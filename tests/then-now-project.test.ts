import assert from "node:assert/strict";
import test from "node:test";
import { applyProjectEdit, attachProjectReference, createProject, createReferencedProject, parsePhotoProject, serializePhotoProject, undoProject, validatePhotoProject } from "../lib/projects/model";
import { exportProjectBundle, importProjectBundle, projectBlobHash } from "../lib/projects/bundle";
import { validateMediaResource, RESOURCE_LIMITS } from "../lib/projects/resource-bounds";
import { DEFAULT_THEN_NOW_ALIGNMENT, type ThenNowPlan } from "../lib/memories/then-and-now";
import { templatePixel, inspectTemplateFixture } from "./helpers/template-fixture";
import { templateFromProject } from "../lib/templates/from-project";

const plan: ThenNowPlan = { version: 1, reference: { mediaId: "old-image", provenance: { kind: "imported-strip" }, date: "2006-02-28", crop: { x: 0, y: 0, width: 1, height: 1 } }, alignment: { ...DEFAULT_THEN_NOW_ALIGNMENT }, ghostOpacity: .35 };
const declaration = () => ({ id: "old-image", kind: "reference" as const, mime: "image/png" as const, participantId: null, width: 1, height: 1, bytes: templatePixel().size });

test("a fresh round with its reference is a single initial storage revision", () => {
  const next = createReferencedProject({ id: "new-round", capture: { timerSeconds: 5 } }, declaration(), plan);
  assert.equal(next.revision, 0); assert.equal(next.capturedAt, null);
  assert.deepEqual(next.history, { past: [], future: [] });
  assert.deepEqual(next.sourceOrder, { A: [], B: [], C: [], D: [] });
  assert.equal(next.capture.timerSeconds, 5); assert.deepEqual(next.editor.thenNow, plan);
  assert.deepEqual(undoProject(next), next);
});

test("attaching and removing a reference never creates a camera capture or changes originals", () => {
  const empty = createProject(), attached = attachProjectReference(empty, declaration(), plan);
  assert.equal(attached.revision, empty.revision + 1); assert.equal(attached.capturedAt, null);
  assert.deepEqual(attached.sourceOrder, empty.sourceOrder); assert.deepEqual(attached.capture, empty.capture);
  const removed = applyProjectEdit(attached, { sourceOrder: attached.sourceOrder, editor: { ...attached.editor, thenNow: null } });
  assert.equal(removed.editor.thenNow, undefined); assert.equal(removed.media.length, 1);
  assert.deepEqual(undoProject(removed).editor.thenNow, plan);
  const reopened = parsePhotoProject(serializePhotoProject(attached));
  assert.equal(reopened.kind, "current"); if (reopened.kind === "current") assert.deepEqual(reopened.project.editor.thenNow, plan);
});
test("reference inventory, ownership, history and schema cannot bypass validation", () => {
  const empty = createProject();
  assert.throws(() => validatePhotoProject({ ...empty, editor: { ...empty.editor, thenNow: plan } }), /reference is missing/);
  assert.throws(() => attachProjectReference(empty, { ...declaration(), participantId: empty.participants[0].id }, plan));
  assert.throws(() => attachProjectReference(empty, { ...declaration(), id: "other-image" }, plan));
  const attached = attachProjectReference(empty, declaration(), plan);
  assert.throws(() => parsePhotoProject(JSON.stringify({ ...attached, schemaVersion: 2 })));
  assert.throws(() => validatePhotoProject({ ...attached, media: [] }));
  const { id, kind, mime, bytes, width, height } = declaration(), resource = { id, kind, mime, bytes, width, height };
  assert.throws(() => validateMediaResource({ ...resource, bytes: RESOURCE_LIMITS.photoBytes + 1 }), /integer/);
  assert.throws(() => validatePhotoProject({ ...attached, media: Array.from({ length: 7 }, (_, index) => ({ ...declaration(), id: index ? `reference-${index}` : "old-image", bytes: RESOURCE_LIMITS.photoBytes })) }), /quota exceeded/);
  assert.throws(() => attachProjectReference(attached, declaration(), plan), /Duplicate media/);
  assert.throws(() => attachProjectReference(empty, declaration(), { ...plan, reference: { ...plan.reference, crop: { x: 0, y: 0, width: .5, height: 1 } } }), /source pixel/);
});
test("portable backup preserves the full reference bytes, selected crop and dates", async () => {
  const blob = templatePixel(), original = attachProjectReference(createProject({ scope: { kind: "account", ownerId: "private-owner" } }), declaration(), plan);
  const bundle = await exportProjectBundle(original, new Map([["old-image", blob]]));
  const imported = await importProjectBundle(bundle, { inspect: inspectTemplateFixture });
  assert.deepEqual(imported.project.scope, { kind: "device" }); assert.deepEqual(imported.project.editor.thenNow, plan);
  assert.equal(await projectBlobHash(imported.media.get("old-image")!), await projectBlobHash(blob));
  assert.equal(imported.project.capturedAt, null); assert.equal(imported.project.media[0].kind, "reference");
});
test("a reusable frame excludes the personal reference and its provenance", () => {
  const attached = attachProjectReference(createProject(), declaration(), plan);
  const reusable = templateFromProject(attached), encoded = JSON.stringify(reusable);
  assert(!encoded.includes("old-image")); assert(!encoded.includes("2006-02-28")); assert(!encoded.includes("thenNow"));
  assert.deepEqual(reusable.decorations, []);
});
