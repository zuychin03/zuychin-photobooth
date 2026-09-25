import type { GifWorkerReply, GifWorkerRequest } from "./motion-gif-core";
import { ExportJob, createExportCanvas, releaseExportCanvas } from "./still";
import { decodeMotionFrame, drawMotionFrame } from "./motion-frames";
import { MOTION_LIMITS, motionSequence, motionSize, validateMotionBlobs, withMotionSlot, type MotionArtifact, type MotionOptions } from "./motion-types";

export function encodeMotionGif(frames: readonly Blob[], options: MotionOptions & { maxEdge?: number } = {}): Promise<MotionArtifact> {
  return withMotionSlot(() => encodeGif(frames, options));
}
async function encodeGif(frames: readonly Blob[], options: MotionOptions & { maxEdge?: number }): Promise<MotionArtifact> {
  validateMotionBlobs(frames);
  const plan = motionSequence(frames.length, options), edge = options.maxEdge ?? MOTION_LIMITS.gifEdge;
  if (!Number.isInteger(edge) || edge < 2 || edge > MOTION_LIMITS.gifEdge) throw new Error("GIF edge must be between 2 and 640 pixels");
  if (typeof Worker === "undefined") throw new Error("GIF workers are unavailable. Your still photos remain available.");
  const job = new ExportJob(options), started = performance.now();
  let worker: Worker | undefined, canvas: HTMLCanvasElement | undefined;
  try {
    const first = await decodeMotionFrame(frames[0], job);
    try { const size = motionSize(first.width, first.height, edge, edge); canvas = createExportCanvas(size.width, size.height); }
    finally { first.close(); }
    worker = new Worker(new URL("../../workers/exports-gif.worker.ts", import.meta.url), { type: "module" });
    const send = async (message: GifWorkerRequest, transfer: Transferable[] = []) => {
      job.check();
      const active = worker!;
      try {
        return await job.wait(new Promise<GifWorkerReply>((resolve, reject) => {
          active.onmessage = event => event.data.type === "error" ? reject(new Error(event.data.message)) : resolve(event.data as GifWorkerReply);
          active.onerror = () => reject(new Error("GIF worker failed. Your still photos remain available."));
          active.onmessageerror = () => reject(new Error("GIF worker returned unreadable data"));
          active.postMessage(message, transfer);
        }));
      } finally { active.onmessage = active.onerror = active.onmessageerror = null; }
    };
    const ready = await send({ type: "init", width: canvas.width, height: canvas.height, delayMs: plan.delayMs, frameCount: plan.order.length });
    if (ready.type !== "ready") throw new Error("GIF worker did not initialise");
    for (let index = 0; index < plan.order.length; index++) {
      job.check();
      const bitmap = await decodeMotionFrame(frames[plan.order[index]], job);
      try { drawMotionFrame(canvas, bitmap); } finally { bitmap.close(); }
      const pixels = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
      const reply = await send({ type: "frame", index, pixels: pixels.buffer as ArrayBuffer }, [pixels.buffer]);
      if (reply.type !== "frame" || reply.index !== index) throw new Error("GIF worker frame acknowledgement was out of order");
      options.onProgress?.(index + 1, plan.order.length);
    }
    const result = await send({ type: "finish" });
    if (result.type !== "done" || !result.bytes.byteLength || result.bytes.byteLength > MOTION_LIMITS.bytes) throw new Error("Invalid GIF output");
    const blob = new Blob([result.bytes], { type: "image/gif" });
    return { blob, mime: "image/gif", extension: "gif", bytes: blob.size, width: canvas.width, height: canvas.height, frameCount: plan.order.length,
      durationMs: result.durationMs, elapsedMs: performance.now() - started, requestedFps: plan.fps, warnings: ["GIF uses a 256-colour palette; subtle photo colours may change."] };
  } finally { worker?.terminate(); if (canvas) releaseExportCanvas(canvas); }
}
