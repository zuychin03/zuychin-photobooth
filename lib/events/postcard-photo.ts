import { inspectImageHeader, inspectRetainedPngHeader } from "../projects/images";

export const POSTCARD_PHOTO_LIMITS = Object.freeze({ inputBytes: 16 * 1024 * 1024, jpegInputBytes: 10 * 1024 * 1024, outputBytes: 2000000, edge: 4096, pixels: 12000000, timeoutMs: 15000 });
export interface PostcardPhoto { blob: Blob; mime: "image/jpeg"; width: number; height: number; bytes: number; sha256: string }
export interface PostcardPhotoPorts {
  decode(blob: Blob): Promise<ImageBitmap>;
  canvas(): HTMLCanvasElement;
  encode(canvas: HTMLCanvasElement, quality: number): Promise<Blob>;
}
const native: PostcardPhotoPorts = {
  decode: blob => createImageBitmap(blob, { imageOrientation: "from-image" }),
  canvas: () => document.createElement("canvas"),
  encode: (canvas, quality) => new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("postcard_encode_failed")), "image/jpeg", quality)),
};
let occupied = false;
export function createPostcardPhotoEncoder(ports: PostcardPhotoPorts = native) {
  return async (input: Blob, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<PostcardPhoto> => {
    const timeoutMs = options.timeoutMs ?? POSTCARD_PHOTO_LIMITS.timeoutMs;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > POSTCARD_PHOTO_LIMITS.timeoutMs) throw new Error("invalid_postcard_deadline");
    if (options.signal?.aborted) throw new DOMException("Postcard cancelled", "AbortError");
    if (occupied) throw new Error("postcard_photo_busy");
    if (!(input instanceof Blob) || input.size < 1 || input.size > POSTCARD_PHOTO_LIMITS.inputBytes) throw new Error("postcard_input_too_large");
    occupied = true;
    const deadline = new AbortController(), active = AbortSignal.any([deadline.signal, ...(options.signal ? [options.signal] : [])]), timer = setTimeout(() => deadline.abort(), timeoutMs);
    let bitmap: ImageBitmap | undefined, canvas: HTMLCanvasElement | undefined, listener: (() => void) | undefined;
    const check = () => { if (active.aborted) throw new DOMException(deadline.signal.aborted ? "Postcard preparation timed out" : "Postcard cancelled", "AbortError"); };
    const work = (async () => {
      try {
        check(); const inputBytes = new Uint8Array(await input.arrayBuffer()); check();
        const png = inputBytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => inputBytes[index] === byte);
        const header = png ? inspectRetainedPngHeader(inputBytes) : inspectImageHeader(inputBytes); check();
        if (header.mime !== "image/png" && header.mime !== "image/jpeg") throw new Error("postcard_format_unsupported");
        bitmap = await ports.decode(input.slice(0, input.size, header.mime)); check();
        if (bitmap.width !== header.width || bitmap.height !== header.height) throw new Error("postcard_dimensions_mismatch");
        canvas = ports.canvas(); canvas.width = header.width; canvas.height = header.height;
        const context = canvas.getContext("2d"); if (!context) throw new Error("postcard_canvas_unavailable");
        context.fillStyle = "#ffffff"; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close(); bitmap = undefined;
        for (const quality of [.92, .82, .72, .62, .52, .42, .32]) {
          check(); const encoded = await ports.encode(canvas, quality); check();
          if (!(encoded instanceof Blob) || encoded.type !== "image/jpeg" || encoded.size < 1) throw new Error("postcard_encode_failed");
          if (encoded.size > POSTCARD_PHOTO_LIMITS.outputBytes) continue;
          const bytes = new Uint8Array(await encoded.arrayBuffer()); check(); const verified = inspectImageHeader(bytes);
          if (verified.mime !== "image/jpeg" || verified.width !== header.width || verified.height !== header.height) throw new Error("postcard_dimensions_mismatch");
          const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(value => value.toString(16).padStart(2, "0")).join(""); check();
          return { blob: encoded, mime: "image/jpeg" as const, width: header.width, height: header.height, bytes: encoded.size, sha256 };
        }
        throw new Error("postcard_jpeg_too_large");
      } finally { bitmap?.close(); if (canvas) canvas.width = canvas.height = 0; occupied = false; }
    })();
    try { return await Promise.race([work, new Promise<never>((_, reject) => { listener = () => { try { check(); } catch (error) { reject(error); } }; active.addEventListener("abort", listener, { once: true }); if (active.aborted) listener(); })]); }
    finally { clearTimeout(timer); if (listener) active.removeEventListener("abort", listener); }
  };
}
export const prepareEventPostcardPhoto = createPostcardPhotoEncoder();
