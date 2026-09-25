import { exportTemplateBundle, importTemplateBundle, templateBlobHash } from "./bundle";
import { validateTemplateRecipe, type TemplateRecipe } from "./model";
import { openTemplateShelf, type TemplateShelf } from "./storage";

export interface TemplateProbeResult { name: string; passed: boolean; detail: string }
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function denied(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  try { await promise; } catch (error) { check(pattern.test(String(error)), `Unexpected failure: ${String(error)}`); return; }
  throw new Error("Operation unexpectedly succeeded");
}
async function pixel(): Promise<Blob> {
  const canvas = document.createElement("canvas"); canvas.width = canvas.height = 2;
  const ctx = canvas.getContext("2d"); check(ctx, "Canvas unavailable"); ctx.fillStyle = "#ff3388"; ctx.fillRect(0, 0, 2, 2);
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("PNG encode failed")), "image/png"));
}
function quotaFactory(): IDBFactory {
  const bind = (target: object, property: PropertyKey) => { const value = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value; };
  const set = (target: object, property: PropertyKey, value: unknown) => Reflect.set(target, property, value, target);
  return new Proxy(indexedDB, { get(factory, property) {
    if (property !== "open") return bind(factory, property);
    return (name: string, version?: number) => new Proxy<IDBOpenDBRequest>(factory.open(name, version), { set, get(request, field) {
      if (field !== "result") return bind(request, field);
      return new Proxy<IDBDatabase>(request.result, { set, get(db, operation) {
        if (operation !== "transaction") return bind(db, operation);
        return (...args: Parameters<IDBDatabase["transaction"]>) => new Proxy<IDBTransaction>(db.transaction(...args), { set, get(tx, key) {
          if (key !== "objectStore") return bind(tx, key);
          return (store: string) => new Proxy(tx.objectStore(store), { get(objectStore, method) {
            if (method !== "put") return bind(objectStore, method);
            return () => { throw new DOMException("Synthetic template quota exhaustion", "QuotaExceededError"); };
          } });
        } });
      } });
    } });
  } });
}
function rawDatabase(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => { const request = indexedDB.open(name, 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}

export async function runTemplateProbe(): Promise<TemplateProbeResult[]> {
  if (process.env.NODE_ENV !== "development") throw new Error("Template probes are available only in development");
  const databaseName = `photobooth-p3-probe-${crypto.randomUUID()}`, results: TemplateProbeResult[] = [], opened: TemplateShelf[] = [];
  const run = async (name: string, work: () => Promise<void>) => { try { await work(); results.push({ name, passed: true, detail: "Passed with native IndexedDB and PNG decoding" }); } catch (error) { results.push({ name, passed: false, detail: error instanceof Error ? error.message : String(error) }); } };
  const blob = await pixel(), blobs = new Map([["decoration-png", blob]]), now = "2026-09-23T00:00:00.000Z";
  const recipe = validateTemplateRecipe({ schemaVersion: 1, id: "native-template", name: "Synthetic template", revision: 0, scope: { kind: "device" }, createdAt: now, updatedAt: now,
    canvas: { width: 536, height: 1600 }, requiredSources: { A: 1 }, slots: [{ id: "photo-slot", role: "A", sourceIndex: 0, x: 0.1, y: 0.1, width: 0.8, height: 0.7, crop: { zoom: 1, offsetX: 0, offsetY: 0, rotation: 0, mirror: false } }],
    layers: [{ id: "decoration-layer", kind: "decoration", mediaId: "decoration-png", x: 0, y: 0, width: 0.1, height: 0.1, rotation: 0, fit: "contain" }], decorations: [{ id: "decoration-png", kind: "decoration", mime: "image/png", bytes: blob.size, width: 2, height: 2 }],
    look: { frameId: "film", filterId: "none", patternId: "none", themeId: null, sceneId: null, materialId: null }, defaults: { caption: "Synthetic private caption", showDate: true } });
  const connect = async (scope = recipe.scope, factory?: IDBFactory) => { const shelf = await openTemplateShelf(scope, { databaseName, indexedDB: factory }); opened.push(shelf); return shelf; };
  let saved: TemplateRecipe = recipe;
  try {
    let shelf = await connect();
    await run("Template reload and original PNG preservation", async () => {
      await shelf.save(recipe, blobs, null); shelf.close(); shelf = await connect();
      const loaded = await shelf.load(recipe.id); check(loaded?.kind === "current", "Template was not recovered after reopening");
      check(await templateBlobHash(loaded.decorations.get("decoration-png")!) === await templateBlobHash(blob), "PNG bytes changed");
    });
    await run("Concurrent template CAS admits exactly one writer", async () => {
      const other = await connect();
      const outcomes = await Promise.allSettled([shelf.save(validateTemplateRecipe({ ...recipe, revision: 1, name: "First edit" }), blobs, 0), other.save(validateTemplateRecipe({ ...recipe, revision: 1, name: "Other edit" }), blobs, 0)]);
      check(outcomes.filter(item => item.status === "fulfilled").length === 1, "Concurrent writers were not fenced");
      const loaded = await shelf.load(recipe.id); check(loaded?.kind === "current", "Committed template missing"); saved = loaded.recipe;
    });
    await run("Quota failure keeps the previous template and PNG", async () => {
      const failing = await connect(recipe.scope, quotaFactory());
      await denied(failing.save(validateTemplateRecipe({ ...saved, revision: saved.revision + 1, name: "Uncommitted" }), blobs, saved.revision), /quota/i);
      const loaded = await shelf.load(recipe.id); check(loaded?.kind === "current" && loaded.recipe.name === saved.name && loaded.recipe.revision === saved.revision, "Failed save changed committed data");
      check(await templateBlobHash(loaded.decorations.get("decoration-png")!) === await templateBlobHash(blob), "Failed save lost PNG bytes");
    });
    await run("Account scope isolation and duplicate safety", async () => {
      const account = await connect({ kind: "account", ownerId: "synthetic-owner" });
      check((await account.list()).length === 0 && await account.load(recipe.id) === null, "Device recipe leaked into account scope");
      await denied(account.save(saved, blobs, saved.revision), /scope/);
      const duplicate = await shelf.duplicate(recipe.id, { id: "duplicate-template" });
      check(duplicate.revision === 0 && duplicate.id !== saved.id, "Duplicate reused identity");
      await denied(shelf.delete(saved.id, saved.revision - 1), /another tab/);
      check((await shelf.load(saved.id))?.kind === "current", "Stale delete removed recipe");
    });
    await run("Native template bundle round-trip", async () => {
      const imported = await importTemplateBundle(await exportTemplateBundle(saved, blobs));
      check(imported.recipe.id !== saved.id && imported.recipe.defaults.caption === "", "Portable identity or privacy defaults failed");
      check(await templateBlobHash(imported.decorations.get("decoration-png")!) === await templateBlobHash(blob), "Portable PNG bytes changed");
    });
    await run("Future template remains read-only and raw-exportable", async () => {
      const db = await rawDatabase(databaseName), raw = '{"schemaVersion":99,"future":"preserve"}';
      try { await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("templates", "readwrite"), store = tx.objectStore("templates"), request = store.get(`device/${saved.id}`);
        request.onsuccess = () => store.put({ ...request.result, rawJson: raw });
        tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
      }); } finally { db.close(); }
      check((await shelf.load(saved.id))?.kind === "unsupported", "Future recipe was coerced");
      check(await (await shelf.exportRaw(saved.id)).manifest.text() === raw, "Raw future data was changed");
      await denied(shelf.save(validateTemplateRecipe({ ...saved, revision: saved.revision + 1 }), blobs, saved.revision), /newer app/);
    });
  } finally {
    for (const shelf of opened) shelf.close();
    await new Promise<void>((resolve, reject) => { const request = indexedDB.deleteDatabase(databaseName); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); request.onblocked = () => reject(new Error("Synthetic template cleanup was blocked")); });
  }
  return results;
}
