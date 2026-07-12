import { ClockSync } from "./sync";
import { SignalMessage, Signaling, createSignaling } from "./signaling";

// Data-channel protocol: JSON control strings + binary JPEG chunks.
// Chunks always follow their "frame" header on the same ordered channel.
const CHUNK_SIZE = 16 * 1024;
const SYNC_ROUNDS = 6;

export interface ShotPlan {
  layoutId: string;
  filterId: string;
  seed: number;
  /** epoch ms of the first shutter fire, in the LEADER's clock */
  t0: number;
  intervalMs: number;
  shots: number;
}

type Control =
  | { t: "ping"; a: number }
  | { t: "pong"; a: number; b: number }
  | { t: "arm"; plan: ShotPlan }
  | { t: "frame"; shot: number; size: number; capturedAt: number };

export type RoomStatus =
  | "connecting"
  | "waiting"
  | "connected"
  | "peer-left"
  | "full"
  | "failed";

export interface RoomEngineEvents {
  onStatus(status: RoomStatus): void;
  onRemoteStream(stream: MediaStream): void;
  /** plan with t0 already converted to this machine's clock */
  onArm(plan: ShotPlan): void;
  /** capturedAtLocal: the remote capture moment converted to this machine's clock */
  onRemoteFrame(shot: number, blob: Blob, capturedAtLocal: number): void;
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
  readonly clock = new ClockSync();
  private signaling: Signaling;
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private remotePeerId: string | null = null;
  private localStream: MediaStream | null = null;
  private closed = false;
  // reassembly of the incoming frame (headers and chunks arrive in order)
  private incoming: { shot: number; capturedAt: number; parts: ArrayBuffer[]; received: number; size: number } | null = null;

  constructor(
    private roomCode: string,
    private isHost: boolean,
    private events: RoomEngineEvents,
  ) {
    this.signaling = createSignaling(roomCode);
    this.signaling.onMessage((msg) => void this.onSignal(msg));
  }

  start(localStream: MediaStream): void {
    this.localStream = localStream;
    this.events.onStatus("waiting");
    this.signaling.send({ type: "hello", from: this.peerId });
  }

  private newPeerConnection(): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: iceServers() });
    this.localStream?.getTracks().forEach((t) => pc.addTrack(t, this.localStream!));
    pc.onicecandidate = (e) => {
      if (e.candidate && this.remotePeerId) {
        this.signaling.send({
          type: "ice",
          from: this.peerId,
          to: this.remotePeerId,
          payload: e.candidate.toJSON(),
        });
      }
    };
    pc.ontrack = (e) => {
      if (e.streams[0]) this.events.onRemoteStream(e.streams[0]);
    };
    pc.onconnectionstatechange = () => {
      if (this.closed) return;
      if (pc.connectionState === "failed") this.events.onStatus("failed");
      if (pc.connectionState === "disconnected" || pc.connectionState === "closed")
        this.events.onStatus("peer-left");
    };
    return pc;
  }

  private attachDataChannel(dc: RTCDataChannel): void {
    this.dc = dc;
    dc.binaryType = "arraybuffer";
    dc.onopen = () => {
      this.events.onStatus("connected");
      void this.runClockSync();
    };
    dc.onmessage = (e) => this.onChannelMessage(e.data);
    dc.onclose = () => {
      if (!this.closed) this.events.onStatus("peer-left");
    };
  }

  private async onSignal(msg: SignalMessage): Promise<void> {
    if (msg.from === this.peerId) return;
    if (msg.to && msg.to !== this.peerId) return;

    switch (msg.type) {
      case "hello": {
        if (this.isHost) {
          if (this.remotePeerId && this.remotePeerId !== msg.from) {
            this.signaling.send({ type: "full", from: this.peerId, to: msg.from });
            return;
          }
          this.remotePeerId = msg.from;
          this.pc = this.newPeerConnection();
          this.attachDataChannel(this.pc.createDataChannel("booth"));
          const offer = await this.pc.createOffer();
          await this.pc.setLocalDescription(offer);
          this.signaling.send({
            type: "offer",
            from: this.peerId,
            to: msg.from,
            payload: offer,
          });
        } else if (!this.remotePeerId) {
          // host announced after we did; re-announce so it can offer
          this.signaling.send({ type: "hello", from: this.peerId });
        }
        return;
      }
      case "offer": {
        if (this.isHost) return;
        this.remotePeerId = msg.from;
        this.pc = this.newPeerConnection();
        this.pc.ondatachannel = (e) => this.attachDataChannel(e.channel);
        await this.pc.setRemoteDescription(msg.payload as RTCSessionDescriptionInit);
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        this.signaling.send({
          type: "answer",
          from: this.peerId,
          to: msg.from,
          payload: answer,
        });
        return;
      }
      case "answer": {
        await this.pc?.setRemoteDescription(msg.payload as RTCSessionDescriptionInit);
        return;
      }
      case "ice": {
        try {
          await this.pc?.addIceCandidate(msg.payload as RTCIceCandidateInit);
        } catch {
          // stale candidate after renegotiation; safe to drop
        }
        return;
      }
      case "full": {
        this.events.onStatus("full");
        return;
      }
      case "bye": {
        if (msg.from === this.remotePeerId) this.events.onStatus("peer-left");
        return;
      }
    }
  }

  private sendControl(msg: Control): void {
    if (this.dc?.readyState === "open") this.dc.send(JSON.stringify(msg));
  }

  private async runClockSync(): Promise<void> {
    for (let i = 0; i < SYNC_ROUNDS; i++) {
      this.sendControl({ t: "ping", a: Date.now() });
      await new Promise((r) => setTimeout(r, 120));
    }
  }

  private onChannelMessage(data: string | ArrayBuffer): void {
    if (typeof data !== "string") {
      const inc = this.incoming;
      if (!inc) return;
      inc.parts.push(data);
      inc.received += data.byteLength;
      if (inc.received >= inc.size) {
        this.incoming = null;
        const blob = new Blob(inc.parts, { type: "image/jpeg" });
        this.events.onRemoteFrame(inc.shot, blob, this.clock.toLocal(inc.capturedAt));
      }
      return;
    }

    const msg = JSON.parse(data) as Control;
    switch (msg.t) {
      case "ping":
        this.sendControl({ t: "pong", a: msg.a, b: Date.now() });
        return;
      case "pong":
        this.clock.addSample(msg.a, msg.b, Date.now());
        return;
      case "arm": {
        const plan = { ...msg.plan, t0: this.clock.toLocal(msg.plan.t0) };
        this.events.onArm(plan);
        return;
      }
      case "frame":
        this.incoming = {
          shot: msg.shot,
          capturedAt: msg.capturedAt,
          parts: [],
          received: 0,
          size: msg.size,
        };
        return;
    }
  }

  /** Leader side: broadcast the plan (t0 in our clock) and run it locally too. */
  arm(plan: ShotPlan): void {
    this.sendControl({ t: "arm", plan });
    this.events.onArm(plan);
  }

  async sendFrame(shot: number, blob: Blob, capturedAt: number): Promise<void> {
    if (this.dc?.readyState !== "open") return;
    const buf = await blob.arrayBuffer();
    this.sendControl({ t: "frame", shot, size: buf.byteLength, capturedAt });
    for (let i = 0; i < buf.byteLength; i += CHUNK_SIZE) {
      this.dc.send(buf.slice(i, i + CHUNK_SIZE));
    }
  }

  close(): void {
    this.closed = true;
    this.signaling.send({ type: "bye", from: this.peerId });
    this.signaling.close();
    this.dc?.close();
    this.pc?.close();
  }
}
