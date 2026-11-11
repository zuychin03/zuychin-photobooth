import { inspectImageHeader, type ProjectImageInfo } from "./images";
import { RESOURCE_LIMITS } from "./resource-bounds";

/** Originals share the project's 48 MP budget, so layouts with more than 4 photos store each one smaller. */
export function importPixelBudget(requiredShots: number): number {
  return Math.min(RESOURCE_LIMITS.photoPixels, Math.floor(RESOURCE_LIMITS.totalPixels / Math.max(RESOURCE_LIMITS.sourcesPerParticipant, requiredShots)));
}

export function importSize(width: number, height: number, budget: number): { width: number; height: number } {
  if (width * height <= budget) return { width, height };
  const scale = Math.sqrt(budget / (width * height));
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}

/** Re-encodes a decoded import as JPEG when it is over budget; null when it already fits. Releases `canvas` unless it returns null. */
export async function fitImportedPhoto(canvas: HTMLCanvasElement, budget: number): Promise<{ blob: Blob; info: ProjectImageInfo; canvas: HTMLCanvasElement } | null> {
  const size = importSize(canvas.width, canvas.height, budget);
  if (size.width === canvas.width && size.height === canvas.height) return null;
  const scaled = document.createElement("canvas");
  scaled.width = size.width; scaled.height = size.height;
  const context = scaled.getContext("2d");
  if (!context) { canvas.width = canvas.height = 0; throw new Error("Couldn't resize this photo. Try a smaller image."); }
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, size.width, size.height);
  context.imageSmoothingQuality = "high";
  context.drawImage(canvas, 0, 0, size.width, size.height);
  const blob = await new Promise<Blob | null>(resolve => scaled.toBlob(resolve, "image/jpeg", 0.92));
  canvas.width = canvas.height = 0;
  if (!blob) { scaled.width = scaled.height = 0; throw new Error("Couldn't resize this photo. Try a smaller image."); }
  return { blob, info: inspectImageHeader(new Uint8Array(await blob.arrayBuffer())), canvas: scaled };
}
