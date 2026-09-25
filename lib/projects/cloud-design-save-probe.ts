import { openCloudDesignJournal, validateDesignSaveRecord, type CloudDesignSaveRecord } from "./cloud-design-journal";
import { CLOUD_JOURNAL_VERSION, openCloudJournalScope, removeCloudJournalForOwner } from "./cloud-journal-db";
import { createProject } from "./model";

const owner = "11111111-1111-4111-8111-111111111111", other = "22222222-2222-4222-8222-222222222222";
const id = (n: number) => `33333333-3333-4333-8333-${String(n).padStart(12, "0")}`;
function openRaw(name: string, version: number, upgrade?: (db: IDBDatabase) => void): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version); let expired = false;
    const timer = setTimeout(() => { expired = true; reject(new Error("Probe open timed out")); }, 5000);
    request.onupgradeneeded = () => { if (expired) request.transaction?.abort(); else upgrade?.(request.result); };
    request.onerror = () => { clearTimeout(timer); reject(request.error); };
    request.onsuccess = () => { clearTimeout(timer); if (expired) request.result.close(); else resolve(request.result); };
  });
}
function write(db: IDBDatabase, names: string[], work: (tx: IDBTransaction) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(names, "readwrite"), timer = setTimeout(() => tx.abort(), 5000);
    tx.oncomplete = () => { clearTimeout(timer); resolve(); };
    tx.onabort = tx.onerror = () => { clearTimeout(timer); reject(tx.error ?? new Error("Probe transaction aborted")); };
    work(tx);
  });
}
export async function runCloudDesignSaveProbe(): Promise<{ passed: number; checks: string[] }> {
  if (process.env.NODE_ENV !== "development") throw new Error("Development probe unavailable");
  const databaseName = `pb-design-save-probe-${crypto.randomUUID()}`, futureName = `${databaseName}-future`, checks: string[] = [], closers: (() => void)[] = [];
  const options = (ownerId = owner) => ({ databaseName, identity: () => ({ ownerId, epoch: 1 }) });
  const record = (n: number, ownerId = owner): CloudDesignSaveRecord => {
    const project = createProject({ id: `local-${n}`, scope: { kind: "device" }, participants: [{ id: "person", role: "A" }] });
    return validateDesignSaveRecord({ version: 1, id: id(n), ownerId, localProjectId: project.id, cloudProjectId: id(1000 + n), revision: 0, createdAt: project.createdAt, updatedAt: project.updatedAt, phase: "prepared", requestId: id(2000 + n), expectedRevision: null, project, participants: [{ participantId: "person", ownerId }], bindings: [], uploads: [], receipt: null });
  };
  const check = (ok: boolean, name: string) => { if (!ok) throw new Error(name); checks.push(name); };
  const denied = async (work: () => Promise<unknown>, code?: string) => { try { await work(); return false; } catch (error) { return !code || Boolean(error && typeof error === "object" && "code" in error && error.code === code); } };
  try {
    const legacy = await openRaw(databaseName, 3, db => { for (const name of ["uploads", "challengeRequests"]) db.createObjectStore(name, { keyPath: ["ownerId", "id"] }).createIndex("owner", "ownerId"); db.createObjectStore("generations"); });
    await write(legacy, ["uploads", "challengeRequests"], tx => { for (const name of ["uploads", "challengeRequests"]) for (const ownerId of [owner, other]) tx.objectStore(name).put({ id: id(90), ownerId, marker: name }); }); legacy.close();
    const a = await openCloudDesignJournal(owner, options()), b = await openCloudDesignJournal(owner, options()), foreign = await openCloudDesignJournal(other, options(other)); closers.push(a.close, b.close, foreign.close);
    for (const name of ["uploads", "challengeRequests"] as const) {
      const scope = await openCloudJournalScope(owner, name, options()); closers.push(scope.close);
      const retained = await scope.transaction<unknown>("readonly", (store, done) => { const request = store.get([owner, id(90)]); request.onsuccess = () => done(request.result); });
      check(Boolean(retained), `Version 3 ${name} survives the additive version 4 upgrade`);
    }
    let downgrade = false; try { const old = await openRaw(databaseName, 3); old.close(); } catch (error) { downgrade = error instanceof DOMException && error.name === "VersionError"; }
    check(downgrade, "Older version 3 cleanup cannot silently ignore design and voice records");
    const initial = await a.put(record(1), null);
    const race = await Promise.allSettled([a.put({ ...initial, revision: 1, phase: "uploading" }, 0), b.put({ ...initial, revision: 1, phase: "uploading" }, 0)]);
    check(race.filter(result => result.status === "fulfilled").length === 1, "Two connections preserve one exact journal revision winner");
    a.close(); const reopened = await openCloudDesignJournal(owner, options()); closers.push(reopened.close);
    const frozen = (await reopened.get(initial.id))!;
    check(frozen.requestId === initial.requestId && frozen.revision === 1, "Close and reopen retains the frozen request and canonical project");
    check(await denied(() => reopened.put({ ...frozen, revision: 2, requestId: id(999) }, 1), "pending"), "An unresolved save cannot silently acquire a new request identity");
    const scope = await openCloudJournalScope(owner, "designSaves", options()); closers.push(scope.close);
    check(await denied(() => scope.transaction("readwrite", (store, _done, fail) => { store.put(record(99)); fail(new DOMException("Fixture quota", "QuotaExceededError")); })) && await reopened.get(id(99)) === null, "An aborted native transaction leaves no partial save record");
    const raw = await openRaw(databaseName, CLOUD_JOURNAL_VERSION); closers.push(() => raw.close());
    await write(raw, ["designSaves"], tx => tx.objectStore("designSaves").put({ ...record(98), version: 2 }));
    check((await reopened.list()).some(item => item.id === id(98) && "readOnly" in item) && await denied(() => reopened.get(id(98)), "readonly"), "Future save metadata remains read-only");
    await write(raw, ["designSaves"], tx => tx.objectStore("designSaves").delete([owner, id(98)]));
    for (let n = 2; n <= 32; n++) await reopened.put(record(n), null);
    check(await denied(() => reopened.put(record(33), null), "capacity") && (await reopened.get(initial.id))?.requestId === initial.requestId, "The 32-record ceiling never evicts unresolved saves");
    await foreign.put(record(1, other), null);
    await write(raw, ["voiceDrafts"], tx => { for (const ownerId of [owner, other]) tx.objectStore("voiceDrafts").put({ id: id(90), ownerId, marker: "voice" }); });
    const removed = await removeCloudJournalForOwner(owner, { databaseName });
    check(removed.removed === 35 && await denied(() => b.list(), "account_changed"), "Explicit account cleanup removes all four record kinds and closes old writers");
    const fresh = await openCloudDesignJournal(owner, options()); closers.push(fresh.close);
    check((await fresh.list()).length === 0 && (await foreign.list()).length === 1, "Reopening confirms deletion without affecting the other account");
    for (const name of ["uploads", "challengeRequests", "voiceDrafts"] as const) {
      const foreignScope = await openCloudJournalScope(other, name, options(other)); closers.push(foreignScope.close);
      const retained = await foreignScope.transaction<unknown>("readonly", (store, done) => { const request = store.get([other, id(90)]); request.onsuccess = () => done(request.result); });
      check(Boolean(retained), `Other-account ${name} remains intact`);
    }
    const future = await openRaw(futureName, CLOUD_JOURNAL_VERSION + 1); future.close();
    check(await denied(() => removeCloudJournalForOwner(owner, { databaseName: futureName }), "journal_readonly"), "Unknown future journal versions refuse incomplete cleanup");
    return { passed: checks.length, checks };
  } finally {
    for (const close of closers) close();
    for (const name of [databaseName, futureName]) await new Promise<void>((resolve, reject) => { const request = indexedDB.deleteDatabase(name); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); request.onblocked = () => reject(new Error("Probe cleanup blocked")); });
  }
}
