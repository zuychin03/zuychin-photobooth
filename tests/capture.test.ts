import assert from "node:assert/strict";
import { test } from "node:test";
import { blobToCanvas, canvasToJpeg, captureFrame } from "../lib/capture";
import { installCanvasEnvironment, RecordingCanvas, stubGlobal } from "./helpers/recording-canvas";

test("capture keeps native dimensions and unfiltered pixels with optional mirroring", (t) => {
  const env = installCanvasEnvironment(t);
  const video = Object.freeze({
    videoWidth: 1920,
    videoHeight: 1080,
    style: { filter: "grayscale(1)" },
  }) as unknown as HTMLVideoElement;

  for (const mirror of [false, true]) {
    const result = captureFrame(video, mirror);
    const recorded = env.canvases.at(-1)!;
    assert.equal(result, recorded.element);
    assert.deepEqual([result.width, result.height], [1920, 1080]);
    assert.deepEqual(recorded.context.draws, [{
      source: video,
      coordinates: [0, 0, 1920, 1080],
      filter: "none",
      clip: null,
    }]);
    assert.deepEqual(recorded.context.transforms, mirror ? [
      { kind: "translate", values: [1920, 0] },
      { kind: "scale", values: [-1, 1] },
    ] : []);
  }
});

test("JPEG exchange requests the expected format and quality without resizing", async () => {
  const canvas = new RecordingCanvas();
  canvas.width = 1920;
  canvas.height = 1080;
  assert.equal((await canvasToJpeg(canvas.element)).type, "image/jpeg");
  assert.equal((await canvasToJpeg(canvas.element, 0.75)).type, "image/jpeg");
  assert.deepEqual(canvas.encodes, [
    { type: "image/jpeg", quality: 0.92 },
    { type: "image/jpeg", quality: 0.75 },
  ]);
  assert.deepEqual([canvas.width, canvas.height], [1920, 1080]);
});

test("JPEG encoding failure rejects instead of producing an empty frame", async () => {
  const canvas = new RecordingCanvas({ blobResult: null });
  await assert.rejects(canvasToJpeg(canvas.element), /toBlob failed/);
});

test("JPEG encoding propagates synchronous browser failures", async () => {
  const failure = new DOMException("Canvas contains cross-origin data", "SecurityError");
  const canvas = { toBlob() { throw failure; } } as unknown as HTMLCanvasElement;
  await assert.rejects(canvasToJpeg(canvas), (error) => error === failure);
});

test("capture propagates a failed video draw instead of returning an empty frame", (t) => {
  const failure = new DOMException("Video frame unavailable", "InvalidStateError");
  installCanvasEnvironment(t, { drawError: failure });
  const video = { videoWidth: 1280, videoHeight: 720 } as HTMLVideoElement;
  assert.throws(() => captureFrame(video, false), (error) => error === failure);
});

test("decoded bitmap dimensions survive import and the bitmap closes after drawing", async (t) => {
  const env = installCanvasEnvironment(t);
  const blob = new Blob(["image fixture"], { type: "image/jpeg" });
  let closes = 0;
  const bitmap = {
    width: 1170,
    height: 2532,
    close() {
      assert.equal(env.canvases[0].context.draws.length, 1);
      closes++;
    },
  };
  stubGlobal(t, "createImageBitmap", async (input: Blob) => {
    assert.equal(input, blob);
    return bitmap;
  });

  const result = await blobToCanvas(blob);
  assert.deepEqual([result.width, result.height], [1170, 2532]);
  assert.equal(env.canvases[0].context.draws[0].source, bitmap);
  assert.deepEqual(env.canvases[0].context.draws[0].coordinates, [0, 0]);
  assert.equal(closes, 1);
});

test("decode rejection propagates without allocating a destination canvas", async (t) => {
  const env = installCanvasEnvironment(t);
  const failure = new Error("unsupported image");
  stubGlobal(t, "createImageBitmap", async () => { throw failure; });
  await assert.rejects(blobToCanvas(new Blob()), (error) => error === failure);
  assert.equal(env.canvases.length, 0);
});

test("decoded bitmap is released when drawing fails", async (t) => {
  const failure = new Error("drawing failed");
  installCanvasEnvironment(t, { drawError: failure });
  let closes = 0;
  stubGlobal(t, "createImageBitmap", async () => ({
    width: 640,
    height: 480,
    close() { closes++; },
  }));

  await assert.rejects(blobToCanvas(new Blob()), (error) => error === failure);
  assert.equal(closes, 1);
});

test("decoded bitmap is released when no 2D context can be allocated", async (t) => {
  installCanvasEnvironment(t, { missingContext: true });
  let closes = 0;
  stubGlobal(t, "createImageBitmap", async () => ({
    width: 640,
    height: 480,
    close() { closes++; },
  }));

  await assert.rejects(blobToCanvas(new Blob()), /Canvas context unavailable/);
  assert.equal(closes, 1);
});
