import { getLayout, splitSlice, stripGeometry, type Role, type ShotCount } from "../layouts";
import type { PhotoProject } from "../projects/model";
import { defaultCellEdit } from "../projects/transforms";
import { validateTemplateDesign, type TemplateDesign, type TemplatePhotoSlot, type TemplatePhotoSource, type TemplateStickerLayer } from "./model";

export function templateFromProject(project: PhotoProject): TemplateDesign {
  const editor = project.editor;
  const look = { frameId: editor.frameId, filterId: editor.filterId, patternId: editor.patternId, themeId: editor.themeId, sceneId: editor.sceneId, materialId: editor.materialId ?? null, ...(editor.strip ? { strip: editor.strip } : {}) };
  const defaults = { caption: editor.caption, showDate: editor.showDate };
  const geometry = stripGeometry(getLayout(editor.layoutId), editor.strip), canvas = editor.template?.canvas ?? { width: geometry.width, height: geometry.height };
  const extraLayers: TemplateStickerLayer[] = editor.stickers.map(sticker => {
    const width = Math.min(1, 96 * sticker.scale / canvas.width), height = Math.min(1, 96 * sticker.scale / canvas.height);
    let id = `sticker-${sticker.key}`;
    while (editor.template?.layers.some(layer => layer.id === id) || editor.template?.slots.some(slot => slot.id === id)) id = `copy-${id}`;
    return { id, kind: "sticker", slug: sticker.slug, style: editor.stickerStyle,
      x: Math.min(1 - width, Math.max(0, sticker.x - width / 2)), y: Math.min(1 - height, Math.max(0, sticker.y - height / 2)), width, height,
      rotation: ((sticker.rotation * 180 / Math.PI + 180) % 360 + 360) % 360 - 180 };
  });
  if (editor.template) return validateTemplateDesign({ ...editor.template, look, defaults, places: Object.fromEntries(Object.entries(editor.places).filter(([role]) => editor.template!.requiredSources[role as Role])), layers: [...editor.template.layers, ...extraLayers] });
  const slots: TemplatePhotoSlot[] = [], requiredSources: Partial<Record<Role, ShotCount>> = {};
  for (const cell of geometry.cells) {
    const parts = cell.owners.length, split = parts > 1, slice = splitSlice(parts);
    const source = (role: Role): TemplatePhotoSource => {
      const { sourceIndex, filterId, ...crop } = editor.cellEdits[`${cell.index}:${role}`] ?? defaultCellEdit(cell.shot);
      requiredSources[role] = Math.max(requiredSources[role] ?? 0, sourceIndex + 1) as ShotCount;
      return { role, sourceIndex, crop, filterId, ...(split && slice[0] > 0 ? { sliceX: slice } : {}) };
    };
    (editor.sceneId ? [cell.owners[0]] : cell.owners).forEach((role, part) => {
      const companions = editor.sceneId ? project.participants.filter(person => person.role !== role).map(person => source(person.role)) : [];
      slots.push({ id: `photo-${cell.index}-${role}`, ...source(role),
        x: (cell.x + part * cell.width / parts) / canvas.width,
        y: cell.y / canvas.height,
        width: cell.width / (editor.sceneId ? 1 : parts) / canvas.width, height: cell.height / canvas.height,
        ...(companions.length ? { companions, splitFallback: split } : {}),
      });
    });
  }
  return validateTemplateDesign({ canvas, requiredSources, slots, look, defaults, places: Object.fromEntries(Object.entries(editor.places).filter(([role]) => requiredSources[role as Role])), decorations: [], layers: extraLayers });
}
