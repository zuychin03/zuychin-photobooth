import type { ProbeResult } from "./types";

const CHECKPOINT_DB = "photobooth-p0-reload-probe";
const CHECKPOINT_ID = "synthetic-checkpoint";

interface Checkpoint {
  id: string;
  schemaVersion: 1;
  caption: string;
  capturedAt: string;
  hash: string;
  createdInDocument: number;
}

function openDatabase(name: string, version = 1): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version);
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      reject(new Error("Database open timed out; close other probe tabs"));
    }, 5000);
    request.onupgradeneeded = () => {
      if (expired) { request.transaction?.abort(); return; }
      const db = request.result;
      if (!db.objectStoreNames.contains("projects")) db.createObjectStore("projects", { keyPath: "id" });
      if (!db.objectStoreNames.contains("media")) db.createObjectStore("media");
      if (version >= 2) {
        const projects = request.transaction!.objectStore("projects");
        if (!projects.indexNames.contains("capturedAt")) projects.createIndex("capturedAt", "capturedAt");
      }
    };
    request.onerror = () => { clearTimeout(timer); reject(request.error); };
    request.onsuccess = () => {
      clearTimeout(timer);
      if (expired) { request.result.close(); return; }
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
}

function complete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Database transaction timed out after 5 seconds"));
      try { transaction.abort(); } catch { /* An already-finished transaction cannot be aborted. */ }
    }, 5000);
    transaction.oncomplete = () => { clearTimeout(timer); resolve(); };
    transaction.onabort = () => { clearTimeout(timer); reject(transaction.error ?? new DOMException("Transaction aborted", "AbortError")); };
    transaction.onerror = () => {};
  });
}

function read<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function digest(blob: Blob): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join("");
}

async function fixture(): Promise<{ project: Checkpoint; blob: Blob }> {
  const canvas = document.createElement("canvas");
  canvas.width = 96;
  canvas.height = 64;
  try {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas unavailable");
    ctx.fillStyle = "#e11d48";
    ctx.fillRect(0, 0, 48, 64);
    ctx.fillStyle = "#1c1917";
    ctx.fillRect(48, 0, 48, 64);
    const blob = await new Promise<Blob>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("PNG export timed out after 8 seconds")), 8000);
      try {
        canvas.toBlob(value => {
          clearTimeout(timer);
          if (value?.size && value.type === "image/png") resolve(value);
          else reject(new Error("PNG export failed"));
        }, "image/png");
      } catch (error) { clearTimeout(timer); reject(error); }
    });
    return {
      blob,
      project: { id: CHECKPOINT_ID, schemaVersion: 1, caption: "P0 synthetic draft", capturedAt: new Date().toISOString(), hash: await digest(blob), createdInDocument: performance.timeOrigin },
    };
  } finally {
    canvas.width = canvas.height = 0;
  }
}

async function writeFixture(db: IDBDatabase, project: Checkpoint, blob: Blob, abort = false) {
  const transaction = db.transaction(["projects", "media"], "readwrite");
  const done = complete(transaction);
  try {
    transaction.objectStore("media").put(blob, project.id);
    transaction.objectStore("projects").put(project);
    if (abort) transaction.abort();
  } catch (error) {
    try { transaction.abort(); } catch { /* Preserve the original write failure. */ }
    await done.catch(() => {});
    throw error;
  }
  await done;
}

async function readFixture(db: IDBDatabase) {
  const transaction = db.transaction(["projects", "media"], "readonly");
  const done = complete(transaction);
  const [, project, blob] = await Promise.all([
    done,
    read<Checkpoint | undefined>(transaction.objectStore("projects").get(CHECKPOINT_ID)),
    read<Blob | undefined>(transaction.objectStore("media").get(CHECKPOINT_ID)),
  ]);
  return { project, blob };
}

function sameManifest(actual: Checkpoint | undefined, expected: Checkpoint): boolean {
  return !!actual && actual.id === expected.id && actual.schemaVersion === expected.schemaVersion
    && actual.caption === expected.caption && actual.capturedAt === expected.capturedAt
    && actual.hash === expected.hash && actual.createdInDocument === expected.createdInDocument;
}

async function removeProbe(name: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    const timer = setTimeout(() => reject(new Error("Probe cleanup blocked by another tab")), 5000);
    request.onsuccess = () => { clearTimeout(timer); resolve(); };
    request.onerror = () => { clearTimeout(timer); reject(request.error); };
  });
}

export async function runStorageProbe(): Promise<ProbeResult[]> {
  if (!globalThis.indexedDB || !globalThis.crypto?.subtle) return [{ id: "storage", status: "unsupported", detail: "IndexedDB or secure-context hashing unavailable" }];
  const results: ProbeResult[] = [];
  const name = `photobooth-p0-transaction-${crypto.randomUUID()}`;
  let db: IDBDatabase | undefined;
  try {
    const { project, blob } = await fixture();
    db = await openDatabase(name);
    await writeFixture(db, project, blob);
    db.close();
    db = await openDatabase(name);
    const recovered = await readFixture(db);
    const restored = sameManifest(recovered.project, project) && recovered.blob instanceof Blob && await digest(recovered.blob) === project.hash;
    results.push({ id: "storage-reopen", status: restored ? "pass" : "fail", detail: restored ? "Atomic manifest and PNG recovered after closing and reopening the database" : "Reopened manifest or PNG differs from the committed fixture", metrics: { bytes: blob.size } });
    let aborted = false;
    try {
      await writeFixture(db, { ...project, caption: "Uncommitted edit" }, new Blob(["replacement"]), true);
    } catch (error) {
      if (!(error instanceof DOMException) || error.name !== "AbortError") throw error;
      aborted = true;
    }
    const rollback = await readFixture(db);
    const preserved = aborted && sameManifest(rollback.project, project) && rollback.blob instanceof Blob && await digest(rollback.blob) === project.hash;
    results.push({ id: "storage-rollback", status: preserved ? "pass" : "fail", detail: preserved ? "Injected transaction abort preserved both the prior manifest and media. This is not a disk-full test." : "Transaction abort did not preserve the complete prior fixture" });
    db.close();
    db = await openDatabase(name, 2);
    const migrated = await readFixture(db);
    const migrationPassed = db.version === 2 && db.transaction("projects").objectStore("projects").indexNames.contains("capturedAt") && sameManifest(migrated.project, project) && migrated.blob instanceof Blob && await digest(migrated.blob) === project.hash;
    results.push({ id: "storage-migration", status: migrationPassed ? "pass" : "fail", detail: migrationPassed ? "Additive database index upgrade retained the existing manifest and PNG" : "Database version, index, manifest or PNG did not survive the additive upgrade" });
  } catch (error) {
    results.push({ id: "storage", status: "fail", detail: error instanceof Error ? error.message : String(error) });
  } finally {
    db?.close();
    try { await removeProbe(name); } catch (error) {
      results.push({ id: "storage-cleanup", status: "fail", detail: String(error) });
    }
  }
  return results;
}

export async function saveReloadCheckpoint(): Promise<ProbeResult> {
  const { project, blob } = await fixture();
  const db = await openDatabase(CHECKPOINT_DB);
  try { await writeFixture(db, project, blob); } finally { db.close(); }
  return { id: "reload-checkpoint-save", status: "pass", detail: "Synthetic PNG and manifest committed. Reload this page, then verify the checkpoint.", metrics: { capturedAt: project.capturedAt, hash: project.hash } };
}

export async function verifyReloadCheckpoint(): Promise<ProbeResult> {
  const db = await openDatabase(CHECKPOINT_DB);
  try {
    const { project, blob } = await readFixture(db);
    if (!project || !(blob instanceof Blob)) return { id: "reload-checkpoint", status: "fail", detail: "No complete checkpoint found. Save one before reloading." };
    if (project.createdInDocument === performance.timeOrigin) return { id: "reload-checkpoint", status: "fail", detail: "Checkpoint was saved in this document. Reload the page before verifying recovery." };
    const intact = project.id === CHECKPOINT_ID && project.schemaVersion === 1 && project.caption === "P0 synthetic draft"
      && Number.isFinite(project.createdInDocument) && Number.isFinite(Date.parse(project.capturedAt))
      && blob.type === "image/png" && blob.size > 0 && await digest(blob) === project.hash;
    return { id: "reload-checkpoint", status: intact ? "pass" : "fail", detail: intact ? "Recovered synthetic manifest from a prior document and verified original PNG bytes" : "Checkpoint manifest or PNG integrity validation failed", metrics: { capturedAt: project.capturedAt, hash: project.hash, bytes: blob.size } };
  } finally { db.close(); }
}

export async function clearReloadCheckpoint(): Promise<ProbeResult> {
  await removeProbe(CHECKPOINT_DB);
  return { id: "reload-checkpoint-clear", status: "pass", detail: "Only the P0 synthetic checkpoint database was removed" };
}
