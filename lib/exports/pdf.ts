import { compositionSize, type ComposeInput } from "../compose";
import { RESOURCE_LIMITS } from "../projects/resource-bounds";
import { inspectImageHeader } from "../projects/images";
import { exportGeometry, mmToPixels, mmToPoints, sourceResolution, type ExportGeometry } from "./geometry";
import { getExportProfile, type ExportOptions, type PdfProfileId } from "./profiles";
import { ExportJob, composeExportSource, createExportCanvas, encodeExportCanvas, exportCutMarks, paintExportGeometry, releaseExportCanvas, type ExportArtifact } from "./still";

export async function pdfFromStripPng(png: Uint8Array, geometry: ExportGeometry, job = new ExportJob({})): Promise<Blob> {
  if (geometry.unit !== "mm" || getExportProfile(geometry.profileId).kind !== "pdf") throw new Error("Choose a physical print profile");
  job.check();
  if (png.byteLength > RESOURCE_LIMITS.totalEncodedBytes) throw new Error("PDF image exceeds the 64 MiB file limit");
  const header = inspectImageHeader(png);
  if (header.mime !== "image/png" || header.width !== 600 || header.height !== 1800) throw new Error("PDF strip raster must be 600 × 1800 pixels");
  const { PDFDocument, PrintScaling, rgb } = await job.wait(import("pdf-lib"));
  const doc = await job.wait(PDFDocument.create());
  doc.catalog.getOrCreateViewerPreferences().setPrintScaling(PrintScaling.None);
  const image = await job.wait(doc.embedPng(png));
  if (image.width !== 600 || image.height !== 1800) throw new Error("Decoded PDF strip dimensions do not match the image header");
  const page = doc.addPage([mmToPoints(geometry.width), mmToPoints(geometry.height)]);
  for (const { tile } of geometry.placements) {
    job.check();
    page.drawImage(image, { x: mmToPoints(tile.x), y: mmToPoints(geometry.height - tile.y - tile.height), width: mmToPoints(tile.width), height: mmToPoints(tile.height) });
  }
  for (const line of exportCutMarks(geometry)) page.drawLine({ start: { x: mmToPoints(line.x1), y: mmToPoints(geometry.height - line.y1) }, end: { x: mmToPoints(line.x2), y: mmToPoints(geometry.height - line.y2) }, thickness: mmToPoints(.15), color: rgb(.33, .33, .33) });
  const bytes = await job.wait(doc.save());
  if (bytes.byteLength > RESOURCE_LIMITS.totalEncodedBytes) throw new Error("PDF exceeds the 64 MiB file limit");
  return new Blob([new Uint8Array(bytes)], { type: "application/pdf" });
}
export async function exportPdf(input: ComposeInput, profileId: PdfProfileId, options: ExportOptions = {}): Promise<ExportArtifact> {
  if (getExportProfile(profileId).kind !== "pdf") throw new Error("Choose a physical print profile");
  const job = new ExportJob(options), geometry = exportGeometry(compositionSize(input), profileId, options);
  const first = geometry.placements[0], tile = createExportCanvas(mmToPixels(first.tile.width), mmToPixels(first.tile.height));
  let source: HTMLCanvasElement | undefined;
  try {
    source = composeExportSource(input, geometry, job);
    const local: ExportGeometry = { ...geometry, width: first.tile.width, height: first.tile.height, cutMarks: false,
      placements: [{ tile: { ...first.tile, x: 0, y: 0 }, box: { ...first.box, x: first.box.x - first.tile.x, y: first.box.y - first.tile.y }, draw: { ...first.draw, x: first.draw.x - first.tile.x, y: first.draw.y - first.tile.y } }] };
    paintExportGeometry(tile, source, local);
    const png = await encodeExportCanvas(tile, "png", 1, job);
    releaseExportCanvas(source); source = undefined;
    const blob = await pdfFromStripPng(new Uint8Array(await job.wait(png.arrayBuffer())), geometry, job);
    return { blob, bytes: blob.size, mime: "application/pdf", extension: "pdf", width: geometry.width, height: geometry.height, unit: "mm", geometry, resolution: sourceResolution(input, geometry) };
  } finally { if (source) releaseExportCanvas(source); releaseExportCanvas(tile); }
}
