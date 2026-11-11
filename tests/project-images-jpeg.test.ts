import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import sharp from "sharp";
import { DEFAULT_THEN_NOW_ALIGNMENT, prepareThenNowReference, type ThenNowPlan } from "../lib/memories/then-and-now";
import { inspectImageHeader, withoutImageTrailer } from "../lib/projects/images";
import { createCloudUploadManager, type CloudUploadRecord } from "../lib/projects/cloud-upload";
import type { ProjectFinalisationStatus } from "../lib/projects/cloud-contract";
import { RESOURCE_LIMITS } from "../lib/projects/resource-bounds";
import { importRelayPhotos } from "../lib/relay-recovery";
import { verifyProjectOriginal } from "../lib/server/image-finalise";
import { installCanvasEnvironment, stubGlobal } from "./helpers/recording-canvas";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());
const latin = (text: string) => Buffer.from(text, "latin1");

const noise = Buffer.alloc(120 * 80 * 3);
for (let i = 0, seed = 7; i < noise.length; i++) { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; noise[i] = seed >>> 24; }
const source = () => sharp(noise, { raw: { width: 120, height: 80, channels: 3 } });

const fixtures = (async () => ({
  jpegs: {
    baseline: { bytes: await source().jpeg().toBuffer(), width: 120, height: 80 },
    progressive: { bytes: await source().jpeg({ progressive: true }).toBuffer(), width: 120, height: 80 },
    oriented: { bytes: await source().withMetadata({ orientation: 6 }).jpeg().toBuffer(), width: 80, height: 120 },
  },
  // Shapes of real camera trailers: Samsung SEF, a Pixel motion photo MP4, an MPF secondary image and zero padding.
  trailers: {
    samsung: latin("\0\0\0\0Image_UTC_Data1700000000000SEFH\x2a\0\0\0\x01\0\0\0SEFT"),
    motion: Buffer.concat([Buffer.from([0, 0, 0, 0x18]), latin("ftypmp42\0\0\0\0isommp42"), Buffer.alloc(64, 0xff)]),
    mpf: await sharp({ create: { width: 16, height: 16, channels: 3, background: "#808080" } }).jpeg().toBuffer(),
    padding: Buffer.alloc(256),
  },
}))();

test("JPEGs with camera data after EOI are accepted and stored without the trailer", async () => {
  const { jpegs, trailers } = await fixtures;
  assert.ok(jpegs.baseline.bytes.includes(Buffer.from([0xff, 0x00])), "fixture exercises byte stuffing");
  for (const [name, { bytes, width, height }] of Object.entries(jpegs)) {
    const clean = new Blob([bytes]);
    assert.deepEqual(inspectImageHeader(bytes), { mime: "image/jpeg", width, height }, name);
    assert.equal(await withoutImageTrailer(clean), clean);
    for (const [kind, trailer] of Object.entries(trailers)) {
      const file = Buffer.concat([bytes, trailer]);
      assert.deepEqual(inspectImageHeader(file), { mime: "image/jpeg", width, height }, `${name} + ${kind}`);
      const original = await withoutImageTrailer(new Blob([file]));
      assert.equal(original.type, "image/jpeg");
      assert.deepEqual(await bytesOf(original), new Uint8Array(bytes), `${name} + ${kind}`);
    }
  }
});

test("truncated JPEGs are still rejected, with or without a trailer", async () => {
  const { jpegs, trailers } = await fixtures;
  for (const [name, { bytes }] of Object.entries(jpegs)) {
    const scan = bytes.indexOf(Buffer.from([0xff, 0xda]));
    for (const end of [bytes.length - 1, bytes.length - 2, Math.floor((scan + bytes.length) / 2), scan + 20]) {
      const cut = bytes.subarray(0, end);
      assert.throws(() => inspectImageHeader(cut), /incomplete or unsupported/, `${name} cut at ${end}`);
      assert.throws(() => inspectImageHeader(Buffer.concat([cut, trailers.samsung])), /incomplete or unsupported/, `${name} cut at ${end} + trailer`);
      const unparsed = new Blob([cut]);
      assert.equal(await withoutImageTrailer(unparsed), unparsed);
    }
    const lateFrame = Buffer.from(bytes); lateFrame[lateFrame.length - 1] = 0xc0;
    assert.throws(() => inspectImageHeader(Buffer.concat([lateFrame, Buffer.from([0, 8, 8, 0, 1, 0, 1, 1, 0xff, 0xd9])])), /incomplete or unsupported/, `${name} frame after scan`);
  }
});

test("trimmed originals pass the server's strict JPEG verification", async () => {
  const { jpegs, trailers } = await fixtures;
  for (const { bytes } of Object.values(jpegs)) {
    const file = Buffer.concat([bytes, trailers.samsung]), original = await bytesOf(await withoutImageTrailer(new Blob([file])));
    const expected = { ...inspectImageHeader(original), kind: "photo" as const, bytes: original.length, sha256: sha(original) };
    assert.equal((await verifyProjectOriginal(original, expected)).verified.decoded, true);
    await assert.rejects(verifyProjectOriginal(file, { ...expected, bytes: file.length, sha256: sha(file) }), /invalid_image/);
  }
});

const project = "22222222-2222-4222-8222-222222222222";
function cloudUploads() {
  const owner = "11111111-1111-4111-8111-111111111111";
  const records = new Map<string, CloudUploadRecord>(), sent: Blob[] = []; let queued = false;
  const status = (id: string): ProjectFinalisationStatus => ({ assetId: id, status: queued ? "complete" : "not_queued", assetStatus: queued ? "ready" : "reserved", attempts: 0, reservedUntil: "2026-09-24T00:00:00Z", failure: null });
  const manager = createCloudUploadManager({
    journal: { ownerId: owner, async get(id) { return records.get(id) ?? null; }, async list() { return [...records.values()]; }, async put(record) { records.set(record.id, structuredClone(record)); }, async remove(id) { records.delete(id); }, close() {} },
    client: {
      ownerId: owner, assertActive() {},
      async reserve(projectId, asset) { return { ...asset, ownerId: owner, projectId, reservedUntil: "2026-09-24T00:00:00Z", status: "reserved" }; },
      async status(id) { return status(id); }, async mintUpload() { return { signedUrl: "fixture", path: "fixture", token: "fixture" }; },
      async upload(_projectId, _asset, blob) { sent.push(blob); return { acknowledged: true }; },
      async finalise(id) { queued = true; return status(id); },
    },
    inspect: async blob => inspectImageHeader(await bytesOf(blob)), sleep: async () => undefined,
  });
  return { manager, sent };
}

test("cloud uploads describe and send the JPEG without its trailer", async () => {
  const { jpegs, trailers } = await fixtures, { bytes } = jpegs.oriented, file = Buffer.concat([bytes, trailers.motion]), { manager, sent } = cloudUploads();
  const record = await manager.prepare(project, new Blob([file], { type: "image/jpeg" }), { kind: "photo" });
  assert.equal(record.asset.bytes, bytes.length); assert.equal(record.asset.sha256, sha(bytes));
  assert.equal((await manager.run(record.id, new Blob([file]))).state, "ready");
  assert.equal(sent.length, 1); assert.deepEqual(await bytesOf(sent[0]), new Uint8Array(bytes));
});

test("the 10 MiB limit counts the JPEG without its trailer", async t => {
  const { jpegs } = await fixtures, { bytes } = jpegs.oriented, limit = RESOURCE_LIMITS.photoBytes;
  const motion = new Blob([bytes, new Uint8Array(limit)]);
  const comment = Buffer.concat([Buffer.from([0xff, 0xfe, 0xff, 0xff]), Buffer.alloc(0xfffd)]);
  const oversized = new Blob([Buffer.concat([bytes.subarray(0, 2), ...Array<Buffer>(161).fill(comment), bytes.subarray(2), Buffer.alloc(64)])]);
  assert.ok(motion.size > limit && oversized.size > limit);
  assert.deepEqual(await bytesOf(await withoutImageTrailer(motion)), new Uint8Array(bytes));
  assert.equal(await withoutImageTrailer(oversized), oversized);

  const { manager } = cloudUploads();
  assert.equal((await manager.prepare(project, motion, { kind: "photo" })).asset.bytes, bytes.length);
  await assert.rejects(manager.prepare(project, oversized, { kind: "photo" }), /invalid_image/);

  const frame = { width: 80, height: 120 } as HTMLCanvasElement, decoded: Blob[] = [];
  await importRelayPhotos([motion], 1, () => true, async blob => { decoded.push(blob); return frame; });
  assert.deepEqual(await bytesOf(decoded[0]), new Uint8Array(bytes));

  installCanvasEnvironment(t);
  stubGlobal(t, "createImageBitmap", async (blob: Blob) => { decoded.push(blob); return { width: 80, height: 120, close() {} }; });
  const plan: ThenNowPlan = { version: 1, reference: { mediaId: "reference-1", provenance: { kind: "imported-image" }, date: null, crop: null }, alignment: { ...DEFAULT_THEN_NOW_ALIGNMENT }, ghostOpacity: 0.4 };
  (await prepareThenNowReference(motion, plan)).dispose();
  assert.deepEqual(await bytesOf(decoded[1]), new Uint8Array(bytes));
  await assert.rejects(prepareThenNowReference(oversized, plan), /Invalid Then & Now reference/);
});
