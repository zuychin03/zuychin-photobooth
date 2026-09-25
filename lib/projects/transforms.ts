import { FILTERS } from "../filters";

export interface PhotoCellEdit {
  sourceIndex: number;
  zoom: number;
  offsetX: number;
  offsetY: number;
  rotation: 0 | 90 | 180 | 270;
  mirror: boolean;
  filterId: string | null;
}

export function defaultCellEdit(sourceIndex: number): PhotoCellEdit {
  return { sourceIndex, zoom: 1, offsetX: 0, offsetY: 0, rotation: 0, mirror: false, filterId: null };
}

export function validateCellEdit(value: unknown): PhotoCellEdit {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid photo adjustment");
  const input = value as Record<string, unknown>;
  const keys = ["sourceIndex", "zoom", "offsetX", "offsetY", "rotation", "mirror", "filterId"];
  if (Object.keys(input).length !== keys.length || Object.keys(input).some(key => !keys.includes(key))
    || keys.some(key => !("value" in (Object.getOwnPropertyDescriptor(input, key) ?? {})))) throw new Error("Invalid photo adjustment fields");
  const within = (key: string, min: number, max: number) => typeof input[key] === "number" && Number.isFinite(input[key]) && input[key] >= min && input[key] <= max;
  if (!within("sourceIndex", 0, 3) || !Number.isInteger(input.sourceIndex) || !within("zoom", 1, 4)
    || !within("offsetX", -1, 1) || !within("offsetY", -1, 1) || ![0, 90, 180, 270].includes(input.rotation as number)
    || typeof input.mirror !== "boolean" || (input.filterId !== null && !FILTERS.some(filter => filter.id === input.filterId))) throw new Error("Photo adjustment is out of bounds");
  return { sourceIndex: input.sourceIndex, zoom: input.zoom, offsetX: input.offsetX, offsetY: input.offsetY, rotation: input.rotation, mirror: input.mirror, filterId: input.filterId } as PhotoCellEdit;
}

export function photoPlacement(sourceWidth: number, sourceHeight: number, width: number, height: number, edit: PhotoCellEdit) {
  if (![sourceWidth, sourceHeight, width, height].every(value => Number.isFinite(value) && value > 0)) throw new Error("Invalid photo dimensions");
  const settings = validateCellEdit(edit);
  const rotated = settings.rotation === 90 || settings.rotation === 270;
  const rotatedWidth = rotated ? sourceHeight : sourceWidth;
  const rotatedHeight = rotated ? sourceWidth : sourceHeight;
  const scale = Math.max(width / rotatedWidth, height / rotatedHeight) * settings.zoom;
  return {
    scale,
    translateX: settings.offsetX * (rotatedWidth * scale - width) / 2,
    translateY: settings.offsetY * (rotatedHeight * scale - height) / 2,
    drawWidth: sourceWidth * scale,
    drawHeight: sourceHeight * scale,
    radians: settings.rotation * Math.PI / 180,
  };
}

export function drawEditedPhoto(ctx: CanvasRenderingContext2D, source: HTMLCanvasElement, x: number, y: number, width: number, height: number, edit: PhotoCellEdit, slice: [number, number] = [0, 1]): void {
  const sourceWidth = source.width * (slice[1] - slice[0]);
  const place = photoPlacement(sourceWidth, source.height, width, height, edit);
  ctx.save();
  try {
    ctx.beginPath(); ctx.rect(x, y, width, height); ctx.clip();
    ctx.translate(x + width / 2 + place.translateX, y + height / 2 + place.translateY);
    ctx.rotate(place.radians);
    ctx.scale(edit.mirror ? -1 : 1, 1);
    ctx.drawImage(source, source.width * slice[0], 0, sourceWidth, source.height, -place.drawWidth / 2, -place.drawHeight / 2, place.drawWidth, place.drawHeight);
  } finally { ctx.restore(); }
}
