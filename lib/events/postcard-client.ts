import { EventClientError, eventClientConsent, eventClientInstant, eventClientObject, eventClientUuid, parseEventReceipt, type EventBrowserOptions, type EventGuestClient } from "./client";
import { EVENT_POSTCARD_LIMITS, parsePostcardCandidate, parsePostcardProposal, parsePostcardSource, parsePostcardView, type PostcardCandidate, type PostcardProposal, type PostcardSource } from "./postcard-contract";
import { createPostcardTransport, postcardOrigin, type PostcardTransportOptions } from "./postcard-transport";
import { inspectImageHeader } from "../projects/images";
import type { EventConsent } from "./contract";

const fail = (code = "invalid_response"): never => { throw new EventClientError(code); };
const token = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value) ? value : fail();
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function createPostcardSourceClient(options: PostcardTransportOptions & { source: PostcardSource }) {
  const source = parsePostcardSource(options.source), path = `/api/${source.kind === "room" ? "rooms" : "challenges"}/${source.id}/postcards`, io = createPostcardTransport(options), authenticated = source.kind !== "room";
  return { source, assertActive: io.assertActive, close: io.close,
    proposal(postcardId: string, signal?: AbortSignal) { return io.run(signal, async active => {
      const id = eventClientUuid(postcardId), b = eventClientObject(await io.request(path, "proposal", { postcardId: id, source }, active, authenticated), ["eventId", "proposal"]), proposal = parsePostcardProposal(b.proposal);
      if (proposal.postcardId !== id || !same(proposal.source, source)) fail(); return { eventId: eventClientUuid(b.eventId), proposal };
    }); },
    attach(eventId: string, ticket: string, proposal: PostcardProposal, signal?: AbortSignal) { return io.run(signal, async active => {
      const input = parsePostcardProposal(proposal), id = eventClientUuid(eventId); if (!same(input.source, source)) fail("invalid_request");
      const result = parsePostcardView(await io.request(path, "attach", { eventId: id, ticket: token(ticket), proposal: input }, active, authenticated), id, input.postcardId);
      if (!same(result.source, input.source) || !same(result.design, input.design) || result.submissionId !== input.submissionId) fail(); return result;
    }); },
  };
}
export type PostcardSourceClient = ReturnType<typeof createPostcardSourceClient>;
export interface PostcardReviewedImage { blob: Blob; candidate: PostcardCandidate; postcardId: string; submissionId: string }
export interface EventPostcardClientOptions extends EventBrowserOptions {
  guest: EventGuestClient; storageOrigin: string;
  decode?(blob: Blob): Promise<{ width: number; height: number; close(): void }>;
}
let nativeBusy = false;
export function createEventPostcardClient(options: EventPostcardClientOptions) {
  const guest = options.guest, eventId = eventClientUuid(guest.eventId), expectedGuestId = eventClientUuid(guest.guestId), storageOrigin = postcardOrigin(options.storageOrigin);
  const io = createPostcardTransport({ ...options, assertAuthority: guest.assertActive }), path = `/api/events/${eventId}/postcards`, reviewed = new WeakSet<PostcardReviewedImage>();
  const request = (operation: string, postcardId: string, input: object, active: AbortSignal) => io.request(path, operation, { expectedGuestId, postcardId: eventClientUuid(postcardId), ...input }, active);
  const view = async (postcardId: string, active: AbortSignal) => parsePostcardView(await request("view", postcardId, {}, active), eventId, postcardId);
  return { eventId, guestId: expectedGuestId, assertActive: io.assertActive, close: io.close,
    capabilities(signal?: AbortSignal) { return io.run(signal, async active => { const b = eventClientObject(await io.request(path, "capabilities", {}, active), Object.keys(EVENT_POSTCARD_LIMITS)); if (Object.entries(EVENT_POSTCARD_LIMITS).some(([key, value]) => b[key] !== value)) fail("update_required"); return EVENT_POSTCARD_LIMITS; }); },
    ticket(postcardId: string, requestId: string, signal?: AbortSignal) { return io.run(signal, async active => { const b = eventClientObject(await request("ticket", postcardId, { requestId: eventClientUuid(requestId) }, active), ["postcardId", "expiresAt", "ticket"]), expiresAt = eventClientInstant(b.expiresAt); if (b.postcardId !== postcardId || Date.parse(expiresAt) <= Date.now() || Date.parse(expiresAt) > Date.now() + 300000) fail("expired"); return { postcardId, expiresAt, ticket: token(b.ticket) }; }); },
    view(postcardId: string, signal?: AbortSignal) { return io.run(signal, active => view(postcardId, active)); },
    scopeConsent(postcardId: string, expectedRevision: number, consent: EventConsent, signal?: AbortSignal) { return io.run(signal, async active => { if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) fail("invalid_request"); const result = parsePostcardView(await request("scopeConsent", postcardId, { expectedRevision, consent: eventClientConsent(consent) }, active), eventId, postcardId); if (consent.submission && result.revision < expectedRevision) fail(); return result; }); },
    reserve(postcardId: string, submissionId: string, requestId: string, signal?: AbortSignal) { return io.run(signal, async active => { const b = eventClientObject(await request("reserve", postcardId, { requestId: eventClientUuid(requestId) }, active), ["receipt", "receiptToken", "fragmentOnly"]); if (b.fragmentOnly !== true) fail(); return { receipt: parseEventReceipt(b.receipt, eventClientUuid(submissionId)), receiptToken: token(b.receiptToken), fragmentOnly: true as const }; }); },
    approveCandidate(image: PostcardReviewedImage, signal?: AbortSignal) { return io.run(signal, async active => {
      if (!reviewed.has(image)) fail("image_review_required"); const before = await view(image.postcardId, active);
      if (!same(before.candidate, image.candidate) || before.submissionId !== image.submissionId || !["candidate", "ready"].includes(before.state)) fail("conflict");
      return parsePostcardView(await request("approveCandidate", image.postcardId, { sha256: image.candidate.sha256 }, active), eventId, image.postcardId);
    }); },
    download(postcardId: string, signal?: AbortSignal): Promise<PostcardReviewedImage> { return io.run(signal, async active => {
      if (nativeBusy) fail("busy"); nativeBusy = true; let bitmap: { width: number; height: number; close(): void } | undefined;
      try {
        const before = await view(postcardId, active); if (!before.candidate || !["candidate", "ready"].includes(before.state)) fail("not_ready");
        const b = eventClientObject(await request("candidate", postcardId, {}, active), ["revision", "sha256", "bytes", "width", "height", "mime", "submissionId", "bucket", "path", "retainedUntil", "expiresAt", "signedUrl"]);
        const { submissionId, bucket, path: storagePath, retainedUntil, expiresAt, signedUrl, ...fields } = b, candidate = parsePostcardCandidate(fields), until = Date.parse(eventClientInstant(expiresAt)), retained = Date.parse(eventClientInstant(retainedUntil));
        if (!same(candidate, before.candidate) || submissionId !== before.submissionId || bucket !== "photobooth-events-v2" || storagePath !== `${eventId}/${submissionId}/image` || until <= Date.now() || until > Math.min(retained, Date.now() + 300000) || retained > Date.parse(before.expiresAt) || typeof signedUrl !== "string" || signedUrl.length > 20000) fail();
        const url = new URL(signedUrl as string); if (url.origin !== storageOrigin || url.pathname !== `/storage/v1/object/sign/${bucket}/${storagePath}` || url.username || url.password || url.hash || [...url.searchParams.keys()].join() !== "token" || !url.searchParams.get("token") || url.searchParams.get("token")!.length > 16384) fail();
        const response = await io.fetch(url.href, { method: "GET", credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer", signal: active });
        if (active.aborted || response.status !== 200 || response.redirected || response.url && response.url !== url.href || response.headers.get("content-type")?.split(";")[0] !== "image/jpeg") { void response.body?.cancel(); io.assertActive(active); fail("source_unavailable"); }
        const bytes = await io.bytes(response, candidate.bytes, active), header = inspectImageHeader(bytes); io.assertActive(active);
        if (bytes.length !== candidate.bytes || header.mime !== "image/jpeg" || header.width !== candidate.width || header.height !== candidate.height) fail("invalid_image");
        const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(x => x.toString(16).padStart(2, "0")).join(""); io.assertActive(active); if (digest !== candidate.sha256) fail("invalid_image");
        const blob = new Blob([bytes], { type: "image/jpeg" }); bitmap = await (options.decode ? options.decode(blob) : createImageBitmap(blob, { imageOrientation: "from-image" })); io.assertActive(active);
        if (bitmap.width !== candidate.width || bitmap.height !== candidate.height || Date.now() >= until) fail("invalid_image");
        const after = await view(postcardId, active); if (!same(after.candidate, candidate) || after.submissionId !== submissionId || !["candidate", "ready"].includes(after.state)) fail("access_denied");
        const result = Object.freeze({ blob, candidate: Object.freeze(candidate), postcardId, submissionId: before.submissionId }); reviewed.add(result); return result;
      } finally { bitmap?.close(); nativeBusy = false; }
    }); },
  };
}
export type EventPostcardClient = ReturnType<typeof createEventPostcardClient>;
