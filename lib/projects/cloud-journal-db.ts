import { cloudUuid } from "./cloud-contract";
import { CloudClientError, type CloudIdentity } from "./cloud-client";

export interface CloudJournalOptions { databaseName?: string; indexedDB?: IDBFactory }
export const CLOUD_JOURNAL_VERSION = 4;
const stores = ["uploads", "challengeRequests", "designSaves", "voiceDrafts"] as const;
type Store = typeof stores[number];
const openJournals = new Map<string, Set<() => void>>(), cleanupEpochs = new Map<string, number>();
const databaseKey = (ownerId: string, options: CloudJournalOptions) => `${options.databaseName ?? "pb-cloud-upload-journal"}:${ownerId}`;
function openDatabase(options: CloudJournalOptions): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = (options.indexedDB ?? indexedDB).open(options.databaseName ?? "pb-cloud-upload-journal", CLOUD_JOURNAL_VERSION);
    let expired = false; const timer = setTimeout(() => { expired = true; reject(new CloudClientError("journal_blocked")); }, 5000);
    request.onupgradeneeded = () => {
      if (expired) { request.transaction?.abort(); return; }
      for (const name of stores) if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, { keyPath: ["ownerId", "id"] }).createIndex("owner", "ownerId");
      if (!request.result.objectStoreNames.contains("generations")) request.result.createObjectStore("generations");
    };
    request.onerror = () => { clearTimeout(timer); reject(new CloudClientError(request.error?.name === "VersionError" ? "journal_readonly" : "journal_unavailable")); };
    request.onsuccess = () => { clearTimeout(timer); if (expired) request.result.close(); else resolve(request.result); };
  });
}
export async function removeCloudJournalForOwner(ownerId: string, options: CloudJournalOptions = {}): Promise<{ removed: number }> {
  cloudUuid(ownerId); const key = databaseKey(ownerId, options);
  cleanupEpochs.set(key, (cleanupEpochs.get(key) ?? 0) + 1);
  for (const close of [...openJournals.get(key) ?? []]) close();
  const db = await openDatabase(options);
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction([...stores, "generations"], "readwrite"), generations = tx.objectStore("generations"); let removed = 0;
      const timer = setTimeout(() => tx.abort(), 5000);
      tx.oncomplete = () => { clearTimeout(timer); resolve({ removed }); };
      tx.onabort = tx.onerror = () => { clearTimeout(timer); reject(new CloudClientError("journal_unavailable")); };
      const generation = generations.get(ownerId); generation.onsuccess = () => { generations.put((generation.result ?? 0) + 1, ownerId); };
      for (const name of stores) {
        const cursor = tx.objectStore(name).index("owner").openCursor(ownerId);
        cursor.onsuccess = () => { if (cursor.result) { cursor.result.delete(); removed++; cursor.result.continue(); } };
      }
    });
  } finally { db.close(); }
}
export async function openCloudJournalScope(ownerId: string, storeName: Store, options: CloudJournalOptions & { identity(): CloudIdentity | null }) {
  cloudUuid(ownerId); const initial = options.identity();
  if (!initial || initial.ownerId !== ownerId || !Number.isSafeInteger(initial.epoch)) throw new CloudClientError("account_changed");
  let closed = false; const epoch = initial.epoch, key = databaseKey(ownerId, options), cleanupEpoch = cleanupEpochs.get(key) ?? 0;
  function active() { const current = options.identity(); if (closed || !current || current.ownerId !== ownerId || current.epoch !== epoch || (cleanupEpochs.get(key) ?? 0) !== cleanupEpoch) throw new CloudClientError("account_changed"); }
  const db = await openDatabase(options);
  try { active(); } catch (error) { db.close(); throw error; }
  const transactions = new Set<IDBTransaction>();
  function close() { closed = true; for (const tx of transactions) { try { tx.abort(); } catch { /* Already committed. */ } } db.close(); const entries = openJournals.get(key); entries?.delete(close); if (!entries?.size) openJournals.delete(key); }
  if (!openJournals.has(key)) openJournals.set(key, new Set()); openJournals.get(key)!.add(close);
  db.onversionchange = close;
  const generation = await new Promise<number>((resolve, reject) => {
    const tx = db.transaction("generations", "readonly"); transactions.add(tx); const req = tx.objectStore("generations").get(ownerId);
    const timer = setTimeout(() => tx.abort(), 5000);
    tx.oncomplete = () => { clearTimeout(timer); transactions.delete(tx); resolve(req.result ?? 0); };
    tx.onabort = tx.onerror = () => { clearTimeout(timer); transactions.delete(tx); reject(new CloudClientError("journal_unavailable")); };
  }).catch(error => { close(); throw error; });
  try { active(); } catch (error) { close(); throw error; }
  function transaction<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore, done: (value: T) => void, fail: (error: unknown) => void) => void): Promise<T> {
    active(); return new Promise((resolve, reject) => {
      const tx = db.transaction([storeName, "generations"], mode); transactions.add(tx); let result: T, failure: unknown;
      const fail = (error: unknown) => { failure = error; try { tx.abort(); } catch { reject(error); } };
      const timer = setTimeout(() => fail(new CloudClientError("journal_unavailable")), 5000);
      tx.oncomplete = () => { clearTimeout(timer); transactions.delete(tx); try { active(); resolve(result); } catch (error) { reject(error); } };
      tx.onabort = tx.onerror = () => { clearTimeout(timer); transactions.delete(tx); reject(failure ?? new CloudClientError("journal_unavailable")); };
      const check = tx.objectStore("generations").get(ownerId);
      check.onsuccess = () => { try { active(); if ((check.result ?? 0) !== generation) throw new CloudClientError("account_changed"); work(tx.objectStore(storeName), value => { active(); result = value; }, fail); } catch (error) { fail(error); } };
    });
  }
  return { ownerId, active, transaction, close };
}
