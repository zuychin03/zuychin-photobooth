import { composeStrip, compositionSize, type ComposeInput } from "../compose";
import { RESOURCE_LIMITS } from "../projects/resource-bounds";
import { boundedRaster, exportGeometry, sourceResolution, type ExportGeometry, type ResolutionReport } from "./geometry";
import { getExportProfile, type ExportOptions, type ExportProfileId, type StillProfileId } from "./profiles";

export interface ExportArtifact {
  blob: Blob;
  mime: "image/png" | "image/jpeg" | "application/pdf";
  extension: "png" | "jpg" | "pdf";
  bytes: number;
  width: number;
  height: number;
  unit: "px" | "mm";
  geometry: ExportGeometry;
  resolution: ResolutionReport;
}
export class ExportJob {
  private readonly deadline: number;
  constructor(private readonly options: ExportOptions) {
    const timeout = options.timeoutMs ?? 30_000;
    if (!Number.isFinite(timeout) || timeout < 1 || timeout > 120_000) throw new Error("Export timeout must be between 1 and 120000 ms");
    this.deadline = Date.now() + timeout;
    this.check();
  }
  check() {
    if (this.options.signal?.aborted) throw new DOMException("Export cancelled", "AbortError");
    if (Date.now() >= this.deadline) throw new Error("Export timed out. Your original photos are unchanged.");
  }
  async wait<T>(pending: Promise<T>): Promise<T> {
    this.check();
    return new Promise<T>((resolve, reject) => {
      const signal = this.options.signal;
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
      const abort = () => { cleanup(); reject(new DOMException("Export cancelled", "AbortError")); };
      const timer = setTimeout(() => { cleanup(); reject(new Error("Export timed out. Your original photos are unchanged.")); }, Math.max(1, this.deadline - Date.now()));
      signal?.addEventListener("abort", abort, { once: true });
      pending.then(value => { cleanup(); try { this.check(); resolve(value); } catch (error) { reject(error); } }, error => { cleanup(); reject(error); });
    });
  }
}
export function createExportCanvas(width = 1, height = 1): HTMLCanvasElement {
  if (typeof document === "undefined") throw new Error("Image export requires a browser");
  if (![width, height].every(value => Number.isInteger(value) && value > 0 && value <= RESOURCE_LIMITS.photoEdge)
    || width * height > RESOURCE_LIMITS.photoPixels) throw new Error("Export canvas exceeds the image bounds");
  const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
  return canvas;
}
export function releaseExportCanvas(canvas: HTMLCanvasElement) { canvas.width = 0; canvas.height = 0; }
export async function encodeExportCanvas(canvas: HTMLCanvasElement, format: "png" | "jpeg", quality: number, job: ExportJob): Promise<Blob> {
  job.check();
  if (!["png", "jpeg"].includes(format) || !Number.isFinite(quality) || quality < .1 || quality > 1) throw new Error("Invalid image encoding settings");
  const mime = format === "png" ? "image/png" : "image/jpeg";
  const blob = await job.wait(new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(value => value ? resolve(value) : reject(new Error("Image encoding failed. Your original photos are unchanged.")), mime, quality);
  }));
  if (blob.type !== mime || !blob.size) throw new Error("The browser returned an unexpected image format");
  if (blob.size > RESOURCE_LIMITS.totalEncodedBytes) throw new Error("Export exceeds the 64 MiB file limit");
  return blob;
}
export function composeExportSource(input: ComposeInput, geometry: ExportGeometry, job: ExportJob): HTMLCanvasElement {
  job.check();
  const canvas = createExportCanvas();
  try { composeStrip(canvas, input, geometry.raster.scale); job.check(); return canvas; }
  catch (error) { releaseExportCanvas(canvas); throw error; }
}
export function paintExportGeometry(canvas: HTMLCanvasElement, source: HTMLCanvasElement, geometry: ExportGeometry, background = "#ffffff") {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas drawing is unavailable");
  ctx.save();
  try {
    ctx.fillStyle = background; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.scale(canvas.width / geometry.width, canvas.height / geometry.height);
    for (const { box, draw } of geometry.placements) {
      ctx.save(); ctx.beginPath(); ctx.rect(box.x, box.y, box.width, box.height); ctx.clip();
      ctx.drawImage(source, draw.x, draw.y, draw.width, draw.height); ctx.restore();
    }
    if (geometry.unit === "mm" && geometry.cutMarks) {
      ctx.strokeStyle = "#555555"; ctx.lineWidth = .15;
      for (const mark of exportCutMarks(geometry)) { ctx.beginPath(); ctx.moveTo(mark.x1, mark.y1); ctx.lineTo(mark.x2, mark.y2); ctx.stroke(); }
    }
  } finally { ctx.restore(); }
}
export function exportCutMarks(geometry: ExportGeometry): { x1: number; y1: number; x2: number; y2: number }[] {
  if (geometry.unit !== "mm" || !geometry.cutMarks) return [];
  const marks: { x1: number; y1: number; x2: number; y2: number }[] = [];
  for (const { tile } of geometry.placements) for (const x of [tile.x, tile.x + tile.width]) for (const y of [tile.y, tile.y + tile.height]) {
    const sx = x === tile.x ? -1 : 1, sy = y === tile.y ? -1 : 1;
    for (const line of [{ x1: x + sx * .8, y1: y, x2: x + sx * 3, y2: y }, { x1: x, y1: y + sy * .8, x2: x, y2: y + sy * 3 }]) {
      if ([line.x1, line.x2].every(value => value >= 0 && value <= geometry.width)
        && [line.y1, line.y2].every(value => value >= 0 && value <= geometry.height)) marks.push(line);
    }
  }
  if (geometry.profileId === "print-two-up") {
    marks.push({ x1: 50.8, y1: 0, x2: 50.8, y2: 1 }, { x1: 50.8, y1: geometry.height - 1, x2: 50.8, y2: geometry.height });
  }
  return marks;
}
export async function exportStill(input: ComposeInput, profileId: StillProfileId, options: ExportOptions = {}): Promise<ExportArtifact> {
  if (getExportProfile(profileId).kind !== "still") throw new Error("Choose an image export profile");
  const job = new ExportJob(options), geometry = exportGeometry(compositionSize(input), profileId, options);
  const output = createExportCanvas(geometry.width, geometry.height);
  let source: HTMLCanvasElement | undefined;
  try {
    source = composeExportSource(input, geometry, job);
    paintExportGeometry(output, source, geometry, input.style.frameColor);
    const format = options.format ?? "png", blob = await encodeExportCanvas(output, format, options.quality ?? .92, job);
    return { blob, bytes: blob.size, mime: format === "png" ? "image/png" : "image/jpeg", extension: format === "png" ? "png" : "jpg",
      width: geometry.width, height: geometry.height, unit: geometry.unit, geometry, resolution: sourceResolution(input, geometry) };
  } finally { if (source) releaseExportCanvas(source); releaseExportCanvas(output); }
}
export function renderExportPreview(canvas: HTMLCanvasElement, input: ComposeInput, profileId: ExportProfileId, options: ExportOptions = {}, maxEdge = 1200): ExportGeometry {
  if (!Number.isInteger(maxEdge) || maxEdge < 1 || maxEdge > 2048) throw new Error("Invalid preview size");
  const job = new ExportJob(options), geometry = exportGeometry(compositionSize(input), profileId, options);
  const ratio = Math.min(1, maxEdge / Math.max(geometry.width, geometry.height));
  const previewScale = geometry.unit === "mm" ? maxEdge / Math.max(geometry.width, geometry.height) : ratio;
  canvas.width = Math.max(1, Math.round(geometry.width * previewScale)); canvas.height = Math.max(1, Math.round(geometry.height * previewScale));
  const desiredScale = Math.min(geometry.raster.scale, Math.max(...geometry.placements.map(item => item.draw.width / geometry.source.width * previewScale)));
  const previewGeometry = { ...geometry, raster: boundedRaster(geometry.source, desiredScale) };
  const source = composeExportSource(input, previewGeometry, job);
  try { paintExportGeometry(canvas, source, geometry, geometry.unit === "mm" ? "#ffffff" : input.style.frameColor); job.check(); return geometry; }
  finally { releaseExportCanvas(source); }
}
