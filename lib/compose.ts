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
}

export function compositionSize(input: Pick<ComposeInput, "layout" | "template">) {
  return input.template?.canvas ?? stripSize(input.layout);
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

function drawTemplate(ctx: CanvasRenderingContext2D, input: ComposeInput, width: number, height: number, canFilter: boolean) {
  for (const slot of input.template!.slots) {
    const x = slot.x * width, y = slot.y * height, w = slot.width * width, h = slot.height * height;
    ctx.save();
    ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
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
    ctx.restore();
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
  const { width, height } = compositionSize(input);
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext("2d")!;
  ctx.save();
  ctx.scale(scale, scale);

  ctx.fillStyle = style.frameColor;
  ctx.fillRect(0, 0, width, height);
  const material = input.materialId ? getCuratedAsset(input.materialId) : null;
  if (material) {
    const resource = input.resources?.get(material.id);
    if (resource) drawAsset(ctx, resource, 0, 0, width, height);
    else { ctx.fillStyle = material.fallback.colour; ctx.fillRect(0, 0, width, height); }
  }
  getPattern(style.patternId)?.draw(ctx, width, height, style.inkColor);

  const cellH = CELL_W / layout.cellAspect;
  const filter = getFilter(style.filterId);
  const canFilter = supportsCanvasFilter();
  const cellCount = layout.cols * layout.rows;

  if (input.template) drawTemplate(ctx, input, width, height, canFilter);
  for (let i = 0; !input.template && i < cellCount; i++) {
    const col = i % layout.cols;
    const row = Math.floor(i / layout.cols);
    const x = STRIP_MARGIN + col * (CELL_W + CELL_GAP);
    const y = STRIP_MARGIN + row * (cellH + CELL_GAP);
    const owner = layout.duoPattern?.[i] ?? "A";
    const shotIdx = cellShotIndex(layout, i);

    const editedShot = (role: Role) => shots[role]?.[cellEdits?.[`${i}:${role}`]?.sourceIndex ?? shotIdx] ?? null;
    const shotA = editedShot("A");
    const shotB = editedShot("B");
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

    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, CELL_W, cellH);
    ctx.clip();
    ctx.fillStyle = "#d6d3d1";
    ctx.fillRect(x, y, CELL_W, cellH);
    if (canFilter && filter.css !== "none") ctx.filter = filter.css;

    let cellFilled = false;
    if (togetherCell) {
      drawScene(ctx, input, x, y, CELL_W, cellH);
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
      if (shotA) drawPhoto("A", shotA, x, CELL_W / 2, [0.25, 0.75]);
      if (shotB)
        drawPhoto("B", shotB, x + CELL_W / 2, CELL_W / 2, [0.25, 0.75]);
      cellFilled = !!(shotA || shotB);
    } else {
      const shot = editedShot(owner);
      if (shot) drawPhoto(owner, shot, x, CELL_W);
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
  if (material && (style.caption || style.showDate)) {
    ctx.fillStyle = style.frameColor;
    ctx.fillRect(STRIP_MARGIN / 2, footerTop, width - STRIP_MARGIN, FOOTER_H);
  }
  ctx.textAlign = "center";
  if (style.caption) {
    ctx.fillStyle = style.inkColor;
    ctx.font = `600 34px ${fontVar("--font-fraunces", "Georgia, serif")}`;
    ctx.textBaseline = "middle";
    ctx.fillText(style.caption, width / 2, footerTop + FOOTER_H * 0.42, width - STRIP_MARGIN * 2);
  }
  if (style.showDate && input.capturedAt !== null) {
    const d = new Date(input.capturedAt ?? Date.now());
    const parts = new Intl.DateTimeFormat("en-AU", { timeZone: input.captureTimeZone, day: "2-digit", month: "2-digit", year: "numeric" }).formatToParts(d);
    const part = (name: string) => parts.find(value => value.type === name)?.value;
    const stamp = `${part("day")}·${part("month")}·${part("year")}`;
    ctx.fillStyle = "#ff9d45";
    ctx.shadowColor = "rgba(255, 157, 69, 0.85)";
    ctx.shadowBlur = 8;
    ctx.font = `italic 700 26px ${fontVar("--font-geist-mono", "monospace")}`;
    ctx.textBaseline = "middle";
    ctx.fillText(stamp, width / 2, footerTop + FOOTER_H * (style.caption ? 0.78 : 0.55));
    ctx.shadowBlur = 0;
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
