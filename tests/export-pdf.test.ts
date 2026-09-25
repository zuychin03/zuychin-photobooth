import assert from "node:assert/strict";
import test from "node:test";
import { deflateSync } from "node:zlib";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import { exportGeometry, mmToPoints } from "../lib/exports/geometry";
import { pdfFromStripPng } from "../lib/exports/pdf";
import { ExportJob, encodeExportCanvas, exportCutMarks } from "../lib/exports/still";
import type { PdfProfileId } from "../lib/exports/profiles";

function png(width: number, height: number): Uint8Array {
  function chunk(type: string, data: Uint8Array) {
    const result = Buffer.alloc(data.length + 12); result.writeUInt32BE(data.length); result.write(type, 4); result.set(data, 8);
    let crc = 0xffffffff;
    for (const byte of result.subarray(4, result.length - 4)) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4); return result;
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.alloc((width * 3 + 1) * height))), chunk("IEND", Buffer.alloc(0))]);
}
test("actual PDF files have exact physical pages and reuse one embedded raster for repeated strips", async () => {
  const image = png(600, 1800);
  for (const [profile, count, width, height] of [["print-strip", 1, 50.8, 152.4], ["print-two-up", 2, 101.6, 152.4], ["a4-contact", 3, 210, 297]] as [PdfProfileId, number, number, number][]) {
    const geometry = exportGeometry({ width: 536, height: 1600 }, profile);
    const blob = await pdfFromStripPng(image, geometry);
    assert.equal(blob.type, "application/pdf"); assert.ok(blob.size > 0);
    const document = await PDFDocument.load(await blob.arrayBuffer());
    assert.equal(document.getPageCount(), 1);
    const page = document.getPage(0);
    assert.ok(Math.abs(page.getWidth() - mmToPoints(width)) < 1e-9);
    assert.ok(Math.abs(page.getHeight() - mmToPoints(height)) < 1e-9);
    assert.equal(document.catalog.getOrCreateViewerPreferences().getPrintScaling(), "None");
    const resources = page.node.Resources()!, objects = resources.lookup(PDFName.of("XObject"), PDFDict);
    const references = new Set(objects.values().map(ref => ref.toString()));
    assert.equal(references.size, 1);
    const stream = document.context.lookup(objects.values()[0]);
    assert.ok(stream instanceof PDFRawStream);
    assert.equal(stream.dict.get(PDFName.of("Width"))?.toString(), "600");
    assert.equal(stream.dict.get(PDFName.of("Height"))?.toString(), "1800");
    const contents = page.node.Contents() as PDFArray;
    const decoded = Array.from({ length: contents.size() }, (_, i) => new TextDecoder().decode(decodePDFRawStream(contents.lookup(i, PDFRawStream)).decode())).join("\n");
    assert.equal((decoded.match(/\bDo\b/g) ?? []).length, count);
    assert.ok(decoded.includes("144 0 0 432"));
  }
});
test("PDF rejects wrong raster sizes and cancelled jobs, cut marks remain inside paper", async () => {
  const geometry = exportGeometry({ width: 536, height: 1600 }, "a4-contact");
  await assert.rejects(pdfFromStripPng(png(10, 10), geometry), /600 × 1800/);
  const controller = new AbortController(); controller.abort();
  assert.throws(() => new ExportJob({ signal: controller.signal }), { name: "AbortError" });
  for (const mark of exportCutMarks(geometry)) {
    assert.ok(mark.x1 >= 0 && mark.x2 <= geometry.width && mark.y1 >= 0 && mark.y2 <= geometry.height);
  }
  assert.deepEqual(exportCutMarks({ ...geometry, cutMarks: false }), []);
});
test("encoding rejects MIME fallback, null callback, and timeout without losing original canvas", async () => {
  const fake = (reply: Blob | null) => ({ width: 10, height: 10, toBlob: (callback: BlobCallback) => callback(reply) }) as HTMLCanvasElement;
  const source = fake(new Blob(["fallback"], { type: "image/png" }));
  await assert.rejects(encodeExportCanvas(source, "jpeg", .9, new ExportJob({})), /unexpected image format/);
  assert.equal(source.width, 10);
  await assert.rejects(encodeExportCanvas(fake(null), "png", 1, new ExportJob({})), /encoding failed/);
  const hangs = { toBlob: () => {} } as unknown as HTMLCanvasElement;
  await assert.rejects(encodeExportCanvas(hangs, "png", 1, new ExportJob({ timeoutMs: 10 })), /timed out/);
  const controller = new AbortController(), pending = encodeExportCanvas(hangs, "png", 1, new ExportJob({ signal: controller.signal }));
  controller.abort(); await assert.rejects(pending, { name: "AbortError" });
});
