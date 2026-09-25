import { composeStrip, type ComposeInput, type ShotSet } from "../compose";
import { FRAMES } from "../decor";
import { LAYOUTS } from "../layouts";
import { THEMES } from "../themes";
import { createAssetLoader, type ReadyAsset } from "../assets/loader";
import { getStickerImage, preloadStickers } from "../sticker-assets";
import { inspectImageHeader } from "../projects/images";
import { openProjectRepository, type ProjectRepository } from "../projects/storage";
import { validatePhotoProject, type PhotoProject, type ProjectMedia } from "../projects/model";
import { templateFromProject } from "../templates/from-project";
import { validateTemplateDesign, type TemplateDesign } from "../templates/model";
import type { PostcardSource } from "../events/postcard-contract";
import { ROOM_PHOTO_BUDGET_BYTES, ROOM_PHOTO_BUDGET_PIXELS, type RoomState } from "../server/room-contract";
import type { WorkspaceSnapshot } from "./workspace-controller";
import { createRoomApi } from "./signaling-v2";

const changed = () => { throw new Error("The shared capture or design changed. Refresh the room before preparing this postcard."); };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function roomPostcardPlan(snapshot: WorkspaceSnapshot) {
  const { room, round, recipe } = snapshot, capture = room.capture;
  if (!round || !recipe || !capture || capture.state !== "committed" || capture.captureId !== round.id || capture.rosterRevision !== room.rosterRevision || room.status !== "open" || snapshot.capturing || snapshot.pendingProposal || snapshot.recoveryRecipe || snapshot.pendingLocalFrames.length) return changed();
  const project = validatePhotoProject(round), people = room.members.filter(member => capture.memberIds.includes(member.id));
  if (people.length !== capture.memberIds.length || !people.some(member => member.id === room.selfId) || people.some(member => member.status !== "admitted" || !member.role || recipe.recipe.owners[member.role] !== member.id || !project.participants.some(person => person.id === member.id && person.role === member.role)) || !same(project.editor, recipe.recipe.editor)) return changed();
  const used = new Set<string>(); let bytes = 0, pixels = 0;
  for (const person of project.participants) {
    if (!capture.memberIds.includes(person.id)) return changed();
    const ids = project.sourceOrder[person.role];
    if (ids.length !== capture.shotIds.length || ids.some(id => !id)) return changed();
    for (const id of ids) { const media = project.media.find(item => item.id === id); if (!media || media.kind !== "photo" || media.participantId !== person.id || used.has(media.id) || media.bytes > capture.profile.maxPhotoBytes || media.width * media.height > capture.profile.maxPhotoPixels) return changed(); used.add(media.id); bytes += media.bytes; pixels += media.width * media.height; }
  }
  if (used.size !== capture.memberIds.length * capture.shotIds.length) return changed();
  if (bytes > ROOM_PHOTO_BUDGET_BYTES || pixels > ROOM_PHOTO_BUDGET_PIXELS) throw new Error("This capture exceeds the room's original-photo export budget.");
  const design = templateFromProject(project);
  if (Object.keys(design.requiredSources).some(role => !project.participants.some(person => person.role === role)) || design.slots.some(slot => slot.companions?.length && !slot.splitFallback)) throw new Error("Use a separate-photo or split layout before starting this postcard. This Together layout cannot preserve every participant without prepared cutouts.");
  const source: PostcardSource = { kind: "room", id: room.roomId, captureId: capture.captureId };
  return { source, design, project, fingerprint: JSON.stringify({ project, recipeHash: recipe.recipeHash, recipeRevision: recipe.revision, roomId: room.roomId, sessionId: room.sessionId, selfId: room.selfId, rosterRevision: room.rosterRevision, capture }) };
}
type Plan = ReturnType<typeof roomPostcardPlan>;
export interface RoomPostcardRenderPorts {
  open(project: PhotoProject): Promise<Pick<ProjectRepository, "load" | "close">>;
  state(roomId: string, signal: AbortSignal): Promise<RoomState>;
  decode(blob: Blob, media: ProjectMedia, signal: AbortSignal): Promise<HTMLCanvasElement>;
  prepare(design: TemplateDesign, signal: AbortSignal): Promise<{ resources: ReadonlyMap<string, ReadyAsset>; release(): void }>;
  render(input: ComposeInput, signal: AbortSignal): Promise<Blob>;
}
const check = (signal: AbortSignal) => signal.throwIfAborted();
const native: RoomPostcardRenderPorts = {
  open: project => openProjectRepository(project.scope),
  state: (roomId, signal) => createRoomApi(roomId, { signal }).state(),
  async decode(blob, media, signal) {
    check(signal); const header = inspectImageHeader(new Uint8Array(await blob.arrayBuffer())); check(signal);
    if (blob.size !== media.bytes || blob.type !== media.mime || !same(header, { mime: media.mime, width: media.width, height: media.height })) throw new Error("A saved original no longer matches this room capture.");
    const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" }); let canvas: HTMLCanvasElement | undefined;
    try { check(signal); if (bitmap.width !== media.width || bitmap.height !== media.height) throw new Error("A saved original could not be decoded faithfully."); canvas = document.createElement("canvas"); canvas.width = bitmap.width; canvas.height = bitmap.height; const context = canvas.getContext("2d"); if (!context) throw new Error("Photo rendering is unavailable."); context.drawImage(bitmap, 0, 0); return canvas; }
    catch (error) { if (canvas) canvas.width = canvas.height = 0; throw error; }
    finally { bitmap.close(); }
  },
  async prepare(design, signal) {
    const loader = createAssetLoader(), resources = new Map<string, ReadyAsset>();
    try {
      await document.fonts.ready; check(signal);
      if (design.look.materialId) { const material = await loader.preload(design.look.materialId); check(signal); if (material.kind !== "ready") throw new Error("The selected print material is unavailable. Retry before preparing the postcard."); resources.set(material.asset.id, material); }
      const theme = THEMES.find(item => item.id === design.look.themeId), stickers = [...design.layers.flatMap(layer => layer.kind === "sticker" ? [{ slug: layer.slug, style: layer.style }] : []), ...(theme?.decor.map(item => ({ slug: item.slug, style: theme.stickerStyle })) ?? [])];
      for (const style of ["flat", "3d"] as const) { const slugs = [...new Set(stickers.filter(item => item.style === style).map(item => item.slug))]; if (slugs.length) { await preloadStickers(style, slugs); check(signal); if (slugs.some(slug => !getStickerImage(style, slug))) throw new Error("Some selected sticker artwork is unavailable. Retry before preparing the postcard."); } }
      return { resources, release: () => loader.dispose() };
    } catch (error) { loader.dispose(); throw error; }
  },
  async render(input, signal) {
    const canvas = document.createElement("canvas"), size = input.template!.canvas;
    try {
      composeStrip(canvas, input, Math.min(2, 4096 / Math.max(size.width, size.height), Math.sqrt(12000000 / (size.width * size.height)))); check(signal);
      for (const quality of [.92, .82, .72, .62, .52, .42, .32]) { const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("The postcard could not be encoded.")), "image/jpeg", quality)); check(signal); if (blob.type === "image/jpeg" && blob.size > 0 && blob.size <= 2000000) return blob; }
      throw new Error("This finished postcard is too large for the event. Use a smaller layout and try again.");
    } finally { canvas.width = canvas.height = 0; }
  },
};
let occupied = false;
export async function renderRoomPostcard(options: { initial: Plan; current(): WorkspaceSnapshot; design: TemplateDesign; signal: AbortSignal; assertActive(): void; databaseName?: string; timeoutMs?: number }, overrides: Partial<RoomPostcardRenderPorts> = {}): Promise<Blob> {
  const ports = { ...native, ...overrides }, initial = options.initial, timeout = options.timeoutMs ?? 60000;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 60000) throw new Error("Invalid postcard deadline");
  if (occupied) throw new Error("A postcard is still being prepared. Wait for it to finish before trying again.");
  check(options.signal); options.assertActive();
  if (!same(validateTemplateDesign(options.design), initial.design)) return changed();
  occupied = true; const abort = new AbortController(), signal = AbortSignal.any([abort.signal, options.signal]), timer = setTimeout(() => abort.abort(), timeout);
  const current = () => { check(signal); options.assertActive(); if (roomPostcardPlan(options.current()).fingerprint !== initial.fingerprint) changed(); };
  const authority = async () => { current(); const fresh = await ports.state(initial.source.id, signal); current(); const known = options.current().room; if (fresh.roomId !== known.roomId || fresh.sessionId !== known.sessionId || fresh.selfId !== known.selfId || fresh.status !== "open" || fresh.rosterRevision !== known.rosterRevision || !same(fresh.capture, known.capture) || fresh.members.some(member => initial.project.participants.some(person => person.id === member.id && (person.role !== member.role || member.status !== "admitted"))) || !initial.project.participants.every(person => fresh.members.some(member => member.id === person.id))) changed(); };
  let listener = () => {};
  const work = (async () => {
    const images = new Map<string, HTMLCanvasElement>(); let repository: Pick<ProjectRepository, "load" | "close"> | undefined, prepared: Awaited<ReturnType<RoomPostcardRenderPorts["prepare"]>> | undefined;
    try {
      await authority(); repository = options.databaseName && !overrides.open ? await openProjectRepository(initial.project.scope, { databaseName: options.databaseName }) : await ports.open(initial.project); current();
      const loaded = await repository.load(initial.project.id); current(); if (!loaded || loaded.kind !== "current" || !same(loaded.project, initial.project)) return changed();
      const ids = new Set([...Object.values(initial.project.sourceOrder).flat().filter((id): id is string => id !== null), ...initial.design.decorations.map(item => item.id)]);
      for (const id of ids) { const media = initial.project.media.find(item => item.id === id), blob = loaded.media.get(id); if (!media || !blob) throw new Error("A saved original is unavailable. Restore the complete capture before preparing a postcard."); const image = await ports.decode(blob, media, signal); images.set(id, image); current(); if (image.width !== media.width || image.height !== media.height) throw new Error("A saved original has different dimensions."); }
      prepared = await ports.prepare(initial.design, signal); current(); const shots: ShotSet = {}, decorations = new Map<string, HTMLCanvasElement>();
      for (const person of initial.project.participants) shots[person.role] = initial.project.sourceOrder[person.role].map(id => id ? images.get(id)! : null);
      for (const declaration of initial.design.decorations) decorations.set(declaration.id, images.get(declaration.id)!);
      const frame = FRAMES.find(item => item.id === initial.design.look.frameId)!;
      const blob = await ports.render({ layout: LAYOUTS[0], shots, template: initial.design, decorations, resources: prepared.resources, materialId: initial.design.look.materialId, stickers: [], together: null, theme: THEMES.find(item => item.id === initial.design.look.themeId) ?? null, capturedAt: initial.project.capturedAt, captureTimeZone: initial.project.captureTimeZone, style: { frameColor: frame.color, inkColor: frame.ink, filterId: initial.design.look.filterId, patternId: initial.design.look.patternId, caption: initial.design.defaults.caption, showDate: initial.design.defaults.showDate, stickerStyle: "flat" } }, signal); current();
      if (blob.type !== "image/jpeg" || blob.size < 1 || blob.size > 2000000) throw new Error("The finished postcard exceeds the event photo limit.");
      await authority(); const final = await repository.load(initial.project.id); current(); if (!final || final.kind !== "current" || !same(final.project, initial.project)) return changed(); return blob;
    } finally { repository?.close(); prepared?.release(); for (const image of images.values()) image.width = image.height = 0; images.clear(); occupied = false; }
  })();
  try { return await Promise.race([work, new Promise<never>((_, reject) => { listener = () => reject(new DOMException("Postcard preparation cancelled or timed out", "AbortError")); signal.addEventListener("abort", listener, { once: true }); if (signal.aborted) listener(); })]); }
  finally { clearTimeout(timer); signal.removeEventListener("abort", listener); }
}
