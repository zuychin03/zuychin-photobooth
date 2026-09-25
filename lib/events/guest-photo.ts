import { inspectImageHeader } from "../projects/images";
import { composeStrip } from "../compose";
import { stripSize, type StripLayout } from "../layouts";
import { FRAMES } from "../decor";
import type { EventGuestContext } from "./host-contract";
import { EVENT_LIMITS } from "./contract";

let occupied = false;
export async function prepareEventGuestPhoto(blob: Blob, context: EventGuestContext, signal?: AbortSignal, capturedAt: string | null = null): Promise<{ blob: Blob; width: number; height: number; warning: string | null }> {
  if (occupied) throw new Error("Photo processing is busy"); if (blob.size > 10 * 1024 * 1024 || blob.size < 1) throw new Error("Choose a still photo no larger than 10 MiB"); occupied = true;
  let source: HTMLCanvasElement | undefined, output: HTMLCanvasElement | undefined, bitmap: ImageBitmap | undefined, expired = false;
  const deadline = new AbortController(), timer = setTimeout(() => { expired = true; deadline.abort(); }, 15000), active = AbortSignal.any([deadline.signal, ...(signal ? [signal] : [])]);
  const check = () => { if (active.aborted) throw new DOMException("Photo preparation cancelled or timed out", "AbortError"); };
  const work = (async () => {
    try {
      check(); const bytes = new Uint8Array(await blob.arrayBuffer()); check(); const info = inspectImageHeader(bytes);
      bitmap = await createImageBitmap(blob.slice(0, blob.size, info.mime), { imageOrientation: "from-image" }); check(); if (bitmap.width !== info.width || bitmap.height !== info.height) throw new Error("Photo dimensions could not be verified");
      source = document.createElement("canvas"); source.width = bitmap.width; source.height = bitmap.height; const ctx = source.getContext("2d"); if (!ctx) throw new Error("Canvas unavailable"); ctx.drawImage(bitmap, 0, 0); bitmap.close(); bitmap = undefined;
      const layout: StripLayout = { id: "event-photo", name: "Event photo", mode: "solo", cols: 1, rows: 1, cellAspect: Math.max(.5, Math.min(2, source.width / source.height)), shots: 1 }, frame = FRAMES.find(f => f.id === context.look.frameId)!;
      output = document.createElement("canvas"); const size = stripSize(layout), scale = Math.min(2, 1600 / Math.max(size.width, size.height));
      composeStrip(output, { layout, shots: { A: [source] }, style: { frameColor: frame.color, inkColor: frame.ink, patternId: "none", filterId: context.look.filterId, caption: context.look.caption, showDate: context.look.showDate && capturedAt !== null, stickerStyle: "flat" }, stickers: [], capturedAt, captureTimeZone: context.timezone }, scale); check();
      let encoded: Blob | null = null; for (const quality of [.9, .78, .65]) { encoded = await new Promise<Blob>((resolve, reject) => output!.toBlob(value => value ? resolve(value) : reject(new Error("Photo encoding failed")), "image/jpeg", quality)); check(); if (encoded.size <= EVENT_LIMITS.imageBytes) break; }
      if (!encoded || encoded.type !== "image/jpeg" || encoded.size > EVENT_LIMITS.imageBytes) throw new Error("The finished photo is too large for this event");
      return { blob: encoded, width: output.width, height: output.height, warning: context.look.sceneId ? "The host's frame, filter and caption are applied. This photo keeps its original background; scene replacement is not available in this flow yet." : context.look.showDate && !capturedAt ? "The date is omitted because this imported photo has no verified capture time." : null };
    } finally { bitmap?.close(); if (source) source.width = source.height = 0; if (output) output.width = output.height = 0; occupied = false; }
  })();
  let abort: (() => void) | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { abort = () => reject(new DOMException(expired ? "Photo preparation timed out" : "Photo preparation cancelled", "AbortError")); active.addEventListener("abort", abort, { once: true }); if (active.aborted) abort(); })]); }
  finally { clearTimeout(timer); if (abort) active.removeEventListener("abort", abort); }
}
