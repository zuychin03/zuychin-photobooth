import assert from "node:assert/strict";
import test from "node:test";
import { collectMotionFrames } from "../lib/exports/motion-capture";
import { createMotionGifEncoder } from "../lib/exports/motion-gif-core";
import { MOTION_LIMITS, motionSequence, motionSize, validateMotionBlobs } from "../lib/exports/motion-types";
import { motionFrameEmitter, sustainMotionFrame } from "../lib/exports/motion-frames";

function readGif(bytes: Uint8Array) {
  let offset = 13, delay = 0;
  const u16 = (start: number) => bytes[start] | bytes[start + 1] << 8;
  assert.equal(new TextDecoder().decode(bytes.subarray(0, 6)), "GIF89a");
  const width = u16(6), height = u16(8), frames: { delay: number; pixels: number[][] }[] = [];
  const table = (packed: number) => {
    const size = 3 * (1 << ((packed & 7) + 1)), palette = Array.from({ length: size / 3 }, (_, i) => Array.from(bytes.subarray(offset + i * 3, offset + i * 3 + 3)));
    offset += size; return palette;
  };
  const global = bytes[10] & 128 ? table(bytes[10]) : [];
  const blocks = () => {
    const data: number[] = [];
    while (bytes[offset]) { const count = bytes[offset++]; data.push(...bytes.subarray(offset, offset + count)); offset += count; }
    offset++; return data;
  };
  while (bytes[offset] !== 0x3b) {
    const marker = bytes[offset++];
    if (marker === 0x21) {
      const kind = bytes[offset++];
      if (kind === 0xf9) { assert.equal(bytes[offset], 4); delay = u16(offset + 2) * 10; offset += 6; }
      else blocks();
    } else {
      assert.equal(marker, 0x2c);
      assert.equal(u16(offset + 4), width); assert.equal(u16(offset + 6), height);
      const packed = bytes[offset + 8]; offset += 9;
      const palette = packed & 128 ? table(packed) : global;
      const minimum = bytes[offset++], compressed = blocks(), clear = 1 << minimum, end = clear + 1;
      let dictionary: number[][] = [], codeSize = minimum + 1, bit = 0, previous: number[] | undefined;
      const indices: number[] = [];
      while (bit < compressed.length * 8) {
        let code = 0;
        for (let i = 0; i < codeSize; i++, bit++) code |= ((compressed[bit >> 3] >> (bit & 7)) & 1) << i;
        if (code === clear) { dictionary = Array.from({ length: end + 1 }, (_, value) => [value]); codeSize = minimum + 1; previous = undefined; continue; }
        if (code === end) break;
        const entry = dictionary[code] ?? (previous ? [...previous, previous[0]] : undefined);
        assert.ok(entry); indices.push(...entry);
        if (previous) { dictionary.push([...previous, entry[0]]); if (dictionary.length === 1 << codeSize && codeSize < 12) codeSize++; }
        previous = entry;
      }
      assert.equal(indices.length, width * height);
      frames.push({ delay, pixels: indices.map(value => palette[value]) });
    }
  }
  assert.equal(offset, bytes.length - 1);
  return { width, height, frames };
}
test("real GIF encoder emits complete, LZW-decodable frames with ordered local palettes and delays", () => {
  const encoder = createMotionGifEncoder(8, 8, 1000 / 12, 4);
  const colours = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]];
  for (let index = 0; index < 4; index++) {
    const rgba = new Uint8Array(8 * 8 * 4);
    for (let pixel = 0; pixel < 64; pixel++) rgba.set([...colours[index], 255], pixel * 4);
    encoder.write(rgba, index);
  }
  const encoded = encoder.finish(), parsed = readGif(encoded.bytes);
  assert.equal(parsed.frames.length, 4); assert.equal(encoded.durationMs, 320);
  for (let i = 0; i < 4; i++) {
    assert.equal(parsed.frames[i].delay, 80);
    for (const pixel of parsed.frames[i].pixels) assert.deepEqual(pixel, colours[i]);
  }
  assert.throws(() => encoder.finish(), /incomplete/);
});
test("GIF rejects duplicate/out-of-order/incomplete frames and oversized frame surfaces", () => {
  assert.throws(() => createMotionGifEncoder(641, 360, 100, 4), /bounds/);
  const encoder = createMotionGifEncoder(2, 2, 100, 2);
  assert.throws(() => encoder.write(new Uint8Array(16), 1), /sequence/);
  assert.throws(() => encoder.write(new Uint8Array(15), 0), /pixels/);
  encoder.write(new Uint8Array(16).fill(255), 0);
  assert.throws(() => encoder.write(new Uint8Array(16), 0), /sequence/);
  assert.throws(() => encoder.finish(), /incomplete/);
});
test("motion planner bounds frame count, source bytes and boomerang without duplicate turnaround frames", () => {
  assert.deepEqual(motionSequence(4, { boomerang: true }).order, [0, 1, 2, 3, 2, 1]);
  assert.equal(motionSequence(24, { fps: 12, boomerang: true }).order.length, 46);
  assert.throws(() => motionSequence(26, { fps: 12, boomerang: true }), /48/);
  assert.throws(() => motionSequence(48, { delayMs: 500 }), /8 seconds/);
  assert.throws(() => motionSequence(4, { fps: 24 }), /12 fps/);
  assert.throws(() => motionSequence(4, { fps: 4, delayMs: 250 }), /either/);
  assert.throws(() => validateMotionBlobs([new Blob([new Uint8Array(MOTION_LIMITS.bytes)], { type: "image/png" }), new Blob(["1"], { type: "image/png" })]), /10 MiB/);
  assert.throws(() => validateMotionBlobs([new Blob(["svg"], { type: "image/svg+xml" }), new Blob(["x"], { type: "image/png" })]), /PNG or JPEG/);
  const portrait = motionSize(536, 1522, 640, 640);
  assert.ok(portrait.width < portrait.height); assert.equal(portrait.height, 640);
  assert.deepEqual(motionSize(1920, 1080, 1280, 720), { width: 1280, height: 720 });
});
test("capture scheduler keeps at most24 encoded JPEGs, reports actual elapsed, and does not catch up after a slow frame", async () => {
  let now = 0; const starts: number[] = [];
  const result = await collectMotionFrames({ now: () => now, check() {}, pause: async ms => { now += ms; }, capture: async () => {
    starts.push(now); now += starts.length === 2 ? 220 : 5; return new Blob(["jpeg"], { type: "image/jpeg" });
  } }, 2000, 12);
  assert.ok(result.frames.length < 24 && result.frames.length > 2);
  assert.ok(starts[2] - starts[1] >= 220 + 1000 / 12 - 1e-6);
  assert.equal(result.elapsedMs, now);
  assert.ok(starts.every(value => value < 2000));
});
test("capture cancellation and byte exhaustion propagate without claiming a completed loop", async () => {
  let now = 0, calls = 0;
  await assert.rejects(collectMotionFrames({ now: () => now, check() { if (calls === 2) throw new DOMException("Cancelled", "AbortError"); }, pause: async ms => { now += ms; }, capture: async () => { calls++; return new Blob(["x"], { type: "image/jpeg" }); } }, 2000, 12), { name: "AbortError" });
  now = 0;
  await assert.rejects(collectMotionFrames({ now: () => now, check() {}, pause: async ms => { now += ms; }, capture: async () => new Blob([new Uint8Array(6 * 1024 * 1024)], { type: "image/jpeg" }) }, 2000, 12), /10 MiB/);
});
test("recording sustains a held frame at no more than12 emissions per second, including the final hold", async () => {
  let now = 0; const emissions: number[] = [];
  const ports = { now: () => now, pause: async (ms: number) => { now += ms; }, emit: () => { emissions.push(now); }, check() {} };
  for (let frame = 0; frame < 4; frame++) await sustainMotionFrame(500, ports);
  assert.ok(now >= 2000 && now < 2001);
  assert.ok(emissions.length >= 20 && emissions.length <= 24);
  assert.ok(emissions.at(-1)! >= 1900);
  assert.ok(emissions.every((time, index) => index === 0 || time - emissions[index - 1] >= 1000 / 12 - .5));
  const controller = new AbortController();
  await assert.rejects(sustainMotionFrame(500, { ...ports, pause: async ms => { now += ms; controller.abort(); }, check() { if (controller.signal.aborted) throw new DOMException("Cancelled", "AbortError"); } }), { name: "AbortError" });
});
test("manual canvas-frame requests stay globally bounded across hold and source changes", () => {
  let now = 0; const emitted: number[] = [], emit = motionFrameEmitter(() => now, () => emitted.push(now));
  for (const time of [0, 0, 10, 83, 84, 90, 168, 169, 170, 250, 252, 336]) { now = time; emit(); }
  assert.deepEqual(emitted, [0, 84, 168, 252, 336]);
});
