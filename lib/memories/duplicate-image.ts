import type { MemoryActivity } from "./activity-contract";
import type { RetainedStripClient } from "./retained-strip-client";
import type { RetainedStripDownload } from "./retained-strip-contract";
import { createProject, validatePhotoProject } from "../projects/model";
import { RESOURCE_LIMITS } from "../projects/resource-bounds";
import { openProjectRepository } from "../projects/storage";
import { validateTemplateDesign } from "../templates/model";
export class MemoryImageCopyError extends Error {}

export function flattenedMemoryProject(image: RetainedStripDownload, ownerId: string, now = new Date().toISOString()) {
  if (image.blob.size > RESOURCE_LIMITS.photoBytes) throw new MemoryImageCopyError("This finished image exceeds the 10 MiB local project limit. Its full original remains unchanged.");
  if (image.width < 128 || image.height < 128) throw new MemoryImageCopyError("This image is too small for the local editor. Its full original remains unchanged.");
  const template = validateTemplateDesign({ canvas: { width: image.width, height: image.height }, requiredSources: { A: 1 }, slots: [{ id: "finished-image", x: 0, y: 0, width: 1, height: 1, role: "A", sourceIndex: 0, crop: { zoom: 1, offsetX: 0, offsetY: 0, rotation: 0, mirror: false } }], layers: [], decorations: [], look: { frameId: "film", filterId: "none", patternId: "none", themeId: null, sceneId: null, materialId: null }, defaults: { caption: "", showDate: false } });
  const project = createProject({ scope: { kind: "account", ownerId }, name: "Finished image copy", createdAt: now, participants: [{ id: "image-owner", role: "A" }], capture: { requiredShots: 1 }, editor: { template, caption: "", showDate: false } });
  return validatePhotoProject({ ...project, media: [{ id: "finished-image", kind: "photo", participantId: "image-owner", mime: "image/png", bytes: image.blob.size, width: image.width, height: image.height }], sourceOrder: { A: ["finished-image"], B: [], C: [], D: [] } });
}

export async function duplicateMemoryImage(item: MemoryActivity, client: RetainedStripClient, signal?: AbortSignal, open = openProjectRepository) {
  const assertActive = () => client.assertActive(signal);
  assertActive();
  if (item.source?.kind !== "strip" || !["available", "archive_pending", "archived"].includes(item.availability)) throw new Error("This memory has no available finished image.");
  const id = item.source.id;
  await client.resolve(id, signal); assertActive();
  const image = await client.download(id, signal); assertActive();
  if (image.id !== id) throw new Error("The finished image changed. Refresh memories and try again.");
  const project = flattenedMemoryProject(image, client.ownerId);
  await client.resolve(id, signal); assertActive();
  const repository = await open(project.scope, { assertActive });
  try { assertActive(); await repository.save(project, new Map([["finished-image", image.blob]]), null); assertActive(); return project; }
  finally { repository.close(); }
}
