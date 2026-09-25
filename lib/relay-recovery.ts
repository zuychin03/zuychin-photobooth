import { inspectProjectImage, projectImageToCanvas } from "./projects/images";
import { createProject, validatePhotoProject } from "./projects/model";
import { openProjectRepository } from "./projects/storage";
import { projectBlobHash } from "./projects/bundle";

export async function importRelayPhotos(files: readonly Blob[], count: number, active: () => boolean, decode = projectImageToCanvas) {
  if (files.length !== count || count < 1 || count > 4) throw new Error(`Choose exactly ${count} photos.`);
  const frames: HTMLCanvasElement[] = [];
  try {
    for (const file of files) {
      if (!active()) throw new Error("Capture closed");
      const frame = await decode(file); frames.push(frame);
      if (!active()) throw new Error("Capture closed");
    }
    return frames;
  } catch (error) { for (const frame of frames) frame.width = frame.height = 0; throw error; }
}

export class RelayOriginalEncoder {
  private occupied = false;
  private drain: Promise<void> = Promise.resolve();
  get busy() { return this.occupied; }
  settled() { return this.drain; }
  encode(frame: HTMLCanvasElement, timeoutMs = 10_000): Promise<Blob> {
    if (this.occupied) return Promise.reject(new Error("The previous photo is still being prepared. Wait before retrying."));
    this.occupied = true;
    let finished!: () => void;
    this.drain = new Promise(resolve => { finished = resolve; });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Photo preparation timed out. Your photo is retained; wait for preparation to finish, then retry.")), timeoutMs);
      const done = () => { clearTimeout(timer); this.occupied = false; finished(); };
      try { frame.toBlob(blob => { done(); if (blob && blob.size <= 10 * 1024 * 1024) resolve(blob); else reject(new Error("This photo could not be prepared within the 10 MiB limit. Your photo is retained.")); }, "image/png"); }
      catch (error) { done(); reject(error); }
    });
  }
}
export const relayOriginalEncoder = new RelayOriginalEncoder();
export const relayFrameOriginal = (frame: HTMLCanvasElement) => relayOriginalEncoder.encode(frame);

type RelayOriginalInput = { id: string; ownerId: string; layoutId: string; filterId: string; role: "A" | "B"; shots?: number; originals: readonly Blob[]; active(): boolean };
export async function loadRelayOriginals(input: Pick<RelayOriginalInput, "id" | "ownerId" | "role" | "active">, open = openProjectRepository) {
  const check = () => { if (!input.active()) throw new Error("Your account or relay page changed."); };
  check(); const repository = await open({ kind: "account", ownerId: input.ownerId }, { assertActive: check });
  try {
    check(); const loaded = await repository.load(`relay-${input.id}-${input.role}`); check();
    if (!loaded) return null;
    if (loaded.kind !== "current" || loaded.project.role !== input.role || loaded.media.size > 4 || loaded.media.size < 1 || loaded.project.participants.length !== 1 || loaded.project.participants[0].id !== "relay-owner") throw new Error("The recovery project changed. Keep a backup in My projects.");
    const originals: Blob[] = [];
    for (let i = 0; i < loaded.media.size; i++) { const blob = loaded.media.get(`photo-${i}`); if (!blob) throw new Error("The recovery inventory changed. Keep a backup in My projects."); originals.push(blob); }
    return { project: loaded.project, originals };
  } finally { repository.close(); }
}

export async function saveRelayOriginals(input: RelayOriginalInput, open = openProjectRepository, inspect = inspectProjectImage) {
  const check = () => { if (!input.active()) throw new Error("Your account or relay page changed. No upload was started."); };
  const shots = input.shots ?? input.originals.length;
  check(); if (!Number.isInteger(shots) || shots < 1 || shots > 4 || input.originals.length < 1 || input.originals.length > shots) throw new Error("Choose one to four photos.");
  const initial = createProject({ id: `relay-${input.id}-${input.role}`, scope: { kind: "account", ownerId: input.ownerId }, mode: "duo", role: input.role, name: "Relay originals", participants: [{ id: "relay-owner", role: input.role }], capture: { requiredShots: shots as 1 | 2 | 3 | 4 }, editor: { layoutId: input.layoutId, filterId: input.filterId, showDate: false } });
  const media = [], blobs = new Map<string, Blob>();
  for (const [index, blob] of input.originals.entries()) { const info = await inspect(blob); check(); const id = `photo-${index}`; media.push({ id, kind: "photo" as const, participantId: "relay-owner", ...info, bytes: blob.size }); blobs.set(id, blob); }
  const repository = await open(initial.scope, { assertActive: check });
  try {
    check(); const existing = await repository.load(initial.id); check();
    if (existing) {
      if (existing.kind !== "current" || existing.media.size > blobs.size || existing.project.role !== input.role || existing.project.capture.requiredShots !== shots || existing.project.editor.layoutId !== input.layoutId || existing.project.editor.filterId !== input.filterId) throw new Error("Your recovery project changed. Keep your originals before retrying.");
      for (const [id, blob] of existing.media) { if (!blobs.has(id) || await projectBlobHash(blob) !== await projectBlobHash(blobs.get(id)!)) throw new Error("Your recovery originals differ. Keep both copies before continuing."); check(); }
      if (existing.media.size === blobs.size) return existing.project;
    }
    const prior = existing?.kind === "current" ? existing.project : null;
    const project = validatePhotoProject({ ...(prior ?? initial), schemaVersion: 4, media, sourceOrder: { ...initial.sourceOrder, [input.role]: media.map(item => item.id) }, revision: prior ? prior.revision + 1 : 0, updatedAt: new Date(Math.max(Date.now(), Date.parse(prior?.updatedAt ?? initial.updatedAt))).toISOString() });
    const saved = await repository.save(project, blobs, prior?.revision ?? null); check(); return saved;
  } finally { repository.close(); }
}
