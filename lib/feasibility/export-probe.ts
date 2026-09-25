import { composeStrip, compositionSize, type ComposeInput } from "../compose";
import { CELL_GAP, CELL_W, STRIP_MARGIN, getLayout } from "../layouts";
import { projectBlobHash } from "../projects/bundle";
import { createPhotoLoopFrames } from "../exports/photo-loop";
import { ExportJob, createExportCanvas, encodeExportCanvas, exportStill, releaseExportCanvas, renderExportPreview } from "../exports/still";
import type { ExportGeometry } from "../exports/geometry";
import type { ProbeResult } from "./types";

export function flatStripProbeSamples(geometry: ExportGeometry, colours: readonly (readonly number[])[]) {
  const { draw, box } = geometry.placements[0], cellHeight = CELL_W / (3 / 2), samples: { x: number; y: number; expected: readonly number[] }[] = [];
  for (const y of [.03, .15, .28, .4, .52, .65, .78, .9, .97]) for (const x of [.03, .2, .5, .8, .97]) {
    const px = x * geometry.width, py = y * geometry.height;
    const sx = (px - draw.x) / draw.width * geometry.source.width, sy = (py - draw.y) / draw.height * geometry.source.height;
    let expected: readonly number[] = [255, 255, 255];
    const edges = [box.x, box.x + box.width, draw.x, draw.x + draw.width];
    if (edges.some(edge => Math.abs(px - edge) < 8) || [box.y, box.y + box.height, draw.y, draw.y + draw.height].some(edge => Math.abs(py - edge) < 8)) continue;
    if (px >= box.x && px <= box.x + box.width && py >= box.y && py <= box.y + box.height && sx >= 0 && sx <= geometry.source.width && sy >= 0 && sy <= geometry.source.height) {
      let boundary = false;
      for (let cell = 0; cell < 4; cell++) {
        const top = STRIP_MARGIN + cell * (cellHeight + CELL_GAP), bottom = top + cellHeight;
        if ([STRIP_MARGIN, STRIP_MARGIN + CELL_W].some(edge => Math.abs(sx - edge) < 16) || [top, bottom].some(edge => Math.abs(sy - edge) < 16)) { boundary = true; break; }
        if (sx > STRIP_MARGIN && sx < STRIP_MARGIN + CELL_W && sy > top && sy < bottom) expected = colours[cell];
      }
      if (boundary) continue;
    }
    samples.push({ x, y, expected });
  }
  return samples;
}

export async function runExportCompositionProbe(): Promise<ProbeResult[]> {
  if (process.env.NODE_ENV === "production") throw new Error("Export probes are development-only");
  const colours = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]];
  const sources = colours.map(colour => {
    const canvas = createExportCanvas(120, 80), context = canvas.getContext("2d")!;
    context.fillStyle = `rgb(${colour.join(",")})`; context.fillRect(0, 0, 120, 80); return canvas;
  });
  const sample = createExportCanvas(), job = new ExportJob({ timeoutMs: 120_000 }), results: ProbeResult[] = [];
  const input: ComposeInput = { layout: getLayout("strip4"), shots: { A: sources }, stickers: [], style: { frameColor: "#ffffff", inkColor: "#000000", patternId: "none", filterId: "none", caption: "", showDate: false, stickerStyle: "flat" } };
  const run = async (id: string, action: () => Promise<string>) => {
    try { results.push({ id, status: "pass", detail: await action() }); }
    catch (error) { results.push({ id, status: "fail", detail: error instanceof Error ? error.message : String(error) }); }
  };
  try {
    const original = await Promise.all(sources.map(async source => projectBlobHash(await encodeExportCanvas(source, "png", 1, job))));
    await run("native-still-profile-dimensions", async () => {
      for (const profile of ["original", "story", "square", "wallpaper"] as const) for (const format of ["png", "jpeg"] as const) {
        const artifact = await exportStill(input, profile, { format }), bitmap = await createImageBitmap(artifact.blob);
        try { if (bitmap.width !== artifact.width || bitmap.height !== artifact.height || artifact.blob.type !== artifact.mime) throw new Error(`${profile}/${format} dimensions or MIME differ from the prepared file`); }
        finally { bitmap.close(); }
      }
      return "All four image profiles encoded and natively decoded in both PNG and JPEG, with exact declared output dimensions and MIME.";
    });
    await run("native-still-preview-output-parity", async () => {
      const preview = createExportCanvas(); let checked = 0;
      try {
        for (const profile of ["original", "story", "square", "wallpaper"] as const) for (const fit of ["contain", "cover"] as const) {
          const geometry = renderExportPreview(preview, input, profile, { fit }, 900), points = flatStripProbeSamples(geometry, colours);
          if (points.length < 6 || !points.some(point => point.expected.some(value => value === 0))) throw new Error(`${profile}/${fit} has insufficient solid-colour samples`);
          const previewContext = preview.getContext("2d")!;
          for (const format of ["png", "jpeg"] as const) {
            const artifact = await exportStill(input, profile, { fit, format }), bitmap = await createImageBitmap(artifact.blob);
            try {
              sample.width = bitmap.width; sample.height = bitmap.height;
              const context = sample.getContext("2d")!; context.drawImage(bitmap, 0, 0);
              for (const point of points) {
                const before = previewContext.getImageData(Math.floor(point.x * preview.width), Math.floor(point.y * preview.height), 1, 1).data;
                const after = context.getImageData(Math.floor(point.x * sample.width), Math.floor(point.y * sample.height), 1, 1).data;
                if (before[3] !== 255 || after[3] !== 255 || point.expected.some((value, channel) => Math.abs(before[channel] - value) > 8 || Math.abs(after[channel] - value) > 8 || Math.abs(before[channel] - after[channel]) > 8)) throw new Error(`${profile}/${fit}/${format} preview/output pixels differ at ${point.x},${point.y}`);
                checked++;
              }
            } finally { bitmap.close(); }
          }
        }
        return `${checked} solid-interior samples matched fixture colours and preview/output pixels across all four profiles, both fits, and PNG/JPEG native decodes (8-level lossy tolerance).`;
      } finally { releaseExportCanvas(preview); }
    });
    await run("native-photo-loop-composition", async () => {
      const frames = await createPhotoLoopFrames(input), size = compositionSize(input);
      if (frames.length !== 4) throw new Error("Expected four composed photo-loop frames");
      for (let index = 0; index < frames.length; index++) {
        const bitmap = await createImageBitmap(frames[index]);
        try {
          if (Math.max(bitmap.width, bitmap.height) > 640) throw new Error("Photo-loop frame exceeds its pixel limit");
          sample.width = bitmap.width; sample.height = bitmap.height;
          const context = sample.getContext("2d")!; context.drawImage(bitmap, 0, 0);
          const pixel = context.getImageData(Math.floor((STRIP_MARGIN + CELL_W / 2) / size.width * bitmap.width), Math.floor((STRIP_MARGIN + CELL_W / input.layout.cellAspect / 2) / size.height * bitmap.height), 1, 1).data;
          if (colours[index].some((value, channel) => Math.abs(pixel[channel] - value) > 3)) throw new Error(`Photo-loop frame ${index + 1} has the wrong source photo`);
        } finally { bitmap.close(); }
      }
      return "Four bounded strip frames decoded with the expected rotating photo colours and retained frame geometry.";
    });
    await run("native-export-cancel-retains-originals", async () => {
      const abort = new AbortController(); abort.abort();
      let rejected = false;
      try { await createPhotoLoopFrames(input, abort.signal); } catch (error) { rejected = error instanceof DOMException && error.name === "AbortError"; }
      if (!rejected) throw new Error("Cancelled composition was not rejected");
      const after = await Promise.all(sources.map(async source => projectBlobHash(await encodeExportCanvas(source, "png", 1, job))));
      if (original.some((hash, index) => hash !== after[index]) || input.shots.A !== sources) throw new Error("Export changed the original images or source order");
      return "Cancelled composition refused to start; native PNG hashes and source order remained unchanged after all still and loop exports.";
    });
    await run("native-photo-loop-keeps-empty-positions", async () => {
      const sparse = { ...input, shots: { A: [null, sources[0], null, sources[2]] } }, size = compositionSize(sparse);
      const reference = createExportCanvas();
      let expectedBlob: Blob;
      try { composeStrip(reference, sparse, Math.min(1, 640 / Math.max(size.width, size.height))); expectedBlob = await encodeExportCanvas(reference, "png", 1, job); }
      finally { releaseExportCanvas(reference); }
      const expected = await projectBlobHash(expectedBlob);
      const frames = await createPhotoLoopFrames(sparse);
      if (frames.length !== 2) throw new Error("Expected a two-frame sparse photo loop");
      if (await projectBlobHash(frames[0]) !== expected) {
        const bitmaps = await Promise.all([createImageBitmap(expectedBlob), createImageBitmap(frames[0])]);
        try {
          const pixels = bitmaps.map(bitmap => { sample.width = bitmap.width; sample.height = bitmap.height; const context = sample.getContext("2d")!; context.drawImage(bitmap, 0, 0); return context.getImageData(0, 0, sample.width, sample.height).data; });
          const first = pixels[0].findIndex((value, index) => value !== pixels[1][index]);
          throw new Error(`Sparse first-frame PNG differs: ${expectedBlob.size}/${frames[0].size} bytes, first pixel difference at ${first}, values ${pixels[0][first]}/${pixels[1][first]}`);
        } finally { bitmaps.forEach(bitmap => bitmap.close()); }
      }
      return "A sparse two-photo loop's first frame exactly matches the native still composition, including both empty positions.";
    });
  } finally { sources.forEach(releaseExportCanvas); releaseExportCanvas(sample); }
  return results;
}
