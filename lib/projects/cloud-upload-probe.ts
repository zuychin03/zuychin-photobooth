import { openCloudUploadJournal, removeCloudUploadJournalForOwner, type CloudUploadRecord, type CloudUploadJournal } from "./cloud-upload-journal";
import type { CloudJournalProbeRequest, CloudJournalProbeReply } from "../../workers/cloud-journal-probe.worker";

export async function runCloudUploadJournalProbe(): Promise<{ passed: number; checks: string[] }> {
  if (process.env.NODE_ENV !== "development") throw new Error("Development probe unavailable");
  const databaseName = `pb-cloud-journal-probe-${crypto.randomUUID()}`, owner = "11111111-1111-4111-8111-111111111111", other = "22222222-2222-4222-8222-222222222222";
  const journals: CloudUploadJournal[] = [], checks: string[] = [];
  let worker: Worker | undefined;
  const open = async (ownerId: string) => { const journal = await openCloudUploadJournal(ownerId, { databaseName, identity: () => ({ ownerId, epoch: 1 }) }); journals.push(journal); return journal; };
  function record(index: number, ownerId = owner, state: CloudUploadRecord["state"] = "prepared"): CloudUploadRecord {
    const id = `33333333-3333-4333-8333-${String(index).padStart(12, "0")}`;
    return { id, ownerId, projectId: "44444444-4444-4444-8444-444444444444", asset: { id, requestId: id, kind: "photo", mime: "image/png", width: 1, height: 1, bytes: 1, sha256: "a".repeat(64), protection: { kind: "none", id: null } }, state, createdAt: "2026-09-23T00:00:00Z", updatedAt: "2026-09-23T00:00:00Z", reservedUntil: null };
  }
  function check(condition: boolean, name: string) { if (!condition) throw new Error(name); checks.push(name); }
  try {
    const a = await open(owner), b = await open(other);
    await a.put(record(1)); await b.put(record(1, other)); a.close();
    const reopened = await open(owner); check((await reopened.get(record(1).id))?.ownerId === owner, "Close/reopen preserves exact-owner retry IDs");
    for (let i = 2; i <= 64; i++) await reopened.put(record(i, owner, "ready"));
    await reopened.put(record(65)); const retained = await reopened.list();
    check(retained.length === 2 && retained.every(r => r.state === "prepared"), "Only verified-ready tracking is pruned at the 64-record ceiling");
    for (let i = 66; i <= 127; i++) await reopened.put(record(i));
    let capped = false; try { await reopened.put(record(128)); } catch { capped = true; }
    check(capped && (await reopened.list()).length === 64, "Uncertain records are never evicted to make room");
    const writing = reopened.put(record(1, owner, "uploading")).then(() => true, () => false);
    await removeCloudUploadJournalForOwner(owner, { databaseName }); await writing;
    let oldClosed = false; try { await reopened.put(record(129)); } catch { oldClosed = true; }
    check(oldClosed, "Cleanup closes and drains existing writers before deletion");
    const clean = await open(owner); check((await clean.list()).length === 0, "Removed account stays empty after full reopen");
    check((await b.list()).length === 1 && (await b.get(record(1).id))?.ownerId === other, "Cleanup preserves other accounts and their live connections");
    worker = new Worker(new URL("../../workers/cloud-journal-probe.worker.ts", import.meta.url), { type: "module" });
    const send = async (message: CloudJournalProbeRequest): Promise<CloudJournalProbeReply> => {
      const active = worker!;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await new Promise<CloudJournalProbeReply>((resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Independent journal worker timed out")), 15000);
          active.onmessage = event => { const reply = event.data as CloudJournalProbeReply; if (reply.sequence !== message.sequence || reply.type === "error") reject(new Error("Independent journal worker failed")); else resolve(reply); };
          active.onerror = () => reject(new Error("Independent journal worker failed to load"));
          active.onmessageerror = () => reject(new Error("Independent journal worker returned unreadable data"));
          active.postMessage(message);
        });
      } finally { clearTimeout(timer); active.onmessage = active.onerror = active.onmessageerror = null; }
    };
    const opened = await send({ sequence: 1, type: "open", databaseName, owner: record(201), other: record(201, other) });
    check(opened.type === "opened" && (await clean.get(record(201).id))?.ownerId === owner && (await b.get(record(201).id))?.ownerId === other, "Independent worker commits both owners before main-context cleanup");
    await removeCloudUploadJournalForOwner(owner, { databaseName });
    const result = await send({ sequence: 2, type: "check", owner: record(202), other: record(202, other) });
    check(result.type === "checked" && result.staleReadDenied && result.staleWriteDenied, "Main-context cleanup fences already-open worker reads and writes by stored generation");
    check(result.type === "checked" && result.otherRead && result.otherWrite, "Other-owner worker handle remains readable and writable after cleanup");
    worker.terminate(); worker = undefined;
    const afterWorker = await open(owner), otherReopened = await open(other);
    check((await afterWorker.list()).length === 0, "Removed owner stays empty after cross-context writes and full reopen");
    check((await otherReopened.get(record(202).id))?.ownerId === other, "Independent other-owner write survives full reopen");
    return { passed: checks.length, checks };
  } finally {
    worker?.terminate();
    for (const journal of journals) journal.close();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Probe database cleanup timed out")), 5000);
      const request = indexedDB.deleteDatabase(databaseName);
      request.onsuccess = () => { clearTimeout(timer); resolve(); };
      request.onerror = () => { clearTimeout(timer); reject(new Error("Probe database cleanup failed")); };
    });
  }
}
