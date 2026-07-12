import {
  CELL_GAP,
  CELL_W,
  FOOTER_H,
  ROLES,
  Role,
  STRIP_MARGIN,
  StripLayout,
  cellShotIndex,
  stripSize,
} from "./layouts";
import { getFilter, supportsCanvasFilter } from "./filters";
import { StickerStyle, monochromeGlyph } from "./decor";
import { getStickerImage } from "./sticker-assets";
import { getScene } from "./scenes";

export interface StickerInstance {
  key: number;
  emoji: string;
  /** Fluent asset slug; the emoji char is the fallback glyph */
  slug: string;
  /** center position relative to strip size, 0..1 */
  x: number;
  y: number;
  scale: number;
  /** radians */
  rotation: number;
}

export interface StripStyle {
  frameColor: string;
  /** text color that reads on frameColor */
  inkColor: string;
  filterId: string;
  caption: string;
  showDate: boolean;
  stickerStyle: StickerStyle;
}

export type ShotSet = Partial<Record<Role, (HTMLCanvasElement | null)[]>>;

/** Per-member adjustment in Together mode; dx/dy are cell fractions. */
export interface TogetherPlacement {
  dx: number;
  dy: number;
  scale: number;
}

export const DEFAULT_PLACEMENT: TogetherPlacement = { dx: 0, dy: 0, scale: 1 };

export interface TogetherOptions {
  sceneId: string;
  places: Partial<Record<Role, TogetherPlacement>>;
}

export interface ComposeInput {
  layout: StripLayout;
  shots: ShotSet;
  style: StripStyle;
  stickers: StickerInstance[];
  /** person cutouts parallel to shots, required for Together mode cells */
  cutouts?: ShotSet;
  together?: TogetherOptions | null;
}

const STICKER_BASE = 96;

/** ctx.font cannot resolve CSS variables; read the next/font family off :root. */
function fontVar(name: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v ? `${v}, ${fallback}` : fallback;
}

/** Cover-fit draw: center-crops source to the destination aspect. */
function drawCover(
  ctx: CanvasRenderingContext2D,
  img: HTMLCanvasElement,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
  /** horizontal slice of the source to use: [start, end] in 0..1 */
  sliceX: [number, number] = [0, 1],
) {
  const sw = img.width * (sliceX[1] - sliceX[0]);
  const sx0 = img.width * sliceX[0];
  const srcAspect = sw / img.height;
  const dstAspect = dw / dh;
  let sx = sx0;
  let sy = 0;
  let cw = sw;
  let ch = img.height;
  if (srcAspect > dstAspect) {
    cw = img.height * dstAspect;
    sx = sx0 + (sw - cw) / 2;
  } else {
    ch = sw / dstAspect;
    sy = (img.height - ch) / 2;
  }
  ctx.drawImage(img, sx, sy, cw, ch, dx, dy, dw, dh);
}

/**
 * Renders the full strip onto `canvas`. Pure with respect to inputs; the
 * editor preview and the 2x export call this same function.
 */
export function composeStrip(
  canvas: HTMLCanvasElement,
  input: ComposeInput,
  scale = 1,
): void {
  const { layout, shots, style, stickers, cutouts, together } = input;
  const scene = together ? getScene(together.sceneId) : null;
  const { width, height } = stripSize(layout);
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext("2d")!;
  ctx.save();
  ctx.scale(scale, scale);

  ctx.fillStyle = style.frameColor;
  ctx.fillRect(0, 0, width, height);

  const cellH = CELL_W / layout.cellAspect;
  const filter = getFilter(style.filterId);
  const canFilter = supportsCanvasFilter();
  const cellCount = layout.cols * layout.rows;

  for (let i = 0; i < cellCount; i++) {
    const col = i % layout.cols;
    const row = Math.floor(i / layout.cols);
    const x = STRIP_MARGIN + col * (CELL_W + CELL_GAP);
    const y = STRIP_MARGIN + row * (cellH + CELL_GAP);
    const owner = layout.duoPattern?.[i] ?? "A";
    const shotIdx = cellShotIndex(layout, i);

    const shotA = shots.A?.[shotIdx] ?? null;
    const shotB = shots.B?.[shotIdx] ?? null;

    // members with a cutout for this shot, in role order, share the cell
    const presentCuts = ROLES.map((r) => ({
      role: r,
      cut: cutouts?.[r]?.[shotIdx] ?? null,
    })).filter((e) => e.cut);
    const togetherCell = !!scene && !!together && presentCuts.length > 0;

    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, CELL_W, cellH);
    ctx.clip();
    ctx.fillStyle = "#d6d3d1";
    ctx.fillRect(x, y, CELL_W, cellH);
    if (canFilter && filter.css !== "none") ctx.filter = filter.css;

    let cellFilled = false;
    if (togetherCell) {
      scene.draw(ctx, x, y, CELL_W, cellH);
      presentCuts.forEach(({ role, cut }, idx) => {
        const place = together.places[role] ?? DEFAULT_PLACEMENT;
        const anchorX = (idx + 1) / (presentCuts.length + 1);
        const ph = cellH * (presentCuts.length > 2 ? 0.8 : 0.92) * place.scale;
        const pw = (cut!.width / cut!.height) * ph;
        const cx = x + CELL_W * (anchorX + place.dx);
        const bottom = y + cellH + cellH * place.dy;
        ctx.drawImage(cut!, cx - pw / 2, bottom - ph, pw, ph);
      });
      cellFilled = true;
    } else if (owner === "AB") {
      if (shotA) drawCover(ctx, shotA, x, y, CELL_W / 2, cellH, [0.25, 0.75]);
      if (shotB)
        drawCover(ctx, shotB, x + CELL_W / 2, y, CELL_W / 2, cellH, [0.25, 0.75]);
      cellFilled = !!(shotA || shotB);
    } else {
      const shot = shots[owner]?.[shotIdx] ?? null;
      if (shot) drawCover(ctx, shot, x, y, CELL_W, cellH);
      cellFilled = !!shot;
    }
    ctx.restore();

    if (!cellFilled) {
      ctx.fillStyle = "rgba(120, 113, 108, 0.6)";
      ctx.font = `500 20px ${fontVar("--font-geist-sans", "system-ui, sans-serif")}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("…", x + CELL_W / 2, y + cellH / 2);
    }
  }

  const footerTop = height - STRIP_MARGIN - FOOTER_H;
  ctx.textAlign = "center";
  if (style.caption) {
    ctx.fillStyle = style.inkColor;
    ctx.font = `600 34px ${fontVar("--font-fraunces", "Georgia, serif")}`;
    ctx.textBaseline = "middle";
    ctx.fillText(style.caption, width / 2, footerTop + FOOTER_H * 0.42, width - STRIP_MARGIN * 2);
  }
  if (style.showDate) {
    const d = new Date();
    const stamp = `${String(d.getDate()).padStart(2, "0")}·${String(
      d.getMonth() + 1,
    ).padStart(2, "0")}·${d.getFullYear()}`;
    ctx.fillStyle = "#ff9d45";
    ctx.shadowColor = "rgba(255, 157, 69, 0.85)";
    ctx.shadowBlur = 8;
    ctx.font = `italic 700 26px ${fontVar("--font-geist-mono", "monospace")}`;
    ctx.textBaseline = "middle";
    ctx.fillText(stamp, width / 2, footerTop + FOOTER_H * (style.caption ? 0.78 : 0.55));
    ctx.shadowBlur = 0;
  }

  for (const s of stickers) {
    const size = STICKER_BASE * s.scale;
    ctx.save();
    ctx.translate(s.x * width, s.y * height);
    ctx.rotate(s.rotation);
    const img =
      style.stickerStyle === "noto"
        ? null
        : getStickerImage(style.stickerStyle, s.slug);
    if (img) {
      ctx.drawImage(img, -size / 2, -size / 2, size, size);
    } else if (style.stickerStyle === "noto") {
      ctx.font = `${size}px ${fontVar("--font-noto-emoji", "sans-serif")}`;
      ctx.fillStyle = style.inkColor;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(monochromeGlyph(s.emoji), 0, 0);
    } else {
      // image not loaded yet: native glyph placeholder until re-render
      ctx.font = `${size}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(s.emoji, 0, 0);
    }
    ctx.restore();
  }

  ctx.restore();
}

export function stripToBlob(input: ComposeInput, scale = 2): Promise<Blob> {
  const canvas = document.createElement("canvas");
  composeStrip(canvas, input, scale);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("export failed"))),
      "image/png",
    );
  });
}
