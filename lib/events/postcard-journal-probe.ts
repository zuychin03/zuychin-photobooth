import { openPostcardJournal } from "./postcard-journal";
import type { EventGuestClient } from "./client";
import type { PostcardProposal } from "./postcard-contract";

export async function runPostcardJournalProbe(proposal: PostcardProposal) {
  if (process.env.NODE_ENV !== "development") throw new Error("Development probe unavailable");
  const databaseName = `pb-postcard-probe-${crypto.randomUUID()}`, eventId = crypto.randomUUID(), guestId = crypto.randomUUID(), checks: { name: string; passed: boolean }[] = [];
  const guest = (id: string) => ({ eventId, guestId: id, assertActive() {} }) as EventGuestClient;
  const first = await openPostcardJournal(guest(guestId), { databaseName }); let reopened: Awaited<ReturnType<typeof openPostcardJournal>> | undefined, other: typeof reopened;
  const check = (name: string, passed: boolean) => { checks.push({ name, passed }); if (!passed) throw new Error(name); };
  try {
    const original = await first.create(proposal, new Date(Date.now() + 3600000).toISOString()); first.close();
    reopened = await openPostcardJournal(guest(guestId), { databaseName }); const saved = (await reopened.list())[0];
    check("Remount retains exact ticket and reservation identities", saved.ticketRequestId === original.ticketRequestId && saved.reserveRequestId === original.reserveRequestId);
    other = await openPostcardJournal(guest(crypto.randomUUID()), { databaseName }); check("Another guest cannot list this draft", (await other.list()).length === 0);
    const intent = { expectedRevision: 0, consent: { submission: true, gallery: false, wall: false } };
    await reopened.update(proposal.postcardId, 0, { consentIntent: intent });
    let conflict = false; try { await reopened.update(proposal.postcardId, 0, { consentIntent: null }); } catch { conflict = true; } check("Stale journal revision cannot replace permissions", conflict);
    for (let i = 1; i < 8; i++) await reopened.create({ ...proposal, postcardId: crypto.randomUUID(), submissionId: crypto.randomUUID() }, original.expiresAt);
    let bounded = false; try { await other.create({ ...proposal, postcardId: crypto.randomUUID(), submissionId: crypto.randomUUID() }, original.expiresAt); } catch { bounded = true; } check("Eight-entry capacity is shared across guest scopes", bounded);
    const rows = await reopened.list(); check("Recovery records contain no bearer tokens or photo bytes", rows.every(row => !JSON.stringify(row).includes("access_token") && !("blob" in row) && !("token" in row)));
    return { passed: checks.every(c => c.passed), checks };
  } finally { first.close(); reopened?.close(); other?.close(); await new Promise<void>((resolve, reject) => { const request = indexedDB.deleteDatabase(databaseName); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); request.onblocked = () => reject(new Error("Probe cleanup blocked")); }); }
}
