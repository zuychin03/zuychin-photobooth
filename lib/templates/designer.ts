import { ROLES, type Role } from "../layouts";
import { validateTemplateDesign, type TemplateDesign, type TemplatePhotoSlot } from "./model";

export function reviseTemplate(design: TemplateDesign, patch: Partial<TemplateDesign>): TemplateDesign {
  const next = { ...design, ...patch }, requiredSources: Partial<Record<Role, 1 | 2 | 3 | 4>> = {};
  for (const slot of next.slots) for (const source of [slot, ...(slot.companions ?? [])]) requiredSources[source.role] = Math.max(requiredSources[source.role] ?? 0, source.sourceIndex + 1) as 1 | 2 | 3 | 4;
  const used = new Set(next.layers.flatMap(layer => layer.kind === "decoration" ? [layer.mediaId] : []));
  const places = next.places ? Object.fromEntries(Object.entries(next.places).filter(([role]) => requiredSources[role as Role])) : null;
  return validateTemplateDesign({ ...next, requiredSources, ...(places ? { places } : {}), decorations: next.decorations.filter(item => used.has(item.id)) });
}

export function moveTemplateItem(design: TemplateDesign, id: string, x: number, y: number): TemplateDesign {
  const move = <T extends { id: string; x: number; y: number; width: number; height: number }>(item: T): T => item.id !== id ? item : { ...item, x: Math.min(1 - item.width, Math.max(0, x)), y: Math.min(1 - item.height, Math.max(0, y)) };
  return reviseTemplate(design, { slots: design.slots.map(move), layers: design.layers.map(move) });
}

export function newTemplateSlot(design: TemplateDesign, id: string): TemplatePhotoSlot {
  const role = ROLES.find(role => design.requiredSources[role]) ?? "A";
  return { id, role, sourceIndex: 0, x: 0.08, y: 0.08, width: 0.4, height: 0.24, crop: { zoom: 1, offsetX: 0, offsetY: 0, rotation: 0, mirror: false } };
}
