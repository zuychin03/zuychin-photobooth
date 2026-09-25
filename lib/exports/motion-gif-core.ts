import { GIFEncoder, applyPalette, quantize } from "gifenc";
import { MOTION_LIMITS } from "./motion-types";

export function createMotionGifEncoder(width: number, height: number, delayMs: number, frameCount: number) {
  if (![width, height].every(value => Number.isInteger(value) && value >= 2 && value <= MOTION_LIMITS.gifEdge)
    || !Number.isInteger(frameCount) || frameCount < 2 || frameCount > MOTION_LIMITS.frames
    || !Number.isFinite(delayMs) || delayMs < 80 || delayMs > 2000 || frameCount * delayMs > MOTION_LIMITS.durationMs) throw new Error("Invalid GIF encoding bounds");
  const encoder = GIFEncoder(), delay = Math.round(delayMs / 10) * 10;
  let written = 0, finished = false;
  return {
    write(rgba: Uint8Array, index: number) {
      if (finished || written >= frameCount || index !== written || rgba.byteLength !== width * height * 4) throw new Error("Unexpected GIF frame sequence or pixels");
      const palette = quantize(rgba, 256, { format: "rgb565" }), indexed = applyPalette(rgba, palette, "rgb565");
      encoder.writeFrame(indexed, width, height, { palette, delay, repeat: 0, dispose: 1 });
      written++;
      if (encoder.bytesView().byteLength > MOTION_LIMITS.bytes) throw new Error("GIF exceeds the 10 MiB output limit");
    },
    finish() {
      if (finished || written !== frameCount) throw new Error("GIF is incomplete");
      encoder.finish(); finished = true;
      if (encoder.bytesView().byteLength > MOTION_LIMITS.bytes) throw new Error("GIF exceeds the 10 MiB output limit");
      return { bytes: encoder.bytes(), durationMs: delay * written };
    },
  };
}
export type GifWorkerRequest = { type: "init"; width: number; height: number; delayMs: number; frameCount: number }
  | { type: "frame"; index: number; pixels: ArrayBuffer } | { type: "finish" };
export type GifWorkerReply = { type: "ready" } | { type: "frame"; index: number }
  | { type: "done"; bytes: ArrayBuffer; durationMs: number } | { type: "error"; message: string };
