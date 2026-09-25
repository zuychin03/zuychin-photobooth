import type { ProjectScope } from "../projects/model";
import { inspectProjectImage } from "../projects/images";
import { ROOM_LIMITS, type RoomCapture, type RoomCaptureProposal, type RoomSignal, type RoomState } from "../server/room-contract";
import { CaptureRunner, type CaptureProgress } from "./capture-v2";
import { createRoomApi, RoomApiError, validateRoomState, type RoomApi } from "./signaling-v2";
import { CONTROL_BYTES, encodeEnvelope, PeerEnvelopeGuard, RoomProtocolError, TRANSFER_CHUNK_BYTES, type ControlPayloads, type ControlType, type Envelope, type TransferManifest } from "./protocol";
import { openTransferJournal, transferHash, type TransferJournal } from "./transfer-store";
import { PeerTransfers, retainOutgoing } from "./transfer";
import { validateRecipeCommit, validateRecipeProposal, type RecipeCommit, type RecipeProposal } from "./recipe-v2";

export type RoomV2Status = CaptureProgress
  | { kind: "connecting" | "connected" | "waiting-admission" | "host-absent" | "closed" }
  | { kind: "capture-ready" | "capture-committed"; capture: RoomCapture }
  | { kind: "transfer-progress"; transferId: string; memberId: string; received: number; total: number }
  | { kind: "recovery-required"; reason: string; transferId?: string };
export interface RoomEngineV2Options {
  initial: RoomState; scope: ProjectScope; iceServers: RTCIceServer[];
  readiness(capture: RoomCapture): Promise<boolean>;
  captureShot(capture: RoomCapture, index: number): Promise<Blob>;
  commitRemoteFrame(frame: { manifest: TransferManifest; blob: Blob; capture: RoomCapture }): Promise<void>;
  onState(state: RoomState): void;
  onStatus(status: RoomV2Status): void;
  onPeerDisconnected?(member: RoomState["members"][number]): void;
  onRemoteStream(member: RoomState["members"][number], stream: MediaStream): void;
  onError(code: string): void;
  onRecipeProposal?(proposal: RecipeProposal, sender: RoomState["members"][number]): Promise<void>;
  onRecipeCommit?(commit: RecipeCommit, sender: RoomState["members"][number]): Promise<void>;
  onCaptureRequest?(sender: RoomState["members"][number]): void | Promise<void>;
  api?: RoomApi; journal?: TransferJournal; openJournal?: () => Promise<TransferJournal>;
  createPeer?: (configuration: RTCConfiguration) => RTCPeerConnection;
}
interface Peer {
  member: RoomState["members"][number]; pc: RTCPeerConnection; dc: RTCDataChannel | null;
  guard: PeerEnvelopeGuard; seq: number; hello: boolean; transfers: PeerTransfers | null;
  pending: Promise<void>; queued: number; candidates: RTCIceCandidateInit[]; lastCaptureRequestAt: number; signalReceipts: Set<string>; remoteSdp: string | null;
}

export class RoomEngineV2 {
  private snapshot: RoomState;
  private api: RoomApi;
  private journal: TransferJournal | null = null;
  private runner: CaptureRunner | null = null;
  private peers = new Map<string, Peer>();
  private stream: MediaStream | null = null;
  private controller = new AbortController();
  private stateTimer: ReturnType<typeof setTimeout> | null = null;
  private signalTimer: ReturnType<typeof setTimeout> | null = null;
  private signalCursor = 0;
  private expectedSignalReset = false;
  private signalUntil = 0;
  private statePending: Promise<RoomState> | null = null;
  private serverOffset = 0;
  private bestRtt = Infinity;
  private signalBusy = false;
  private lastStateAt = 0;
  private generation = 0;
  private closed = false;
  private lastCaptureRequestAt = -Infinity;
  private acknowledged = new Set<string>();
  private startedCaptures = new Set<string>();
  private captures = new Map<string, RoomCapture>();
  constructor(private readonly options: RoomEngineV2Options) {
    this.snapshot = validateRoomState(options.initial);
    this.api = options.api ?? createRoomApi(options.initial.roomId, { signal: this.controller.signal });
  }
  get state(): RoomState { return structuredClone(this.snapshot); }
  get peerReadiness(): { member: RoomState["members"][number]; connected: boolean }[] {
    return this.snapshot.members.filter(member => member.status === "admitted" && member.id !== this.snapshot.selfId)
      .map(member => ({ member: structuredClone(member), connected: this.authorised() && this.peers.get(member.id)?.hello === true }));
  }
  private status(value: RoomV2Status) { if (!this.closed) this.options.onStatus(value); }
  private error(error: unknown) { if (!this.closed) this.options.onError(error instanceof Error ? error.message : "room_unavailable"); }
  private currentPeer(peer: Peer) { return !this.closed && this.peers.get(peer.member.id) === peer; }
  private now() { return Date.now() + this.serverOffset; }
  private authorised() { return !this.closed && this.snapshot.status === "open" && this.snapshot.members.some(member => member.id === this.snapshot.selfId && member.status === "admitted" && member.role === this.snapshot.selfRole) && this.now() < this.snapshot.expiresAt && Date.now() - this.lastStateAt < 15000; }

  async start(stream: MediaStream): Promise<void> {
    if (this.closed || this.stream) throw new Error("room_already_started");
    this.stream = stream; this.options.onState(this.state); this.status({ kind: "connecting" });
    this.journal = this.options.journal ?? await (this.options.openJournal?.() ?? openTransferJournal({ scope: this.options.scope, roomId: this.snapshot.roomId, sessionId: this.snapshot.sessionId, selfId: this.snapshot.selfId }));
    if (this.closed) { this.journal.close(); return; }
    this.runner = new CaptureRunner({ journal: this.journal, expiresAt: this.snapshot.expiresAt, now: () => this.now(),
      authorised: async capture => {
        await this.refresh();
        return this.authorised() && capture.memberIds.every(id => this.snapshot.members.some(member => member.id === id && member.status === "admitted") && (id === this.snapshot.selfId || this.peers.get(id)?.hello)) && (await this.api.capture(capture.captureId)).state === "committed";
      },
      capture: (capture, index) => this.captureLocal(capture, index), onProgress: value => this.status(value),
    });
    await this.refresh(Boolean(this.snapshot.selfRole)); this.scheduleState(); this.startSignals();
  }
  private scheduleState() {
    if (this.closed) return;
    if (this.stateTimer) clearTimeout(this.stateTimer);
    this.stateTimer = setTimeout(() => { void this.refresh().catch(error => this.error(error)).finally(() => this.scheduleState()); }, ROOM_LIMITS.statePollMs);
  }
  async refresh(renewConnection = false): Promise<RoomState> {
    if (this.closed) throw new Error("room_closed");
    if (this.statePending) {
      try { await this.statePending; }
      catch (error) { if (!renewConnection || !(error instanceof Error) || error.message !== "room_generation_changed") throw error; }
      if (!renewConnection) return this.state;
      if (this.closed) throw new Error("room_closed");
    }
    const started = Date.now(), generation = this.generation;
    const pending = this.api.state(renewConnection).then(async state => {
      if (this.closed || generation !== this.generation) throw new Error("room_generation_changed");
      if (state.roomId !== this.snapshot.roomId || state.sessionId !== this.snapshot.sessionId || state.selfId !== this.snapshot.selfId) throw new Error("room_identity_changed");
      const rtt = Date.now() - started;
      if (rtt < this.bestRtt) { this.bestRtt = rtt; this.serverOffset = state.serverNow - (started + Date.now()) / 2; }
      this.lastStateAt = Date.now();
      const changed = state.connectionEpoch !== this.snapshot.connectionEpoch || state.rosterRevision !== this.snapshot.rosterRevision;
      const peerEpochChanged = state.members.some(member => member.status === "admitted" && this.snapshot.members.some(previous => previous.id === member.id && previous.connectionEpoch !== member.connectionEpoch));
      this.snapshot = state;
      const self = state.members.find(member => member.id === state.selfId);
      if (state.status !== "open" || self?.status !== "admitted" || !self.role || self.role !== state.selfRole) {
        this.runner?.cancel("access_denied"); this.closePeers(); this.options.onState(this.state);
        this.status(state.status === "open" && self?.status === "pending" ? { kind: "waiting-admission" } : { kind: "recovery-required", reason: "access_denied" });
        return this.state;
      }
      if (changed) { this.runner?.cancel("membership_changed"); this.closePeers(); this.signalCursor = 0; this.expectedSignalReset = true; this.startSignals(); }
      else if (peerEpochChanged) { this.signalCursor = 0; this.expectedSignalReset = true; this.startSignals(); }
      for (const [id, peer] of this.peers) if (!state.members.some(member => member.id === id && member.status === "admitted" && member.connectionEpoch === peer.member.connectionEpoch)) this.dropPeer(id);
      this.options.onState(this.state);
      if (!state.selfRole) { this.status({ kind: "waiting-admission" }); return this.state; }
      await this.connectPeers();
      if (state.capture) await this.observeCapture(state.capture);
      return this.state;
    }).catch(error => {
      if (this.closed || generation !== this.generation) throw new Error("room_generation_changed");
      if (error instanceof RoomApiError && error.status === 403) { this.runner?.cancel("access_denied"); this.closePeers(); this.status({ kind: "recovery-required", reason: "access_denied" }); }
      else if (Date.now() - this.lastStateAt >= 15000) { this.runner?.cancel("authorisation_unavailable"); this.closePeers(); this.status({ kind: "recovery-required", reason: "authorisation_unavailable" }); }
      throw error;
    });
    this.statePending = pending;
    try { return await pending; } finally { if (this.statePending === pending) this.statePending = null; }
  }
  private async connectPeers() {
    if (!this.stream || !this.snapshot.selfRole) return;
    const members = this.snapshot.members.filter(member => member.status === "admitted" && member.id !== this.snapshot.selfId);
    for (const member of members) {
      if (this.peers.has(member.id)) continue;
      const peer = this.makePeer(member);
      this.startSignals();
      if (this.snapshot.selfRole < member.role!) {
        this.attach(peer, peer.pc.createDataChannel("photobooth-v2", { ordered: true }));
        const offer = await peer.pc.createOffer(); if (!this.currentPeer(peer)) continue;
        await peer.pc.setLocalDescription(offer); if (!this.currentPeer(peer)) continue;
        await this.api.signal({ messageId: crypto.randomUUID(), toMemberId: member.id, connectionEpoch: this.snapshot.connectionEpoch, kind: "sdp", payload: JSON.stringify({ type: offer.type, sdp: offer.sdp, rosterRevision: this.snapshot.rosterRevision, toConnectionEpoch: peer.member.connectionEpoch }) });
      }
    }
  }
  private makePeer(member: RoomState["members"][number]): Peer {
    const pc = (this.options.createPeer ?? (config => new RTCPeerConnection(config)))({ iceServers: this.options.iceServers });
    const peer: Peer = { member, pc, dc: null, seq: 0, hello: false, transfers: null, pending: Promise.resolve(), queued: 0, candidates: [], lastCaptureRequestAt: -Infinity, signalReceipts: new Set(), remoteSdp: null,
      guard: new PeerEnvelopeGuard({ roomId: this.snapshot.roomId, sessionId: this.snapshot.sessionId, memberId: member.id, connectionEpoch: member.connectionEpoch, rosterRevision: this.snapshot.rosterRevision }),
    };
    this.peers.set(member.id, peer);
    this.stream?.getVideoTracks().forEach(track => pc.addTrack(track, this.stream!));
    pc.onicecandidate = event => {
      if (!event.candidate || !this.currentPeer(peer)) return;
      void this.api.signal({ messageId: crypto.randomUUID(), toMemberId: member.id, connectionEpoch: this.snapshot.connectionEpoch, kind: "ice", payload: JSON.stringify({ ...event.candidate.toJSON(), rosterRevision: this.snapshot.rosterRevision, toConnectionEpoch: peer.member.connectionEpoch }) }).catch(error => this.error(error));
    };
    pc.ondatachannel = event => { if (this.currentPeer(peer)) this.attach(peer, event.channel); else event.channel.close(); };
    pc.ontrack = event => { if (this.currentPeer(peer) && event.streams[0]) this.options.onRemoteStream(member, event.streams[0]); };
    pc.onconnectionstatechange = () => {
      if (!this.currentPeer(peer)) return;
      if (["failed", "disconnected", "closed"].includes(pc.connectionState)) {
        this.runner?.cancel("peer_disconnected"); this.dropPeer(member.id);
        this.status(member.id === this.snapshot.hostId ? { kind: "host-absent" } : { kind: "recovery-required", reason: "peer_disconnected" });
      }
    };
    return peer;
  }
  private send<T extends ControlType>(peer: Peer, type: T, payload: ControlPayloads[T]) {
    if (!this.currentPeer(peer) || !this.authorised() || peer.dc?.readyState !== "open") throw new Error("peer_unavailable");
    peer.dc.send(encodeEnvelope({ roomId: this.snapshot.roomId, sessionId: this.snapshot.sessionId, memberId: this.snapshot.selfId, connectionEpoch: this.snapshot.connectionEpoch, rosterRevision: this.snapshot.rosterRevision, seq: ++peer.seq }, type, payload));
  }
  private attach(peer: Peer, dc: RTCDataChannel) {
    if (peer.dc || dc.label !== "photobooth-v2" || !dc.ordered) { dc.close(); return; }
    peer.dc = dc; dc.binaryType = "arraybuffer"; dc.bufferedAmountLowThreshold = 32768;
    peer.transfers = new PeerTransfers({ peerId: peer.member.id, journal: this.journal!,
      wire: { control: (type, payload) => this.send(peer, type, payload), binary: bytes => { if (!this.currentPeer(peer) || !this.authorised() || dc.readyState !== "open") throw new Error("peer_unavailable"); dc.send(bytes); }, writable: signal => this.writable(peer, signal) },
      authorise: (manifest, phase) => this.authoriseTransfer(peer, manifest, phase === "offer" || phase === "commit"),
      commit: async (manifest, blob) => { const capture = await this.getCapture(manifest.captureId); await this.options.commitRemoteFrame({ manifest, blob, capture }); },
      onProgress: (transferId, received, total) => this.status({ kind: "transfer-progress", transferId, memberId: peer.member.id, received, total }),
      onIncomplete: (transferId, reason) => this.status({ kind: "recovery-required", transferId, reason }),
      onAcknowledged: async (manifest, memberIds) => {
        const capture = await this.getCapture(manifest.captureId);
        if (capture.memberIds.every(id => id === this.snapshot.selfId || memberIds.includes(id))) await this.journal!.markCommitted(manifest.id);
      },
    });
    dc.onopen = () => { if (this.currentPeer(peer)) { try { this.send(peer, "hello", { peerEpoch: peer.member.connectionEpoch }); } catch (error) { this.error(error); this.dropPeer(peer.member.id); } } };
    dc.onclose = () => { if (this.currentPeer(peer)) { this.runner?.cancel("peer_disconnected"); this.dropPeer(peer.member.id); this.status(peer.member.id === this.snapshot.hostId ? { kind: "host-absent" } : { kind: "recovery-required", reason: "peer_disconnected" }); } };
    dc.onmessage = event => {
      if (!this.currentPeer(peer)) return;
      if (peer.queued >= 32 || (typeof event.data === "string" ? event.data.length > CONTROL_BYTES : !(event.data instanceof ArrayBuffer) || event.data.byteLength > 28 + TRANSFER_CHUNK_BYTES)) { this.runner?.cancel("peer_message_rejected"); this.dropPeer(peer.member.id); this.error(new Error("peer_queue_full")); return; }
      peer.queued++;
      peer.pending = peer.pending.then(async () => {
        if (!this.currentPeer(peer) || !this.authorised()) return;
        if (typeof event.data === "string") {
          const message = peer.guard.accept(event.data); if (message) await this.control(peer, message);
        } else if (event.data instanceof ArrayBuffer && peer.hello) await peer.transfers!.receiveChunk(event.data);
        else throw new Error("invalid_peer_message");
      }).catch(error => {
        if (error instanceof RoomProtocolError) { this.runner?.cancel("peer_message_rejected"); this.dropPeer(peer.member.id); }
        this.error(error);
      }).finally(() => { peer.queued--; });
    };
  }
  private async writable(peer: Peer, signal: AbortSignal) {
    const dc = peer.dc;
    if (!dc || !this.currentPeer(peer) || signal.aborted || dc.readyState !== "open") throw new Error("peer_unavailable");
    if (dc.bufferedAmount <= 65536) return;
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => { clearTimeout(timer); dc.removeEventListener("bufferedamountlow", ready); dc.removeEventListener("close", closed); signal.removeEventListener("abort", closed); if (error) reject(error); else resolve(); };
      const ready = () => finish(), closed = () => finish(new Error("peer_unavailable"));
      const timer = setTimeout(() => finish(new Error("transfer_backpressure_timeout")), 5000);
      dc.addEventListener("bufferedamountlow", ready, { once: true }); dc.addEventListener("close", closed, { once: true }); signal.addEventListener("abort", closed, { once: true });
      if (dc.bufferedAmount <= dc.bufferedAmountLowThreshold) ready();
    });
  }
  private async control(peer: Peer, message: Envelope) {
    if (message.type === "hello") {
      if ((message.payload as ControlPayloads["hello"]).peerEpoch !== this.snapshot.connectionEpoch) throw new Error("peer_epoch_changed");
      peer.hello = true;
      if ([...this.peers.values()].every(item => item.hello)) this.status({ kind: "connected" });
      await peer.transfers!.offerStored(); return;
    }
    if (!peer.hello) throw new Error("peer_handshake_required");
    switch (message.type) {
      case "ping": this.send(peer, "pong", { sentAt: (message.payload as ControlPayloads["ping"]).sentAt, repliedAt: this.now() }); return;
      case "pong": return;
      case "capture-notice": { const capture = await this.api.capture((message.payload as ControlPayloads["capture-notice"]).captureId); await this.observeCapture(capture); return; }
      case "capture-request":
        if (this.snapshot.selfId !== this.snapshot.hostId) throw new RoomProtocolError("host_required");
        if (performance.now() - peer.lastCaptureRequestAt < 3000) return;
        peer.lastCaptureRequestAt = performance.now();
        return this.options.onCaptureRequest?.(structuredClone(peer.member));
      case "recipe-proposal":
        if (this.snapshot.selfId !== this.snapshot.hostId) throw new RoomProtocolError("host_required");
        return this.options.onRecipeProposal?.(validateRecipeProposal(message.payload), structuredClone(peer.member));
      case "recipe-commit":
        if (peer.member.id !== this.snapshot.hostId) throw new RoomProtocolError("host_required");
        return this.options.onRecipeCommit?.(validateRecipeCommit(message.payload), structuredClone(peer.member));
      case "transfer-offer": return peer.transfers!.receiveOffer(message.payload as TransferManifest);
      case "transfer-missing": return peer.transfers!.receiveMissing(message.payload as ControlPayloads["transfer-missing"]);
      case "transfer-ack": return peer.transfers!.receiveAck(message.payload as ControlPayloads["transfer-ack"]);
    }
  }
  private startSignals() {
    if (this.closed) return;
    this.signalUntil = Date.now() + ROOM_LIMITS.negotiationSeconds * 1000;
    if (this.signalTimer) clearTimeout(this.signalTimer);
    this.signalTimer = setTimeout(() => void this.pollSignals(), 0);
  }
  private async pollSignals() {
    if (this.closed || !this.snapshot.selfRole || this.signalBusy) return;
    this.signalBusy = true;
    const epoch = this.snapshot.connectionEpoch, revision = this.snapshot.rosterRevision;
    try {
      const page = await this.api.poll(this.signalCursor);
      if (this.closed || epoch !== this.snapshot.connectionEpoch || revision !== this.snapshot.rosterRevision) return;
      if (page.resetRequired) {
        await this.refresh();
        if (this.closed || epoch !== this.snapshot.connectionEpoch || revision !== this.snapshot.rosterRevision) return;
        if (!this.expectedSignalReset && [...this.peers.values()].some(peer => !peer.hello)) this.status({ kind: "recovery-required", reason: "signalling_expired" });
      }
      for (const signal of page.signals) {
        if (this.closed || epoch !== this.snapshot.connectionEpoch || revision !== this.snapshot.rosterRevision) return;
        const peer = this.peers.get(signal.fromMemberId);
        if (!peer && this.snapshot.members.some(member => member.id === signal.fromMemberId && member.status === "admitted")) return;
        try { if (peer) await this.applySignal(peer, signal, epoch, revision); }
        catch (error) { this.error(error); this.status({ kind: "recovery-required", reason: "invalid_signal" }); }
        if (epoch !== this.snapshot.connectionEpoch || revision !== this.snapshot.rosterRevision) return;
        this.signalCursor = Math.max(this.signalCursor, signal.id);
      }
      this.signalCursor = Math.max(this.signalCursor, page.cursor);
      if (!page.resetRequired) this.expectedSignalReset = false;
    } catch (error) { this.error(error); }
    finally {
      this.signalBusy = false;
      if (!this.closed && Date.now() < this.signalUntil && [...this.peers.values()].some(peer => !peer.hello)) this.signalTimer = setTimeout(() => void this.pollSignals(), ROOM_LIMITS.signalPollMs);
      else if ([...this.peers.values()].some(peer => !peer.hello)) this.status({ kind: "recovery-required", reason: "connection_timeout" });
    }
  }
  private async applySignal(peer: Peer, signal: RoomSignal, epoch: string, revision: number) {
    if (!this.currentPeer(peer) || signal.toMemberId !== this.snapshot.selfId || signal.connectionEpoch !== peer.member.connectionEpoch || peer.signalReceipts.has(signal.messageId)) return;
    let parsed: unknown; try { parsed = JSON.parse(signal.payload); } catch { throw new Error("invalid_signal"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid_signal");
    const { rosterRevision, toConnectionEpoch, ...payload } = parsed as Record<string, unknown>;
    if (!Number.isSafeInteger(rosterRevision) || typeof toConnectionEpoch !== "string") throw new Error("invalid_signal");
    if (rosterRevision !== revision || toConnectionEpoch !== epoch) return;
    const active = () => this.currentPeer(peer) && epoch === this.snapshot.connectionEpoch && revision === this.snapshot.rosterRevision;
    if (signal.kind === "sdp") {
      const description = payload as unknown as RTCSessionDescriptionInit;
      if (!["offer", "answer"].includes(description.type) || typeof description.sdp !== "string" || Object.keys(payload).some(key => !["type", "sdp"].includes(key))) throw new Error("invalid_signal");
      const fingerprint = JSON.stringify({ type: description.type, sdp: description.sdp });
      if (peer.remoteSdp === fingerprint) return;
      if (peer.remoteSdp) throw new Error("unexpected_renegotiation");
      if (description.type === "offer" ? this.snapshot.selfRole! < peer.member.role! : this.snapshot.selfRole! > peer.member.role!) throw new Error("unexpected_sdp");
      await peer.pc.setRemoteDescription(description); if (!active()) return;
      peer.remoteSdp = fingerprint;
      for (const candidate of peer.candidates.splice(0)) { await peer.pc.addIceCandidate(candidate); if (!active()) return; }
      if (description.type === "offer") {
        const answer = await peer.pc.createAnswer(); if (!active()) return;
        await peer.pc.setLocalDescription(answer); if (!active()) return;
        await this.api.signal({ messageId: crypto.randomUUID(), toMemberId: peer.member.id, connectionEpoch: epoch, kind: "sdp", payload: JSON.stringify({ type: answer.type, sdp: answer.sdp, rosterRevision: revision, toConnectionEpoch: peer.member.connectionEpoch }) });
      }
    } else {
      const candidate = payload as RTCIceCandidateInit;
      if (typeof candidate.candidate !== "string" || candidate.candidate.length > ROOM_LIMITS.iceBytes || Object.keys(payload).some(key => !["candidate", "sdpMid", "sdpMLineIndex", "usernameFragment"].includes(key))) throw new Error("invalid_signal");
      if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(candidate);
      else if (peer.candidates.length < 16) peer.candidates.push(candidate); else throw new Error("ice_queue_full");
    }
    if (!active()) return;
    peer.signalReceipts.add(signal.messageId);
    if (peer.signalReceipts.size > ROOM_LIMITS.roomSignals) peer.signalReceipts.delete(peer.signalReceipts.values().next().value!);
  }
  private async getCapture(id: string): Promise<RoomCapture> {
    const existing = this.captures.get(id);
    if (existing?.state === "committed") return existing;
    const capture = await this.api.capture(id); this.captures.set(id, capture); return capture;
  }
  private async authoriseTransfer(peer: Peer, manifest: TransferManifest, fresh = false) {
    if (!this.currentPeer(peer) || !peer.hello || !this.authorised() || manifest.roomId !== this.snapshot.roomId || manifest.sessionId !== this.snapshot.sessionId || manifest.expiresAt > this.snapshot.expiresAt) throw new Error("transfer_identity");
    const capture = fresh ? await this.api.capture(manifest.captureId, peer.member.id) : await this.getCapture(manifest.captureId);
    if (!this.currentPeer(peer) || !this.authorised()) throw new Error("transfer_identity");
    const owner = this.snapshot.members.find(member => member.id === manifest.memberId && member.status === "admitted");
    if (capture.state !== "committed" || !capture.memberIds.includes(this.snapshot.selfId) || !capture.memberIds.includes(peer.member.id)
      || !capture.memberIds.includes(manifest.memberId) || !capture.shotIds.includes(manifest.shotId) || owner?.role !== manifest.role
      || ![this.snapshot.selfId, peer.member.id].includes(manifest.memberId) || manifest.bytes > capture.profile.maxPhotoBytes || manifest.width * manifest.height > capture.profile.maxPhotoPixels) throw new Error("transfer_not_authorised");
  }
  private async observeCapture(capture: RoomCapture) {
    this.captures.set(capture.captureId, capture);
    if (!capture.memberIds.includes(this.snapshot.selfId) || capture.rosterRevision !== this.snapshot.rosterRevision) return;
    if (capture.state === "prepared" && !this.acknowledged.has(capture.captureId)) {
      const peersReady = capture.memberIds.every(id => id === this.snapshot.selfId || this.peers.get(id)?.hello);
      if (this.bestRtt > 500) { this.status({ kind: "recovery-required", reason: "clock_sync_unreliable" }); return; }
      if (!peersReady || !await this.options.readiness(capture) || !this.authorised()) return;
      await this.api.ack(capture); this.acknowledged.add(capture.captureId); this.status({ kind: "capture-ready", capture });
    } else if (capture.state === "committed" && !this.startedCaptures.has(capture.captureId)) {
      this.startedCaptures.add(capture.captureId);
      this.status({ kind: "capture-committed", capture });
      void this.runner?.run(capture).catch(error => this.error(error));
    } else if (capture.state === "aborted") this.runner?.cancel("capture_aborted");
  }
  private async captureLocal(capture: RoomCapture, index: number) {
    const blob = await this.options.captureShot(capture, index);
    this.status({ kind: "local-original-saved", captureId: capture.captureId, shotId: capture.shotIds[index], index });
    await this.publishLocalFrame(capture, index, blob);
  }
  private async publishLocalFrame(capture: RoomCapture, index: number, blob: Blob) {
    if (this.closed) throw new Error("room_closed");
    const info = await inspectProjectImage(blob);
    if (this.closed || blob.size > capture.profile.maxPhotoBytes || info.width * info.height > capture.profile.maxPhotoPixels || blob.type !== info.mime) throw new Error("capture_profile_exceeded");
    const manifest: TransferManifest = { id: crypto.randomUUID(), roomId: this.snapshot.roomId, sessionId: this.snapshot.sessionId, captureId: capture.captureId, shotId: capture.shotIds[index], memberId: this.snapshot.selfId, role: this.snapshot.selfRole!, mime: info.mime, width: info.width, height: info.height, bytes: blob.size, sha256: await transferHash(new Uint8Array(await blob.arrayBuffer())), chunkSize: TRANSFER_CHUNK_BYTES, chunks: Math.ceil(blob.size / TRANSFER_CHUNK_BYTES), expiresAt: this.snapshot.expiresAt };
    const retained = await retainOutgoing(this.journal!, manifest, blob);
    if (retained.committed) return;
    for (const peer of this.peers.values()) if (peer.hello && capture.memberIds.includes(peer.member.id) && !retained.acknowledgedBy.includes(peer.member.id)) {
      await this.authoriseTransfer(peer, retained.manifest, true);
      this.send(peer, "transfer-offer", retained.manifest);
    }
  }
  async sendSavedFrame(captureId: string, index: number, blob: Blob): Promise<void> {
    const capture = await this.api.capture(captureId);
    if (!this.authorised() || !this.journal || !this.snapshot.selfRole || capture.state !== "committed" || !capture.memberIds.includes(this.snapshot.selfId) || !Number.isInteger(index) || index < 0 || index >= capture.shotIds.length) throw new Error("capture_not_authorised");
    await this.publishLocalFrame(capture, index, blob);
    await this.journal.finishShot(capture.captureId, capture.shotIds[index]);
  }
  async prepareCapture(proposal: RoomCaptureProposal): Promise<RoomCapture> {
    if (this.snapshot.selfId !== this.snapshot.hostId) throw new Error("host_required");
    const capture = await this.api.prepare(proposal); await this.observeCapture(capture); this.notice(capture); return capture;
  }
  sendRecipeProposal(proposal: RecipeProposal): void {
    if (this.snapshot.selfId === this.snapshot.hostId) throw new Error("host_uses_local_coordinator");
    const peer = this.peers.get(this.snapshot.hostId);
    if (!peer?.hello) throw new Error("host_unavailable");
    this.send(peer, "recipe-proposal", validateRecipeProposal(proposal));
  }
  requestCapture(): void {
    if (this.snapshot.selfId === this.snapshot.hostId) throw new Error("host_prepares_capture");
    const peer = this.peers.get(this.snapshot.hostId);
    if (!peer?.hello) throw new Error("host_unavailable");
    if (performance.now() - this.lastCaptureRequestAt < 3000) throw new Error("capture_request_rate_limited");
    this.send(peer, "capture-request", {});
    this.lastCaptureRequestAt = performance.now();
  }
  sendRecipeCommit(commit: RecipeCommit, toMemberId?: string): void {
    if (this.snapshot.selfId !== this.snapshot.hostId) throw new Error("host_required");
    const checked = validateRecipeCommit(commit);
    const targets = toMemberId ? [this.peers.get(toMemberId)] : this.peerReadiness.map(item => this.peers.get(item.member.id));
    if (targets.some(peer => !peer?.hello)) throw new Error("peer_unavailable");
    for (const peer of targets) this.send(peer!, "recipe-commit", checked);
  }
  async commitCapture(captureId: string): Promise<RoomCapture> { const capture = await this.api.commit(captureId); await this.observeCapture(capture); this.notice(capture); return capture; }
  async abortCapture(captureId: string): Promise<RoomCapture> { const capture = await this.api.abort(captureId); await this.observeCapture(capture); this.notice(capture); return capture; }
  private notice(capture: RoomCapture) { for (const peer of this.peers.values()) if (peer.hello) this.send(peer, "capture-notice", { captureId: capture.captureId }); }
  async admit(memberId: string) { await this.api.control("admit", { memberId }); return this.refresh(); }
  async remove(memberId: string) { await this.api.control("remove", { memberId }); return this.refresh(); }
  async lock(locked: boolean) { await this.api.control("lock", { locked }); return this.refresh(); }
  async end() { await this.api.control("end", {}); this.close(); }
  async reconnect() { this.generation++; this.runner?.cancel("reconnecting"); this.closePeers(); this.signalCursor = 0; this.expectedSignalReset = true; await this.refresh(true); this.startSignals(); }
  private dropPeer(id: string) { const peer = this.peers.get(id); if (!peer) return; this.peers.delete(id); peer.transfers?.close(); peer.dc?.close(); peer.pc.close(); this.options.onPeerDisconnected?.(structuredClone(peer.member)); }
  private closePeers() { for (const id of [...this.peers.keys()]) this.dropPeer(id); }
  close() {
    if (this.closed) return;
    this.closed = true; this.generation++; this.controller.abort(); this.runner?.cancel("room_closed");
    if (this.stateTimer) clearTimeout(this.stateTimer); if (this.signalTimer) clearTimeout(this.signalTimer);
    this.closePeers(); this.journal?.close(); this.options.onStatus({ kind: "closed" });
  }
}
