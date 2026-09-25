import assert from "node:assert/strict";
import test from "node:test";
import { mediaResourceInventory, rgbaBytes } from "../lib/feasibility/memory-observation";

test("surface budgets distinguish a streamed clip from retaining its raw frames", () => {
  const inventory = mediaResourceInventory();
  assert.equal(inventory.persistentMediaCanvasBytes, 3_686_400);
  assert.equal(inventory.hypothetical24RawFramesBytes, 88_473_600);
  assert.equal(inventory.queuedRawFrameBytes, 0);
  assert.equal(inventory.layoutKnownSurfacePeakBytes, 17_273_840);
  assert.equal(inventory.playbackKnownSurfaceBytes, 7_372_804);
});

test("resource arithmetic rejects invalid dimensions and multiplication overflow", () => {
  for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => rgbaBytes(value, 720), RangeError);
    assert.throws(() => rgbaBytes(1280, value), RangeError);
    assert.throws(() => rgbaBytes(1280, 720, value), RangeError);
  }
  assert.throws(() => rgbaBytes(Number.MAX_SAFE_INTEGER, 720), RangeError);
});
