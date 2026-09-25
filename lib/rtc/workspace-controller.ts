import type { PhotoProject, ProjectScope } from "../projects/model";
import { openProjectRepository, type ProjectRepository } from "../projects/storage";
import { LAYOUTS, type Role } from "../layouts";
import { ROOM_LIMITS, type RoomCapture, type RoomState } from "../server/room-contract";
import { RoomEngineV2, type RoomEngineV2Options, type RoomV2Status } from "./engine-v2";
import { registerRoomScopeCloser } from "./scope-lifecycle";
import { createRoomApi, validateRoomState, type RoomApi } from "./signaling-v2";
import { acceptRecipeCommit, chooseRecipeReconnect, initialRecipeCommit, RecipeCoordinator, type RecipeCommit, type RecipeContext, type RecipeEdit, type RecipeProposal } from "./recipe-v2";
import { captureRoomOriginal, roomCaptureProfile, roomIceServers } from "./workspace-capture";
import { openRoomWorkspaceStore, type RoomWorkspaceBinding, type RoomWorkspaceStore } from "./workspace-store";

type WorkspaceEngine = Pick<RoomEngineV2, "start" | "close" | "refresh" | "reconnect" | "commitCapture" | "prepareCapture" | "abortCapture" | "sendRecipeCommit" | "sendRecipeProposal" | "requestCapture" | "sendSavedFrame" | "peerReadiness">;
export interface RoomWorkspaceDependencies {
  api?: RoomApi;
  openStore?: (binding: RoomWorkspaceBinding) => Promise<RoomWorkspaceStore>;
  createEngine?: (options: RoomEngineV2Options) => WorkspaceEngine;
  openRepository?: (scope: ProjectScope) => Promise<Pick<ProjectRepository, "duplicate" | "close">>;
  captureOriginal?: typeof captureRoomOriginal;
  iceServers?: () => RTCIceServer[];
  onError?: (error: unknown) => void;
}
export interface LocalFrameRecovery { id: string; captureId: string; shotIndex: number; bytes: number; persisted: boolean }
interface PendingLocalFrame extends LocalFrameRecovery { capture: RoomCapture; role: Role; blob: Blob }

export interface WorkspaceSnapshot {
  room: RoomState; draft: PhotoProject | null; recipe: RecipeCommit | null; round: PhotoProject | null;
  peers: { id: string; connected: boolean }[]; status: string; error: string | null;
  busy: boolean; cameraConnected: boolean; capturing: boolean; pendingProposal: boolean;
  recoveryRecipe: RecipeCommit | null; captureRequest: string | null; savedShots: number;
  pendingLocalFrames: readonly LocalFrameRecovery[]; remoteStreamRevision: number;
}
const CONNECTION_ERRORS = new Set(["signalling_expired", "peer_disconnected", "peer_unavailable", "host_unavailable", "connection_timeout", "authorisation_unavailable"]);
const errorMessage = (error: unknown) => {
  const code = error instanceof Error ? error.message : "";
  const messages: Record<string, string> = {
    access_denied: "Your room access has ended. Your saved projects are still on this device.",
    authorisation_unavailable: "Room access could not be checked. Capture is paused; reconnect when the connection returns.",
    peer_disconnected: "Someone disconnected. Capture is paused until everyone reconnects.",
    recovery_required: "The room or shared design changed. Reconnect and check the shared design before taking another round.",
    protocol_update_required: "This room uses a newer app version. Keep your saved project, update the app, then rejoin the room.",
    update_required: "This shared design needs a newer app version. Keep your saved project, update the app, then rejoin the room.",
    ownership_denied: "You can change only your own photos, placement and stickers.",
    not_ready: "Everyone must be connected with the same design before capture.",
    state_conflict: "The room changed. Refresh the connection before trying again.",
    rate_limited: "The room is receiving too many requests. Wait a moment, then retry.",
    unsaved_local_photos: "A photo still needs saving. Retry or download it before leaving this room.",
    capture_request_rate_limited: "Your request was sent. Wait a few seconds before asking again.",
  };
  return messages[code] ?? "This action could not finish. Your saved originals are retained. Retry or keep an editable copy.";
};

export class RoomWorkspaceController {
  private snapshot: WorkspaceSnapshot;
  private listeners = new Set<() => void>();
  private abort = new AbortController();
  private api;
  private store: RoomWorkspaceStore | null = null;
  private engine: WorkspaceEngine | null = null;
  private coordinator: RecipeCoordinator | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pollPending = false;
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private closed = false;
  private errorProvenance: "connection" | "operation" | null = null;
  private starting: Promise<void> | null = null;
  private closing: Promise<void> | null = null;
  private connectionGeneration = 0;
  private unregisterScope: () => void;
  private rosterKey = "";
  private commitPending = new Set<string>();
  private pendingWrite: RecipeCommit | null = null;
  private pendingWriteMode: "normal" | "accept-host" = "normal";
  private pendingAcceptanceCaptureId: string | undefined;
  private recoveringOriginals = false;
  private localFrames = new Map<string, PendingLocalFrame>();
  private video: HTMLVideoElement | null = null;
  private offeredConnection: { video: HTMLVideoElement; stream: MediaStream } | null = null;
  private streams = new Map<string, MediaStream>();
  private proposalTimer: ReturnType<typeof setTimeout> | null = null;
  private lastBroadcast = "";
  private clockOffset: number;
  constructor(readonly initial: RoomState, readonly scope: ProjectScope, private readonly dependencies: RoomWorkspaceDependencies = {}) {
    this.snapshot = { room: validateRoomState(initial), draft: null, recipe: null, round: null, peers: [], status: initial.selfRole ? "Choose when to turn on your camera." : "Waiting for the host to let you in.", error: null, busy: false, cameraConnected: false, capturing: false, pendingProposal: false, recoveryRecipe: null, captureRequest: null, savedShots: 0, pendingLocalFrames: [], remoteStreamRevision: 0 };
    this.api = dependencies.api ?? createRoomApi(initial.roomId, { signal: this.abort.signal });
    this.clockOffset = initial.serverNow - Date.now();
    this.unregisterScope = registerRoomScopeCloser(scope, () => this.close());
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  get remoteStreams() { return new Map(this.streams); }
  get serverNow() { return Date.now() + this.clockOffset; }
  private patch(value: Partial<WorkspaceSnapshot>) {
    if (this.closed) return;
    if (value.error === null) this.errorProvenance = null;
    this.snapshot = { ...this.snapshot, ...value }; for (const listener of this.listeners) listener();
  }
  private check() { if (this.closed) throw new Error("room_closed"); }
  private fail(error: unknown, provenance: "connection" | "operation" = "operation") {
    if (this.closed) return;
    this.dependencies.onError?.(error);
    if (provenance === "connection" && this.snapshot.error && this.errorProvenance === "operation") return;
    this.errorProvenance = provenance; this.patch({ error: errorMessage(error), busy: false });
  }
  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    if (this.closed || this.pending >= 16) return Promise.reject(new Error("room_busy"));
    this.pending++;
    const task = this.tail.then(() => { this.check(); return action(); });
    this.tail = task.catch(() => undefined).finally(() => { this.pending--; });
    return task;
  }
  private context(): RecipeContext {
    const { room, draft } = this.snapshot;
    if (!draft) throw new Error("not_ready");
    return { project: draft, hostId: room.hostId, members: room.members.filter(member => member.status === "admitted" && member.role).map(member => ({ id: member.id, role: member.role! })), availableMediaIds: new Set(draft.media.map(media => media.id)) };
  }
  start(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return this.starting ??= this.startStore().finally(() => { if (!this.store) this.starting = null; });
  }
  private async startStore() {
    try {
      const store = await (this.dependencies.openStore ?? openRoomWorkspaceStore)({ scope: this.scope, roomId: this.initial.roomId, sessionId: this.initial.sessionId, selfId: this.initial.selfId });
      if (this.closed) { await store.close(); return; }
      this.store = store;
      await this.acceptState(this.initial);
      this.schedulePoll();
    } catch (error) { this.fail(error); }
  }
  private schedulePoll() {
    if (this.timer) clearTimeout(this.timer);
    if (this.closed || this.engine || this.snapshot.room.status === "ended") return;
    this.timer = setTimeout(() => {
      void this.refresh().catch(error => this.fail(error)).finally(() => this.schedulePoll());
    }, ROOM_LIMITS.statePollMs);
  }
  async refresh() {
    if (this.engine) { const engine = this.engine; const state = await engine.refresh(); if (this.engine === engine) await this.acceptState(state, () => this.engine === engine); return; }
    if (this.pollPending) return;
    this.pollPending = true;
    try { const state = await this.api.state(); await this.acceptState(state); }
    finally { this.pollPending = false; }
  }
  private acceptState(value: RoomState, current: () => boolean = () => true): Promise<void> {
    const room = validateRoomState(value);
    return this.enqueue(async () => {
    this.check();
    if (!current()) return;
    if (room.roomId !== this.initial.roomId || room.sessionId !== this.initial.sessionId || room.selfId !== this.initial.selfId) throw new Error("room_identity_changed");
    if (room.rosterRevision < this.snapshot.room.rosterRevision || room.serverNow < this.snapshot.room.serverNow) return;
    this.clockOffset = room.serverNow - Date.now();
    let streamsChanged = false;
    for (const id of this.streams.keys()) if (!room.members.some(member => member.id === id && member.status === "admitted")) streamsChanged = this.streams.delete(id) || streamsChanged;
    this.patch({ room, remoteStreamRevision: this.snapshot.remoteStreamRevision + Number(streamsChanged) });
    if (room.status === "ended" || !room.members.some(member => member.id === room.selfId && member.status !== "removed")) {
      this.disconnect(); this.patch({ status: room.status === "ended"
        ? "This room has ended. Your saved projects are available below."
        : "Your access to this room has ended. Your saved projects are available below." }); return;
    }
    const key = `${room.rosterRevision}:${room.members.filter(member => member.status === "admitted").map(member => `${member.id}:${member.role}`).join(",")}`;
    if (room.selfRole && key !== this.rosterKey && this.store) {
      if (key === this.rosterKey) return;
      const previous = this.rosterKey;
      if (this.pendingWrite) await this.persistRecipe(this.pendingWrite);
      const draft = await this.store!.loadDraft(room); this.check();
      if (!current()) return;
      this.coordinator?.close(); this.coordinator = null;
      this.rosterKey = key; this.lastBroadcast = "";
      this.patch({ draft: draft.project, recipe: draft.recipe, recoveryRecipe: null, pendingProposal: false, capturing: false, ...(previous ? { round: null, savedShots: 0, status: "The group changed. A new design is ready; previous rounds remain in My projects." } : {}) });
      if (this.context().members.length >= 2) {
        const recipe = draft.recipe ?? await initialRecipeCommit(this.context());
        const saved = await this.store!.saveRecipe(recipe); this.check();
        this.patch({ draft: saved.project, recipe });
        if (room.selfId === room.hostId) this.coordinator = new RecipeCoordinator(recipe, () => this.context());
      }
    }
    if (this.store && room.capture?.memberIds.includes(room.selfId) && room.capture.rosterRevision === room.rosterRevision && this.snapshot.round?.id !== room.capture.captureId) {
      const round = await this.store.loadRound(room.capture.captureId); this.check();
      if (!current()) return;
      if (round) this.patch({ round: round.project, savedShots: round.project.media.filter(media => media.kind === "photo").length });
    }
    this.updatePeers();
    if (this.engine && room.capture?.state === "prepared" && room.selfId === room.hostId && room.capture.acks.length === room.capture.memberIds.length && !this.commitPending.has(room.capture.captureId)) {
      const capture = room.capture; this.commitPending.add(capture.captureId);
      const engine = this.engine;
      void engine.commitCapture(capture.captureId).catch(error => { if (this.engine === engine) { this.patch({ capturing: false }); this.fail(error); } }).finally(() => this.commitPending.delete(capture.captureId));
    }
    });
  }
  async connect(video: HTMLVideoElement, stream: MediaStream) {
    if (this.closed) return;
    this.offeredConnection = { video, stream };
    const generation = this.connectionGeneration;
    await this.start();
    if (generation !== this.connectionGeneration) return;
    if (this.engine || this.closed || !this.store || !this.snapshot.room.selfRole) return;
    this.video = video;
    if (this.timer) clearTimeout(this.timer);
    const active = () => this.engine === engine && !this.closed;
    const engine = (this.dependencies.createEngine ?? (options => new RoomEngineV2(options)))({ initial: this.snapshot.room, scope: this.scope, iceServers: (this.dependencies.iceServers ?? roomIceServers)(),
      readiness: capture => active() ? this.readiness(capture, active) : Promise.resolve(false),
      captureShot: async (capture, index) => {
        if (!active() || !this.video || !this.store || !this.snapshot.room.selfRole) throw new Error("not_ready");
        const role = this.snapshot.room.selfRole, store = this.store;
        const id = `${capture.captureId}:${index}`;
        if (!Number.isInteger(index) || index < 0 || index >= capture.shotIds.length || this.localFrames.has(id) || this.localFrames.size >= 4 || this.localFrames.size && [...this.localFrames.values()].some(frame => frame.captureId !== capture.captureId)) throw new Error("unsaved_local_photos");
        const blob = await (this.dependencies.captureOriginal ?? captureRoomOriginal)(this.video, capture.profile, this.abort.signal); this.check();
        if (!blob.size || blob.size > capture.profile.maxPhotoBytes || [...this.localFrames.values()].reduce((sum, frame) => sum + frame.bytes, 0) + blob.size > capture.profile.maxPhotoBytes * capture.shotIds.length) throw new Error("capture_profile_exceeded");
        const frame: PendingLocalFrame = { id, captureId: capture.captureId, shotIndex: index, bytes: blob.size, persisted: false, blob, capture, role };
        this.localFrames.set(id, frame); this.publishLocalFrames();
        if (!active()) throw new Error("room_generation_changed");
        await store.saveFrame({ capture, role, shotIndex: index, blob }); this.check();
        frame.persisted = true; this.publishLocalFrames();
        await this.updateRound(capture.captureId); return blob;
      },
      commitRemoteFrame: async ({ capture, manifest, blob }) => {
        if (!active() || !this.store) throw new Error("not_ready");
        await this.store.saveFrame({ capture, role: manifest.role, shotIndex: capture.shotIds.indexOf(manifest.shotId), blob }); this.check();
        await this.updateRound(capture.captureId);
      },
      onState: state => { if (active()) void this.acceptState(state, active).catch(error => { if (active()) this.fail(error); }); },
      onStatus: value => { if (active()) this.onStatus(value); },
      onPeerDisconnected: member => { if (active() && this.streams.delete(member.id)) this.patch({ remoteStreamRevision: this.snapshot.remoteStreamRevision + 1 }); },
      onRemoteStream: (member, remote) => { if (active() && this.streams.get(member.id) !== remote) { this.streams.set(member.id, remote); this.patch({ remoteStreamRevision: this.snapshot.remoteStreamRevision + 1 }); } },
      onError: code => { if (active()) this.fail(new Error(code), CONNECTION_ERRORS.has(code) ? "connection" : "operation"); },
      onRecipeProposal: (proposal, sender) => active() ? this.commitProposal(proposal, sender.id, active) : Promise.reject(new Error("room_generation_changed")),
      onRecipeCommit: (commit, sender) => active() ? this.receiveRecipe(commit, sender.id, active) : Promise.reject(new Error("room_generation_changed")),
      onCaptureRequest: member => { if (active()) this.patch({ captureRequest: member.displayName }); },
    });
    this.engine = engine;
    try { await engine.start(stream); if (!active()) { engine.close(); return; } this.patch({ cameraConnected: true }); this.updatePeers(); }
    catch (error) { engine.close(); if (active()) { this.engine = null; this.patch({ cameraConnected: false }); this.fail(error); this.schedulePoll(); } }
  }
  disconnect() {
    this.connectionGeneration++;
    this.engine?.close(); this.engine = null; this.video = null; this.offeredConnection = null; this.streams.clear(); this.lastBroadcast = "";
    this.patch({ cameraConnected: false, peers: [], capturing: false, remoteStreamRevision: this.snapshot.remoteStreamRevision + 1 }); this.schedulePoll();
  }
  private updatePeers() {
    const peers = this.engine?.peerReadiness.map(item => ({ id: item.member.id, connected: item.connected })) ?? [];
    this.patch({ peers });
    const { room, recipe } = this.snapshot;
    const expectedPeers = room.members.filter(member => member.status === "admitted" && member.id !== room.selfId).length;
    if (this.errorProvenance === "connection" && room.status === "open" && peers.length > 0 && peers.length === expectedPeers && peers.every(peer => peer.connected) && !this.pendingWrite && !this.snapshot.recoveryRecipe) this.patch({ error: null });
    if (room.selfId === room.hostId && recipe && peers.length && peers.every(peer => peer.connected) && !this.pendingWrite) {
      const key = `${recipe.revision}:${recipe.recipeHash}:${room.connectionEpoch}:${room.members.map(member => member.connectionEpoch).join(":")}`;
      if (this.lastBroadcast !== key) {
        try { this.engine!.sendRecipeCommit(recipe); this.lastBroadcast = key; }
        catch { this.lastBroadcast = ""; }
      }
    }
  }
  private onStatus(value: RoomV2Status) {
    if (this.closed) return;
    this.updatePeers();
    if (value.kind === "connected") this.patch({ status: "Connected. Everyone keeps a local editable copy." });
    if (value.kind === "host-absent") this.patch({ status: "The host disconnected. Keep your copy or wait for them to return.", capturing: false });
    if (value.kind === "recovery-required") { this.patch({ capturing: false }); this.fail(new Error(value.reason), CONNECTION_ERRORS.has(value.reason) ? "connection" : "operation"); }
    if (value.kind === "capture-ready") this.patch({ status: "Your camera and saved design are ready. Waiting for everyone." });
    if (value.kind === "capture-committed") this.patch({ capturing: true, status: "Everyone is ready. Get into position." });
    if (value.kind === "capture-complete") this.patch({ capturing: false, status: "Your photos are saved. Receiving the remaining originals…" });
    if (value.kind === "capture-incomplete") this.patch({ capturing: false, status: "Capture was interrupted. Saved photos are retained; missing photos are shown below." });
    if (value.kind === "shot-saved") { this.localFrames.delete(`${value.captureId}:${value.index}`); this.publishLocalFrames(); }
  }
  private async readiness(capture: RoomCapture, current: () => boolean = () => true): Promise<boolean> {
    const { recipe, recoveryRecipe, pendingProposal } = this.snapshot;
    if (!this.store || !this.video || this.video.readyState < 2 || this.video.paused || !recipe || recipe.recipeHash !== capture.recipeHash || recoveryRecipe || pendingProposal || this.pendingWrite || this.localFrames.size || this.recoveringOriginals) return false;
    const round = await this.store.prepareRound(capture, recipe); this.check();
    if (!current()) return false;
    this.patch({ round: round.project, savedShots: round.project.media.filter(media => media.kind === "photo").length }); return true;
  }
  private async updateRound(captureId: string) {
    const round = await this.store?.loadRound(captureId); this.check();
    if (round && this.snapshot.round?.id === captureId) {
      const savedShots = round.project.media.filter(media => media.kind === "photo").length;
      this.patch({ round: round.project, savedShots, ...(savedShots === round.capture.shotIds.length * round.capture.memberIds.length ? { status: "Every original is saved on this device. Finish your design together." } : {}) });
    }
  }
  capture(): Promise<void> { return this.beginCapture(false); }
  async keepIncompleteRoundAndCapture(): Promise<void> {
    await this.enqueue(async () => {
      if (!this.store || this.snapshot.room.selfId !== this.snapshot.room.hostId || this.snapshot.capturing || this.localFrames.size) throw new Error("not_ready");
      if (this.pendingWrite) await this.persistRecipe(this.pendingWrite);
      const { round, room } = this.snapshot;
      if (!round || !room.capture || round.id !== room.capture.captureId || this.snapshot.savedShots >= room.capture.memberIds.length * room.capture.shotIds.length) throw new Error("not_ready");
      const preserved = await this.store.loadRound(round.id); this.check();
      if (!preserved || preserved.project.id !== round.id || preserved.project.revision !== round.revision) throw new Error("state_conflict");
      await this.beginCapture(true);
    });
  }
  private async beginCapture(allowIncomplete: boolean) {
    if (this.recoveringOriginals) throw new Error("not_ready");
    if (this.localFrames.size) throw new Error("unsaved_local_photos");
    if (!this.engine) return;
    const { room, recipe, peers, round } = this.snapshot;
    if (room.selfId !== room.hostId) { this.engine.requestCapture(); this.patch({ status: "Capture requested. The host will start when everyone is ready." }); return; }
    if (!recipe || this.snapshot.capturing || this.snapshot.pendingProposal || this.snapshot.recoveryRecipe || this.pendingWrite || peers.length < 1 || !peers.every(peer => peer.connected)) throw new Error("not_ready");
    if (!allowIncomplete && round && room.capture && this.snapshot.savedShots < room.capture.memberIds.length * room.capture.shotIds.length) throw new Error("not_ready");
    const shots = recipe.recipe.editor.template ? Math.max(...Object.values(recipe.recipe.editor.template.requiredSources)) : LAYOUTS.find(layout => layout.id === recipe.recipe.editor.layoutId)!.shots;
    this.patch({ capturing: true, captureRequest: null, error: null });
    try {
      await this.engine.prepareCapture({ captureId: crypto.randomUUID(), rosterRevision: room.rosterRevision, recipeHash: recipe.recipeHash, shotIds: Array.from({ length: shots }, () => crypto.randomUUID()), fireAt: this.serverNow + 20000, intervalMs: recipe.recipe.editor.story ? 15000 : 2500, profile: roomCaptureProfile(peers.length + 1, shots) });
      await this.engine.refresh();
    } catch (error) { this.patch({ capturing: false }); throw error; }
  }
  private async persistRecipe(commit: RecipeCommit) {
    if (!this.store) throw new Error("not_ready");
    this.pendingWrite = commit;
    const draft = this.pendingWriteMode === "accept-host" ? (await this.store.acceptHostSnapshot(commit, this.pendingAcceptanceCaptureId)).draft : await this.store.saveRecipe(commit); this.check();
    if (this.snapshot.round) {
      if (this.pendingWriteMode !== "accept-host") await this.store.updateRoundRecipe(this.snapshot.round.id, commit);
      this.check(); await this.updateRound(this.snapshot.round.id);
    }
    this.pendingWrite = null;
    this.pendingWriteMode = "normal"; this.pendingAcceptanceCaptureId = undefined;
    this.patch({ recipe: commit, draft: draft.project, pendingProposal: false, error: null });
    if (this.proposalTimer) clearTimeout(this.proposalTimer);
  }
  private commitProposal(proposal: RecipeProposal, sender: string, current: () => boolean = () => true): Promise<void> {
    return this.enqueue(async () => {
      if (!current()) throw new Error("room_generation_changed");
      if (!this.coordinator || this.snapshot.capturing || this.pendingWrite) throw new Error("not_ready");
      const commit = await this.coordinator.commit(sender, proposal); this.check();
      await this.persistRecipe(commit); this.lastBroadcast = ""; this.updatePeers();
    });
  }
  async edit(edit: RecipeEdit) {
    const { recipe, room } = this.snapshot;
    if (!recipe || this.snapshot.capturing || this.snapshot.pendingProposal || this.snapshot.recoveryRecipe || this.pendingWrite) throw new Error("not_ready");
    const proposal: RecipeProposal = { schemaVersion: 1, id: crypto.randomUUID(), baseRevision: recipe.revision, edit };
    if (room.selfId === room.hostId) await this.commitProposal(proposal, room.selfId);
    else {
      if (!this.engine) throw new Error("not_ready");
      this.engine.sendRecipeProposal(proposal); this.patch({ pendingProposal: true });
      this.proposalTimer = setTimeout(() => this.patch({ pendingProposal: false, error: "The host has not confirmed your edit. Reconnect to check the shared design before retrying." }), 10000);
    }
  }
  private receiveRecipe(incoming: RecipeCommit, sender: string, live: () => boolean = () => true): Promise<void> {
    return this.enqueue(async () => {
      if (!live()) throw new Error("room_generation_changed");
      const current = this.snapshot.recipe;
      if (!current || this.pendingWrite) throw new Error("not_ready");
      try {
        const accepted = await acceptRecipeCommit(current, incoming, sender, this.context()); this.check();
        if (accepted !== current) await this.persistRecipe(accepted);
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "recovery_required") throw error;
        await chooseRecipeReconnect(current.recipe, incoming, sender, this.context(), "accept-host"); this.check();
        this.patch({ recoveryRecipe: incoming, pendingProposal: false, error: null });
      }
    });
  }
  async acceptHost() {
    await this.enqueue(async () => {
      const { recoveryRecipe, recipe, round, draft, room } = this.snapshot;
      if (!recoveryRecipe || !recipe || !draft) return;
      await chooseRecipeReconnect(recipe.recipe, recoveryRecipe, room.hostId, this.context(), "accept-host"); this.check();
      if (this.pendingWrite) throw new Error("not_ready");
      const repository = await (this.dependencies.openRepository ?? openProjectRepository)(this.scope);
      try { await repository.duplicate((round ?? draft).id, { name: "Room design before reconnect" }); this.check(); }
      finally { repository.close(); }
      this.pendingWriteMode = "accept-host"; this.pendingAcceptanceCaptureId = round?.id;
      await this.persistRecipe(recoveryRecipe); this.patch({ recoveryRecipe: null });
    });
  }
  async retrySave() {
    await this.enqueue(async () => { if (this.pendingWrite) { const accepting = this.pendingWriteMode === "accept-host"; await this.persistRecipe(this.pendingWrite); if (accepting) this.patch({ recoveryRecipe: null }); this.lastBroadcast = ""; this.updatePeers(); } });
  }
  private publishLocalFrames() {
    this.patch({ pendingLocalFrames: [...this.localFrames.values()].map(({ id, captureId, shotIndex, bytes, persisted }) => ({ id, captureId, shotIndex, bytes, persisted })) });
  }
  getLocalRecoveryBlob(id: string): Blob | null { return this.localFrames.get(id)?.blob ?? null; }
  async retryLocalFrames(): Promise<void> {
    await this.enqueue(async () => {
      if (!this.store || this.snapshot.capturing) throw new Error("not_ready");
      for (const frame of [...this.localFrames.values()]) {
        if (!frame.persisted) {
          await this.store.saveFrame({ capture: frame.capture, role: frame.role, shotIndex: frame.shotIndex, blob: frame.blob }); this.check();
          frame.persisted = true; this.publishLocalFrames(); await this.updateRound(frame.captureId);
        }
        if (!this.engine) throw new Error("host_unavailable");
        await this.engine.sendSavedFrame(frame.captureId, frame.shotIndex, frame.blob); this.check();
        this.localFrames.delete(frame.id); this.publishLocalFrames();
      }
      this.patch({ error: null, status: "Your retained photos are saved and queued for sharing." });
    });
  }
  async resumeSavedOriginals(): Promise<void> {
    await this.enqueue(async () => {
      const { room, round } = this.snapshot, engine = this.engine, store = this.store;
      if (!engine || !store || !room.selfRole || !round || this.snapshot.capturing || this.pendingWrite || this.localFrames.size || this.snapshot.pendingProposal) throw new Error("not_ready");
      const role = room.selfRole, order = round.sourceOrder[role];
      if (order.length > 4 || !round.participants.some(person => person.id === room.selfId && person.role === role)) throw new Error("state_conflict");
      const current = () => { this.check(); if (this.engine !== engine || this.snapshot.round?.id !== round.id) throw new Error("room_generation_changed"); };
      this.recoveringOriginals = true;
      try {
        let queued = 0;
        for (let index = 0; index < order.length; index++) {
          if (!order[index]) continue;
          const blob = await store.loadSavedFrame(round.id, role, index); current();
          if (!blob) throw new Error("saved_original_missing");
          await engine.sendSavedFrame(round.id, index, blob); current(); queued++;
        }
        this.patch({ error: null, status: queued ? `${queued} saved original${queued === 1 ? " is" : "s are"} queued for sharing. Missing photos remain empty.` : "There are no saved originals from your camera in this round." });
      } finally { this.recoveringOriginals = false; }
    });
  }
  async openEditableCopy(): Promise<string> {
    return this.enqueue(async () => {
      if (this.snapshot.capturing || this.snapshot.pendingProposal) throw new Error("not_ready");
      if ([...this.localFrames.values()].some(frame => !frame.persisted)) throw new Error("unsaved_local_photos");
      if (this.pendingWrite) await this.persistRecipe(this.pendingWrite);
      const project = this.snapshot.round ?? this.snapshot.draft;
      if (!project) throw new Error("not_ready");
      const repository = await (this.dependencies.openRepository ?? openProjectRepository)(this.scope);
      try { const copy = await repository.duplicate(project.id, { name: "My room copy" }); this.check(); return copy.id; }
      finally { repository.close(); }
    });
  }
  async control(action: "admit" | "remove" | "lock" | "end", value?: string | boolean) {
    if (action === "end") { await this.api.control(action, {}); this.disconnect(); this.patch({ room: { ...this.snapshot.room, status: "ended" } }); return; }
    const result = await this.api.control(action, action === "lock" ? { locked: value } : { memberId: value });
    if ("roomId" in result) await this.acceptState(result);
    if (this.engine) await this.engine.refresh();
  }
  async reconnect() {
    this.lastBroadcast = "";
    if (this.engine) await this.engine.reconnect();
    else if (this.offeredConnection) await this.connect(this.offeredConnection.video, this.offeredConnection.stream);
    else { await this.start(); await this.refresh(); }
  }
  async cancelCapture() { if (this.engine && this.snapshot.room.capture) await this.engine.abortCapture(this.snapshot.room.capture.captureId); this.patch({ capturing: false }); }
  async action(action: () => Promise<unknown>) {
    if (this.snapshot.busy || this.closed) return;
    this.patch({ busy: true });
    try { await action(); } catch (error) { this.fail(error); } finally { this.patch({ busy: false }); }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true; this.connectionGeneration++; this.unregisterScope(); this.abort.abort(); this.engine?.close(); this.coordinator?.close(); this.streams.clear();
    if (this.timer) clearTimeout(this.timer); if (this.proposalTimer) clearTimeout(this.proposalTimer);
    this.localFrames.clear(); this.offeredConnection = null; this.video = null; this.listeners.clear();
    this.closing = (async () => { await this.starting; await this.tail; await this.store?.close(); })();
    return this.closing;
  }
}
