import assert from "node:assert/strict";
import test from "node:test";
import { createRoomWorkspaceStore, type WorkspaceCheckpoint, type WorkspaceMetadata } from "../lib/rtc/workspace-store";
import { validatePhotoProject, type PhotoProject } from "../lib/projects/model";
import type { LoadedProject, ProjectRepository } from "../lib/projects/storage";
import { hashRecipe, initialRecipeCommit, type RecipeCommit } from "../lib/rtc/recipe-v2";
import type { RoomCapture, RoomState } from "../lib/server/room-contract";
import { CAPTURE_ID, EPOCH, MEMBER_A, MEMBER_B, ROOM_ID, SESSION_ID } from "./helpers/room-fixture";
import { LAYOUTS, type Role } from "../lib/layouts";

const binding = { scope: { kind: "device" as const }, roomId: ROOM_ID, sessionId: SESSION_ID, selfId: MEMBER_A };
const roster = (): RoomState => ({ roomId: ROOM_ID, sessionId: SESSION_ID, code: "ABC234", hostId: MEMBER_A, selfId: MEMBER_A, selfRole: "A", connectionEpoch: EPOCH, status: "open", locked: false, rosterRevision: 1, serverNow: Date.now(), expiresAt: Date.now() + 60000, capture: null, members: [{ id: MEMBER_A, role: "A", displayName: "A", status: "admitted", connectionEpoch: EPOCH }, { id: MEMBER_B, role: "B", displayName: "B", status: "admitted", connectionEpoch: EPOCH }] });
const png = (byte = 1) => new Blob([new Uint8Array([byte, 2, 3])], { type: "image/png" });
function fixture() {
  const records = new Map<string, WorkspaceCheckpoint>(), projects = new Map<string, { project: PhotoProject; media: Map<string, Blob> }>();
  let failAcknowledgement = false, beforeSave: (() => Promise<void>) | null = null;
  const metadata = (): WorkspaceMetadata => ({ get: async key => structuredClone(records.get(key) ?? null), put: async (value, expected) => {
    if ((records.get(value.key)?.version ?? null) !== expected) throw new Error("metadata conflict");
    if (failAcknowledgement && !value.pending) { failAcknowledgement = false; throw new Error("injected acknowledgement failure"); }
    records.set(value.key, structuredClone(value));
  }, close() {} });
  const repository = (): ProjectRepository => ({ scope: binding.scope, close() {}, list: async () => [], load: async id => { const value = projects.get(id); return value ? { id, kind: "current", readOnly: false, project: structuredClone(value.project), revision: value.project.revision, media: new Map(value.media), checkpoint: null } as LoadedProject : null; }, save: async (input, media, expected) => {
    await beforeSave?.(); const previous = projects.get(input.id);
    if ((previous?.project.revision ?? null) !== expected) throw new Error("project CAS conflict");
    const project = validatePhotoProject(input), blobs = new Map(previous?.media ?? []); for (const [id, blob] of media) blobs.set(id, blob);
    if (project.media.some(item => !blobs.has(item.id))) throw new Error("missing media");
    projects.set(project.id, { project, media: blobs }); return project;
  }, rename: async () => { throw new Error("unused"); }, duplicate: async () => { throw new Error("unused"); }, delete: async () => {}, recoverCheckpoint: async () => { throw new Error("unused"); }, exportRaw: async () => { throw new Error("unused"); } });
  const open = (inspect = async () => ({ mime: "image/png" as const, width: 1, height: 1 })) => createRoomWorkspaceStore(binding, { projects: repository(), metadata: metadata(), inspect });
  return { records, projects, open, setFault: () => { failAcknowledgement = true; }, setBeforeSave: (fn: (() => Promise<void>) | null) => { beforeSave = fn; } };
}
async function prepared(f = fixture()) {
  const store = f.open(), draft = await store.loadDraft(roster());
  const recipe = await initialRecipeCommit({ project: draft.project, hostId: MEMBER_A, members: draft.project.participants, availableMediaIds: new Set() });
  await store.saveRecipe(recipe);
  const capture: RoomCapture = { captureId: CAPTURE_ID, rosterRevision: 1, recipeHash: recipe.recipeHash, shotIds: Array.from({ length: draft.project.capture.requiredShots }, (_, i) => `shot-${i}`), fireAt: Date.now() - 1000, intervalMs: 1000, profile: { shotsPerMember: draft.project.capture.requiredShots, maxPhotoBytes: 1000, maxPhotoPixels: 1000 }, memberIds: [MEMBER_A, MEMBER_B], acks: [MEMBER_A, MEMBER_B], state: "committed" };
  await store.prepareRound(capture, recipe);
  return { f, store, draft, recipe, capture };
}
async function captionCommit(current: RecipeCommit) {
  const recipe = { ...current.recipe, editor: { ...current.recipe.editor, caption: "Saved together" } };
  return { ...current, revision: current.revision + 1, proposalId: crypto.randomUUID(), authorId: MEMBER_A, recipe, recipeHash: await hashRecipe(recipe) };
}

test("new room drafts show every admitted role, including four people and gaps after removal", async () => {
  const cases: { roles: Role[]; layout: string; shots: number }[] = [
    { roles: ["A"], layout: "strip4", shots: 4 }, { roles: ["A", "B"], layout: "duo-alternate", shots: 4 },
    { roles: ["A", "B", "C"], layout: "trio", shots: 4 }, { roles: ["A", "B", "C", "D"], layout: "quad", shots: 3 },
    { roles: ["A", "C", "D"], layout: "quad", shots: 3 }, { roles: ["A", "C"], layout: "trio", shots: 4 }, { roles: ["A", "D"], layout: "quad", shots: 3 },
  ];
  for (const fixtureCase of cases) {
    const f = fixture(), store = f.open(), state = roster();
    state.members = fixtureCase.roles.map(role => ({ id: role === "A" ? MEMBER_A : crypto.randomUUID(), role, displayName: role, status: "admitted", connectionEpoch: EPOCH }));
    const draft = await store.loadDraft(state), layout = LAYOUTS.find(item => item.id === fixtureCase.layout)!;
    assert.equal(draft.project.editor.layoutId, fixtureCase.layout); assert.equal(draft.project.mode, layout.mode); assert.equal(draft.project.capture.requiredShots, fixtureCase.shots);
    assert.deepEqual(draft.project.participants, state.members.map(member => ({ id: member.id, role: member.role })));
    assert(fixtureCase.roles.every(role => layout.mode === "solo" ? role === "A" : layout.duoPattern?.some(owner => owner === role || owner === "AB" && (role === "A" || role === "B"))));
    if (fixtureCase.roles.length > 1) {
      const recipe = await initialRecipeCommit({ project: draft.project, hostId: MEMBER_A, members: draft.project.participants, availableMediaIds: new Set() });
      const saved = await store.saveRecipe(recipe); assert.equal(saved.project.capture.requiredShots, fixtureCase.shots);
    }
    await store.close();
  }
});

test("round frames persist at capture ID, preserve out-of-order slots and reject differing retry bytes", async () => {
  const { store, capture } = await prepared();
  assert.equal(await store.saveFrame({ capture, role: "B", shotIndex: 1, blob: png() }), CAPTURE_ID);
  const before = (await store.loadRound(CAPTURE_ID))!.project;
  await store.saveFrame({ capture, role: "B", shotIndex: 1, blob: png() });
  assert.equal((await store.loadRound(CAPTURE_ID))!.project.revision, before.revision);
  assert.deepEqual(before.sourceOrder.B, [null, "room-B-1"]);
  await assert.rejects(store.saveFrame({ capture, role: "B", shotIndex: 1, blob: png(9) }), /media/);
  await assert.rejects(store.saveFrame({ capture, role: "D", shotIndex: 0, blob: png() }), /identity/);
  await assert.rejects(store.saveFrame({ capture: { ...capture, recipeHash: "0".repeat(64) }, role: "A", shotIndex: 0, blob: png() }), /recovery/);
  await store.close();
});

test("collaborative finishing retains capture recipe identity and immutable originals", async () => {
  const { store, capture, recipe } = await prepared();
  await store.saveFrame({ capture, role: "A", shotIndex: 0, blob: png() });
  const next = await captionCommit(recipe); await store.saveRecipe(next); const round = await store.updateRoundRecipe(CAPTURE_ID, next);
  assert.equal(round.project.editor.caption, "Saved together"); assert.equal(round.initialRecipeHash, recipe.recipeHash); assert.equal(round.capture.recipeHash, capture.recipeHash); assert.equal(round.recipe.recipeHash, next.recipeHash);
  assert.equal(round.project.media.length, 1); assert.equal(round.project.capture.requiredShots, capture.shotIds.length);
  assert.equal((await store.updateRoundRecipe(CAPTURE_ID, next)).project.revision, round.project.revision);
  await store.close();
});

test("a changed roster creates a distinct draft and retains the frozen earlier round", async () => {
  const { f, store, capture, draft } = await prepared();
  const changed = roster(); changed.rosterRevision = 2; changed.members = changed.members.slice(0, 1);
  const current = await store.loadDraft(changed); assert.notEqual(current.project.id, draft.project.id); assert.equal(current.recipe, null); assert(f.projects.has(draft.project.id));
  await store.saveFrame({ capture, role: "B", shotIndex: 0, blob: png() }); assert.equal((await store.loadRound(CAPTURE_ID))!.participants.length, 2);
  await store.close();
});

test("interrupted metadata acknowledgement reconciles only the exact committed project", async () => {
  const { f, store, recipe } = await prepared(), next = await captionCommit(recipe);
  f.setFault(); await assert.rejects(store.saveRecipe(next), /acknowledgement/);
  await store.close(); const reopened = f.open(); const loaded = await reopened.loadDraft(roster());
  assert.equal(loaded.recipe?.recipeHash, next.recipeHash); assert.equal(loaded.project.editor.caption, next.recipe.editor.caption);
  assert([...f.records.values()].every(record => record.pending === null)); await reopened.close();
});

test("simultaneous frame writers cannot overwrite a concurrent project revision", async () => {
  const { f, store, capture } = await prepared(), other = f.open();
  let arrivals = 0, release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
  f.setBeforeSave(async () => { if (++arrivals === 2) release(); await barrier; });
  const results = await Promise.allSettled([store.saveFrame({ capture, role: "A", shotIndex: 0, blob: png() }), other.saveFrame({ capture, role: "B", shotIndex: 0, blob: png() })]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1); assert.equal((await store.loadRound(CAPTURE_ID))!.project.media.length, 1);
  f.setBeforeSave(null); await store.close(); await other.close();
});

test("close fences pending image validation before any frame write or success response", async () => {
  const { f, store, capture } = await prepared(); await store.close();
  let release!: () => void; const blocked = f.open(async () => { await new Promise<void>(resolve => { release = resolve; }); return { mime: "image/png", width: 1, height: 1 }; });
  const saving = blocked.saveFrame({ capture, role: "A", shotIndex: 0, blob: png() }); await new Promise(resolve => setImmediate(resolve));
  const closing = blocked.close(); release(); await assert.rejects(saving, /closed/); await closing;
  assert.equal(f.projects.get(CAPTURE_ID)!.project.media.length, 0);
});

test("foreign identity and oversized frames cannot enter a local workspace", async () => {
  const { store, capture } = await prepared();
  await assert.rejects(store.loadDraft({ ...roster(), roomId: CAPTURE_ID }), /identity/);
  await assert.rejects(store.saveFrame({ capture, role: "A", shotIndex: 0, blob: new Blob([new Uint8Array(1001)], { type: "image/png" }) }), /profile/);
  await store.close();
});

test("reopened saved-frame reads preserve exact original bytes and frozen roles without new writes", async () => {
  const { f, store, capture } = await prepared();
  await store.saveFrame({ capture, role: "A", shotIndex: 0, blob: png() }); await store.close();
  const reopened = f.open(), revision = f.projects.get(CAPTURE_ID)!.project.revision;
  const recovered = await reopened.loadSavedFrame(CAPTURE_ID, "A", 0);
  assert.deepEqual(new Uint8Array(await recovered!.arrayBuffer()), new Uint8Array(await png().arrayBuffer()));
  assert.equal(await reopened.loadSavedFrame(CAPTURE_ID, "A", 1), null);
  assert.equal(await reopened.loadSavedFrame(crypto.randomUUID(), "A", 0), null);
  await assert.rejects(reopened.loadSavedFrame(CAPTURE_ID, "D", 0), /identity/);
  await assert.rejects(reopened.loadSavedFrame(CAPTURE_ID, "A", 4), /profile/);
  assert.equal(f.projects.get(CAPTURE_ID)!.project.revision, revision);
  f.projects.get(CAPTURE_ID)!.media.set("room-A-0", new Blob([new Uint8Array(4)], { type: "image/png" }));
  await assert.rejects(reopened.loadSavedFrame(CAPTURE_ID, "A", 0), /media/);
  await reopened.close(); await assert.rejects(reopened.loadSavedFrame(CAPTURE_ID, "A", 0), /closed/);
});

test("interrupted writes never reconcile over a newer divergent project", async () => {
  const { f, store, recipe, draft } = await prepared(), next = await captionCommit(recipe);
  f.setFault(); await assert.rejects(store.saveRecipe(next), /acknowledgement/);
  const saved = f.projects.get(draft.project.id)!;
  saved.project = validatePhotoProject({ ...saved.project, revision: saved.project.revision + 1, editor: { ...saved.project.editor, caption: "Separate local edit" } });
  await store.close(); const reopened = f.open(); await assert.rejects(reopened.loadDraft(roster()), /conflict/);
  assert.equal(f.projects.get(draft.project.id)!.project.editor.caption, "Separate local edit"); await reopened.close();
});

test("damaged frozen project pointers are rejected before a source write", async () => {
  const { f, store, capture, draft } = await prepared();
  const record = [...f.records.values()].find(item => item.kind === "round")!; record.projectId = draft.project.id;
  await assert.rejects(store.saveFrame({ capture, role: "A", shotIndex: 0, blob: png() }), /recovery/);
  assert.equal(f.projects.get(draft.project.id)!.project.media.length, 0); await store.close();
});

test("only explicit host snapshot acceptance crosses a revision gap and preserves original capture identity", async () => {
  const { store, capture, recipe } = await prepared(); await store.saveFrame({ capture, role: "A", shotIndex: 0, blob: png() });
  const commit = { ...await captionCommit(recipe), revision: 8 };
  await assert.rejects(store.saveRecipe(commit), /recovery_required/);
  const saved = await store.acceptHostSnapshot(commit, CAPTURE_ID);
  assert.equal(saved.draft.recipe?.revision, 8); assert.equal(saved.round?.recipe.revision, 8); assert.equal(saved.round?.initialRecipeHash, recipe.recipeHash); assert.equal(saved.round?.project.media.length, 1);
  const retry = await store.acceptHostSnapshot(commit, CAPTURE_ID); assert.equal(retry.round?.project.revision, saved.round?.project.revision);
  await store.close();
});
