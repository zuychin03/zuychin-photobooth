import { inspectRetainedPngHeader } from "./projects/images";
import { readRetainedBody } from "./memories/retained-strip-contract";
const STRIP_H = 640;
const GAP = 28;
const PAD = 48;
const HEADER_H = 130;
const MAX_COLS = 4;
const BG = "#faf7f2";
const INK = "#292524";

export const WEEKLY_RECAP_LIMITS = Object.freeze({ sources: 20, sourceBytes: 16 * 1024 * 1024, outputBytes: 16 * 1024 * 1024, thumbnailEdge: 640, timeoutMs: 120000, nativeTimeoutMs: 10000 });

/** ctx.font cannot resolve CSS variables; read the next/font family off :root. */
function fontVar(name: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v ? `${v}, ${fallback}` : fallback;
}

type Source = HTMLImageElement | HTMLCanvasElement;

function srcW(s: Source): number {
  return typeof HTMLImageElement !== "undefined" && s instanceof HTMLImageElement ? s.naturalWidth : s.width;
}
function srcH(s: Source): number {
  return typeof HTMLImageElement !== "undefined" && s instanceof HTMLImageElement ? s.naturalHeight : s.height;
}

export function composeRecap(sources: Source[], title: string, scale = 1, annual?: { labels: readonly string[] }): HTMLCanvasElement {
  if (annual) return composeAnnualRecap(sources, title, scale, annual.labels);
  if (typeof title !== "string" || [...title].length > 120) throw new Error("The recap title is too long.");
  const { cols, colW, width, height, outputWidth, outputHeight, renderScale } = weeklyRecapGeometry(sources.map(source => ({ width: srcW(source), height: srcH(source) })), scale);
  const canvas = document.createElement("canvas");
  canvas.width = outputWidth;
  canvas.height = outputHeight;
  try {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("The recap canvas is unavailable.");
  ctx.scale(renderScale, renderScale);

  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = INK;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `600 52px ${fontVar("--font-fraunces", "Georgia, serif")}`;
  ctx.fillText(title, width / 2, PAD + HEADER_H / 2, width - PAD * 2);

  sources.forEach((s, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const w = STRIP_H * (srcW(s) / srcH(s));
    const x = PAD + col * (colW + GAP) + (colW - w) / 2;
    const y = PAD + HEADER_H + row * (STRIP_H + GAP);
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.18)";
    ctx.shadowBlur = 18;
    ctx.shadowOffsetY = 6;
    ctx.drawImage(s, x, y, w, STRIP_H);
    ctx.restore();
  });

  return canvas;
  } catch (error) { canvas.width = canvas.height = 0; throw error; }
}

export function weeklyRecapGeometry(sources: readonly { width: number; height: number }[], scale = 2) {
  if (!sources.length || sources.length > WEEKLY_RECAP_LIMITS.sources || !Number.isFinite(scale) || scale <= 0 || scale > 2 || sources.some(s => !Number.isInteger(s.width) || !Number.isInteger(s.height) || s.width < 1 || s.height < 1 || s.width > 4096 || s.height > 4096 || s.width * s.height > 12 * 1024 * 1024)) throw new Error("Choose up to 20 supported strips for this recap.");
  const count = sources.length;
  const cols = Math.min(count, MAX_COLS);
  const rows = Math.ceil(count / cols);
  const widths = sources.map((s) => STRIP_H * (s.width / s.height));
  const colW = Math.max(...widths, STRIP_H * 0.6);

  const width = PAD * 2 + cols * colW + (cols - 1) * GAP;
  const height = PAD * 2 + HEADER_H + rows * STRIP_H + (rows - 1) * GAP;

  const renderScale = Math.min(scale, 4096 / width, 4096 / height, Math.sqrt(12 * 1024 * 1024 / (width * height)));
  return { cols, colW, width, height, renderScale, outputWidth: Math.max(1, Math.floor(width * renderScale)), outputHeight: Math.max(1, Math.floor(height * renderScale)) };
}

export function annualRecapGeometry(count: number, scale = 1, cellWidth = 640, cellHeight = 640) {
  if (!Number.isInteger(count) || count < 1 || count > 12 || !Number.isFinite(scale) || scale <= 0 || !Number.isInteger(cellWidth) || !Number.isInteger(cellHeight) || cellWidth < 1 || cellHeight < 1 || cellWidth > 640 || cellHeight > 640) throw new Error("Invalid annual recap selection");
  const caption = 64, cols = Math.min(count, 4), rows = Math.ceil(count / cols);
  const width = PAD * 2 + cols * cellWidth + (cols - 1) * GAP, height = PAD * 2 + HEADER_H + rows * (cellHeight + caption) + (rows - 1) * GAP;
  const w = Math.round(width * scale), h = Math.round(height * scale);
  if (w < 1 || h < 1 || w > 4096 || h > 4096 || w * h > 12 * 1024 * 1024) throw new Error("Annual recap exceeds the image bounds");
  return { cellWidth, cellHeight, caption, cols, width, height, outputWidth: w, outputHeight: h };
}
function composeAnnualRecap(sources: Source[], title: string, scale: number, labels: readonly string[]) {
  if (labels.length !== sources.length || typeof title !== "string" || [...title].length > 120 || labels.some(label => typeof label !== "string" || [...label].length > 100)) throw new Error("Invalid annual recap selection");
  if (sources.some(source => !Number.isInteger(srcW(source)) || !Number.isInteger(srcH(source)) || srcW(source) < 1 || srcH(source) < 1 || srcW(source) > 640 || srcH(source) > 640)) throw new Error("Annual recap exceeds the image bounds");
  const { cellWidth, cellHeight, caption, cols, width, height, outputWidth: w, outputHeight: h } = annualRecapGeometry(sources.length, scale, Math.max(...sources.map(srcW)), Math.max(...sources.map(srcH)));
  const canvas = document.createElement("canvas"); canvas.width = w; canvas.height = h;
  try {
    const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("Recap canvas is unavailable");
    ctx.scale(scale, scale); ctx.fillStyle = BG; ctx.fillRect(0, 0, width, height); ctx.fillStyle = INK; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.font = `600 52px ${fontVar("--font-fraunces", "Georgia, serif")}`; ctx.fillText(title, width / 2, PAD + HEADER_H / 2, width - PAD * 2);
    sources.forEach((source, index) => {
      const left = PAD + index % cols * (cellWidth + GAP), top = PAD + HEADER_H + Math.floor(index / cols) * (cellHeight + caption + GAP);
      const fit = Math.min(cellWidth / srcW(source), cellHeight / srcH(source), 1), imageW = srcW(source) * fit, imageH = srcH(source) * fit;
      ctx.drawImage(source, left + (cellWidth - imageW) / 2, top + (cellHeight - imageH) / 2, imageW, imageH);
      ctx.font = `400 25px ${fontVar("--font-geist-sans", "Arial, sans-serif")}`; ctx.fillText(labels[index], left + cellWidth / 2, top + cellHeight + caption / 2, cellWidth);
    });
    return canvas;
  } catch (error) { canvas.width = canvas.height = 0; throw error; }
}

export function recapToBlob(sources: Source[], title: string, scale = 2): Promise<Blob> {
  const canvas = composeRecap(sources, title, scale);
  return new Promise((resolve, reject) => {
    try { canvas.toBlob(
      (blob) => { canvas.width = canvas.height = 0; if (blob?.size && blob.size <= WEEKLY_RECAP_LIMITS.outputBytes) resolve(blob); else reject(new Error("The recap could not be encoded within its size limit.")); },
      "image/png",
    ); } catch (error) { canvas.width = canvas.height = 0; reject(error); }
  });
}

export interface WeeklyRecapSource { id: string; resolve(signal: AbortSignal): Promise<{ url: string; fingerprint: string }> }
export interface WeeklyRecapPorts {
  fetch: typeof fetch;
  decode(blob: Blob): Promise<Pick<ImageBitmap, "width" | "height" | "close">>;
  canvas(): HTMLCanvasElement;
  compose(sources: HTMLCanvasElement[], title: string): HTMLCanvasElement;
  encode(canvas: HTMLCanvasElement): Promise<Blob>;
}
const weeklyNative: WeeklyRecapPorts = {
  fetch: (...args) => fetch(...args), decode: blob => createImageBitmap(blob), canvas: () => document.createElement("canvas"),
  compose: (sources, title) => composeRecap(sources, title, 2),
  encode: canvas => new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("Recap encoding failed.")), "image/png")),
};
export function weeklyStripUrl(value: string, origin: string, path: string) {
  const base = new URL(origin), url = new URL(value);
  if (base.origin !== origin || base.username || base.password || base.protocol !== "https:" && !(base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)) || !/^[a-f0-9-]{36}\/[a-f0-9-]{36}\.png$/.test(path) || url.origin !== origin || url.username || url.password || url.hash || url.pathname !== `/storage/v1/object/sign/photobooth-strips/${path}` || [...url.searchParams.keys()].some(key => key !== "token") || url.searchParams.getAll("token").length !== 1 || !url.searchParams.get("token")) throw new Error("The private photo address could not be verified.");
  return url.href;
}
let weeklyOccupied = false;
export function renderWeeklyRecap(sources: readonly WeeklyRecapSource[], title: string, options: { signal?: AbortSignal; assertActive(): void; timeoutMs?: number; nativeTimeoutMs?: number }, ports: WeeklyRecapPorts = weeklyNative): Promise<{ blob: Blob; width: number; height: number }> {
  const items = [...sources], timeout = options.timeoutMs ?? WEEKLY_RECAP_LIMITS.timeoutMs, nativeTimeout = options.nativeTimeoutMs ?? WEEKLY_RECAP_LIMITS.nativeTimeoutMs;
  if (!items.length || items.length > WEEKLY_RECAP_LIMITS.sources || new Set(items.map(s => s.id)).size !== items.length || typeof title !== "string" || [...title].length > 120 || !Number.isInteger(timeout) || timeout < 1 || timeout > WEEKLY_RECAP_LIMITS.timeoutMs || !Number.isInteger(nativeTimeout) || nativeTimeout < 1 || nativeTimeout > WEEKLY_RECAP_LIMITS.nativeTimeoutMs) return Promise.reject(new Error("Choose up to 20 supported strips for this recap."));
  if (weeklyOccupied) return Promise.reject(new Error("The previous recap is still settling. Try again shortly."));
  const controller = new AbortController(); let failure: Error | undefined, rejectStop!: (error: Error) => void;
  const stopped = new Promise<never>((_, reject) => { rejectStop = reject; });
  const stop = (message: string) => { if (!failure) { failure = new Error(message); controller.abort(); rejectStop(failure); } };
  const abort = () => stop("Recap cancelled. Your saved strips are unchanged.");
  const check = () => { if (failure) throw failure; if (options.signal?.aborted) throw new Error("Recap cancelled."); options.assertActive(); };
  try { check(); } catch (error) { return Promise.reject(error); }
  weeklyOccupied = true; options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => stop("The recap took too long. Try again with fewer strips."), timeout);
  const native = async <T,>(work: () => Promise<T>, dispose?: (result: T) => void) => {
    check(); const timer = setTimeout(() => stop("The image processor took too long. Try again shortly."), nativeTimeout);
    try { const result = await work(); try { check(); } catch (error) { dispose?.(result); throw error; } return result; } finally { clearTimeout(timer); }
  };
  const task = (async () => {
    const thumbnails: HTMLCanvasElement[] = [], fingerprints: string[] = []; let output: HTMLCanvasElement | undefined;
    try {
      for (const source of items) {
        check(); const resolved = await source.resolve(controller.signal); check(); fingerprints.push(resolved.fingerprint);
        const response = await ports.fetch(resolved.url, { signal: controller.signal, credentials: "omit", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer" });
        try { check(); if (!response.ok || response.redirected || response.url && response.url !== resolved.url || response.headers.get("content-type")?.split(";", 1)[0] !== "image/png") throw new Error("A source photo is unavailable. Refresh the vault before trying again."); }
        catch (error) { void response.body?.cancel().catch(() => {}); throw error; }
        const bytes = await readRetainedBody(response, WEEKLY_RECAP_LIMITS.sourceBytes, controller.signal); check();
        const info = inspectRetainedPngHeader(bytes), bitmap = await native(() => ports.decode(new Blob([bytes], { type: "image/png" })), bitmap => bitmap.close());
        try {
          if (bitmap.width !== info.width || bitmap.height !== info.height) throw new Error("A source photo could not be verified.");
          const canvas = ports.canvas(); thumbnails.push(canvas);
          const scale = Math.min(1, 640 / bitmap.width, 640 / bitmap.height); canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
          const context = canvas.getContext("2d"); if (!context) throw new Error("The recap canvas is unavailable.");
          context.drawImage(bitmap as ImageBitmap, 0, 0, canvas.width, canvas.height); check();
        } finally { bitmap.close(); }
      }
      check(); output = ports.compose(thumbnails, title);
      if (!Number.isInteger(output.width) || !Number.isInteger(output.height) || output.width < 1 || output.height < 1 || output.width > 4096 || output.height > 4096 || output.width * output.height > 12 * 1024 * 1024) throw new Error("The recap exceeds the output limit.");
      const width = output.width, height = output.height, blob = await native(() => ports.encode(output!));
      if (blob.type !== "image/png" || !blob.size || blob.size > WEEKLY_RECAP_LIMITS.outputBytes) throw new Error("The recap exceeds the file size limit.");
      for (let index = 0; index < items.length; index++) { const current = await items[index].resolve(controller.signal); check(); if (current.fingerprint !== fingerprints[index]) throw new Error("A source photo changed. Refresh the vault before trying again."); }
      check(); return { blob, width, height };
    } finally {
      if (output) output.width = output.height = 0;
      for (const canvas of thumbnails) canvas.width = canvas.height = 0;
      weeklyOccupied = false; clearTimeout(timer); options.signal?.removeEventListener("abort", abort);
    }
  })();
  // Cancellation stops publication immediately; the allocation slot waits for late native work.
  return Promise.race([task, stopped]);
}
