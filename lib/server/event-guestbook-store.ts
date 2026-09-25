import { EVENT_GUESTBOOK_LIMITS, parseEventGuestbookNote, parseEventMissions, validateGuestbookText, type EventGuestbookNote } from "../events/guestbook-contract";
import { eventActorId, EventStoreError, type EventRpcClient, type VerifiedEventActor } from "./event-store";
import { eventInstant, eventInteger, eventObject, eventUuid } from "./event-http-input";
export function createEventGuestbookStore(client: EventRpcClient) {
  const rpc = async (name: string, args: Record<string, unknown>) => {
    const { data, error } = await client.rpc(name, args);
    if (error) { const codes = { PB_EVENT_DENIED: ["access_denied", 403], PB_EVENT_EXPIRED: ["expired", 410], PB_EVENT_CONFLICT: ["conflict", 409], PB_EVENT_CAPACITY: ["capacity", 409], PB_EVENT_NOT_READY: ["not_ready", 503], PB_EVENT_INVALID: ["invalid_request", 400] } as const; const [code, status] = codes[error.message as keyof typeof codes] ?? ["unavailable", 503]; throw new EventStoreError(code, status); }
    return data;
  };
  const parsed = <T>(work: () => T): T => { try { return work(); } catch { throw new EventStoreError("unavailable", 503); } };
  const missions = (data: unknown, eventId: string) => parsed(() => {
    const value = eventObject(data, ["version", "eventId", "revision", "missionIds", "endsAt", "locked"]);
    return parseEventMissions({ ...value, endsAt: eventInstant(value.endsAt) }, eventId);
  });
  return {
    async capabilities() { const data = await rpc("pb_event_guestbook_capabilities", {}); return parsed(() => { const b = eventObject(data, Object.keys(EVENT_GUESTBOOK_LIMITS)); if (Object.entries(EVENT_GUESTBOOK_LIMITS).some(([key, value]) => b[key] !== value)) throw new Error(); return EVENT_GUESTBOOK_LIMITS; }); },
    async missions(actor: VerifiedEventActor, eventId: string, save?: { expectedRevision: number; missionIds: string[]; endsAt: string }) { const data = await rpc("pb_event_missions_host", { p_actor: eventActorId(actor), p_event: eventId, p_revision: save?.expectedRevision ?? null, p_ids: save?.missionIds ?? null, p_end: save?.endsAt ?? null }); return missions(data, eventId); },
    async guestMissions(eventId: string, hash: string, guestId: string) { const data = await rpc("pb_event_missions_guest", { p_event: eventId, p_hash: hash, p_guest: guestId }); return missions(data, eventId); },
    async reserve(eventId: string, hash: string, guestId: string, input: { submissionId: string; requestId: string; receiptHash: string; consent: unknown; missionId: string | null }) { return rpc("pb_event_reserve_mission", { p_event: eventId, p_hash: hash, p_guest: guestId, p_submission: input.submissionId, p_request: input.requestId, p_receipt_hash: input.receiptHash, p_consent: input.consent, p_mission: input.missionId }); },
    async read(eventId: string, hash: string, kind: "contribute" | "receipt", submissionId: string, guestId?: string) { const data = await rpc("pb_event_guestbook_read", { p_event: eventId, p_hash: hash, p_kind: kind, p_submission: submissionId, p_guest: guestId ?? null }); return parsed(() => parseEventGuestbookNote(data, eventId, submissionId)); },
    async save(eventId: string, hash: string, guestId: string, submissionId: string, input: { requestId: string; expectedRevision: number; message: string; signature: string }) {
      const text = validateGuestbookText(input.message, input.signature), data = await rpc("pb_event_guestbook_save", { p_event: eventId, p_hash: hash, p_guest: guestId, p_submission: submissionId, p_request: input.requestId, p_revision: input.expectedRevision, p_message: text.message, p_signature: text.signature });
      return parsed(() => { const b = eventObject(data, ["acceptedRequestId", "acceptedRevision", "current"]), current = parseEventGuestbookNote(b.current, eventId, submissionId), acceptedRevision = eventInteger(b.acceptedRevision, 1, current.revision); if (b.acceptedRequestId !== input.requestId) throw new Error(); return { acceptedRequestId: input.requestId, acceptedRevision, current }; });
    },
    async withdraw(eventId: string, hash: string, kind: "contribute" | "receipt", submissionId: string, guestId?: string) { const data = await rpc("pb_event_guestbook_withdraw", { p_event: eventId, p_hash: hash, p_kind: kind, p_submission: submissionId, p_guest: guestId ?? null }); return parsed(() => { const b = eventObject(data, ["submissionId", "withdrawn"]); if (b.submissionId !== submissionId || b.withdrawn !== true) throw new Error(); return { submissionId, withdrawn: true as const }; }); },
    async list(actor: VerifiedEventActor, eventId: string, after?: string, limit = 25) {
      const data = await rpc("pb_event_guestbook_host", { p_actor: eventActorId(actor), p_event: eventId, p_after: after ?? null, p_limit: limit });
      return parsed(() => { const b = eventObject(data, ["version", "entries", "nextCursor"]); if (b.version !== 1 || !Array.isArray(b.entries) || b.entries.length > limit) throw new Error(); let previous = after ?? "";
        const entries = b.entries.map(item => { const e = eventObject(item, ["submissionId", "note", "unavailable"]), id = eventUuid(e.submissionId); if (id <= previous || typeof e.unavailable !== "boolean" || e.unavailable !== (e.note === null)) throw new Error(); previous = id; return { submissionId: id, note: e.note === null ? null : parseEventGuestbookNote(e.note, eventId, id), unavailable: e.unavailable }; });
        const nextCursor = b.nextCursor === null ? null : eventUuid(b.nextCursor); if (nextCursor !== null && (entries.length !== limit || nextCursor !== previous)) throw new Error(); return { version: 1 as const, entries: entries as { submissionId: string; note: EventGuestbookNote | null; unavailable: boolean }[], nextCursor };
      });
    },
  };
}
