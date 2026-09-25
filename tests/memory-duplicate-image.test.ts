import test from "node:test";
import assert from "node:assert/strict";
import { duplicateMemoryImage, flattenedMemoryProject } from "../lib/memories/duplicate-image";
import type { RetainedStripDownload } from "../lib/memories/retained-strip-contract";
import type { RetainedStripClient } from "../lib/memories/retained-strip-client";
import type { MemoryActivity } from "../lib/memories/activity-contract";
import type { openProjectRepository } from "../lib/projects/storage";
import { configureProjectCapture, parsePhotoProject, serializePhotoProject } from "../lib/projects/model";
import { composeStrip } from "../lib/compose";
import { getLayout } from "../lib/layouts";
import { templateFromProject } from "../lib/templates/from-project";
import { validateCloudDesign } from "../lib/projects/cloud-design";
const ownerId = "00000000-0000-4000-8000-000000000001";
const image: RetainedStripDownload = { version: 1, id: ownerId, availability: "available", bytesLimit: 16777216, blob: new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }), sha256: "a".repeat(64), width: 224, height: 640 };
const item: MemoryActivity = { id: ownerId, mine: true, occurredAt: "2025-01-01T00:00:00.000Z", provenance: "saved_at", availability: "available", source: { kind: "strip", id: ownerId, scopeKind: "personal", scopeId: null }, annotation: null };
test("flattened copy preserves full aspect and original bytes without inventing camera provenance", async () => {
  let saved = false, closed = false;
  const client = { ownerId, assertActive() {}, async resolve() { return image; }, async download() { return image; }, close() {} } satisfies RetainedStripClient;
  const open = (async (scope, options) => ({ scope, close() { closed = true; }, async save(project, blobs, revision) { options?.assertActive?.(); assert.equal(revision, null); assert.equal(project.revision, 0); assert.equal(blobs.get("finished-image"), image.blob); saved = true; return project; } })) as typeof openProjectRepository;
  const project = await duplicateMemoryImage(item, client, undefined, open);
  assert.ok(saved && closed); assert.deepEqual(project.scope, { kind: "account", ownerId });
  assert.equal(project.capturedAt, null); assert.notEqual(project.createdAt, item.occurredAt);
  assert.deepEqual(project.editor.template?.canvas, { width: 224, height: 640 });
  assert.deepEqual(project.editor.template?.slots.map(s => [s.x, s.y, s.width, s.height]), [[0, 0, 1, 1]]);
  assert.deepEqual(project.sourceOrder.A, ["finished-image"]); assert.equal(project.editor.template?.layers.length, 0);
});
test("account loss during download never opens local storage", async () => {
  let active = true, opened = false;
  const client = { ownerId, assertActive() { if (!active) throw new Error("account_changed"); }, async resolve() { return image; }, async download() { active = false; return image; }, close() {} } satisfies RetainedStripClient;
  await assert.rejects(duplicateMemoryImage(item, client, undefined, (async () => { opened = true; throw new Error("unexpected"); }) as typeof openProjectRepository), /account_changed/);
  assert.equal(opened, false);
});
test("account loss during storage preparation trips the transaction fence and closes storage", async () => {
  let active = true, closed = false;
  const client = { ownerId, assertActive() { if (!active) throw new Error("account_changed"); }, async resolve() { return image; }, async download() { return image; }, close() {} } satisfies RetainedStripClient;
  const open = (async (scope: Parameters<typeof openProjectRepository>[0], options: Parameters<typeof openProjectRepository>[1]) => ({ scope, close() { closed = true; }, async save() { active = false; options?.assertActive?.(); throw new Error("unexpected"); } })) as unknown as typeof openProjectRepository;
  await assert.rejects(duplicateMemoryImage(item, client, undefined, open), /account_changed/); assert.ok(closed);
});
test("oversized retained images are refused without lossy conversion", () => {
  assert.throws(() => flattenedMemoryProject({ ...image, blob: new Blob([new Uint8Array(10 * 1024 * 1024 + 1)]) }, ownerId), /10 MiB/);
});
test("unknown date survives serialisation and templates, locks capture count and never stamps today", () => {
  const project = flattenedMemoryProject(image, ownerId);
  const parsed = parsePhotoProject(serializePhotoProject(project));
  assert.equal(parsed.kind, "current"); if (parsed.kind !== "current") throw new Error("Unexpected project");
  assert.equal(parsed.project.capturedAt, null);
  const cloud = validateCloudDesign({ version: 1, project: { ...project, scope: { kind: "device" } }, bindings: [{ mediaId: "finished-image", assetId: ownerId, ownerId, sha256: image.sha256 }], participants: [{ participantId: "image-owner", ownerId }] });
  assert.equal(cloud.project.capturedAt, null);
  assert.throws(() => configureProjectCapture(project, { requiredShots: 4 }), /new round/);
  assert.deepEqual(templateFromProject(project).canvas, { width: 224, height: 640 });
  const text: string[] = [], draws: unknown[][] = [];
  const context = new Proxy({}, { get: (_target, key) => key === "fillText" ? (value: string) => text.push(value) : key === "drawImage" ? (...args: unknown[]) => draws.push(args) : String(key).startsWith("create") ? () => ({ addColorStop() {} }) : () => {} }) as CanvasRenderingContext2D;
  const canvas = { width: 0, height: 0, getContext: () => context } as unknown as HTMLCanvasElement;
  const source = { width: 224, height: 640 } as HTMLCanvasElement;
  composeStrip(canvas, { layout: getLayout("strip4"), template: project.editor.template, capturedAt: null, shots: { A: [source] }, stickers: [], style: { frameColor: "#ffffff", inkColor: "#000000", patternId: "none", filterId: "none", caption: "", showDate: true, stickerStyle: "flat" } }, 1);
  assert.deepEqual(text, []); assert.equal(canvas.width, 224); assert.equal(canvas.height, 640);
  assert.equal(draws.filter(call => call[0] === source).length, 1);
});
