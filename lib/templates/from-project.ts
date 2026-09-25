import { CELL_GAP, CELL_W, STRIP_MARGIN, cellShotIndex, getLayout, stripSize, type Role } from "../layouts";
import type { PhotoProject } from "../projects/model";
import { defaultCellEdit } from "../projects/transforms";
import { validateTemplateDesign, type TemplateDesign, type TemplatePhotoSlot, type TemplatePhotoSource, type TemplateStickerLayer } from "./model";

export function templateFromProject(project: PhotoProject): TemplateDesign {
  const editor = project.editor;
  const look = { frameId: editor.frameId, filterId: editor.filterId, patternId: editor.patternId, themeId: editor.themeId, sceneId: editor.sceneId, materialId: editor.materialId ?? null };
  const defaults = { caption: editor.caption, showDate: editor.showDate };
  const layout = getLayout(editor.layoutId), canvas = editor.template?.canvas ?? stripSize(layout), cellHeight = CELL_W / layout.cellAspect;
  const extraLayers: TemplateStickerLayer[] = editor.stickers.map(sticker => {
    const width = Math.min(1, 96 * sticker.scale / canvas.width), height = Math.min(1, 96 * sticker.scale / canvas.height);
    let id = `sticker-${sticker.key}`;
    while (editor.template?.layers.some(layer => layer.id === id) || editor.template?.slots.some(slot => slot.id === id)) id = `copy-${id}`;
    return { id, kind: "sticker", slug: sticker.slug, style: editor.stickerStyle,
      x: Math.min(1 - width, Math.max(0, sticker.x - width / 2)), y: Math.min(1 - height, Math.max(0, sticker.y - height / 2)), width, height,
      rotation: ((sticker.rotation * 180 / Math.PI + 180) % 360 + 360) % 360 - 180 };
  });
  if (editor.template) return validateTemplateDesign({ ...editor.template, look, defaults, places: Object.fromEntries(Object.entries(editor.places).filter(([role]) => editor.template!.requiredSources[role as Role])), layers: [...editor.template.layers, ...extraLayers] });
  const slots: TemplatePhotoSlot[] = [], requiredSources: Partial<Record<Role, 1 | 2 | 3 | 4>> = {};
  const source = (role: Role, i: number, split: boolean): TemplatePhotoSource => {
    const { sourceIndex, filterId, ...crop } = editor.cellEdits[`${i}:${role}`] ?? defaultCellEdit(cellShotIndex(layout, i));
    requiredSources[role] = Math.max(requiredSources[role] ?? 0, sourceIndex + 1) as 1 | 2 | 3 | 4;
    return { role, sourceIndex, crop, filterId, ...(split ? { sliceX: [0.25, 0.75] as const } : {}) };
  };
  for (let i = 0; i < layout.rows * layout.cols; i++) {
    const owner = layout.duoPattern?.[i] ?? "A", roles: Role[] = owner === "AB" ? ["A", "B"] : [owner];
    (editor.sceneId ? [roles[0]] : roles).forEach((role, half) => {
      const companions = editor.sceneId ? project.participants.filter(person => person.role !== role).map(person => source(person.role, i, owner === "AB")) : [];
      slots.push({ id: `photo-${i}-${role}`, ...source(role, i, owner === "AB"),
        x: (STRIP_MARGIN + (i % layout.cols) * (CELL_W + CELL_GAP) + half * CELL_W / 2) / canvas.width,
        y: (STRIP_MARGIN + Math.floor(i / layout.cols) * (cellHeight + CELL_GAP)) / canvas.height,
        width: CELL_W / (editor.sceneId ? 1 : roles.length) / canvas.width, height: cellHeight / canvas.height,
        ...(companions.length ? { companions, splitFallback: owner === "AB" } : {}),
      });
    });
  }
  return validateTemplateDesign({ canvas, requiredSources, slots, look, defaults, places: Object.fromEntries(Object.entries(editor.places).filter(([role]) => requiredSources[role as Role])), decorations: [], layers: extraLayers });
}
