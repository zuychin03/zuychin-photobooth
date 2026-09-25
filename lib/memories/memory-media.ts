import { composeRecap } from "../recap";
import { cloudUuid, validateCloudAsset, type CloudProjectAsset } from "../projects/cloud-contract";
import type { CloudProjectClient } from "../projects/cloud-client";
import { inspectImageHeader, inspectRetainedPngHeader } from "../projects/images";
import type { RetainedStripClient } from "./retained-strip-client";
import { parseRetainedResolution } from "./retained-strip-contract";
import type { MemoryActivity } from "./activity-contract";

export const MEMORY_MEDIA_LIMITS = Object.freeze({ sources: 12, thumbnailEdge: 640, thumbnailBytes: 2 * 1024 * 1024, outputBytes: 32 * 1024 * 1024, timeoutMs: 120000, nativeTimeoutMs: 10000 });
export interface MemoryMediaClients {
  retained: Pick<RetainedStripClient, "ownerId" | "assertActive" | "resolve" | "download">;
  projects: Pick<CloudProjectClient, "ownerId" | "assertActive" | "view" | "read" | "download">;
}
export interface MemoryThumbnail { blob: Blob; mime: "image/png"; width: number; height: number; activityId: string }
export interface AnnualMemoryRecap { blob: Blob; mime: "image/png"; width: number; height: number; activityIds: string[] }
export class MemoryMediaError extends Error {
  constructor(readonly code: "source_unavailable" | "access_changed" | "account_changed" | "cancelled" | "timeout" | "busy" | "invalid_selection" | "invalid_image" | "render_failed") { super(code); }
}
export interface MemoryMediaPorts {
  decode(blob: Blob): Promise<Pick<ImageBitmap, "width" | "height" | "close">>;
  canvas(): HTMLCanvasElement;
  encode(canvas: HTMLCanvasElement): Promise<Blob>;
  compose(sources: HTMLCanvasElement[], title: string, labels: readonly string[]): HTMLCanvasElement;
}
const native: MemoryMediaPorts = {
  decode: blob => createImageBitmap(blob, { imageOrientation: "from-image" }),
  canvas: () => document.createElement("canvas"),
  encode: canvas => new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new MemoryMediaError("render_failed")), "image/png")),
  compose: (sources, title, labels) => composeRecap(sources, title, 1, { labels }),
};
const release = (canvas: HTMLCanvasElement | undefined) => { if (canvas) canvas.width = canvas.height = 0; };
function active(clients: MemoryMediaClients, signal?: AbortSignal) {
  if (clients.retained.ownerId !== clients.projects.ownerId) throw new MemoryMediaError("account_changed");
  cloudUuid(clients.retained.ownerId); clients.retained.assertActive(signal); clients.projects.assertActive(signal);
  if (signal?.aborted) throw new MemoryMediaError("cancelled");
}
function activity(value: MemoryActivity): MemoryActivity {
  const source = value?.source;
  if (!source || !["available", "archive_pending", "archived"].includes(value.availability)) throw new MemoryMediaError("source_unavailable");
  cloudUuid(value.id); cloudUuid(source.id);
  if (source.kind === "project_asset") { if (source.scopeKind !== "project") throw new MemoryMediaError("source_unavailable"); cloudUuid(source.scopeId); }
  else if (source.kind !== "strip" || !["personal", "couple"].includes(source.scopeKind) || (source.scopeKind === "personal") !== (source.scopeId === null)) throw new MemoryMediaError("source_unavailable");
  return { ...value, source: { ...source } };
}
type Source = { kind: "strip"; fingerprint: string } | { kind: "project_asset"; fingerprint: string; asset: CloudProjectAsset; projectId: string };
async function resolve(value: MemoryActivity, clients: MemoryMediaClients, signal?: AbortSignal): Promise<Source> {
  active(clients, signal); const item = activity(value), source = item.source!;
  try {
    if (source.kind === "strip") {
      const result = parseRetainedResolution(await clients.retained.resolve(source.id, signal), source.id); active(clients, signal);
      return { kind: "strip", fingerprint: JSON.stringify(result) };
    }
    const projectId = source.scopeId!, view = await clients.projects.view(projectId, signal); active(clients, signal);
    if (view.project.id !== projectId || view.project.status !== "active" || !view.members.some(member => member.userId === clients.projects.ownerId && member.status === "accepted")) throw new MemoryMediaError("source_unavailable");
    const asset = view.assets.find(asset => asset.id === source.id);
    if (!asset || asset.kind !== "photo") throw new MemoryMediaError("source_unavailable");
    const { ownerId, ...metadata } = asset; cloudUuid(ownerId);
    validateCloudAsset({ ...metadata, requestId: asset.id, protection: { kind: "none", id: null } });
    await clients.projects.read({ id: asset.id, ownerId: asset.ownerId, projectId }, signal); active(clients, signal);
    return { kind: "project_asset", asset, projectId, fingerprint: JSON.stringify([asset.id, asset.ownerId, asset.kind, asset.mime, asset.bytes, asset.width, asset.height, asset.sha256]) };
  } catch (error) { active(clients, signal); if (error instanceof MemoryMediaError) throw error; throw new MemoryMediaError("source_unavailable"); }
}
export async function assertMemorySource(item: MemoryActivity, clients: MemoryMediaClients, signal?: AbortSignal): Promise<void> { await resolve(item, clients, signal); }

let occupied = false;
interface Job { signal: AbortSignal; check(): void; native<T>(work: () => Promise<T>, cleanup?: (value: T) => void): Promise<T> }
interface Deadlines { timeoutMs: number; nativeTimeoutMs: number }
function run<T>(clients: MemoryMediaClients, signal: AbortSignal | undefined, deadlines: Deadlines, work: (job: Job) => Promise<T>): Promise<T> {
  active(clients, signal);
  if (occupied) return Promise.reject(new MemoryMediaError("busy"));
  occupied = true;
  const controller = new AbortController(); let failure: MemoryMediaError | undefined, rejectStop!: (error: Error) => void;
  const stopped = new Promise<never>((_, reject) => { rejectStop = reject; });
  const stop = (code: "cancelled" | "timeout") => { if (!failure) { failure = new MemoryMediaError(code); controller.abort(); rejectStop(failure); } };
  const abort = () => stop("cancelled"); signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => stop("timeout"), deadlines.timeoutMs);
  const check = () => { if (failure) throw failure; active(clients, controller.signal); };
  const task = (async () => {
    try {
      check(); const result = await work({ signal: controller.signal, check, async native(operation, cleanup) {
        check(); const nativeTimer = setTimeout(() => stop("timeout"), deadlines.nativeTimeoutMs);
        try { const result = await operation(); try { check(); } catch (error) { cleanup?.(result); throw error; } return result; }
        finally { clearTimeout(nativeTimer); }
      } }); check(); return result;
    } catch (error) { if (failure) throw failure; if (error instanceof MemoryMediaError) throw error; active(clients, controller.signal); throw new MemoryMediaError("render_failed"); }
    finally { occupied = false; clearTimeout(timer); signal?.removeEventListener("abort", abort); }
  })();
  // Caller cancellation does not release the native allocation slot before late work settles.
  return Promise.race([task, stopped]);
}
async function thumbnail(item: MemoryActivity, clients: MemoryMediaClients, job: Job, ports: MemoryMediaPorts): Promise<{ canvas: HTMLCanvasElement; source: Source }> {
  const source = await resolve(item, clients, job.signal); job.check(); let blob: Blob, width: number, height: number, mime: string;
  try { if (source.kind === "strip") {
    const download = await clients.retained.download(item.source!.id, job.signal); job.check();
    if (download.id !== item.source!.id || download.blob.size < 1 || download.blob.size > 16 * 1024 * 1024) throw new MemoryMediaError("invalid_image");
    blob = download.blob; width = download.width; height = download.height; mime = "image/png";
  } else {
    blob = await clients.projects.download({ ...source.asset, projectId: source.projectId }, job.signal); job.check();
    if (blob.size !== source.asset.bytes || blob.size > 10 * 1024 * 1024) throw new MemoryMediaError("invalid_image");
    ({ width, height, mime } = source.asset);
  } } catch (error) { job.check(); if (error instanceof MemoryMediaError) throw error; throw new MemoryMediaError("source_unavailable"); }
  const bytes = new Uint8Array(await blob.arrayBuffer()); job.check();
  let info;
  try { info = source.kind === "strip" ? inspectRetainedPngHeader(bytes) : inspectImageHeader(bytes); } catch { throw new MemoryMediaError("invalid_image"); }
  if (info.width !== width || info.height !== height || info.mime !== mime || blob.type !== mime) throw new MemoryMediaError("invalid_image");
  const bitmap = await job.native(() => ports.decode(blob), bitmap => bitmap.close()); let canvas: HTMLCanvasElement | undefined;
  try {
    if (bitmap.width !== width || bitmap.height !== height) throw new MemoryMediaError("invalid_image");
    canvas = ports.canvas(); const scale = Math.min(1, 640 / width, 640 / height);
    canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext("2d"); if (!ctx) throw new MemoryMediaError("render_failed");
    ctx.drawImage(bitmap as ImageBitmap, 0, 0, canvas.width, canvas.height); job.check();
    return { canvas, source };
  } catch (error) { release(canvas); throw error; } finally { bitmap.close(); }
}
async function recheck(item: MemoryActivity, original: Source, clients: MemoryMediaClients, job: Job) {
  const current = await resolve(item, clients, job.signal); job.check();
  if (current.kind !== original.kind || current.fingerprint !== original.fingerprint) throw new MemoryMediaError("access_changed");
}
function encoded(blob: Blob, maximum: number) { if (blob.type !== "image/png" || blob.size < 1 || blob.size > maximum) throw new MemoryMediaError("render_failed"); return blob; }

export function createMemoryMedia(ports: MemoryMediaPorts = native, options: Partial<Deadlines> = {}) {
  const deadlines = { timeoutMs: options.timeoutMs ?? MEMORY_MEDIA_LIMITS.timeoutMs, nativeTimeoutMs: options.nativeTimeoutMs ?? MEMORY_MEDIA_LIMITS.nativeTimeoutMs };
  if (!Number.isInteger(deadlines.timeoutMs) || deadlines.timeoutMs < 1 || deadlines.timeoutMs > MEMORY_MEDIA_LIMITS.timeoutMs || !Number.isInteger(deadlines.nativeTimeoutMs) || deadlines.nativeTimeoutMs < 1 || deadlines.nativeTimeoutMs > MEMORY_MEDIA_LIMITS.nativeTimeoutMs) throw new MemoryMediaError("invalid_selection");
  return {
    prepareMemoryThumbnail(value: MemoryActivity, clients: MemoryMediaClients, signal?: AbortSignal): Promise<MemoryThumbnail> {
      const item = activity(value);
      return run(clients, signal, deadlines, async job => {
        const { canvas, source } = await thumbnail(item, clients, job, ports);
        try {
          const blob = encoded(await job.native(() => ports.encode(canvas)), MEMORY_MEDIA_LIMITS.thumbnailBytes); job.check();
          await recheck(item, source, clients, job);
          return { blob, mime: "image/png", width: canvas.width, height: canvas.height, activityId: item.id };
        } finally { release(canvas); }
      });
    },
    renderAnnualMemoryRecap(values: readonly MemoryActivity[], title: string, labels: readonly string[], clients: MemoryMediaClients, signal?: AbortSignal): Promise<AnnualMemoryRecap> {
      if (values.length < 1 || values.length > 12 || labels.length !== values.length || typeof title !== "string" || [...title].length > 120 || labels.some(label => typeof label !== "string" || [...label].length > 100)) return Promise.reject(new MemoryMediaError("invalid_selection"));
      const items = values.map(activity), copiedLabels = [...labels];
      if (new Set(items.map(item => item.id)).size !== items.length || new Set(items.map(item => `${item.source!.kind}:${item.source!.id}`)).size !== items.length) return Promise.reject(new MemoryMediaError("invalid_selection"));
      return run(clients, signal, deadlines, async job => {
        const sources: { canvas: HTMLCanvasElement; source: Source }[] = []; let output: HTMLCanvasElement | undefined;
        try {
          for (const item of items) { sources.push(await thumbnail(item, clients, job, ports)); job.check(); }
          output = ports.compose(sources.map(source => source.canvas), title, copiedLabels); job.check();
          if (!Number.isInteger(output.width) || !Number.isInteger(output.height) || output.width < 1 || output.height < 1 || output.width > 4096 || output.height > 4096 || output.width * output.height > 12 * 1024 * 1024) throw new MemoryMediaError("render_failed");
          const width = output.width, height = output.height, blob = encoded(await job.native(() => ports.encode(output!)), MEMORY_MEDIA_LIMITS.outputBytes); job.check();
          for (let i = 0; i < items.length; i++) await recheck(items[i], sources[i].source, clients, job);
          return { blob, mime: "image/png", width, height, activityIds: items.map(item => item.id) };
        } finally { release(output); for (const source of sources) release(source.canvas); }
      });
    },
  };
}
const media = createMemoryMedia();
export const prepareMemoryThumbnail = media.prepareMemoryThumbnail;
export const renderAnnualMemoryRecap = media.renderAnnualMemoryRecap;
