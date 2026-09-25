import { createHash, randomBytes, randomUUID } from "node:crypto";

// P0 executable model only. Trusted control-plane methods require real host auth in P5/P7.
export class AccessDenied extends Error {}
const deny = (reason: string): never => { throw new AccessDenied(reason); };
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
export const MINUTE = 60_000;
export type Clock = () => number;
type Scope = "room" | "event";
type Role = "host" | "participant" | "contribute" | "receipt" | "gallery" | "wall";
type Capability = {
  scope: Scope; resource: string; subject: string; role: Role; expiresAt: number; revoked: boolean; object?: string;
};

export class Capabilities {
  private readonly records = new Map<string, Capability>();
  constructor(private readonly now: Clock) {}
  issue(capability: Omit<Capability, "revoked">): string {
    if (capability.expiresAt <= this.now()) deny("expired issuance");
    const token = randomBytes(32).toString("base64url");
    this.records.set(hash(token), { ...capability, revoked: false });
    return token;
  }
  check(token: string, scope: Scope, resource: string, roles: readonly Role[]): Readonly<Capability> {
    const record = this.records.get(hash(token));
    if (!record || record.revoked || record.expiresAt <= this.now()
      || record.scope !== scope || record.resource !== resource || !roles.includes(record.role)) {
      return deny("invalid capability");
    }
    return { ...record };
  }
  revoke(token: string): void {
    const record = this.records.get(hash(token));
    if (record) record.revoked = true;
  }
}

type Signal = { cursor: number; sender: string; recipient: string; kind: "sdp" | "ice"; payload: string; expiresAt: number };
type Room = { expiresAt: number; members: Set<string>; nextCursor: number; messages: Signal[] };
export class RoomSignalling {
  private readonly rooms = new Map<string, Room>();
  constructor(private readonly caps: Capabilities, private readonly now: Clock) {}
  create(roomId: string, members: string[], expiresAt: number): void {
    if (this.rooms.has(roomId) || !members.length || members.length > 4 || new Set(members).size !== members.length
      || expiresAt <= this.now()) deny("invalid room");
    this.rooms.set(roomId, { expiresAt, members: new Set(members), nextCursor: 0, messages: [] });
  }
  remove(roomId: string, member: string): void {
    const room = this.rooms.get(roomId);
    room?.members.delete(member);
    if (room) room.messages = room.messages.filter(message => message.sender !== member && message.recipient !== member);
  }
  private access(token: string, roomId: string) {
    const identity = this.caps.check(token, "room", roomId, ["host", "participant"]);
    const room = this.rooms.get(roomId);
    if (!room || room.expiresAt <= this.now() || !room.members.has(identity.subject)) return deny("inactive room member");
    room.messages = room.messages.filter(message => message.expiresAt > this.now());
    return { room, identity };
  }
  send(token: string, roomId: string, input: { sender: string; recipient: string; kind: string; payload: string }): number {
    const { room, identity } = this.access(token, roomId);
    if (input.sender !== identity.subject || !room.members.has(input.recipient) || input.recipient === input.sender) deny("invalid sender or recipient");
    if (input.kind !== "sdp" && input.kind !== "ice") deny("invalid signal type");
    const limit = input.kind === "sdp" ? 32_768 : 4_096;
    if (typeof input.payload !== "string" || Buffer.byteLength(input.payload) > limit || !input.payload.length) deny("invalid signal size");
    if (room.messages.length >= 64) deny("inbox full");
    const cursor = ++room.nextCursor;
    room.messages.push({ ...input, kind: input.kind as "sdp" | "ice", cursor, expiresAt: this.now() + MINUTE });
    return cursor;
  }
  poll(token: string, roomId: string, after: number): { messages: Signal[]; cursor: number } {
    const { room, identity } = this.access(token, roomId);
    if (!Number.isSafeInteger(after) || after < 0 || after > room.nextCursor) deny("invalid cursor");
    const messages = room.messages.filter(message => message.cursor > after && message.recipient === identity.subject).slice(0, 16);
    return { messages: messages.map(message => ({ ...message })), cursor: messages.at(-1)?.cursor ?? room.nextCursor };
  }
}

export type Destination = "gallery" | "wall";
export type ContributorGrant = { subject: string; submission: boolean; gallery: boolean; wall: boolean };
type EventConfig = { maxCount: number; maxBytes: number; stagingBytes: number; derivativeBytes: number; expiresAt: number };
type Reservation = {
  id: string; guest: string; key: string; logicalExpiresAt: number; stagingUntil: number; stagingHeld: boolean;
  state: "reserved" | "ready" | "expired" | "removed"; derivativeHeld: boolean;
  grants: ContributorGrant[]; approval: Record<Destination, boolean>; hidden: Record<Destination, boolean>;
};
type Event = EventConfig & { closedAt?: number; revoked: Set<string>; deleted: boolean; reservations: Map<string, Reservation>; consents: Map<string, ContributorGrant> };
export class EventAccess {
  private readonly events = new Map<string, Event>();
  constructor(private readonly caps: Capabilities, private readonly now: Clock) {}
  create(id: string, config: EventConfig): void {
    if (this.events.has(id) || config.expiresAt <= this.now()
      || [config.maxCount, config.maxBytes, config.stagingBytes, config.derivativeBytes].some(n => !Number.isSafeInteger(n) || n <= 0)) deny("invalid event");
    this.events.set(id, { ...config, revoked: new Set(), deleted: false, reservations: new Map(), consents: new Map() });
  }
  private event(id: string): Event {
    const event = this.events.get(id);
    if (!event || event.deleted || event.expiresAt <= this.now()) return deny("inactive event");
    for (const item of event.reservations.values()) {
      if (item.state === "reserved" && this.deadline(event, item) <= this.now()) {
        item.state = "expired";
        item.derivativeHeld = false;
      }
    }
    return event;
  }
  private deadline(event: Event, item: Reservation): number {
    return Math.min(item.logicalExpiresAt, event.closedAt === undefined ? Infinity : event.closedAt + 10 * MINUTE);
  }
  private access(token: string, id: string, role: Role) {
    const capability = this.caps.check(token, "event", id, [role]);
    const event = this.event(id);
    if (event.revoked.has(capability.subject)) deny("revoked guest");
    return { event, guest: capability.subject, capability };
  }
  usage(id: string): { count: number; bytes: number } {
    const event = this.event(id);
    let count = 0;
    let bytes = 0;
    for (const item of event.reservations.values()) {
      const committed = item.state === "reserved" || item.state === "ready";
      if (committed) count++;
      if (item.derivativeHeld) bytes += event.derivativeBytes;
      if (item.stagingHeld) bytes += event.stagingBytes;
    }
    return { count, bytes };
  }
  consent(token: string, id: string, choices: Omit<ContributorGrant, "subject">): void {
    const { event, guest } = this.access(token, id, "contribute");
    if (Object.values(choices).length !== 3 || [choices.submission, choices.gallery, choices.wall].some(value => typeof value !== "boolean")) deny("invalid consent");
    event.consents.set(guest, { ...choices, subject: guest });
    for (const item of event.reservations.values()) {
      const grant = item.grants.find(value => value.subject === guest);
      if (grant) Object.assign(grant, choices);
    }
  }
  reserve(token: string, id: string, key: string, grants: ContributorGrant[]): string {
    const { event, guest } = this.access(token, id, "contribute");
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(key)) deny("invalid idempotency key");
    if (!grants.length || grants.length > 4 || new Set(grants.map(g => g.subject)).size !== grants.length
      || !grants.some(g => g.subject === guest) || grants.some(g => {
        const recorded = event.consents.get(g.subject);
        return !g.submission || event.revoked.has(g.subject) || !recorded
          || recorded.submission !== g.submission || recorded.gallery !== g.gallery || recorded.wall !== g.wall;
      })) deny("submission consent required");
    const existing = [...event.reservations.values()].find(item => item.guest === guest && item.key === key);
    if (existing) {
      if (JSON.stringify(existing.grants) !== JSON.stringify(grants)) deny("idempotency conflict");
      if (existing.state !== "reserved" && existing.state !== "ready") deny("inactive reservation");
      return existing.id;
    }
    if (event.closedAt !== undefined) deny("contributions closed");
    const usage = this.usage(id);
    if (usage.count >= event.maxCount || usage.bytes + event.stagingBytes + event.derivativeBytes > event.maxBytes) deny("capacity exhausted");
    const reservationId = randomUUID();
    event.reservations.set(reservationId, {
      id: reservationId, guest, key, logicalExpiresAt: this.now() + 10 * MINUTE,
      stagingUntil: this.now() + 120 * MINUTE + 5 * MINUTE, stagingHeld: true, state: "reserved", derivativeHeld: true,
      grants: grants.map(grant => ({ ...grant })), approval: { gallery: false, wall: false }, hidden: { gallery: false, wall: false },
    });
    return reservationId;
  }
  finalise(token: string, id: string, reservationId: string, actualBytes: number): void {
    const { event, guest } = this.access(token, id, "contribute");
    const item = event.reservations.get(reservationId);
    if (!item || item.guest !== guest || !["ready", "reserved"].includes(item.state)) deny("invalid reservation");
    if (item!.grants.some(grant => !grant.submission || event.revoked.has(grant.subject))) deny("contributor consent withdrawn");
    if (!Number.isSafeInteger(actualBytes) || actualBytes <= 0 || actualBytes > event.stagingBytes) deny("invalid actual bytes");
    if (item!.state === "ready") return;
    if (this.deadline(event, item!) <= this.now()) deny("reservation expired");
    item!.state = "ready";
  }
  read(token: string, id: string, reservationId: string, destination: "receipt" | Destination): string {
    const { event, guest, capability } = this.access(token, id, destination);
    const item = event.reservations.get(reservationId);
    if (!item || item.state !== "ready" || event.revoked.has(item.guest)
      || item.grants.some(grant => !grant.submission || event.revoked.has(grant.subject))) return deny("unavailable contribution");
    if (destination === "receipt") {
      if (item.guest !== guest || capability.object !== reservationId) deny("foreign receipt");
    } else if (!item.approval[destination] || item.hidden[destination] || item.grants.some(grant => !grant[destination])) {
      deny("unpublished destination");
    }
    return `events/${id}/delivery/${item.id}`;
  }
  close(id: string): void { const event = this.event(id); event.closedAt ??= this.now(); }
  revokeGuest(id: string, guest: string): void { this.event(id).revoked.add(guest); }
  deleteEvent(id: string): void { this.event(id).deleted = true; }
  remove(id: string, reservationId: string): void {
    const item = this.item(id, reservationId);
    if (item.state === "reserved") item.derivativeHeld = false;
    item.state = "removed";
  }
  confirmDeliveryDeleted(id: string, reservationId: string): void {
    const item = this.item(id, reservationId);
    if (item.state !== "removed") deny("delivery still active");
    item.derivativeHeld = false;
  }
  moderate(id: string, reservationId: string, destination: Destination, approved: boolean): void {
    this.item(id, reservationId).approval[destination] = approved;
  }
  hide(id: string, reservationId: string, destination: Destination): void { this.item(id, reservationId).hidden[destination] = true; }
  withdraw(id: string, reservationId: string, subject: string, destination: Destination | "submission"): void {
    const grant = this.item(id, reservationId).grants.find(value => value.subject === subject);
    if (!grant) deny("unknown contributor");
    grant![destination] = false;
  }
  confirmStagingDeleted(id: string, reservationId: string): void {
    const item = this.item(id, reservationId);
    if (this.now() < item.stagingUntil) deny("upload authorisation still live");
    item.stagingHeld = false;
  }
  private item(id: string, reservationId: string): Reservation {
    const item = this.event(id).reservations.get(reservationId);
    return item ?? deny("unknown contribution");
  }
}
