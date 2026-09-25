"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { ROLES, type Role } from "./layouts";
import { useAuth } from "./auth";
import { appendProjectMedia, applyProjectEdit, applyTemplateToProject, attachProjectReference, configureProjectCapture, createProject, createReferencedProject, redoProject, undoProject, type CreateProjectInput, type PhotoProject, type ProjectCaptureSettings, type ProjectEditorSettings, type ProjectScope, type ProjectSourceOrder } from "./projects/model";
import { validateThenNowPlan, type ThenNowPlan } from "./memories/then-and-now";
import { openProjectRepository } from "./projects/storage";
import { inspectImageHeader, projectImageToCanvas } from "./projects/images";
import { exportProjectBundle } from "./projects/bundle";
import { RESOURCE_LIMITS } from "./projects/resource-bounds";
import type { TemplateDesign } from "./templates/model";
import { prepareTemplateMedia } from "./templates/project-media";
import { projectEditorIdentity, projectEditorRecovery } from "./projects/editor-queue";

export type ShotStore = Record<Role, (HTMLCanvasElement | null)[]>;
export interface BoothSession {
  mode: "solo" | "duo" | "group";
  role: Role;
  layoutId: string;
  filterId: string;
  shots: ShotStore;
  members: Role[];
  promptSeed: number | null;
  roomCode: string | null;
  sceneId: string | null;
}
export const EMPTY_SHOTS: ShotStore = { A: [], B: [], C: [], D: [] };
const EMPTY: BoothSession = { mode: "solo", role: "A", layoutId: "strip4", filterId: "none", shots: EMPTY_SHOTS, members: ["A"], promptSeed: null, roomCode: null, sceneId: null };
type StorageStatus = "idle" | "saving" | "saved" | "error";
interface SessionContextValue {
  session: BoothSession;
  project: PhotoProject | null;
  hydrating: boolean;
  storageStatus: StorageStatus;
  storageError: string | null;
  update(patch: Partial<BoothSession>): Promise<void>;
  setShot(owner: Role, index: number, shot: HTMLCanvasElement): Promise<void>;
  importShot(owner: Role, index: number, blob: Blob): Promise<void>;
  startProject(options?: CreateProjectInput, carryReference?: boolean): Promise<void>;
  openProject(id: string, scope?: ProjectScope): Promise<PhotoProject>;
  forgetProject(id: string, scope: ProjectScope): Promise<void>;
  updateCapture(patch: Partial<ProjectCaptureSettings>, editorPatch?: Partial<ProjectEditorSettings>): Promise<void>;
  editProject(patch: Partial<ProjectEditorSettings>, sourceOrder?: ProjectSourceOrder, expected?: Pick<PhotoProject, "id" | "scope">): Promise<void>;
  undo(): Promise<PhotoProject>;
  redo(): Promise<PhotoProject>;
  flush(): Promise<void>;
  flushEditor(): Promise<PhotoProject | null>;
  applyTemplate(design: TemplateDesign, decorations: ReadonlyMap<string, Blob>): Promise<PhotoProject>;
  decorationCanvases: ReadonlyMap<string, HTMLCanvasElement>;
  getDecorationBlobs(): ReadonlyMap<string, Blob>;
  attachReference(blob: Blob, plan: ThenNowPlan): Promise<void>;
  copyReference(sourceProjectId: string, sourceMediaId: string, plan: ThenNowPlan): Promise<void>;
  referenceCanvas: HTMLCanvasElement | null;
  exportProject(editor?: ProjectEditorSettings): Promise<Blob>;
  suspendForSignOut(): Promise<() => void>;
  reset(): void;
}
const SessionContext = createContext<SessionContextValue | null>(null);
const pointerKey = (scope: ProjectScope) => `pb-active-project:${scope.kind === "device" ? "device" : scope.ownerId}`;
const identity = (project: Pick<PhotoProject, "id" | "scope"> | null) => project ? `${pointerKey(project.scope)}/${project.id}` : null;
const activeMediaIds = (project: PhotoProject) => new Set([...Object.values(project.sourceOrder).flat().filter((id): id is string => Boolean(id)), ...(project.editor.template?.decorations.map(item => item.id) ?? []), ...(project.editor.thenNow ? [project.editor.thenNow.reference.mediaId] : [])]);
const png = (canvas: HTMLCanvasElement) => new Promise<Blob>((resolve, reject) => {
  if (!canvas.width || !canvas.height || canvas.width > 4096 || canvas.height > 4096 || canvas.width * canvas.height > RESOURCE_LIMITS.photoPixels) {
    reject(new Error("Photo dimensions exceed the local project limit")); return;
  }
  const timer = setTimeout(() => reject(new Error("Photo encoding timed out. Your captured photo is still available to retry.")), 10_000);
  try {
    canvas.toBlob(value => {
      clearTimeout(timer);
      if (!value) reject(new Error("Photo encoding failed"));
      else if (value.size > RESOURCE_LIMITS.photoBytes) reject(new Error("The encoded photo exceeds 10 MiB"));
      else resolve(value);
    }, "image/png");
  } catch (error) { clearTimeout(timer); reject(error); }
});

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const owner = user?.id ?? null;
  const scope = useMemo<ProjectScope>(() => owner ? { kind: "account", ownerId: owner } : { kind: "device" }, [owner]);
  const [session, setSession] = useState<BoothSession>(EMPTY);
  const [project, setProject] = useState<PhotoProject | null>(null);
  const [decorationCanvases, setDecorationCanvases] = useState<ReadonlyMap<string, HTMLCanvasElement>>(new Map());
  const [referenceCanvas, setReferenceCanvas] = useState<HTMLCanvasElement | null>(null);
  const [hydrating, setHydrating] = useState(true);
  const [storageStatus, setStorageStatus] = useState<StorageStatus>("idle");
  const [storageError, setStorageError] = useState<string | null>(null);
  const current = useRef<PhotoProject | null>(null);
  const originals = useRef(new Map<string, Blob>());
  const decoded = useRef(new Map<string, HTMLCanvasElement>());
  const serial = useRef<Promise<unknown>>(Promise.resolve());
  const epoch = useRef(0);
  const lastFailure = useRef<unknown>(null);
  const writesPaused = useRef(false);

  const adopt = useCallback(async (next: PhotoProject, blobs: ReadonlyMap<string, Blob>, token: number, fresh = new Map<string, HTMLCanvasElement>()) => {
    const canvases = new Map<string, HTMLCanvasElement>();
    const sameProject = current.current?.id === next.id && pointerKey(current.current.scope) === pointerKey(next.scope);
    try {
      for (const mediaId of activeMediaIds(next)) {
        const blob = blobs.get(mediaId), declaration = next.media.find(item => item.id === mediaId);
        if (!blob || !declaration) throw new Error("An original photo is missing. Keep a backup and try the previous checkpoint.");
        canvases.set(mediaId, fresh.get(mediaId) ?? (sameProject ? decoded.current.get(mediaId) : undefined) ?? await projectImageToCanvas(blob, declaration));
        if (token !== epoch.current) throw new Error("The active account changed");
      }
    } catch (error) {
      for (const [id, canvas] of canvases) if (decoded.current.get(id) !== canvas && fresh.get(id) !== canvas) canvas.width = canvas.height = 0;
      throw error;
    }
    if (token !== epoch.current) throw new Error("The active account changed");
    for (const [id, canvas] of decoded.current) if (canvases.get(id) !== canvas) canvas.width = canvas.height = 0;
    decoded.current = canvases; originals.current = new Map(blobs); current.current = next;
    const shots = Object.fromEntries(ROLES.map(role => [role, next.sourceOrder[role].map(id => id ? canvases.get(id) ?? null : null)])) as ShotStore;
    setProject(next);
    setDecorationCanvases(new Map((next.editor.template?.decorations ?? []).map(item => [item.id, canvases.get(item.id)!])));
    setReferenceCanvas(next.editor.thenNow ? canvases.get(next.editor.thenNow.reference.mediaId)! : null);
    setSession(previous => ({ ...(sameProject ? previous : EMPTY), mode: next.mode, role: next.role, layoutId: next.editor.layoutId, filterId: next.editor.filterId, sceneId: next.editor.sceneId, members: next.participants.map(person => person.role), shots: sameProject && ROLES.every(role => previous.shots[role].length === shots[role].length && shots[role].every((shot, index) => shot === previous.shots[role][index])) ? previous.shots : shots }));
    try { localStorage.setItem(pointerKey(next.scope), next.id); } catch { /* The library remains available without a resume pointer. */ }
  }, []);

  const commit = useCallback(async (next: PhotoProject, additions: Map<string, Blob>, expectedRevision: number | null, token: number, fresh?: Map<string, HTMLCanvasElement>) => {
    if (token !== epoch.current) throw new Error("The active account changed");
    const blobs = expectedRevision === null ? additions : new Map([...originals.current, ...additions]);
    const prepared = new Map(fresh);
    const sameProject = identity(current.current) === identity(next);
    try {
      // Decode before the durable revision advances, so a failed decoder leaves a retryable checkpoint.
      for (const mediaId of activeMediaIds(next)) {
        if (prepared.has(mediaId)) continue;
        const cached = sameProject ? decoded.current.get(mediaId) : null;
        const blob = blobs.get(mediaId), declaration = next.media.find(item => item.id === mediaId);
        if (!blob || !declaration) throw new Error("An original photo is missing");
        prepared.set(mediaId, cached ?? await projectImageToCanvas(blob, declaration));
        if (token !== epoch.current) throw new Error("The active account changed");
      }
      const repo = await openProjectRepository(next.scope);
      try { await repo.save(next, additions, expectedRevision); } finally { repo.close(); }
      if (token !== epoch.current) throw new Error("The active account changed");
      await adopt(next, blobs, token, prepared);
    } catch (error) {
      for (const [id, canvas] of prepared) if (decoded.current.get(id) !== canvas && fresh?.get(id) !== canvas) canvas.width = canvas.height = 0;
      throw error;
    }
  }, [adopt]);

  const enqueue = useCallback(<T,>(work: (token: number) => Promise<T>, expected?: string | null) => {
    const token = epoch.current;
    const operation = serial.current.catch(() => {}).then(async () => {
      if (token !== epoch.current || writesPaused.current) throw new Error("The active account changed or local saving was paused");
      if (expected !== undefined && identity(current.current) !== expected) throw new Error("The active project changed. Reopen the original project to retry these changes.");
      setStorageStatus("saving"); setStorageError(null); lastFailure.current = null;
      const result = await work(token);
      if (token === epoch.current) setStorageStatus("saved");
      return result;
    }).catch(error => {
      if (token === epoch.current && (expected == null || identity(current.current) === expected)) { lastFailure.current = error; setStorageStatus("error"); setStorageError(error instanceof Error ? error.message : "Changes could not be saved on this device"); }
      throw error;
    });
    serial.current = operation;
    void operation.catch(() => {});
    return operation;
  }, []);

  useEffect(() => {
    if (loading) return;
    const token = ++epoch.current;
    const initialise = async () => {
      setHydrating(true); setStorageError(null); setStorageStatus("idle"); setProject(null); setSession(EMPTY); setDecorationCanvases(new Map()); setReferenceCanvas(null);
      current.current = null; originals.current = new Map(); lastFailure.current = null;
      writesPaused.current = false;
      for (const canvas of decoded.current.values()) canvas.width = canvas.height = 0;
      decoded.current.clear();
      const repo = await openProjectRepository(scope);
      try {
        let id: string | null = null;
        try { id = localStorage.getItem(pointerKey(scope)); } catch { /* Projects remain available through the library. */ }
        if (id && /^[A-Za-z0-9_-]{1,64}$/.test(id)) {
          const loaded = await repo.load(id);
          if (loaded?.kind === "current") { await adopt(loaded.project, loaded.media, token); if (token === epoch.current) setStorageStatus("saved"); }
          else if (loaded) throw new Error("This project needs recovery or a newer app. Open My projects to keep a raw backup.");
        }
      } finally { repo.close(); }
    };
    const initial = initialise().catch(error => {
      if (token === epoch.current) { setStorageError(error instanceof Error ? error.message : "Local projects could not be opened"); setStorageStatus("error"); }
    }).finally(() => { if (token === epoch.current) setHydrating(false); });
    serial.current = initial;
    const lifetime = epoch;
    return () => { if (lifetime.current === token) lifetime.current = token + 1; };
  }, [adopt, loading, scope]);

  const startProject = useCallback((options: CreateProjectInput = {}, carryReference = false) => enqueue(async token => {
    if (loading) throw new Error("Please wait for your local projects to open");
    let next = createProject({ ...options, scope });
    const additions = new Map<string, Blob>(), plan = carryReference ? current.current?.editor.thenNow : null;
    if (plan && current.current) {
      const media = current.current.media.find(item => item.id === plan.reference.mediaId), blob = originals.current.get(plan.reference.mediaId);
      if (!media || !blob) throw new Error("The reference is unavailable. Keep the previous project open and retry.");
      next = createReferencedProject({ ...options, scope }, media, plan); additions.set(media.id, blob);
    }
    await commit(next, additions, null, token);
    setSession(previous => ({ ...previous, promptSeed: null, roomCode: null }));
  }, carryReference ? identity(current.current) : undefined), [commit, enqueue, loading, scope]);

  const requireProject = useCallback(async (token: number) => {
    if (!current.current) await commit(createProject({ scope }), new Map(), null, token);
    return current.current!;
  }, [commit, scope]);

  const enqueueProject = useCallback(<T,>(work: (token: number) => Promise<T>, expected = identity(current.current)) => enqueue(work, expected), [enqueue]);

  const importShot = useCallback((role: Role, index: number, blob: Blob) => enqueueProject(async token => {
    if (!Number.isInteger(index) || index < 0 || index > 3) throw new Error("Photo position is out of bounds");
    const previous = await requireProject(token);
    const participant = previous.participants.find(person => person.role === role);
    if (!participant) throw new Error("This participant does not belong to the project");
    if (blob.size > RESOURCE_LIMITS.photoBytes) throw new Error("Choose an image smaller than 10 MiB");
    const info = inspectImageHeader(new Uint8Array(await blob.arrayBuffer()));
    const original = blob.slice(0, blob.size, info.mime);
    const canvas = await projectImageToCanvas(original, info);
    const id = crypto.randomUUID(), order = [...previous.sourceOrder[role]];
    while (order.length <= index) order.push(null);
    order[index] = id;
    try {
      const next = appendProjectMedia(previous, [{ ...info, id, kind: "photo", bytes: original.size, participantId: participant.id }], { ...previous.sourceOrder, [role]: order }, new Date().toISOString());
      await commit(next, new Map([[id, original]]), previous.revision, token, new Map([[id, canvas]]));
    } catch (error) { canvas.width = canvas.height = 0; throw error; }
  }), [commit, enqueueProject, requireProject]);

  const setShot = useCallback(async (role: Role, index: number, shot: HTMLCanvasElement) => {
    const token = epoch.current;
    const expected = identity(current.current);
    const blob = await png(shot);
    if (token !== epoch.current) throw new Error("The active account changed");
    if (identity(current.current) !== expected) throw new Error("The active project changed. Your captured photo is still available to download.");
    await importShot(role, index, blob);
  }, [importShot]);

  const saveReference = useCallback(async (previous: PhotoProject, blob: Blob, plan: ThenNowPlan, token: number) => {
    const id = crypto.randomUUID(), checked = validateThenNowPlan({ ...plan, reference: { ...plan.reference, mediaId: id } });
    if (blob.size > RESOURCE_LIMITS.photoBytes) throw new Error("Choose a reference smaller than 10 MiB");
    const info = inspectImageHeader(new Uint8Array(await blob.arrayBuffer())), original = blob.slice(0, blob.size, info.mime);
    const next = attachProjectReference(previous, { ...info, id, bytes: original.size, kind: "reference", participantId: null }, checked);
    const canvas = await projectImageToCanvas(original, info);
    try {
      await commit(next, new Map([[id, original]]), previous.revision, token, new Map([[id, canvas]]));
    } catch (error) { canvas.width = canvas.height = 0; throw error; }
  }, [commit]);
  const attachReference = useCallback((blob: Blob, plan: ThenNowPlan) => enqueueProject(async token => {
    const checked = validateThenNowPlan(plan);
    if (!checked.reference.provenance.kind.startsWith("imported-")) throw new Error("Choose an accessible saved project to copy an original");
    await saveReference(await requireProject(token), blob, checked, token);
  }), [enqueueProject, requireProject, saveReference]);
  const copyReference = useCallback((sourceProjectId: string, sourceMediaId: string, plan: ThenNowPlan) => enqueueProject(async token => {
    const previous = await requireProject(token), repo = await openProjectRepository(previous.scope);
    try {
      const loaded = await repo.load(sourceProjectId);
      const source = loaded?.kind === "current" ? loaded.project.media.find(item => item.id === sourceMediaId && item.kind === "photo") : null;
      const blob = source ? loaded!.media.get(sourceMediaId) : null;
      if (!blob) throw new Error("That original is unavailable in this project's local scope");
      const checked = validateThenNowPlan({ ...plan, reference: { ...plan.reference, crop: null, provenance: { kind: "project-original", projectId: sourceProjectId, sourceMediaId } } });
      await saveReference(previous, blob, checked, token);
    } finally { repo.close(); }
  }), [enqueueProject, requireProject, saveReference]);

  const editProject = useCallback((patch: Partial<ProjectEditorSettings>, sourceOrder?: ProjectSourceOrder, expected?: Pick<PhotoProject, "id" | "scope">) => enqueueProject(async token => {
    const previous = await requireProject(token);
    const next = applyProjectEdit(previous, { sourceOrder: sourceOrder ?? previous.sourceOrder, editor: { ...previous.editor, ...patch } });
    await commit(next, new Map(), previous.revision, token);
  }, expected ? identity(expected) : identity(current.current)), [commit, enqueueProject, requireProject]);

  const updateCapture = useCallback((patch: Partial<ProjectCaptureSettings>, editorPatch?: Partial<ProjectEditorSettings>) => enqueueProject(async token => {
    const previous = await requireProject(token);
    const next = configureProjectCapture(previous, patch, editorPatch);
    await commit(next, new Map(), previous.revision, token);
  }), [commit, enqueueProject, requireProject]);

  const update = useCallback(async (patch: Partial<BoothSession>) => {
    const token = epoch.current;
    if (patch.shots) {
      await startProject({ mode: patch.mode ?? "solo", role: patch.role ?? "A", participants: (patch.members ?? ["A"]).map(role => ({ id: crypto.randomUUID(), role })), editor: { layoutId: patch.layoutId ?? "strip4", filterId: patch.filterId ?? "none", sceneId: patch.sceneId ?? null } });
      for (const role of ROLES) for (let index = 0; index < patch.shots[role].length; index++) {
        if (token !== epoch.current) throw new Error("The active account changed");
        const shot = patch.shots[role][index]; if (shot) await setShot(role, index, shot);
      }
    } else {
      const editor: Partial<ProjectEditorSettings> = {
        ...(patch.layoutId !== undefined ? { layoutId: patch.layoutId } : {}),
        ...(patch.filterId !== undefined ? { filterId: patch.filterId } : {}),
        ...(patch.sceneId !== undefined ? { sceneId: patch.sceneId } : {}),
      };
      if (Object.keys(editor).length) await editProject(editor);
    }
    if (token !== epoch.current) throw new Error("The active account changed");
    setSession(previous => ({ ...previous, ...(patch.promptSeed !== undefined ? { promptSeed: patch.promptSeed } : {}), ...(patch.roomCode !== undefined ? { roomCode: patch.roomCode } : {}) }));
  }, [editProject, setShot, startProject]);

  const openProject = useCallback((id: string, selectedScope: ProjectScope = scope) => enqueue(async token => {
    if (selectedScope.kind === "account" && selectedScope.ownerId !== owner) throw new Error("Sign in to the project owner's account");
    const repo = await openProjectRepository(selectedScope);
    try {
      const loaded = await repo.load(id);
      if (!loaded || loaded.kind !== "current") throw new Error("This project cannot be edited; keep a raw backup from My projects");
      await adopt(loaded.project, loaded.media, token);
      return loaded.project;
    } finally { repo.close(); }
  }), [adopt, enqueue, owner, scope]);
  const forgetProject = useCallback((id: string, selectedScope: ProjectScope) => enqueue(async () => {
    if (current.current?.id !== id || pointerKey(current.current.scope) !== pointerKey(selectedScope)) return;
    try { localStorage.removeItem(pointerKey(selectedScope)); } catch { /* A missing project is ignored during restoration. */ }
    for (const canvas of decoded.current.values()) canvas.width = canvas.height = 0;
    decoded.current.clear(); originals.current.clear(); current.current = null;
    lastFailure.current = null; setStorageError(null); setProject(null); setSession(EMPTY); setDecorationCanvases(new Map()); setReferenceCanvas(null);
  }), [enqueue]);
  const history = useCallback((direction: "undo" | "redo") => enqueueProject(async token => {
    const previous = await requireProject(token), next = direction === "undo" ? undoProject(previous) : redoProject(previous);
    if (next.revision !== previous.revision) await commit(next, new Map(), previous.revision, token);
    return next;
  }), [commit, enqueueProject, requireProject]);
  const flush = useCallback(async () => { await serial.current; if (lastFailure.current) throw lastFailure.current; }, []);
  const flushEditor = useCallback(async () => {
    const previous = current.current, token = epoch.current;
    if (previous) await projectEditorRecovery.flushIdentity(projectEditorIdentity(previous));
    // A failed import/application has no unsaved editor draft and must remain retryable.
    await serial.current.catch(() => {});
    if (token !== epoch.current || identity(previous) !== identity(current.current)) throw new Error("The active project changed");
    return current.current;
  }, []);
  const applyTemplate = useCallback(async (design: TemplateDesign, decorations: ReadonlyMap<string, Blob>) => {
    const previous = await flushEditor();
    return enqueueProject(async token => {
      const source = previous ?? await requireProject(token);
      const { template, media, additions } = await prepareTemplateMedia(source, originals.current, design, decorations);
      if (token !== epoch.current) throw new Error("The active account changed");
      const next = applyTemplateToProject(source, template, media);
      await commit(next, additions, source.revision, token);
      return next;
    }, identity(previous));
  }, [commit, enqueueProject, flushEditor, requireProject]);
  const getDecorationBlobs = useCallback(() => {
    const source = current.current;
    if (!source || (source.scope.kind === "account" && source.scope.ownerId !== owner)) return new Map<string, Blob>();
    return new Map((source.editor.template?.decorations ?? []).map(item => [item.id, originals.current.get(item.id)!]));
  }, [owner]);
  const exportProject = useCallback(async (editor?: ProjectEditorSettings) => {
    if (!current.current) throw new Error("There is no project to export yet");
    const token = epoch.current, expected = identity(current.current);
    const source = editor ? applyProjectEdit(current.current, { sourceOrder: current.current.sourceOrder, editor }) : current.current;
    const bundle = await exportProjectBundle(source, new Map(originals.current));
    if (token !== epoch.current || expected !== identity(current.current)) throw new Error("The active project changed before its backup finished");
    return bundle;
  }, []);
  const suspendForSignOut = useCallback(async () => {
    writesPaused.current = true;
    epoch.current++;
    await serial.current.catch(() => {});
    return () => { writesPaused.current = false; };
  }, []);
  const allowed = !project || project.scope.kind === "device" || project.scope.ownerId === owner;
  const value = useMemo<SessionContextValue>(() => ({ session: allowed ? session : EMPTY, project: allowed ? project : null, hydrating: hydrating || !allowed || loading,
    storageStatus, storageError, update, setShot, importShot, startProject, openProject, forgetProject, updateCapture, editProject,
    undo: () => history("undo"), redo: () => history("redo"), flush, flushEditor, applyTemplate, getDecorationBlobs,
    decorationCanvases: allowed ? decorationCanvases : new Map(), referenceCanvas: allowed ? referenceCanvas : null, attachReference, copyReference,
    exportProject, suspendForSignOut, reset: () => { void startProject().catch(() => {}); },
  }), [allowed, session, project, hydrating, loading, storageStatus, storageError, update, setShot, importShot, startProject, openProject, forgetProject, updateCapture, editProject, history, flush, flushEditor, applyTemplate, getDecorationBlobs, decorationCanvases, referenceCanvas, attachReference, copyReference, exportProject, suspendForSignOut]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useBoothSession(): SessionContextValue {
  const context = useContext(SessionContext);
  if (!context) throw new Error("useBoothSession outside SessionProvider");
  return context;
}
