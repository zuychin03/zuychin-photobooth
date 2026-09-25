import { createHash } from "node:crypto";
import sharp, { type Sharp } from "sharp";
import { inspectImageHeader, inspectRetainedPngHeader, type ProjectImageInfo } from "../projects/images";
import { RESOURCE_LIMITS } from "../projects/resource-bounds";
import { EVENT_LIMITS } from "../events/contract";

export interface ImageJobOptions { signal?: AbortSignal; timeoutMs?: number }
export interface VerifiedImageInfo extends ProjectImageInfo { bytes: number; sha256: string; decoded: true }
export interface ProjectImageExpectation extends Omit<VerifiedImageInfo, "decoded"> { kind: "photo" | "decoration" | "reference" }
export interface EncodedImage extends VerifiedImageInfo { mime: "image/jpeg"; data: Buffer }
export interface VerifiedProjectOriginal { original: Buffer; verified: VerifiedImageInfo }
export interface FinalisedEventImage { source: VerifiedImageInfo; image: EncodedImage; thumbnail: EncodedImage }
export class ImageFinaliseError extends Error {
  constructor(readonly code: "invalid_image" | "metadata_mismatch" | "image_busy" | "image_timeout" | "image_cancelled" | "output_too_large" | "invalid_options") { super(code); }
}
interface JobContext { check(): void; pipeline(value: Sharp): Sharp }
let occupied = false;

function bounded<T>(options: ImageJobOptions, action: (context: JobContext) => Promise<T>): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 10000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) return Promise.reject(new ImageFinaliseError("invalid_options"));
  if (options.signal?.aborted) return Promise.reject(new ImageFinaliseError("image_cancelled"));
  if (occupied) return Promise.reject(new ImageFinaliseError("image_busy"));
  occupied = true;
  const deadline = Date.now() + timeoutMs;
  let reason: ImageFinaliseError | undefined;
  let rejectStop!: (error: ImageFinaliseError) => void;
  const stopped = new Promise<never>((_, reject) => { rejectStop = reject; });
  const stop = (code: "image_timeout" | "image_cancelled") => { if (!reason) { reason = new ImageFinaliseError(code); rejectStop(reason); } };
  const abort = () => stop("image_cancelled");
  const check = () => { if (options.signal?.aborted) stop("image_cancelled"); if (Date.now() >= deadline) stop("image_timeout"); if (reason) throw reason; };
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => stop("image_timeout"), timeoutMs);
  const task = (async () => {
    try { return await action({ check, pipeline: pipeline => { check(); return pipeline.timeout({ seconds: Math.max(1, Math.ceil((deadline - Date.now()) / 1000)) }); } }); }
    catch (error) { if (reason) throw reason; if (error instanceof ImageFinaliseError) throw error; throw new ImageFinaliseError("invalid_image"); }
    finally { occupied = false; clearTimeout(timer); options.signal?.removeEventListener("abort", abort); }
  })();
  // Native work may outlive the caller. Its slot stays held until that task settles.
  return Promise.race([task, stopped]);
}

const crcTable = Uint32Array.from({ length: 256 }, (_, entry) => {
  let value = entry; for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1; return value >>> 0;
});
function crc(bytes: Buffer, start: number, end: number): number { let value = 0xffffffff; for (let i = start; i < end; i++) value = crcTable[(value ^ bytes[i]) & 255] ^ value >>> 8; return (value ^ 0xffffffff) >>> 0; }
const invalid = (): never => { throw new ImageFinaliseError("invalid_image"); };
function strictPng(bytes: Buffer) {
  let offset = 8, chunks = 0, sawData = false, endedData = false;
  const singleton = new Set<string>();
  while (offset < bytes.length) {
    if (++chunks > 4096 || offset + 12 > bytes.length) invalid();
    const size = bytes.readUInt32BE(offset), type = bytes.toString("ascii", offset + 4, offset + 8), end = offset + 8 + size;
    if (end + 4 > bytes.length || !/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(type) || crc(bytes, offset + 4, end) !== bytes.readUInt32BE(end)) invalid();
    if (type[0] === type[0].toUpperCase() && !["IHDR", "PLTE", "IDAT", "IEND"].includes(type)) invalid();
    if (["IHDR", "PLTE", "IEND", "eXIf"].includes(type)) { if (singleton.has(type)) invalid(); singleton.add(type); }
    if (type === "PLTE" && sawData) invalid();
    if (type === "IDAT") { if (endedData) invalid(); sawData = true; } else if (sawData) endedData = true;
    offset = end + 4;
  }
}
function strictJpeg(bytes: Buffer) {
  let offset = 2, scan = false, scans = 0, segments = 0;
  while (offset < bytes.length) {
    if (scan) { while (offset < bytes.length && bytes[offset] !== 255) offset++; }
    if (bytes[offset++] !== 255) invalid();
    while (bytes[offset] === 255) offset++;
    const marker = bytes[offset++];
    if (scan && (marker === 0 || marker >= 0xd0 && marker <= 0xd7)) continue;
    if (++segments > 4096) invalid();
    if (marker === 0xd9) { if (!scans || offset !== bytes.length) invalid(); return; }
    if (![0xc0, 0xc1, 0xc2, 0xc4, 0xda, 0xdb, 0xdd, 0xfe].includes(marker) && !(marker >= 0xe0 && marker <= 0xef)) invalid();
    if (offset + 2 > bytes.length) invalid();
    const size = bytes.readUInt16BE(offset);
    if (size < 2 || offset + size > bytes.length) invalid();
    if ([0xc0, 0xc1, 0xc2].includes(marker) && (size < 11 || bytes[offset + 2] !== 8 || size !== 8 + 3 * bytes[offset + 7])) invalid();
    if (marker === 0xdd && size !== 4) invalid();
    if (marker === 0xda && (size < 8 || size !== 6 + 2 * bytes[offset + 2])) invalid();
    scan = marker === 0xda; if (scan) scans++;
    offset += size;
  }
  invalid();
}
function strictWebp(bytes: Buffer) {
  let offset = 12, chunks = 0; const seen = new Set<string>();
  while (offset < bytes.length) {
    if (++chunks > 128 || offset + 8 > bytes.length) invalid();
    const type = bytes.toString("ascii", offset, offset + 4), size = bytes.readUInt32LE(offset + 4), start = offset + 8;
    if (!["VP8X", "VP8 ", "VP8L", "ALPH", "ICCP", "EXIF", "XMP "].includes(type) || seen.has(type) || start + size + (size % 2) > bytes.length) invalid();
    if (size % 2 && bytes[start + size] !== 0) invalid();
    if (type === "VP8X" && (size !== 10 || bytes[start] & 0xc3 || bytes[start + 1] || bytes[start + 2] || bytes[start + 3])) invalid();
    if (type === "ALPH" && (seen.has("VP8 ") || seen.has("VP8L"))) invalid();
    seen.add(type); offset = start + size + (size % 2);
  }
  if (seen.has("VP8 ") === seen.has("VP8L") || seen.has("ALPH") && seen.has("VP8L")) invalid();
}
function inspect(bytes: Buffer): ProjectImageInfo {
  let info: ProjectImageInfo; try { info = inspectImageHeader(bytes); } catch { return invalid(); }
  if (info.mime === "image/png") strictPng(bytes); else if (info.mime === "image/jpeg") strictJpeg(bytes); else strictWebp(bytes);
  return info;
}
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function snapshot(input: Uint8Array, maxBytes: number): Buffer {
  if (!(input instanceof Uint8Array) || !input.byteLength || input.byteLength > maxBytes) invalid();
  return Buffer.from(input);
}
async function decode(bytes: Buffer, header: ProjectImageInfo, context: JobContext) {
  context.check();
  const options = { failOn: "warning" as const, limitInputPixels: RESOURCE_LIMITS.photoPixels, unlimited: false, sequentialRead: true, animated: false };
  const reader = context.pipeline(sharp(bytes, options));
  let pixels: Buffer | undefined, delivered = false;
  try {
    const metadata = await reader.metadata(); context.check();
    if (metadata.format !== header.mime.slice(6) || (metadata.pages ?? 1) !== 1 || !metadata.width || !metadata.height || metadata.width > RESOURCE_LIMITS.photoEdge || metadata.height > RESOURCE_LIMITS.photoEdge || metadata.width * metadata.height > RESOURCE_LIMITS.photoPixels) invalid();
    const result = await context.pipeline(reader.rotate().toColourspace("srgb").ensureAlpha().raw({ depth: "uchar" })).toBuffer({ resolveWithObject: true }); pixels = result.data; context.check();
    if (result.info.width !== header.width || result.info.height !== header.height || result.info.channels !== 4 || result.data.length !== header.width * header.height * 4) invalid();
    delivered = true; return result.data;
  } finally { if (!delivered) pixels?.fill(0); reader.destroy(); }
}
export function verifyProjectOriginal(input: Uint8Array, expected: ProjectImageExpectation, options: ImageJobOptions = {}): Promise<VerifiedProjectOriginal> {
  return bounded(options, async context => {
    const original = snapshot(input, RESOURCE_LIMITS.photoBytes), info = inspect(original), sha256 = digest(original);
    if (!["photo", "decoration", "reference"].includes(expected.kind) || expected.mime !== info.mime || expected.bytes !== original.length || expected.width !== info.width || expected.height !== info.height || expected.sha256 !== sha256) throw new ImageFinaliseError("metadata_mismatch");
    if (expected.kind === "decoration" && (info.mime !== "image/png" || original.length > RESOURCE_LIMITS.decorationBytes || info.width > RESOURCE_LIMITS.decorationEdge || info.height > RESOURCE_LIMITS.decorationEdge)) invalid();
    const raw = await decode(original, info, context); raw.fill(0); context.check();
    return { original, verified: { ...info, bytes: original.length, sha256, decoded: true } };
  });
}
export function verifyRetainedStrip(input: Uint8Array, options: ImageJobOptions = {}): Promise<VerifiedProjectOriginal> {
  return bounded(options, async context => {
    const original = snapshot(input, 16 * 1024 * 1024);
    let info: ProjectImageInfo; try { info = inspectRetainedPngHeader(original); } catch { return invalid(); }
    strictPng(original);
    const raw = await decode(original, info, context); raw.fill(0); context.check();
    return { original, verified: { ...info, bytes: original.length, sha256: digest(original), decoded: true } };
  });
}
async function jpeg(raw: Buffer, info: ProjectImageInfo, maxBytes: number, thumbnail: boolean, context: JobContext): Promise<EncodedImage> {
  const settings = thumbnail ? [[400, 78], [320, 65], [240, 55]] : [[4096, 85], [3072, 78], [2048, 72], [1536, 65], [1024, 55]];
  for (const [edge, quality] of settings) {
    context.check();
    const encoder = context.pipeline(sharp(raw, { raw: { width: info.width, height: info.height, channels: 4 }, limitInputPixels: RESOURCE_LIMITS.photoPixels }).flatten({ background: "#ffffff" }).resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true }).jpeg({ quality, chromaSubsampling: "4:2:0", progressive: false }));
    try {
      const output = await encoder.toBuffer({ resolveWithObject: true }); context.check();
      if (output.data.length <= maxBytes) return { data: output.data, bytes: output.data.length, width: output.info.width, height: output.info.height, mime: "image/jpeg", sha256: digest(output.data), decoded: true };
    } finally { encoder.destroy(); }
  }
  throw new ImageFinaliseError("output_too_large");
}
export function finaliseEventImage(input: Uint8Array, options: ImageJobOptions = {}): Promise<FinalisedEventImage> {
  return bounded(options, async context => {
    const original = snapshot(input, EVENT_LIMITS.imageBytes), info = inspect(original);
    const source: VerifiedImageInfo = { ...info, bytes: original.length, sha256: digest(original), decoded: true };
    const raw = await decode(original, info, context);
    try {
      const image = await jpeg(raw, info, EVENT_LIMITS.imageBytes, false, context);
      const thumbnail = await jpeg(raw, info, EVENT_LIMITS.thumbnailBytes, true, context); context.check();
      return { source, image, thumbnail };
    } finally { raw.fill(0); }
  });
}
