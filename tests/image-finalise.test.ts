import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { GIFEncoder } from "gifenc";
import { inspectImageHeader } from "../lib/projects/images";
import { finaliseEventImage, verifyProjectOriginal, type ProjectImageExpectation } from "../lib/server/image-finalise";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const expected = (bytes: Buffer): ProjectImageExpectation => ({ ...inspectImageHeader(bytes), kind: "photo", bytes: bytes.length, sha256: hash(bytes) });
const fixture = () => sharp({ create: { width: 80, height: 40, channels: 4, background: { r: 160, g: 40, b: 20, alpha: 0.5 } } });

test("real JPEG, progressive JPEG, PNG and static WebP decode while original bytes stay identical", async () => {
  for (const bytes of [await fixture().png().toBuffer(), await fixture().jpeg().toBuffer(), await fixture().jpeg({ progressive: true }).toBuffer(), await fixture().webp().toBuffer(), await fixture().webp({ lossless: true }).toBuffer()]) {
    const result = await verifyProjectOriginal(bytes, expected(bytes));
    assert.deepEqual(result.original, bytes); assert.notEqual(result.original, bytes);
    assert.equal(result.verified.sha256, hash(bytes)); assert.equal(result.verified.decoded, true);
  }
});

test("explicit reference originals use actual photo decode without changing their bytes", async () => {
  const bytes = await fixture().png().toBuffer();
  const result = await verifyProjectOriginal(bytes, { ...expected(bytes), kind: "reference" });
  assert.deepEqual(result.original, bytes); assert.equal(result.verified.sha256, hash(bytes));
  const broken = Buffer.from(bytes); broken[broken.length - 5] ^= 1;
  await assert.rejects(verifyProjectOriginal(broken, { ...expected(bytes), kind: "reference", sha256: hash(broken) }));
});

test("EXIF orientation is verified without rewriting originals; derivative pixels are oriented and metadata stripped", async () => {
  const bytes = await fixture().withMetadata({ orientation: 6 }).jpeg().toBuffer();
  const original = await verifyProjectOriginal(bytes, expected(bytes));
  assert.equal(original.verified.width, 40); assert.equal(original.verified.height, 80); assert.deepEqual(original.original, bytes);
  const result = await finaliseEventImage(bytes);
  for (const output of [result.image, result.thumbnail]) {
    const metadata = await sharp(output.data).metadata();
    assert.equal(metadata.format, "jpeg"); assert.equal(metadata.width, 40); assert.equal(metadata.height, 80);
    assert.equal(metadata.exif, undefined); assert.equal(metadata.icc, undefined); assert.equal(metadata.xmp, undefined); assert.equal(metadata.orientation, undefined);
    assert.equal(output.bytes, output.data.length); assert.equal(output.sha256, hash(output.data));
    assert.equal((await sharp(output.data).raw().toBuffer()).length, 40 * 80 * 3);
  }
});

test("transparent event input is deliberately white-matted and real outputs satisfy byte and size budgets", async () => {
  const bytes = await sharp({ create: { width: 1000, height: 500, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
  const result = await finaliseEventImage(bytes);
  assert(result.image.bytes <= 2_000_000); assert(result.thumbnail.bytes <= 100_000);
  assert.equal(result.image.width, 1000); assert.equal(result.image.height, 500);
  assert.equal(result.thumbnail.width, 400); assert.equal(result.thumbnail.height, 200);
  const pixel = await sharp(result.image.data).extract({ left: 10, top: 10, width: 1, height: 1 }).raw().toBuffer();
  assert([...pixel].every(v => v >= 253));
});

test("claimed metadata cannot substitute for verified bytes", async () => {
  const bytes = await fixture().png().toBuffer(), claim = expected(bytes);
  for (const change of [{ width: 81 }, { bytes: bytes.length + 1 }, { mime: "image/jpeg" }, { sha256: "0".repeat(64) }]) await assert.rejects(verifyProjectOriginal(bytes, { ...claim, ...change } as ProjectImageExpectation), /metadata_mismatch/);
  const jpeg = await fixture().jpeg().toBuffer(); await assert.rejects(verifyProjectOriginal(jpeg, { ...expected(jpeg), kind: "decoration" }), /invalid_image/);
});

test("structural parsing rejects CRC corruption, trailing payload, oversized dimensions and animated containers", async () => {
  const png = await fixture().png().toBuffer(), badCrc = Buffer.from(png); badCrc[29] ^= 1;
  const jpeg = await fixture().jpeg().toBuffer(), webp = await fixture().webp().toBuffer(), badRiff = Buffer.from(webp); badRiff.writeUInt32LE(webp.length, 4);
  const gif = GIFEncoder(); for (const index of [0, 1]) gif.writeFrame(new Uint8Array(16).fill(index), 4, 4, { palette: [[255, 0, 0], [0, 0, 255]], delay: 100 }); gif.finish();
  const animated = await sharp(gif.bytes(), { animated: true }).webp().toBuffer(); assert((await sharp(animated, { animated: true }).metadata()).pages! > 1);
  const huge = await sharp({ create: { width: 5000, height: 1, channels: 3, background: "red" } }).png().toBuffer();
  for (const bytes of [badCrc, Buffer.concat([jpeg, Buffer.from("hidden")]), badRiff, animated, huge, Buffer.from("<svg/>"), Buffer.from("https://example.invalid/photo.png")]) await assert.rejects(finaliseEventImage(bytes), /invalid_image/);
});

test("valid headers with missing compressed pixels fail actual native decode", async () => {
  const jpeg = await fixture().jpeg().toBuffer(); const scan = jpeg.indexOf(Buffer.from([255, 218])); assert(scan > 0);
  const truncated = Buffer.concat([jpeg.subarray(0, scan + 2 + jpeg.readUInt16BE(scan + 2)), Buffer.from([255, 217])]);
  assert.equal(inspectImageHeader(truncated).width, 80);
  await assert.rejects(verifyProjectOriginal(truncated, expected(truncated)), /invalid_image/);
  const webp = await fixture().webp({ lossless: true }).toBuffer(), start = webp.indexOf(Buffer.from("VP8L")); assert(start >= 12);
  const broken = Buffer.alloc(26); broken.write("RIFF"); broken.writeUInt32LE(18, 4); broken.write("WEBPVP8L", 8); broken.writeUInt32LE(5, 16); webp.copy(broken, 20, start + 8, start + 13);
  assert.equal(inspectImageHeader(broken).width, 80);
  await assert.rejects(verifyProjectOriginal(broken, expected(broken)), /invalid_image/);
});

test("abort rejects promptly but native slot stays occupied until it settles, then a retry succeeds", async () => {
  const bytes = await fixture().png().toBuffer(), controller = new AbortController();
  const pending = verifyProjectOriginal(bytes, expected(bytes), { signal: controller.signal }); controller.abort();
  await assert.rejects(verifyProjectOriginal(bytes, expected(bytes)), /image_busy/);
  await assert.rejects(pending, /image_cancelled/);
  let retried = false;
  for (let i = 0; i < 100; i++) {
    try { await verifyProjectOriginal(bytes, expected(bytes)); retried = true; break; }
    catch (error) { assert.match(String(error), /image_busy/); await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  assert(retried);
  await assert.rejects(verifyProjectOriginal(bytes, expected(bytes), { signal: controller.signal }), /image_cancelled/);
  await assert.rejects(verifyProjectOriginal(bytes, expected(bytes), { timeoutMs: 0 }), /invalid_options/);
});

test("input snapshot prevents a caller from changing bytes while decode runs", async () => {
  const bytes = await fixture().png().toBuffer(), copy = Buffer.from(bytes), claim = expected(bytes);
  const job = verifyProjectOriginal(bytes, claim); bytes.fill(0);
  assert.deepEqual((await job).original, copy);
});
