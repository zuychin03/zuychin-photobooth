import { LAYOUTS, type Role } from "../layouts";
import { appendProjectMedia, createProject, serializePhotoProject, validatePhotoProject, type PhotoProject, type ProjectParticipant, type ProjectScope } from "../projects/model";
import { openProjectRepository, type ProjectRepository } from "../projects/storage";
import { inspectProjectImage, type ProjectImageInfo } from "../projects/images";
import { projectBlobHash } from "../projects/bundle";
import { RESOURCE_LIMITS } from "../projects/resource-bounds";
import type { RoomCapture, RoomState } from "../server/room-contract";
import { acceptRecipeCommit, hashRecipe, validateRecipeCommit, validateRecipeContext, type RecipeCommit } from "./recipe-v2";
import { UUID_PATTERN } from "./protocol";
import { validateRoomCapture, validateRoomState } from "./signaling-v2";
import { registerRoomScopeCloser, roomScopeEpoch, roomScopeKey, withRoomScopeLock } from "./scope-lifecycle";

export interface RoomWorkspaceBinding { scope: ProjectScope; roomId: string; sessionId: string; selfId: string }
export interface RoomDraft { project: PhotoProject; recipe: RecipeCommit | null }
export interface RoomRound { project: PhotoProject; capture: RoomCapture; recipe: RecipeCommit; participants: readonly ProjectParticipant[]; initialRecipeHash: string }
export interface RoomWorkspaceStore {
  loadDraft(roster: RoomState): Promise<RoomDraft>;
  saveRecipe(commit: RecipeCommit, media?: ReadonlyMap<string, Blob>): Promise<RoomDraft>;
  prepareRound(capture: RoomCapture, recipe: RecipeCommit, media?: ReadonlyMap<string, Blob>): Promise<RoomRound>;
  updateRoundRecipe(captureId: string, commit: RecipeCommit, media?: ReadonlyMap<string, Blob>): Promise<RoomRound>;
  acceptHostSnapshot(commit: RecipeCommit, captureId?: string, media?: ReadonlyMap<string, Blob>): Promise<{ draft: RoomDraft; round: RoomRound | null }>;
  saveFrame(input: { capture: RoomCapture; role: Role; shotIndex: number; blob: Blob }): Promise<string>;
  loadSavedFrame(captureId: string, role: Role, shotIndex: number): Promise<Blob | null>;
  loadRound(captureId: string): Promise<RoomRound | null>;
  close(): Promise<void>;
}
export class RoomWorkspaceError extends Error {
  constructor(readonly code: "closed" | "identity" | "recovery" | "conflict" | "missing" | "profile" | "media" | "capacity", readonly projectId?: string) { super(`room_workspace_${code}`); }
}
interface PendingWrite { target: PhotoProject; recipe: RecipeCommit | null; baseRevision: number | null }
export interface WorkspaceCheckpoint {
  key: string; binding: string; version: number; kind: "draft" | "round"; projectId: string; projectRevision: number | null;
  rosterRevision: number; hostId: string; participants: ProjectParticipant[]; recipe: RecipeCommit | null;
  capture: RoomCapture | null; pending: PendingWrite | null;
  expiresAt?: number;
}
export interface WorkspaceMetadata {
  get(key: string): Promise<WorkspaceCheckpoint | null>;
  put(value: WorkspaceCheckpoint, expectedVersion: number | null): Promise<void>;
  close(): void;
}
interface WorkspaceDependencies {
  projects: ProjectRepository; metadata: WorkspaceMetadata;
  inspect?: (blob: Blob) => Promise<ProjectImageInfo>; now?: () => string;
  lock?: <T>(work: () => Promise<T>) => Promise<T>;
}
const fail = (code: RoomWorkspaceError["code"], id?: string): never => { throw new RoomWorkspaceError(code, id); };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const frozenCapture = (value: RoomCapture) => ({ captureId: value.captureId, rosterRevision: value.rosterRevision, recipeHash: value.recipeHash, shotIds: value.shotIds, fireAt: value.fireAt, intervalMs: value.intervalMs, profile: value.profile, memberIds: value.memberIds });
function bindingKey(value: RoomWorkspaceBinding): string {
  if (![value.roomId, value.sessionId, value.selfId].every(id => UUID_PATTERN.test(id)) || (value.scope.kind !== "device" && (value.scope.kind !== "account" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value.scope.ownerId)))) return fail("identity");
  return `${value.scope.kind === "device" ? "device" : `account:${value.scope.ownerId}`}/${value.roomId}/${value.sessionId}/${value.selfId}`;
}
const shotCount = (project: PhotoProject, recipe: RecipeCommit) => (recipe.recipe.editor.template ? Math.max(...Object.values(recipe.recipe.editor.template.requiredSources)) : LAYOUTS.find(layout => layout.id === recipe.recipe.editor.layoutId)?.shots ?? project.capture.requiredShots) as 1 | 2 | 3 | 4;

/** Core injection is for fault tests; browser callers use openRoomWorkspaceStore. */
export function createRoomWorkspaceStore(input: RoomWorkspaceBinding, dependencies: WorkspaceDependencies): RoomWorkspaceStore {
  const binding = structuredClone(input), key = bindingKey(binding), { projects, metadata } = dependencies;
  if (!same(projects.scope, binding.scope)) fail("identity");
  const inspect = dependencies.inspect ?? inspectProjectImage, now = dependencies.now ?? (() => new Date().toISOString());
  let closed = false, draftKey: string | null = null, tail: Promise<unknown> = Promise.resolve(), closing: Promise<void> | null = null;
  const live = () => { if (closed) fail("closed"); };
  const enqueue = <T,>(work: () => Promise<T>): Promise<T> => { if (closed) return Promise.reject(new RoomWorkspaceError("closed")); const guarded = () => { live(); return work(); }; const next = tail.then(() => dependencies.lock ? dependencies.lock(guarded) : guarded()); tail = next.catch(() => {}); return next; };
  const read = async (recordKey: string) => {
    const record = await metadata.get(recordKey); live();
    if (record && (record.key !== recordKey || record.binding !== key || !Number.isSafeInteger(record.version) || record.version < 0 || !["draft", "round"].includes(record.kind)
      || !Number.isSafeInteger(record.rosterRevision) || record.rosterRevision < 1 || !UUID_PATTERN.test(record.hostId) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(record.projectId)
      || !Array.isArray(record.participants) || record.participants.length < 1 || record.participants.length > 4 || !record.participants.some(person => person.id === binding.selfId) || !record.participants.some(person => person.id === record.hostId)
      || record.participants.some(person => !UUID_PATTERN.test(person.id) || !["A", "B", "C", "D"].includes(person.role)) || new Set(record.participants.map(person => person.id)).size !== record.participants.length || new Set(record.participants.map(person => person.role)).size !== record.participants.length)) fail("recovery", record.projectId);
    if (record?.kind === "round") {
      if (!record.capture) fail("recovery", record.projectId);
      const capture = validateRoomCapture(record.capture);
      if (capture.captureId !== record.projectId || capture.rosterRevision !== record.rosterRevision || !same([...capture.memberIds].sort(), record.participants.map(person => person.id).sort())) fail("recovery", record.projectId);
    } else if (record?.capture) fail("recovery", record.projectId);
    return record;
  };
  const projectFor = async (record: WorkspaceCheckpoint, allowPending = false): Promise<PhotoProject> => {
    if (record.pending && !allowPending) return fail("recovery", record.projectId);
    const loaded = await projects.load(record.projectId); live();
    if (!loaded || loaded.kind !== "current") return fail("recovery", record.projectId);
    const project = loaded.project;
    if (!same(project.scope, binding.scope) || !same(project.participants, record.participants) || project.role !== record.participants.find(person => person.id === binding.selfId)?.role) return fail("identity", record.projectId);
    return project;
  };
  const checkedCommit = async (commit: RecipeCommit, project: PhotoProject, record: WorkspaceCheckpoint, acceptHostSnapshot = false) => {
    const checked = validateRecipeCommit(commit);
    if (await hashRecipe(checked.recipe) !== checked.recipeHash) fail("media", project.id);
    const context = { project, hostId: record.hostId, members: record.participants, availableMediaIds: new Set(project.media.map(media => media.id)) };
    validateRecipeContext(checked.recipe, context); live();
    if (acceptHostSnapshot) return checked;
    if (record.recipe) await acceptRecipeCommit(record.recipe, checked, record.hostId, context);
    else if (checked.revision !== 0 || checked.proposalId !== null || checked.authorId !== record.hostId) fail("conflict", project.id);
    return checked;
  };
  const persistPending = async (record: WorkspaceCheckpoint, media: ReadonlyMap<string, Blob>): Promise<WorkspaceCheckpoint> => {
    const pending = record.pending; if (!pending) return record;
    const target = validatePhotoProject(pending.target);
    if (target.id !== record.projectId || !same(target.scope, binding.scope) || !same(target.participants, record.participants) || target.role !== record.participants.find(person => person.id === binding.selfId)?.role) fail("identity", record.projectId);
    if (pending.recipe && (await hashRecipe(pending.recipe.recipe) !== pending.recipe.recipeHash || !same(target.editor, pending.recipe.recipe.editor))) fail("recovery", record.projectId);
    const loaded = await projects.load(record.projectId); live();
    if (loaded && loaded.kind !== "current") fail("recovery", record.projectId);
    if (loaded?.kind === "current" && serializePhotoProject(loaded.project) === serializePhotoProject(target)) {
      // The project transaction committed before its metadata acknowledgement.
    } else if ((loaded?.revision ?? null) === pending.baseRevision) {
      live(); await projects.save(target, media, pending.baseRevision); live();
    } else return fail("conflict", record.projectId);
    const next: WorkspaceCheckpoint = { ...record, version: record.version + 1, projectRevision: target.revision, recipe: pending.recipe, pending: null };
    live(); await metadata.put(next, record.version); live(); return next;
  };
  const write = async (record: WorkspaceCheckpoint, target: PhotoProject, commit: RecipeCommit | null, media: ReadonlyMap<string, Blob>) => {
    if (record.pending) {
      if (!same(record.pending.recipe, commit)) fail("recovery", record.projectId);
      return persistPending(record, media);
    }
    const pending: WorkspaceCheckpoint = { ...record, version: record.version + 1, pending: { target, recipe: commit, baseRevision: record.projectRevision } };
    live(); await metadata.put(pending, record.version); live(); return persistPending(pending, media);
  };
  const roundView = async (record: WorkspaceCheckpoint): Promise<RoomRound> => {
    if (record.kind !== "round" || !record.capture || !record.recipe) return fail("recovery", record.projectId);
    validateRoomCapture(record.capture);
    const project = await projectFor(record);
    if (await hashRecipe(record.recipe.recipe) !== record.recipe.recipeHash || !same(project.editor, record.recipe.recipe.editor)) fail("recovery", record.projectId);
    validateRecipeContext(record.recipe.recipe, { project, hostId: record.hostId, members: record.participants, availableMediaIds: new Set(project.media.map(media => media.id)) });
    return { project, capture: structuredClone(record.capture), recipe: validateRecipeCommit(record.recipe), participants: structuredClone(record.participants), initialRecipeHash: record.capture.recipeHash };
  };
  const withRecipe = (previous: PhotoProject, commit: RecipeCommit): PhotoProject => {
    const declarations = commit.recipe.editor.template?.decorations ?? [], existing = new Map(previous.media.map(media => [media.id, media]));
    for (const item of declarations) { const old = existing.get(item.id); if (old && !same({ id: old.id, kind: old.kind, mime: old.mime, bytes: old.bytes, width: old.width, height: old.height }, item)) fail("media", previous.id); if (!old) existing.set(item.id, { ...item, participantId: null }); }
    return validatePhotoProject({ ...previous, revision: previous.revision + 1, updatedAt: now(), editor: commit.recipe.editor, media: [...existing.values()], capture: previous.capturedAt ? previous.capture : { ...previous.capture, requiredShots: shotCount(previous, commit) }, history: { past: [], future: [] } });
  };
  const applyRecipe = async (record: WorkspaceCheckpoint, commit: RecipeCommit, media: ReadonlyMap<string, Blob>, acceptHostSnapshot = false) => {
    if (record.pending) { if (!same(record.pending.recipe, commit)) fail("recovery", record.projectId); return persistPending(record, media); }
    const previous = await projectFor(record);
    if (same(record.recipe, commit)) {
      if (!same(previous.editor, commit.recipe.editor)) fail("recovery", record.projectId);
      return record;
    }
    const edited = withRecipe(previous, commit), target = record.kind === "round" ? validatePhotoProject({ ...edited, capture: previous.capture }) : edited;
    const checked = await checkedCommit(commit, target, record, acceptHostSnapshot);
    return write({ ...record, projectRevision: previous.revision }, target, checked, media);
  };
  const store: RoomWorkspaceStore = {
    loadDraft: roster => enqueue(async () => {
      const state = validateRoomState(roster);
      if (state.roomId !== binding.roomId || state.sessionId !== binding.sessionId || state.selfId !== binding.selfId || !state.selfRole || state.status !== "open") fail("identity");
      const participants = state.members.filter(member => member.status === "admitted").map(member => ({ id: member.id, role: member.role! })).sort((a, b) => a.role.localeCompare(b.role));
      if (!participants.length || participants.length > 4 || !participants.some(person => person.id === binding.selfId && person.role === state.selfRole)) fail("identity");
      const recordKey = `${key}/draft/${state.rosterRevision}`;
      draftKey = recordKey;
      let record = await read(recordKey);
      if (!record) {
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(recordKey)); live();
        const id = `room-draft-${[...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("").slice(0, 48)}`;
        const layoutId = participants.some(person => person.role === "D") ? "quad" : participants.some(person => person.role === "C") ? "trio" : participants.some(person => person.role === "B") ? "duo-alternate" : "strip4";
        const mode = LAYOUTS.find(layout => layout.id === layoutId)!.mode;
        const project = createProject({ id, name: "Room draft", scope: binding.scope, mode, role: state.selfRole!, participants, editor: { layoutId }, createdAt: now() });
        record = { key: recordKey, binding: key, version: 0, kind: "draft", projectId: id, projectRevision: null, rosterRevision: state.rosterRevision, hostId: state.hostId, participants, recipe: null, capture: null, expiresAt: state.expiresAt, pending: { target: project, recipe: null, baseRevision: null } };
        await metadata.put(record, null); live(); record = await persistPending(record, new Map());
      } else if (!same(record.participants, participants) || record.hostId !== state.hostId || record.rosterRevision !== state.rosterRevision) fail("identity", record.projectId);
      else if (record.pending) record = await persistPending(record, new Map());
      if (record.expiresAt !== state.expiresAt) { const updated = { ...record, expiresAt: state.expiresAt, version: record.version + 1 }; await metadata.put(updated, record.version); record = updated; }
      const project = await projectFor(record);
      if (record.recipe) { if (await hashRecipe(record.recipe.recipe) !== record.recipe.recipeHash || !same(project.editor, record.recipe.recipe.editor)) fail("recovery", project.id); validateRecipeContext(record.recipe.recipe, { project, hostId: record.hostId, members: participants, availableMediaIds: new Set(project.media.map(media => media.id)) }); }
      draftKey = recordKey; return { project, recipe: record.recipe ? validateRecipeCommit(record.recipe) : null };
    }),
    saveRecipe: (commit, media = new Map()) => enqueue(async () => {
      if (!draftKey) return fail("missing"); const record = await read(draftKey); if (!record) return fail("missing");
      const saved = await applyRecipe(record, validateRecipeCommit(commit), media); return { project: await projectFor(saved), recipe: saved.recipe };
    }),
    prepareRound: (inputCapture, recipe, media = new Map()) => enqueue(async () => {
      const capture = validateRoomCapture(inputCapture), checked = validateRecipeCommit(recipe);
      if (capture.state === "aborted" || capture.recipeHash !== checked.recipeHash || !capture.memberIds.includes(binding.selfId)) fail("identity");
      const recordKey = `${key}/round/${capture.captureId}`; let record = await read(recordKey);
      if (record) {
        if (!record.capture || !same(frozenCapture(record.capture), frozenCapture(capture)) || (record.pending ? !same(record.pending.recipe, checked) : record.capture.recipeHash !== checked.recipeHash)) fail("conflict", record.projectId);
        if (record.pending) record = await persistPending(record, media);
        return roundView(record);
      }
      if (!draftKey) return fail("missing"); const draft = await read(draftKey); if (!draft || draft.pending || draft.rosterRevision !== capture.rosterRevision || !same(draft.recipe, checked)) return fail("recovery");
      const previous = await projectFor(draft), participants = draft.participants;
      if (!same([...capture.memberIds].sort(), participants.map(person => person.id).sort()) || capture.shotIds.length !== shotCount(previous, checked)) fail("profile");
      const loaded = await projects.load(previous.id); live(); if (!loaded || loaded.kind !== "current") return fail("recovery");
      const blobs = new Map(media); for (const item of previous.media) if (item.kind === "decoration" && !blobs.has(item.id)) { const blob = loaded.media.get(item.id); if (blob) blobs.set(item.id, blob); }
      const decorations = previous.media.filter(item => item.kind === "decoration");
      if (decorations.reduce((sum, item) => sum + item.bytes, 0) + capture.memberIds.length * capture.shotIds.length * capture.profile.maxPhotoBytes > RESOURCE_LIMITS.totalEncodedBytes
        || decorations.reduce((sum, item) => sum + item.width * item.height, 0) + capture.memberIds.length * capture.shotIds.length * capture.profile.maxPhotoPixels > RESOURCE_LIMITS.totalPixels) fail("profile");
      const timestamp = now(), project = validatePhotoProject({ ...previous, id: capture.captureId, name: "Room photos", revision: 0, createdAt: timestamp, updatedAt: timestamp, capturedAt: null, capture: { ...previous.capture, requiredShots: capture.shotIds.length }, media: decorations, sourceOrder: { A: [], B: [], C: [], D: [] }, history: { past: [], future: [] } });
      record = { key: recordKey, binding: key, version: 0, kind: "round", projectId: project.id, projectRevision: null, rosterRevision: capture.rosterRevision, hostId: draft.hostId, participants, recipe: null, capture, expiresAt: draft.expiresAt, pending: { target: project, recipe: checked, baseRevision: null } };
      await metadata.put(record, null); live(); record = await persistPending(record, blobs); return roundView(record);
    }),
    updateRoundRecipe: (captureId, commit, media = new Map()) => enqueue(async () => {
      if (!UUID_PATTERN.test(captureId)) return fail("identity"); const record = await read(`${key}/round/${captureId}`); if (!record) return fail("missing");
      return roundView(await applyRecipe(record, validateRecipeCommit(commit), media));
    }),
    acceptHostSnapshot: (commit, captureId, media = new Map()) => enqueue(async () => {
      if (!draftKey || (captureId !== undefined && !UUID_PATTERN.test(captureId))) return fail("identity");
      const checked = validateRecipeCommit(commit), record = await read(draftKey); if (!record) return fail("missing");
      const saved = await applyRecipe(record, checked, media, true);
      let round: RoomRound | null = null;
      if (captureId) { const captured = await read(`${key}/round/${captureId}`); if (!captured) return fail("missing", captureId); round = await roundView(await applyRecipe(captured, checked, media, true)); }
      return { draft: { project: await projectFor(saved), recipe: saved.recipe }, round };
    }),
    saveFrame: ({ capture: inputCapture, role, shotIndex, blob }) => enqueue(async () => {
      const capture = validateRoomCapture(inputCapture);
      if (capture.state !== "committed" || capture.acks.length !== capture.memberIds.length || !Number.isInteger(shotIndex) || shotIndex < 0 || shotIndex >= capture.shotIds.length || !blob.size || blob.size > capture.profile.maxPhotoBytes) fail("profile");
      const record = await read(`${key}/round/${capture.captureId}`);
      if (!record || record.pending || !record.capture || !same(frozenCapture(record.capture), frozenCapture(capture))) return fail("recovery", capture.captureId);
      const participant = record.participants.find(person => person.role === role); if (!participant) return fail("identity", capture.captureId);
      const info = await inspect(blob); live();
      if (info.mime !== blob.type || info.width * info.height > capture.profile.maxPhotoPixels) fail("profile", capture.captureId);
      const hash = await projectBlobHash(blob), previous = await projectFor(record); live();
      const id = `room-${role}-${shotIndex}`, existing = previous.media.find(item => item.id === id);
      if (existing) {
        const loaded = await projects.load(previous.id); live(); const stored = loaded?.media.get(id);
        if (!stored || existing.participantId !== participant.id || existing.bytes !== blob.size || existing.mime !== info.mime || existing.width !== info.width || existing.height !== info.height || await projectBlobHash(stored) !== hash || previous.sourceOrder[role][shotIndex] !== id) return fail("media", previous.id);
        live(); return previous.id;
      }
      if (previous.sourceOrder[role][shotIndex]) fail("conflict", previous.id);
      const order = [...previous.sourceOrder[role]]; while (order.length <= shotIndex) order.push(null); order[shotIndex] = id;
      const next = appendProjectMedia(previous, [{ id, kind: "photo", mime: info.mime, bytes: blob.size, width: info.width, height: info.height, participantId: participant.id }], { ...previous.sourceOrder, [role]: order }, new Date(capture.fireAt).toISOString(), now());
      live(); await projects.save(next, new Map([[id, blob]]), previous.revision); live(); return next.id;
    }),
    loadSavedFrame: (captureId, role, shotIndex) => enqueue(async () => {
      if (!UUID_PATTERN.test(captureId) || !["A", "B", "C", "D"].includes(role)) return fail("identity");
      const record = await read(`${key}/round/${captureId}`); if (!record) return null;
      const round = await roundView(record), participant = round.participants.find(person => person.role === role);
      if (!participant || !round.capture.memberIds.includes(participant.id)) return fail("identity", captureId);
      if (!Number.isInteger(shotIndex) || shotIndex < 0 || shotIndex >= round.capture.shotIds.length) return fail("profile", captureId);
      const mediaId = round.project.sourceOrder[role][shotIndex]; if (!mediaId) return null;
      const declaration = round.project.media.find(item => item.id === mediaId);
      if (mediaId !== `room-${role}-${shotIndex}` || declaration?.kind !== "photo" || declaration.participantId !== participant.id) return fail("media", captureId);
      const loaded = await projects.load(captureId); live();
      if (loaded?.kind !== "current" || serializePhotoProject(loaded.project) !== serializePhotoProject(round.project)) return fail("conflict", captureId);
      const blob = loaded.media.get(mediaId);
      if (!blob || blob.size !== declaration.bytes || blob.type !== declaration.mime || blob.size > round.capture.profile.maxPhotoBytes) return fail("media", captureId);
      const info = await inspect(blob); live();
      if (info.mime !== declaration.mime || info.width !== declaration.width || info.height !== declaration.height || info.width * info.height > round.capture.profile.maxPhotoPixels) return fail("media", captureId);
      return blob;
    }),
    loadRound: captureId => enqueue(async () => { if (!UUID_PATTERN.test(captureId)) return fail("identity"); const record = await read(`${key}/round/${captureId}`); return record ? roundView(record) : null; }),
    close: () => { if (!closing) { closed = true; unregister(); closing = tail.then(() => { metadata.close(); projects.close(); }); } return closing; },
  };
  const unregister = registerRoomScopeCloser(binding.scope, store.close);
  return store;
}

async function openMetadata(databaseName: string, factory: IDBFactory, timeout: number, scope: ProjectScope): Promise<WorkspaceMetadata> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(databaseName, 2); let expired = false;
    const timer = setTimeout(() => { expired = true; reject(new RoomWorkspaceError("recovery")); }, timeout);
    request.onupgradeneeded = () => { if (expired) { request.transaction?.abort(); return; } for (const name of ["checkpoints", "fences"]) if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, { keyPath: "key" }); };
    request.onerror = () => { clearTimeout(timer); reject(request.error); };
    request.onsuccess = () => { clearTimeout(timer); if (expired) request.result.close(); else resolve(request.result); };
  });
  let closed = false; const close = () => { closed = true; db.close(); }; db.onversionchange = close; db.onclose = () => { closed = true; };
  const scopeKey = roomScopeKey(scope);
  const generation = await new Promise<number>((resolve, reject) => { const request = db.transaction("fences").objectStore("fences").get(scopeKey); request.onsuccess = () => resolve(request.result?.generation ?? 0); request.onerror = () => reject(request.error); }).catch(error => { close(); throw error; });
  const transaction = <T,>(mode: IDBTransactionMode, work: (store: IDBObjectStore, done: (result: T) => void, abort: (error: unknown) => void) => void): Promise<T> => {
    if (closed) return Promise.reject(new RoomWorkspaceError("closed"));
    return new Promise((resolve, reject) => {
      const tx = db.transaction(["checkpoints", "fences"], mode); let result: T, failure: unknown;
      const abort = (error: unknown) => { failure = error; try { tx.abort(); } catch { reject(error); } };
      const timer = setTimeout(() => abort(new RoomWorkspaceError("recovery")), timeout);
      tx.oncomplete = () => { clearTimeout(timer); resolve(result); }; tx.onabort = () => { clearTimeout(timer); reject(failure ?? tx.error); };
      const fence = tx.objectStore("fences").get(scopeKey);
      fence.onsuccess = () => { try { if ((fence.result?.generation ?? 0) !== generation) throw new RoomWorkspaceError("closed"); work(tx.objectStore("checkpoints"), value => { result = value; }, abort); } catch (error) { abort(error); } };
    });
  };
  return { close,
    get: key => transaction("readonly", (store, done) => { const request = store.get(key); request.onsuccess = () => done(request.result ?? null); }),
    put: (value, expectedVersion) => transaction<void>("readwrite", (store, done, abort) => {
      if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 192 * 1024) throw new RoomWorkspaceError("capacity", value.projectId);
      const request = store.get(value.key);
      request.onsuccess = () => {
        if ((request.result?.version ?? null) !== expectedVersion) { abort(new RoomWorkspaceError("conflict", value.projectId)); return; }
        const write = () => { store.put(value); done(); };
        if (request.result) write();
        else { const count = store.count(); count.onsuccess = () => { if (count.result >= 128) abort(new RoomWorkspaceError("capacity", value.projectId)); else write(); }; }
      };
    }),
  };
}
export async function openRoomWorkspaceStore(input: RoomWorkspaceBinding, options: { databaseName?: string; projectDatabaseName?: string; indexedDB?: IDBFactory; timeoutMs?: number; inspect?: (blob: Blob) => Promise<ProjectImageInfo>; now?: () => string } = {}): Promise<RoomWorkspaceStore> {
  bindingKey(input); const factory = options.indexedDB ?? globalThis.indexedDB, timeout = options.timeoutMs ?? 10000;
  if (!factory || !Number.isFinite(timeout) || timeout < 1 || timeout > 60000) throw new RoomWorkspaceError("recovery");
  const epoch = roomScopeEpoch(input.scope);
  const metadata = await openMetadata(options.databaseName ?? "photobooth-room-workspaces-v2", factory, timeout, input.scope);
  try {
    const projects = await openProjectRepository(input.scope, { indexedDB: factory, databaseName: options.projectDatabaseName, timeoutMs: timeout, inspect: options.inspect, now: options.now });
    if (roomScopeEpoch(input.scope) !== epoch) { projects.close(); throw new RoomWorkspaceError("closed"); }
    return createRoomWorkspaceStore(input, { projects, metadata, inspect: options.inspect, now: options.now, lock: work => withRoomScopeLock(input.scope, work) });
  } catch (error) { metadata.close(); throw error; }
}
