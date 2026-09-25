import type { ProbeResult } from "../feasibility/types";
import { ExportJob, createExportCanvas, encodeExportCanvas, releaseExportCanvas } from "./still";
import { encodeMotionGif } from "./motion-gif";
import { advertisedVideoMime, encodeMotionVideo, type MotionVideoFormat } from "./motion-video";
import { projectBlobHash } from "../projects/bundle";

async function syntheticFrames(signal?: AbortSignal) {
  const job = new ExportJob({ signal }), canvas = createExportCanvas(1280, 720), frames: Blob[] = [];
  try {
    const context = canvas.getContext("2d")!;
    for (const colour of ["#ff0000", "#00ff00", "#0000ff", "#ffff00"]) {
      job.check(); context.fillStyle = colour; context.fillRect(0, 0, canvas.width, canvas.height);
      frames.push(await encodeExportCanvas(canvas, "png", 1, job));
    }
    return frames;
  } finally { releaseExportCanvas(canvas); }
}
export interface MotionVideoCapability { format: MotionVideoFormat; available: boolean; status: "pass" | "fail" | "unsupported"; detail: string }
export async function probeMotionVideoFormats(signal?: AbortSignal): Promise<MotionVideoCapability[]> {
  const frames = await syntheticFrames(signal), results: MotionVideoCapability[] = [];
  for (const format of ["mp4", "webm"] as const) {
    if (signal?.aborted) throw new DOMException("Motion probe cancelled", "AbortError");
    if (!advertisedVideoMime(format)) { results.push({ format, available: false, status: "unsupported", detail: "This browser does not advertise this recording format." }); continue; }
    try {
      const artifact = await encodeMotionVideo(frames, { format, delayMs: 500, signal });
      if ((artifact.distinctDecodedSamples ?? 0) < 2 || artifact.durationMs < 1750 || artifact.durationMs > 3000) throw new Error("Synthetic video did not decode with the expected duration and changing pixels");
      results.push({ format, available: true, status: "pass", detail: `Encoded and decoded ${artifact.mime}, ${artifact.bytes} bytes, ${artifact.width} × ${artifact.height}, ${Math.round(artifact.durationMs)} ms.` });
    } catch (error) {
      if (signal?.aborted) throw error;
      results.push({ format, available: false, status: "fail", detail: error instanceof Error ? error.message : "Native video verification failed" });
    }
  }
  return results;
}
type DecodedFrame = { image: CanvasImageSource & { close(): void; displayWidth: number; displayHeight: number } };
type Decoder = { tracks: { ready: Promise<void>; selectedTrack: { frameCount: number } | null }; decode(options: { frameIndex: number }): Promise<DecodedFrame>; close(): void };
type DecoderConstructor = new (options: { data: ArrayBuffer; type: string }) => Decoder;
export async function runMotionProbe(signal?: AbortSignal): Promise<ProbeResult[]> {
  if (process.env.NODE_ENV === "production") throw new Error("Motion probes are available only in development");
  if (typeof document === "undefined") return [{ id: "motion-browser", status: "unsupported", detail: "Native motion probes require a browser." }];
  const results: ProbeResult[] = [], frames = await syntheticFrames(signal), job = new ExportJob({ signal });
  let decoder: Decoder | undefined, sample: HTMLCanvasElement | undefined;
  try {
    const before = await Promise.all(frames.map(projectBlobHash));
    const cancellation = new AbortController();
    const abort = () => cancellation.abort();
    signal?.addEventListener("abort", abort, { once: true });
    let rejected = false, progressCount = 0;
    try {
      await encodeMotionGif(frames, { delayMs: 200, boomerang: true, signal: cancellation.signal, onProgress: () => { progressCount++; cancellation.abort(); } });
    } catch (error) { rejected = error instanceof DOMException && error.name === "AbortError"; }
    finally { signal?.removeEventListener("abort", abort); }
    job.check();
    if (!rejected || progressCount !== 1) throw new Error("GIF cancellation did not stop after the first acknowledged worker frame");
    const after = await Promise.all(frames.map(projectBlobHash));
    if (before.some((hash, index) => hash !== after[index])) throw new Error("GIF cancellation changed an original frame");
    const artifact = await encodeMotionGif(frames, { delayMs: 200, boomerang: true, signal });
    if (artifact.frameCount !== 6 || artifact.mime !== "image/gif" || !artifact.bytes) throw new Error("GIF retry did not complete a fresh six-frame worker job");
    results.push({ id: "motion-gif-mid-encode-cancel-retry", status: "pass", detail: "Aborted after the first acknowledged worker frame, retained every original PNG hash, then a new worker encoded all six frames successfully." });
    results.push({ id: "motion-gif-worker", status: "pass", detail: "Worker encoded a six-frame synthetic boomerang; original PNGs remain unchanged.", metrics: { bytes: artifact.bytes, width: artifact.width, height: artifact.height, frames: artifact.frameCount, durationMs: artifact.durationMs } });
    const NativeDecoder = (globalThis as unknown as { ImageDecoder?: DecoderConstructor }).ImageDecoder;
    if (!NativeDecoder) results.push({ id: "motion-gif-native-decode", status: "unsupported", detail: "The browser does not expose native multi-frame ImageDecoder. Worker encoding does not prove animated playback." });
    else {
      decoder = new NativeDecoder({ data: await job.wait(artifact.blob.arrayBuffer()), type: "image/gif" });
      await job.wait(decoder.tracks.ready);
      if (decoder.tracks.selectedTrack?.frameCount !== 6) throw new Error("Native GIF decoder reported an unexpected frame count");
      sample = createExportCanvas(1, 1);
      const context = sample.getContext("2d")!, expected = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [0, 0, 255], [0, 255, 0]];
      for (let index = 0; index < 6; index++) {
        const pending: Promise<DecodedFrame> = decoder.decode({ frameIndex: index });
        let frame: DecodedFrame | undefined;
        try {
          frame = await job.wait(pending);
          if (frame.image.displayWidth !== artifact.width || frame.image.displayHeight !== artifact.height) throw new Error("Native GIF dimensions differ from the exported canvas");
          context.drawImage(frame.image, 0, 0, 1, 1);
          const pixel = context.getImageData(0, 0, 1, 1).data;
          if (expected[index].some((value, channel) => Math.abs(pixel[channel] - value) > 8)) throw new Error(`Native GIF frame ${index + 1} has unexpected pixels`);
        } finally { if (frame) frame.image.close(); else void pending.then(value => value.image.close(), () => {}); }
      }
      results.push({ id: "motion-gif-native-decode", status: "pass", detail: "Native decoder checked all six boomerang frames, dimensions and expected changing pixels." });
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    results.push({ id: "motion-gif", status: "fail", detail: error instanceof Error ? error.message : "GIF probe failed" });
  } finally { decoder?.close(); if (sample) releaseExportCanvas(sample); }
  for (const capability of await probeMotionVideoFormats(signal)) results.push({ id: `motion-${capability.format}`, status: capability.status, detail: capability.detail });
  return results;
}
