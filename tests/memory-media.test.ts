import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { annualRecapGeometry } from "../lib/recap";
import { createMemoryMedia, assertMemorySource, type MemoryMediaClients, type MemoryMediaPorts } from "../lib/memories/memory-media";
import type { MemoryActivity } from "../lib/memories/activity-contract";
import { inspectImageHeader } from "../lib/projects/images";
const owner = randomUUID(), project = randomUUID();
const raw = readFileSync(new URL("./fixtures/projects/b.png", import.meta.url)), info = inspectImageHeader(raw), blob = new Blob([raw], { type: "image/png" });
function item(kind: "strip" | "project_asset" = "strip"): MemoryActivity {
  return { id: randomUUID(), mine: true, occurredAt: "2026-01-01T00:00:00.000Z", provenance: kind === "strip" ? "saved_at" : "verified_at", availability: "available", annotation: { revision: 0, chapterId: null, occasion: null }, source: { kind, id: randomUUID(), scopeKind: kind === "strip" ? "personal" : "project", scopeId: kind === "strip" ? null : project } };
}
function fixture(items: MemoryActivity[], original = blob) {
  const sourceInfo = inspectImageHeader(new Uint8Array(readFileSync(new URL("./fixtures/projects/b.png", import.meta.url)))), calls: string[] = [];
  const assets = items.filter(i => i.source!.kind === "project_asset").map(i => ({ id: i.source!.id, ownerId: owner, kind: "photo" as const, ...sourceInfo, bytes: original.size, sha256: "a".repeat(64) }));
  const clients: MemoryMediaClients = {
    retained: { ownerId: owner, assertActive() {}, async resolve(id) { calls.push(`resolve:${id}`); return { version: 1, id, availability: "available", bytesLimit: 16777216 }; }, async download(id) { calls.push(`download:${id}`); return { version: 1, id, availability: "available", bytesLimit: 16777216, blob: original, width: sourceInfo.width, height: sourceInfo.height, sha256: "a".repeat(64) }; } },
    projects: { ownerId: owner, assertActive() {}, async view(id) { calls.push(`view:${id}`); return { project: { id, ownerId: owner, kind: "personal", title: "Fixture", maxBytes: 67108864, status: "active", createdAt: "2026-01-01T00:00:00.000Z" }, members: [{ userId: owner, status: "accepted" }], assets }; }, async read(asset) { calls.push(`read:${asset.id}`); return { signedUrl: "https://fixture.invalid/transient", expiresIn: 300 }; }, async download(asset) { calls.push(`download:${asset.id}`); return original; } },
  };
  const canvases: HTMLCanvasElement[] = [], bitmaps: { width: number; height: number; closed: boolean; close(): void }[] = [];
  const canvas = () => { const value = { width: 0, height: 0, getContext: () => ({ drawImage() {} }) } as unknown as HTMLCanvasElement; canvases.push(value); return value; };
  const ports: MemoryMediaPorts = {
    async decode() { calls.push("decode"); const bitmap = { width: sourceInfo.width, height: sourceInfo.height, closed: false, close() { this.closed = true; } }; bitmaps.push(bitmap); return bitmap; },
    canvas, async encode(value) { calls.push(`encode:${value.width}x${value.height}`); return blob; },
    compose(sources) { calls.push(`compose:${sources.length}`); assert.ok(sources.every(s => s.width <= 640 && s.height <= 640)); const result = canvas(), geometry = annualRecapGeometry(sources.length); result.width = geometry.outputWidth; result.height = geometry.outputHeight; return result; },
  };
  return { clients, ports, calls, canvases, bitmaps, assets };
}
test("annual geometry stays bounded for twelve mixed-orientation thumbnails", () => {
  const geometry = annualRecapGeometry(12); assert.equal(geometry.outputWidth, 2740); assert.equal(geometry.outputHeight, 2394); assert.ok(geometry.outputWidth * geometry.outputHeight < 12 * 1024 * 1024);
  for (const count of [0, 13, 1.5, NaN]) assert.throws(() => annualRecapGeometry(count));
  assert.throws(() => annualRecapGeometry(12, 2)); assert.throws(() => annualRecapGeometry(1, Infinity));
});
test("annual portrait cells use actual dimensions without forcing square whitespace", () => {
  const strips = annualRecapGeometry(3, 1, 225, 640);
  assert.equal(strips.outputWidth, 827); assert.equal(strips.outputHeight, 930);
  const originals = annualRecapGeometry(3, 1, 256, 384);
  assert.equal(originals.outputWidth, 920); assert.equal(originals.outputHeight, 674);
  assert.throws(() => annualRecapGeometry(3, 1, 641, 384));
});
test("fresh retained resolution wraps download and every resource is released", async () => {
  const selected = item(), f = fixture([selected]);
  const result = await createMemoryMedia(f.ports).prepareMemoryThumbnail(selected, f.clients);
  assert.equal(result.activityId, selected.id); assert.equal(result.blob.type, "image/png"); assert.ok(result.width <= 640 && result.height <= 640);
  assert.deepEqual(f.calls, [`resolve:${selected.source!.id}`, `download:${selected.source!.id}`, "decode", `encode:${info.width}x${info.height}`, `resolve:${selected.source!.id}`]);
  assert.ok(f.bitmaps.every(bitmap => bitmap.closed)); assert.ok(f.canvases.every(canvas => canvas.width === 0 && canvas.height === 0));
});
test("project preview requires fresh membership and exact original before both reads", async () => {
  const selected = item("project_asset"), f = fixture([selected]);
  await createMemoryMedia(f.ports).prepareMemoryThumbnail(selected, f.clients);
  assert.deepEqual(f.calls.filter(c => c.startsWith("view") || c.startsWith("read")), [`view:${project}`, `read:${selected.source!.id}`, `view:${project}`, `read:${selected.source!.id}`]);
  f.clients.projects.view = async () => { throw new Error("access denied"); };
  await assert.rejects(assertMemorySource(selected, f.clients), /source_unavailable/);
});
test("missing/concealed sources fail before download or native allocation", async () => {
  const selected = item("project_asset"), f = fixture([selected]); f.assets.splice(0);
  await assert.rejects(createMemoryMedia(f.ports).prepareMemoryThumbnail(selected, f.clients), /source_unavailable/);
  assert.equal(f.canvases.length, 0); assert.equal(f.calls.some(call => call.startsWith("download")), false);
  await assert.rejects(async () => createMemoryMedia(f.ports).prepareMemoryThumbnail({ ...selected, source: null, availability: "access_lost" }, f.clients), /source_unavailable/);
});
test("descriptor changed during encoding is denied without publishing a thumbnail", async () => {
  const selected = item("project_asset"), f = fixture([selected]);
  f.ports.encode = async () => { f.assets[0] = { ...f.assets[0], sha256: "b".repeat(64) }; return blob; };
  await assert.rejects(createMemoryMedia(f.ports).prepareMemoryThumbnail(selected, f.clients), /access_changed/);
  assert.ok(f.canvases.every(canvas => canvas.width === 0));
});
test("annual downloads are sequential, preserve selection order and recheck all sources", async () => {
  const items = [item(), item("project_asset"), item()], f = fixture(items);
  const result = await createMemoryMedia(f.ports).renderAnnualMemoryRecap(items, "2026", ["Jan", "Feb", "Mar"], f.clients);
  assert.deepEqual(result.activityIds, items.map(i => i.id)); assert.equal(result.width, annualRecapGeometry(3).outputWidth);
  const sequence = f.calls.filter(call => call.startsWith("download") || call === "decode");
  assert.deepEqual(sequence, items.flatMap(i => [`download:${i.source!.id}`, "decode"]));
  assert.ok(f.canvases.every(canvas => canvas.width === 0)); assert.ok(f.bitmaps.every(bitmap => bitmap.closed));
});
test("a later unavailable source fails the whole recap and clears earlier thumbnails", async () => {
  const items = [item(), item()], f = fixture(items), original = f.clients.retained.download;
  f.clients.retained.download = async (id, signal) => { if (id === items[1].source!.id) throw new Error("missing"); return original(id, signal); };
  await assert.rejects(createMemoryMedia(f.ports).renderAnnualMemoryRecap(items, "2026", ["Jan", "Feb"], f.clients), /source_unavailable/);
  assert.ok(f.canvases.every(canvas => canvas.width === 0)); assert.equal(f.calls.some(c => c.startsWith("compose")), false);
});
test("real large PNG headers are checked and original is reduced before retaining it", async () => {
  const raw = await sharp({ create: { width: 2000, height: 1000, channels: 3, background: "red" } }).png().toBuffer(), original = new Blob([raw], { type: "image/png" }), selected = item(), f = fixture([selected], original);
  f.clients.retained.download = async id => ({ version: 1, id, availability: "available", bytesLimit: 16777216, blob: original, width: 2000, height: 1000, sha256: "a".repeat(64) });
  let closed = false; f.ports.decode = async () => ({ width: 2000, height: 1000, close() { closed = true; } });
  const result = await createMemoryMedia(f.ports).prepareMemoryThumbnail(selected, f.clients);
  assert.equal(result.width, 640); assert.equal(result.height, 320); assert.equal(closed, true);
});
test("decode cancellation retains the occupied slot and closes a late bitmap", async () => {
  const selected = item(), f = fixture([selected]), abort = new AbortController();
  let finish!: (bitmap: { width: number; height: number; close(): void }) => void, started!: () => void;
  const begun = new Promise<void>(resolve => { started = resolve; });
  f.ports.decode = () => new Promise(resolve => { finish = resolve; started(); });
  const api = createMemoryMedia(f.ports), pending = api.prepareMemoryThumbnail(selected, f.clients, abort.signal); await begun; abort.abort();
  await assert.rejects(pending, /cancelled/); await assert.rejects(api.prepareMemoryThumbnail(selected, f.clients), /busy/);
  let closed = false; finish({ width: info.width, height: info.height, close() { closed = true; } });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, true); assert.equal(f.canvases.length, 0);
  await createMemoryMedia(fixture([selected]).ports).prepareMemoryThumbnail(selected, f.clients);
});
test("timed-out encoding keeps its canvas alive until the native callback settles", async () => {
  const selected = item(), f = fixture([selected]); let finish!: (blob: Blob) => void;
  f.ports.encode = () => new Promise(resolve => { finish = resolve; });
  const api = createMemoryMedia(f.ports, { nativeTimeoutMs: 10 });
  await assert.rejects(api.prepareMemoryThumbnail(selected, f.clients), /timeout/);
  assert.ok(f.canvases[0].width > 0); await assert.rejects(api.prepareMemoryThumbnail(selected, f.clients), /busy/);
  finish(blob); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.canvases[0].width, 0);
});
test("account change at final authority check never returns an encoded result", async () => {
  const selected = item(), f = fixture([selected]); let changed = false;
  f.clients.retained.assertActive = () => { if (changed) throw new Error("account_changed"); };
  f.ports.encode = async () => { changed = true; return blob; };
  await assert.rejects(createMemoryMedia(f.ports).prepareMemoryThumbnail(selected, f.clients), /account_changed/);
  assert.ok(f.canvases.every(canvas => canvas.width === 0));
});
test("duplicate/over-limit selection and mismatched client owners do no source work", async () => {
  const selected = item(), f = fixture([selected]), api = createMemoryMedia(f.ports);
  await assert.rejects(api.renderAnnualMemoryRecap([selected, selected], "2026", ["A", "B"], f.clients), /invalid_selection/);
  await assert.rejects(api.renderAnnualMemoryRecap(Array(13).fill(selected), "2026", Array(13).fill(""), f.clients), /invalid_selection/);
  f.clients.projects.ownerId = randomUUID(); await assert.rejects(async () => api.prepareMemoryThumbnail(selected, f.clients), /account_changed/);
  assert.equal(f.calls.length, 0);
});
