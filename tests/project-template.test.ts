import assert from "node:assert/strict";
import test from "node:test";
import { applyProjectEdit, applyTemplateToProject, appendProjectMedia, createProject, parsePhotoProject, redoProject, serializePhotoProject, undoProject, validatePhotoProject } from "../lib/projects/model";
import { designFromRecipe } from "../lib/templates/application";
import { validateTemplateDesign } from "../lib/templates/model";
import { templateFixture, templateTimestamp } from "./helpers/template-fixture";
import { templateFromProject } from "../lib/templates/from-project";

const draft = () => createProject({ id: "migration-fixture", createdAt: templateTimestamp, captureTimeZone: "Australia/Sydney", participants: [{ id: "person-a", role: "A" }], capture: { cameraId: "local-camera" } });

test("a new round derives the edited template count while retaining camera settings and decoration originals", () => {
  const initial = validatePhotoProject({ ...draft(), capture: { ...draft().capture, requiredShots: 1, timerSeconds: 10, style: "flexible", mirror: false, fillLight: true } });
  const captured = appendProjectMedia(initial, [{ id: "old-photo", participantId: "person-a", kind: "photo", mime: "image/png", width: 640, height: 480, bytes: 1000 }], { ...initial.sourceOrder, A: ["old-photo"] }, templateTimestamp, templateTimestamp);
  const one = designFromRecipe(templateFixture(true));
  const four = validateTemplateDesign({ ...one, requiredSources: { A: 4 }, slots: [{ ...one.slots[0], sourceIndex: 3 }] });
  const decoration = { ...four.decorations[0], participantId: null };
  const previous = applyTemplateToProject(captured, four, [decoration], templateTimestamp);
  assert.equal(previous.capture.requiredShots, 1);
  const fresh = createProject({ id: "next-round", createdAt: templateTimestamp, captureTimeZone: previous.captureTimeZone, participants: [...previous.participants], capture: { ...previous.capture }, editor: { layoutId: previous.editor.layoutId, filterId: previous.editor.filterId } });
  const next = applyTemplateToProject(fresh, templateFromProject(previous), [decoration], templateTimestamp);
  assert.equal(next.capture.requiredShots, 4);
  assert.deepEqual({ ...next.capture, requiredShots: 1 }, previous.capture);
  assert.equal(next.capturedAt, null);
  assert.deepEqual(next.media, [decoration]);
  assert(!Object.values(next.sourceOrder).flat().includes("old-photo"));
  assert.deepEqual(previous.media.map(media => media.id), ["old-photo", decoration.id]);
});

test("legacy manifest migration preserves identity, revision, source ownership, history and raw input", () => {
  const initial = draft();
  const captured = appendProjectMedia(initial, [{ id: "original", participantId: "person-a", kind: "photo", mime: "image/png", width: 640, height: 480, bytes: 1000 }], { ...initial.sourceOrder, A: ["original"] }, templateTimestamp, templateTimestamp);
  const edited = applyProjectEdit(captured, { sourceOrder: captured.sourceOrder, editor: { ...captured.editor, caption: "Private caption" } }, templateTimestamp);
  const legacy = { ...JSON.parse(serializePhotoProject(edited)), schemaVersion: 1 };
  const raw = JSON.stringify(legacy, null, 2), snapshot = raw;
  const result = parsePhotoProject(raw);
  assert.equal(result.kind, "current");
  if (result.kind !== "current") throw new Error("Expected local migration");
  assert.equal(result.project.schemaVersion, 3);
  for (const key of ["id", "revision", "createdAt", "capturedAt", "captureTimeZone", "scope", "capture", "media", "history", "sourceOrder"] as const) assert.deepEqual(result.project[key], edited[key]);
  assert.equal(raw, snapshot); assert.equal(legacy.schemaVersion, 1); assert(Object.isFrozen(result.project.history.past[0].editor));
});

test("version one rejects new template fields while future versions retain exact raw text", () => {
  const project = draft(), design = designFromRecipe(templateFixture());
  assert.throws(() => parsePhotoProject(JSON.stringify({ ...project, schemaVersion: 1, editor: { ...project.editor, template: design } })));
  const raw = ' { "schemaVersion": 5, "unknown": "keep exactly" } ';
  assert.deepEqual(parsePhotoProject(raw), { kind: "unsupported", schemaVersion: 5, rawJson: raw, readOnly: true });
});

test("version two migration preserves template edits and rejects story fields claimed by an older schema", () => {
  const project = applyTemplateToProject(draft(), designFromRecipe(templateFixture()), [], templateTimestamp);
  const raw = JSON.stringify({ ...project, schemaVersion: 2 });
  const result = parsePhotoProject(raw);
  assert.equal(result.kind, "current");
  if (result.kind !== "current") throw new Error("Expected version two migration");
  assert.deepEqual(result.project, { ...project, schemaVersion: 3 }); assert.equal(result.project.schemaVersion, 3);
  assert.throws(() => parsePhotoProject(JSON.stringify({ ...project, schemaVersion: 2, editor: { ...project.editor, story: null } })));
});

test("templates bind exact decoration inventory and participant roles before changing a project", () => {
  const project = draft(), design = designFromRecipe(templateFixture(true)), decoration = { ...design.decorations[0], participantId: null };
  assert.throws(() => applyTemplateToProject(project, design, [], templateTimestamp), /missing|differs/);
  assert.throws(() => applyTemplateToProject(project, design, [{ ...decoration, bytes: decoration.bytes + 1 }], templateTimestamp), /missing|differs/);
  const saved = applyTemplateToProject(project, design, [decoration], templateTimestamp);
  assert.equal(saved.revision, project.revision + 1); assert.equal(saved.media[0].participantId, null);
  assert(Object.isFrozen(saved.editor.template?.slots[0].crop));
  const foreign = validateTemplateDesign({ ...design, requiredSources: { B: 1 }, slots: design.slots.map(slot => ({ ...slot, role: "B" })) });
  assert.throws(() => applyTemplateToProject(project, foreign, [decoration], templateTimestamp), /participant/);
  assert.throws(() => validatePhotoProject({ ...saved, media: [] }), /missing|differs/);
});

test("template application can set draft shot count but preserves the captured session's frozen settings", () => {
  const project = draft(), design = designFromRecipe(templateFixture());
  const beforeCapture = applyTemplateToProject(project, design, [], templateTimestamp);
  assert.equal(beforeCapture.capture.requiredShots, 1);
  const captured = appendProjectMedia(project, [{ id: "original", participantId: "person-a", kind: "photo", mime: "image/png", width: 640, height: 480, bytes: 1000 }], { ...project.sourceOrder, A: ["original"] }, templateTimestamp, templateTimestamp);
  const afterCapture = applyTemplateToProject(captured, design, [], templateTimestamp);
  assert.equal(afterCapture.capture.requiredShots, 4); assert.deepEqual(afterCapture.capture, captured.capture);
  assert.equal(afterCapture.capturedAt, captured.capturedAt); assert.deepEqual(afterCapture.sourceOrder, captured.sourceOrder); assert.deepEqual(afterCapture.media, captured.media);
});

test("draft template undo and redo restore the target source requirements while retaining other capture settings", () => {
  const project = validatePhotoProject({ ...draft(), capture: { ...draft().capture, timerSeconds: 10, mirror: false, style: "flexible" } });
  const applied = applyTemplateToProject(project, designFromRecipe(templateFixture()), [], templateTimestamp);
  assert.equal(applied.capture.requiredShots, 1);
  const undone = undoProject(applied, templateTimestamp);
  assert.equal(undone.editor.template, undefined); assert.equal(undone.capture.requiredShots, 4);
  assert.equal(undone.capture.timerSeconds, 10); assert.equal(undone.capture.mirror, false); assert.equal(undone.capture.style, "flexible");
  const redone = redoProject(undone, templateTimestamp);
  assert.equal(redone.capture.requiredShots, 1); assert.equal(redone.editor.template?.requiredSources.A, 1);
});

test("after the first shot, template undo and redo never change the frozen capture count", () => {
  const draftOne = applyTemplateToProject(draft(), designFromRecipe(templateFixture()), [], templateTimestamp);
  const captured = appendProjectMedia(draftOne, [{ id: "original", participantId: "person-a", kind: "photo", mime: "image/png", width: 640, height: 480, bytes: 1000 }], { ...draftOne.sourceOrder, A: ["original"] }, templateTimestamp, templateTimestamp);
  const one = designFromRecipe(templateFixture());
  const four = validateTemplateDesign({ ...one, requiredSources: { A: 4 }, slots: Array.from({ length: 4 }, (_, sourceIndex) => ({ ...one.slots[0], id: `slot-${sourceIndex}`, sourceIndex })) });
  const applied = applyTemplateToProject(captured, four, [], templateTimestamp), undone = undoProject(applied, templateTimestamp), redone = redoProject(undone, templateTimestamp);
  for (const project of [applied, undone, redone]) {
    assert.equal(project.capture.requiredShots, 1); assert.equal(project.capturedAt, templateTimestamp); assert.deepEqual(project.media, captured.media);
  }
  assert.equal(redone.editor.template?.requiredSources.A, 4);
});
