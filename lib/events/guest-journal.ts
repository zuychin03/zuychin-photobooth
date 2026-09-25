import { EVENT_LIMITS, type EventConsent, type EventReceipt } from "./contract";
import { EventClientError, eventClientConsent, eventClientInstant, eventClientObject, eventClientUuid, parseEventReceipt, type EventGuestClient, type EventGuestIdentity } from "./client";
import { EVENT_MISSIONS } from "./guestbook-contract";
import { inspectImageHeader } from "../projects/images";

export const EVENT_GUEST_QUEUE_LIMITS = Object.freeze({ records: 8, bytes: 16_000_000, scopes: 8, lifetimeMs: 86400000, transactionMs: 5000 });
export type EventGuestQueueStage = "prepared" | "reserving" | "reserved" | "uploading" | "uploaded" | "finalising" | "ready" | "failed";
export interface EventGuestImage { sha256: string; mime: "image/jpeg" | "image/png" | "image/webp"; bytes: number; width: number; height: number }
export interface EventGuestRecord {
  version: 1; eventId: string; guestId: string; requestId: string; submissionId: string; revision: number;
  consent: EventConsent; image: EventGuestImage; createdAt: string; expiresAt: string; stage: EventGuestQueueStage;
  missionChoice?: { version: 1; missionId: string | null };
  receipt: EventReceipt | null; keepOnDevice: boolean; blob: Blob | null;
}
export interface EventGuestJournalOptions { databaseName?: string; indexedDB?: IDBFactory; identity(): EventGuestIdentity | null; now?: () => number }
const invalid = (code = "journal_invalid"): never => { throw new EventClientError(code); };
const scopeKey = (eventId: string, guestId: string) => `${eventClientUuid(eventId)}:${eventClientUuid(guestId)}`;
const live = new Map<string, Set<() => void>>();
const cleanupEpochs = new Map<string, number>();
const identityKey = (v: EventGuestIdentity | null) => v ? `${scopeKey(v.eventId, v.guestId)}:${v.epoch}` : null;
const dbName = (options: Pick<EventGuestJournalOptions, "databaseName">) => options.databaseName ?? "pb-event-guest-queue";
const handleKey = (scope: string, options: Pick<EventGuestJournalOptions, "databaseName">) => `${dbName(options)}:${scope}`;
export function validateEventGuestRecord(value: unknown): EventGuestRecord {
  const v = eventClientObject(value, ["version", "eventId", "guestId", "requestId", "submissionId", "revision", "consent", "image", "createdAt", "expiresAt", "stage", "receipt", "keepOnDevice", "blob"], ["missionChoice"]);
  const i = eventClientObject(v.image, ["sha256", "mime", "bytes", "width", "height"]), createdAt = eventClientInstant(v.createdAt), expiresAt = eventClientInstant(v.expiresAt);
  if (v.version !== 1 || !Number.isSafeInteger(v.revision) || (v.revision as number) < 0 || typeof v.keepOnDevice !== "boolean" || !["prepared", "reserving", "reserved", "uploading", "uploaded", "finalising", "ready", "failed"].includes(v.stage as string) || !/^[0-9a-f]{64}$/.test(i.sha256 as string) || !["image/jpeg", "image/png", "image/webp"].includes(i.mime as string) || !Number.isSafeInteger(i.bytes) || (i.bytes as number) < 1 || (i.bytes as number) > EVENT_LIMITS.imageBytes || ![i.width, i.height].every(x => Number.isSafeInteger(x) && (x as number) >= 1 && (x as number) <= 4096) || (i.width as number) * (i.height as number) > 12_000_000 || expiresAt <= createdAt || Date.parse(expiresAt) - Date.parse(createdAt) > EVENT_GUEST_QUEUE_LIMITS.lifetimeMs) return invalid();
  let missionChoice: EventGuestRecord["missionChoice"];
  if (v.missionChoice !== undefined) { const m = eventClientObject(v.missionChoice, ["version", "missionId"]); if (m.version !== 1 || m.missionId !== null && !EVENT_MISSIONS.some(item => item.id === m.missionId)) return invalid(); missionChoice = { version: 1, missionId: m.missionId as string | null }; }
  const submissionId = eventClientUuid(v.submissionId), receipt = v.receipt === null ? null : parseEventReceipt(v.receipt, submissionId), consent = eventClientConsent(v.consent);
  if (!consent.submission || v.blob !== null && (!(v.blob instanceof Blob) || !v.keepOnDevice || v.blob.size !== i.bytes || v.blob.type !== i.mime) || v.keepOnDevice && v.blob === null && v.stage !== "ready" && !(v.stage === "failed" && receipt && ["failed", "expired", "deleted"].includes(receipt.state)) || v.stage === "ready" && (v.blob !== null || receipt?.state !== "ready") || receipt && expiresAt > receipt.eventExpiresAt) return invalid();
  return { ...(missionChoice ? { missionChoice } : {}), version: 1, eventId: eventClientUuid(v.eventId), guestId: eventClientUuid(v.guestId), requestId: eventClientUuid(v.requestId), submissionId, revision: v.revision as number, consent, image: { sha256: i.sha256 as string, mime: i.mime as EventGuestImage["mime"], bytes: i.bytes as number, width: i.width as number, height: i.height as number }, createdAt, expiresAt, stage: v.stage as EventGuestQueueStage, receipt, keepOnDevice: v.keepOnDevice, blob: v.blob as Blob | null };
}
const immutable = (r: EventGuestRecord) => JSON.stringify([r.eventId, r.guestId, r.requestId, r.submissionId, r.consent, r.image, r.createdAt, r.expiresAt, r.keepOnDevice, r.missionChoice ?? null]);
const transitions: Record<EventGuestQueueStage, readonly EventGuestQueueStage[]> = {
  prepared: ["reserving"], reserving: ["reserving", "reserved", "ready", "failed"], reserved: ["reserving", "reserved", "uploading", "finalising", "ready", "failed"], uploading: ["uploading", "uploaded", "finalising", "ready", "failed"], uploaded: ["uploaded", "finalising", "ready", "failed"], finalising: ["finalising", "uploading", "ready", "failed"], ready: ["ready", "failed"], failed: ["reserving", "uploading", "finalising", "ready", "failed"],
};
export function nextEventGuestRecord(current: EventGuestRecord, patch: { stage: EventGuestQueueStage; receipt?: EventReceipt }, now: number): EventGuestRecord {
  const old = validateEventGuestRecord(current); eventClientObject(patch, ["stage"], ["receipt"]);
  if (!Number.isFinite(now) || now >= Date.parse(old.expiresAt)) invalid("queue_expired");
  if (!transitions[old.stage].includes(patch.stage)) invalid("conflict");
  const receipt = patch.receipt ? parseEventReceipt(patch.receipt, old.submissionId) : old.receipt;
  if (old.receipt && receipt && (old.receipt.logicalExpiresAt !== receipt.logicalExpiresAt || receipt.eventExpiresAt < old.receipt.eventExpiresAt)) invalid("conflict");
  return validateEventGuestRecord({ ...old, revision: old.revision + 1, stage: patch.stage, receipt, blob: patch.stage === "ready" ? null : old.blob });
}
interface GuestScope { generation: string; expiresAt: number }
function scopeValue(value: unknown): GuestScope {
  const v = eventClientObject(value, ["generation", "expiresAt"]);
  if (typeof v.generation !== "string" || !Number.isSafeInteger(v.expiresAt) || (v.expiresAt as number) < 0) return invalid();
  return { generation: eventClientUuid(v.generation), expiresAt: v.expiresAt as number };
}
function housekeeping(tx: IDBTransaction, now: number, preserve: string, done: () => void, fail: (e: unknown) => void) {
  const records = tx.objectStore("records"), scopes = tx.objectStore("scopes"), request = records.getAll(undefined, 9);
  request.onsuccess = () => { try {
    if (request.result.length > EVENT_GUEST_QUEUE_LIMITS.records) invalid();
    const all = request.result.map(validateEventGuestRecord), retained = all.filter(r => Date.parse(r.expiresAt) > now);
    const keys = scopes.getAllKeys(undefined, 9), values = scopes.getAll(undefined, 9);
    values.onsuccess = () => { try {
      if (values.result.length > EVENT_GUEST_QUEUE_LIMITS.scopes || keys.result.length !== values.result.length) invalid();
      const checked = values.result.map(scopeValue);
      for (const r of all) if (Date.parse(r.expiresAt) <= now) records.delete(r.submissionId);
      checked.forEach((scope, index) => { const key = keys.result[index]; if (key !== preserve && scope.expiresAt <= now && !retained.some(r => scopeKey(r.eventId, r.guestId) === key)) scopes.delete(key); });
      done();
    } catch (e) { fail(e); } };
  } catch (e) { fail(e); } };
}
function openDatabase(options: Pick<EventGuestJournalOptions, "databaseName" | "indexedDB" | "now">): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = (options.indexedDB ?? indexedDB).open(dbName(options), 3); let expired = false;
    const timer = setTimeout(() => { expired = true; reject(new EventClientError("journal_blocked")); }, 5000);
    req.onupgradeneeded = () => {
      if (expired) { req.transaction?.abort(); return; }
      if (!req.result.objectStoreNames.contains("records")) req.result.createObjectStore("records", { keyPath: "submissionId" }).createIndex("scope", ["eventId", "guestId"]);
      if (!req.result.objectStoreNames.contains("scopes")) req.result.createObjectStore("scopes");
      const cursor = req.transaction!.objectStore("scopes").openCursor();
      cursor.onsuccess = () => { const item = cursor.result; if (!item) return; if (typeof item.value === "string") item.update({ generation: item.value, expiresAt: (options.now ?? Date.now)() + EVENT_GUEST_QUEUE_LIMITS.lifetimeMs }); item.continue(); };
    };
    req.onerror = () => { clearTimeout(timer); reject(new EventClientError("journal_unavailable")); };
    req.onsuccess = () => { clearTimeout(timer); if (expired) req.result.close(); else resolve(req.result); };
  });
}
function transaction<T>(db: IDBDatabase, mode: IDBTransactionMode, work: (tx: IDBTransaction, done: (v: T) => void, fail: (e: unknown) => void) => void, transactions?: Set<IDBTransaction>): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["records", "scopes"], mode); transactions?.add(tx); let result: T, error: unknown;
    const fail = (e: unknown) => { error = e; try { tx.abort(); } catch { reject(e); } };
    const timer = setTimeout(() => fail(new EventClientError("journal_unavailable")), 5000);
    tx.oncomplete = () => { clearTimeout(timer); transactions?.delete(tx); resolve(result); };
    tx.onabort = tx.onerror = () => { clearTimeout(timer); transactions?.delete(tx); reject(error ?? new EventClientError("journal_unavailable")); };
    try { work(tx, v => { result = v; }, fail); } catch (e) { fail(e); }
  });
}
export async function clearEventGuestJournal(eventId: string, guestId: string, options: Pick<EventGuestJournalOptions, "databaseName" | "indexedDB"> = {}): Promise<void> {
  const key = scopeKey(eventId, guestId), handle = handleKey(key, options); cleanupEpochs.set(handle, (cleanupEpochs.get(handle) ?? 0) + 1); for (const close of [...live.get(handle) ?? []]) close();
  const db = await openDatabase(options);
  try { await transaction<void>(db, "readwrite", (tx, done) => { tx.objectStore("scopes").delete(key); const req = tx.objectStore("records").index("scope").openCursor(IDBKeyRange.only([eventId, guestId])); req.onsuccess = () => { const cursor = req.result; if (cursor) { cursor.delete(); cursor.continue(); } else done(); }; }); } finally { db.close(); }
}
export async function openEventGuestJournal(options: EventGuestJournalOptions) {
  const initial = options.identity(); if (!initial || !Number.isSafeInteger(initial.epoch) || initial.epoch < 0) return invalid("identity_changed");
  const { eventId, guestId } = initial, key = scopeKey(eventId, guestId), initialKey = identityKey(initial), now = options.now ?? Date.now, handle = handleKey(key, options), cleanupEpoch = cleanupEpochs.get(handle) ?? 0;
  let closed = false; const transactions = new Set<IDBTransaction>();
  function active(signal?: AbortSignal) { if (closed || identityKey(options.identity()) !== initialKey || (cleanupEpochs.get(handle) ?? 0) !== cleanupEpoch) invalid("identity_changed"); if (signal?.aborted) invalid("cancelled"); }
  const db = await openDatabase(options); try { active(); } catch (error) { db.close(); throw error; }
  function close() { closed = true; for (const tx of transactions) { try { tx.abort(); } catch { /* Already committed. */ } } db.close(); const handles = live.get(handleKey(key, options)); handles?.delete(close); if (!handles?.size) live.delete(handleKey(key, options)); }
  if (!live.has(handleKey(key, options))) live.set(handleKey(key, options), new Set()); live.get(handleKey(key, options))!.add(close); db.onversionchange = close;
  let generation: string;
  try { generation = await transaction<string>(db, "readwrite", (tx, done, fail) => {
    housekeeping(tx, now(), "", () => {
      const scopes = tx.objectStore("scopes"), req = scopes.get(key);
      req.onsuccess = () => { try { active(); if (req.result !== undefined) { const current = scopeValue(req.result); scopes.put({ ...current, expiresAt: Math.max(current.expiresAt, now() + EVENT_GUEST_QUEUE_LIMITS.lifetimeMs) }, key); done(current.generation); } else { const count = scopes.count(); count.onsuccess = () => { try { active(); if (count.result >= EVENT_GUEST_QUEUE_LIMITS.scopes) return invalid("queue_capacity"); const id = crypto.randomUUID(); scopes.put({ generation: id, expiresAt: now() + EVENT_GUEST_QUEUE_LIMITS.lifetimeMs }, key); done(id); } catch (e) { fail(e); } }; } } catch (e) { fail(e); } };
    }, fail);
  }, transactions); active(); } catch (error) { close(); throw error; }
  async function scoped<T>(mode: IDBTransactionMode, work: (records: IDBObjectStore, done: (v: T) => void, fail: (e: unknown) => void, tx: IDBTransaction) => void): Promise<T> {
    active(); const result = await transaction<T>(db, mode, (tx, done, fail) => { const req = tx.objectStore("scopes").get(key); req.onsuccess = () => { try { active(); if (req.result === undefined || scopeValue(req.result).generation !== generation) invalid("identity_changed"); work(tx.objectStore("records"), done, fail, tx); } catch (e) { fail(e); } }; }, transactions); active(); return result;
  }
  const checked = (value: unknown) => { const r = validateEventGuestRecord(value); if (r.eventId !== eventId || r.guestId !== guestId) invalid("identity_changed"); return r; };
  async function purgeExpired(): Promise<number> { return scoped("readwrite", (store, done, fail) => { let count = 0; const req = store.index("scope").openCursor(IDBKeyRange.only([eventId, guestId])); req.onsuccess = () => { try { const cursor = req.result; if (!cursor) return done(count); const record = checked(cursor.value); if (Date.parse(record.expiresAt) <= now()) { cursor.delete(); count++; } cursor.continue(); } catch (e) { fail(e); } }; }); }
  let preparing = false;
  const journal = {
    eventId, guestId, close, assertActive: active, purgeExpired,
    async list(): Promise<EventGuestRecord[]> { await purgeExpired(); return scoped("readonly", (store, done, fail) => { const req = store.index("scope").getAll(IDBKeyRange.only([eventId, guestId]), 9); req.onsuccess = () => { try { if (req.result.length > 8) invalid(); done(req.result.map(checked)); } catch (e) { fail(e); } }; }); },
    async get(submissionId: string): Promise<EventGuestRecord | null> { eventClientUuid(submissionId); await purgeExpired(); return scoped("readonly", (store, done, fail) => { const req = store.get(submissionId); req.onsuccess = () => { try { done(req.result === undefined ? null : checked(req.result)); } catch (e) { fail(e); } }; }); },
    async prepare(input: { requestId: string; submissionId: string; consent: EventConsent; blob: Blob; keepOnDevice: boolean; eventExpiresAt: string; missionChoice?: EventGuestRecord["missionChoice"] }, signal?: AbortSignal): Promise<EventGuestRecord> {
      active(signal); eventClientObject(input, ["requestId", "submissionId", "consent", "blob", "keepOnDevice", "eventExpiresAt"], ["missionChoice"]);
      if (preparing) return invalid("busy"); preparing = true;
      try {
      input = { ...input, requestId: eventClientUuid(input.requestId), submissionId: eventClientUuid(input.submissionId), consent: eventClientConsent(input.consent), eventExpiresAt: eventClientInstant(input.eventExpiresAt) };
      if (!(input.blob instanceof Blob) || input.blob.size < 1 || input.blob.size > EVENT_LIMITS.imageBytes || typeof input.keepOnDevice !== "boolean") invalid();
      const bytes = new Uint8Array(await input.blob.arrayBuffer()); active(signal); const info = inspectImageHeader(bytes), sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(x => x.toString(16).padStart(2, "0")).join(""); active(signal);
      const createdAt = new Date(now()).toISOString(), expiresAt = new Date(Math.min(now() + EVENT_GUEST_QUEUE_LIMITS.lifetimeMs, Date.parse(eventClientInstant(input.eventExpiresAt)))).toISOString();
      const record = checked({ ...(input.missionChoice ? { missionChoice: input.missionChoice } : {}), version: 1, eventId, guestId, requestId: input.requestId, submissionId: input.submissionId, revision: 0, consent: input.consent, image: { ...info, sha256, bytes: bytes.length }, createdAt, expiresAt, stage: "prepared", receipt: null, keepOnDevice: input.keepOnDevice, blob: input.keepOnDevice ? input.blob.slice(0, input.blob.size, info.mime) : null });
      await purgeExpired(); active(signal);
      return await scoped("readwrite", (store, done, fail, tx) => { housekeeping(tx, now(), key, () => { const req = store.getAll(undefined, 9); req.onsuccess = () => { try { active(signal); const all = req.result.map(validateEventGuestRecord), existing = all.find(r => r.submissionId === record.submissionId || r.requestId === record.requestId);
        if (existing) { const retry = { ...record, createdAt: existing.createdAt, expiresAt: existing.expiresAt }; if (immutable(existing) !== immutable(retry)) invalid("conflict"); return done(checked(existing)); }
        if (all.length >= EVENT_GUEST_QUEUE_LIMITS.records || all.reduce((n, r) => n + (r.blob?.size ?? 0), 0) + (record.blob?.size ?? 0) > EVENT_GUEST_QUEUE_LIMITS.bytes) invalid("queue_capacity"); store.add(record); tx.objectStore("scopes").put({ generation, expiresAt: now() + EVENT_GUEST_QUEUE_LIMITS.lifetimeMs }, key); done(record);
      } catch (e) { fail(e); } }; }, fail); });
      } finally { preparing = false; }
    },
    async update(submissionId: string, expectedRevision: number, patch: { stage: EventGuestQueueStage; receipt?: EventReceipt }): Promise<EventGuestRecord> {
      eventClientUuid(submissionId); return scoped("readwrite", (store, done, fail) => { const req = store.get(submissionId); req.onsuccess = () => { try { const old = checked(req.result); if (old.revision !== expectedRevision) invalid("conflict"); const next = nextEventGuestRecord(old, patch, now()); store.put(next); done(next); } catch (e) { fail(e); } }; });
    },
    async remove(submissionId: string): Promise<void> { eventClientUuid(submissionId); return scoped("readwrite", (store, done, fail) => { const req = store.get(submissionId); req.onsuccess = () => { try { if (req.result !== undefined) checked(req.result); store.delete(submissionId); done(); } catch (e) { fail(e); } }; }); },
  };
  try { await purgeExpired(); return journal; } catch (e) { close(); throw e; }
}
export type EventGuestJournal = Awaited<ReturnType<typeof openEventGuestJournal>>;
export async function matchEventGuestImage(record: EventGuestRecord, blob: Blob): Promise<void> {
  const r = validateEventGuestRecord(record); if (blob.size !== r.image.bytes || blob.size > EVENT_LIMITS.imageBytes) invalid("image_mismatch");
  const bytes = new Uint8Array(await blob.arrayBuffer()), info = inspectImageHeader(bytes), digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(x => x.toString(16).padStart(2, "0")).join("");
  if (digest !== r.image.sha256 || info.mime !== r.image.mime || info.width !== r.image.width || info.height !== r.image.height) invalid("image_mismatch");
}
export async function reserveEventGuestRecord(journal: EventGuestJournal, client: EventGuestClient, submissionId: string, signal?: AbortSignal) {
  journal.assertActive(signal); client.assertActive(signal); if (client.eventId !== journal.eventId || client.guestId !== journal.guestId) invalid("identity_changed");
  const current = await journal.get(submissionId); if (!current) return invalid("not_found");
  const marked = await journal.update(submissionId, current.revision, { stage: "reserving" }); journal.assertActive(signal); client.assertActive(signal);
  const result = await reserveRecord(client, marked, signal);
  journal.assertActive(signal); client.assertActive(signal); await journal.update(submissionId, marked.revision, { stage: result.receipt.state === "ready" ? "ready" : "reserved", receipt: result.receipt }); return result;
}
export async function uploadEventGuestRecord(journal: EventGuestJournal, client: EventGuestClient, submissionId: string, selected?: Blob, signal?: AbortSignal): Promise<EventReceipt> {
  const check = () => { journal.assertActive(signal); client.assertActive(signal); if (client.eventId !== journal.eventId || client.guestId !== journal.guestId) invalid("identity_changed"); }; check();
  let current = await journal.get(submissionId); if (!current) return invalid("not_found");
  if (["prepared", "reserving"].includes(current.stage)) return invalid("reservation_required");
  if (current.stage === "ready") return current.receipt!;
  if (current.receipt && ["failed", "expired", "deleted"].includes(current.receipt.state)) return invalid("source_unavailable");
  if (!["uploaded", "finalising"].includes(current.stage)) {
    const blob = selected ?? current.blob; if (!blob) return invalid("original_required"); await matchEventGuestImage(current, blob); check();
    current = await journal.update(submissionId, current.revision, { stage: "uploading" }); check(); const grant = await client.mintUpload(submissionId, signal); check();
    const uploaded = await client.upload(submissionId, blob, grant, signal); check();
    if (uploaded.acknowledged) current = await journal.update(submissionId, current.revision, { stage: "uploaded" });
  }
  current = await journal.update(submissionId, current.revision, { stage: "finalising" }); check();
  const receipt = await client.finalise(submissionId, signal); check();
  await journal.update(submissionId, current.revision, { stage: receipt.state === "ready" ? "ready" : "finalising", receipt }); return receipt;
}
export async function refreshEventGuestRecord(journal: EventGuestJournal, client: EventGuestClient, submissionId: string, signal?: AbortSignal): Promise<EventReceipt> {
  journal.assertActive(signal); client.assertActive(signal); if (client.eventId !== journal.eventId || client.guestId !== journal.guestId) return invalid("identity_changed");
  const current = await journal.get(submissionId); if (!current || current.stage === "prepared") return invalid("not_found");
  const result = await reserveRecord(client, current, signal); journal.assertActive(signal); client.assertActive(signal);
  const stage = result.receipt.state === "ready" ? "ready" : ["failed", "expired", "deleted"].includes(result.receipt.state) ? "failed" : current.stage === "reserving" ? "reserved" : current.stage;
  await journal.update(submissionId, current.revision, { stage, receipt: result.receipt }); return result.receipt;
}

function reserveRecord(client: EventGuestClient, record: EventGuestRecord, signal?: AbortSignal) {
  const input = { submissionId: record.submissionId, requestId: record.requestId, consent: record.consent };
  return record.missionChoice ? client.reserveMission({ ...input, missionId: record.missionChoice.missionId }, signal) : client.reserve(input, signal);
}
