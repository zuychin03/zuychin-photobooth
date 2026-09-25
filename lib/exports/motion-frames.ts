import { inspectImageHeader } from "../projects/images";
import { ExportJob } from "./still";

let nativeDecodePending = false;
export async function decodeMotionFrame(blob: Blob, job: ExportJob): Promise<ImageBitmap> {
  job.check();
  const info = inspectImageHeader(new Uint8Array(await job.wait(blob.arrayBuffer())));
  if (info.mime !== blob.type || !["image/png", "image/jpeg"].includes(info.mime)) throw new Error("Motion frame MIME does not match its bytes");
  if (typeof createImageBitmap !== "function") throw new Error("Native image decoding is unavailable on this browser");
  if (nativeDecodePending) throw new Error("A previous motion image is still decoding. Wait before retrying, or reload this page if it does not finish.");
  let abandoned = false;
  nativeDecodePending = true;
  let decoding: Promise<ImageBitmap>;
  try { decoding = createImageBitmap(blob); } catch (error) { nativeDecodePending = false; throw error; }
  const pending = decoding.then(bitmap => {
    if (abandoned) { bitmap.close(); throw new Error("Image decode was cancelled"); }
    if (bitmap.width !== info.width || bitmap.height !== info.height) { bitmap.close(); throw new Error("Motion frame dimensions do not match their header"); }
    return bitmap;
  }).finally(() => { nativeDecodePending = false; });
  try { return await job.wait(pending); }
  catch (error) { abandoned = true; void pending.then(bitmap => bitmap.close(), () => {}); throw error; }
}
export async function motionPause(ms: number, job: ExportJob) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await job.wait(new Promise<void>(resolve => { timer = setTimeout(resolve, Math.max(0, ms)); })); }
  finally { clearTimeout(timer); }
}
export async function sustainMotionFrame(durationMs: number, ports: { now(): number; pause(ms: number): Promise<void>; emit(): void; check(): void }) {
  const started = ports.now(), period = 1000 / 12;
  let lastEmission = started;
  while (ports.now() - started < durationMs) {
    ports.check();
    await ports.pause(Math.min(Math.ceil(period), durationMs - (ports.now() - started)));
    ports.check();
    if (ports.now() - lastEmission >= period - .5) { ports.emit(); lastEmission = ports.now(); }
  }
}
export function motionFrameEmitter(now: () => number, emit: () => void) {
  let previous = -Infinity;
  return () => { const time = now(); if (time - previous >= 1000 / 12) { emit(); previous = time; } };
}
export function drawMotionFrame(canvas: HTMLCanvasElement, source: CanvasImageSource & { width: number; height: number }) {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas drawing is unavailable");
  context.fillStyle = "#ffffff"; context.fillRect(0, 0, canvas.width, canvas.height);
  const scale = Math.min(canvas.width / source.width, canvas.height / source.height);
  const width = source.width * scale, height = source.height * scale;
  context.drawImage(source, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
}
