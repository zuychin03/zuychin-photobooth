import { createClient } from "@supabase/supabase-js";
import { EVENT_LIMITS, type EventCapabilities, type EventConsent, type EventCreateInput, type EventDashboard, type EventDestination, type EventErrorCode, type EventJob, type EventManageAction, type EventObjectAccess, type EventReceipt, type EventReservation, type EventUploadAuthorisation } from "../events/contract";
import { supabaseServiceOrigin } from "./cron-auth";
import { EVENT_TRANSPORT_LIMITS, type EventSession, type EventTokenKind } from "../events/contract";

export class EventStoreError extends Error {
  constructor(readonly code: EventErrorCode, readonly status: number) { super(code); }
}
const actors = new WeakMap<object, number>();
declare const actorBrand: unique symbol;
export interface VerifiedEventActor { readonly id: string; readonly [actorBrand]: true }
export async function verifyEventActor(auth: { getUser(): Promise<{ data: { user: { id: string } | null }; error: unknown }> }): Promise<VerifiedEventActor> {
  const result = await auth.getUser().catch(() => null);
  if (!result || result.error || !result.data.user || !uuid(result.data.user.id)) throw new EventStoreError("access_denied", 401);
  const actor = Object.freeze({ id: result.data.user.id }) as VerifiedEventActor; actors.set(actor, Date.now()); return actor;
}
export interface EventRpcClient { rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message?: string; code?: string } | null }> }
export interface EventStore {
  capabilities(): Promise<EventCapabilities>;
  transportReady(): Promise<void>;
  rate(key: string, bucket: "read" | "write" | "redeem"): Promise<{ allowed: boolean; retryAfterSeconds: number }>;
  session(eventId: string, tokenHash: string, kind: EventTokenKind, submissionId?: string): Promise<EventSession>;
  issue(actor: VerifiedEventActor, eventId: string, requestId: string, kind: "invite" | "gallery" | "display", tokenHash: string, expiresAt: string, rotate: boolean): Promise<{ kind: "invite" | "gallery" | "display"; expiresAt: string }>;
  create(actor: VerifiedEventActor, eventId: string, input: EventCreateInput): Promise<Record<string, unknown>>;
  manage(actor: VerifiedEventActor, eventId: string, action: EventManageAction, body?: Record<string, unknown>): Promise<Record<string, unknown>>;
  dashboard(actor: VerifiedEventActor, eventId: string, after?: string, limit?: number): Promise<EventDashboard>;
  redeem(eventId: string, inviteHash: string, guestId: string, contributeHash: string): Promise<{ guestId: string }>;
  reserve(input: { eventId: string; tokenHash: string; submissionId: string; requestId: string; receiptHash: string; contributors: string[]; consent: EventConsent }): Promise<EventReservation>;
  authoriseUpload(eventId: string, tokenHash: string, submissionId: string): Promise<EventUploadAuthorisation>;
  consent(eventId: string, tokenHash: string, submissionId: string, consent: EventConsent): Promise<EventReceipt>;
  receipt(eventId: string, receiptHash: string, submissionId: string): Promise<EventReceipt>;
  readAccess(eventId: string, tokenHash: string, submissionId: string, destination: "receipt" | EventDestination): Promise<EventObjectAccess>;
  enqueueFinalise(eventId: string, tokenHash: string, submissionId: string): Promise<EventReceipt>;
  claimJobs(limit?: number): Promise<EventJob[]>;
  checkpointJob(jobId: string, lease: string, checkpoint: Record<string, unknown>): Promise<EventJob>;
  finishJob(jobId: string, lease: string, outcome: "complete" | "retry" | "failed", error?: string): Promise<EventJob>;
  sweep(limit?: number): Promise<{ expired: number }>;
}
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const hash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const int = (value: unknown, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max;
const object = (value: unknown): Record<string, unknown> => { if (!value || typeof value !== "object" || Array.isArray(value)) throw new EventStoreError("unavailable", 503); return value as Record<string, unknown>; };
const invalid = (): never => { throw new EventStoreError("invalid_request", 400); };
const malformed = (): never => { throw new EventStoreError("unavailable", 503); };
const dates = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
const actorId = (actor: VerifiedEventActor) => { const at = actors.get(actor); if (at === undefined || Date.now() - at > 60000 || !uuid(actor.id)) throw new EventStoreError("access_denied", 401); return actor.id; };
export { actorId as eventActorId };
const identity = (...ids: unknown[]) => { if (!ids.every(uuid)) invalid(); };
const guestArgs = (event: string, token: string, submission: string) => { identity(event, submission); if (!hash(token)) invalid(); return { p_event: event, p_token: token, p_submission: submission }; };
const receipt = (input: unknown): EventReceipt => {
  const value = object(input);
  if (!uuid(value.submissionId) || !["reserved", "uploading", "finalising", "ready", "failed", "expired", "deleted"].includes(value.state as string) || !dates(value.logicalExpiresAt) || !dates(value.eventExpiresAt) || ![value.gallery, value.wall].every(item => ["private", "awaiting_approval", "approved", "hidden", "rejected"].includes(item as string))) malformed();
  return { submissionId: value.submissionId, state: value.state, logicalExpiresAt: value.logicalExpiresAt, eventExpiresAt: value.eventExpiresAt, gallery: value.gallery, wall: value.wall } as EventReceipt;
};
const job = (input: unknown): EventJob => {
  const value = object(input);
  if (![value.id, value.event_id, value.submission_id].every(uuid) || !["finalise", "delete_delivery", "delete_staging"].includes(value.kind as string) || !["queued", "running", "retry", "complete", "failed"].includes(value.status as string) || !int(value.attempts, 8) || value.lease_token !== null && !uuid(value.lease_token) || value.lease_until !== null && !dates(value.lease_until)) malformed();
  object(value.checkpoint); return value as unknown as EventJob;
};
export function createEventStore(env: Record<string, string | undefined> = process.env, providedClient?: EventRpcClient): EventStore {
  const origin = supabaseServiceOrigin(env.NEXT_PUBLIC_SUPABASE_URL), key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (env.PB_EVENTS_ENABLED !== "true" || !origin || !key?.trim()) throw new EventStoreError("unavailable", 503);
  const client = providedClient ?? (() => {
    const admin = createClient(origin, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: (input, init) => fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000) }) } });
    return { rpc: async (name: string, args: Record<string, unknown>) => { const { data, error } = await admin.rpc(name, args); return { data, error }; } };
  })();
  const rpc = async (name: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    if (new TextEncoder().encode(JSON.stringify(args)).length > 16384) invalid();
    const { data, error } = await client.rpc(name, args).catch(() => { throw new EventStoreError("unavailable", 503); });
    if (error) {
      const codes: Record<string, [EventErrorCode, number]> = { PB_EVENT_DENIED: ["access_denied", 403], PB_EVENT_INVALID: ["invalid_request", 400], PB_EVENT_CAPACITY: ["capacity", 409], PB_EVENT_CONFLICT: ["conflict", 409], PB_EVENT_EXPIRED: ["expired", 410], PB_EVENT_NOT_READY: ["not_ready", 409], PB_EVENT_LEASE: ["lease_lost", 409] };
      const [code, status] = codes[error.message ?? ""] ?? (error.code?.startsWith("22") || error.code?.startsWith("23") ? ["invalid_request", 400] : ["unavailable", 503]); throw new EventStoreError(code as EventErrorCode, status as number);
    }
    if (data === null || new TextEncoder().encode(JSON.stringify(data)).length > 256 * 1024) malformed(); return data;
  };
  const capabilities = async (): Promise<EventCapabilities> => {
    const value = object(await rpc("pb_event_capabilities")), limits = object(value.limits);
    if (value.version !== 1 || typeof value.ready !== "boolean" || !int(value.deploymentBytes) || !int(value.allocatedBytes) || Object.entries(EVENT_LIMITS).some(([name, expected]) => limits[name] !== expected)) malformed();
    return value as unknown as EventCapabilities;
  };
  const call = async (name: string, args: Record<string, unknown> = {}) => { if (!(await capabilities()).ready) throw new EventStoreError("not_ready", 503); return rpc(name, args); };
  return {
    capabilities,
    async transportReady() { const value = object(await rpc("pb_event_transport_capabilities")); if (Object.entries(EVENT_TRANSPORT_LIMITS).some(([field, expected]) => value[field] !== expected)) malformed(); },
    async rate(key, bucket) {
      if (!hash(key) || !["read", "write", "redeem"].includes(bucket)) invalid();
      const value = object(await rpc("pb_event_check_rate", { p_key: key, p_bucket: bucket }));
      if (typeof value.allowed !== "boolean" || !int(value.retryAfterSeconds, 60) || value.allowed && value.retryAfterSeconds !== 0 || !value.allowed && value.retryAfterSeconds === 0) malformed();
      return { allowed: value.allowed as boolean, retryAfterSeconds: value.retryAfterSeconds as number };
    },
    async session(eventId, tokenHash, kind, submissionId) {
      identity(eventId); if (!hash(tokenHash) || !["contribute", "receipt", "gallery", "display"].includes(kind) || (kind === "receipt") !== (submissionId !== undefined)) invalid(); if (submissionId !== undefined) identity(submissionId);
      const value = object(await call("pb_event_session", { p_event: eventId, p_hash: tokenHash, p_kind: kind, p_submission: submissionId ?? null }));
      if (value.eventId !== eventId || value.kind !== kind || value.submissionId !== (submissionId ?? null) || !dates(value.expiresAt) || (["contribute", "receipt"].includes(kind) ? !uuid(value.guestId) : value.guestId !== null)) malformed();
      return { eventId, kind, submissionId: submissionId ?? null, guestId: value.guestId as string | null, expiresAt: new Date(value.expiresAt as string).toISOString() };
    },
    async issue(actor, eventId, requestId, kind, tokenHash, expiresAt, rotate) {
      identity(eventId, requestId); if (!["invite", "gallery", "display"].includes(kind) || !hash(tokenHash) || !dates(expiresAt) || typeof rotate !== "boolean" || rotate && kind !== "invite") invalid();
      const value = object(await call("pb_event_issue_capability", { p_actor: actorId(actor), p_event: eventId, p_request: requestId, p_kind: kind, p_hash: tokenHash, p_expires: expiresAt, p_rotate: rotate }));
      if (value.kind !== kind || !dates(value.expiresAt) || Date.parse(value.expiresAt as string) > Date.parse(expiresAt)) malformed();
      return { kind, expiresAt: new Date(value.expiresAt as string).toISOString() };
    },
    async create(actor, eventId, input) { identity(eventId); return object(await call("pb_event_create", { p_actor: actorId(actor), p_event: eventId, p_body: input })); },
    async manage(actor, eventId, action, body = {}) { identity(eventId); return object(await call("pb_event_manage", { p_actor: actorId(actor), p_event: eventId, p_action: action, p_body: body })); },
    async dashboard(actor, eventId, after, limit = 25) {
      identity(eventId); if (after !== undefined) identity(after); if (!int(limit, 25) || limit < 1) invalid();
      const result = object(await call("pb_event_dashboard", { p_actor: actorId(actor), p_event: eventId, p_after: after ?? null, p_limit: limit })); object(result.event); const usage = object(result.usage);
      if (!Array.isArray(result.submissions) || result.submissions.length > limit || ["guests", "count", "bytes", "stagingBytes", "derivativeBytes"].some(field => !int(usage[field]))) return malformed();
      result.submissions.forEach(receipt); return result as unknown as EventDashboard;
    },
    async redeem(eventId, inviteHash, guestId, contributeHash) { identity(eventId, guestId); if (!hash(inviteHash) || !hash(contributeHash)) invalid(); const value = object(await call("pb_event_redeem", { p_event: eventId, p_invite_hash: inviteHash, p_guest: guestId, p_contribute_hash: contributeHash })); if (value.guestId !== guestId) malformed(); return { guestId }; },
    async reserve(input) { identity(input.requestId); if (!hash(input.receiptHash) || !Array.isArray(input.contributors) || input.contributors.length < 1 || input.contributors.length > 4) invalid(); identity(...input.contributors); const result = object(await call("pb_event_reserve", { ...guestArgs(input.eventId, input.tokenHash, input.submissionId), p_request: input.requestId, p_receipt_hash: input.receiptHash, p_contributors: input.contributors, p_consent: input.consent })); receipt(result); if (result.submissionId !== input.submissionId || result.stagingPath !== `${input.eventId}/${input.submissionId}/source` || !int(result.stagingHeldBytes, EVENT_LIMITS.imageBytes) || !int(result.derivativeHeldBytes, EVENT_LIMITS.derivativeBytes)) malformed(); return result as unknown as EventReservation; },
    async authoriseUpload(eventId, tokenHash, submissionId) {
      const value = object(await call("pb_event_authorise_upload", guestArgs(eventId, tokenHash, submissionId)));
      if (value.bucket !== "photobooth-event-images-staging-v2" || value.path !== `${eventId}/${submissionId}/source` || value.overwrite !== false || value.maxBytes !== EVENT_LIMITS.imageBytes || !int(value.generation, 8) || value.generation === 0 || !dates(value.mintBefore) || !dates(value.authorisationUntil) || !dates(value.cleanupAfter) || Date.parse(value.authorisationUntil as string) - Date.parse(value.mintBefore as string) !== 7200000 || Date.parse(value.cleanupAfter as string) - Date.parse(value.authorisationUntil as string) !== 300000) malformed();
      return value as unknown as EventUploadAuthorisation;
    },
    async consent(eventId, tokenHash, submissionId, consent) { return receipt(await call("pb_event_consent", { ...guestArgs(eventId, tokenHash, submissionId), p_consent: consent })); },
    async receipt(eventId, tokenHash, submissionId) { const value = receipt(await call("pb_event_receipt", guestArgs(eventId, tokenHash, submissionId))); if (value.submissionId !== submissionId) malformed(); return value; },
    async readAccess(eventId, tokenHash, submissionId, destination) { const value = object(await call("pb_event_read_access", { ...guestArgs(eventId, tokenHash, submissionId), p_destination: destination })); if (value.bucket !== "photobooth-events-v2" || value.path !== `${eventId}/${submissionId}/image` || !int(value.maxAgeSeconds, 300) || value.maxAgeSeconds === 0) malformed(); return value as unknown as EventObjectAccess; },
    async enqueueFinalise(eventId, tokenHash, submissionId) { const value = receipt(await call("pb_event_enqueue_finalise", guestArgs(eventId, tokenHash, submissionId))); if (value.submissionId !== submissionId) malformed(); return value; },
    async claimJobs(limit = 10) { if (!int(limit, 10) || limit < 1) invalid(); const value = await call("pb_event_claim_jobs", { p_limit: limit }); if (!Array.isArray(value) || value.length > limit) return malformed(); return value.map(job); },
    async checkpointJob(jobId, lease, checkpoint) { identity(jobId, lease); return job(await call("pb_event_checkpoint_job", { p_job: jobId, p_lease: lease, p_checkpoint: checkpoint })); },
    async finishJob(jobId, lease, outcome, error) { identity(jobId, lease); return job(await call("pb_event_finish_job", { p_job: jobId, p_lease: lease, p_outcome: outcome, p_error: error ?? null })); },
    async sweep(limit = 25) { if (!int(limit, 25) || limit < 1) invalid(); const value = object(await call("pb_event_sweep", { p_limit: limit })); if (!int(value.expired, limit)) malformed(); return { expired: value.expired as number }; },
  };
}
