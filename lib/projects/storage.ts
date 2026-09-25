import { inspectProjectImage } from "./images";
import { parsePhotoProject, serializePhotoProject, validatePhotoProject, type PhotoProject, type ProjectScope } from "./model";
import { assertDecodedImageDimensions, assertEncodedMediaMatches } from "./resource-bounds";
import { projectBlobHash, projectMediaResource, type ProjectImageInspector, type ProjectMediaBlobs } from "./bundle";

export const PROJECT_DATABASE_NAME = "photobooth-projects-v2";
export const PROJECT_DATABASE_VERSION = 2;
const STORES = ["projects", "media", "identities"];
interface ManifestRecord { rawJson: string; revision: number; mediaIds: string[] }
interface StoredProject extends ManifestRecord { key: string; scopeKey: string; id: string; previous: ManifestRecord | null }
interface MediaIdentity { key: string; projectKey: string; id: string; hash: string; bytes: number; mime: string; width: number; height: number }
interface StoredMedia extends MediaIdentity { blob: Blob }
export interface ProjectCheckpoint { rawJson: string; revision: number; media: Map<string, Blob> }
export type LoadedProject = ({ kind: "current"; readOnly: false; project: PhotoProject } | { kind: "unsupported" | "corrupt"; readOnly: true; rawJson: string }) & {
  id: string; revision: number; media: Map<string, Blob>; checkpoint: ProjectCheckpoint | null;
};
export interface ProjectListItem { id: string; name: string; revision: number; updatedAt: string | null; readOnly: boolean }
export class ProjectStorageError extends Error {
  constructor(readonly code: "unavailable" | "blocked" | "closed" | "conflict" | "scope" | "missing" | "readonly" | "media" | "timeout", message: string) { super(message); this.name = "ProjectStorageError"; }
}
function fail(code: ProjectStorageError["code"], message: string): never { throw new ProjectStorageError(code, message); }
function scopeKey(scope: ProjectScope): string {
  if (scope.kind === "device") return "device";
  if (scope.kind === "account" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(scope.ownerId)) return `account:${scope.ownerId}`;
  return fail("scope", "Invalid local project scope");
}
function projectKey(scope: string, id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)) fail("scope", "Invalid project identifier");
  return `${scope}/${id}`;
}
function readCurrent(record: StoredProject): PhotoProject {
  const parsed = parsePhotoProject(record.rawJson);
  if (parsed.kind !== "current") fail("readonly", "A newer project version must remain read-only");
  if (parsed.project.id !== record.id || scopeKey(parsed.project.scope) !== record.scopeKey || parsed.project.revision !== record.revision
    || JSON.stringify(parsed.project.media.map(item => item.id)) !== JSON.stringify(record.mediaIds)) fail("readonly", "Stored project identity is inconsistent; keep a raw recovery backup");
  return parsed.project;
}
function sameIdentity(left: MediaIdentity, right: MediaIdentity): boolean {
  return left.hash === right.hash && left.bytes === right.bytes && left.mime === right.mime && left.width === right.width && left.height === right.height;
}

export interface ProjectRepository {
  readonly scope: ProjectScope;
  close(): void;
  list(): Promise<ProjectListItem[]>;
  load(id: string): Promise<LoadedProject | null>;
  save(project: PhotoProject, media: ProjectMediaBlobs, expectedRevision: number | null): Promise<PhotoProject>;
  rename(id: string, name: string, expectedRevision: number): Promise<PhotoProject>;
  duplicate(id: string, options?: { id?: string; name?: string }): Promise<PhotoProject>;
  delete(id: string, expectedRevision: number): Promise<void>;
  recoverCheckpoint(id: string, expectedRevision: number): Promise<PhotoProject>;
  exportRaw(id: string): Promise<{ manifest: Blob; media: Map<string, Blob>; checkpoint: ProjectCheckpoint | null }>;
}

export async function openProjectRepository(scope: ProjectScope, options: { indexedDB?: IDBFactory; databaseName?: string; timeoutMs?: number; inspect?: ProjectImageInspector; now?: () => string; assertActive?: () => void } = {}): Promise<ProjectRepository> {
  const scoped = scopeKey(scope);
  const factory = options.indexedDB ?? globalThis.indexedDB;
  if (!factory) fail("unavailable", "IndexedDB is unavailable; export your project before leaving");
  const timeout = options.timeoutMs ?? 10_000;
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > 60_000) fail("timeout", "Invalid database timeout");
  const now = options.now ?? (() => new Date().toISOString());
  const inspect = options.inspect ?? inspectProjectImage;
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(options.databaseName ?? PROJECT_DATABASE_NAME, PROJECT_DATABASE_VERSION);
    let expired = false, blocked = false;
    const timer = setTimeout(() => {
      expired = true;
      reject(new ProjectStorageError(blocked ? "blocked" : "timeout", "Project storage could not open; close other project tabs and retry"));
    }, timeout);
    request.onblocked = () => { blocked = true; };
    request.onupgradeneeded = () => {
      if (expired) { request.transaction?.abort(); return; }
      for (const name of STORES) {
        const store = dbStore(request, name);
        const index = name === "projects" ? "scopeKey" : "projectKey";
        if (!store.indexNames.contains(index)) store.createIndex(index, index);
      }
    };
    request.onerror = () => { clearTimeout(timer); reject(request.error); };
    request.onsuccess = () => {
      clearTimeout(timer);
      if (expired) { request.result.close(); return; }
      resolve(request.result);
    };
  });
  let closed = false;
  const close = () => { closed = true; db.close(); };
  db.onversionchange = close;
  db.onclose = () => { closed = true; };

  function transact<T>(mode: IDBTransactionMode, work: (tx: IDBTransaction, request: <V>(req: IDBRequest<V>, receive: (value: V) => void) => void, finish: (value: T) => void) => void): Promise<T> {
    if (closed) return Promise.reject(new ProjectStorageError("closed", "Project storage was closed; reopen it before saving"));
    return new Promise<T>((resolve, reject) => {
      options.assertActive?.();
      const tx = db.transaction(STORES, mode);
      let result: T, failure: unknown, finished = false;
      const abort = (error: unknown) => { failure = error; try { tx.abort(); } catch { reject(error); } };
      const timer = setTimeout(() => abort(new ProjectStorageError("timeout", "Project transaction timed out; changes were not confirmed saved")), timeout);
      tx.oncomplete = () => { clearTimeout(timer); if (finished) resolve(result); else reject(new Error("Project transaction completed without a result")); };
      tx.onabort = () => { clearTimeout(timer); reject(failure ?? tx.error ?? new DOMException("Project transaction aborted", "AbortError")); };
      tx.onerror = () => {};
      const request = <V,>(req: IDBRequest<V>, receive: (value: V) => void) => {
        req.onsuccess = () => { try { options.assertActive?.(); receive(req.result); } catch (error) { abort(error); } };
      };
      try { work(tx, request, value => { result = value; finished = true; }); } catch (error) { abort(error); }
    });
  }
  const scopedRecord = (record: StoredProject | undefined, id: string): StoredProject => {
    if (!record) fail("missing", "Project not found in this local scope");
    if (record.scopeKey !== scoped || record.id !== id) fail("scope", "Project scope mismatch");
    return record;
  };
  const assertRevision = (record: StoredProject | undefined, expected: number | null) => {
    if ((record?.revision ?? null) !== expected) fail("conflict", "This project changed in another tab; reload or duplicate your unsaved edits");
  };

  const repository: ProjectRepository = {
    scope: Object.freeze({ ...scope }), close,
    list: () => transact("readonly", (tx, request, finish) => {
      request(tx.objectStore("projects").index("scopeKey").getAll(scoped), (records: StoredProject[]) => finish(records.map(record => {
        try { const project = readCurrent(record); return { id: record.id, name: project.name, revision: record.revision, updatedAt: project.updatedAt, readOnly: false }; }
        catch { return { id: record.id, name: "Project requiring recovery or a newer app", revision: record.revision, updatedAt: null, readOnly: true }; }
      }).sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))));
    }),
    load: id => transact("readonly", (tx, request, finish) => {
      const key = projectKey(scoped, id);
      request(tx.objectStore("projects").get(key), (value: StoredProject | undefined) => {
        if (!value) { finish(null); return; }
        const record = scopedRecord(value, id);
        request(tx.objectStore("media").index("projectKey").getAll(key), (rows: StoredMedia[]) => {
          const byId = new Map(rows.map(row => [row.id, row.blob]));
          const select = (ids: string[]) => new Map(ids.flatMap(mediaId => {
            const blob = byId.get(mediaId);
            return blob instanceof Blob ? [[mediaId, blob] as const] : [];
          }));
          const common = { id, revision: record.revision, media: select(record.mediaIds), checkpoint: record.previous ? { rawJson: record.previous.rawJson, revision: record.previous.revision, media: select(record.previous.mediaIds) } : null };
          try {
            const parsed = parsePhotoProject(record.rawJson);
            if (common.media.size !== record.mediaIds.length) { finish({ ...common, kind: "corrupt", readOnly: true, rawJson: record.rawJson }); return; }
            if (parsed.kind === "current") {
              const project = readCurrent(record);
              for (const declaration of project.media) assertEncodedMediaMatches(common.media.get(declaration.id), projectMediaResource(declaration));
              finish({ ...common, kind: "current", readOnly: false, project });
            } else finish({ ...common, kind: "unsupported", readOnly: true, rawJson: record.rawJson });
          } catch { finish({ ...common, kind: "corrupt", readOnly: true, rawJson: record.rawJson }); }
        });
      });
    }),
    save: async (input, media, expectedRevision) => {
      const project = validatePhotoProject(input);
      if (scopeKey(project.scope) !== scoped) fail("scope", "Project belongs to a different local scope");
      if (project.revision !== (expectedRevision === null ? 0 : expectedRevision + 1)) fail("conflict", "Project revision must advance exactly once");
      const key = projectKey(scoped, project.id), prepared = new Map<string, StoredMedia>();
      const declarations = new Map(project.media.map(item => [item.id, item]));
      for (const [id, blob] of media) {
        const declaration = declarations.get(id);
        if (!declaration) fail("media", "Undeclared media cannot be persisted");
        const resource = projectMediaResource(declaration);
        assertEncodedMediaMatches(blob, resource);
        const actual = await inspect(blob);
        if (actual.mime !== declaration.mime) fail("media", "Image signature differs from declared MIME");
        assertDecodedImageDimensions(actual.width, actual.height, resource);
        prepared.set(id, { key: `${key}/${id}`, projectKey: key, id, hash: await projectBlobHash(blob), blob, bytes: blob.size, mime: blob.type, width: actual.width, height: actual.height });
      }
      const rawJson = serializePhotoProject(project);
      return transact("readwrite", (tx, request, finish) => {
        request(tx.objectStore("projects").get(key), (value: StoredProject | undefined) => {
          assertRevision(value, expectedRevision);
          if (value) {
            const previous = readCurrent(scopedRecord(value, project.id));
            if (previous.createdAt !== project.createdAt || previous.captureTimeZone !== project.captureTimeZone || ((previous.capturedAt !== null || previous.media.some(item => item.kind === "photo")) && previous.capturedAt !== project.capturedAt)) fail("conflict", "Capture provenance is immutable");
            if (project.updatedAt < previous.updatedAt) fail("conflict", "Project update time cannot move backwards");
          }
          let remaining = project.media.length;
          const commit = () => {
            const previous = value ? { rawJson: value.rawJson, revision: value.revision, mediaIds: value.mediaIds } : null;
            tx.objectStore("projects").put({ key, scopeKey: scoped, id: project.id, rawJson, revision: project.revision, mediaIds: project.media.map(item => item.id), previous } satisfies StoredProject);
            const keep = new Set([...project.media.map(item => item.id), ...(previous?.mediaIds ?? [])]);
            request(tx.objectStore("media").index("projectKey").openCursor(key), cursor => { if (cursor) { if (!keep.has(cursor.value.id)) cursor.delete(); cursor.continue(); } });
            finish(project);
          };
          if (!remaining) commit();
          for (const declaration of project.media) {
            const mediaKey = `${key}/${declaration.id}`;
            request(tx.objectStore("identities").get(mediaKey), (identity: MediaIdentity | undefined) => {
              const fresh = prepared.get(declaration.id);
              request(tx.objectStore("media").get(mediaKey), (stored: StoredMedia | undefined) => {
                const immutable = identity ?? stored;
                if (fresh && immutable && !sameIdentity(fresh, immutable)) fail("media", "Existing source bytes are immutable; use a new media identifier");
                if (fresh) {
                  const { blob, ...metadata } = fresh;
                  tx.objectStore("identities").put(metadata);
                  tx.objectStore("media").put({ ...metadata, blob });
                } else if (!stored || stored.bytes !== declaration.bytes || stored.mime !== declaration.mime || stored.width !== declaration.width || stored.height !== declaration.height) fail("media", "Missing media or changed media declaration");
                if (--remaining === 0) commit();
              });
            });
          }
        });
      });
    },
    rename: async (id, name, expectedRevision) => {
      const loaded = await repository.load(id);
      if (!loaded) fail("missing", "Project not found");
      if (loaded.kind !== "current") fail("readonly", "This project is read-only");
      return repository.save(validatePhotoProject({ ...loaded.project, name, revision: expectedRevision + 1, updatedAt: now() }), new Map(), expectedRevision);
    },
    duplicate: async (id, duplicateOptions = {}) => {
      const loaded = await repository.load(id);
      if (!loaded) fail("missing", "Project not found");
      if (loaded.kind !== "current") fail("readonly", "This project is read-only; retain a raw backup");
      const timestamp = now();
      const project = validatePhotoProject({ ...loaded.project, id: duplicateOptions.id ?? crypto.randomUUID(), name: duplicateOptions.name ?? `${loaded.project.name.slice(0, 72)} (copy)`, revision: 0, createdAt: timestamp, updatedAt: timestamp, capture: { ...loaded.project.capture, cameraId: null } });
      return repository.save(project, loaded.media, null);
    },
    delete: (id, expectedRevision) => transact("readwrite", (tx, request, finish) => {
      const key = projectKey(scoped, id);
      request(tx.objectStore("projects").get(key), (value: StoredProject | undefined) => {
        const record = scopedRecord(value, id);
        assertRevision(record, expectedRevision);
        readCurrent(record);
        tx.objectStore("projects").delete(key);
        for (const store of ["media", "identities"]) request(tx.objectStore(store).index("projectKey").openCursor(key), cursor => { if (cursor) { cursor.delete(); cursor.continue(); } });
        finish(undefined);
      });
    }),
    recoverCheckpoint: (id, expectedRevision) => transact("readwrite", (tx, request, finish) => {
      const key = projectKey(scoped, id);
      request(tx.objectStore("projects").get(key), (value: StoredProject | undefined) => {
        const record = scopedRecord(value, id);
        assertRevision(record, expectedRevision);
        let future = false;
        try { future = parsePhotoProject(record.rawJson).kind === "unsupported"; } catch { /* A corrupt current record can recover its prior checkpoint. */ }
        if (future) fail("readonly", "A newer project version must remain read-only");
        if (!record.previous) fail("missing", "No previous checkpoint is available");
        const prior = readCurrent({ ...record, ...record.previous });
        const restored = validatePhotoProject({ ...prior, revision: record.revision + 1, updatedAt: now() });
        const previous = record.previous;
        request(tx.objectStore("media").index("projectKey").getAll(key), (rows: StoredMedia[]) => {
          const available = new Set(rows.filter(row => row.blob instanceof Blob).map(row => row.id));
          if (previous.mediaIds.some(mediaId => !available.has(mediaId))) fail("media", "Checkpoint media is missing; retain a raw backup");
          tx.objectStore("projects").put({ ...record, rawJson: serializePhotoProject(restored), revision: restored.revision, mediaIds: previous.mediaIds, previous: { rawJson: record.rawJson, revision: record.revision, mediaIds: record.mediaIds } });
          finish(restored);
        });
      });
    }),
    exportRaw: async id => {
      const loaded = await repository.load(id);
      if (!loaded) fail("missing", "Project not found");
      const rawJson = loaded.kind === "current" ? serializePhotoProject(loaded.project) : loaded.rawJson;
      return { manifest: new Blob([rawJson], { type: "application/json" }), media: loaded.media, checkpoint: loaded.checkpoint };
    },
  };
  return repository;
}

function dbStore(request: IDBOpenDBRequest, name: string): IDBObjectStore {
  return request.result.objectStoreNames.contains(name) ? request.transaction!.objectStore(name) : request.result.createObjectStore(name, { keyPath: "key" });
}
