import { clearEventGuestJournal, matchEventGuestImage, openEventGuestJournal, type EventGuestJournal } from "./guest-journal";
import type { EventJournalProbeRequest, EventJournalProbeReply } from "../../workers/event-guest-journal-probe.worker";

export async function runEventGuestJournalProbe(): Promise<{ passed: number; checks: string[] }> {
  if (process.env.NODE_ENV !== "development") throw new Error("Development probe unavailable");
  const databaseName = `pb-event-journal-probe-${crypto.randomUUID()}`, eventId = crypto.randomUUID(), guestId = crypto.randomUUID(), otherGuest = crypto.randomUUID(), handles: EventGuestJournal[] = [], checks: string[] = [];
  let clock = Date.now(), epoch = 1, worker: Worker | undefined;
  const check = (value: unknown, name: string) => { if (!value) throw new Error(name); checks.push(name); };
  const open = async (guest = guestId) => { const handle = await openEventGuestJournal({ databaseName, identity: () => ({ eventId, guestId: guest, epoch }), now: () => clock }); handles.push(handle); return handle; };
  const canvas = document.createElement("canvas"); canvas.width = 16; canvas.height = 24; const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("Canvas unavailable"); ctx.fillStyle = "#d55e78"; ctx.fillRect(0, 0, 16, 24);
  try {
    await new Promise<void>((resolve, reject) => { const req = indexedDB.open(databaseName, 1); req.onupgradeneeded = () => { req.result.createObjectStore("records", { keyPath: "submissionId" }).createIndex("scope", ["eventId", "guestId"]); req.result.createObjectStore("scopes").put(crypto.randomUUID(), `${eventId}:${guestId}`); }; req.onsuccess = () => { req.result.close(); resolve(); }; req.onerror = () => reject(new Error("Legacy journal setup failed")); });
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("PNG unavailable")), "image/png"));
    const input = (retain: boolean) => ({ requestId: crypto.randomUUID(), submissionId: crypto.randomUUID(), consent: { submission: true, gallery: false, wall: false }, blob, keepOnDevice: retain, eventExpiresAt: new Date(clock + 86400000).toISOString() });
    const a = await open(), b = await open(otherGuest), first = input(false), retained = { ...input(true), missionChoice: { version: 1 as const, missionId: "same-energy-1" } };
    const legacyDenied = await new Promise<boolean>(resolve => { const req = indexedDB.open(databaseName, 2); req.onerror = () => resolve(req.error?.name === "VersionError"); req.onsuccess = () => { req.result.close(); resolve(false); }; });
    check(legacyDenied, "Legacy journal upgrades without replacing records; pre-mission clients cannot reopen it");
    check((await a.prepare(first)).blob === null, "Default queue stores metadata without original bytes");
    const saved = await a.prepare(retained); check(saved.blob?.size === blob.size, "Explicit device retention preserves the encoded PNG"); a.close();
    const reopened = await open(), loaded = await reopened.get(saved.submissionId); if (!loaded?.blob) throw new Error("Original was lost"); await matchEventGuestImage(loaded, loaded.blob); check(loaded.image.sha256 === saved.image.sha256, "Close/reopen retains exact original digest and request identity");
    check(loaded.missionChoice?.missionId === "same-energy-1" && loaded.expiresAt === saved.expiresAt, "Remount preserves immutable mission choice and original expiry");
    let missionChanged = false; try { await reopened.prepare({ ...retained, missionChoice: { version: 1, missionId: null } }); } catch { missionChanged = true; } check(missionChanged, "A queued mission cannot change to none after reservation intent");
    check((await reopened.get(first.submissionId))?.missionChoice === undefined, "Legacy records remain on their original non-mission reservation path");
    const repeated = await reopened.prepare(retained); check(repeated.requestId === saved.requestId && (await reopened.list()).length === 2, "Exact repeated prepare does not add a second record");
    let rebound = false; try { await reopened.prepare({ ...retained, consent: { ...retained.consent, gallery: true } }); } catch { rebound = true; } check(rebound, "A queued request cannot be rebound to changed consent");
    const concurrent = await Promise.allSettled([reopened.update(saved.submissionId, 0, { stage: "reserving" }), reopened.update(saved.submissionId, 0, { stage: "reserving" })]); check(concurrent.filter(x => x.status === "fulfilled").length === 1, "Concurrent stale revisions cannot overwrite each other");
    const other = await b.prepare(input(true)); for (let n = 0; n < 5; n++) await reopened.prepare(input(false));
    let capped = false; try { await reopened.prepare(input(false)); } catch { capped = true; } check(capped && (await reopened.list()).length === 7, "The eight-record device cap preserves all uncertain records");
    await clearEventGuestJournal(eventId, guestId, { databaseName }); let denied = false; try { await reopened.prepare(input(false)); } catch { denied = true; } check(denied, "Exact guest cleanup closes stale writers before deletion");
    check((await b.get(other.submissionId))?.blob?.size === blob.size, "Guest turnover preserves another guest's separately scoped queue");
    const clean = await open(); check((await clean.list()).length === 0, "Reopening a cleared guest cannot resurrect previous records");
    worker = new Worker(new URL("../../workers/event-guest-journal-probe.worker.ts", import.meta.url), { type: "module" });
    const send = (message: EventJournalProbeRequest) => new Promise<EventJournalProbeReply>((resolve, reject) => {
      const active = worker!, finish = () => { clearTimeout(timer); active.onmessage = active.onerror = active.onmessageerror = null; }, timer = setTimeout(() => { finish(); reject(new Error("Independent event journal worker timed out")); }, 15000);
      active.onmessage = event => { finish(); const reply = event.data as EventJournalProbeReply; if (reply.sequence !== message.sequence || reply.type === "error") reject(new Error("Independent event journal worker failed")); else resolve(reply); };
      active.onerror = active.onmessageerror = () => { finish(); reject(new Error("Independent event journal worker failed")); }; active.postMessage(message);
    });
    await send({ sequence: 1, type: "open", databaseName, eventId, guestId, otherGuest, otherSubmission: other.submissionId });
    await clearEventGuestJournal(eventId, guestId, { databaseName }); const next = await open();
    const independent = await send({ sequence: 2, type: "check", submissionId: saved.submissionId });
    check(independent.type === "checked" && independent.staleReadDenied && independent.staleWriteDenied, "A separate worker's stale generation cannot read or delete after replacement");
    check(independent.type === "checked" && independent.otherRead && independent.otherWrite, "Another guest's worker handle remains usable after exact cleanup");
    worker.terminate(); worker = undefined;
    await next.prepare(input(true)); epoch++; let changed = false; try { await next.list(); } catch { changed = true; } check(changed, "Session epoch change immediately fences an old handle");
    const expires = await open(); clock = Math.max(clock + 86400001, Date.now() + 86400001); check((await expires.list()).length === 0, "Expired local queue bytes are removed before showing another session");
    const keepGuest = crypto.randomUUID(), keeper = await open(keepGuest), scopeGuests = Array.from({ length: 7 }, () => crypto.randomUUID()), scopeHandles: EventGuestJournal[] = [];
    await keeper.prepare(input(true));
    for (const guest of scopeGuests) { const handle = await open(guest); scopeHandles.push(handle); await handle.prepare(input(true)); }
    let fullScopes = false; try { await open(crypto.randomUUID()); } catch { fullScopes = true; }
    check(fullScopes, "Eight non-expired guest scopes and their photos are never evicted for a ninth");
    clock += 43200000;
    const previous = (await keeper.list())[0]; await keeper.remove(previous.submissionId); const kept = await keeper.prepare(input(true));
    worker = new Worker(new URL("../../workers/event-guest-journal-probe.worker.ts", import.meta.url), { type: "module" });
    await send({ sequence: 3, type: "open", databaseName, eventId, guestId: scopeGuests[0], otherGuest: keepGuest, otherSubmission: kept.submissionId });
    let releaseBytes!: () => void; const delayed = new Promise<void>(resolve => { releaseBytes = resolve; });
    class SlowBlob extends Blob { async arrayBuffer() { await delayed; return super.arrayBuffer(); } }
    const late = scopeHandles[0].prepare({ ...input(true), blob: new SlowBlob([blob], { type: blob.type }) }).then(() => false, () => true);
    clock += 43200001;
    const newcomer = await open(crypto.randomUUID());
    releaseBytes(); check(await late, "An in-flight old-generation prepare cannot resurrect a scope retired during hashing");
    const retired = await send({ sequence: 4, type: "check", submissionId: saved.submissionId });
    check(retired.type === "checked" && retired.staleReadDenied && retired.staleWriteDenied && retired.otherRead && retired.otherWrite, "Expiry retirement fences an independent worker while preserving its unexpired guest handle");
    worker.terminate(); worker = undefined;
    check((await keeper.get(kept.submissionId))?.blob?.size === blob.size, "Global expiry housekeeping preserves another guest's non-expired retained photo");
    check((await newcomer.list()).length === 0, "Expired foreign bytes and empty scopes release capacity without exposing their records");
    let stale = false; try { await scopeHandles[1].list(); } catch { stale = true; }
    const replacement = await open(scopeGuests[1]);
    check(stale && (await replacement.list()).length === 0, "Recreated expired scopes use fresh generations and reject old handles");
    return { passed: checks.length, checks };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : error instanceof Error ? error.message : "unknown failure";
    throw new Error(`Guest journal check failed after ${checks.at(-1) ?? "initial setup"}: ${code}`);
  } finally {
    worker?.terminate(); canvas.width = canvas.height = 0; for (const handle of handles) handle.close();
    await new Promise<void>((resolve, reject) => { const request = indexedDB.deleteDatabase(databaseName), timer = setTimeout(() => reject(new Error("Probe database cleanup blocked")), 5000); request.onsuccess = () => { clearTimeout(timer); resolve(); }; request.onerror = () => { clearTimeout(timer); reject(new Error("Probe database cleanup failed")); }; });
  }
}
