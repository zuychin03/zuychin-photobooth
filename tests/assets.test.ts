import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import sharp from "sharp";
import manifest from "../lib/assets/manifest.json";
import { CURATED_ASSETS, SCENE_ASSETS, MATERIAL_ASSETS, getCuratedAsset, getAssetCrop, validateAssetRegistry } from "../lib/assets/registry";
import { createAssetLoader, type DecodedAsset } from "../lib/assets/loader";

const first = CURATED_ASSETS[0];
const bytesFor = (path: string) => readFile(new URL(`../public${path}`, import.meta.url));
const source = { image: {} as CanvasImageSource, width: first.full.width, height: first.full.height };
const responseFor = async () => new Response(await bytesFor(first.full.path), { headers: { "Content-Type": "image/webp" } });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test("all 24 originals and 48 delivery files match measured dimensions, byte budgets and hashes", async () => {
  assert.equal(SCENE_ASSETS.length, 18); assert.equal(MATERIAL_ASSETS.length, 6);
  let total = 0;
  for (const asset of CURATED_ASSETS) {
    const original = await readFile(new URL(`../${asset.provenance.source}`, import.meta.url));
    assert.equal(createHash("sha256").update(original).digest("hex"), asset.provenance.sha256);
    for (const variant of ["full", "thumbnail"] as const) {
      const declaration = asset[variant], bytes = await bytesFor(declaration.path), metadata = await sharp(bytes).metadata();
      assert.equal(bytes.length, declaration.bytes); assert.equal(metadata.width, declaration.width); assert.equal(metadata.height, declaration.height);
      assert.equal(metadata.format, "webp"); assert.equal(createHash("sha256").update(bytes).digest("hex"), declaration.sha256); total += bytes.length;
    }
  }
  assert.equal(total, 5110258);
});

test("registry rejects remote/traversal paths, duplicate IDs, malformed provenance, future versions and bad bounds", () => {
  const mutate = (change: (input: typeof manifest) => void) => { const input = structuredClone(manifest); change(input); assert.throws(() => validateAssetRegistry(input)); };
  mutate(input => { input.assets[0].full.path = "https://foreign.test/image.webp"; });
  mutate(input => { input.assets[0].full.path = "/scenes/v2/../private.webp"; });
  mutate(input => { input.assets[1].id = input.assets[0].id; });
  mutate(input => { input.assets[0].provenance.file = "docs/assets/v2/../../secret.json"; });
  mutate(input => { input.version = "3.0.0"; });
  mutate(input => { input.assets[0].focalPoint[0] = NaN; });
  mutate(input => { input.assets[0].full.width = 99999; });
  mutate(input => { input.assets[0].thumbnail.bytes = 999999; });
  assert.equal(getCuratedAsset("unknown"), null); assert(Object.isFrozen(first.full));
});

test("focal cover crops stay in source bounds for eight layout aspect ratios", () => {
  for (const asset of CURATED_ASSETS) for (const [width, height] of [[2, 6], [4, 6], [1, 1], [6, 4], [3, 4], [9, 16], [16, 9], [2, 3]]) {
    const crop = getAssetCrop(asset, width, height);
    assert(crop.x >= 0 && crop.y >= 0 && crop.x + crop.width <= asset.full.width + 1e-8 && crop.y + crop.height <= asset.full.height + 1e-8);
    assert(Math.abs(crop.width / crop.height - width / height) < 1e-8);
  }
  assert.throws(() => getAssetCrop(first, 0, 100));
});

test("reviewed portrait focal overrides preserve landscape coverage", () => {
  for (const id of ["paper-moon-studio-v2", "porcelain-sculpture-studio-v2", "lantern-courtyard-v2", "lilac-origami-v2", "liquid-chrome-v2", "film-noir-lobby-v2", "graduation-atelier-v2", "winter-celebration-v2", "birthday-confetti-v2"]) {
    const asset = getCuratedAsset(id)!;
    assert.deepEqual(asset.focalPoint, [0.75, 0.5]);
    assert.deepEqual(getAssetCrop(asset, 3, 4), { x: 768, y: 0, width: 768, height: 1024 });
    assert.deepEqual(getAssetCrop(asset, 3, 2), { x: 0, y: 0, width: 1536, height: 1024 });
  }
});

test("loader is lazy, verifies before decoding and explicitly releases each ready resource once", async () => {
  let fetches = 0, decodes = 0, closes = 0;
  const loader = createAssetLoader({ fetch: async () => { fetches++; return responseFor(); }, decode: async () => { decodes++; return { ...source, close: () => { closes++; } }; } });
  assert.equal(fetches, 0);
  const result = await loader.preload(first.id);
  assert.equal(result.kind, "ready"); assert.equal(fetches, 1); assert.equal(decodes, 1);
  if (result.kind === "ready") { result.release(); result.release(); }
  loader.dispose(); assert.equal(closes, 1);
  assert.equal((await loader.preload(first.id)).kind, "fallback");
  await assert.rejects(loader.preload("https://foreign.test/photo"), /Unknown/);
});

test("tampered, oversized, wrong-MIME and unavailable asset responses never decode", async () => {
  const bytes = await bytesFor(first.full.path);
  for (const response of [new Response(new Uint8Array(bytes.length), { headers: { "Content-Type": "image/webp" } }), new Response(new Uint8Array(bytes.length + 1), { headers: { "Content-Type": "image/webp" } }), new Response(bytes, { headers: { "Content-Type": "image/png" } }), new Response(null, { status: 404 })]) {
    let decodes = 0;
    const loader = createAssetLoader({ fetch: async () => response, decode: async () => { decodes++; return { ...source, close() {} }; } });
    assert.equal((await loader.preload(first.id)).kind, "fallback"); assert.equal(decodes, 0); loader.dispose();
  }
});

test("loader limits live handles and resumes a queued request after release", async () => {
  let opens = 0, maximum = 0;
  const loader = createAssetLoader({ fetch: async () => responseFor(), decode: async () => { opens++; maximum = Math.max(maximum, opens); return { ...source, close: () => { opens--; } }; } });
  const handles = await Promise.all(Array.from({ length: 4 }, () => loader.preload(first.id)));
  assert(handles.every(result => result.kind === "ready"));
  let resolved = false;
  const fifth = loader.preload(first.id).then(result => { resolved = true; return result; });
  await tick(); assert.equal(resolved, false);
  if (handles[0].kind === "ready") handles[0].release();
  assert.equal((await fifth).kind, "ready"); assert.equal(maximum, 4); loader.dispose(); assert.equal(opens, 0);
});

test("timed-out native decoders keep capacity reserved and late images close", async () => {
  let closed = 0;
  const releases: ((value: DecodedAsset) => void)[] = [];
  const bytes = await bytesFor(first.full.path);
  const loader = createAssetLoader({ fetch: async () => new Response(bytes, { headers: { "Content-Type": "image/webp" } }), timeoutMs: 500, decode: () => new Promise(resolve => { releases.push(resolve); }) });
  const results = await Promise.all([loader.preload(first.id), loader.preload(first.id), loader.preload(first.id)]);
  assert(results.every(result => result.kind === "fallback")); assert.equal(releases.length, 2);
  loader.dispose();
  for (const release of releases) release({ ...source, close: () => { closed++; } });
  await tick(); assert.equal(closed, 2);
});

test("decoded dimension mismatch closes the resource and selects fallback", async () => {
  let closed = 0;
  const loader = createAssetLoader({ fetch: async () => responseFor(), decode: async () => ({ ...source, width: 1, close: () => { closed++; } }) });
  const result = await loader.preload(first.id);
  assert.equal(result.kind, "fallback"); assert.equal(closed, 1); loader.dispose();
});
