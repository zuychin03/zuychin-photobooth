import type { PhotoProject, ProjectMedia } from "../projects/model";
import { templateBlobHash } from "./bundle";
import { validateTemplateDesign, type TemplateDesign } from "./model";

export async function prepareTemplateMedia(project: PhotoProject, originals: ReadonlyMap<string, Blob>, design: TemplateDesign, incoming: ReadonlyMap<string, Blob>) {
  const template = validateTemplateDesign(design), remapped = new Map<string, string>(), additions = new Map<string, Blob>();
  const declarations: ProjectMedia[] = [], hashes = new Map<string, string>(), used = new Set<string>();
  for (const item of template.decorations) {
    const blob = incoming.get(item.id);
    if (!blob || blob.size !== item.bytes || blob.type !== item.mime) throw new Error("A template decoration is missing or differs from its declaration");
    const hash = await templateBlobHash(blob);
    let match: ProjectMedia | undefined;
    for (const candidate of project.media) {
      if (candidate.kind !== "decoration" || used.has(candidate.id) || candidate.bytes !== item.bytes || candidate.mime !== item.mime || candidate.width !== item.width || candidate.height !== item.height) continue;
      const original = originals.get(candidate.id);
      if (!original || original.size !== candidate.bytes || original.type !== candidate.mime) continue;
      if (!hashes.has(candidate.id)) hashes.set(candidate.id, await templateBlobHash(original));
      if (hashes.get(candidate.id) === hash) { match = candidate; break; }
    }
    const id = match?.id ?? crypto.randomUUID();
    remapped.set(item.id, id); used.add(id);
    declarations.push(match ?? { ...item, id, participantId: null });
    if (!match) additions.set(id, blob);
  }
  const mapped = validateTemplateDesign({ ...template,
    decorations: declarations.map(({ participantId: _participantId, ...item }) => { void _participantId; return item; }),
    layers: template.layers.map(layer => layer.kind === "decoration" ? { ...layer, mediaId: remapped.get(layer.mediaId)! } : layer),
  });
  return { template: mapped, additions, media: declarations.filter(item => additions.has(item.id)) };
}
