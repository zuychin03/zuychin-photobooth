import assert from "node:assert/strict";
import test from "node:test";
import { encodeMotionGif } from "../lib/exports/motion-gif";
import { decodeMotionFrame } from "../lib/exports/motion-frames";
import { ExportJob } from "../lib/exports/still";
import { templatePixel } from "./helpers/template-fixture";
import type { GifWorkerRequest } from "../lib/exports/motion-gif-core";
import { withMotionSlot } from "../lib/exports/motion-types";

function replaceGlobal(key: string, value: unknown) {
  const before = Object.getOwnPropertyDescriptor(globalThis, key);
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  return () => { if (before) Object.defineProperty(globalThis, key, before); else Reflect.deleteProperty(globalThis, key); };
}
test("GIF cancellation terminates worker, releases canvas/bitmaps and never queues later frames", async () => {
  const controller = new AbortController(), messages: GifWorkerRequest[] = [], surfaces: { width: number; height: number }[] = [];
  let closed = 0, decoded = 0, terminated = 0, inFlight = 0, maxInFlight = 0;
  class WorkerStub {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror = null; onmessageerror = null;
    postMessage(message: GifWorkerRequest) {
      messages.push(message); inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      queueMicrotask(() => { inFlight--; this.onmessage?.({ data: message.type === "init" ? { type: "ready" } : { type: "frame", index: message.type === "frame" ? message.index : -1 } }); });
    }
    terminate() { terminated++; }
  }
  const restore = [replaceGlobal("Worker", WorkerStub), replaceGlobal("createImageBitmap", async () => {
    decoded++; return { width: 1, height: 1, close() { closed++; } };
  }), replaceGlobal("document", { createElement: () => {
    const canvas = { width: 0, height: 0, getContext: () => ({ fillRect() {}, drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(16).fill(255) }) }) };
    surfaces.push(canvas); return canvas;
  } })];
  try {
    const frames = [templatePixel(), templatePixel(), templatePixel(), templatePixel()];
    await assert.rejects(encodeMotionGif(frames, { signal: controller.signal, onProgress: () => controller.abort() }), { name: "AbortError" });
    assert.equal(terminated, 1); assert.equal(maxInFlight, 1); assert.equal(decoded, closed);
    assert.deepEqual(messages.map(item => item.type), ["init", "frame"]);
    assert.ok(surfaces.every(item => item.width === 0 && item.height === 0));
    assert.equal(frames.length, 4); assert.ok(frames.every(item => item.size > 0));
  } finally { restore.reverse().forEach(callback => callback()); }
});
test("native decoder is never reached for invalid headers; late successful bitmaps close after timeout", async () => {
  let calls = 0, closed = 0, settle: ((value: ImageBitmap) => void) | undefined;
  const restore = replaceGlobal("createImageBitmap", () => { calls++; return new Promise<ImageBitmap>(resolve => { settle = resolve; }); });
  try {
    await assert.rejects(decodeMotionFrame(new Blob(["not PNG"], { type: "image/png" }), new ExportJob({})), /still JPEG|unsupported|incomplete/i);
    assert.equal(calls, 0);
    await assert.rejects(decodeMotionFrame(templatePixel(), new ExportJob({ timeoutMs: 100 })), /timed out/);
    await assert.rejects(decodeMotionFrame(templatePixel(), new ExportJob({})), /previous motion image/);
    assert.equal(calls, 1);
    settle!({ width: 1, height: 1, close() { closed++; } } as ImageBitmap);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(closed, 1);
  } finally { restore(); }
});
test("overlapping motion operations fail closed, and a completed or failed job releases the slot", async () => {
  let finish: (() => void) | undefined;
  const first = withMotionSlot(() => new Promise<void>(resolve => { finish = resolve; }));
  let ran = false;
  await assert.rejects(withMotionSlot(async () => { ran = true; }), /Another motion operation/);
  assert.equal(ran, false); finish!(); await first;
  await assert.rejects(withMotionSlot(async () => { throw new Error("encoder failed"); }), /encoder failed/);
  assert.equal(await withMotionSlot(async () => "retry succeeded"), "retry succeeded");
});
test("non-responsive GIF worker times out and terminates instead of retaining the job", async () => {
  let terminated = 0;
  class HungWorker { onmessage = null; onerror = null; onmessageerror = null; postMessage() {} terminate() { terminated++; } }
  const restore = [replaceGlobal("Worker", HungWorker), replaceGlobal("createImageBitmap", async () => ({ width: 1, height: 1, close() {} })), replaceGlobal("document", { createElement: () => ({ width: 0, height: 0 }) })];
  try { await assert.rejects(encodeMotionGif([templatePixel(), templatePixel()], { timeoutMs: 100 }), /timed out/); assert.equal(terminated, 1); }
  finally { restore.reverse().forEach(callback => callback()); }
});
