import assert from "node:assert/strict";
import { test } from "node:test";
import { insertProbeJpegOrientation } from "../lib/feasibility/project-render-probe";
import { inspectImageHeader } from "../lib/projects/images";

function headerFixture() {
  return new Uint8Array([255, 216, 255, 192, 0, 8, 8, 0, 80, 0, 120, 1, 255, 218, 0, 2, 255, 217]);
}

test("probe EXIF segment has valid TIFF orientation metadata without rewriting JPEG payload", () => {
  const source = headerFixture(), copy = source.slice();
  const oriented = insertProbeJpegOrientation(source);
  assert.deepEqual(source, copy);
  assert.deepEqual(oriented.subarray(0, 2), source.subarray(0, 2));
  assert.deepEqual(oriented.subarray(38), source.subarray(2));
  assert.equal(new DataView(oriented.buffer).getUint16(4), 34);
  assert.deepEqual(inspectImageHeader(oriented), { mime: "image/jpeg", width: 80, height: 120 });
  assert.deepEqual(inspectImageHeader(insertProbeJpegOrientation(source, 1)), { mime: "image/jpeg", width: 120, height: 80 });
});

test("probe injector rejects malformed sources and unsupported orientation fixtures", () => {
  assert.throws(() => insertProbeJpegOrientation(new Uint8Array()), /complete synthetic JPEG/);
  assert.throws(() => insertProbeJpegOrientation(headerFixture().slice(0, -1)), /complete synthetic JPEG/);
  assert.throws(() => insertProbeJpegOrientation(headerFixture(), 9 as 6), /Unsupported probe orientation/);
});
