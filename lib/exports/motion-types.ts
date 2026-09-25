export const MOTION_LIMITS = Object.freeze({ frames: 48, captureFrames: 24, bytes: 10 * 1024 * 1024, fps: 12, captureMs: 2000, durationMs: 8000, gifEdge: 640, width: 1280, height: 720 });
export interface MotionOptions {
  fps?: number;
  delayMs?: number;
  boomerang?: boolean;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
  timeoutMs?: number;
}
export interface MotionArtifact {
  blob: Blob; mime: "image/gif" | "video/mp4" | "video/webm"; extension: "gif" | "mp4" | "webm";
  bytes: number; width: number; height: number; frameCount: number; durationMs: number; elapsedMs: number; requestedFps: number; warnings: string[];
  decodedSamples?: number; distinctDecodedSamples?: number;
}
export interface MotionCapture { frames: readonly Blob[]; width: number; height: number; frameCount: number; elapsedMs: number; requestedFps: number; warnings: string[] }
let activeMotionOperation = false;
export async function withMotionSlot<T>(work: () => Promise<T>): Promise<T> {
  if (activeMotionOperation) throw new Error("Another motion operation is running. Finish or cancel it before trying again.");
  activeMotionOperation = true;
  try { return await work(); } finally { activeMotionOperation = false; }
}
export function motionSequence(count: number, options: MotionOptions = {}) {
  if (!Number.isInteger(count) || count < 2 || count > MOTION_LIMITS.frames) throw new Error("Choose 2–48 motion frames");
  if (options.fps !== undefined && options.delayMs !== undefined) throw new Error("Choose either frame rate or frame delay");
  const fps = options.fps ?? (options.delayMs === undefined ? 4 : 1000 / options.delayMs);
  if (!Number.isFinite(fps) || fps < .5 || fps > MOTION_LIMITS.fps) throw new Error("Motion frame rate must be between 0.5 and 12 fps");
  const order = Array.from({ length: count }, (_, index) => index);
  if (options.boomerang) for (let index = count - 2; index > 0; index--) order.push(index);
  if (order.length > MOTION_LIMITS.frames) throw new Error("Boomerang exceeds the 48-frame limit");
  const delayMs = 1000 / fps;
  if (order.length * delayMs > MOTION_LIMITS.durationMs) throw new Error("Motion output must be no longer than 8 seconds");
  return { order, delayMs, fps };
}
export function validateMotionBlobs(frames: readonly Blob[]) {
  if (!Array.isArray(frames) || frames.length < 2 || frames.length > MOTION_LIMITS.frames) throw new Error("Choose 2–48 motion frames");
  let bytes = 0;
  for (const frame of frames) {
    if (!(frame instanceof Blob) || !frame.size || !["image/png", "image/jpeg"].includes(frame.type)) throw new Error("Motion frames must be PNG or JPEG images");
    bytes += frame.size;
    if (bytes > MOTION_LIMITS.bytes) throw new Error("Motion source frames exceed 10 MiB");
  }
}
export function motionSize(width: number, height: number, maxWidth: number, maxHeight: number) {
  if (![width, height, maxWidth, maxHeight].every(value => Number.isFinite(value) && value > 0)) throw new Error("Invalid motion dimensions");
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return { width: Math.max(2, Math.floor(width * scale / 2) * 2), height: Math.max(2, Math.floor(height * scale / 2) * 2) };
}
