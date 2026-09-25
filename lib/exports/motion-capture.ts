import { FILTERS, supportsCanvasFilter } from "../filters";
import { ExportJob, createExportCanvas, encodeExportCanvas, releaseExportCanvas } from "./still";
import { motionPause } from "./motion-frames";
import { MOTION_LIMITS, motionSize, withMotionSlot, type MotionCapture, type MotionOptions } from "./motion-types";

export interface CaptureMotionOptions extends Pick<MotionOptions, "signal" | "onProgress"> { mirror?: boolean; filterId?: string; durationMs?: number; fps?: number }
export async function collectMotionFrames(ports: { now(): number; pause(ms: number): Promise<void>; capture(): Promise<Blob>; check(): void }, durationMs: number, fps: number, onProgress?: MotionOptions["onProgress"]) {
  if (!Number.isFinite(durationMs) || durationMs < 100 || durationMs > MOTION_LIMITS.captureMs
    || !Number.isFinite(fps) || fps < 1 || fps > MOTION_LIMITS.fps) throw new Error("Solo motion is limited to 2 seconds at up to 12 fps");
  const frames: Blob[] = [], started = ports.now(), period = 1000 / fps;
  const limit = Math.min(MOTION_LIMITS.captureFrames, Math.ceil(durationMs / period));
  let bytes = 0, nextAt = started;
  while (frames.length < limit && ports.now() - started < durationMs) {
    ports.check();
    if (nextAt > ports.now()) await ports.pause(nextAt - ports.now());
    ports.check();
    if (ports.now() - started >= durationMs) break;
    const shotAt = ports.now(), blob = await ports.capture();
    ports.check();
    if (blob.type !== "image/jpeg" || !blob.size) throw new Error("Motion capture did not produce a JPEG frame");
    bytes += blob.size;
    if (bytes > MOTION_LIMITS.bytes) throw new Error("Motion capture exceeds 10 MiB. Your still photos are unchanged.");
    frames.push(blob); onProgress?.(frames.length, limit);
    nextAt = shotAt + period;
    if (ports.now() > nextAt) nextAt = ports.now() + period;
  }
  if (frames.length < 2) throw new Error("The camera was too slow to capture a loop. Your still photos are unchanged.");
  return { frames, elapsedMs: ports.now() - started };
}
export function captureSoloFrames(video: HTMLVideoElement, options: CaptureMotionOptions = {}): Promise<MotionCapture> {
  return withMotionSlot(() => captureFrames(video, options));
}
async function captureFrames(video: HTMLVideoElement, options: CaptureMotionOptions): Promise<MotionCapture> {
  const filter = FILTERS.find(item => item.id === (options.filterId ?? "none"));
  if (!filter) throw new Error("Unknown camera filter");
  if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) throw new Error("The camera is not ready for a motion capture");
  const job = new ExportJob({ signal: options.signal, timeoutMs: 10_000 }), fps = options.fps ?? 12;
  const size = motionSize(video.videoWidth, video.videoHeight, MOTION_LIMITS.width, MOTION_LIMITS.height);
  const canvas = createExportCanvas(size.width, size.height), warnings: string[] = [];
  try {
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas drawing is unavailable");
    const filtered = filter.css === "none" || supportsCanvasFilter();
    if (!filtered) warnings.push("This browser captured the loop without the selected filter.");
    const result = await collectMotionFrames({ now: () => performance.now(), check: () => job.check(), pause: ms => motionPause(ms, job), capture: async () => {
      if (video.readyState < 2 || video.ended || video.videoWidth < 1 || video.videoHeight < 1) throw new Error("The camera stopped during motion capture");
      context.save();
      try {
        context.fillStyle = "#ffffff"; context.fillRect(0, 0, canvas.width, canvas.height);
        if (options.mirror) { context.translate(canvas.width, 0); context.scale(-1, 1); }
        if (filtered) context.filter = filter.css;
        const scale = Math.min(canvas.width / video.videoWidth, canvas.height / video.videoHeight);
        const width = video.videoWidth * scale, height = video.videoHeight * scale;
        context.drawImage(video, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
      } finally { context.restore(); }
      return encodeExportCanvas(canvas, "jpeg", .82, job);
    } }, options.durationMs ?? 2000, fps, options.onProgress);
    return { ...result, ...size, frameCount: result.frames.length, requestedFps: fps, warnings };
  } finally { releaseExportCanvas(canvas); }
}
