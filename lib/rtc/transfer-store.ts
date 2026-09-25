import type { ProjectScope } from "../projects/model";
import { TRANSFER_CHUNK_BYTES, validateTransferManifest, type TransferManifest } from "./protocol";
import { registerRoomScopeCloser, roomScopeEpoch, roomScopeKey } from "./scope-lifecycle";

export const TRANSFER_DATABASE = "photobooth-room-transfers-v2";
const MAX_BYTES = 64 * 1024 * 1024, MAX_TRANSFERS = 24, MAX_MARKERS = 1024;
interface ChunkRecord { blob: Blob; hash: string }
export interface JournalTransfer {
  manifest: TransferManifest; direction: "send" | "receive"; chunks: (ChunkRecord | null)[];
  committed: boolean; acknowledgedBy: string[];
}
interface StoredTransfer extends JournalTransfer { key: string; binding: string }
interface ShotMarker { key: string; expiresAt: number; state: "claimed" | "saved" }
export interface TransferJournal {
  reserve(manifest: TransferManifest, direction: "send" | "receive"): Promise<JournalTransfer>;
  get(id: string): Promise<JournalTransfer | null>;
  list(): Promise<JournalTransfer[]>;
  putChunk(id: string, index: number, bytes: Uint8Array): Promise<void>;
  markCommitted(id: string): Promise<void>;
  acknowledge(id: string, memberId: string): Promise<void>;
  remove(id: string): Promise<void>;
  claimShot(captureId: string, shotId: string, expiresAt: number): Promise<boolean>;
  finishShot(captureId: string, shotId: string): Promise<void>;
  cleanup(): Promise<void>;
  close(): void;
}
export async function transferHash(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)))].map(value => value.toString(16).padStart(2, "0")).join("");
}
export async function openTransferJournal(input: { scope: ProjectScope; roomId: string; sessionId: string; selfId: string }, options: { indexedDB?: IDBFactory; databaseName?: string; timeoutMs?: number; now?: () => number } = {}): Promise<TransferJournal> {
  const safe = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
  if (![input.roomId, input.sessionId, input.selfId].every(value => safe.test(value)) || (input.scope.kind === "account" && !safe.test(input.scope.ownerId))) throw new Error("invalid_transfer_scope");
  const scope = input.scope.kind === "device" ? "device" : `account:${input.scope.ownerId}`;
  const epoch = roomScopeEpoch(input.scope);
  const binding = `${scope}/${input.roomId}/${input.sessionId}/${input.selfId}`;
  const factory = options.indexedDB ?? globalThis.indexedDB, timeout = options.timeoutMs ?? 10000, now = options.now ?? Date.now;
  if (!factory || !Number.isFinite(timeout) || timeout < 1 || timeout > 60000) throw new Error("transfer_storage_unavailable");
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(options.databaseName ?? TRANSFER_DATABASE, 2);
    let expired = false, blocked = false;
    const timer = setTimeout(() => { expired = true; reject(new Error(blocked ? "transfer_storage_blocked" : "transfer_storage_timeout")); }, timeout);
    request.onblocked = () => { blocked = true; };
    request.onupgradeneeded = () => {
      if (expired) { request.transaction?.abort(); return; }
      for (const name of ["transfers", "shots", "fences"]) if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, { keyPath: "key" });
    };
    request.onerror = () => { clearTimeout(timer); reject(request.error); };
    request.onsuccess = () => { clearTimeout(timer); if (expired) request.result.close(); else resolve(request.result); };
  });
  let closed = false;
  let unregister = () => {};
  const close = () => { closed = true; unregister(); db.close(); };
  db.onversionchange = close; db.onclose = () => { closed = true; };
  if (epoch !== roomScopeEpoch(input.scope)) { close(); throw new Error("transfer_storage_closed"); }
  unregister = registerRoomScopeCloser(input.scope, close);
  const scopeKey = roomScopeKey(input.scope);
  const generation = await new Promise<number>((resolve, reject) => { const request = db.transaction("fences").objectStore("fences").get(scopeKey); request.onsuccess = () => resolve(request.result?.generation ?? 0); request.onerror = () => reject(request.error); }).catch(error => { close(); throw error; });
  const transact = <T,>(mode: IDBTransactionMode, work: (stores: { transfers: IDBObjectStore; shots: IDBObjectStore }, request: <V>(r: IDBRequest<V>, cb: (v: V) => void) => void, finish: (value: T) => void) => void): Promise<T> => {
    if (closed) return Promise.reject(new Error("transfer_storage_closed"));
    return new Promise((resolve, reject) => {
      const tx = db.transaction(["transfers", "shots", "fences"], mode); let value: T, finished = false, failure: unknown;
      const abort = (error: unknown) => { failure = error; try { tx.abort(); } catch { reject(error); } };
      const timer = setTimeout(() => abort(new Error("transfer_storage_timeout")), timeout);
      tx.oncomplete = () => { clearTimeout(timer); if (finished) resolve(value); else reject(new Error("transfer_storage_incomplete")); };
      tx.onabort = () => { clearTimeout(timer); reject(failure ?? tx.error ?? new Error("transfer_storage_aborted")); };
      const request = <V,>(r: IDBRequest<V>, cb: (v: V) => void) => { r.onsuccess = () => { try { cb(r.result); } catch (error) { abort(error); } }; };
      request(tx.objectStore("fences").get(scopeKey), fence => {
        if ((fence?.generation ?? 0) !== generation) throw new Error("transfer_storage_closed");
        work({ transfers: tx.objectStore("transfers"), shots: tx.objectStore("shots") }, request, result => { value = result; finished = true; });
      });
    });
  };
  const key = (id: string) => { if (!safe.test(id)) throw new Error("invalid_transfer_id"); return `${binding}/${id}`; };
  const check = (item: StoredTransfer | undefined): StoredTransfer => {
    if (!item || item.binding !== binding || item.manifest.roomId !== input.roomId || item.manifest.sessionId !== input.sessionId) throw new Error("transfer_missing");
    validateTransferManifest(item.manifest);
    if (item.manifest.expiresAt <= now()) throw new Error("transfer_expired");
    return item;
  };
  const update = (id: string, mutate: (item: StoredTransfer) => void) => transact<void>("readwrite", (stores, request, finish) => {
    request(stores.transfers.get(key(id)), item => { const checked = check(item); mutate(checked); stores.transfers.put(checked); finish(); });
  });
  const journal: TransferJournal = {
    close,
    cleanup: () => transact<void>("readwrite", (stores, request, finish) => {
      request(stores.transfers.getAll(), (items: StoredTransfer[]) => { for (const item of items) if (item.binding.startsWith(`${scope}/`) && item.key.startsWith(`${scope}/`) && Number.isFinite(item.manifest?.expiresAt) && item.manifest.expiresAt <= now()) stores.transfers.delete(item.key); });
      request(stores.shots.getAll(), (items: ShotMarker[]) => { for (const item of items) if (item.key.startsWith(`${scope}/`) && Number.isFinite(item.expiresAt) && item.expiresAt <= now()) stores.shots.delete(item.key); finish(); });
    }),
    reserve: async (value, direction) => {
      const manifest = validateTransferManifest(value);
      if (manifest.roomId !== input.roomId || manifest.sessionId !== input.sessionId || (direction === "send" && manifest.memberId !== input.selfId)
        || manifest.expiresAt <= now() || manifest.expiresAt > now() + 2 * 60 * 60 * 1000) throw new Error("invalid_transfer_scope");
      return transact("readwrite", (stores, request, finish) => request(stores.transfers.getAll(), (items: StoredTransfer[]) => {
        const existing = items.find(item => item.key === key(manifest.id));
        if (existing) {
          check(existing);
          if (existing.direction !== direction || Object.keys(manifest).some(field => manifest[field as keyof TransferManifest] !== existing.manifest[field as keyof TransferManifest])) throw new Error("transfer_conflict");
          finish(existing); return;
        }
        if (items.some(item => item.binding === binding && item.manifest.captureId === manifest.captureId && item.manifest.memberId === manifest.memberId && item.manifest.shotId === manifest.shotId)) throw new Error("transfer_slot_conflict");
        if (items.filter(item => !item.committed).length >= MAX_TRANSFERS || items.length >= 512 || items.some(item => !Number.isSafeInteger(item.manifest?.bytes)) || items.reduce((sum, item) => sum + (item.committed ? 0 : item.manifest.bytes), 0) + manifest.bytes > MAX_BYTES) throw new Error("transfer_storage_full");
        const item: StoredTransfer = { key: key(manifest.id), binding, manifest, direction, chunks: Array.from({ length: manifest.chunks }, () => null), committed: false, acknowledgedBy: [] };
        stores.transfers.add(item); finish(item);
      }));
    },
    get: id => transact("readonly", (stores, request, finish) => request(stores.transfers.get(key(id)), item => finish(item ? check(item) : null))),
    list: () => transact("readonly", (stores, request, finish) => request(stores.transfers.getAll(), (items: StoredTransfer[]) => finish(items.filter(item => item.binding === binding && item.manifest.expiresAt > now()).map(check)))),
    putChunk: async (id, index, bytes) => {
      if (!Number.isInteger(index) || index < 0 || bytes.byteLength < 1 || bytes.byteLength > TRANSFER_CHUNK_BYTES) throw new Error("invalid_chunk");
      const copy = new Uint8Array(bytes), hash = await transferHash(copy);
      await update(id, item => {
        const expected = Math.min(TRANSFER_CHUNK_BYTES, item.manifest.bytes - index * TRANSFER_CHUNK_BYTES);
        if (index >= item.manifest.chunks || copy.byteLength !== expected) throw new Error("invalid_chunk");
        const previous = item.chunks[index];
        if (previous && previous.hash !== hash) throw new Error("chunk_conflict");
        item.chunks[index] = previous ?? { blob: new Blob([copy]), hash };
      });
    },
    markCommitted: id => update(id, item => { if (item.chunks.some(chunk => !chunk)) throw new Error("transfer_incomplete"); item.committed = true; item.chunks = item.chunks.map(chunk => ({ blob: new Blob(), hash: chunk!.hash })); }),
    acknowledge: (id, memberId) => update(id, item => { if (!safe.test(memberId) || item.direction !== "send") throw new Error("invalid_ack"); if (!item.acknowledgedBy.includes(memberId)) { if (item.acknowledgedBy.length >= 3) throw new Error("invalid_ack"); item.acknowledgedBy.push(memberId); } }),
    remove: id => transact<void>("readwrite", (stores, _request, finish) => { stores.transfers.delete(key(id)); finish(); }),
    claimShot: (captureId, shotId, expiresAt) => {
      const markerKey = `${key(captureId)}/${shotId}`;
      if (!safe.test(shotId) || !Number.isFinite(expiresAt) || expiresAt <= now() || expiresAt > now() + 7200000) return Promise.reject(new Error("invalid_shot_marker"));
      return transact("readwrite", (stores, request, finish) => request(stores.shots.getAll(), (items: ShotMarker[]) => {
        if (items.some(item => item.key === markerKey)) { finish(false); return; }
        if (items.length >= MAX_MARKERS) throw new Error("transfer_storage_full");
        stores.shots.add({ key: markerKey, expiresAt, state: "claimed" } satisfies ShotMarker); finish(true);
      }));
    },
    finishShot: (captureId, shotId) => transact<void>("readwrite", (stores, request, finish) => {
      if (!safe.test(shotId)) throw new Error("invalid_shot_marker");
      request(stores.shots.get(`${key(captureId)}/${shotId}`), (item: ShotMarker | undefined) => { if (!item || item.expiresAt <= now()) throw new Error("shot_marker_missing"); stores.shots.put({ ...item, state: "saved" }); finish(); });
    }),
  };
  try { await journal.cleanup(); return journal; } catch (error) { close(); throw error; }
}

export async function runRoomTransferJournalProbe(): Promise<{ checks: string[] }> {
  if (!globalThis.indexedDB) throw new Error("IndexedDB is unavailable");
  const { retainOutgoing } = await import("./transfer");
  const databaseName = `pb-room-journal-probe-${crypto.randomUUID()}`, checks: string[] = [];
  const input = { scope: { kind: "device" as const }, roomId: crypto.randomUUID(), sessionId: crypto.randomUUID(), selfId: crypto.randomUUID() };
  let time = Date.now(); const options = { databaseName, now: () => time };
  const journals: TransferJournal[] = [];
  const assert = (value: unknown, message: string) => { if (!value) throw new Error(message); };
  try {
    const first = await openTransferJournal(input, options), second = await openTransferJournal(input, options); journals.push(first, second);
    const captureId = crypto.randomUUID(), markers = await Promise.all([first.claimShot(captureId, "one", time + 60000), second.claimShot(captureId, "one", time + 60000)]);
    assert(markers.filter(Boolean).length === 1, "Two tabs claimed the same shutter"); checks.push("two-connection shutter claim");
    const bytes = new Uint8Array(32769).fill(17);
    const manifest: TransferManifest = { id: crypto.randomUUID(), roomId: input.roomId, sessionId: input.sessionId, memberId: input.selfId, captureId, shotId: "one", role: "A", mime: "image/png", width: 4, height: 4, bytes: bytes.length, sha256: await transferHash(bytes), chunkSize: 16384, chunks: 3, expiresAt: time + 60000 };
    await first.reserve(manifest, "send"); await first.putChunk(manifest.id, 0, bytes.subarray(0, 16384));
    let rejected = false; try { await second.putChunk(manifest.id, 0, new Uint8Array(16384).fill(18)); } catch { rejected = true; }
    assert(rejected, "Conflicting immutable chunk was accepted");
    assert(new Uint8Array(await (await second.get(manifest.id))!.chunks[0]!.blob.arrayBuffer())[0] === 17, "An aborted update changed the original chunk"); checks.push("chunk conflict transaction rollback");
    let interrupted = false;
    try { await retainOutgoing({ ...first, putChunk: async (id, index, chunk) => { if (index === 1) throw new Error("fixture_stage_interrupted"); await first.putChunk(id, index, chunk); } }, { ...manifest, id: crypto.randomUUID() }, new Blob([bytes], { type: manifest.mime })); }
    catch (error) { interrupted = error instanceof Error && error.message === "fixture_stage_interrupted"; }
    assert(interrupted, "Outgoing staging interruption was not exercised");
    first.close(); second.close();
    const reopened = await openTransferJournal(input, options); journals.push(reopened);
    assert((await reopened.get(manifest.id))?.chunks[0]?.blob.size === 16384 && !await reopened.claimShot(captureId, "one", time + 60000), "Reload lost bytes or the shutter claim"); checks.push("close/reopen partial transfer and capture marker");
    const recovered = await retainOutgoing(reopened, { ...manifest, id: crypto.randomUUID() }, new Blob([bytes], { type: manifest.mime }));
    assert(recovered.manifest.id === manifest.id && (await reopened.list()).length === 1 && recovered.chunks.every(Boolean), "Outgoing retry duplicated its slot or left missing chunks");
    assert(await transferHash(new Uint8Array(await new Blob(recovered.chunks.map(chunk => chunk!.blob)).arrayBuffer())) === manifest.sha256, "Outgoing retry changed original bytes"); checks.push("interrupted outgoing staging retries one UUID after reopen with exact bytes");
    const otherTime = time, other = await openTransferJournal({ ...input, scope: { kind: "account", ownerId: "probe-account" } }, { ...options, now: () => otherTime }); journals.push(other);
    assert(await other.get(manifest.id) === null && (await other.list()).length === 0, "Account scope exposed a device transfer"); checks.push("exact scope isolation");
    await other.reserve(manifest, "send"); await other.putChunk(manifest.id, 0, bytes.subarray(0, 16384)); await other.claimShot(captureId, "one", otherTime + 60000);
    const reservations = await Promise.allSettled(Array.from({ length: 7 }, (_, index) => reopened.reserve({ ...manifest, id: crypto.randomUUID(), captureId: crypto.randomUUID(), shotId: `budget-${index}`, bytes: 10 * 1024 * 1024, chunks: 640 }, "send")));
    assert(reservations.filter(result => result.status === "fulfilled").length === 6, "Concurrent reservations bypassed the byte ceiling"); checks.push("concurrent 64 MiB reservation ceiling");
    time += 60001;
    const nextRoom = await openTransferJournal({ ...input, roomId: crypto.randomUUID(), sessionId: crypto.randomUUID() }, options); journals.push(nextRoom);
    assert(await reopened.get(manifest.id) === null, "Opening a new room left expired same-scope staging behind");
    assert(await reopened.claimShot(captureId, "one", time + 60000), "Expired marker was not cleaned");
    assert((await other.get(manifest.id))?.chunks[0]?.blob.size === 16384 && !await other.claimShot(captureId, "one", otherTime + 60000), "Same-scope expiry cleanup touched another account"); checks.push("new room clears expired same-scope staging and markers, preserving another account");
    return { checks };
  } finally {
    for (const journal of journals) journal.close();
    await new Promise<void>((resolve, reject) => { const request = indexedDB.deleteDatabase(databaseName); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); request.onblocked = () => reject(new Error("Probe database cleanup was blocked")); });
  }
}
