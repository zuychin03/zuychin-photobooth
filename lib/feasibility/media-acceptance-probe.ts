import { createProject, appendProjectMedia } from "../projects/model";
import { inspectProjectImage, projectImageToCanvas } from "../projects/images";
import { projectBlobHash } from "../projects/bundle";
import { openProjectRepository } from "../projects/storage";
import { exportStill } from "../exports/still";
import { getLayout } from "../layouts";
import { runProjectRenderProbe } from "./project-render-probe";
import { runExportCompositionProbe } from "./export-probe";
import { runMotionProbe } from "../exports/motion-probe";
import { RESOURCE_LIMITS } from "../projects/resource-bounds";
import { flattenedMemoryProject } from "../memories/duplicate-image";

export function gpsProbeJpeg(jpeg: Uint8Array): Uint8Array<ArrayBuffer> {
  const exif = new Uint8Array(146), t = new DataView(exif.buffer, 6);
  exif.set(new TextEncoder().encode("Exif\0\0II")); t.setUint16(2, 42, true); t.setUint32(4, 8, true); t.setUint16(8, 1, true);
  t.setUint16(10, 0x8825, true); t.setUint16(12, 4, true); t.setUint32(14, 1, true); t.setUint32(18, 26, true);
  t.setUint16(26, 4, true);
  for (const [index, tag, type, count, value] of [[0, 1, 2, 2, 78], [1, 2, 5, 3, 80], [2, 3, 2, 2, 69], [3, 4, 5, 3, 104]]) {
    const offset = 28 + index * 12; t.setUint16(offset, tag, true); t.setUint16(offset + 2, type, true); t.setUint32(offset + 4, count, true); t.setUint32(offset + 8, value, true);
  }
  for (const [offset, degrees] of [[80, 12], [104, 34]]) for (let i = 0; i < 3; i++) { t.setUint32(offset + i * 8, i === 0 ? degrees : 0, true); t.setUint32(offset + i * 8 + 4, 1, true); }
  const bytes = new Uint8Array(jpeg.length + exif.length + 4); bytes.set(jpeg.subarray(0, 2)); bytes.set([255, 225, 0, exif.length + 2], 2); bytes.set(exif, 6); bytes.set(jpeg.subarray(2), exif.length + 6); return bytes;
}
export function derivativeMetadataBlocks(bytes: Uint8Array): string[] {
  const found: string[] = [], view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes[0] === 255 && bytes[1] === 216) {
    for (let at = 2; at + 4 <= bytes.length;) { if (bytes[at] !== 255) throw new Error("Invalid JPEG segment"); const marker = bytes[at + 1]; if (marker === 218 || marker === 217) break; const size = view.getUint16(at + 2); if (size < 2 || at + size + 2 > bytes.length) throw new Error("Invalid JPEG size"); if (marker === 225 || marker === 237 || marker === 254) found.push(`JPEG-${marker}`); at += size + 2; }
  } else {
    for (let at = 8; at + 12 <= bytes.length;) { const size = view.getUint32(at), name = String.fromCharCode(...bytes.subarray(at + 4, at + 8)); if (at + size + 12 > bytes.length) throw new Error("Invalid PNG size"); if (["eXIf", "tEXt", "iTXt", "zTXt"].includes(name)) found.push(name); at += size + 12; }
  }
  return found;
}
async function metadataRoundTrip() {
  const databaseName = `pb-metadata-probe-${crypto.randomUUID()}`, canvas = document.createElement("canvas"); canvas.width = 120; canvas.height = 80; canvas.getContext("2d")!.fillRect(0, 0, 120, 80);
  let decoded: HTMLCanvasElement | undefined, repo: Awaited<ReturnType<typeof openProjectRepository>> | undefined;
  try {
    const jpeg = await new Promise<Blob>((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error("JPEG failed")), "image/jpeg"));
    const bytes = gpsProbeJpeg(new Uint8Array(await jpeg.arrayBuffer())), original = new Blob([bytes], { type: "image/jpeg" }), hash = await projectBlobHash(original);
    if (!derivativeMetadataBlocks(bytes).includes("JPEG-225")) throw new Error("GPS fixture missing EXIF");
    const info = await inspectProjectImage(original), empty = createProject({ id: "gps-original", scope: { kind: "device" }, participants: [{ id: "synthetic", role: "A" }] });
    const project = appendProjectMedia(empty, [{ ...info, id: "original", kind: "photo", participantId: "synthetic", bytes: original.size }], { ...empty.sourceOrder, A: ["original"] }, new Date().toISOString());
    repo = await openProjectRepository({ kind: "device" }, { databaseName }); await repo.save(empty, new Map(), null); await repo.save(project, new Map([["original", original]]), 0); repo.close(); repo = await openProjectRepository({ kind: "device" }, { databaseName });
    const loaded = await repo.load(project.id); if (!loaded || loaded.kind !== "current") throw new Error("Project reopen failed");
    const stored = loaded.media.get("original")!; if (await projectBlobHash(stored) !== hash) throw new Error("Stored original changed"); decoded = await projectImageToCanvas(stored, info);
    const results = [];
    for (const format of ["png", "jpeg"] as const) { const result = await exportStill({ layout: getLayout("strip4"), shots: { A: [decoded, decoded, decoded, decoded] }, stickers: [], style: { frameColor: "#ffffff", inkColor: "#000000", patternId: "none", filterId: "none", caption: "", showDate: false, stickerStyle: "flat" } }, "original", { format }); if (derivativeMetadataBlocks(new Uint8Array(await result.blob.arrayBuffer())).length) throw new Error(`${format} retained metadata`); await inspectProjectImage(result.blob); results.push({ format, bytes: result.bytes, width: result.width, height: result.height }); }
    if (await projectBlobHash((await repo.load(project.id))!.media.get("original")!) !== hash) throw new Error("Export changed stored original");
    const finished = await exportStill({ layout: getLayout("strip4"), shots: { A: [decoded, decoded, decoded, decoded] }, stickers: [], style: { frameColor: "#ffffff", inkColor: "#000000", patternId: "none", filterId: "none", caption: "", showDate: false, stickerStyle: "flat" } }, "original", { format: "png" });
    const ownerId = "00000000-0000-4000-8000-000000000001", copy = flattenedMemoryProject({ version: 1, id: ownerId, availability: "available", bytesLimit: 16777216, blob: finished.blob, width: finished.width, height: finished.height, sha256: await projectBlobHash(finished.blob) }, ownerId);
    repo.close(); repo = await openProjectRepository(copy.scope, { databaseName }); await repo.save(copy, new Map([["finished-image", finished.blob]]), null); repo.close(); repo = await openProjectRepository(copy.scope, { databaseName });
    const restored = await repo.load(copy.id); if (restored?.kind !== "current" || restored.project.capturedAt !== null || await projectBlobHash(restored.media.get("finished-image")!) !== await projectBlobHash(finished.blob)) throw new Error("Flattened copy changed bytes or date");
    repo.close(); repo = await openProjectRepository({ kind: "account", ownerId: "00000000-0000-4000-8000-000000000002" }, { databaseName }); if (await repo.load(copy.id)) throw new Error("Flattened copy leaked across accounts");
    return { originalBytes: original.size, originalHash: hash, derivatives: results, flattenedCopy: "Exact PNG reopened, unknown camera date retained, other account cannot read" };
  } finally { repo?.close(); canvas.width = canvas.height = 0; if (decoded) decoded.width = decoded.height = 0; await new Promise<void>((resolve, reject) => { const r = indexedDB.deleteDatabase(databaseName); r.onsuccess = () => resolve(); r.onerror = () => reject(r.error); r.onblocked = () => reject(new Error("Cleanup blocked")); }); }
}
export async function runMediaAcceptanceProbe(progress: (message: string) => void, signal?: AbortSignal, repetitions: 6 | 30 = 6) {
  if (process.env.NODE_ENV !== "development") throw new Error("Development only");
  if (repetitions !== 6 && repetitions !== 30) throw new Error("Choose six or thirty bounded rounds");
  const rounds = [], heapSamples: number[] = [], started = performance.now();
  const sample = () => { const value = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize; if (value !== undefined) heapSamples.push(value); };
  const timer = setInterval(sample, 100); sample();
  try { for (let index = 0; index < repetitions; index++) {
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError"); progress(`Round ${index + 1} of ${repetitions}: GPS import, reopen, edits, stills, cancelled GIF, GIF retry and MP4/WebM.`);
    const metadata = await metadataRoundTrip(), edits = await runProjectRenderProbe(), composition = await runExportCompositionProbe(), motion = await runMotionProbe(signal);
    if (edits.some(r => !r.passed) || [...composition, ...motion].some(r => r.status !== "pass")) throw new Error(JSON.stringify({ index, edits, composition, motion }));
    sample(); rounds.push({ round: index + 1, elapsedMs: Math.round(performance.now() - started), jsHeapBytes: heapSamples.at(-1) ?? null, metadata, edits: edits.length, composition: composition.length, motion });
  }
  return { passed: true, repetitions: rounds.length, elapsedMs: Math.round(performance.now() - started), heap: { samples: heapSamples.length, start: heapSamples[0] ?? null, end: heapSamples.at(-1) ?? null, peak: heapSamples.length ? Math.max(...heapSamples) : null, nativeGpuMeasured: false, forcedGc: false }, resourceLimits: RESOURCE_LIMITS, rounds };
  } finally { clearInterval(timer); }
}
