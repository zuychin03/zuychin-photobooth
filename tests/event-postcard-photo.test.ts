import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { createPostcardPhotoEncoder, POSTCARD_PHOTO_LIMITS, type PostcardPhotoPorts } from "../lib/events/postcard-photo";
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function fixture() {
  const png = new Blob([new Uint8Array(await sharp({ create: { width: 120, height: 360, channels: 4, background: "#c48496" } }).png().toBuffer())], { type: "image/png" });
  const jpeg = new Blob([new Uint8Array(await sharp(await png.arrayBuffer()).jpeg().toBuffer())], { type: "image/jpeg" });
  let closed = 0; const draws: unknown[][] = [], bitmap = { width: 120, height: 360, close() { closed++; } } as ImageBitmap;
  const canvas = { width: 0, height: 0, getContext: () => ({ fillStyle: "", fillRect() {}, drawImage(...args: unknown[]) { draws.push(args); } }) } as unknown as HTMLCanvasElement;
  const ports: PostcardPhotoPorts = { decode: async () => bitmap, canvas: () => canvas, encode: async () => jpeg };
  return { png, jpeg, bitmap, canvas, ports, draws, closed: () => closed };
}
test("finished-strip encoder preserves full dimensions and verifies JPEG bytes without recomposition", async () => {
  const f = await fixture(), encoded = await createPostcardPhotoEncoder(f.ports)(f.png);
  assert.equal(encoded.width, 120); assert.equal(encoded.height, 360); assert.equal(encoded.bytes, f.jpeg.size); assert.match(encoded.sha256, /^[a-f0-9]{64}$/); assert.deepEqual(f.draws[0], [f.bitmap, 0, 0, 120, 360]); assert.equal(f.closed(), 1); assert.equal(f.canvas.width, 0);
});
test("bounded quality retries refuse oversized output and invalid native dimensions", async () => {
  const f = await fixture(); let attempts = 0; const large = new Blob([new Uint8Array(POSTCARD_PHOTO_LIMITS.outputBytes + 1)], { type: "image/jpeg" });
  await assert.rejects(createPostcardPhotoEncoder({ ...f.ports, encode: async () => { attempts++; return large; } })(f.png), /postcard_jpeg_too_large/); assert.equal(attempts, 7); assert.equal(f.canvas.height, 0);
  await assert.rejects(createPostcardPhotoEncoder({ ...f.ports, decode: async () => ({ ...f.bitmap, width: 119 }) })(f.png), /dimensions_mismatch/);
  await assert.rejects(createPostcardPhotoEncoder(f.ports)(new Blob([new Uint8Array(POSTCARD_PHOTO_LIMITS.inputBytes + 1)])), /input_too_large/);
});
test("rendered PNG headers accept over 10 MiB while JPEG input retains its 10 MiB cap", async () => {
  const f = await fixture(), png = new Uint8Array(await f.png.arrayBuffer()), chunk = new Uint8Array(11 * 1024 * 1024 + 12);
  new DataView(chunk.buffer).setUint32(0, chunk.length - 12); chunk.set([116, 69, 88, 116], 4);
  const expanded = new Blob([png.slice(0, -12), chunk, png.slice(-12)], { type: "image/png" });
  const result = await createPostcardPhotoEncoder(f.ports)(expanded); assert.equal(result.height, 360);
  await assert.rejects(createPostcardPhotoEncoder(f.ports)(new Blob([await f.jpeg.arrayBuffer(), new Uint8Array(11 * 1024 * 1024)], { type: "image/jpeg" })), /10 MiB/);
});
test("noncooperative decode keeps the global slot until late bitmap cleanup", async () => {
  const f = await fixture(); let resolve!: (value: ImageBitmap) => void;
  const encode = createPostcardPhotoEncoder({ ...f.ports, decode: () => new Promise(done => { resolve = done; }) });
  await assert.rejects(encode(f.png, { timeoutMs: 15 }), /timed out/); await assert.rejects(createPostcardPhotoEncoder(f.ports)(f.png), /photo_busy/); resolve(f.bitmap); await tick(); assert.equal(f.closed(), 1); assert.equal(f.draws.length, 0); await createPostcardPhotoEncoder(f.ports)(f.png);
});
test("abort during native encoding holds canvas until late callback and never returns stale output", async () => {
  const f = await fixture(), abort = new AbortController(); let resolve!: (value: Blob) => void, entered!: () => void; const ready = new Promise<void>(done => { entered = done; });
  const encode = createPostcardPhotoEncoder({ ...f.ports, encode: () => { entered(); return new Promise(done => { resolve = done; }); } });
  const pending = encode(f.png, { signal: abort.signal }); await ready; abort.abort(); await assert.rejects(pending, /cancelled/); assert.equal(f.canvas.width, 120); await assert.rejects(createPostcardPhotoEncoder(f.ports)(f.png), /photo_busy/); resolve(f.jpeg); await tick(); assert.equal(f.canvas.width, 0); await createPostcardPhotoEncoder(f.ports)(f.png);
});
