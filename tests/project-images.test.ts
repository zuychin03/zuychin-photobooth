import assert from "node:assert/strict";
import test from "node:test";
import { inspectImageHeader, inspectProjectImage, projectImageToCanvas } from "../lib/projects/images";
import { installCanvasEnvironment, stubGlobal } from "./helpers/recording-canvas";

function chunk(name: string, body: Uint8Array) {
  const result = new Uint8Array(body.length + 12);
  new DataView(result.buffer).setUint32(0, body.length);
  result.set(new TextEncoder().encode(name), 4); result.set(body, 8);
  return result;
}
function png(width = 600, height = 400, animated = false) {
  const header = new Uint8Array(13); const view = new DataView(header.buffer);
  view.setUint32(0, width); view.setUint32(4, height); header[8] = 8; header[9] = 2;
  return new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, ...chunk("IHDR", header), ...(animated ? chunk("acTL", new Uint8Array(8)) : []), ...chunk("IDAT", new Uint8Array([1])), ...chunk("IEND", new Uint8Array())]);
}
function jpeg(orientation = 1) {
  const exif = new Uint8Array(32); exif.set(new TextEncoder().encode("Exif\0\0II"));
  const view = new DataView(exif.buffer, 6); view.setUint16(2, 42, true); view.setUint32(4, 8, true); view.setUint16(8, 1, true);
  view.setUint16(10, 0x112, true); view.setUint16(12, 3, true); view.setUint32(14, 1, true); view.setUint16(18, orientation, true);
  return new Uint8Array([255, 216, 255, 225, 0, 34, ...exif, 255, 192, 0, 8, 8, 1, 144, 2, 88, 1, 255, 218, 0, 2, 255, 217]);
}
function webp(width = 600, height = 400, animated = false) {
  const result = new Uint8Array(animated ? 48 : 30); const view = new DataView(result.buffer);
  result.set(new TextEncoder().encode("RIFF")); view.setUint32(4, result.length - 8, true); result.set(new TextEncoder().encode("WEBP"), 8);
  let offset = 12;
  if (animated) {
    result.set(new TextEncoder().encode("VP8X"), offset); view.setUint32(offset + 4, 10, true); result[offset + 8] = 2;
    offset += 18;
  }
  result.set(new TextEncoder().encode("VP8 "), offset); view.setUint32(offset + 4, 10, true);
  result.set([0x9d, 1, 0x2a], offset + 11); view.setUint16(offset + 14, width, true); view.setUint16(offset + 16, height, true);
  return result;
}

test("headers identify supported still formats without trusting the filename or MIME", () => {
  for (const [bytes, mime] of [[png(), "image/png"], [jpeg(), "image/jpeg"], [webp(), "image/webp"]] as const) {
    assert.deepEqual(inspectImageHeader(bytes), { mime, width: 600, height: 400 });
  }
  assert.throws(() => inspectImageHeader(new TextEncoder().encode('<svg width="600" height="400"/>')), /still JPEG/);
});

test("orientation is included in dimensions before decoding", () => {
  for (const orientation of [1, 2, 3, 4]) assert.deepEqual(inspectImageHeader(jpeg(orientation)), { mime: "image/jpeg", width: 600, height: 400 });
  for (const orientation of [5, 6, 7, 8]) assert.deepEqual(inspectImageHeader(jpeg(orientation)), { mime: "image/jpeg", width: 400, height: 600 });
  assert.throws(() => inspectImageHeader(jpeg(9)), /unsupported/);
});

test("oversized declared dimensions, animation and truncated chunks are rejected before decoding", () => {
  for (const bytes of [png(4097, 1), png(4096, 4096), png(1, 0), webp(8000, 100), png(600, 400, true), webp(600, 400, true), png().slice(0, -1), jpeg().slice(0, -1), webp().slice(0, -1)]) {
    assert.throws(() => inspectImageHeader(bytes));
  }
  const corrupt = png(); new DataView(corrupt.buffer).setUint32(33, 0xffffffff);
  assert.throws(() => inspectImageHeader(corrupt));
});

test("byte budget and unsupported signatures reject before the native decoder", async t => {
  let decodes = 0; stubGlobal(t, "createImageBitmap", () => { decodes++; throw new Error("must not decode"); });
  await assert.rejects(inspectProjectImage(new Blob([new Uint8Array(10 * 1024 * 1024 + 1)])), /10 MiB/);
  await assert.rejects(inspectProjectImage(new Blob([png(5000, 1)])), /4096/);
  await assert.rejects(inspectProjectImage(new Blob(["not a photo"], { type: "image/png" })), /still JPEG/);
  assert.equal(decodes, 0);
});

test("actual decoding applies orientation, checks dimensions and always releases the bitmap", async t => {
  let closed = 0;
  stubGlobal(t, "createImageBitmap", async (blob: Blob, options: ImageBitmapOptions) => {
    assert.equal(blob.type, "image/jpeg"); assert.equal(options.imageOrientation, "from-image");
    return { width: 400, height: 600, close: () => { closed++; } };
  });
  const blob = new Blob([jpeg(6)], { type: "application/octet-stream" });
  assert.deepEqual(await inspectProjectImage(blob), { mime: "image/jpeg", width: 400, height: 600 });
  assert.equal(closed, 1);
  await assert.rejects(inspectProjectImage(new Blob([jpeg(1)])), /dimensions/);
  assert.equal(closed, 2);
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), jpeg(6));
});

test("canvas loading preserves the original bytes and closes decoded resources after draw failure", async t => {
  installCanvasEnvironment(t, { drawError: new Error("fixture draw failure") });
  let closed = 0;
  stubGlobal(t, "createImageBitmap", async () => ({ width: 600, height: 400, close: () => { closed++; } }));
  await assert.rejects(projectImageToCanvas(new Blob([png()])), /fixture draw failure/);
  assert.equal(closed, 1);
  await assert.rejects(projectImageToCanvas(new Blob([png()]), { mime: "image/png", width: 400, height: 600 }), /original photo/);
  assert.equal(closed, 1);
});
