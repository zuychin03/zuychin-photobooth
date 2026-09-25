import { composeStrip, compositionSize, type ComposeInput } from "../compose";
import { ExportJob, createExportCanvas, encodeExportCanvas, releaseExportCanvas } from "./still";

export async function createPhotoLoopFrames(input: ComposeInput, signal?: AbortSignal): Promise<Blob[]> {
  if (["B", "C", "D"].some(role => input.shots[role as "B" | "C" | "D"]?.some(Boolean))) throw new Error("Photo loops are available for solo projects first.");
  const originals = input.shots.A ?? [];
  const sources = originals.map((photo, index) => ({ photo, index, cutout: input.cutouts?.A?.[index] ?? null })).filter(item => item.photo && item.photo.width > 0 && item.photo.height > 0);
  if (sources.length < 2 || sources.length > 4) throw new Error("Add two to four photos before making a photo loop.");
  const job = new ExportJob({ signal }), canvas = createExportCanvas(), frames: Blob[] = [];
  const size = compositionSize(input), scale = Math.min(1, 640 / Math.max(size.width, size.height));
  let bytes = 0;
  try {
    for (let step = 0; step < sources.length; step++) {
      job.check();
      const photos = [...originals], cutouts = [...(input.cutouts?.A ?? originals.map(() => null))];
      sources.forEach((source, index) => { const next = sources[(index + step) % sources.length]; photos[source.index] = next.photo; cutouts[source.index] = next.cutout; });
      composeStrip(canvas, { ...input, shots: { ...input.shots, A: photos },
        cutouts: input.cutouts ? { ...input.cutouts, A: cutouts } : undefined }, scale);
      const frame = await encodeExportCanvas(canvas, "png", 1, job);
      bytes += frame.size;
      if (bytes > 10 * 1024 * 1024) throw new Error("These animation frames exceed the 10 MB limit. Your still exports remain available.");
      frames.push(frame);
    }
    return frames;
  } finally { releaseExportCanvas(canvas); }
}
