import assert from "node:assert/strict";
import test from "node:test";
import { exportProjectBundle, importProjectBundle, portableProject, PROJECT_BUNDLE_LIMIT, projectBlobHash, type ProjectImageInspector } from "../lib/projects/bundle";
import { inspectImageHeader } from "../lib/projects/images";
import { createProject, PROJECT_SCHEMA_VERSION, validatePhotoProject, type PhotoProject } from "../lib/projects/model";

const timestamp = "2026-09-23T00:00:00.000Z";
const pixel = () => new Blob([Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=", "base64")], { type: "image/png" });
const inspect: ProjectImageInspector = async blob => inspectImageHeader(new Uint8Array(await blob.arrayBuffer()));
function fixture(): { project: PhotoProject; media: Map<string, Blob> } {
  const blob = pixel();
  const empty = createProject({ id: "project-original", createdAt: timestamp, captureTimeZone: "Australia/Sydney", scope: { kind: "account", ownerId: "private-account" }, participants: [{ id: "person-a", role: "A" }], capture: { cameraId: "private-camera" } });
  const project = validatePhotoProject({ ...empty, capturedAt: timestamp, sourceOrder: { A: ["source-one"], B: [], C: [], D: [] }, media: [{ id: "source-one", kind: "photo", mime: "image/png", bytes: blob.size, width: 1, height: 1, participantId: "person-a" }] });
  return { project, media: new Map([["source-one", blob]]) };
}
const options = { inspect, newId: () => "imported-project", now: () => timestamp };
async function rewriteManifest(bundle: Blob, rewrite: (manifest: Record<string, unknown>) => void): Promise<Blob> {
  const bytes = new Uint8Array(await bundle.arrayBuffer()), header = bytes.slice(0, 18), view = new DataView(header.buffer);
  const length = view.getUint32(10), manifest = JSON.parse(new TextDecoder().decode(bytes.slice(18, 18 + length)));
  rewrite(manifest);
  const replacement = new TextEncoder().encode(JSON.stringify(manifest));
  view.setUint32(10, replacement.length);
  return new Blob([header, replacement, bytes.slice(18 + length)]);
}

test("portable project round-trip retains original bytes and capture provenance while removing local account/camera binding", async () => {
  const { project, media } = fixture();
  const bundle = await exportProjectBundle(project, media);
  const imported = await importProjectBundle(bundle, options);
  assert.equal(imported.project.id, "imported-project");
  assert.equal(imported.project.revision, 0);
  assert.deepEqual(imported.project.scope, { kind: "device" });
  assert.equal(imported.project.capture.cameraId, null);
  assert.equal(imported.project.capturedAt, project.capturedAt);
  assert.equal(imported.project.captureTimeZone, project.captureTimeZone);
  assert.deepEqual(imported.project.sourceOrder, project.sourceOrder);
  assert.equal(await projectBlobHash(imported.media.get("source-one")!), await projectBlobHash(media.get("source-one")!));
  const bytes = new Uint8Array(await bundle.arrayBuffer());
  const text = new TextDecoder().decode(bytes.slice(18, 18 + new DataView(bytes.buffer).getUint32(10)));
  assert(!text.includes("private-account"));
  assert(!text.includes("private-camera"));
  assert.equal(project.scope.kind, "account");
  assert.equal(project.capture.cameraId, "private-camera");
});

test("a blank project is portable without invented media", async () => {
  const project = createProject({ id: "blank", createdAt: timestamp, captureTimeZone: "Australia/Sydney" });
  const imported = await importProjectBundle(await exportProjectBundle(project, new Map()), options);
  assert.equal(imported.media.size, 0);
  assert.deepEqual(imported.project.media, []);
});

test("truncation, trailing bytes, unknown versions and oversized framing reject before media inspection", async () => {
  const { project, media } = fixture(), bundle = await exportProjectBundle(project, media);
  let inspections = 0;
  const noInspect = { ...options, inspect: async (blob: Blob) => { inspections++; return inspect(blob); } };
  for (const length of [0, 17, bundle.size - 1]) await assert.rejects(importProjectBundle(bundle.slice(0, length), noInspect));
  await assert.rejects(importProjectBundle(new Blob([bundle, "x"]), noInspect), /trailing/);
  const bytes = new Uint8Array(await bundle.arrayBuffer());
  bytes[0] = 0;
  await assert.rejects(importProjectBundle(new Blob([bytes]), noInspect), /signature/);
  bytes[0] = 80;
  new DataView(bytes.buffer).setUint16(8, 2);
  await assert.rejects(importProjectBundle(new Blob([bytes]), noInspect), /version/);
  new DataView(bytes.buffer).setUint16(8, 1);
  new DataView(bytes.buffer).setUint32(10, 65537);
  await assert.rejects(importProjectBundle(new Blob([bytes]), noInspect), /bounds/);
  new DataView(bytes.buffer).setUint32(10, 2);
  new DataView(bytes.buffer).setUint32(14, 25);
  await assert.rejects(importProjectBundle(new Blob([bytes]), noInspect), /bounds/);
  assert.equal(inspections, 0);
});

test("full bundle ceiling applies before allocating or parsing its body", async () => {
  const large = new Blob([new Uint8Array(1024 * 1024)]);
  const tooLarge = new Blob([...Array(64).fill(large), new Uint8Array(PROJECT_BUNDLE_LIMIT - 64 * 1024 * 1024 + 1)]);
  assert.equal(tooLarge.size, PROJECT_BUNDLE_LIMIT + 1);
  await assert.rejects(importProjectBundle(tooLarge, options), /size/);
});

test("tampered media is rejected by hash before decoder work", async () => {
  const { project, media } = fixture(), bytes = new Uint8Array(await (await exportProjectBundle(project, media)).arrayBuffer());
  bytes[bytes.length - 1] ^= 1;
  let inspected = false;
  await assert.rejects(importProjectBundle(new Blob([bytes]), { ...options, inspect: async blob => { inspected = true; return inspect(blob); } }), /integrity/);
  assert.equal(inspected, false);
});

test("unknown entry IDs and mismatched manifest inventories reject", async () => {
  const { project, media } = fixture(), bundle = await exportProjectBundle(project, media);
  const bytes = new Uint8Array(await bundle.arrayBuffer()), entryOffset = 18 + new DataView(bytes.buffer).getUint32(10);
  bytes[entryOffset + 1] = "X".charCodeAt(0);
  await assert.rejects(importProjectBundle(new Blob([bytes]), options), /Unknown/);
  const changed = await rewriteManifest(bundle, manifest => { (manifest.media as Array<{ bytes: number }>)[0].bytes++; });
  await assert.rejects(importProjectBundle(changed, options), /length differs/);
  const twoPhotos = validatePhotoProject({ ...project, media: [...project.media, { ...project.media[0], id: "source-two" }], sourceOrder: { A: ["source-one", "source-two"], B: [], C: [], D: [] } });
  const duplicate = new Uint8Array(await (await exportProjectBundle(twoPhotos, new Map([...media, ["source-two", pixel()]]))).arrayBuffer());
  const firstEntry = 18 + new DataView(duplicate.buffer).getUint32(10);
  const secondEntry = firstEntry + 1 + duplicate[firstEntry] + 4 + 32 + project.media[0].bytes;
  duplicate.set(new TextEncoder().encode("source-one"), secondEntry + 1);
  await assert.rejects(importProjectBundle(new Blob([duplicate]), options), /duplicate/);
});

test("manifest paths, unknown fields and future schemas are preserved by caller but never imported as editable", async () => {
  const { project, media } = fixture(), bundle = await exportProjectBundle(project, media);
  await assert.rejects(importProjectBundle(await rewriteManifest(bundle, value => { value.schemaVersion = PROJECT_SCHEMA_VERSION + 1; }), options), /Unsupported project/);
  await assert.rejects(importProjectBundle(await rewriteManifest(bundle, value => { value.token = "not-an-accepted-field"; }), options), /manifest/);
  await assert.rejects(importProjectBundle(await rewriteManifest(bundle, value => { value.id = "../../outside"; }), options), /manifest/);
});

test("real header checks and decoded MIME/dimensions are mandatory on imported entries", async () => {
  const { project, media } = fixture(), bundle = await exportProjectBundle(project, media);
  await assert.rejects(importProjectBundle(bundle, { ...options, inspect: async () => ({ mime: "image/jpeg", width: 1, height: 1 }) }), /MIME/);
  await assert.rejects(importProjectBundle(bundle, { ...options, inspect: async () => ({ mime: "image/png", width: 2, height: 1 }) }), /dimensions/);
  await assert.rejects(importProjectBundle(bundle, { ...options, inspect: async () => { throw new Error("decoder failed"); } }), /decoder failed/);
});

test("export refuses missing/extra media, altered declarations and non-project secret fields", async () => {
  const { project, media } = fixture();
  await assert.rejects(exportProjectBundle(project, new Map()), /inventory/);
  await assert.rejects(exportProjectBundle(project, new Map([...media, ["extra", pixel()]])), /inventory/);
  await assert.rejects(exportProjectBundle(project, new Map([["source-one", new Blob(["x"], { type: "image/png" })]])), /byte length/);
  assert.throws(() => portableProject({ ...project, token: "private" } as PhotoProject), /fields/);
});
