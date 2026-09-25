import { projectBlobHash } from "../projects/bundle";
import { createProject, validatePhotoProject } from "../projects/model";
import { openProjectRepository, type ProjectRepository } from "../projects/storage";

export interface ProjectStorageProbeResult { name: string; passed: boolean; detail: string }
const RELOAD_DATABASE = "photobooth-p2-reload-probe";
function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
async function denied(work: Promise<unknown>, pattern: RegExp) {
  try { await work; } catch (error) { check(pattern.test(String(error)), `Unexpected rejection: ${String(error)}`); return; }
  throw new Error("Operation unexpectedly succeeded");
}
const open = (name: string, version: number) => new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open(name, version);
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
const remove = (name: string) => new Promise<void>((resolve, reject) => {
  const request = indexedDB.deleteDatabase(name);
  request.onsuccess = () => resolve();
  request.onerror = () => reject(request.error);
  request.onblocked = () => reject(new Error("Synthetic project probe cleanup was blocked"));
});

function quotaFailureFactory(databaseName: string): IDBFactory {
  let injected = false;
  const set = (target: object, key: PropertyKey, value: unknown) => Reflect.set(target, key, value, target);
  const bind = (target: object, key: PropertyKey) => {
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  };
  return new Proxy(indexedDB, { get(factory, key) {
    if (key !== "open") return bind(factory, key);
    return (name: string, version?: number) => {
      const request = factory.open(name, version);
      return new Proxy<IDBOpenDBRequest>(request, { set, get(target, property) {
        if (property !== "result") return bind(target, property);
        const db = target.result;
        return new Proxy<IDBDatabase>(db, { set, get(connection, operation) {
          if (operation !== "transaction" || name !== databaseName) return bind(connection, operation);
          return (...args: Parameters<IDBDatabase["transaction"]>) => new Proxy<IDBTransaction>(connection.transaction(...args), { set, get(tx, field) {
            if (field !== "objectStore") return bind(tx, field);
            return (storeName: string) => new Proxy(tx.objectStore(storeName), { get(store, method) {
              if (method !== "put" || storeName !== "projects") return bind(store, method);
              return (...values: Parameters<IDBObjectStore["put"]>) => {
                if (!injected) { injected = true; throw new DOMException("Synthetic quota failure after media was queued", "QuotaExceededError"); }
                return store.put(...values);
              };
            } });
          } });
        } });
      } });
    };
  } });
}
async function pixel(colour: string): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 2;
  const context = canvas.getContext("2d");
  check(context, "Canvas unavailable");
  context.fillStyle = colour;
  context.fillRect(0, 0, 2, 2);
  try { return await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("PNG encode failed")), "image/png")); }
  finally { canvas.width = canvas.height = 0; }
}

/** Runs only against newly named synthetic databases, never the user's project library. */
export async function runProjectStorageProbe(): Promise<ProjectStorageProbeResult[]> {
  const databaseName = `photobooth-p2-test-${crypto.randomUUID()}`, blockedName = `${databaseName}-blocked`;
  const results: ProjectStorageProbeResult[] = [], repositories: ProjectRepository[] = [];
  const report = (name: string, detail: string) => results.push({ name, passed: true, detail });
  const now = () => new Date().toISOString();
  let held: IDBDatabase | undefined, raw: IDBDatabase | undefined;
  try {
    const first = await openProjectRepository({ kind: "device" }, { databaseName, now }); repositories.push(first);
    const second = await openProjectRepository({ kind: "device" }, { databaseName, now }); repositories.push(second);
    const blob = await pixel("#ff0000"), timestamp = now();
    const empty = createProject({ id: "synthetic-project", name: "Original", createdAt: timestamp, captureTimeZone: "Australia/Sydney", participants: [{ id: "person-a", role: "A" }] });
    const project = validatePhotoProject({ ...empty, capturedAt: timestamp, sourceOrder: { A: ["photo-one"], B: [], C: [], D: [] }, media: [{ id: "photo-one", kind: "photo", participantId: "person-a", mime: "image/png", bytes: blob.size, width: 2, height: 2 }] });
    await first.save(project, new Map([["photo-one", blob]]), null);
    first.close();
    const reopened = await openProjectRepository({ kind: "device" }, { databaseName, now }); repositories.push(reopened);
    const recovered = await reopened.load(project.id);
    check(recovered?.kind === "current", "Committed project did not reopen");
    check(await projectBlobHash(recovered.media.get("photo-one")!) === await projectBlobHash(blob), "Source bytes changed after reopen");
    report("commit-reopen", "Committed manifest and original PNG survived closing/reopening the database");

    const attempts = await Promise.allSettled([reopened.rename(project.id, "Tab one", 0), second.rename(project.id, "Tab two", 0)]);
    check(attempts.filter(item => item.status === "fulfilled").length === 1, "Concurrent stale writers both committed");
    const current = await reopened.load(project.id);
    check(current?.kind === "current" && current.revision === 1, "Unexpected revision after racing saves");
    report("revision-fence", "Exactly one of two concurrent writers committed revision 1");

    const changedBlob = await pixel("#0000ff");
    const altered = validatePhotoProject({ ...current.project, revision: 2, updatedAt: now(), media: current.project.media.map(item => ({ ...item, bytes: changedBlob.size })) });
    await denied(reopened.save(altered, new Map([["photo-one", changedBlob]]), 1), /immutable/);
    report("immutable-original", "Replacing bytes under an existing media identifier was rejected");

    const newProject = validatePhotoProject({ ...current.project, revision: 2, updatedAt: now(), media: [...current.project.media, { ...current.project.media[0], id: "photo-two", bytes: changedBlob.size }], sourceOrder: { A: ["photo-one", "photo-two"], B: [], C: [], D: [] } });
    const failing = await openProjectRepository({ kind: "device" }, { databaseName, indexedDB: quotaFailureFactory(databaseName), now }); repositories.push(failing);
    await denied(failing.save(newProject, new Map([["photo-two", changedBlob]]), 1), /QuotaExceededError/);
    raw = await open(databaseName, 2);
    const mediaCount = await new Promise<number>((resolve, reject) => {
      const request = raw!.transaction("media").objectStore("media").count();
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    check(mediaCount === 1 && (await reopened.load(project.id))?.revision === 1, "Aborted transaction leaked media or advanced the manifest");
    report("quota-abort-rollback", "Injected QuotaExceededError after media requests rolled back both media and manifest");

    const account = await openProjectRepository({ kind: "account", ownerId: "account-a" }, { databaseName, now }); repositories.push(account);
    const foreign = await openProjectRepository({ kind: "account", ownerId: "account-b" }, { databaseName, now }); repositories.push(foreign);
    await account.save(validatePhotoProject({ ...project, scope: { kind: "account", ownerId: "account-a" } }), new Map([["photo-one", blob]]), null);
    check((await account.list()).length === 1 && (await foreign.list()).length === 0 && (await reopened.list()).length === 1, "Scoped lists leaked account drafts");
    check(await foreign.load(project.id) === null, "Foreign account opened a draft");
    await denied(reopened.save(validatePhotoProject({ ...project, scope: { kind: "account", ownerId: "account-a" } }), new Map(), null), /scope/);
    report("scope-isolation", "Device and exact account namespaces remain isolated even with identical project IDs");

    const duplicate = await reopened.duplicate(project.id, { id: "synthetic-copy", name: "Copy" });
    check(duplicate.capturedAt === project.capturedAt && duplicate.revision === 0, "Duplicate changed capture provenance");
    await reopened.delete(duplicate.id, 0);
    check(await reopened.load(duplicate.id) === null && (await reopened.load(project.id))?.kind === "current", "Scoped deletion affected the source");
    await reopened.rename(project.id, "Third name", 1);
    const restored = await reopened.recoverCheckpoint(project.id, 2);
    check(restored.name === current.project.name && restored.revision === 3, "Checkpoint recovery lost revision or previous settings");
    report("duplicate-delete-checkpoint", "Duplicate retained capture provenance; delete stayed scoped; previous manifest recovered at a new revision");

    await new Promise<void>((resolve, reject) => {
      const tx = raw!.transaction("projects", "readwrite"), store = tx.objectStore("projects"), request = store.get(`device/${project.id}`);
      request.onsuccess = () => { const record = request.result; record.rawJson = JSON.stringify({ ...restored, id: "mismatched-project" }); store.put(record); };
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
    });
    check((await reopened.load(project.id))?.kind === "corrupt", "Inconsistent stored identity remained editable");
    await denied(reopened.delete(project.id, 3), /inconsistent/);
    report("corrupt-identity", "A manifest/wrapper identity mismatch stayed read-only and could not be deleted");

    await new Promise<void>((resolve, reject) => {
      const tx = raw!.transaction("projects", "readwrite"), store = tx.objectStore("projects"), request = store.get(`device/${project.id}`);
      request.onsuccess = () => { const record = request.result; record.rawJson = JSON.stringify({ ...restored, schemaVersion: 99, futureField: "retain me" }); store.put(record); };
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
    });
    check((await reopened.load(project.id))?.kind === "unsupported", "Future schema was not read-only");
    await denied(reopened.rename(project.id, "Unsafe", 3), /read-only/);
    await denied(reopened.delete(project.id, 3), /read-only/);
    await denied(reopened.recoverCheckpoint(project.id, 3), /read-only/);
    check((await (await reopened.exportRaw(project.id)).manifest.text()).includes("retain me"), "Future data was lost from raw export");
    report("future-readonly", "Unknown future manifest stayed read-only with exact raw backup retained");

    held = await open(blockedName, 1);
    await denied(openProjectRepository({ kind: "device" }, { databaseName: blockedName, timeoutMs: 40 }), /close other project tabs/);
    held.close(); held = undefined;
    const upgraded = await openProjectRepository({ kind: "device" }, { databaseName: blockedName }); repositories.push(upgraded);
    await upgraded.save(createProject({ id: "upgraded", createdAt: now(), captureTimeZone: "Australia/Sydney" }), new Map(), null);
    upgraded.close();
    report("blocked-upgrade", "Blocked upgrade timed out; retry after closing the old connection completed additively");

    raw.close(); raw = undefined;
    const nextVersion = await open(databaseName, 3);
    nextVersion.close();
    await denied(reopened.list(), /closed/);
    report("versionchange-close", "A version upgrade closed every old repository connection");
    return results;
  } finally {
    raw?.close(); held?.close();
    for (const repository of repositories) repository.close();
    await remove(databaseName);
    await remove(blockedName);
  }
}

export async function saveProjectReloadCheckpoint(): Promise<ProjectStorageProbeResult> {
  const repository = await openProjectRepository({ kind: "device" }, { databaseName: RELOAD_DATABASE });
  try {
    const previous = await repository.load("reload-checkpoint");
    if (previous) await repository.delete(previous.id, previous.revision);
    const blob = await pixel("#22c55e"), timestamp = new Date().toISOString();
    const blank = createProject({ id: "reload-checkpoint", name: `Reload ${performance.timeOrigin}`, createdAt: timestamp, captureTimeZone: "Australia/Sydney", participants: [{ id: "person-a", role: "A" }], editor: { caption: await projectBlobHash(blob) } });
    const project = validatePhotoProject({ ...blank, capturedAt: timestamp, media: [{ id: "reload-photo", kind: "photo", participantId: "person-a", mime: "image/png", bytes: blob.size, width: 2, height: 2 }], sourceOrder: { A: ["reload-photo"], B: [], C: [], D: [] } });
    await repository.save(project, new Map([["reload-photo", blob]]), null);
    return { name: "project-reload-save", passed: true, detail: "Synthetic P2 manifest and PNG committed. Reload this page before verification." };
  } finally { repository.close(); }
}

export async function verifyProjectReloadCheckpoint(): Promise<ProjectStorageProbeResult> {
  const repository = await openProjectRepository({ kind: "device" }, { databaseName: RELOAD_DATABASE });
  try {
    const loaded = await repository.load("reload-checkpoint");
    check(loaded?.kind === "current", "Save the synthetic P2 checkpoint first");
    check(loaded.project.name !== `Reload ${performance.timeOrigin}`, "Reload the page before checking recovery");
    check(await projectBlobHash(loaded.media.get("reload-photo")!) === loaded.project.editor.caption, "Recovered original PNG bytes differ");
    return { name: "project-reload-verify", passed: true, detail: "Recovered the P2 manifest and exact original PNG from a prior page document." };
  } finally { repository.close(); }
}

export async function clearProjectReloadCheckpoint(): Promise<ProjectStorageProbeResult> {
  await remove(RELOAD_DATABASE);
  return { name: "project-reload-clear", passed: true, detail: "Only the synthetic P2 reload database was removed." };
}
