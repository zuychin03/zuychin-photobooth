import assert from "node:assert/strict";
import { test } from "node:test";
import { applyProjectEdit, appendProjectMedia, createProject, isProjectVisibleTo, parsePhotoProject, redoProject, serializePhotoProject, undoProject, validatePhotoProject, type PhotoProject, type ProjectMedia } from "../lib/projects/model";
import { RESOURCE_LIMITS, validateResourceManifest } from "../lib/projects/resource-bounds";
import { defaultCellEdit } from "../lib/projects/transforms";

const createdAt = "2026-09-22T00:00:00.000Z";
const shotAt = "2026-09-22T00:01:00.000Z";
const updatedAt = "2026-09-22T00:02:00.000Z";
function draft() { return createProject({ id: "project-1", createdAt, captureTimeZone: "Australia/Sydney", participants: [{ id: "person-1", role: "A" }] }); }
function photo(id = "photo-1", participantId = "person-1"): ProjectMedia { return { id, participantId, kind: "photo", mime: "image/jpeg", bytes: 1024, width: 640, height: 480 }; }
function captured() { const p = draft(); return appendProjectMedia(p, [photo()], { ...p.sourceOrder, A: ["photo-1", null] }, shotAt, updatedAt); }
function edit(project: PhotoProject, caption: string) { return applyProjectEdit(project, { sourceOrder: project.sourceOrder, editor: { ...project.editor, caption } }, updatedAt); }

test("empty and incomplete drafts remain independent of completed resource validation", () => {
  const project = draft();
  assert.equal(project.media.length, 0);
  assert.equal(project.capturedAt, null);
  assert.equal(project.revision, 0);
  const shared = createProject({ mode: "group", participants: [{ id: "guest", role: "C" }], role: "C", createdAt });
  assert.equal(shared.participants.length, 1);
  assert.throws(() => validateResourceManifest({ version: 1, mode: "solo", participants: [], media: [], slots: [], textLayers: [], stickerLayers: [] }));
});

test("round trip detaches and deeply freezes data", () => {
  const input = JSON.parse(serializePhotoProject(captured()));
  const project = validatePhotoProject(input);
  input.editor.caption = "mutated";
  input.sourceOrder.A[0] = "missing";
  assert.equal(project.editor.caption, "");
  assert.equal(project.sourceOrder.A[0], "photo-1");
  assert(Object.isFrozen(project.media[0]));
  assert(Object.isFrozen(project.history.past[0].editor));
  const result = parsePhotoProject(serializePhotoProject(project));
  assert.equal(result.kind, "current");
  if (result.kind === "current") assert.deepEqual(result.project, project);
});

test("unknown future versions preserve exact raw input without current-version coercion", () => {
  const raw = '{ "schemaVersion": 8, "unknown": {"room":"opaque"} }';
  assert.deepEqual(parsePhotoProject(raw), { kind: "unsupported", schemaVersion: 8, rawJson: raw, readOnly: true });
  assert.throws(() => parsePhotoProject('{"schemaVersion":0}'));
  assert.throws(() => parsePhotoProject('{"schemaVersion":1.5}'));
  assert.throws(() => parsePhotoProject('{"schemaVersion":2,"payload":"' + "💛".repeat(20000) + '"}'));
});

test("unknown fields and accessor payloads are rejected without executing getters", () => {
  assert.throws(() => validatePhotoProject({ ...draft(), roomSecret: "fixture-capability" }));
  let reads = 0;
  const input = { ...draft() };
  Object.defineProperty(input, "name", { get() { reads++; return "unsafe"; }, enumerable: true });
  assert.throws(() => validatePhotoProject(input));
  assert.equal(reads, 0);
  const declaration = { ...photo() };
  Object.defineProperty(declaration, "id", { get() { reads++; return "unsafe"; }, enumerable: true });
  assert.throws(() => appendProjectMedia(draft(), [declaration], draft().sourceOrder, shotAt, updatedAt));
  assert.equal(reads, 0);
});

test("sparse arrays, duplicate roles and source ownership mistakes fail validation", () => {
  const p = captured();
  assert.throws(() => validatePhotoProject({ ...p, sourceOrder: { ...p.sourceOrder, A: Array(2) } }));
  assert.throws(() => validatePhotoProject({ ...p, sourceOrder: { ...p.sourceOrder, A: ["missing"] } }));
  assert.throws(() => validatePhotoProject({ ...p, sourceOrder: { ...p.sourceOrder, A: ["photo-1", "photo-1"] } }));
  assert.throws(() => validatePhotoProject({ ...p, media: [{ ...photo(), participantId: "someone-else" }] }));
  assert.throws(() => createProject({ mode: "duo", participants: [{ id: "one", role: "A" }, { id: "two", role: "A" }] }));
  const shared = createProject({ mode: "duo", participants: [{ id: "one", role: "A" }, { id: "two", role: "B" }], createdAt });
  assert.throws(() => appendProjectMedia(shared, [photo("p", "two")], { ...shared.sourceOrder, A: ["p"] }, shotAt, updatedAt));
});

test("only supported catalogues and bounded adjustments can enter a project", () => {
  const p = draft();
  for (const patch of [{ layoutId: "quad" }, { frameId: "remote-url" }, { filterId: "external" }, { patternId: "external" }, { sceneId: "external" }, { caption: "a".repeat(501) }, { places: { A: { dx: 0.6, dy: 0, scale: 1 } } }]) {
    assert.throws(() => validatePhotoProject({ ...p, editor: { ...p.editor, ...patch } }));
  }
  assert.throws(() => validatePhotoProject({ ...p, editor: { ...p.editor, cellEdits: { "0:A": { ...defaultCellEdit(0), zoom: Infinity } } } }));
  assert.throws(() => validatePhotoProject({ ...p, editor: { ...p.editor, cellEdits: { "4:A": defaultCellEdit(0) } } }));
  assert.throws(() => validatePhotoProject({ ...p, editor: { ...p.editor, stickers: [{ key: 1, slug: "red_heart", emoji: "wrong", x: 0.5, y: 0.5, scale: 1, rotation: 0 }] } }));
});

test("retake keeps the original inventory and undo restores original active references", () => {
  const before = captured();
  const after = appendProjectMedia(before, [photo("retake")], { ...before.sourceOrder, A: ["retake", null] }, updatedAt, updatedAt);
  assert.equal(after.media.length, 2);
  assert.equal(after.capturedAt, shotAt);
  assert.equal(after.captureTimeZone, "Australia/Sydney");
  const undone = undoProject(after, updatedAt);
  assert.deepEqual(undone.sourceOrder.A, ["photo-1", null]);
  assert.equal(undone.media.length, 2);
  assert.deepEqual(redoProject(undone, updatedAt).sourceOrder.A, ["retake", null]);
  assert.equal(before.media.length, 1);
});

test("retake quota exhaustion and media ID rebinding preserve the existing project", () => {
  const p = draft();
  const full = appendProjectMedia(p, Array.from({ length: 24 }, (_, index) => photo(`p-${index}`)), { ...p.sourceOrder, A: ["p-23"] }, shotAt, updatedAt);
  const saved = serializePhotoProject(full);
  assert.throws(() => appendProjectMedia(full, [photo("extra")], { ...full.sourceOrder, A: ["extra"] }, shotAt, updatedAt), /oversized array/);
  assert.throws(() => appendProjectMedia(full, [{ ...photo("p-23"), width: 12 }], full.sourceOrder, shotAt, updatedAt));
  assert.equal(serializePhotoProject(full), saved);
  const large = Array.from({ length: 7 }, (_, index) => ({ ...photo(`large-${index}`), bytes: 10 * 1024 * 1024 }));
  assert.throws(() => appendProjectMedia(p, large, p.sourceOrder, shotAt, updatedAt), /quota/);
  assert.equal(p.media.length, 0);
});

test("undo redo history branches are bounded and revision increases exactly once", () => {
  let p = draft();
  for (let index = 0; index < 30; index++) p = edit(p, String(index));
  assert.equal(p.revision, 30);
  assert.equal(p.history.past.length, 20);
  p = undoProject(p, updatedAt);
  assert.equal(p.editor.caption, "28");
  assert.equal(p.revision, 31);
  p = redoProject(p, updatedAt);
  assert.equal(p.editor.caption, "29");
  assert.equal(p.revision, 32);
  p = edit(undoProject(p, updatedAt), "branch");
  assert.equal(p.history.future.length, 0);
  assert.equal(redoProject(p, updatedAt).revision, p.revision);
});

test("large editor snapshots trim oldest history to fit the manifest byte budget", () => {
  let p = draft();
  const stickers = Array.from({ length: 32 }, (_, key) => ({ key, slug: "red_heart", emoji: "❤️", x: 0.5, y: 0.5, scale: 1, rotation: 0 }));
  p = applyProjectEdit(p, { sourceOrder: p.sourceOrder, editor: { ...p.editor, stickers } }, updatedAt);
  for (let i = 0; i < 30; i++) p = edit(p, `${i}:` + "💛".repeat(490));
  assert(p.history.past.length < 20);
  assert(new TextEncoder().encode(serializePhotoProject(p)).byteLength <= RESOURCE_LIMITS.manifestBytes);
  assert.equal(undoProject(p, updatedAt).editor.caption.slice(0, 3), "28:");
});

test("editor layout changes preserve capture requirements and original capture metadata", () => {
  const p = captured();
  const changed = applyProjectEdit(p, { sourceOrder: p.sourceOrder, editor: { ...p.editor, layoutId: "strip3" } }, updatedAt);
  assert.equal(changed.capture.requiredShots, 4);
  assert.equal(changed.capturedAt, p.capturedAt);
  assert.equal(changed.createdAt, p.createdAt);
  assert.equal(changed.captureTimeZone, p.captureTimeZone);
  assert.throws(() => applyProjectEdit(p, { sourceOrder: p.sourceOrder, editor: p.editor, capturedAt: createdAt } as never, updatedAt));
  assert.throws(() => edit({ ...p, captureTimeZone: "Not/A_Timezone" }, "test"));
  assert.throws(() => createProject({ captureTimeZone: "+01:00" }));
  assert.throws(() => applyProjectEdit(p, { sourceOrder: p.sourceOrder, editor: p.editor }, createdAt));
});

test("account projects are hidden after logout or account switch", () => {
  const project = createProject({ scope: { kind: "account", ownerId: "owner-1" } });
  assert.equal(isProjectVisibleTo(project, "owner-1"), true);
  assert.equal(isProjectVisibleTo(project, null), false);
  assert.equal(isProjectVisibleTo(project, "owner-2"), false);
  assert.equal(isProjectVisibleTo(draft(), null), true);
});

test("duplicates may retain an earlier capture timestamp under a new project creation time", () => {
  const p = captured();
  const copy = validatePhotoProject({ ...p, id: "copy", createdAt: updatedAt, revision: 0, history: { past: [], future: [] } });
  assert.equal(copy.capturedAt, shotAt);
  assert.throws(() => validatePhotoProject({ ...copy, capturedAt: "2027-01-01T00:00:00.000Z" }));
});
