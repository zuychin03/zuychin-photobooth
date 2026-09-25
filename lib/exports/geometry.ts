import type { ComposeInput } from "../compose";
import { CELL_W, ROLES, cellShotIndex, stripSize, type Role } from "../layouts";
import { getScene } from "../scenes";
import { RESOURCE_LIMITS } from "../projects/resource-bounds";
import { defaultCellEdit, photoPlacement, type PhotoCellEdit } from "../projects/transforms";
import { getExportProfile, type ExportFit, type ExportOptions, type ExportProfileId } from "./profiles";

export interface Size { width: number; height: number }
export interface Rect extends Size { x: number; y: number }
export interface ExportPlacement { tile: Rect; box: Rect; draw: Rect }
export interface ExportGeometry extends Size {
  profileId: ExportProfileId;
  unit: "px" | "mm";
  fit: ExportFit;
  marginMm: number;
  cutMarks: boolean;
  source: Size;
  placements: ExportPlacement[];
  raster: Size & { scale: number };
}
export const PRINT_PPI = 300;
export const mmToPoints = (mm: number) => mm * 72 / 25.4;
export const mmToPixels = (mm: number) => Math.round(mm * PRINT_PPI / 25.4);

function positive(...values: number[]) {
  if (!values.every(value => Number.isFinite(value) && value > 0)) throw new Error("Export dimensions must be positive and finite");
}
export function boundedRaster(source: Size, desiredScale: number): Size & { scale: number } {
  positive(source.width, source.height, desiredScale);
  const scale = Math.min(desiredScale, RESOURCE_LIMITS.photoEdge / source.width, RESOURCE_LIMITS.photoEdge / source.height,
    Math.sqrt(RESOURCE_LIMITS.photoPixels / (source.width * source.height)));
  const width = Math.max(1, Math.floor(source.width * scale)), height = Math.max(1, Math.floor(source.height * scale));
  return { width, height, scale: Math.min(width / source.width, height / source.height) };
}
export function fitRect(source: Size, box: Rect, fit: ExportFit): Rect {
  positive(source.width, source.height, box.width, box.height);
  if (![box.x, box.y].every(Number.isFinite) || !["contain", "cover"].includes(fit)) throw new Error("Invalid export placement");
  const scale = (fit === "contain" ? Math.min : Math.max)(box.width / source.width, box.height / source.height);
  const width = source.width * scale, height = source.height * scale;
  return { x: box.x + (box.width - width) / 2, y: box.y + (box.height - height) / 2, width, height };
}
export function exportGeometry(source: Size, profileId: ExportProfileId, options: ExportOptions = {}): ExportGeometry {
  positive(source.width, source.height);
  const profile = getExportProfile(profileId), fit = options.fit ?? profile.fit;
  if (!["contain", "cover"].includes(fit)) throw new Error("Invalid export fit");
  const unit = profile.kind === "pdf" ? "mm" : "px";
  const original = boundedRaster(source, 2);
  const width = profile.width ?? original.width, height = profile.height ?? original.height;
  const marginMm = options.marginMm ?? (profileId === "a4-contact" ? 10 : unit === "mm" ? 2 : 0);
  if (!Number.isFinite(marginMm) || marginMm < 0 || marginMm > (profileId === "a4-contact" ? 20 : 10)) throw new Error("Export margin is out of bounds");
  const tiles: Rect[] = [];
  if (profileId === "a4-contact") {
    const gap = 4, total = 3 * 50.8 + 2 * gap;
    if (width - marginMm * 2 < total || height - marginMm * 2 < 152.4) throw new Error("The strips do not fit inside the page margins");
    for (let i = 0; i < 3; i++) tiles.push({ x: (width - total) / 2 + i * (50.8 + gap), y: (height - 152.4) / 2, width: 50.8, height: 152.4 });
  } else if (profileId === "print-two-up") {
    tiles.push({ x: 0, y: 0, width: 50.8, height }, { x: 50.8, y: 0, width: 50.8, height });
  } else tiles.push({ x: 0, y: 0, width, height });
  const inset = unit === "px" ? 0 : profileId === "a4-contact" ? 2 : marginMm;
  const placements = tiles.map(tile => {
    const box = { x: tile.x + inset, y: tile.y + inset, width: tile.width - 2 * inset, height: tile.height - 2 * inset };
    return { tile, box, draw: fitRect(source, box, fit) };
  });
  const pixelsPerUnit = unit === "mm" ? PRINT_PPI / 25.4 : 1;
  const desiredScale = Math.max(...placements.map(item => item.draw.width / source.width * pixelsPerUnit));
  return { profileId, width, height, unit, fit, marginMm, cutMarks: options.cutMarks ?? unit === "mm", source: { ...source }, placements, raster: boundedRaster(source, desiredScale) };
}

export interface SourceResolution {
  cell: number; role: Role; sourceIndex: number; kind: "photo" | "cutout";
  pixelsPerOutputPixel: number | null;
  effectivePpi: number | null;
  missing: boolean;
}
export interface ResolutionReport { sources: SourceResolution[]; minimumPpi: number | null; minimumPixelRatio: number | null; warnings: string[] }
export function sourceResolution(input: ComposeInput, geometry: ExportGeometry): ResolutionReport {
  const sources: SourceResolution[] = [];
  const size = input.template?.canvas ?? stripSize(input.layout);
  const unitScale = Math.max(...geometry.placements.map(item => item.draw.width / size.width));
  const pixelsPerUnit = geometry.unit === "mm" ? PRINT_PPI / 25.4 : 1;
  const rasterRatio = geometry.raster.scale / (unitScale * pixelsPerUnit);
  const add = (cell: number, role: Role, sourceIndex: number, width: number, height: number, edit: PhotoCellEdit, slice = 1, kind: "photo" | "cutout" = "photo", cutHeight?: number) => {
    const photo = (kind === "cutout" ? input.cutouts : input.shots)?.[role]?.[sourceIndex];
    const sourceScale = photo ? kind === "cutout" ? cutHeight! / photo.height : photoPlacement(photo.width * slice, photo.height, width, height, edit).scale : null;
    const ratio = sourceScale === null ? null : Math.min(1 / (sourceScale * unitScale * pixelsPerUnit), rasterRatio);
    sources.push({ cell, role, sourceIndex, kind, missing: !photo, pixelsPerOutputPixel: ratio, effectivePpi: geometry.unit === "mm" && ratio !== null ? ratio * PRINT_PPI : null });
  };
  if (input.template) input.template.slots.forEach((slot, cell) => {
    const group = [slot, ...(slot.companions ?? [])];
    const together = input.together && group.every(source => input.shots[source.role]?.[source.sourceIndex] && input.cutouts?.[source.role]?.[source.sourceIndex]);
    const displayed = together || slot.splitFallback ? group : [slot];
    for (const source of displayed) {
      const width = slot.width * size.width / (together ? 1 : displayed.length), height = slot.height * size.height;
      add(cell, source.role, source.sourceIndex, width, height, { ...source.crop, sourceIndex: source.sourceIndex, filterId: source.filterId ?? null }, source.sliceX ? source.sliceX[1] - source.sliceX[0] : 1,
        together ? "cutout" : "photo", height * (group.length > 2 ? .8 : .92) * (input.together?.places[source.role]?.scale ?? 1));
    }
  });
  else for (let cell = 0; cell < input.layout.cols * input.layout.rows; cell++) {
    const index = cellShotIndex(input.layout, cell), height = CELL_W / input.layout.cellAspect;
    const roles = ROLES.filter(role => input.shots[role]?.some(Boolean));
    const editFor = (role: Role) => input.cellEdits?.[`${cell}:${role}`] ?? defaultCellEdit(index);
    const together = input.together && getScene(input.together.sceneId) && roles.length > 0 && roles.every(role => input.cutouts?.[role]?.[editFor(role).sourceIndex]);
    const owner = input.layout.duoPattern?.[cell] ?? "A";
    const displayed = together ? roles : owner === "AB" ? ["A", "B"] as Role[] : [owner];
    for (const role of displayed) {
      const edit = editFor(role), split = !together && owner === "AB";
      add(cell, role, edit.sourceIndex, CELL_W / (split ? 2 : 1), height, edit, split ? .5 : 1, together ? "cutout" : "photo",
        height * (roles.length > 2 ? .8 : .92) * (input.together?.places[role]?.scale ?? 1));
    }
  }
  const ratios = sources.flatMap(item => item.pixelsPerOutputPixel === null ? [] : [item.pixelsPerOutputPixel]);
  const minimumPixelRatio = ratios.length ? Math.min(...ratios) : null;
  const warnings: string[] = [];
  if (sources.some(item => item.missing)) warnings.push("Some photo slots are empty. Their placeholders will be exported.");
  if (minimumPixelRatio !== null && minimumPixelRatio < .99) warnings.push(geometry.unit === "mm" ? "Some photo crops render below 300 ppi at this print size." : "Some photo crops are enlarged beyond their source resolution.");
  const requestedWidth = size.width * unitScale * pixelsPerUnit, requestedHeight = size.height * unitScale * pixelsPerUnit;
  if (requestedWidth > RESOURCE_LIMITS.photoEdge || requestedHeight > RESOURCE_LIMITS.photoEdge || requestedWidth * requestedHeight > RESOURCE_LIMITS.photoPixels) warnings.push("The composition raster is capped by the 4096-pixel / 12-MiPixel export limit.");
  return { sources, minimumPpi: geometry.unit === "mm" && minimumPixelRatio !== null ? minimumPixelRatio * PRINT_PPI : null, minimumPixelRatio, warnings };
}
