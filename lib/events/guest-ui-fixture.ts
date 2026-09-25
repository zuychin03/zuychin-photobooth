import { EVENT_LIMITS, type EventConsent, type EventReceipt } from "./contract";
import { EVENT_MISSIONS, validateGuestbookText, type EventGuestbookNote } from "./guestbook-contract";
import { DEFAULT_EVENT_LOOK, type EventGuestContext } from "./host-contract";

export function createEventGuestUIFixture(appOrigin: string) {
  if (process.env.NODE_ENV !== "development") throw new Error("Development fixture unavailable");
  const eventId = crypto.randomUUID(), databaseName = `pb-event-ui-fixture-${crypto.randomUUID()}`, invite = "A".repeat(43), storageOrigin = "https://event-storage.example.invalid";
  let guestId = crypto.randomUUID(), joined = false, held = true, lostReservation = false, failedUpload = false, closed = false, status: EventGuestContext["status"] = "open", receiptId: string | null = null;
  const expiresAt = new Date(Date.now() + 86400000).toISOString(), startsAt = new Date(Date.now() - 60000).toISOString(), closesAt = new Date(Date.now() + 3600000).toISOString();
  let lostText = false, refuseText = false, lostConsent = false;
  const consentRevisions = new Map<string, number>();
  const notes = new Map<string, EventGuestbookNote>(), textRequests = new Map<string, { fingerprint: string; revision: number }>();
  const submissions = new Map<string, { requestId: string; guestId: string; consent: EventConsent; reservationConsent: EventConsent; receipt: EventReceipt; token: string; bytes: Blob | null }>();
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", "cache-control": "private, no-store" } });
  const denied = () => json({ error: "access_denied" }, 403);
  const session = () => ({ eventId, guestId, kind: "contribute", submissionId: null, expiresAt });
  const context = (): EventGuestContext => ({ version: 1, eventId, title: "A little synthetic celebration", timezone: "Australia/Sydney", startsAt, closesAt, expiresAt, status, look: { ...DEFAULT_EVENT_LOOK, frameId: "rose", caption: "A little celebration" }, capacityAvailable: submissions.size < 3, canReserve: status === "open" && submissions.size < 3 });
  const fetcher: typeof fetch = async (input, init) => {
    if (closed || init?.signal?.aborted) throw new DOMException("Cancelled", "AbortError"); const url = new URL(String(input));
    if (url.origin === storageOrigin) {
      const id = url.pathname.split("/").at(-2)!, found = submissions.get(id); if (!found) return denied();
      if (init?.method === "PUT") { if (failedUpload) { failedUpload = false; return json({ error: "Synthetic interrupted upload" }, 400); } if (found.bytes) return json({}, 409); if (!(init.body instanceof Blob) || init.body.size > EVENT_LIMITS.imageBytes) return json({}, 413); found.bytes = init.body; return json({}); }
      if (!found.bytes || found.receipt.state !== "ready") return denied(); return new Response(found.bytes, { headers: { "content-type": "image/jpeg" } });
    }
    if (url.origin !== appOrigin || init?.method !== "POST") return denied();
    const body = JSON.parse(String(init.body)) as Record<string, unknown>, operation = body.operation;
    if (url.pathname === "/api/events" && operation === "capabilities") return json({ enabled: true, version: 1, transportVersion: 1, hostVersion: 1, guestbookVersion: 1, ownConsentVersion: 1, limits: EVENT_LIMITS, uploadsAvailable: true, downloadsAvailable: true });
    if (url.pathname === `/api/events/${eventId}/guest`) {
      if (operation === "redeem") { if (body.inviteToken !== invite || status !== "open") return denied(); joined = true; return json({ ...session(), replacesBrowserGuestSession: true }, 201); }
      if (!joined) return denied(); if (operation === "session") return json(session()); if (body.expectedGuestId !== guestId) return denied();
      if (operation === "missions") return json({ version: 1, eventId, revision: 1, missionIds: EVENT_MISSIONS.slice(0, 3).map(m => m.id), endsAt: closesAt, locked: submissions.size > 0 });
      if (operation === "context") return json(context());
      const id = String(body.submissionId), prior = submissions.get(id);
      if (operation === "reserve" || operation === "reserveMission") {
        const chosen = operation === "reserveMission" ? body.missionId : null; if (chosen !== null && !EVENT_MISSIONS.slice(0, 3).some(m => m.id === chosen)) return json({ error: "invalid_request" }, 400);
        if (prior && (notes.get(id)?.mission?.id ?? null) !== chosen) return json({ error: "conflict" }, 409);
        const consent = body.consent as EventConsent;
        if (prior && (prior.guestId !== guestId || prior.requestId !== body.requestId || JSON.stringify(prior.reservationConsent) !== JSON.stringify(consent))) return json({ error: "conflict" }, 409);
        if (!prior) { if (status !== "open") return json({ error: "expired" }, 410); if (submissions.size >= 3) return json({ error: "capacity" }, 409); if (!consent.submission) return denied(); const token = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", ""); submissions.set(id, { guestId, requestId: String(body.requestId), consent: { ...consent }, reservationConsent: { ...consent }, receipt: { submissionId: id, state: "reserved", logicalExpiresAt: new Date(Date.now() + 600000).toISOString(), eventExpiresAt: expiresAt, gallery: consent.gallery ? "awaiting_approval" : "private", wall: consent.wall ? "awaiting_approval" : "private" }, token, bytes: null }); }
        if (!notes.has(id)) notes.set(id, { version: 1, eventId, submissionId: id, revision: 0, message: "", signature: "", withdrawn: false, mission: EVENT_MISSIONS.find(m => m.id === chosen) ?? null, missionCompleted: false });
        receiptId = id; const saved = submissions.get(id)!; if (lostReservation) { lostReservation = false; throw new Error("Synthetic lost reservation response"); } return json({ receipt: saved.receipt, receiptToken: saved.token, replacesBrowserReceipt: true, fragmentOnly: true }, 201);
      }
      if (!prior || prior.guestId !== guestId) return denied();
      if (["guestbook", "saveGuestbook", "withdrawGuestbook"].includes(String(operation))) {
        if (["deleted", "expired", "failed"].includes(prior.receipt.state)) return denied();
        const note = notes.get(id)!; note.missionCompleted = !!note.mission && prior.receipt.state === "ready";
        if (operation === "guestbook") return json(note);
        if (operation === "withdrawGuestbook") { note.revision++; note.message = note.signature = ""; note.withdrawn = true; return json({ submissionId: id, withdrawn: true }); }
        if (refuseText) return json({ error: "capacity" }, 409);
        try { validateGuestbookText(body.message, body.signature); } catch { return json({ error: "invalid_request" }, 400); }
        const key = `${id}:${body.requestId}`, fingerprint = JSON.stringify([body.expectedRevision, body.message, body.signature]), ack = textRequests.get(key);
        if (ack && ack.fingerprint !== fingerprint || !ack && body.expectedRevision !== note.revision) return json({ error: "conflict" }, 409);
        if (!ack) { if ([...textRequests.keys()].filter(k => k.startsWith(`${id}:`)).length >= 32) return json({ error: "capacity" }, 409); note.revision++; note.message = String(body.message); note.signature = String(body.signature); note.withdrawn = false; textRequests.set(key, { fingerprint, revision: note.revision }); }
        if (lostText) { lostText = false; throw new Error("Synthetic lost text acknowledgement"); }
        return json({ acceptedRequestId: body.requestId, acceptedRevision: textRequests.get(key)!.revision, current: note });
      }
      if (operation === "ownConsent" || operation === "saveOwnConsent") {
        if (["deleted", "expired", "failed"].includes(prior.receipt.state)) return denied();
        let revision = consentRevisions.get(id) ?? 0;
        if (operation === "saveOwnConsent") {
          if (typeof body.gallery !== "boolean" || typeof body.wall !== "boolean" || !Number.isInteger(body.expectedRevision)) return json({ error: "invalid_request" }, 400);
          const same = prior.consent.gallery === body.gallery && prior.consent.wall === body.wall;
          if (revision !== body.expectedRevision && !(revision === Number(body.expectedRevision) + 1 && same)) return json({ error: "conflict" }, 409);
          if (!same) { prior.consent.gallery = body.gallery; prior.consent.wall = body.wall; if (!body.gallery) prior.receipt.gallery = "private"; else if (prior.receipt.state === "ready" && prior.receipt.gallery === "private") prior.receipt.gallery = "awaiting_approval"; if (!body.wall) prior.receipt.wall = "private"; else if (prior.receipt.state === "ready" && prior.receipt.wall === "private") prior.receipt.wall = "awaiting_approval"; revision++; consentRevisions.set(id, revision); }
          if (lostConsent) { lostConsent = false; throw new Error("Synthetic lost permission acknowledgement"); }
        }
        return json({ version: 1, eventId, submissionId: id, revision, consent: prior.consent, receipt: prior.receipt });
      }
      if (operation === "upload") { if (!["reserved", "uploading"].includes(prior.receipt.state)) return json({ error: "expired" }, 410); prior.receipt.state = "uploading"; return json({ submissionId: id, bucket: "photobooth-event-images-staging-v2", path: `${eventId}/${id}/source`, signedUrl: `${storageOrigin}/storage/v1/object/upload/sign/photobooth-event-images-staging-v2/${eventId}/${id}/source?token=synthetic`, expiresAt: new Date(Date.now() + 600000).toISOString(), maxBytes: 2000000, overwrite: false }); }
      if (operation === "finalise") { if (!prior.bytes) return json({ error: "not_ready" }, 503); if (["deleted", "expired", "failed"].includes(prior.receipt.state)) return denied(); prior.receipt.state = held ? "finalising" : "ready"; return json(prior.receipt); }
      if (operation === "consent") { const consent = body.consent as EventConsent; if (!consent.submission) { prior.receipt.state = "deleted"; prior.receipt.gallery = prior.receipt.wall = "private"; } else { if (!consent.gallery) prior.receipt.gallery = "private"; if (!consent.wall) prior.receipt.wall = "private"; } return json(prior.receipt); }
    }
    const match = new RegExp(`^/api/events/${eventId}/receipts/([a-f0-9-]{36})$`).exec(url.pathname); if (!match) return denied(); const item = submissions.get(match[1]); if (!item) return denied();
    if (operation === "exchange") { if (body.token !== item.token) return denied(); receiptId = match[1]; return json(item.receipt); }
    if (receiptId !== match[1]) return denied(); if (operation === "read") return json(item.receipt);
    if (operation === "guestbook" || operation === "withdrawGuestbook") { if (["deleted", "expired", "failed"].includes(item.receipt.state)) return denied(); const note = notes.get(match[1])!; note.missionCompleted = !!note.mission && item.receipt.state === "ready"; if (operation === "withdrawGuestbook") { note.revision++; note.message = note.signature = ""; note.withdrawn = true; return json({ submissionId: match[1], withdrawn: true }); } return json(note); }
    if (operation === "media") { if (item.receipt.state !== "ready") return denied(); return json({ submissionId: match[1], bucket: "photobooth-events-v2", path: `${eventId}/${match[1]}/image`, signedUrl: `${storageOrigin}/storage/v1/object/sign/photobooth-events-v2/${eventId}/${match[1]}/image?token=synthetic`, expiresAt: new Date(Date.now() + 60000).toISOString(), maxBytes: 2000000, mime: "image/jpeg" }); }
    return json({ error: "invalid_request" }, 400);
  };
  return {
    eventId, databaseName, options: { appOrigin, storageOrigin, databaseName, initialInvite: invite, fetch: fetcher },
    setHeld(value: boolean) { held = value; if (!held) for (const row of submissions.values()) if (row.receipt.state === "finalising" && row.bytes) row.receipt.state = "ready"; },
    loseConsentSave() { lostConsent = true; }, withdrawPublicationElsewhere() { for (const [id, row] of submissions) { row.consent.gallery = row.consent.wall = false; row.receipt.gallery = row.receipt.wall = "private"; consentRevisions.set(id, (consentRevisions.get(id) ?? 0) + 1); } },
    loseTextSave() { lostText = true; }, refuseTextSave(value: boolean) { refuseText = value; },
    loseReservation() { lostReservation = true; }, failUpload() { failedUpload = true; }, setStatus(value: "open" | "paused" | "closed") { status = value; },
    replaceGuest() { guestId = crypto.randomUUID(); joined = true; },
    receipts() { return [...submissions.values()].map(row => ({ submissionId: row.receipt.submissionId, token: row.token, state: row.receipt.state })); },
    async photo() { const c = document.createElement("canvas"); c.width = 400; c.height = 300; const ctx = c.getContext("2d")!; ctx.fillStyle = "#ecb8c7"; ctx.fillRect(0, 0, 400, 300); ctx.fillStyle = "#633646"; ctx.beginPath(); ctx.arc(140, 130, 62, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = "#f5eedf"; ctx.fillRect(240, 75, 80, 140); try { return await new Promise<Blob>((resolve, reject) => c.toBlob(value => value ? resolve(value) : reject(new Error()), "image/png")); } finally { c.width = c.height = 0; } },
    close() { closed = true; submissions.clear(); notes.clear(); textRequests.clear(); consentRevisions.clear(); },
  };
}
export type EventGuestUIFixture = ReturnType<typeof createEventGuestUIFixture>;
