// Sync image cache for canvas composition: composeStrip stays synchronous,
// callers preload and re-render when images land.
import { stickerAssetUrl } from "./decor";

const cache = new Map<string, HTMLImageElement>();
const pending = new Map<string, Promise<void>>();

function key(style: "flat" | "3d", slug: string): string {
  return `${style}:${slug}`;
}

export function getStickerImage(
  style: "flat" | "3d",
  slug: string,
): HTMLImageElement | null {
  return cache.get(key(style, slug)) ?? null;
}

function loadOne(style: "flat" | "3d", slug: string): Promise<void> {
  const k = key(style, slug);
  if (cache.has(k)) return Promise.resolve();
  const existing = pending.get(k);
  if (existing) return existing;
  const p = new Promise<void>((resolve) => {
    const img = new Image();
    img.onload = () => {
      cache.set(k, img);
      pending.delete(k);
      resolve();
    };
    // resolve on error too: compose falls back to the native glyph
    img.onerror = () => {
      pending.delete(k);
      resolve();
    };
    img.src = stickerAssetUrl(style, slug);
  });
  pending.set(k, p);
  return p;
}

export function preloadStickers(
  style: "flat" | "3d",
  slugs: string[],
): Promise<void> {
  return Promise.all(slugs.map((s) => loadOne(style, s))).then(() => undefined);
}

/** Canvas only rasterizes glyphs of fonts that are already loaded. */
export async function ensureNotoFont(family: string): Promise<void> {
  if (typeof document === "undefined" || !document.fonts) return;
  try {
    await document.fonts.load(`400 64px ${family}`, "❤🎉📷");
  } catch {
    // missing font falls back to the native emoji glyph
  }
}
