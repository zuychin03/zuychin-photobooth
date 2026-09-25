import assert from "node:assert/strict";
import test from "node:test";
import { LiveScenePainter } from "../lib/live-preview";
import { getScene } from "../lib/scenes";
import { SCENE_ASSETS, getAssetCrop } from "../lib/assets/registry";
import type { ReadyAsset } from "../lib/assets/loader";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Painter did not reach its expected frame")), 3000); })]); }
  finally { clearTimeout(timer!); }
}
function canvas(draw: (...args: unknown[]) => void = () => {}) {
  const context = new Proxy({}, { get: (_target, key) => key === "drawImage" ? draw : () => {} }) as CanvasRenderingContext2D;
  return { width: 1, height: 1, getContext: () => context } as unknown as HTMLCanvasElement;
}
const video = { videoWidth: 640, videoHeight: 480 } as HTMLVideoElement;

test("live scene painter draws the verified selected image with focal crop and releases its work canvases", async () => {
  const calls: unknown[][] = [], painted = deferred<void>(), work: HTMLCanvasElement[] = [];
  const target = canvas((...args) => { calls.push(args); if (calls.length >= 2) painted.resolve(); });
  const asset = SCENE_ASSETS[0], image = {} as CanvasImageSource;
  let releases = 0, procedural = 0;
  const resource: ReadyAsset = { kind: "ready", asset, image, width: asset.full.width, height: asset.full.height, release: () => { releases++; } };
  const scene = { ...getScene(asset.id)!, draw: () => { procedural++; } };
  const painter = new LiveScenePainter(video, target, true, { createCanvas: () => { const next = canvas(); work.push(next); return next; }, segment: async () => {} });
  try {
    painter.start(scene, resource); await bounded(painted.promise);
    const crop = getAssetCrop(asset, 480, 360);
    assert.deepEqual(calls[0], [image, crop.x, crop.y, crop.width, crop.height, 0, 0, 480, 360]);
    assert.equal(procedural, 0);
  } finally { painter.stop(); }
  assert(work.every(item => item.width === 0 && item.height === 0));
  assert.equal(releases, 0, "the hook owns the borrowed ready resource");
});

test("a wrong-scene resource is ignored and the declared procedural fallback still paints", async () => {
  const painted = deferred<void>(), asset = SCENE_ASSETS[0]; let procedural = 0;
  const scene = { ...getScene(asset.id)!, draw: () => { procedural++; } };
  const resource: ReadyAsset = { kind: "ready", asset: SCENE_ASSETS[1], image: {} as CanvasImageSource, width: 1536, height: 1024, release() {} };
  const painter = new LiveScenePainter(video, canvas(() => painted.resolve()), false, { createCanvas: () => canvas(), segment: async () => {} });
  try { painter.start(scene, resource); await bounded(painted.promise); assert.equal(procedural, 1); }
  finally { painter.stop(); }
});

test("a segmentation result arriving after stop cannot repaint or retain work canvases", async () => {
  const started = deferred<void>(), finish = deferred<void>(), work: HTMLCanvasElement[] = [];
  let paints = 0;
  const painter = new LiveScenePainter(video, canvas(() => { paints++; }), false, {
    createCanvas: () => { const next = canvas(); work.push(next); return next; },
    segment: async (_video, _timestamp, mask) => { started.resolve(); await finish.promise; mask.width = 256; mask.height = 256; },
  });
  try {
    painter.start(getScene(SCENE_ASSETS[0].id)!); await bounded(started.promise); painter.stop(); finish.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(paints, 0); assert(work.every(item => item.width === 0 && item.height === 0));
  } finally { finish.resolve(); painter.stop(); }
});
