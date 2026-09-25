import assert from "node:assert/strict";
import { createStoryPlan } from "../lib/stories/model";
import test from "node:test";
import { createProject, type PhotoProject } from "../lib/projects/model";
import { RoomWorkspaceController, type RoomWorkspaceDependencies } from "../lib/rtc/workspace-controller";
import type { RoomWorkspaceStore, RoomRound } from "../lib/rtc/workspace-store";
import type { RoomEngineV2Options } from "../lib/rtc/engine-v2";
import type { RoomApi } from "../lib/rtc/signaling-v2";
import type { RoomState, RoomCaptureProposal } from "../lib/server/room-contract";
import { RecipeCoordinator } from "../lib/rtc/recipe-v2";
import { EPOCH, MEMBER_A, MEMBER_B, ROOM_ID, SESSION_ID, captureFixture } from "./helpers/room-fixture";
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(ready: () => boolean) { for (let i = 0; i < 100 && !ready(); i++) await new Promise(resolve => setTimeout(resolve, 2)); assert(ready()); }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function fixture(guest = false) {
  const members: RoomState["members"] = [{ id: MEMBER_A, role: "A", displayName: "Host", status: "admitted", connectionEpoch: EPOCH }, { id: MEMBER_B, role: "B", displayName: "Guest", status: "admitted", connectionEpoch: EPOCH }];
  let state: RoomState = { roomId: ROOM_ID, sessionId: SESSION_ID, code: "ABC234", hostId: MEMBER_A, selfId: guest ? MEMBER_B : MEMBER_A, selfRole: guest ? "B" : "A", connectionEpoch: EPOCH, status: "open", locked: false, rosterRevision: 1, expiresAt: Date.now() + 60000, serverNow: Date.now(), members, capture: null };
  let project = createProject({ id: "fixture-room-draft", mode: "duo", role: guest ? "B" : "A", participants: members.map(member => ({ id: member.id, role: member.role! })) });
  let peerConnected = true, failStart = false;
  let failSave = false, failFrame = false, failShare = false, failAcceptance = false, captures = 0, commitCalls = 0, closedStore = false;
  let savedRound: RoomRound | null = null, failLoad = false;
  let roundOrder: PhotoProject["sourceOrder"] | undefined;
  const savedOriginals = new Map<number, Blob>(), savedFrameReads: { role: string; index: number }[] = [];
  const proposals: RoomCaptureProposal[] = [];
  const saved: Blob[] = [], shared: Blob[] = [], duplicates: string[] = [], accepted: number[] = [], recipeWrites: number[] = [];
  let saveGate: Promise<void> | undefined, startGate: Promise<void> | undefined, openGate: Promise<void> | undefined;
  const engines: { options: RoomEngineV2Options; closed: boolean }[] = [];
  const unused = async (): Promise<never> => { throw new Error("unexpected operation"); };
  const store: RoomWorkspaceStore = {
    loadDraft: async () => ({ project, recipe: null }),
    saveRecipe: async commit => { recipeWrites.push(commit.revision); await saveGate; if (failSave) throw new Error("quota"); project = { ...project, editor: commit.recipe.editor }; return { project, recipe: commit }; },
    saveFrame: async ({ blob }) => { saved.push(blob); if (failFrame) throw new Error("quota"); return "photo"; },
    loadSavedFrame: async (_id, role, index) => { savedFrameReads.push({ role, index }); return savedOriginals.get(index) ?? null; },
    loadRound: async () => { if (failLoad) throw new Error("storage_unavailable"); return savedRound; },
    prepareRound: async (capture, recipe) => { savedRound = { project: { ...project, id: capture.captureId, sourceOrder: roundOrder ?? project.sourceOrder }, capture, recipe, participants: project.participants, initialRecipeHash: recipe.recipeHash }; return savedRound; }, updateRoundRecipe: unused,
    acceptHostSnapshot: async commit => { accepted.push(commit.revision); if (failAcceptance) throw new Error("quota"); project = { ...project, editor: commit.recipe.editor }; return { draft: { project, recipe: commit }, round: null }; },
    close: async () => { closedStore = true; },
  };
  const api: RoomApi = { state: async () => state, signal: unused, poll: unused, prepare: unused, capture: unused, ack: unused, commit: unused, abort: unused, control: unused };
  const blob = new Blob(["retained original bytes"], { type: "image/jpeg" });
  const deps: RoomWorkspaceDependencies = {
    api, openStore: async () => { await openGate; return store; }, iceServers: () => [], captureOriginal: async () => { captures++; return blob; },
    openRepository: async () => ({ duplicate: async id => { duplicates.push(id); return { ...project, id: "editable-copy" }; }, close() {} }),
    createEngine: options => { const engine = { options, closed: false }; engines.push(engine); return {
      start: async () => { await startGate; if (failStart) throw new Error("temporary_start_failure"); }, close: () => { engine.closed = true; }, refresh: async () => state, reconnect: async () => {},
      commitCapture: async () => { commitCalls++; if (commitCalls === 1) throw new Error("offline"); return state.capture!; }, prepareCapture: async proposal => { proposals.push(proposal); return { ...captureFixture(), ...proposal, state: "prepared" }; }, abortCapture: unused,
      sendRecipeCommit() {}, sendRecipeProposal() {}, requestCapture() {},
      sendSavedFrame: async (_capture, _index, value) => { shared.push(value); if (failShare) throw new Error("journal_quota"); },
      get peerReadiness() { return [{ member: members[guest ? 0 : 1], connected: peerConnected }]; },
    }; },
  };
  const controller = new RoomWorkspaceController(state, { kind: "device" }, deps);
  const connect = () => controller.connect({ readyState: 2, paused: false } as HTMLVideoElement, {} as MediaStream);
  return { controller, connect, engines, blob, saved, shared, duplicates, accepted, recipeWrites, store, proposals, savedOriginals, savedFrameReads,
    roundOrder(value: PhotoProject["sourceOrder"]) { roundOrder = value; },
    failLoad(value: boolean) { failLoad = value; },
    setState(value: RoomState) { state = value; }, get state() { return state; }, get captures() { return captures; }, get commitCalls() { return commitCalls; }, get closedStore() { return closedStore; },
    failStart(value: boolean) { failStart = value; },
    peerConnected(value: boolean) { peerConnected = value; },
    failSave(value: boolean) { failSave = value; }, failFrame(value: boolean) { failFrame = value; }, failShare(value: boolean) { failShare = value; }, failAcceptance(value: boolean) { failAcceptance = value; },
    saveGate(value?: Promise<void>) { saveGate = value; }, startGate(value?: Promise<void>) { startGate = value; }, openGate(value?: Promise<void>) { openGate = value; },
  };
}
test("camera connection waits for storage and cancelled startup cannot reconnect later", async () => {
  const f = fixture(), gate = deferred(); f.openGate(gate.promise);
  const connection = f.connect(); f.controller.disconnect(); gate.resolve(); await connection;
  assert.equal(f.engines.length, 0); await f.connect(); assert.equal(f.engines.length, 1);
  await f.controller.close(); assert(f.closedStore);
});
test("old engine startup and queued callbacks cannot replace a newer connection", async () => {
  const f = fixture(), gate = deferred(); f.startGate(gate.promise);
  const first = f.connect(); await until(() => f.engines.length === 1);
  f.controller.disconnect(); f.startGate(); await f.connect(); gate.resolve(); await first;
  assert(f.controller.getSnapshot().cameraConnected); assert(f.engines[0].closed);
  f.engines[0].options.onError("access_denied"); f.engines[0].options.onState({ ...f.state, status: "ended", serverNow: f.state.serverNow + 1 });
  await tick(); assert.equal(f.controller.getSnapshot().room.status, "open"); assert.equal(f.controller.getSnapshot().error, null);
  await f.controller.close();
});
test("failed originals remain identical across persistence and sharing retries without recapture", async () => {
  const f = fixture(); await f.connect(); const options = f.engines[0].options, capture = captureFixture();
  f.failFrame(true); await assert.rejects(options.captureShot(capture, 0), /quota/);
  const recovery = f.controller.getSnapshot().pendingLocalFrames[0]; assert.equal(recovery.persisted, false); assert.equal(f.controller.getLocalRecoveryBlob(recovery.id), f.blob);
  await assert.rejects(f.controller.openEditableCopy(), /unsaved_local/);
  await assert.rejects(f.controller.retryLocalFrames(), /quota/); assert.equal(f.captures, 1);
  f.failFrame(false); f.failShare(true); await assert.rejects(f.controller.retryLocalFrames(), /journal_quota/);
  assert.equal(f.controller.getSnapshot().pendingLocalFrames[0].persisted, true);
  const saves = f.saved.length; f.failShare(false); await f.controller.retryLocalFrames();
  assert.equal(f.saved.length, saves); assert(f.shared.every(blob => blob === f.blob)); assert.equal(f.captures, 1); assert.equal(f.controller.getSnapshot().pendingLocalFrames.length, 0);
  assert.equal(await f.controller.openEditableCopy(), "editable-copy"); assert.deepEqual(f.duplicates, ["fixture-room-draft"]); await f.controller.close();
});
test("failed recipe write blocks replacement, and copy retries the exact pending revision", async () => {
  const f = fixture(); await f.connect(); f.failSave(true);
  await assert.rejects(f.controller.edit({ kind: "shared", patch: { caption: "Retained edit" } }), /quota/);
  await assert.rejects(f.controller.edit({ kind: "shared", patch: { caption: "Lost replacement" } }), /not_ready/);
  await assert.rejects(f.controller.openEditableCopy(), /quota/); assert.deepEqual(f.duplicates, []);
  f.failSave(false); assert.equal(await f.controller.openEditableCopy(), "editable-copy");
  assert.equal(f.controller.getSnapshot().recipe?.recipe.editor.caption, "Retained edit"); assert.deepEqual(f.recipeWrites, [0, 1, 1, 1]); await f.controller.close();
});
test("prepared commit failure remains retryable and no-camera polling consumes no attempt", async () => {
  const f = fixture(); await f.controller.start(); const capture = { ...captureFixture(), state: "prepared" as const };
  f.setState({ ...f.state, serverNow: f.state.serverNow + 1, capture }); await f.controller.refresh(); assert.equal(f.commitCalls, 0);
  await f.connect(); await f.controller.refresh(); await tick(); assert.equal(f.commitCalls, 1);
  await f.controller.refresh(); await tick(); assert.equal(f.commitCalls, 2); await f.controller.close();
});
test("explicit host gap recovery preserves fork once and retries the explicit snapshot path", async () => {
  const f = fixture(true); await f.connect(); const initial = f.controller.getSnapshot().recipe!, project = f.controller.getSnapshot().draft!;
  const coordinator = new RecipeCoordinator(initial, () => ({ project, hostId: MEMBER_A, members: f.state.members.map(member => ({ id: member.id, role: member.role! })), availableMediaIds: new Set() }));
  let incoming = initial;
  for (let i = 0; i < 3; i++) incoming = await coordinator.commit(MEMBER_A, { schemaVersion: 1, id: crypto.randomUUID(), baseRevision: i, edit: { kind: "shared", patch: { caption: `Host ${i}` } } });
  await f.engines[0].options.onRecipeCommit!(incoming, f.state.members[0]); assert.equal(f.controller.getSnapshot().recoveryRecipe?.revision, 3);
  f.failAcceptance(true); await assert.rejects(f.controller.acceptHost(), /quota/); assert.equal(f.duplicates.length, 1);
  f.failAcceptance(false); await f.controller.retrySave(); assert.deepEqual(f.accepted, [3, 3]); assert.deepEqual(f.recipeWrites, [0]); assert.equal(f.duplicates.length, 1); assert.equal(f.controller.getSnapshot().recoveryRecipe, null); await f.controller.close();
});
test("close waits for in-flight recipe persistence and does not broadcast its late result", async () => {
  const f = fixture(); await f.connect(); const gate = deferred(); f.saveGate(gate.promise);
  const edit = f.controller.edit({ kind: "shared", patch: { caption: "Closing" } }); await until(() => f.recipeWrites.length === 2);
  const closing = f.controller.close(); assert.equal(closing, f.controller.close()); assert.equal(f.closedStore, false);
  gate.resolve(); await assert.rejects(edit, /room_closed/); await closing; assert(f.closedStore);
});

test("queued old-engine room state is discarded after disconnect instead of ending the new session", async () => {
  const f = fixture(); await f.connect(); const gate = deferred(); f.saveGate(gate.promise);
  const edit = f.controller.edit({ kind: "shared", patch: { caption: "Saving" } }); await until(() => f.recipeWrites.length === 2);
  f.engines[0].options.onState({ ...f.state, status: "ended", serverNow: f.state.serverNow + 1 });
  f.controller.disconnect(); await f.connect(); gate.resolve(); await edit; await tick();
  assert.equal(f.controller.getSnapshot().room.status, "open"); assert(f.controller.getSnapshot().cameraConnected); await f.controller.close();
});


test("remote video arriving before hello survives readiness updates until explicit peer disconnect", async () => {
  const f = fixture(); await f.connect(); const stream = {} as MediaStream, options = f.engines[0].options; f.peerConnected(false);
  options.onRemoteStream(f.state.members[1], stream); options.onStatus({ kind: "connecting" });
  assert.equal(f.controller.remoteStreams.get(MEMBER_B), stream);
  const revision = f.controller.getSnapshot().remoteStreamRevision;
  options.onRemoteStream(f.state.members[1], stream); assert.equal(f.controller.getSnapshot().remoteStreamRevision, revision);
  options.onRemoteStream(f.state.members[1], {} as MediaStream); assert.equal(f.controller.getSnapshot().remoteStreamRevision, revision + 1);
  options.onPeerDisconnected!(f.state.members[1]); assert.equal(f.controller.remoteStreams.has(MEMBER_B), false);
  await f.controller.close();
});


test("explicit reconnect restarts a failed engine using only the still-consented stream", async () => {
  const f = fixture(); f.failStart(true); await f.connect(); assert.equal(f.controller.getSnapshot().cameraConnected, false);
  f.failStart(false); await f.controller.reconnect(); assert.equal(f.engines.length, 2); assert(f.controller.getSnapshot().cameraConnected);
  f.controller.disconnect(); await f.controller.reconnect(); assert.equal(f.engines.length, 2); await f.controller.close();
});


test("explicit new round verifies the incomplete project is durable and never overwrites its capture identity", async () => {
  const f = fixture(); await f.connect();
  const capture = { ...captureFixture(), recipeHash: f.controller.getSnapshot().recipe!.recipeHash };
  f.setState({ ...f.state, capture }); await f.controller.refresh();
  assert(await f.engines[0].options.readiness(capture));
  const original = f.controller.getSnapshot().round!;
  await assert.rejects(f.controller.capture(), /not_ready/); assert.equal(f.proposals.length, 0);
  f.failLoad(true); await assert.rejects(f.controller.keepIncompleteRoundAndCapture(), /storage_unavailable/); assert.equal(f.proposals.length, 0);
  f.failLoad(false); await f.controller.keepIncompleteRoundAndCapture();
  assert.equal(f.proposals.length, 1); assert.notEqual(f.proposals[0].captureId, original.id);
  assert.equal((await f.store.loadRound(original.id))?.project, original);
  assert.deepEqual(original.sourceOrder, { A: [], B: [], C: [], D: [] });
  await f.controller.close();
});


test("reload recovery sends only durable own-role occupied slots and never invokes the camera", async () => {
  const f = fixture(); await f.connect();
  f.roundOrder({ A: ["own-0", null, "own-2"], B: ["foreign-0"], C: [], D: [] });
  f.savedOriginals.set(0, f.blob); const other = new Blob(["second retained original"], { type: "image/jpeg" }); f.savedOriginals.set(2, other);
  const capture = { ...captureFixture(), recipeHash: f.controller.getSnapshot().recipe!.recipeHash };
  assert(await f.engines[0].options.readiness(capture));
  f.failShare(true); await assert.rejects(f.controller.resumeSavedOriginals(), /journal_quota/); assert.equal(f.captures, 0);
  f.failShare(false); await f.controller.resumeSavedOriginals();
  assert.deepEqual(f.savedFrameReads, [{ role: "A", index: 0 }, { role: "A", index: 0 }, { role: "A", index: 2 }]);
  assert.deepEqual(f.shared, [f.blob, f.blob, other]); assert.equal(f.captures, 0); assert.equal(f.controller.getSnapshot().pendingLocalFrames.length, 0);
  f.savedOriginals.delete(0); await assert.rejects(f.controller.resumeSavedOriginals(), /saved_original_missing/);
  await f.controller.close();
});


test("a saved round discovered after startup hydrates without a roster change", async () => {
  const f = fixture(); await f.connect();
  const recipe = f.controller.getSnapshot().recipe!, capture = { ...captureFixture(), recipeHash: recipe.recipeHash };
  const round = await f.store.prepareRound(capture, recipe);
  assert.equal(f.controller.getSnapshot().round, null);
  f.setState({ ...f.state, capture }); await f.controller.refresh();
  assert.equal(f.controller.getSnapshot().round?.id, round.project.id);
  await f.controller.close();
});

test("healed peer connections clear only connection errors and preserve failed writes or integrity errors", async () => {
  const f = fixture(); await f.connect(); const callbacks = f.engines[0].options;
  f.peerConnected(false); callbacks.onStatus({ kind: "recovery-required", reason: "peer_disconnected" }); assert(f.controller.getSnapshot().error);
  f.peerConnected(true); callbacks.onStatus({ kind: "connected" }); assert.equal(f.controller.getSnapshot().error, null);
  await f.controller.action(async () => { throw new Error("storage_quota"); }); const storageError = f.controller.getSnapshot().error;
  f.peerConnected(false); callbacks.onStatus({ kind: "recovery-required", reason: "signalling_expired" });
  f.peerConnected(true); callbacks.onStatus({ kind: "connected" }); await f.controller.action(() => f.controller.reconnect());
  assert.equal(f.controller.getSnapshot().error, storageError);
  callbacks.onError("transfer_integrity"); const integrityError = f.controller.getSnapshot().error;
  callbacks.onStatus({ kind: "connected" }); assert.equal(f.controller.getSnapshot().error, integrityError);
  callbacks.onStatus({ kind: "recovery-required", reason: "recovery_required" });
  callbacks.onStatus({ kind: "connected" }); assert.match(f.controller.getSnapshot().error!, /design changed/);
  await f.controller.close();
});

test("guided rounds freeze four story prompts and a 15-second interval in the capture proposal", async () => {
  const f = fixture(); await f.controller.start(); await f.connect();
  await f.controller.edit({ kind: "shared", patch: { story: createStoryPlan("passing-a-smile", 12) } });
  await f.controller.capture();
  assert.equal(f.proposals.length, 1); assert.equal(f.proposals[0].shotIds.length, 4);
  assert.equal(f.proposals[0].intervalMs, 15000);
  assert.equal(f.proposals[0].recipeHash, f.controller.getSnapshot().recipe?.recipeHash);
  await assert.rejects(f.controller.edit({ kind: "shared", patch: { story: null } }), /not_ready/);
  await f.controller.close();
});
