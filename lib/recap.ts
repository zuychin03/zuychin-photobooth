// Client-side collage of a set of strips into one recap image.
const STRIP_H = 640;
const GAP = 28;
const PAD = 48;
const HEADER_H = 130;
const MAX_COLS = 4;
const BG = "#faf7f2";
const INK = "#292524";

export function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

/** ctx.font cannot resolve CSS variables; read the next/font family off :root. */
function fontVar(name: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v ? `${v}, ${fallback}` : fallback;
}

type Source = HTMLImageElement | HTMLCanvasElement;

function srcW(s: Source): number {
  return s instanceof HTMLImageElement ? s.naturalWidth : s.width;
}
function srcH(s: Source): number {
  return s instanceof HTMLImageElement ? s.naturalHeight : s.height;
}

export function composeRecap(sources: Source[], title: string, scale = 1): HTMLCanvasElement {
  const count = Math.max(sources.length, 1);
  const cols = Math.min(count, MAX_COLS);
  const rows = Math.ceil(count / cols);
  const widths = sources.map((s) => STRIP_H * (srcW(s) / srcH(s)));
  const colW = Math.max(...widths, STRIP_H * 0.6);

  const width = PAD * 2 + cols * colW + (cols - 1) * GAP;
  const height = PAD * 2 + HEADER_H + rows * STRIP_H + (rows - 1) * GAP;

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext("2d")!;
  ctx.scale(scale, scale);

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
}

export function recapToBlob(sources: Source[], title: string, scale = 2): Promise<Blob> {
  const canvas = composeRecap(sources, title, scale);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("recap export failed"))),
      "image/png",
    );
  });
}
