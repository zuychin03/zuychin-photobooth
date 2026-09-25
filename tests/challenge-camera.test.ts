import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import { createChallengePhotoCapture, ChallengeCameraError, type ChallengeCapturePorts } from "../lib/memories/challenge-camera";
import { inspectImageHeader } from "../lib/projects/images";

const video = { videoWidth: 32, videoHeight: 24, readyState: 2 } as HTMLVideoElement;
const jpeg = sharp({ create: { width: 32, height: 24, channels: 3, background: "#b8677d" } }).jpeg().toBuffer().then(bytes => new Blob([new Uint8Array(bytes)], { type: "image/jpeg" }));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture(overrides: Partial<ChallengeCapturePorts> = {}) {
  const canvases: HTMLCanvasElement[] = [], mirrors: boolean[] = [];
  const capture = createChallengePhotoCapture({
    capture: (_source, mirror) => { const canvas = { width: 32, height: 24 } as HTMLCanvasElement; canvases.push(canvas); mirrors.push(mirror); return canvas; },
    encode: () => jpeg, inspect: inspectImageHeader, ...overrides,
  });
  return { capture, canvases, mirrors };
}
const code = (expected: ChallengeCameraError["code"]) => (error: unknown) => error instanceof ChallengeCameraError && error.code === expected;

test("camera capture preserves sparse source index and mirror with verified JPEG dimensions", async () => {
  const f = fixture(), file = await f.capture(video, true, 3);
  assert.equal(file.name, "challenge-photo-4.jpg"); assert.equal(file.type, "image/jpeg");
  assert.deepEqual(inspectImageHeader(new Uint8Array(await file.arrayBuffer())), { mime: "image/jpeg", width: 32, height: 24 });
  assert.deepEqual(f.mirrors, [true]); assert.equal(f.canvases.length, 1);
  assert.deepEqual([f.canvases[0].width, f.canvases[0].height], [1, 1]);
});

test("camera readiness, dimensions, source slot and cancellation reject before allocating", async () => {
  const f = fixture(), cancelled = AbortSignal.abort();
  await assert.rejects(f.capture(video, false, 0, cancelled), code("cancelled"));
  await assert.rejects(f.capture({ ...video, readyState: 1 } as HTMLVideoElement, false, 0), code("not_ready"));
  await assert.rejects(f.capture({ ...video, videoWidth: 4097 } as HTMLVideoElement, false, 0), code("resource_limit"));
  await assert.rejects(f.capture({ ...video, videoWidth: 4096, videoHeight: 4096 } as HTMLVideoElement, false, 0), code("resource_limit"));
  await assert.rejects(f.capture(video, false, 4), code("resource_limit"));
  assert.equal(f.canvases.length, 0);
});

test("encoder failure releases its canvas and permits a later capture", async () => {
  let calls = 0;
  const f = fixture({ encode: async () => { if (!calls++) throw new Error("native failure"); return jpeg; } });
  await assert.rejects(f.capture(video, false, 0), code("encode_failed"));
  assert.equal(f.canvases[0].width, 1);
  assert.equal((await f.capture(video, false, 2)).name, "challenge-photo-3.jpg");
});

test("abort rejects promptly but retains the single native allocation until the encoder settles", async () => {
  const native = deferred<Blob>(), abort = new AbortController(); let encodes = 0;
  const f = fixture({ encode: () => ++encodes === 1 ? native.promise : jpeg });
  const pending = f.capture(video, false, 0, abort.signal); abort.abort();
  await assert.rejects(pending, code("cancelled"));
  await assert.rejects(f.capture(video, false, 1), code("busy"));
  assert.equal(f.canvases.length, 1); assert.equal(f.canvases[0].width, 32);
  native.resolve(await jpeg); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.canvases[0].width, 1);
  assert.equal((await f.capture(video, false, 1)).name, "challenge-photo-2.jpg");
});

test("timeout cannot accumulate native encoder jobs or accept a late photo", async () => {
  const native = deferred<Blob>(), f = fixture({ encode: () => native.promise, timeoutMs: 5 });
  await assert.rejects(f.capture(video, false, 0), code("timeout"));
  await assert.rejects(f.capture(video, false, 0), code("busy"));
  native.resolve(await jpeg); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.canvases.length, 1); assert.equal(f.canvases[0].height, 1);
});

test("wrong dimensions and invalid JPEG reject without retaining a canvas", async () => {
  const dimensions = fixture({ inspect: () => ({ mime: "image/jpeg", width: 31, height: 24 }) });
  await assert.rejects(dimensions.capture(video, false, 0), code("encode_failed"));
  const invalid = fixture({ encode: async () => new Blob(["not JPEG"], { type: "image/jpeg" }) });
  await assert.rejects(invalid.capture(video, false, 0), code("encode_failed"));
  assert.equal(dimensions.canvases[0].width, 1); assert.equal(invalid.canvases[0].width, 1);
});

test("unexpected MIME and excessive encoded bytes reject before reading the encoded body", async () => {
  let reads = 0;
  const excessive = { type: "image/jpeg", size: 10 * 1024 * 1024 + 1, arrayBuffer: async () => { reads++; return new ArrayBuffer(0); } } as Blob;
  for (const blob of [new Blob(["png"], { type: "image/png" }), excessive]) {
    const f = fixture({ encode: async () => blob });
    await assert.rejects(f.capture(video, false, 0), code("resource_limit"));
    assert.equal(f.canvases[0].width, 1);
  }
  assert.equal(reads, 0);
});

test("abort during byte inspection cannot publish a File", async () => {
  const bytes = deferred<ArrayBuffer>(), abort = new AbortController();
  const f = fixture({ encode: async () => ({ type: "image/jpeg", size: 10, arrayBuffer: () => bytes.promise } as Blob) });
  const pending = f.capture(video, false, 0, abort.signal);
  await Promise.resolve(); abort.abort(); await assert.rejects(pending, code("cancelled"));
  bytes.resolve(new ArrayBuffer(10)); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.canvases[0].width, 1);
});
