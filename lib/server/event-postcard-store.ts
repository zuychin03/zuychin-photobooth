import { eventInstant } from "./event-http-input";
import { EVENT_POSTCARD_LIMITS, parsePostcardCandidate, parsePostcardProposal, parsePostcardSource, parsePostcardView, type PostcardProposal, type PostcardSource } from "../events/postcard-contract";
import { eventClientConsent, eventClientObject, eventClientUuid, parseEventReceipt } from "../events/client";
import type { EventConsent, EventErrorCode } from "../events/contract";
import { eventActorId, EventStoreError, type EventRpcClient, type VerifiedEventActor } from "./event-store";

function normaliseDates(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid event response");
  const result = { ...value } as Record<string, unknown>;
  for (const key of ["expiresAt","logicalExpiresAt","eventExpiresAt"]) if (Object.hasOwn(result, key)) if (key !== "logicalExpiresAt" || result[key] !== null) result[key] = eventInstant(result[key]);
  return result;
}

export class EventPostcardError extends Error { constructor(readonly code: EventErrorCode | "identity_changed", readonly status: number) { super(code); } }
export type PostcardSourceAuthority = { roomHash: string } | { actor: VerifiedEventActor };
const hash = (v: string) => { if (!/^[a-f0-9]{64}$/.test(v)) throw new EventStoreError("invalid_request", 400); return v; };
export function createEventPostcardStore(client: EventRpcClient) {
  const rpc = async (name: string, args: Record<string, unknown> = {}) => {
    const { data, error } = await client.rpc(name, args);
    if (error) { const codes: Record<string, [EventErrorCode | "identity_changed", number]> = { PB_EVENT_DENIED: ["access_denied", 403], PB_ROOM_DENIED: ["access_denied", 403], PB_CHALLENGE_DENIED: ["access_denied", 403], PB_PROJECT_DENIED: ["access_denied", 403], PB_EVENT_CONFLICT: ["conflict", 409], PB_EVENT_INVALID: ["invalid_request", 400], PB_EVENT_IDENTITY_CHANGED: ["identity_changed", 403], PB_EVENT_EXPIRED: ["expired", 410], PB_EVENT_CAPACITY: ["capacity", 409], PB_EVENT_NOT_READY: ["not_ready", 503] }; const [code, status] = codes[error.message ?? ""] ?? ["unavailable", 503]; throw new EventPostcardError(code, status); }
    if (data === null || new TextEncoder().encode(JSON.stringify(data)).length > 98304) throw new EventStoreError("unavailable", 503); return data;
  };
  const parsed = <T>(fn: () => T): T => { try { return fn(); } catch { throw new EventStoreError("unavailable", 503); } };
  const scope = (eventId: string, tokenHash: string, guestId: string, postcardId: string) => ({ p_event: eventClientUuid(eventId), p_hash: hash(tokenHash), p_guest: eventClientUuid(guestId), p_id: eventClientUuid(postcardId) });
  const ready = async () => { const data = await rpc("pb_event_postcard_capabilities"); parsed(() => { const b = eventClientObject(data, Object.keys(EVENT_POSTCARD_LIMITS)); if (Object.entries(EVENT_POSTCARD_LIMITS).some(([key, value]) => b[key] !== value)) throw new Error(); }); return EVENT_POSTCARD_LIMITS; };
  return {
    capabilities: ready,
    async proposal(postcardId: string, source: PostcardSource, authority: PostcardSourceAuthority) {
      const value = parsePostcardSource(source); if (value.kind === "room" !== ("roomHash" in authority)) throw new EventStoreError("invalid_request", 400);
      const auth = "roomHash" in authority ? { p_room_hash: hash(authority.roomHash), p_actor: null } : { p_room_hash: null, p_actor: eventActorId(authority.actor) };
      await ready(); const data = await rpc("pb_event_postcard_proposal", { p_id: eventClientUuid(postcardId), p_source: value, ...auth });
      return parsed(() => { const b = eventClientObject(data, ["eventId", "proposal"]), proposal = parsePostcardProposal(b.proposal); if (proposal.postcardId !== postcardId || JSON.stringify(proposal.source) !== JSON.stringify(value)) throw new Error(); return { eventId: eventClientUuid(b.eventId), proposal }; });
    },
    async ticket(eventId: string, tokenHash: string, guestId: string, postcardId: string, requestId: string, ticketHash: string) {
      const { p_id, ...args } = scope(eventId, tokenHash, guestId, postcardId); await ready();
      const data = await rpc("pb_event_postcard_ticket", { ...args, p_postcard: p_id, p_request: eventClientUuid(requestId), p_ticket_hash: hash(ticketHash) });
      return parsed(() => { const b = eventClientObject(data, ["postcardId", "expiresAt"]); if (b.postcardId !== postcardId) throw new Error(); return { postcardId, expiresAt: eventInstant(b.expiresAt) }; });
    },
    async attach(eventId: string, ticketHash: string, input: PostcardProposal, authority: PostcardSourceAuthority) {
      const proposal = parsePostcardProposal(input); if (proposal.source.kind === "room" !== ("roomHash" in authority)) throw new EventStoreError("invalid_request", 400);
      const auth = "roomHash" in authority ? { p_room_hash: hash(authority.roomHash), p_actor: null } : { p_room_hash: null, p_actor: eventActorId(authority.actor) };
      await ready(); const data = await rpc("pb_event_postcard_attach", { p_event: eventClientUuid(eventId), p_ticket_hash: hash(ticketHash), p_id: proposal.postcardId, p_submission: proposal.submissionId, p_source: proposal.source, p_design: proposal.design, ...auth });
      return parsed(() => parsePostcardView(normaliseDates(data), eventId, proposal.postcardId));
    },
    async view(eventId: string, tokenHash: string, guestId: string, postcardId: string) { const args = scope(eventId, tokenHash, guestId, postcardId); await ready(); const data = await rpc("pb_event_postcard_view", args); return parsed(() => parsePostcardView(normaliseDates(data), eventId, postcardId)); },
    async consent(eventId: string, tokenHash: string, guestId: string, postcardId: string, revision: number, consent: EventConsent) {
      const args = scope(eventId, tokenHash, guestId, postcardId); if (!Number.isSafeInteger(revision) || revision < 0) throw new EventStoreError("invalid_request", 400); const value = eventClientConsent(consent); await ready();
      const data = await rpc("pb_event_postcard_consent", { ...args, p_revision: revision, p_consent: value }); return parsed(() => parsePostcardView(normaliseDates(data), eventId, postcardId));
    },
    async reserve(eventId: string, tokenHash: string, guestId: string, postcardId: string, requestId: string, receiptHash: string) {
      const args = scope(eventId, tokenHash, guestId, postcardId); await ready(); const data = await rpc("pb_event_postcard_reserve", { ...args, p_request: eventClientUuid(requestId), p_receipt_hash: hash(receiptHash) });
      return parsed(() => { const b = eventClientObject(data, ["submissionId", "state", "logicalExpiresAt", "eventExpiresAt", "gallery", "wall", "stagingPath", "stagingHeldBytes", "derivativeHeldBytes"]); const { stagingPath, stagingHeldBytes, derivativeHeldBytes, ...fields } = b, receipt = parseEventReceipt(normaliseDates(fields)); if (stagingPath !== `${eventId}/${receipt.submissionId}/source` || !Number.isSafeInteger(stagingHeldBytes) || Number(stagingHeldBytes) < 0 || Number(stagingHeldBytes) > 2000000 || !Number.isSafeInteger(derivativeHeldBytes) || Number(derivativeHeldBytes) < 0 || Number(derivativeHeldBytes) > 2100000) throw new Error(); return receipt; });
    },
    async approve(eventId: string, tokenHash: string, guestId: string, postcardId: string, digest: string) { const args = scope(eventId, tokenHash, guestId, postcardId); await ready(); const data = await rpc("pb_event_postcard_approve", { ...args, p_digest: hash(digest) }); return parsed(() => parsePostcardView(normaliseDates(data), eventId, postcardId)); },
    async candidate(eventId: string, tokenHash: string, guestId: string, postcardId: string) {
      const args = scope(eventId, tokenHash, guestId, postcardId); await ready(); const data = await rpc("pb_event_postcard_candidate", args);
      return parsed(() => { const b = eventClientObject(data, ["revision", "sha256", "bytes", "width", "height", "mime", "submissionId", "bucket", "path", "expiresAt", "maxAgeSeconds"]); const { submissionId, bucket, path, expiresAt, maxAgeSeconds, ...value } = b, candidate = parsePostcardCandidate(value), id = eventClientUuid(submissionId); if (bucket !== "photobooth-events-v2" || path !== `${eventId}/${id}/image` || !Number.isInteger(maxAgeSeconds) || Number(maxAgeSeconds) < 1 || Number(maxAgeSeconds) > 300) throw new Error(); return { ...candidate, submissionId: id, bucket: "photobooth-events-v2" as const, path: path as string, expiresAt: eventInstant(expiresAt), maxAgeSeconds: maxAgeSeconds as number }; });
    },
  };
}
export type EventPostcardStore = ReturnType<typeof createEventPostcardStore>;
