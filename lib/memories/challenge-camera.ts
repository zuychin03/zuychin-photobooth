import { canvasToJpeg, captureFrame } from "../capture";
import { CLOUD_PROJECT_LIMITS } from "../projects/cloud-contract";
import { inspectImageHeader } from "../projects/images";

export class ChallengeCameraError extends Error {
  constructor(readonly code: "busy" | "not_ready" | "resource_limit" | "encode_failed" | "cancelled" | "timeout") { super(code); }
}
export interface ChallengeCapturePorts {
  capture: typeof captureFrame;
  encode: typeof canvasToJpeg;
  inspect: typeof inspectImageHeader;
  timeoutMs?: number;
}
export function createChallengePhotoCapture(ports: ChallengeCapturePorts = { capture: captureFrame, encode: canvasToJpeg, inspect: inspectImageHeader }) {
  let occupied = false;
  const timeoutMs = ports.timeoutMs ?? 10000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) throw new ChallengeCameraError("resource_limit");
  return async (video: HTMLVideoElement, mirror: boolean, sourceIndex: number, signal?: AbortSignal): Promise<File> => {
    if (signal?.aborted) throw new ChallengeCameraError("cancelled");
    if (occupied) throw new ChallengeCameraError("busy");
    if (!Number.isInteger(sourceIndex) || sourceIndex < 0 || sourceIndex > 3) throw new ChallengeCameraError("resource_limit");
    const width = video.videoWidth, height = video.videoHeight;
    if (video.readyState < 2 || !width || !height) throw new ChallengeCameraError("not_ready");
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > CLOUD_PROJECT_LIMITS.edge || height > CLOUD_PROJECT_LIMITS.edge || width * height > CLOUD_PROJECT_LIMITS.pixels) throw new ChallengeCameraError("resource_limit");
    occupied = true;
    let canvas: HTMLCanvasElement | null = null, timedOut = false;
    const release = () => { if (canvas) { canvas.width = 1; canvas.height = 1; canvas = null; } };
    const active = () => { if (signal?.aborted || timedOut) throw new ChallengeCameraError(timedOut ? "timeout" : "cancelled"); };
    let cancel: (() => void) | undefined, timeout: ReturnType<typeof setTimeout> | undefined;
    const interrupted = new Promise<never>((_, reject) => {
      cancel = () => reject(new ChallengeCameraError("cancelled"));
      signal?.addEventListener("abort", cancel, { once: true });
      timeout = setTimeout(() => { timedOut = true; reject(new ChallengeCameraError("timeout")); }, timeoutMs);
    });
    const work = (async () => {
      try {
        canvas = ports.capture(video, mirror);
        if (canvas.width !== width || canvas.height !== height) throw new ChallengeCameraError("encode_failed");
        const blob = await ports.encode(canvas, 0.92); release(); active();
        if (blob.type !== "image/jpeg" || !blob.size || blob.size > CLOUD_PROJECT_LIMITS.assetBytes) throw new ChallengeCameraError("resource_limit");
        const bytes = new Uint8Array(await blob.arrayBuffer()); active();
        const info = ports.inspect(bytes);
        if (info.mime !== "image/jpeg" || info.width !== width || info.height !== height) throw new ChallengeCameraError("encode_failed");
        return new File([blob], `challenge-photo-${sourceIndex + 1}.jpg`, { type: "image/jpeg" });
      } catch (error) {
        if (error instanceof ChallengeCameraError) throw error;
        throw new ChallengeCameraError("encode_failed");
      } finally { release(); occupied = false; }
    })();
    try { return await Promise.race([work, interrupted]); }
    finally { clearTimeout(timeout); if (cancel) signal?.removeEventListener("abort", cancel); }
  };
}
// A late native encoder retains its one slot even when its UI has closed.
export const captureChallengePhoto = createChallengePhotoCapture();

export function challengeCameraMessage(error: unknown): string {
  const code = error instanceof ChallengeCameraError ? error.code : "encode_failed";
  return {
    busy: "The previous photo is still finishing. Wait a moment, or close the camera and choose a file.",
    not_ready: "The camera has not produced a frame yet. Start it again, or choose a file.",
    resource_limit: "This camera photo exceeds the image limits. Choose another camera or a file up to 10 MiB, 4096 pixels per side and 12 megapixels.",
    encode_failed: "This photo could not be prepared. Retake it, or close the camera and choose a file.",
    cancelled: "Capture stopped. No photo was selected or uploaded.",
    timeout: "The photo took too long to prepare. It has not been selected or uploaded. Wait a moment, or choose a file.",
  }[code];
}
