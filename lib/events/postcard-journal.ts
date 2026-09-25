import { EventClientError, eventClientConsent, eventClientInstant, eventClientObject, eventClientUuid, parseEventReceipt, type EventGuestClient } from "./client";
import { parsePostcardCandidate, parsePostcardProposal, type PostcardCandidate, type PostcardProposal } from "./postcard-contract";
import type { EventConsent, EventReceipt } from "./contract";

export interface PostcardDraft {
  version: 1; eventId: string; guestId: string; proposal: PostcardProposal; revision: number;
  ticketRequestId: string; reserveRequestId: string; expiresAt: string;
  image: PostcardCandidate | null; receipt: EventReceipt | null;
  consentIntent: { expectedRevision: number; consent: EventConsent } | null;
}
const fail = (code = "journal_invalid"): never => { throw new EventClientError(code); };
export function parsePostcardDraft(value: unknown): PostcardDraft {
  const b = eventClientObject(value, ["version", "eventId", "guestId", "proposal", "revision", "ticketRequestId", "reserveRequestId", "expiresAt", "image", "receipt", "consentIntent"]);
  if (b.version !== 1 || !Number.isSafeInteger(b.revision) || (b.revision as number) < 0) fail();
  const proposal = parsePostcardProposal(b.proposal), receipt = b.receipt === null ? null : parseEventReceipt(b.receipt, proposal.submissionId);
  let consentIntent: PostcardDraft["consentIntent"] = null;
  if (b.consentIntent !== null) { const c = eventClientObject(b.consentIntent, ["expectedRevision", "consent"]); if (!Number.isSafeInteger(c.expectedRevision) || (c.expectedRevision as number) < 0) fail(); consentIntent = { expectedRevision: c.expectedRevision as number, consent: eventClientConsent(c.consent) }; }
  return { version: 1, eventId: eventClientUuid(b.eventId), guestId: eventClientUuid(b.guestId), proposal, revision: b.revision as number, ticketRequestId: eventClientUuid(b.ticketRequestId), reserveRequestId: eventClientUuid(b.reserveRequestId), expiresAt: eventClientInstant(b.expiresAt), image: b.image === null ? null : parsePostcardCandidate(b.image), receipt, consentIntent };
}
export function updatePostcardDraft(current: PostcardDraft, patch: Pick<Partial<PostcardDraft>, "image" | "receipt" | "consentIntent" | "ticketRequestId">): PostcardDraft {
  const old = parsePostcardDraft(current); eventClientObject(patch, [], ["image", "receipt", "consentIntent", "ticketRequestId"]);
  const next = parsePostcardDraft({ ...old, ...patch, revision: old.revision + 1 });
  if (old.image && JSON.stringify(old.image) !== JSON.stringify(next.image) || old.receipt && (!next.receipt || old.receipt.logicalExpiresAt !== next.receipt.logicalExpiresAt || old.receipt.eventExpiresAt > next.receipt.eventExpiresAt) || old.consentIntent && next.consentIntent && JSON.stringify(old.consentIntent) !== JSON.stringify(next.consentIntent)) fail("conflict");
  return next;
}
export async function postcardImageProof(blob: Blob): Promise<PostcardCandidate> {
  if (blob.type !== "image/jpeg" || blob.size < 1 || blob.size > 2000000) fail("invalid_image");
  const { inspectImageHeader } = await import("../projects/images"), data = new Uint8Array(await blob.arrayBuffer()), info = inspectImageHeader(data);
  if (info.mime !== "image/jpeg") fail("invalid_image");
  const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))].map(x => x.toString(16).padStart(2, "0")).join("");
  return parsePostcardCandidate({ revision: 1, ...info, bytes: data.length, sha256 });
}
export async function openPostcardJournal(guest: EventGuestClient, options: { indexedDB?: IDBFactory; databaseName?: string; now?: () => number } = {}) {
  const eventId = eventClientUuid(guest.eventId), guestId = eventClientUuid(guest.guestId), now = options.now ?? Date.now; let closed = false;
  const active = (signal?: AbortSignal) => { guest.assertActive(signal); if (closed) fail("cancelled"); };
  active();
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    let ended = false; const request = (options.indexedDB ?? indexedDB).open(options.databaseName ?? "pb-event-postcards", 1), timer = setTimeout(() => { ended = true; reject(new EventClientError("journal_blocked")); }, 5000);
    request.onupgradeneeded = () => { if (ended) request.transaction?.abort(); else request.result.createObjectStore("records", { keyPath: "key" }); };
    request.onerror = () => { clearTimeout(timer); reject(new EventClientError("journal_unavailable")); };
    request.onsuccess = () => { clearTimeout(timer); if (ended) request.result.close(); else resolve(request.result); };
  });
  try { active(); } catch (error) { db.close(); throw error; }
  const transactions = new Set<IDBTransaction>();
  db.onversionchange = () => { closed = true; for (const tx of transactions) tx.abort(); db.close(); };
  const key = (id: string) => `${eventId}:${guestId}:${eventClientUuid(id)}`;
  async function transaction<T>(work: (rows: PostcardDraft[], store: IDBObjectStore) => T): Promise<T> {
    active();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction("records", "readwrite"), store = tx.objectStore("records"); transactions.add(tx); let result: T, failure: unknown;
      const stop = (error: unknown) => { failure = error; try { tx.abort(); } catch { reject(error); } };
      const timer = setTimeout(() => stop(new EventClientError("journal_unavailable")), 5000);
      tx.oncomplete = () => { clearTimeout(timer); transactions.delete(tx); try { active(); resolve(result); } catch (error) { reject(error); } };
      tx.onabort = tx.onerror = () => { clearTimeout(timer); transactions.delete(tx); reject(failure ?? new EventClientError("journal_unavailable")); };
      const request = store.getAll(undefined, 9);
      request.onsuccess = () => { try {
        active(); if (request.result.length > 8) fail("queue_capacity");
        const rows: PostcardDraft[] = [];
        for (const value of request.result) {
          const wrapper = eventClientObject(value, ["key", "draft"]), draft = parsePostcardDraft(wrapper.draft);
          if (wrapper.key !== `${draft.eventId}:${draft.guestId}:${draft.proposal.postcardId}`) fail();
          if (Date.parse(draft.expiresAt) <= now()) store.delete(wrapper.key as string); else rows.push(draft);
        }
        result = work(rows, store);
      } catch (error) { stop(error); } };
    });
  }
  const scoped = (row: PostcardDraft) => row.eventId === eventId && row.guestId === guestId;
  return { eventId, guestId, assertActive: active,
    list() { return transaction(rows => rows.filter(scoped)); },
    create(proposal: PostcardProposal, expiresAt: string) { return transaction((rows, store) => {
      const checked = parsePostcardProposal(proposal), existing = rows.find(r => scoped(r) && r.proposal.postcardId === checked.postcardId);
      if (existing) { if (JSON.stringify(existing.proposal) !== JSON.stringify(checked)) fail("conflict"); return existing; }
      if (rows.length >= 8) fail("queue_capacity");
      const until = Math.min(Date.parse(eventClientInstant(expiresAt)), now() + 86400000); if (until <= now()) fail("expired");
      const draft = parsePostcardDraft({ version: 1, eventId, guestId, proposal: checked, revision: 0, ticketRequestId: crypto.randomUUID(), reserveRequestId: crypto.randomUUID(), expiresAt: new Date(until).toISOString(), image: null, receipt: null, consentIntent: null });
      store.add({ key: key(checked.postcardId), draft }); return draft;
    }); },
    update(postcardId: string, revision: number, patch: Parameters<typeof updatePostcardDraft>[1]) { return transaction((rows, store) => {
      const old = rows.find(r => scoped(r) && r.proposal.postcardId === postcardId) ?? fail("conflict"); if (old.revision !== revision) fail("conflict");
      const draft = updatePostcardDraft(old, patch); store.put({ key: key(postcardId), draft }); return draft;
    }); },
    remove(postcardId: string) { return transaction((_rows, store) => { store.delete(key(postcardId)); }); },
    close() { if (closed) return; closed = true; for (const tx of transactions) tx.abort(); db.close(); },
  };
}
export type PostcardJournal = Awaited<ReturnType<typeof openPostcardJournal>>;
