import { openRoomWorkspaceStore, type RoomWorkspaceStore } from "./workspace-store";
import { openTransferJournal, transferHash, type TransferJournal } from "./transfer-store";
import { clearExpiredRoomMetadata, inspectRoomMetadata, removeLocalAccountRoomData } from "./local-cleanup";
import { registerRoomScopeCloser } from "./scope-lifecycle";
import type { RoomState } from "../server/room-contract";
import type { ProjectScope } from "../projects/model";

export async function runRoomCleanupProbe(): Promise<{ checks: string[] }> {
  if (process.env.NODE_ENV !== "development") throw new Error("Development only");
  const prefix = `pb-room-cleanup-probe-${crypto.randomUUID()}`, names = [`${prefix}-metadata`, `${prefix}-transfers`, `${prefix}-projects`];
  const options = { workspaceDatabaseName: names[0], transferDatabaseName: names[1] }, checks: string[] = [], stores: RoomWorkspaceStore[] = [], journals: TransferJournal[] = [];
  const scopes: ProjectScope[] = [{ kind: "account", ownerId: "probe-a" }, { kind: "account", ownerId: "probe-b" }, { kind: "device" }];
  const roomId = crypto.randomUUID(), sessionId = crypto.randomUUID(), selfId = crypto.randomUUID(), epoch = crypto.randomUUID();
  const state: RoomState = { roomId, sessionId, selfId, hostId: selfId, selfRole: "A", code: "ABC234", connectionEpoch: epoch, rosterRevision: 1, status: "open", locked: false, serverNow: Date.now(), expiresAt: Date.now() + 60000, capture: null, members: [{ id: selfId, role: "A", displayName: "Fixture", status: "admitted", connectionEpoch: epoch }] };
  let release: (() => void) | null = null, unregister = () => {};
  const assert = (value: unknown, message: string) => { if (!value) throw new Error(message); };
  try {
    const transferIds: string[] = [];
    for (const scope of scopes) {
      const store = await openRoomWorkspaceStore({ scope, roomId, sessionId, selfId }, { databaseName: names[0], projectDatabaseName: names[2] }); stores.push(store); await store.loadDraft(state);
      const journal = await openTransferJournal({ scope, roomId, sessionId, selfId }, { databaseName: names[1] }); journals.push(journal);
      const bytes = new Uint8Array([1, 2, 3]), id = crypto.randomUUID(), captureId = crypto.randomUUID(); transferIds.push(id);
      await journal.reserve({ id, roomId, sessionId, captureId, memberId: selfId, shotId: "one", role: "A", mime: "image/png", width: 1, height: 1, bytes: 3, sha256: await transferHash(bytes), chunkSize: 16384, chunks: 1, expiresAt: Date.now() + 60000 }, "send");
      await journal.putChunk(id, 0, bytes); await journal.claimShot(captureId, "one", Date.now() + 60000);
    }
    unregister = registerRoomScopeCloser(scopes[0], () => new Promise<void>(resolve => { release = resolve; }));
    const cleanup = removeLocalAccountRoomData("probe-a", options);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert((await inspectRoomMetadata(scopes[0], options)).length === 1, "Cleanup ran before the scope drained");
    if (!release) throw new Error("Scope closer was not invoked"); (release as () => void)();
    const removed = await cleanup; unregister();
    assert(removed.checkpoints === 1 && removed.transfers === 1 && removed.shots === 1, "Account cleanup count differs"); checks.push("close-and-drain completes before account record deletion");
    assert((await inspectRoomMetadata(scopes[0], options)).length === 0, "Private account metadata remains");
    let denied = false; try { await journals[0].reserve((await journals[1].get(transferIds[1]))!.manifest, "send"); } catch { denied = true; }
    assert(denied, "Closed account writer recreated a transfer"); checks.push("old account handles cannot recreate deleted transfer bytes");
    for (const index of [1, 2]) { assert((await inspectRoomMetadata(scopes[index], options)).length === 1, "Another scope's metadata was removed"); assert((await journals[index].get(transferIds[index]))?.chunks[0]?.blob.size === 3, "Another scope's Blob was removed"); }
    checks.push("other account and device metadata, transfer Blobs and markers remain isolated");
    await Promise.all(stores.map(store => store.close())); journals.forEach(journal => journal.close());
    const reopened = await openRoomWorkspaceStore({ scope: scopes[1], roomId, sessionId, selfId }, { databaseName: names[0], projectDatabaseName: names[2] }); stores.push(reopened); assert((await reopened.loadDraft(state)).project.participants[0].id === selfId, "Other account did not reopen");
    const retained = await openTransferJournal({ scope: scopes[2], roomId, sessionId, selfId }, { databaseName: names[1] }); journals.push(retained); assert((await retained.get(transferIds[2]))?.chunks[0]?.blob.size === 3, "Device transfer did not reopen"); checks.push("untouched scopes reopen with their original data");
    const expiredStore = await openRoomWorkspaceStore({ scope: scopes[2], roomId, sessionId, selfId }, { databaseName: names[0], projectDatabaseName: names[2] }); stores.push(expiredStore);
    await expiredStore.loadDraft({ ...state, rosterRevision: 2, expiresAt: Date.now() - 1 });
    assert(await clearExpiredRoomMetadata(scopes[2], { roomId, sessionId }, options) === 1, "Expired-only selection deleted the wrong checkpoint count");
    assert((await inspectRoomMetadata(scopes[2], options))[0]?.records === 1, "Active checkpoint was deleted"); checks.push("explicit expired metadata clearing preserves active records and projects");
    return { checks };
  } finally {
    if (release) (release as () => void)(); unregister(); await Promise.all(stores.map(store => store.close())); journals.forEach(journal => journal.close());
    await Promise.all(names.map(name => new Promise<void>((resolve, reject) => { const request = indexedDB.deleteDatabase(name); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); request.onblocked = () => reject(new Error("Cleanup probe database blocked")); })));
  }
}
