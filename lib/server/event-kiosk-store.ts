import { createClient } from "@supabase/supabase-js";
import { EVENT_KIOSK_LIMITS, kioskObject, parseKioskApproval, parseKioskSession, parseKioskUnlock, type EventKioskApproval, type EventKioskReservation } from "../events/kiosk-contract";
import type { EventReceipt, EventUploadAuthorisation } from "../events/contract";
import { eventActorId, EventStoreError, type EventRpcClient, type VerifiedEventActor } from "./event-store";
import { eventInstant, eventInteger, eventUuid } from "./event-http-input";
import { supabaseServiceOrigin } from "./cron-auth";

const invalid = (): never => { throw new EventStoreError("invalid_request", 400); };
const malformed = (): never => { throw new EventStoreError("unavailable", 503); };
const hash = (value: string) => { if (!/^[a-f0-9]{64}$/.test(value)) invalid(); return value; };
function receipt(value: unknown, submissionId: string): EventReceipt {
  const b = kioskObject(value);
  if (b.submissionId !== submissionId || !["reserved", "uploading", "finalising", "ready", "failed", "expired", "deleted"].includes(String(b.state)) || ![b.gallery, b.wall].every(v => ["private", "awaiting_approval", "approved", "hidden", "rejected"].includes(String(v)))) return malformed();
  return { submissionId, state: b.state as EventReceipt["state"], logicalExpiresAt: eventInstant(b.logicalExpiresAt), eventExpiresAt: eventInstant(b.eventExpiresAt), gallery: b.gallery as EventReceipt["gallery"], wall: b.wall as EventReceipt["wall"] };
}
export function createEventKioskStore(env: Record<string, string | undefined> = process.env, provided?: EventRpcClient, signal?: AbortSignal) {
  const origin = supabaseServiceOrigin(env.NEXT_PUBLIC_SUPABASE_URL), key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (env.PB_EVENTS_ENABLED !== "true" || !origin || !key?.trim()) return malformed();
  const client = provided ?? (() => { const admin = createClient(origin, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.any([AbortSignal.timeout(8000), ...(signal ? [signal] : [])]) }) } }); return { rpc: async (name: string, args: Record<string, unknown>) => admin.rpc(name, args) }; })();
  const rpc = async (name: string, args: Record<string, unknown> = {}) => {
    if (signal?.aborted) return malformed();
    const result = await client.rpc(name, args).catch(malformed); if (signal?.aborted) return malformed();
    if (result.error) { const codes: Record<string, [ConstructorParameters<typeof EventStoreError>[0], number]> = { PB_EVENT_DENIED: ["access_denied", 403], PB_EVENT_EXPIRED: ["expired", 410], PB_EVENT_CONFLICT: ["conflict", 409], PB_EVENT_INVALID: ["invalid_request", 400], PB_EVENT_CAPACITY: ["capacity", 409], PB_EVENT_NOT_READY: ["not_ready", 409] }; const [code, status] = codes[result.error.message ?? ""] ?? ["unavailable", 503]; throw new EventStoreError(code, status); }
    if (result.data === null || new TextEncoder().encode(JSON.stringify(result.data)).length > 32768) return malformed(); return result.data;
  };
  const capabilities = async () => { const b = kioskObject(await rpc("pb_event_kiosk_capabilities")); if (Object.keys(b).length !== Object.keys(EVENT_KIOSK_LIMITS).length || Object.entries(EVENT_KIOSK_LIMITS).some(([k,v]) => b[k] !== v)) return malformed(); return EVENT_KIOSK_LIMITS; };
  const call = async (name: string, args: Record<string, unknown>) => { await capabilities(); return rpc(name, args); };
  const args = (eventId: string, token: string) => ({ p_event: eventUuid(eventId), p_token: hash(token) });
  const session = (value: unknown, eventId: string) => { try { const parsed = parseKioskSession(value, eventId); return { ...parsed, expiresAt: eventInstant(parsed.expiresAt) }; } catch { return malformed(); } };
  return {
    capabilities,
    async create(actor: VerifiedEventActor, eventId: string, deviceId: string, token: string, pin: string) { return session(await call("pb_event_kiosk_create", { ...args(eventId,token), p_actor: eventActorId(actor), p_device: eventUuid(deviceId), p_pin: hash(pin) }), eventId); },
    async session(eventId: string, token: string) { return session(await call("pb_event_kiosk_session", args(eventId,token)), eventId); },
    async begin(eventId: string, token: string, generation: number, guestId: string, contribution: string) { return session(await call("pb_event_kiosk_begin", { ...args(eventId,token), p_generation: eventInteger(generation,0,10000), p_guest: eventUuid(guestId), p_contribution: hash(contribution) }), eventId); },
    async reset(eventId: string, token: string, generation: number, requestId: string) { return session(await call("pb_event_kiosk_reset", { ...args(eventId,token), p_generation: eventInteger(generation,0,10000), p_request: eventUuid(requestId) }), eventId); },
    async unlock(eventId: string, token: string, pin: string, unlock: string) { const value = parseKioskUnlock(await call("pb_event_kiosk_unlock", { ...args(eventId,token), p_pin: hash(pin), p_unlock: hash(unlock) })); return { ...value, unlockedUntil: value.unlockedUntil ? eventInstant(value.unlockedUntil) : null }; },
    async operator(eventId: string, token: string, unlock: string) { const b = kioskObject(await call("pb_event_kiosk_operator", { ...args(eventId,token), p_unlock: hash(unlock) })); return { deviceId: eventUuid(b.deviceId), unlockedUntil: eventInstant(b.unlockedUntil) }; },
    async revoke(actor: VerifiedEventActor, eventId: string, deviceId: string) { const b = kioskObject(await call("pb_event_kiosk_revoke", { p_actor: eventActorId(actor), p_event: eventUuid(eventId), p_device: eventUuid(deviceId) })); if (b.revoked !== true) return malformed(); return { revoked: true as const }; },
    async reserve(input: { eventId: string; token: string; generation: number; guestId: string; contribution: string; submissionId: string; requestId: string; receipt: string; approval: EventKioskApproval }): Promise<EventKioskReservation> {
      let approval: EventKioskApproval; try { approval = parseKioskApproval(input.approval); } catch { return invalid(); }
      const b = kioskObject(await call("pb_event_kiosk_reserve", { ...args(input.eventId,input.token), p_generation: eventInteger(input.generation,0,10000), p_guest: eventUuid(input.guestId), p_contribution: hash(input.contribution), p_submission: eventUuid(input.submissionId), p_request: eventUuid(input.requestId), p_receipt: hash(input.receipt), p_approval: approval }));
      if (b.guestId !== input.guestId || b.generation !== input.generation || b.stagingPath !== `${input.eventId}/${input.submissionId}/source`) return malformed();
      return { ...receipt(b,input.submissionId), deviceId: eventUuid(b.deviceId), guestId: input.guestId, generation: input.generation, stagingPath: String(b.stagingPath), stagingHeldBytes: eventInteger(b.stagingHeldBytes,0,2000000), derivativeHeldBytes: eventInteger(b.derivativeHeldBytes,0,2100000) };
    },
    async job(eventId: string, token: string, generation: number, submissionId: string, operation: "status" | "finalise") { return receipt(await call("pb_event_kiosk_job", { ...args(eventId,token), p_generation: eventInteger(generation,0,10000), p_submission: eventUuid(submissionId), p_operation: operation }), submissionId); },
    async upload(eventId: string, token: string, generation: number, submissionId: string): Promise<EventUploadAuthorisation> {
      const b = kioskObject(await call("pb_event_kiosk_job", { ...args(eventId,token), p_generation: eventInteger(generation,0,10000), p_submission: eventUuid(submissionId), p_operation: "upload" }));
      if (b.bucket !== "photobooth-event-images-staging-v2" || b.path !== `${eventId}/${submissionId}/source` || b.maxBytes !== 2000000 || b.overwrite !== false) return malformed();
      return { bucket: b.bucket, path: b.path, generation: eventInteger(b.generation,1,8), mintBefore: eventInstant(b.mintBefore), authorisationUntil: eventInstant(b.authorisationUntil), cleanupAfter: eventInstant(b.cleanupAfter), maxBytes: 2000000, overwrite: false };
    },
  };
}
export type EventKioskStore = ReturnType<typeof createEventKioskStore>;
