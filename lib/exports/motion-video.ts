import { recordingFormatMatches } from "../feasibility/media-probe";
import { ExportJob, createExportCanvas, releaseExportCanvas } from "./still";
import { decodeMotionFrame, drawMotionFrame, motionFrameEmitter, motionPause, sustainMotionFrame } from "./motion-frames";
import { MOTION_LIMITS, motionSequence, motionSize, validateMotionBlobs, withMotionSlot, type MotionArtifact, type MotionOptions } from "./motion-types";

export type MotionVideoFormat = "mp4" | "webm";
const CANDIDATES = { mp4: ["video/mp4;codecs=avc1.42E01E", "video/mp4"], webm: ["video/webm;codecs=vp8", "video/webm"] } as const;
export function advertisedVideoMime(format: MotionVideoFormat): string | null {
  if (!(format in CANDIDATES)) throw new Error("Choose MP4 or WebM");
  if (typeof MediaRecorder === "undefined") return null;
  return CANDIDATES[format].find(mime => MediaRecorder.isTypeSupported(mime)) ?? null;
}
export async function verifyMotionVideo(blob: Blob, width: number, height: number, job: ExportJob): Promise<{ durationMs: number; samples: number; distinctSamples: number }> {
  const video = document.createElement("video"), sample = createExportCanvas(1, 1), url = URL.createObjectURL(blob);
  let timer: ReturnType<typeof setInterval> | undefined;
  video.muted = true; video.playsInline = true; video.preload = "auto";
  try {
    await job.wait(new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve(); video.onerror = () => reject(new Error("The exported video could not be decoded")); video.src = url;
    }));
    video.onloadeddata = video.onerror = null;
    if (video.videoWidth !== width || video.videoHeight !== height) throw new Error("The exported video decoded at unexpected dimensions");
    const colours = new Set<string>(); let samples = 0;
    const ctx = sample.getContext("2d")!;
    const takeSample = () => {
      if (video.readyState < 2) return;
      ctx.drawImage(video, video.videoWidth / 2, video.videoHeight / 2, 1, 1, 0, 0, 1, 1);
      colours.add(Array.from(ctx.getImageData(0, 0, 1, 1).data).join(",")); samples++;
    };
    const ended = new Promise<void>((resolve, reject) => { video.onended = () => { takeSample(); resolve(); }; video.onerror = () => reject(new Error("The exported video failed during playback")); });
    void ended.catch(() => {});
    takeSample(); timer = setInterval(takeSample, 80);
    await job.wait(video.play()); await job.wait(ended);
    const durationMs = video.currentTime * 1000;
    if (!Number.isFinite(durationMs) || durationMs < 50 || durationMs > 10_000 || samples < 2) throw new Error("The exported video did not complete valid bounded playback");
    return { durationMs, samples, distinctSamples: colours.size };
  } finally {
    clearInterval(timer); video.onloadeddata = video.onerror = video.onended = null;
    video.pause(); video.removeAttribute("src"); video.load(); video.remove(); URL.revokeObjectURL(url); releaseExportCanvas(sample);
  }
}
export function encodeMotionVideo(frames: readonly Blob[], options: MotionOptions & { format: MotionVideoFormat }): Promise<MotionArtifact> {
  return withMotionSlot(() => encodeVideo(frames, options));
}
async function encodeVideo(frames: readonly Blob[], options: MotionOptions & { format: MotionVideoFormat }): Promise<MotionArtifact> {
  validateMotionBlobs(frames);
  const plan = motionSequence(frames.length, options), mime = advertisedVideoMime(options.format);
  if (!mime) throw new Error(`${options.format.toUpperCase()} recording is unavailable. Choose GIF or keep your still photos.`);
  const job = new ExportJob({ signal: options.signal, timeoutMs: options.timeoutMs ?? 40_000 }), started = performance.now();
  let canvas: HTMLCanvasElement | undefined, stream: MediaStream | undefined, recorder: MediaRecorder | undefined;
  let recordingTimer: ReturnType<typeof setTimeout> | undefined;
  const chunks: Blob[] = []; let bytes = 0, fatal: Error | undefined;
  try {
    const first = await decodeMotionFrame(frames[0], job);
    try { const size = motionSize(first.width, first.height, MOTION_LIMITS.width, MOTION_LIMITS.height); canvas = createExportCanvas(size.width, size.height); drawMotionFrame(canvas, first); }
    finally { first.close(); }
    if (typeof canvas.captureStream !== "function") throw new Error("Canvas recording is unavailable. Choose GIF instead.");
    stream = canvas.captureStream(0);
    let captureTrack = stream.getVideoTracks()[0] as MediaStreamTrack & { requestFrame?: () => void };
    if (typeof captureTrack.requestFrame !== "function") {
      stream.getTracks().forEach(track => track.stop());
      stream = canvas.captureStream(12);
      captureTrack = stream.getVideoTracks()[0];
    }
    recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 2_000_000 });
    const active = recorder;
    const stopped = new Promise<Blob>((resolve, reject) => {
      const fail = (error: Error) => { fatal = error; if (active.state !== "inactive") active.stop(); reject(error); };
      active.ondataavailable = event => {
        if (fatal || !event.data.size) return;
        bytes += event.data.size;
        if (bytes > MOTION_LIMITS.bytes) { fail(new Error("Video exceeds the 10 MiB output limit")); return; }
        chunks.push(event.data);
      };
      active.onerror = () => fail(new Error("Video recording failed. Your still photos are unchanged."));
      active.onstop = () => fatal ? reject(fatal) : resolve(new Blob(chunks, { type: active.mimeType }));
    });
    void stopped.catch(() => {});
    active.start(250);
    const emitHeldFrame = motionFrameEmitter(() => performance.now(), () => {
      canvas!.getContext("2d")!.drawImage(canvas!, 0, 0);
      captureTrack.requestFrame?.();
    });
    recordingTimer = setTimeout(() => { fatal = new Error("Video recording exceeded its time limit"); if (active.state !== "inactive") active.stop(); }, 10_000);
    for (let index = 0; index < plan.order.length; index++) {
      job.check(); if (fatal) throw fatal;
      if (index > 0) {
        const bitmap = await decodeMotionFrame(frames[plan.order[index]], job);
        try { drawMotionFrame(canvas, bitmap); } finally { bitmap.close(); }
      }
      emitHeldFrame();
      options.onProgress?.(index + 1, plan.order.length);
      await sustainMotionFrame(plan.delayMs, { now: () => performance.now(), pause: ms => motionPause(ms, job), emit: emitHeldFrame, check: () => { job.check(); if (fatal) throw fatal; } });
    }
    await motionPause(1000 / 12, job);
    if (active.state !== "inactive") active.stop();
    const blob = await job.wait(stopped);
    clearTimeout(recordingTimer);
    stream.getTracks().forEach(track => track.stop());
    if (!blob.size || blob.size > MOTION_LIMITS.bytes || !await job.wait(recordingFormatMatches(mime, active.mimeType, blob))) throw new Error("Requested format did not match the actual video MIME and container");
    const decoded = await verifyMotionVideo(blob, canvas.width, canvas.height, job);
    if (decoded.durationMs < plan.order.length * plan.delayMs - 250) throw new Error("The video ended before its final frame hold completed. Try GIF instead.");
    return { blob, mime: options.format === "mp4" ? "video/mp4" : "video/webm", extension: options.format, bytes: blob.size, width: canvas.width, height: canvas.height,
      frameCount: plan.order.length, durationMs: decoded.durationMs, elapsedMs: performance.now() - started, requestedFps: plan.fps,
      decodedSamples: decoded.samples, distinctDecodedSamples: decoded.distinctSamples,
      warnings: ["Video timing can vary slightly with browser performance."] };
  } finally {
    clearTimeout(recordingTimer);
    if (recorder) { recorder.ondataavailable = recorder.onerror = recorder.onstop = null; if (recorder.state !== "inactive") recorder.stop(); }
    stream?.getTracks().forEach(track => track.stop()); chunks.length = 0;
    if (canvas) releaseExportCanvas(canvas);
  }
}
