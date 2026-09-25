import { inspectProjectImage } from "../projects/images";
import { templateBlobHash, validateTemplateDecorations, type TemplateDecorationBlobs, type TemplateImageInspector } from "./bundle";
import { parseTemplateRecipe, templateId, templateScopeKey, validateTemplateRecipe, validateTemplateScope, type TemplateRecipe, type TemplateScope } from "./model";

export const TEMPLATE_DATABASE_NAME = "photobooth-templates-v1";
export interface TemplateListItem { id: string; name: string; revision: number; updatedAt: string | null; readOnly: boolean }
export type LoadedTemplate = { kind: "current"; readOnly: false; recipe: TemplateRecipe; decorations: Map<string, Blob> }
  | { kind: "unsupported" | "corrupt"; readOnly: true; id: string; revision: number; rawJson: string; decorations: Map<string, Blob> };
interface StoredTemplate { key: string; scopeKey: string; id: string; revision: number; rawJson: string; decorations: { id: string; blob: Blob; hash: string }[] }
export class TemplateStorageError extends Error {
  constructor(readonly code: "unavailable" | "blocked" | "timeout" | "closed" | "conflict" | "scope" | "missing" | "readonly" | "media", message: string) { super(message); this.name = "TemplateStorageError"; }
}
function fail(code: TemplateStorageError["code"], message: string): never { throw new TemplateStorageError(code, message); }
function current(record: StoredTemplate): TemplateRecipe {
  const parsed = parseTemplateRecipe(record.rawJson);
  if (parsed.kind !== "current") fail("readonly", "This template requires a newer app; preserve its raw backup");
  if (parsed.recipe.id !== record.id || parsed.recipe.revision !== record.revision || templateScopeKey(parsed.recipe.scope) !== record.scopeKey) fail("readonly", "Stored template identity is inconsistent");
  return parsed.recipe;
}
export function assertTemplateWrite(previous: TemplateRecipe | null, next: TemplateRecipe, expectedRevision: number | null, scope: TemplateScope): void {
  if (templateScopeKey(next.scope) !== templateScopeKey(scope)) fail("scope", "Template belongs to another local scope");
  if ((previous?.revision ?? null) !== expectedRevision) fail("conflict", "Template changed in another tab; reload or duplicate your edits");
  if (next.revision !== (expectedRevision === null ? 0 : expectedRevision + 1)) fail("conflict", "Template revision must advance exactly once");
  if (previous && (previous.id !== next.id || templateScopeKey(previous.scope) !== templateScopeKey(next.scope) || previous.createdAt !== next.createdAt || next.updatedAt < previous.updatedAt)) fail("scope", "Template identity and creation time cannot change");
}
export interface TemplateShelf {
  readonly scope: TemplateScope;
  close(): void;
  list(): Promise<TemplateListItem[]>;
  load(id: string): Promise<LoadedTemplate | null>;
  save(recipe: TemplateRecipe, decorations: TemplateDecorationBlobs, expectedRevision: number | null): Promise<TemplateRecipe>;
  rename(id: string, name: string, expectedRevision: number): Promise<TemplateRecipe>;
  duplicate(id: string, options?: { id?: string; name?: string }): Promise<TemplateRecipe>;
  delete(id: string, expectedRevision: number): Promise<void>;
  exportRaw(id: string): Promise<{ manifest: Blob; decorations: Map<string, Blob> }>;
}
export async function openTemplateShelf(scope: TemplateScope, options: { indexedDB?: IDBFactory; databaseName?: string; timeoutMs?: number; inspect?: TemplateImageInspector; now?: () => string } = {}): Promise<TemplateShelf> {
  const scoped = templateScopeKey(scope), factory = options.indexedDB ?? globalThis.indexedDB, timeout = options.timeoutMs ?? 10_000;
  if (!factory) fail("unavailable", "Template storage is unavailable; export your recipe before leaving");
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > 60_000) fail("timeout", "Invalid storage timeout");
  const inspect = options.inspect ?? inspectProjectImage, now = options.now ?? (() => new Date().toISOString());
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(options.databaseName ?? TEMPLATE_DATABASE_NAME, 1);
    let expired = false, blocked = false;
    const timer = setTimeout(() => { expired = true; reject(new TemplateStorageError(blocked ? "blocked" : "timeout", "Template storage did not open; close other template tabs and retry")); }, timeout);
    request.onblocked = () => { blocked = true; };
    request.onupgradeneeded = () => {
      if (expired) { request.transaction?.abort(); return; }
      const store = request.result.createObjectStore("templates", { keyPath: "key" }); store.createIndex("scopeKey", "scopeKey");
    };
    request.onerror = () => { clearTimeout(timer); reject(request.error); };
    request.onsuccess = () => { clearTimeout(timer); if (expired) { request.result.close(); return; } resolve(request.result); };
  });
  let closed = false;
  const close = () => { closed = true; db.close(); };
  db.onversionchange = close; db.onclose = () => { closed = true; };
  const keyFor = (id: string) => `${scoped}/${templateId(id)}`;
  function transaction<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore, receive: <V>(request: IDBRequest<V>, apply: (value: V) => void) => void, finish: (value: T) => void) => void): Promise<T> {
    if (closed) return Promise.reject(new TemplateStorageError("closed", "Template storage was closed; reopen it before saving"));
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction("templates", mode);
      let result: T, finished = false, failure: unknown;
      const abort = (error: unknown) => { failure = error; try { tx.abort(); } catch { reject(error); } };
      const timer = setTimeout(() => abort(new TemplateStorageError("timeout", "Template save timed out and was not confirmed")), timeout);
      tx.oncomplete = () => { clearTimeout(timer); if (finished) resolve(result); else reject(new Error("Template transaction completed without a result")); };
      tx.onabort = () => { clearTimeout(timer); reject(failure ?? tx.error ?? new DOMException("Template transaction aborted", "AbortError")); };
      tx.onerror = () => {};
      const receive = <V,>(request: IDBRequest<V>, apply: (value: V) => void) => { request.onsuccess = () => { try { apply(request.result); } catch (error) { abort(error); } }; };
      try { work(tx.objectStore("templates"), receive, value => { result = value; finished = true; }); } catch (error) { abort(error); }
    });
  }
  const getRecord = (id: string) => transaction<StoredTemplate | undefined>("readonly", (store, receive, finish) => receive(store.get(keyFor(id)), finish));
  const requireRecord = (record: StoredTemplate | undefined, id: string) => {
    if (!record) fail("missing", "Template was not found in this local scope");
    if (record.id !== id || record.scopeKey !== scoped || record.key !== keyFor(id)) fail("scope", "Template scope mismatch");
    return record;
  };
  const shelf: TemplateShelf = {
    scope: Object.freeze(validateTemplateScope(scope)), close,
    list: () => transaction("readonly", (store, receive, finish) => receive(store.index("scopeKey").getAll(scoped), (records: StoredTemplate[]) => finish(records.map(record => {
      try { const recipe = current(requireRecord(record, record.id)); return { id: recipe.id, name: recipe.name, revision: recipe.revision, updatedAt: recipe.updatedAt, readOnly: false }; }
      catch { return { id: record.id, name: "Template requiring recovery or a newer app", revision: record.revision, updatedAt: null, readOnly: true }; }
    }).sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))))),
    load: async id => {
      const value = await getRecord(id); if (!value) return null;
      const record = requireRecord(value, id), decorations = new Map(record.decorations.map(item => [item.id, item.blob]));
      const recovery = { readOnly: true as const, id, revision: record.revision, rawJson: record.rawJson, decorations };
      try {
        const parsed = parseTemplateRecipe(record.rawJson);
        if (parsed.kind !== "current") return { ...recovery, kind: "unsupported" };
        const recipe = current(record);
        await validateTemplateDecorations(recipe, decorations, inspect);
        for (const media of record.decorations) if (await templateBlobHash(media.blob) !== media.hash) fail("media", "Stored decoration integrity check failed");
        return { kind: "current", readOnly: false, recipe, decorations };
      } catch { return { ...recovery, kind: "corrupt" }; }
    },
    save: async (input, blobs, expected) => {
      const recipe = validateTemplateRecipe(input);
      if (templateScopeKey(recipe.scope) !== scoped) fail("scope", "Template belongs to another local scope");
      await validateTemplateDecorations(recipe, blobs, inspect);
      const decorations: StoredTemplate["decorations"] = [];
      for (const declaration of recipe.decorations) { const blob = blobs.get(declaration.id)!; decorations.push({ id: declaration.id, blob, hash: await templateBlobHash(blob) }); }
      return transaction("readwrite", (store, receive, finish) => receive(store.get(keyFor(recipe.id)), (existing: StoredTemplate | undefined) => {
        const previous = existing ? current(requireRecord(existing, recipe.id)) : null;
        assertTemplateWrite(previous, recipe, expected, scope);
        if (existing) for (const item of decorations) {
          const old = existing.decorations.find(old => old.id === item.id);
          if (old && old.hash !== item.hash) fail("media", "Use a new decoration identifier when replacing its bytes");
        }
        store.put({ key: keyFor(recipe.id), scopeKey: scoped, id: recipe.id, revision: recipe.revision, rawJson: JSON.stringify(recipe), decorations } satisfies StoredTemplate);
        finish(recipe);
      }));
    },
    rename: async (id, name, expected) => {
      const loaded = await shelf.load(id);
      if (!loaded) fail("missing", "Template not found");
      if (loaded.kind !== "current") fail("readonly", "Unsupported templates remain read-only");
      return shelf.save(validateTemplateRecipe({ ...loaded.recipe, name, revision: expected + 1, updatedAt: now() }), loaded.decorations, expected);
    },
    duplicate: async (id, options = {}) => {
      const loaded = await shelf.load(id);
      if (!loaded) fail("missing", "Template not found");
      if (loaded.kind !== "current") fail("readonly", "Unsupported templates remain read-only");
      const timestamp = now();
      return shelf.save(validateTemplateRecipe({ ...loaded.recipe, id: options.id ?? crypto.randomUUID(), name: options.name ?? `${loaded.recipe.name.slice(0, 90)} copy`, revision: 0, createdAt: timestamp, updatedAt: timestamp }), loaded.decorations, null);
    },
    delete: (id, expected) => transaction("readwrite", (store, receive, finish) => receive(store.get(keyFor(id)), (value: StoredTemplate | undefined) => {
      const record = requireRecord(value, id);
      if (record.revision !== expected) fail("conflict", "Template changed in another tab; reload before deleting");
      store.delete(record.key); finish(undefined);
    })),
    exportRaw: async id => {
      const record = requireRecord(await getRecord(id), id);
      return { manifest: new Blob([record.rawJson], { type: "application/json" }), decorations: new Map(record.decorations.map(item => [item.id, item.blob])) };
    },
  };
  return shelf;
}
