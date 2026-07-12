import { ROLES, Role } from "../layouts";
import { ClockSync } from "./sync";
import { SignalMessage, Signaling, createSignaling } from "./signaling";

// Full mesh for up to 4 members. The host (role A) owns the roster: it
// assigns roles in join order and broadcasts membership; for each pair the
// member earlier in the roster initiates the offer, so there is no glare.
// Data-channel protocol per pair: JSON control strings + binary JPEG chunks;
// chunks always follow their "frame" header on the same ordered channel.
const CHUNK_SIZE = 16 * 1024;
const SYNC_ROUNDS = 6;
export const MAX_MEMBERS = 4;

export interface RoomMember {
  id: string;
  role: Role;
}

export interface ShotPlan {
  layoutId: string;
  filterId: string;
  seed: number;
  /** epoch ms of the first shutter fire, in the LEADER's clock */
  t0: number;
  intervalMs: number;
  shots: number;
  sceneId: string | null;
  /** roles present when the plan fired; receivers expect frames from all of them */
  members: Role[];
}

type Control =
  | { t: "ping"; a: number }
  | { t: "pong"; a: number; b: number }
  | { t: "scene"; id: string | null }
  | { t: "arm"; plan: ShotPlan }
  | { t: "frame"; shot: number; size: number; capturedAt: number };

export type RoomStatus =
  | "connecting"
  | "waiting"
  | "connected"
  | "peer-left"
  | "full"
  | "failed";

interface Incoming {
  shot: number;
  capturedAt: number;
  parts: ArrayBuffer[];
  received: number;
  size: number;
}

interface Peer {
  id: string;
  role: Role;
  pc: RTCPeerConnection;
  dc: RTCDataChannel | null;
  clock: ClockSync;
  incoming: Incoming | null;
}

export interface RoomEngineEvents {
  onStatus(status: RoomStatus): void;
  /** membership changed; includes self, in join order */
  onRoster(members: RoomMember[], selfRole: Role): void;
  onRemoteStream(role: Role, stream: MediaStream): void;
  /** a member changed the shared Together scene */
  onScene(id: string | null): void;
  /** plan with t0 already converted to this machine's clock */
  onArm(plan: ShotPlan): void;
  /** capturedAtLocal: the remote capture moment converted to this machine's clock */
  onRemoteFrame(role: Role, shot: number, blob: Blob, capturedAtLocal: number): void;
  onPeerLeft(role: Role): void;
}

function iceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
  const turnUrl = process.env.NEXT_PUBLIC_TURN_URL;
  if (turnUrl) {
    servers.push({
      urls: turnUrl,
      username: process.env.NEXT_PUBLIC_TURN_USERNAME ?? "",
      credential: process.env.NEXT_PUBLIC_TURN_CREDENTIAL ?? "",
    });
  }
  return servers;
}

export class RoomEngine {
  readonly peerId = crypto.randomUUID();
  private signaling: Signaling;
  private peers = new Map<string, Peer>();
  /** join-ordered membership, host first; authoritative copy lives on the host */
  private roster: RoomMember[] = [];
  private localStream: MediaStream | null = null;
  private closed = false;

  constructor(
    private roomCode: string,
    private isHost: boolean,
    private events: RoomEngineEvents,
  ) {
    this.signaling = createSignaling(roomCode);
    this.signaling.onMessage((msg) => void this.onSignal(msg));
    if (isHost) this.roster = [{ id: this.peerId, role: "A" }];
  }

  get selfRole(): Role {
    return this.roster.find((m) => m.id === this.peerId)?.role ?? (this.isHost ? "A" : "B");
  }

  get memberRoles(): Role[] {
    return this.roster.map((m) => m.role);
  }

  start(localStream: MediaStream): void {
    this.localStream = localStream;
    this.events.onStatus("waiting");
    if (this.isHost) this.events.onRoster(this.roster, "A");
    this.signaling.send({ type: "hello", from: this.peerId });
  }

  private connectedCount(): number {
    let n = 0;
    this.peers.forEach((p) => {
      if (p.dc?.readyState === "open") n++;
    });
    return n;
  }

  private emitConnectivity(): void {
    if (this.closed) return;
    this.events.onStatus(this.connectedCount() > 0 ? "connected" : "waiting");
  }

  private newPeer(id: string, role: Role): Peer {
    const pc = new RTCPeerConnection({ iceServers: iceServers() });
    this.localStream?.getTracks().forEach((t) => pc.addTrack(t, this.localStream!));
    const peer: Peer = { id, role, pc, dc: null, clock: new ClockSync(), incoming: null };
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.signaling.send({
          type: "ice",
          from: this.peerId,
          to: id,
          payload: e.candidate.toJSON(),
        });
      }
    };
    pc.ontrack = (e) => {
      if (e.streams[0]) this.events.onRemoteStream(peer.role, e.streams[0]);
    };
    pc.onconnectionstatechange = () => {
      if (this.closed) return;
      if (
        pc.connectionState === "failed" ||
        pc.connectionState === "disconnected" ||
        pc.connectionState === "closed"
      ) {
        this.dropPeer(id);
      }
    };
    this.peers.set(id, peer);
    return peer;
  }

  private attachDataChannel(peer: Peer, dc: RTCDataChannel): void {
    peer.dc = dc;
    dc.binaryType = "arraybuffer";
    dc.onopen = () => {
      this.emitConnectivity();
      void this.runClockSync(peer);
    };
    dc.onmessage = (e) => this.onChannelMessage(peer, e.data);
    dc.onclose = () => {
      if (!this.closed) this.dropPeer(peer.id);
    };
  }

  private dropPeer(id: string): void {
    const peer = this.peers.get(id);
    if (!peer) return;
    this.peers.delete(id);
    peer.dc?.close();
    peer.pc.close();
    this.roster = this.roster.filter((m) => m.id !== id);
    this.events.onPeerLeft(peer.role);
    this.events.onRoster(this.roster, this.selfRole);
    if (this.connectedCount() === 0) this.events.onStatus("peer-left");
  }

  private nextFreeRole(): Role | null {
    return ROLES.find((r) => !this.roster.some((m) => m.role === r)) ?? null;
  }

  private async onSignal(msg: SignalMessage): Promise<void> {
    if (msg.from === this.peerId) return;
    if (msg.to && msg.to !== this.peerId) return;

    switch (msg.type) {
      case "hello": {
        if (!this.isHost) return;
        if (this.roster.some((m) => m.id === msg.from)) return;
        const role = this.roster.length < MAX_MEMBERS ? this.nextFreeRole() : null;
        if (!role) {
          this.signaling.send({ type: "full", from: this.peerId, to: msg.from });
          return;
        }
        this.roster = [...this.roster, { id: msg.from, role }];
        this.signaling.send({
          type: "roster",
          from: this.peerId,
          payload: this.roster,
        });
        void this.applyRoster(this.roster);
        return;
      }
      case "roster": {
        if (this.isHost) return;
        await this.applyRoster(msg.payload as RoomMember[]);
        return;
      }
      case "offer": {
        const { sdp, role } = msg.payload as { sdp: RTCSessionDescriptionInit; role: Role };
        let peer = this.peers.get(msg.from);
        if (!peer) peer = this.newPeer(msg.from, role);
        peer.pc.ondatachannel = (e) => this.attachDataChannel(peer, e.channel);
        await peer.pc.setRemoteDescription(sdp);
        const answer = await peer.pc.createAnswer();
        await peer.pc.setLocalDescription(answer);
        this.signaling.send({
          type: "answer",
          from: this.peerId,
          to: msg.from,
          payload: { sdp: answer, role: this.selfRole },
        });
        return;
      }
      case "answer": {
        const { sdp } = msg.payload as { sdp: RTCSessionDescriptionInit; role: Role };
        await this.peers.get(msg.from)?.pc.setRemoteDescription(sdp);
        return;
      }
      case "ice": {
        try {
          await this.peers.get(msg.from)?.pc.addIceCandidate(msg.payload as RTCIceCandidateInit);
        } catch {
          // stale candidate after teardown; safe to drop
        }
        return;
      }
      case "full": {
        this.events.onStatus("full");
        return;
      }
      case "bye": {
        this.dropPeer(msg.from);
        return;
      }
    }
  }

  private async applyRoster(roster: RoomMember[]): Promise<void> {
    // members that vanished from the roster are gone
    const ids = new Set(roster.map((m) => m.id));
    [...this.peers.keys()].filter((id) => !ids.has(id)).forEach((id) => this.dropPeer(id));

    this.roster = roster;
    if (!roster.some((m) => m.id === this.peerId)) return;
    this.events.onRoster(roster, this.selfRole);

    // earlier roster member initiates each pair's offer
    const myIndex = roster.findIndex((m) => m.id === this.peerId);
    for (const member of roster.slice(myIndex + 1)) {
      if (this.peers.has(member.id)) continue;
      const peer = this.newPeer(member.id, member.role);
      this.attachDataChannel(peer, peer.pc.createDataChannel("booth"));
      const offer = await peer.pc.createOffer();
      await peer.pc.setLocalDescription(offer);
      this.signaling.send({
        type: "offer",
        from: this.peerId,
        to: member.id,
        payload: { sdp: offer, role: this.selfRole },
      });
    }
    // roles of already-connected peers may have been unknown until now
    roster.forEach((m) => {
      const peer = this.peers.get(m.id);
      if (peer) peer.role = m.role;
    });
  }

  private sendControlTo(peer: Peer, msg: Control): void {
    if (peer.dc?.readyState === "open") peer.dc.send(JSON.stringify(msg));
  }

  private broadcastControl(msg: Control): void {
    this.peers.forEach((p) => this.sendControlTo(p, msg));
  }

  private async runClockSync(peer: Peer): Promise<void> {
    for (let i = 0; i < SYNC_ROUNDS; i++) {
      this.sendControlTo(peer, { t: "ping", a: Date.now() });
      await new Promise((r) => setTimeout(r, 120));
    }
  }

  private onChannelMessage(peer: Peer, data: string | ArrayBuffer): void {
    if (typeof data !== "string") {
      const inc = peer.incoming;
      if (!inc) return;
      inc.parts.push(data);
      inc.received += data.byteLength;
      if (inc.received >= inc.size) {
        peer.incoming = null;
        const blob = new Blob(inc.parts, { type: "image/jpeg" });
        this.events.onRemoteFrame(
          peer.role,
          inc.shot,
          blob,
          peer.clock.toLocal(inc.capturedAt),
        );
      }
      return;
    }

    const msg = JSON.parse(data) as Control;
    switch (msg.t) {
      case "ping":
        this.sendControlTo(peer, { t: "pong", a: msg.a, b: Date.now() });
        return;
      case "pong":
        peer.clock.addSample(msg.a, msg.b, Date.now());
        return;
      case "scene":
        this.events.onScene(msg.id);
        return;
      case "arm": {
        const plan = { ...msg.plan, t0: peer.clock.toLocal(msg.plan.t0) };
        this.events.onArm(plan);
        return;
      }
      case "frame":
        peer.incoming = {
          shot: msg.shot,
          capturedAt: msg.capturedAt,
          parts: [],
          received: 0,
          size: msg.size,
        };
        return;
    }
  }

  sendScene(id: string | null): void {
    this.broadcastControl({ t: "scene", id });
  }

  /** Leader side: broadcast the plan (t0 in our clock) and run it locally too. */
  arm(plan: ShotPlan): void {
    this.broadcastControl({ t: "arm", plan });
    this.events.onArm(plan);
  }

  async sendFrame(shot: number, blob: Blob, capturedAt: number): Promise<void> {
    const buf = await blob.arrayBuffer();
    this.peers.forEach((peer) => {
      if (peer.dc?.readyState !== "open") return;
      this.sendControlTo(peer, { t: "frame", shot, size: buf.byteLength, capturedAt });
      for (let i = 0; i < buf.byteLength; i += CHUNK_SIZE) {
        peer.dc.send(buf.slice(i, i + CHUNK_SIZE));
      }
    });
  }

  close(): void {
    this.closed = true;
    this.signaling.send({ type: "bye", from: this.peerId });
    this.signaling.close();
    this.peers.forEach((p) => {
      p.dc?.close();
      p.pc.close();
    });
    this.peers.clear();
  }
}
