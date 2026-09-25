import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_EXPORT_SETTINGS, projectExportSettings, validateExportSettings } from "../lib/exports/settings";
import { applyProjectEdit, createProject, parsePhotoProject, redoProject, serializePhotoProject, undoProject, validatePhotoProject } from "../lib/projects/model";
import { exportProjectBundle, importProjectBundle } from "../lib/projects/bundle";
import { validateCloudDesign } from "../lib/projects/cloud-design";
import { validateDesignSaveRecord } from "../lib/projects/cloud-design-journal";
import { ProjectEditorQueue } from "../lib/projects/editor-queue";

const at = "2026-09-23T00:00:00.000Z";
const owner = "11111111-1111-4111-8111-111111111111";
const id = "22222222-2222-4222-8222-222222222222";
const settings = validateExportSettings({ ...DEFAULT_EXPORT_SETTINGS, profileId: "a4-contact", fit: "cover", format: "jpeg", quality: .8, marginMm: 12, cutMarks: false });
function base() { return createProject({ id: "export-project", createdAt: at, captureTimeZone: "Australia/Sydney", participants: [{ id: "person", role: "A" }] }); }

test("legacy projects retain exact payloads; first export edit upgrades and survives history/reload", () => {
  const legacy = validatePhotoProject({ ...base(), schemaVersion: 3 });
  const raw = serializePhotoProject(legacy), parsed = parsePhotoProject(raw);
  assert.equal(parsed.kind, "current");
  if (parsed.kind !== "current") throw new Error();
  assert.equal(serializePhotoProject(parsed.project), raw);
  assert.deepEqual(projectExportSettings(parsed.project.editor.exportSettings), DEFAULT_EXPORT_SETTINGS);
  const changed = applyProjectEdit(legacy, { sourceOrder: legacy.sourceOrder, editor: { ...legacy.editor, exportSettings: settings } }, at);
  assert.equal(changed.schemaVersion, 4); assert.equal(changed.revision, legacy.revision + 1);
  assert.deepEqual(projectExportSettings(undoProject(changed, at).editor.exportSettings), DEFAULT_EXPORT_SETTINGS);
  assert.deepEqual(redoProject(undoProject(changed, at), at).editor.exportSettings, settings);
  const reopened = parsePhotoProject(serializePhotoProject(changed));
  assert.equal(reopened.kind, "current"); if (reopened.kind === "current") assert.deepEqual(reopened.project.editor.exportSettings, settings);
  assert.throws(() => validatePhotoProject({ ...changed, schemaVersion: 3 }));
});

test("strict settings reject invalid fields, nonfinite values and unsupported versions", () => {
  for (const patch of [{ version: 2 }, { profileId: "remote" }, { fit: "stretch" }, { format: "svg" }, { quality: NaN }, { quality: .59 }, { marginMm: Infinity }, { marginMm: -1 }, { profileId: "print-strip", marginMm: 11 }, { cutMarks: 1 }, { token: "not-allowed" }]) {
    assert.throws(() => validateExportSettings({ ...settings, ...patch }));
  }
  assert.throws(() => validateExportSettings(null));
  assert.throws(() => validatePhotoProject({ ...base(), editor: { ...base().editor, exportSettings: null } }));
  let getterCalled = false;
  assert.throws(() => validateExportSettings({ ...settings, get quality() { getterCalled = true; return 1; } }));
  assert.equal(getterCalled, false);
});

test("portable backup and cloud snapshot preserve export preferences without leaking account scope", async () => {
  const project = createProject({ id: "settings-portable", createdAt: at, captureTimeZone: "UTC", editor: { exportSettings: settings } });
  const bundle = await exportProjectBundle(project, new Map());
  const restored = await importProjectBundle(bundle, { newId: () => "restored", now: () => at });
  assert.deepEqual(restored.project.editor.exportSettings, settings);
  const snapshot = validateCloudDesign({ version: 1, project, bindings: [], participants: [{ participantId: project.participants[0].id, ownerId: owner }] });
  assert.deepEqual(snapshot.project.editor.exportSettings, settings);
  assert.equal(snapshot.project.schemaVersion, 4);
});

test("old frozen cloud journal requests retain schema 3 and no inserted defaults", () => {
  const project = validatePhotoProject({ ...base(), schemaVersion: 3 });
  const record = { version: 1, id, ownerId: owner, localProjectId: project.id, cloudProjectId: id, revision: 0, createdAt: at, updatedAt: at, phase: "prepared", requestId: id, expectedRevision: null, project, participants: [{ participantId: "person", ownerId: owner }], bindings: [], uploads: [], receipt: null };
  const raw = JSON.stringify(validateDesignSaveRecord(record));
  assert.equal(JSON.stringify(validateDesignSaveRecord(JSON.parse(raw))), raw);
  assert.equal(JSON.stringify(validateDesignSaveRecord(record).project), JSON.stringify(project));
  assert.equal(validateCloudDesign({ version: 1, project, bindings: [], participants: record.participants }).project.schemaVersion, 3);
});

test("export preparation flush waits for the latest settings and exposes failed saves for retry", async () => {
  let project = base(), rejectSave = true;
  const queue = new ProjectEditorQueue(project.editor, async patch => {
    if (rejectSave) throw new Error("Device storage is full");
    project = applyProjectEdit(project, { sourceOrder: project.sourceOrder, editor: { ...project.editor, ...patch } }, at);
  });
  queue.patch({ exportSettings: settings });
  await assert.rejects(queue.flush(), /Device storage is full/);
  assert.match(queue.getSnapshot().error!, /Device storage is full/);
  assert.deepEqual(queue.getSnapshot().editor.exportSettings, settings);
  rejectSave = false;
  await queue.flush();
  assert.deepEqual(project.editor.exportSettings, settings);
  assert.equal(queue.getSnapshot().pending, false);
  queue.dispose();
});
