import { EVENT_LIMITS, type EventConsent, type EventReceipt } from "./contract";
import { DEFAULT_EVENT_LOOK } from "./host-contract";
import { EVENT_POSTCARD_LIMITS, parsePostcardProposal, type PostcardProposal, type PostcardView } from "./postcard-contract";
import { postcardImageProof } from "./postcard-journal";
import { validateTemplateDesign } from "../templates/model";

export function createPostcardUIFixture(appOrigin: string) {
  if (process.env.NODE_ENV !== "development") throw new Error("Development fixture unavailable");
  const eventId = crypto.randomUUID(), source = { kind: "challenge" as const, id: crypto.randomUUID() }, databaseName = `pb-postcard-rehearsal-${crypto.randomUUID()}`, storageOrigin = "https://postcard.example.invalid";
  const principals = [crypto.randomUUID(), crypto.randomUUID()], guests = [crypto.randomUUID(), crypto.randomUUID()], token = "A".repeat(43), expiresAt = new Date(Date.now() + 86400000).toISOString();
  const design = validateTemplateDesign({ canvas: { width: 480, height: 960 }, requiredSources: { A: 1, B: 1 }, slots: ["A", "B"].map((role, index) => ({ id: role, role, sourceIndex: 0, x: .05, y: .05 + index * .45, width: .9, height: .4, crop: { zoom: 1, offsetX: 0, offsetY: 0, rotation: 0, mirror: false } })), layers: [], decorations: [], look: { frameId: "film", filterId: "none", patternId: "none", themeId: null, sceneId: null, materialId: null }, defaults: { caption: "Synthetic postcard", showDate: false } });
  type Row = { proposal: PostcardProposal; initiator: number; revision: number; state: PostcardView["state"]; bound: boolean[]; consent: EventConsent[]; approved: boolean[]; receipt: EventReceipt | null; request: string | null; blob: Blob | null; candidate: PostcardView["candidate"] };
  const rows = new Map<string, Row>(), tickets = new Map<string, { role: number; postcardId: string; token: string }>();
  let role = 0, generation = 0, closed = false, hold = true, loseTicket = false, loseReserve = false, loseConsent = false;
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  const deny = (error = "access_denied", status = 403) => json({ error }, status);
  const view = (row: Row): PostcardView => ({ version: 1, eventId, postcardId: row.proposal.postcardId, submissionId: row.proposal.submissionId, revision: row.revision, state: row.state, source, design, designHash: "a".repeat(64), expiresAt, logicalExpiresAt: row.receipt?.logicalExpiresAt ?? null, selfPrincipalId: principals[role], canSubmit: role === row.initiator, selfConsent: row.consent[role], participants: principals.map((principalId, index) => ({ principalId, role: index === 0 ? "A" : "B", bound: row.bound[index], consent: row.consent[index].submission, approved: row.approved[index] })), candidate: row.candidate });
  const verify = async (row: Row) => { if (row.blob && row.state === "reserved" && row.receipt?.state === "finalising") { row.candidate = await postcardImageProof(row.blob); row.state = "candidate"; row.revision++; } };
  const fetcher: typeof fetch = async (input, init) => {
    if (closed || init?.signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    const url = new URL(String(input));
    if (url.origin === storageOrigin) {
      const row = [...rows.values()].find(r => url.pathname.includes(r.proposal.submissionId));
      if (!row || row.state === "revoked") return deny();
      if (init?.method === "PUT") { if (role !== row.initiator || row.state !== "reserved" || !(init.body instanceof Blob)) return deny(); if (row.blob) return json({}, 409); await postcardImageProof(init.body); row.blob = init.body; return json({}); }
      return row.blob && ["candidate", "ready"].includes(row.state) && row.bound[role] ? new Response(row.blob, { headers: { "content-type": "image/jpeg" } }) : deny();
    }
    if (url.origin !== appOrigin || init?.method !== "POST") return deny();
    const b = JSON.parse(String(init.body)), op = b.operation;
    if (url.pathname === "/api/events" && op === "capabilities") return json({ enabled: true, version: 1, transportVersion: 1, hostVersion: 1, limits: EVENT_LIMITS, uploadsAvailable: true, downloadsAvailable: true });
    if (url.pathname === `/api/events/${eventId}/guest`) {
      if (op === "session") return json({ eventId, guestId: guests[role], kind: "contribute", submissionId: null, expiresAt });
      if (b.expectedGuestId !== guests[role]) return deny("identity_changed");
      if (op === "context") return json({ version: 1, eventId, title: "Synthetic remote celebration", timezone: "Australia/Sydney", startsAt: new Date(Date.now() - 60000).toISOString(), closesAt: new Date(Date.now() + 3600000).toISOString(), expiresAt, status: "open", look: DEFAULT_EVENT_LOOK, capacityAvailable: true, canReserve: true });
      const row = [...rows.values()].find(r => r.proposal.submissionId === b.submissionId);
      if (!row || role !== row.initiator || !row.receipt || row.state === "revoked") return deny();
      if (op === "upload") return json({ submissionId: b.submissionId, bucket: "photobooth-event-images-staging-v2", path: `${eventId}/${b.submissionId}/source`, signedUrl: `${storageOrigin}/storage/v1/object/upload/sign/photobooth-event-images-staging-v2/${eventId}/${b.submissionId}/source?token=synthetic`, expiresAt: new Date(Date.now() + 300000).toISOString(), maxBytes: 2000000, overwrite: false });
      if (op === "finalise") { if (!row.blob) return deny("not_ready", 503); row.receipt.state = "finalising"; if (!hold) await verify(row); return json(row.receipt); }
      return deny("invalid_request", 400);
    }
    if (url.pathname === `/api/challenges/${source.id}/postcards`) {
      if (new Headers(init.headers).get("authorization") !== `Bearer synthetic-role-${role}`) return deny();
      if (op === "proposal") { const row = rows.get(b.postcardId); return row && row.state !== "revoked" ? json({ eventId, proposal: row.proposal }) : deny(); }
      if (op !== "attach") return deny();
      const proposal = parsePostcardProposal(b.proposal), ticket = [...tickets.values()].find(t => t.token === b.ticket && t.role === role && t.postcardId === proposal.postcardId);
      if (!ticket || b.eventId !== eventId || JSON.stringify(proposal.design) !== JSON.stringify(design) || JSON.stringify(proposal.source) !== JSON.stringify(source)) return deny();
      let row = rows.get(proposal.postcardId);
      if (row && JSON.stringify(row.proposal) !== JSON.stringify(proposal)) return deny("conflict", 409);
      if (!row) { if (rows.size >= 8) return deny("capacity", 409); row = { proposal, initiator: role, revision: 0, state: "draft", bound: [false, false], consent: [0, 1].map(() => ({ submission: false, gallery: false, wall: false })), approved: [false, false], receipt: null, request: null, blob: null, candidate: null }; rows.set(proposal.postcardId, row); }
      if (row.state !== "draft") return deny("conflict", 409); row.bound[role] = true; return json(view(row));
    }
    if (url.pathname !== `/api/events/${eventId}/postcards`) return deny();
    if (op === "capabilities") return json(EVENT_POSTCARD_LIMITS);
    if (b.expectedGuestId !== guests[role]) return deny("identity_changed");
    if (op === "ticket") { const key = `${role}:${b.postcardId}:${b.requestId}`; if (!tickets.has(key)) tickets.set(key, { role, postcardId: b.postcardId, token: crypto.randomUUID().replaceAll("-", "") + "A".repeat(11) }); const result = { postcardId: b.postcardId, ticket: tickets.get(key)!.token, expiresAt: new Date(Date.now() + 299000).toISOString() }; if (loseTicket) { loseTicket = false; throw new Error("Synthetic lost ticket acknowledgement"); } return json(result); }
    const row = rows.get(b.postcardId); if (!row || !row.bound[role]) return deny();
    if (op === "view") return json(view(row));
    if (op === "scopeConsent") {
      if (!b.consent.submission) { row.state = "revoked"; row.consent.forEach(c => { c.submission = false; }); row.approved = [false, false]; if (row.receipt) row.receipt.state = "deleted"; row.revision++; }
      else { if (row.state === "revoked") return deny(); if (b.expectedRevision !== row.revision && JSON.stringify(b.consent) !== JSON.stringify(row.consent[role])) return deny("conflict", 409); if (b.expectedRevision === row.revision) { row.consent[role] = { ...b.consent }; row.revision++; } }
      if (loseConsent) { loseConsent = false; throw new Error("Synthetic lost permission acknowledgement"); } return json(view(row));
    }
    if (op === "reserve") {
      if (role !== row.initiator || row.state === "revoked" || !row.bound.every(Boolean) || !row.consent.every(c => c.submission)) return deny();
      if (row.request && row.request !== b.requestId) return deny("conflict", 409);
      if (!row.receipt) { row.request = b.requestId; row.state = "reserved"; row.revision++; row.receipt = { submissionId: row.proposal.submissionId, state: "reserved", logicalExpiresAt: new Date(Date.now() + 600000).toISOString(), eventExpiresAt: expiresAt, gallery: "private", wall: "private" }; }
      if (loseReserve) { loseReserve = false; throw new Error("Synthetic lost reservation acknowledgement"); } return json({ receipt: row.receipt, receiptToken: token, fragmentOnly: true });
    }
    if (op === "candidate") return row.candidate && ["candidate", "ready"].includes(row.state) ? json({ ...row.candidate, submissionId: row.proposal.submissionId, bucket: "photobooth-events-v2", path: `${eventId}/${row.proposal.submissionId}/image`, retainedUntil: expiresAt, expiresAt: new Date(Date.now() + 60000).toISOString(), signedUrl: `${storageOrigin}/storage/v1/object/sign/photobooth-events-v2/${eventId}/${row.proposal.submissionId}/image?token=synthetic` }) : deny();
    if (op === "approveCandidate") { if (row.state !== "candidate" && row.state !== "ready" || b.sha256 !== row.candidate?.sha256) return deny("conflict", 409); row.approved[role] = true; if (row.approved.every(Boolean)) { row.state = "ready"; row.receipt!.state = "ready"; row.receipt!.gallery = row.consent.every(c => c.gallery) ? "awaiting_approval" : "private"; row.receipt!.wall = row.consent.every(c => c.wall) ? "awaiting_approval" : "private"; } return json(view(row)); }
    return deny("invalid_request", 400);
  };
  return { eventId, source, design, databaseName, guests, options: { appOrigin, storageOrigin, databaseName, fetch: fetcher },
    mount() { const captured = generation, capturedRole = role; return { assertActive(signal?: AbortSignal) { if (closed || generation !== captured || signal?.aborted) throw new Error("Synthetic source closed"); }, async accessToken() { if (closed || generation !== captured) throw new Error("Synthetic source closed"); return `synthetic-role-${capturedRole}`; } }; },
    switchRole(next: number) { role = next; generation++; }, remount() { generation++; },
    loseTicket() { loseTicket = true; }, loseReservation() { loseReserve = true; }, losePermissions() { loseConsent = true; },
    async release() { hold = false; for (const row of rows.values()) await verify(row); },
    withdraw() { for (const row of rows.values()) { row.state = "revoked"; row.revision++; row.approved = [false, false]; row.consent.forEach(c => { c.submission = false; }); if (row.receipt) row.receipt.state = "deleted"; } },
    latestId() { return [...rows.keys()].at(-1); },
    summary() { return [...rows.values()].map(row => ({ state: row.state, revision: row.revision, bound: [...row.bound], approvals: [...row.approved], bytes: row.blob?.size ?? 0 })); },
    async render(signal: AbortSignal) { if (signal.aborted || closed) throw new Error("Cancelled"); const canvas = document.createElement("canvas"); canvas.width = 480; canvas.height = 960; const ctx = canvas.getContext("2d")!; ctx.fillStyle = "#faf4ed"; ctx.fillRect(0, 0, 480, 960); for (let i = 0; i < 2; i++) { ctx.fillStyle = i ? "#8cacc7" : "#d991a2"; ctx.fillRect(24, 48 + i * 432, 432, 384); ctx.fillStyle = "#332b34"; ctx.font = "36px serif"; ctx.fillText(`Synthetic role ${i ? "B" : "A"}`, 65, 240 + i * 432); } try { return await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("PNG unavailable")), "image/png")); } finally { canvas.width = canvas.height = 0; } },
    close() { closed = true; generation++; rows.clear(); tickets.clear(); },
  };
}
