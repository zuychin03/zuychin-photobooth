import { inspectImageHeader } from "../projects/images";
import { RESOURCE_LIMITS } from "../projects/resource-bounds";
import { photoPlacement } from "../projects/transforms";

export interface ThenNowCrop { x: number; y: number; width: number; height: number }
export interface ThenNowAlignment { zoom: number; offsetX: number; offsetY: number; rotation: 0 | 90 | 180 | 270; mirror: boolean }
export type ThenNowProvenance = { kind: "project-original" | "project-strip"; projectId: string; sourceMediaId: string } | { kind: "imported-image" | "imported-strip" };
export interface ThenNowPlan {
  version: 1;
  reference: { mediaId: string; provenance: ThenNowProvenance; date: string | null; crop: ThenNowCrop | null };
  alignment: ThenNowAlignment;
  ghostOpacity: number;
}
export interface ThenNowComparisonOptions { width: number; height: number; aspect?: number; currentDate: string | null; currentAlignment?: ThenNowAlignment }
export const THEN_NOW_LIMITS = Object.freeze({ previewEdge: 1024, outputEdge: 2048, outputPixels: 4 * 1024 * 1024 });
export const DEFAULT_THEN_NOW_ALIGNMENT: Readonly<ThenNowAlignment> = Object.freeze({ zoom: 1, offsetX: 0, offsetY: 0, rotation: 0, mirror: false });
const invalid = (): never => { throw new Error("Invalid Then & Now reference or adjustment"); };
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalid();
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some(key => typeof key !== "string" || !keys.includes(key) || !("value" in Object.getOwnPropertyDescriptor(value, key)!))) return invalid();
  return value as Record<string, unknown>;
}
const id = (value: unknown): string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value) ? value : invalid();
const number = (value: unknown, min: number, max: number): number => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : invalid();
function date(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000")) return invalid();
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return invalid();
  return value;
}
function alignment(value: unknown): ThenNowAlignment {
  const a = record(value, ["zoom", "offsetX", "offsetY", "rotation", "mirror"]);
  if (![0, 90, 180, 270].includes(a.rotation as number) || typeof a.mirror !== "boolean") return invalid();
  return Object.freeze({ zoom: number(a.zoom, 1, 4), offsetX: number(a.offsetX, -1, 1), offsetY: number(a.offsetY, -1, 1), rotation: a.rotation as ThenNowAlignment["rotation"], mirror: a.mirror });
}
export function validateThenNowPlan(input: unknown): ThenNowPlan {
  const p = record(input, ["version", "reference", "alignment", "ghostOpacity"]), r = record(p.reference, ["mediaId", "provenance", "date", "crop"]);
  if (p.version !== 1 || !r.provenance || typeof r.provenance !== "object") return invalid();
  const descriptor = Object.getOwnPropertyDescriptor(r.provenance, "kind");
  if (!descriptor || !("value" in descriptor)) return invalid();
  const kind = descriptor.value, project = kind === "project-original" || kind === "project-strip";
  const source = record(r.provenance, project ? ["kind", "projectId", "sourceMediaId"] : ["kind"]);
  if (!project && kind !== "imported-image" && kind !== "imported-strip") return invalid();
  const provenance: ThenNowProvenance = project ? { kind, projectId: id(source.projectId), sourceMediaId: id(source.sourceMediaId) } : { kind };
  let crop: ThenNowCrop | null = null;
  if (r.crop !== null) {
    const c = record(r.crop, ["x", "y", "width", "height"]);
    crop = { x: number(c.x, 0, 1), y: number(c.y, 0, 1), width: number(c.width, Number.EPSILON, 1), height: number(c.height, Number.EPSILON, 1) };
    if (crop.x + crop.width > 1 || crop.y + crop.height > 1) return invalid();
    Object.freeze(crop);
  }
  if ((kind === "project-strip" || kind === "imported-strip") && crop === null) return invalid();
  return Object.freeze({ version: 1, reference: Object.freeze({ mediaId: id(r.mediaId), provenance: Object.freeze(provenance), date: date(r.date), crop }), alignment: alignment(p.alignment), ghostOpacity: number(p.ghostOpacity, 0, 1) });
}
export function thenNowDateLabel(value: string | null): string {
  const checked = date(value); return checked === null ? "Unknown date" : `${checked.slice(8, 10)}/${checked.slice(5, 7)}/${checked.slice(0, 4)}`;
}
export function thenNowDateFromInstant(instant: string | null, timeZone: string): string | null {
  if (instant === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(instant) || !Number.isFinite(Date.parse(instant))) return invalid();
  const parts = new Intl.DateTimeFormat("en-AU", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(instant));
  const part = (type: string) => parts.find(value => value.type === type)?.value ?? "";
  return date(`${part("year").padStart(4, "0")}-${part("month")}-${part("day")}`);
}
function image(source: HTMLCanvasElement): void {
  if (![source.width, source.height].every(value => Number.isSafeInteger(value) && value > 0 && value <= RESOURCE_LIMITS.photoEdge) || source.width * source.height > RESOURCE_LIMITS.photoPixels) return invalid();
}
function target(ctx: CanvasRenderingContext2D, rect: ThenNowCrop): void {
  if (![ctx.canvas.width, ctx.canvas.height].every(value => Number.isSafeInteger(value) && value > 0 && value <= THEN_NOW_LIMITS.outputEdge) || ctx.canvas.width * ctx.canvas.height > THEN_NOW_LIMITS.outputPixels) return invalid();
  if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.x < 0 || rect.y < 0 || rect.width <= 0 || rect.height <= 0 || rect.x + rect.width > ctx.canvas.width || rect.y + rect.height > ctx.canvas.height) return invalid();
}
export function thenNowPlacement(sourceWidth: number, sourceHeight: number, crop: ThenNowCrop | null, rect: Pick<ThenNowCrop, "width" | "height">, edit: ThenNowAlignment) {
  const selected = crop ?? { x: 0, y: 0, width: 1, height: 1 };
  if (![sourceWidth, sourceHeight].every(value => Number.isSafeInteger(value) && value > 0 && value <= RESOURCE_LIMITS.photoEdge) || sourceWidth * sourceHeight > RESOURCE_LIMITS.photoPixels
    || ![selected.x, selected.y, selected.width, selected.height].every(Number.isFinite) || selected.x < 0 || selected.y < 0 || selected.width <= 0 || selected.height <= 0 || selected.x + selected.width > 1 || selected.y + selected.height > 1) return invalid();
  const sw = selected.width * sourceWidth, sh = selected.height * sourceHeight;
  if (sw < 1 || sh < 1) return invalid();
  const place = photoPlacement(sw, sh, rect.width, rect.height, { ...alignment(edit), sourceIndex: 0, filterId: null });
  return { ...place, sourceX: selected.x * sourceWidth, sourceY: selected.y * sourceHeight, sourceWidth: sw, sourceHeight: sh };
}
function draw(ctx: CanvasRenderingContext2D, source: HTMLCanvasElement, crop: ThenNowCrop | null, edit: ThenNowAlignment, rect: ThenNowCrop): void {
  image(source); target(ctx, rect);
  const p = thenNowPlacement(source.width, source.height, crop, rect, edit);
  ctx.save();
  try {
    ctx.beginPath(); ctx.rect(rect.x, rect.y, rect.width, rect.height); ctx.clip();
    ctx.translate(rect.x + rect.width / 2 + p.translateX, rect.y + rect.height / 2 + p.translateY); ctx.rotate(p.radians); ctx.scale(edit.mirror ? -1 : 1, 1);
    ctx.drawImage(source, p.sourceX, p.sourceY, p.sourceWidth, p.sourceHeight, -p.drawWidth / 2, -p.drawHeight / 2, p.drawWidth, p.drawHeight);
  } finally { ctx.restore(); }
}
export function drawThenNowGhost(ctx: CanvasRenderingContext2D, reference: HTMLCanvasElement, input: ThenNowPlan, rect: ThenNowCrop): void {
  const p = validateThenNowPlan(input); ctx.save();
  try { ctx.globalAlpha *= p.ghostOpacity; draw(ctx, reference, p.reference.crop, p.alignment, rect); }
  finally { ctx.restore(); }
}
function metrics(width: number, mode: "comparison" | "alternating") {
  const margin = width * 0.025, font = width * (mode === "comparison" ? 0.0375 : 0.045);
  return { margin, font, footer: font * 3.4 + margin, panel: mode === "comparison" ? (width - margin * 3) / 2 : width - margin * 2 };
}
export function thenNowOutputSize(requestedWidth: number, aspect: number, mode: "comparison" | "alternating"): { width: number; height: number; aspect: number } {
  if (!Number.isSafeInteger(requestedWidth) || requestedWidth < 320 || requestedWidth > THEN_NOW_LIMITS.outputEdge || !["comparison", "alternating"].includes(mode)) return invalid();
  number(aspect, 0.25, 4);
  const unit = metrics(1, mode), heightRatio = unit.margin + unit.panel / aspect + unit.footer;
  const width = Math.min(requestedWidth, Math.floor(THEN_NOW_LIMITS.outputEdge / heightRatio)), height = Math.ceil(width * heightRatio);
  if (width < 320 || width * height > THEN_NOW_LIMITS.outputPixels) return invalid();
  return { width, height, aspect };
}
function comparison(ctx: CanvasRenderingContext2D, options: ThenNowComparisonOptions, mode: "comparison" | "alternating") {
  const { width, height } = options;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 320 || height < 64 || ctx.canvas.width !== width || ctx.canvas.height !== height) return invalid();
  target(ctx, { x: 0, y: 0, width, height }); date(options.currentDate);
  const layout = metrics(width, mode), photoHeight = options.aspect === undefined ? height - layout.margin - layout.footer : layout.panel / number(options.aspect, 0.25, 4);
  if (photoHeight <= 0 || layout.margin + photoHeight + layout.footer > height + 0.000001) return invalid();
  return { width, height, ...layout, photoHeight, now: alignment(options.currentAlignment ?? DEFAULT_THEN_NOW_ALIGNMENT) };
}
function background(ctx: CanvasRenderingContext2D, width: number, height: number) {
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over"; ctx.filter = "none"; ctx.fillStyle = "#f5f1eb"; ctx.fillRect(0, 0, width, height);
}
function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxWidth: number, font: number) {
  ctx.fillStyle = "#342b2b"; ctx.font = `${font}px sans-serif`; ctx.textAlign = "left"; ctx.textBaseline = "top"; ctx.fillText(text, x, y, maxWidth);
}
function stripLabel(plan: ThenNowPlan): string {
  const crop = plan.reference.crop;
  return crop && crop.x === 0 && crop.y === 0 && crop.width === 1 && crop.height === 1 ? "Whole strip reference" : "Selected strip crop";
}
export function drawThenNowComparison(ctx: CanvasRenderingContext2D, reference: HTMLCanvasElement, current: HTMLCanvasElement, input: ThenNowPlan, options: ThenNowComparisonOptions): void {
  const p = validateThenNowPlan(input), { width, height, now, margin, panel, photoHeight, font } = comparison(ctx, options, "comparison"), captionY = margin + photoHeight + font * 0.5;
  image(reference); image(current); ctx.save();
  try {
    background(ctx, width, height);
    draw(ctx, reference, p.reference.crop, p.alignment, { x: margin, y: margin, width: panel, height: photoHeight });
    draw(ctx, current, null, now, { x: margin * 2 + panel, y: margin, width: panel, height: photoHeight });
    label(ctx, `Then · ${thenNowDateLabel(p.reference.date)}`, margin, captionY, panel, font);
    label(ctx, `Now · ${thenNowDateLabel(options.currentDate)}`, margin * 2 + panel, captionY, panel, font);
    if (p.reference.provenance.kind.endsWith("strip")) label(ctx, stripLabel(p), margin, captionY + font * 1.5, panel, font);
  } finally { ctx.restore(); }
}
export function drawThenNowAlternatingFrame(ctx: CanvasRenderingContext2D, reference: HTMLCanvasElement, current: HTMLCanvasElement, input: ThenNowPlan, phase: "then" | "now", options: ThenNowComparisonOptions): void {
  if (phase !== "then" && phase !== "now") return invalid();
  const p = validateThenNowPlan(input), { width, height, now, margin, panel, photoHeight, font } = comparison(ctx, options, "alternating"), old = phase === "then", captionY = margin + photoHeight + font * 0.5;
  image(reference); image(current); ctx.save();
  try {
    background(ctx, width, height);
    draw(ctx, old ? reference : current, old ? p.reference.crop : null, old ? p.alignment : now, { x: margin, y: margin, width: panel, height: photoHeight });
    label(ctx, `${old ? "Then" : "Now"} · ${thenNowDateLabel(old ? p.reference.date : options.currentDate)}`, margin, captionY, panel, font);
    if (old && p.reference.provenance.kind.endsWith("strip")) label(ctx, stripLabel(p), margin, captionY + font * 1.5, panel, font);
  } finally { ctx.restore(); }
}

export interface PreparedThenNowReference { readonly canvas: HTMLCanvasElement; readonly plan: ThenNowPlan; dispose(): void }
export interface ThenNowPrepareOptions { signal?: AbortSignal; decode?: (blob: Blob) => Promise<HTMLCanvasElement>; createCanvas?: () => HTMLCanvasElement }
let preparing = false;
async function decodeReference(blob: Blob): Promise<HTMLCanvasElement> {
  const info = inspectImageHeader(new Uint8Array(await blob.arrayBuffer()));
  const bitmap = await createImageBitmap(blob.slice(0, blob.size, info.mime), { imageOrientation: "from-image" });
  let canvas: HTMLCanvasElement | null = null;
  try {
    if (bitmap.width !== info.width || bitmap.height !== info.height) throw new Error("Reference image dimensions could not be verified");
    canvas = document.createElement("canvas");
    const scale = Math.min(1, THEN_NOW_LIMITS.previewEdge / Math.max(info.width, info.height));
    canvas.width = Math.max(1, Math.round(info.width * scale)); canvas.height = Math.max(1, Math.round(info.height * scale));
    const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("Reference canvas is unavailable");
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height); return canvas;
  } catch (error) { if (canvas) canvas.width = canvas.height = 0; throw error; }
  finally { bitmap.close(); }
}
export async function prepareThenNowReference(blob: Blob, input: ThenNowPlan, options: ThenNowPrepareOptions = {}): Promise<PreparedThenNowReference> {
  const plan = validateThenNowPlan(input), signal = options.signal;
  if (!blob.size || blob.size > RESOURCE_LIMITS.photoBytes) return invalid();
  if (signal?.aborted) throw new DOMException("Reference preparation cancelled", "AbortError");
  if (preparing) throw new Error("Another reference is still being prepared");
  preparing = true;
  let cancelled = false, timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined;
  const work = (async (): Promise<PreparedThenNowReference> => {
    let original: HTMLCanvasElement | null = null, canvas: HTMLCanvasElement | null = null;
    try {
      original = await (options.decode ?? decodeReference)(blob); image(original);
      if (cancelled || signal?.aborted) throw new DOMException("Reference preparation cancelled", "AbortError");
      const scale = Math.min(1, THEN_NOW_LIMITS.previewEdge / Math.max(original.width, original.height));
      canvas = (options.createCanvas ?? (() => document.createElement("canvas")))();
      canvas.width = Math.max(1, Math.round(original.width * scale)); canvas.height = Math.max(1, Math.round(original.height * scale));
      const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("Reference canvas is unavailable");
      ctx.drawImage(original, 0, 0, canvas.width, canvas.height);
      const owned = canvas; let disposed = false;
      return { canvas: owned, plan, dispose() { if (!disposed) { disposed = true; owned.width = owned.height = 0; } } };
    } catch (error) { if (canvas) canvas.width = canvas.height = 0; throw error; }
    finally { if (original) original.width = original.height = 0; preparing = false; }
  })();
  const deadline = new Promise<never>((_, reject) => {
    abort = () => { cancelled = true; reject(new DOMException("Reference preparation cancelled", "AbortError")); };
    signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => { cancelled = true; reject(new Error("Reference decoding timed out")); }, 10_000);
  });
  try { return await Promise.race([work, deadline]); }
  finally { clearTimeout(timer); if (abort) signal?.removeEventListener("abort", abort); }
}
