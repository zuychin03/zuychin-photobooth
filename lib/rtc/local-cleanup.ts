import type { ProjectScope } from "../projects/model";
import { closeRoomScope, roomScopeKey, withRoomScopeLock } from "./scope-lifecycle";

export interface RoomCleanupResult { checkpoints: number; transfers: number; shots: number }
export interface RoomMetadataSummary { roomId: string; sessionId: string; records: number; expired: number; pending: number; unknownExpiry: number; bytes: number }
export interface RoomCleanupOptions { indexedDB?: IDBFactory; workspaceDatabaseName?: string; transferDatabaseName?: string; now?: () => number }
async function open(name: string, stores: string[], factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, 2); let expired = false;
    const timer = setTimeout(() => { expired = true; reject(new Error("room_cleanup_blocked")); }, 10000);
    request.onupgradeneeded = () => { if (expired) { request.transaction?.abort(); return; } for (const store of [...stores, "fences"]) if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store, { keyPath: "key" }); };
    request.onerror = () => { clearTimeout(timer); reject(request.error); };
    request.onsuccess = () => { clearTimeout(timer); if (expired) request.result.close(); else resolve(request.result); };
  });
}
function tx<T>(db: IDBDatabase, stores: string[], mode: IDBTransactionMode, work: (transaction: IDBTransaction, done: (value: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(stores, mode); let result: T;
    const timer = setTimeout(() => { try { transaction.abort(); } catch {} }, 10000);
    transaction.oncomplete = () => { clearTimeout(timer); resolve(result); }; transaction.onabort = () => { clearTimeout(timer); reject(transaction.error ?? new Error("room_cleanup_failed")); };
    try { work(transaction, value => { result = value; }); } catch (error) { transaction.abort(); reject(error); }
  });
}
const expired = (record: { expiresAt?: unknown; pending?: unknown }, now: number) => typeof record.expiresAt === "number" && Number.isFinite(record.expiresAt) && record.expiresAt <= now && !record.pending;
export async function inspectRoomMetadata(scope: ProjectScope, options: RoomCleanupOptions = {}): Promise<RoomMetadataSummary[]> {
  const prefix = `${roomScopeKey(scope)}/`, db = await open(options.workspaceDatabaseName ?? "photobooth-room-workspaces-v2", ["checkpoints"], options.indexedDB ?? indexedDB), now = (options.now ?? Date.now)();
  try { return await tx(db, ["checkpoints"], "readonly", (transaction, done) => {
    const rows = new Map<string, RoomMetadataSummary>(), request = transaction.objectStore("checkpoints").openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) { done([...rows.values()]); return; }
      const record = cursor.value;
      if (typeof record.key === "string" && record.key.startsWith(prefix) && typeof record.binding === "string" && record.binding.startsWith(prefix)) {
        const [roomId, sessionId] = record.binding.slice(prefix.length).split("/"), key = `${roomId}/${sessionId}`;
        const row = rows.get(key) ?? { roomId, sessionId, records: 0, expired: 0, pending: 0, unknownExpiry: 0, bytes: 0 };
        row.records++; row.expired += Number(expired(record, now)); row.pending += Number(Boolean(record.pending)); row.unknownExpiry += Number(!Number.isFinite(record.expiresAt)); row.bytes += new TextEncoder().encode(JSON.stringify(record)).byteLength; rows.set(key, row);
      }
      cursor.continue();
    };
  }); } finally { db.close(); }
}
export async function clearExpiredRoomMetadata(scope: ProjectScope, selected: { roomId: string; sessionId: string }, options: RoomCleanupOptions = {}): Promise<number> {
  if (![selected.roomId, selected.sessionId].every(id => /^[0-9a-f-]{36}$/i.test(id))) throw new Error("room_cleanup_identity");
  return withRoomScopeLock(scope, async () => {
    const prefix = `${roomScopeKey(scope)}/${selected.roomId}/${selected.sessionId}/`, now = (options.now ?? Date.now)();
    const db = await open(options.workspaceDatabaseName ?? "photobooth-room-workspaces-v2", ["checkpoints"], options.indexedDB ?? indexedDB);
    try { return await tx(db, ["checkpoints"], "readwrite", (transaction, done) => {
      let removed = 0; const request = transaction.objectStore("checkpoints").openCursor();
      request.onsuccess = () => { const cursor = request.result; if (!cursor) { done(removed); return; } const record = cursor.value; if (typeof record.key === "string" && record.key.startsWith(prefix) && typeof record.binding === "string" && record.binding.startsWith(prefix) && expired(record, now)) { cursor.delete(); removed++; } cursor.continue(); };
    }); } finally { db.close(); }
  });
}
export async function removeLocalAccountRoomData(ownerId: string, options: RoomCleanupOptions = {}): Promise<RoomCleanupResult> {
  const scope: ProjectScope = { kind: "account", ownerId }, scopeKey = roomScopeKey(scope), prefix = `${scopeKey}/`;
  await closeRoomScope(scope);
  return withRoomScopeLock(scope, async () => {
    const result: RoomCleanupResult = { checkpoints: 0, transfers: 0, shots: 0 }, factory = options.indexedDB ?? indexedDB;
    for (const [name, stores] of [[options.workspaceDatabaseName ?? "photobooth-room-workspaces-v2", ["checkpoints"]], [options.transferDatabaseName ?? "photobooth-room-transfers-v2", ["transfers", "shots"]]] as const) {
      const db = await open(name, [...stores], factory);
      try { await tx<void>(db, [...stores, "fences"], "readwrite", (transaction, done) => {
        const fences = transaction.objectStore("fences"), fence = fences.get(scopeKey);
        fence.onsuccess = () => fences.put({ key: scopeKey, generation: (fence.result?.generation ?? 0) + 1 });
        let remaining = stores.length;
        for (const name of stores) { const request = transaction.objectStore(name).openCursor(); request.onsuccess = () => {
          const cursor = request.result; if (!cursor) { if (--remaining === 0) done(); return; }
          if (typeof cursor.key === "string" && cursor.key.startsWith(prefix)) { cursor.delete(); result[name]++; }
          cursor.continue();
        }; }
      }); } finally { db.close(); }
    }
    return result;
  });
}
