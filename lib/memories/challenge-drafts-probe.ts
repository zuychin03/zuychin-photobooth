import { openChallengeDraftJournal, type ChallengeDraftInput, type ChallengeDraftJournal } from "./challenge-drafts";
import { CLOUD_JOURNAL_VERSION, openCloudJournalScope, removeCloudJournalForOwner } from "../projects/cloud-journal-db";
import { openCloudUploadJournal, type CloudUploadRecord } from "../projects/cloud-upload-journal";

const owner = "11111111-1111-4111-8111-111111111111", other = "22222222-2222-4222-8222-222222222222";
const id = (n: number) => `33333333-3333-4333-8333-${String(n).padStart(12, "0")}`;
function rawOpen(name: string, version: number, upgrade?: (db: IDBDatabase) => void): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version); let expired = false;
    const timer = setTimeout(() => { expired = true; reject(new Error("Probe database open timed out")); }, 5000);
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
export async function runChallengeDraftsProbe(): Promise<{ passed: number; checks: string[] }> {
  if (process.env.NODE_ENV !== "development") throw new Error("Development probe unavailable");
  const databaseName = `pb-challenge-drafts-probe-${crypto.randomUUID()}`, futureName = `${databaseName}-future`, checks: string[] = [], closers: (() => void)[] = [];
  const options = (ownerId = owner) => ({ databaseName, identity: () => ({ ownerId, epoch: 1 }) });
  const open = async (ownerId = owner): Promise<ChallengeDraftJournal> => { const journal = await openChallengeDraftJournal(ownerId, options(ownerId)); closers.push(journal.close); return journal; };
  const input = (n: number, ownerId = owner): ChallengeDraftInput => ({ id: id(n), projectId: id(1000 + n), kind: "create", challengeId: null, form: { selected: [ownerId, ownerId === owner ? other : owner], layoutId: "duo-alternate", policy: "all_submitted", expiresAt: new Date(Date.now() + 7 * 86400000).toISOString() } });
  function check(ok: boolean, name: string) { if (!ok) throw new Error(name); checks.push(name); }
  async function denied(work: () => Promise<unknown>, code?: string) { try { await work(); return false; } catch (error) { return !code || Boolean(error && typeof error === "object" && "code" in error && error.code === code); } }
  try {
    const legacy = await rawOpen(databaseName, 2, db => { db.createObjectStore("uploads", { keyPath: ["ownerId", "id"] }).createIndex("owner", "ownerId"); db.createObjectStore("generations"); });
    const upload: CloudUploadRecord = { id: id(90), ownerId: owner, projectId: id(91), asset: { id: id(90), requestId: id(90), kind: "photo", mime: "image/png", width: 1, height: 1, bytes: 1, sha256: "a".repeat(64), protection: { kind: "none", id: null } }, state: "prepared", createdAt: "2026-09-23T00:00:00Z", updatedAt: "2026-09-23T00:00:00Z", reservedUntil: null };
    await write(legacy, ["uploads"], tx => tx.objectStore("uploads").put(upload)); legacy.close();
    const a = await open(), b = await open(), foreign = await open(other);
    const uploads = await openCloudUploadJournal(owner, options()); closers.push(uploads.close);
    check((await uploads.get(upload.id))?.asset.sha256 === upload.asset.sha256, "Version 2 upload tracking survives the additive current journal upgrade");
    const initial = await a.saveDraft(input(1), null);
    const race = await Promise.allSettled([a.saveDraft({ ...input(1), form: { ...input(1).form, policy: "immediate" } } as ChallengeDraftInput, initial.revision), b.saveDraft(input(1), initial.revision)]);
    check(race.filter(result => result.status === "fulfilled").length === 1 && (await a.get(initial.id))?.revision === 1, "Two connections cannot overwrite the same draft revision");
    const pending = await a.freezeRequest(initial.id, 1); a.close();
    const reopened = await open(); check(JSON.stringify((await reopened.get(initial.id))?.request) === JSON.stringify(pending.request), "Close and reopen retains the exact frozen request and UUID");
    check(await denied(() => reopened.saveDraft(input(1), pending.revision), "pending") && await denied(() => reopened.forget(initial.id, 0), "conflict"), "Pending payload mutation and stale dismissal both fail closed");
    const guidedInput = input(50); if (guidedInput.kind !== "create") throw new Error("Expected creation fixture");
    const unguided = await reopened.saveDraft(guidedInput, null);
    const story = { version: 1 as const, deckId: "little-hello", seed: 42, relaxedSteps: [1, 3] };
    const guided = await reopened.saveDraft({ ...guidedInput, form: { ...guidedInput.form, story } }, unguided.revision);
    check(unguided.version === 1 && guided.version === 2, "Explicit story selection upgrades only that editable creation draft");
    const guidedPending = await reopened.freezeRequest(guided.id, guided.revision), storyReopen = await open();
    const recovered = await storyReopen.get(guided.id);
    check(recovered?.kind === "create" && JSON.stringify(recovered.request) === JSON.stringify(guidedPending.request) && JSON.stringify(recovered.request?.story) === JSON.stringify(story), "Guided pending requests reopen with exact story seed, alternatives and UUID");
    await storyReopen.forget(guided.id, guidedPending.revision);
    let downgradeDenied = false; try { const old = await rawOpen(databaseName, 2); old.close(); } catch (error) { downgradeDenied = error instanceof DOMException && error.name === "VersionError"; }
    check(downgradeDenied && (await reopened.get(initial.id))?.state === "pending", "Older version 2 cleanup cannot open the upgraded journal or silently leave request drafts");
    const foreignRow = await foreign.saveDraft(input(1, other), null);
    const scope = await openCloudJournalScope(owner, "challengeRequests", options()); closers.push(scope.close);
    check(await denied(() => scope.transaction("readwrite", (store, _done, fail) => { store.put({ ...pending, id: id(99) }); fail(new DOMException("Fixture quota", "QuotaExceededError")); })) && await reopened.get(id(99)) === null, "Native transaction abort rolls back a staged draft write");
    const raw = await rawOpen(databaseName, CLOUD_JOURNAL_VERSION); closers.push(() => raw.close());
    await write(raw, ["challengeRequests"], tx => tx.objectStore("challengeRequests").put({ ...pending, id: id(98), version: 3 }));
    check((await reopened.list()).some(row => row.id === id(98) && "readOnly" in row) && await denied(() => reopened.get(id(98)), "readonly"), "Future request metadata remains read-only and untouched");
    await write(raw, ["challengeRequests"], tx => tx.objectStore("challengeRequests").delete([owner, id(98)]));
    for (let n = 2; n <= 32; n++) await reopened.saveDraft(input(n), null);
    check(await denied(() => reopened.saveDraft(input(33), null), "capacity") && (await reopened.get(initial.id))?.state === "pending", "The 32-request ceiling does not evict uncertain requests");
    const writing = reopened.saveDraft(input(2), 0).then(() => true, () => false);
    await removeCloudJournalForOwner(owner, { databaseName }); await writing;
    check(await denied(() => reopened.list(), "account_changed"), "Exact-account cleanup invalidates existing draft writers");
    const clean = await open(), cleanUploads = await openCloudUploadJournal(owner, options()); closers.push(cleanUploads.close);
    check((await clean.list()).length === 0 && (await cleanUploads.list()).length === 0 && (await foreign.get(foreignRow.id))?.ownerId === other, "Full reopen proves uploads and requests removed together while the other account survives");
    await clean.saveDraft(input(40), null);
    await write(raw, ["generations", "challengeRequests"], tx => { const generations = tx.objectStore("generations"), request = generations.get(owner); request.onsuccess = () => generations.put((request.result ?? 0) + 1, owner); tx.objectStore("challengeRequests").delete([owner, id(40)]); });
    check(await denied(() => clean.saveDraft(input(41), null), "account_changed"), "Persisted generation fences a handle even when cleanup occurs outside its registry");
    const future = await rawOpen(futureName, CLOUD_JOURNAL_VERSION + 1, db => db.createObjectStore("future")); future.close();
    check(await denied(() => openChallengeDraftJournal(owner, { ...options(), databaseName: futureName }), "journal_readonly") && await denied(() => removeCloudJournalForOwner(owner, { databaseName: futureName }), "journal_readonly"), "A future database version refuses both old access and incomplete cleanup");
    return { passed: checks.length, checks };
  } finally {
    for (const close of closers) close();
    for (const name of [databaseName, futureName]) await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name), timer = setTimeout(() => reject(new Error("Probe cleanup timed out")), 5000);
      request.onsuccess = () => { clearTimeout(timer); resolve(); }; request.onerror = () => { clearTimeout(timer); reject(request.error); };
    });
  }
}
