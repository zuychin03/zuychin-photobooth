import {
  ROLES,
  Role,
  StripLayout,
  canvasBand,
  splitSlice,
  sprocketHoles,
  stripGeometry,
  type Rect,
} from "./layouts";
import { SPROCKET_MARGIN, formatStripDate, resolveStrip, type StripOptions } from "./strip-style";
import { getFilter, supportsCanvasFilter } from "./filters";
import { STICKER_PACKS, StickerStyle, monochromeGlyph } from "./decor";
import { getStickerImage } from "./sticker-assets";
import { getScene } from "./scenes";
import { getPattern } from "./patterns";
import { ThemeDef } from "./themes";
import { drawEditedPhoto, type PhotoCellEdit } from "./projects/transforms";
import { getAssetCrop, getCuratedAsset } from "./assets/registry";
import type { ReadyAsset } from "./assets/loader";
import type { TemplateDesign } from "./templates/model";
import { RESOURCE_LIMITS } from "./projects/resource-bounds";

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
  /** frame texture from PATTERNS; "none" leaves a plain frame */
  patternId: string;
  filterId: string;
  caption: string;
  showDate: boolean;
  stickerStyle: StickerStyle;
  /** painted top-left to bottom-right instead of frameColor */
  frameGradient?: readonly [string, string] | null;
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
  stickers: readonly StickerInstance[];
  /** person cutouts parallel to shots, required for Together mode cells */
  cutouts?: ShotSet;
  together?: TogetherOptions | null;
  /** baked-in theme decor drawn behind the user's own stickers */
  theme?: ThemeDef | null;
  cellEdits?: Record<string, PhotoCellEdit>;
  capturedAt?: string | null;
  captureTimeZone?: string;
  template?: TemplateDesign | null;
  materialId?: string | null;
  resources?: ReadonlyMap<string, ReadyAsset>;
  decorations?: ReadonlyMap<string, HTMLCanvasElement>;
  strip?: Partial<StripOptions> | null;
}

export function compositionSize(input: Pick<ComposeInput, "layout" | "template" | "strip">) {
  if (input.template) return input.template.canvas;
  const { width, height } = stripGeometry(input.layout, input.strip);
  return { width, height };
}

const KEYLINE_OFFSET = 4;

/** Clips `draw` to one photo with the strip's finish: rounded corners, an ink keyline or a lifted shadow. */
function finishedPhoto(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, finish: StripOptions["finish"], ink: string, keyline: number, draw: () => void) {
  if (finish === "lifted") {
    ctx.save();
    ctx.shadowColor = "rgba(28, 25, 23, 0.32)"; ctx.shadowBlur = 18; ctx.shadowOffsetY = 6;
    ctx.fillStyle = "#d6d3d1"; ctx.fillRect(x, y, w, h);
    ctx.restore();
  }
  ctx.save();
  ctx.beginPath();
  if (finish === "rounded" && typeof ctx.roundRect === "function") ctx.roundRect(x, y, w, h, Math.min(w, h) * 0.06);
  else ctx.rect(x, y, w, h);
  ctx.clip();
  try { draw(); } finally { ctx.restore(); }
  if (finish === "keyline") {
    ctx.save();
    ctx.strokeStyle = ink; ctx.lineWidth = 2;
    ctx.strokeRect(x - keyline - 1, y - keyline - 1, w + keyline * 2 + 2, h + keyline * 2 + 2);
    ctx.restore();
  }
}

function drawSprockets(ctx: CanvasRenderingContext2D, holes: readonly Rect[], ink: string) {
  if (!holes.length) return;
  ctx.save();
  ctx.globalAlpha = 0.85; ctx.fillStyle = ink;
  for (const hole of holes) {
    if (typeof ctx.roundRect !== "function") { ctx.fillRect(hole.x, hole.y, hole.width, hole.height); continue; }
    ctx.beginPath(); ctx.roundRect(hole.x, hole.y, hole.width, hole.height, 3); ctx.fill();
  }
  ctx.restore();
}

function drawDatestamp(ctx: CanvasRenderingContext2D, stamp: string, x: number, y: number, size: number) {
  ctx.fillStyle = "#ff9d45";
  ctx.shadowColor = "rgba(255, 157, 69, 0.85)";
  ctx.shadowBlur = 8;
  ctx.font = `italic 700 ${size}px ${fontVar("--font-geist-mono", "monospace")}`;
  ctx.textBaseline = "middle";
  ctx.fillText(stamp, x, y);
  ctx.shadowBlur = 0;
}

function drawAsset(ctx: CanvasRenderingContext2D, asset: ReadyAsset, x: number, y: number, width: number, height: number) {
  const crop = getAssetCrop(asset.asset, width, height);
  ctx.drawImage(asset.image, crop.x, crop.y, crop.width, crop.height, x, y, width, height);
}

function drawScene(ctx: CanvasRenderingContext2D, input: ComposeInput, x: number, y: number, width: number, height: number) {
  const scene = input.together ? getScene(input.together.sceneId) : null;
  const asset = scene?.assetId ? input.resources?.get(scene.assetId) : null;
  if (asset) drawAsset(ctx, asset, x, y, width, height);
  else scene?.draw(ctx, x, y, width, height);
}

function drawTemplate(ctx: CanvasRenderingContext2D, input: ComposeInput, width: number, height: number, canFilter: boolean, finish: StripOptions["finish"]) {
  for (const slot of input.template!.slots) {
    const x = slot.x * width, y = slot.y * height, w = slot.width * width, h = slot.height * height;
    finishedPhoto(ctx, x, y, w, h, finish, input.style.inkColor, KEYLINE_OFFSET, () => {
    ctx.fillStyle = "#d6d3d1"; ctx.fillRect(x, y, w, h);
    const sources = [slot, ...(slot.companions ?? [])].sort((a, b) => ROLES.indexOf(a.role) - ROLES.indexOf(b.role));
    const ready = input.together && sources.every(source => input.shots[source.role]?.[source.sourceIndex] && input.cutouts?.[source.role]?.[source.sourceIndex]);
    if (ready) {
      if (canFilter) ctx.filter = getFilter(input.style.filterId).css;
      drawScene(ctx, input, x, y, w, h);
      sources.forEach((source, index) => {
        const cut = input.cutouts![source.role]![source.sourceIndex]!;
        const place = input.together!.places[source.role] ?? DEFAULT_PLACEMENT;
        const ph = h * (sources.length > 2 ? 0.8 : 0.92) * place.scale, pw = cut.width / cut.height * ph;
        const cx = x + w * ((index + 1) / (sources.length + 1) + place.dx), bottom = y + h + h * place.dy;
        ctx.drawImage(cut, cx - pw / 2, bottom - ph, pw, ph);
      });
    } else {
      const fallback = slot.splitFallback ? sources : [slot];
      fallback.forEach((source, index) => {
        const photo = input.shots[source.role]?.[source.sourceIndex], left = x + index * w / fallback.length, cellWidth = w / fallback.length;
        if (canFilter) ctx.filter = getFilter(source.filterId ?? input.style.filterId).css;
        if (photo) drawEditedPhoto(ctx, photo, left, y, cellWidth, h, { ...source.crop, sourceIndex: source.sourceIndex, filterId: source.filterId ?? null }, source.sliceX ? [...source.sliceX] : [0, 1]);
        else {
          ctx.fillStyle = "#57534e"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
          ctx.font = `500 ${Math.max(12, Math.min(20, cellWidth / 8))}px sans-serif`;
          ctx.fillText(`${source.role} · ${source.sourceIndex + 1}`, left + cellWidth / 2, y + h / 2);
        }
      });
    }
    });
  }
}

function drawTemplateLayers(ctx: CanvasRenderingContext2D, input: ComposeInput, width: number, height: number) {
  for (const layer of input.template?.layers ?? []) {
    const x = layer.x * width, y = layer.y * height, w = layer.width * width, h = layer.height * height;
    if (layer.kind === "sticker") {
      const sticker = STICKER_PACKS.flatMap(pack => pack.stickers).find(item => item.slug === layer.slug)!;
      ctx.save(); ctx.translate(x + w / 2, y + h / 2); ctx.rotate(layer.rotation * Math.PI / 180);
      ctx.scale(w / STICKER_BASE, h / STICKER_BASE);
      drawSticker(ctx, { ...sticker, x: 0, y: 0, scale: 1, rotation: 0 }, layer.style, input.style.inkColor, 1, 1);
      ctx.restore(); continue;
    }
    ctx.save(); ctx.translate(x + w / 2, y + h / 2); ctx.rotate(layer.rotation * Math.PI / 180);
    ctx.beginPath(); ctx.rect(-w / 2, -h / 2, w, h); ctx.clip();
    if (layer.kind === "text") {
      const size = layer.fontSize * width;
      const family = layer.font === "serif" ? fontVar("--font-fraunces", "Georgia, serif") : layer.font === "mono" ? fontVar("--font-geist-mono", "monospace") : fontVar("--font-geist-sans", "sans-serif");
      ctx.font = `600 ${size}px ${family}`; ctx.fillStyle = layer.colour; ctx.textAlign = layer.align; ctx.textBaseline = "top";
      const tx = layer.align === "left" ? -w / 2 : layer.align === "right" ? w / 2 : 0;
      layer.text.split("\n").forEach((line, index) => { if (index * size * 1.2 < h) ctx.fillText(line, tx, -h / 2 + index * size * 1.2, w); });
    } else {
      const image = input.decorations?.get(layer.mediaId);
      if (image) {
        if (layer.fit === "cover") drawCover(ctx, image, -w / 2, -h / 2, w, h);
        else { const scale = Math.min(w / image.width, h / image.height); ctx.drawImage(image, -image.width * scale / 2, -image.height * scale / 2, image.width * scale, image.height * scale); }
      }
    }
    ctx.restore();
  }
}

const STICKER_BASE = 96;

/** One placed sticker/decor piece: image asset, ink glyph, or emoji placeholder. */
function drawSticker(
  ctx: CanvasRenderingContext2D,
  s: { emoji: string; slug: string; x: number; y: number; scale: number; rotation: number },
  stickerStyle: StickerStyle,
  inkColor: string,
  width: number,
  height: number,
) {
  const size = STICKER_BASE * s.scale;
  ctx.save();
  ctx.translate(s.x * width, s.y * height);
  ctx.rotate(s.rotation);
  const img = stickerStyle === "noto" ? null : getStickerImage(stickerStyle, s.slug);
  if (img) {
    ctx.drawImage(img, -size / 2, -size / 2, size, size);
  } else if (stickerStyle === "noto") {
    ctx.font = `${size}px ${fontVar("--font-noto-emoji", "sans-serif")}`;
    ctx.fillStyle = inkColor;
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
  const { layout, shots, style, stickers, cutouts, together, theme, cellEdits } = input;
  const scene = together ? getScene(together.sceneId) : null;
  const options = resolveStrip(input.strip);
  const { width, height } = compositionSize(input);
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext("2d")!;
  ctx.save();
  ctx.scale(scale, scale);

  if (style.frameGradient) {
    const gradient = ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, style.frameGradient[0]); gradient.addColorStop(1, style.frameGradient[1]);
    ctx.fillStyle = gradient;
  } else ctx.fillStyle = style.frameColor;
  ctx.fillRect(0, 0, width, height);
  const material = input.materialId ? getCuratedAsset(input.materialId) : null;
  if (material) {
    const resource = input.resources?.get(material.id);
    if (resource) drawAsset(ctx, resource, 0, 0, width, height);
    else { ctx.fillStyle = material.fallback.colour; ctx.fillRect(0, 0, width, height); }
  }
  getPattern(style.patternId)?.draw(ctx, width, height, style.inkColor);

  const filter = getFilter(style.filterId);
  const canFilter = supportsCanvasFilter();
  const geometry = input.template ? null : stripGeometry(layout, options);
  drawSprockets(ctx, geometry ? geometry.sprockets : options.sprockets ? sprocketHoles(width, height, SPROCKET_MARGIN, height >= width) : [], style.inkColor);

  if (input.template) drawTemplate(ctx, input, width, height, canFilter, options.finish);
  for (const cell of geometry?.cells ?? []) {
    const { index: i, x, y, width: cellW, height: cellH, owners, shot: shotIdx } = cell;

    const editedShot = (role: Role) => shots[role]?.[cellEdits?.[`${i}:${role}`]?.sourceIndex ?? shotIdx] ?? null;
    const drawPhoto = (role: Role, shot: HTMLCanvasElement, left: number, cellWidth: number, slice: [number, number] = [0, 1]) => {
      const edit = cellEdits?.[`${i}:${role}`];
      ctx.save();
      try {
        if (canFilter) ctx.filter = getFilter(edit?.filterId ?? style.filterId).css;
        if (edit) drawEditedPhoto(ctx, shot, left, y, cellWidth, cellH, edit, slice);
        else drawCover(ctx, shot, left, y, cellWidth, cellH, slice);
      } finally { ctx.restore(); }
    };

    // members with a cutout for this shot, in role order, share the cell
    const intendedRoles = ROLES.filter(role => shots[role]?.some(Boolean));
    const presentCuts = intendedRoles.map((r) => ({
      role: r,
      cut: cutouts?.[r]?.[cellEdits?.[`${i}:${r}`]?.sourceIndex ?? shotIdx] ?? null,
    })).filter((e) => e.cut);
    const togetherCell = !!scene && !!together && intendedRoles.length > 0 && presentCuts.length === intendedRoles.length;

    let cellFilled = false;
    finishedPhoto(ctx, x, y, cellW, cellH, options.finish, style.inkColor, Math.min(KEYLINE_OFFSET, geometry!.gap / 4), () => {
    ctx.fillStyle = "#d6d3d1";
    ctx.fillRect(x, y, cellW, cellH);
    if (canFilter && filter.css !== "none") ctx.filter = filter.css;

    if (togetherCell) {
      drawScene(ctx, input, x, y, cellW, cellH);
      presentCuts.forEach(({ role, cut }, idx) => {
        const place = together.places[role] ?? DEFAULT_PLACEMENT;
        const anchorX = (idx + 1) / (presentCuts.length + 1);
        const ph = cellH * (presentCuts.length > 2 ? 0.8 : 0.92) * place.scale;
        const pw = (cut!.width / cut!.height) * ph;
        const cx = x + cellW * (anchorX + place.dx);
        const bottom = y + cellH + cellH * place.dy;
        ctx.drawImage(cut!, cx - pw / 2, bottom - ph, pw, ph);
      });
      cellFilled = true;
    } else {
      const sliceWidth = cellW / owners.length;
      owners.forEach((role, part) => {
        const shot = editedShot(role);
        if (!shot) return;
        drawPhoto(role, shot, x + part * sliceWidth, sliceWidth, splitSlice(owners.length));
        cellFilled = true;
      });
    }
    });

    if (!cellFilled) {
      ctx.fillStyle = "rgba(120, 113, 108, 0.6)";
      ctx.font = `500 20px ${fontVar("--font-geist-sans", "system-ui, sans-serif")}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("…", x + cellW / 2, y + cellH / 2);
    }
  }

  const band = geometry?.band ?? canvasBand(width, height, options);
  const stamp = style.showDate && input.capturedAt !== null ? formatStripDate(input.capturedAt ?? new Date().toISOString(), input.captureTimeZone, options.dateFormat) : null;
  const bandDate = options.date === "band" ? stamp : null;
  if (material && (style.caption || bandDate)) {
    ctx.fillStyle = style.frameColor;
    ctx.fillRect(band.x / 2, band.y, width - band.x, band.height);
  }
  const family = options.font === "serif" ? fontVar("--font-fraunces", "Georgia, serif") : options.font === "mono" ? fontVar("--font-geist-mono", "monospace") : fontVar("--font-geist-sans", "sans-serif");
  const inline = options.footer === "inline", middle = band.y + band.height / 2;
  ctx.textAlign = inline ? "left" : "center";
  if (style.caption) {
    ctx.fillStyle = style.inkColor;
    ctx.font = `600 ${inline ? 30 : 34}px ${family}`;
    ctx.textBaseline = "middle";
    if (inline) ctx.fillText(style.caption, band.x, middle, bandDate ? band.width * 0.6 : band.width);
    else ctx.fillText(style.caption, width / 2, band.y + band.height * 0.42, width - band.x * 2);
  }
  if (bandDate) {
    ctx.textAlign = inline ? "right" : "center";
    drawDatestamp(ctx, bandDate, inline ? band.x + band.width : width / 2, inline ? middle : band.y + band.height * (style.caption ? 0.78 : 0.55), inline ? 24 : 26);
  } else if (stamp) {
    const last = lastPhoto(geometry?.cells, input.template?.slots, width, height);
    if (last) {
      const size = Math.max(12, last.height * 0.08);
      ctx.textAlign = "right";
      drawDatestamp(ctx, stamp, last.x + last.width - size * 0.6, last.y + last.height - size * 0.9, size);
    }
  }

  if (theme) {
    for (const d of theme.decor) {
      drawSticker(ctx, d, theme.stickerStyle, style.inkColor, width, height);
    }
  }
  for (const s of stickers) {
    drawSticker(ctx, s, style.stickerStyle, style.inkColor, width, height);
  }
  drawTemplateLayers(ctx, input, width, height);

  ctx.restore();
}

/** The bottom-right photo, where a datestamp on the photo goes. */
function lastPhoto(cells: readonly Rect[] | undefined, slots: readonly Rect[] | undefined, width: number, height: number): Rect | null {
  const rects = cells ?? (slots ?? []).map(slot => ({ x: slot.x * width, y: slot.y * height, width: slot.width * width, height: slot.height * height }));
  return rects.reduce<Rect | null>((found, rect) => !found || rect.y + rect.height > found.y + found.height + 0.5 || (Math.abs(rect.y + rect.height - found.y - found.height) <= 0.5 && rect.x > found.x) ? rect : found, null);
}

export function stripToBlob(input: ComposeInput, scale = 2): Promise<Blob> {
  const canvas = document.createElement("canvas");
  const { width, height } = compositionSize(input);
  const boundedScale = Math.min(scale, RESOURCE_LIMITS.photoEdge / width, RESOURCE_LIMITS.photoEdge / height, Math.sqrt(RESOURCE_LIMITS.photoPixels / (width * height)));
  composeStrip(canvas, input, boundedScale);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("export failed"))),
      "image/png",
    );
  });
}
