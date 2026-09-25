import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { gpsProbeJpeg, derivativeMetadataBlocks } from "../lib/feasibility/media-acceptance-probe";

test("GPS acceptance fixture is a decodable JPEG with actual latitude and longitude rationals", async () => {
  const original = await sharp({ create: { width: 12, height: 8, channels: 3, background: "white" } }).jpeg().toBuffer();
  const tagged = gpsProbeJpeg(original);
  const metadata = await sharp(tagged).metadata();
  assert.equal(metadata.width, 12); assert.equal(metadata.height, 8);
  assert.ok(metadata.exif);
  const tiff = new DataView(metadata.exif.buffer, metadata.exif.byteOffset + 6, metadata.exif.byteLength - 6);
  assert.equal(tiff.getUint16(10, true), 0x8825);
  const gps = tiff.getUint32(18, true);
  assert.equal(tiff.getUint16(gps, true), 4);
  assert.equal(tiff.getUint32(80, true), 12); assert.equal(tiff.getUint32(84, true), 1);
  assert.equal(tiff.getUint32(104, true), 34); assert.equal(tiff.getUint32(108, true), 1);
  assert.deepEqual(derivativeMetadataBlocks(tagged), ["JPEG-225"]);
  await sharp(tagged).raw().toBuffer();
  assert.deepEqual(derivativeMetadataBlocks(original), []);
  assert.deepEqual(derivativeMetadataBlocks(new Uint8Array(await sharp(tagged).png().toBuffer())), []);
});
