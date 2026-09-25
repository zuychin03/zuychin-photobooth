import { eventInstant } from "./event-http-input";
import { createClient } from "@supabase/supabase-js";
import { EVENT_REVIEW_LIMITS, parseEventReviewAccess, parseEventReviewPage, type EventReviewAccess, type EventReviewPage } from "../events/review-contract";
import { eventClientObject, eventClientUuid } from "../events/client";
import { createEventStore, eventActorId, EventStoreError, type EventRpcClient, type VerifiedEventActor } from "./event-store";
import { supabaseServiceOrigin } from "./cron-auth";

function normaliseDates(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid event response");
  const result = { ...value } as Record<string, unknown>;
  for (const key of ["createdAt","logicalExpiresAt","eventExpiresAt","expiresAt"]) if (Object.hasOwn(result, key)) result[key] = eventInstant(result[key]);
  if (Array.isArray(result.entries)) result.entries = result.entries.map(normaliseDates);
  return result;
}

export interface EventReviewStore {
  capabilities(): Promise<typeof EVENT_REVIEW_LIMITS>;
  list(actor: VerifiedEventActor, eventId: string, after?: string, limit?: number): Promise<EventReviewPage>;
  access(actor: VerifiedEventActor, eventId: string, submissionId: string): Promise<EventReviewAccess>;
}
export function createEventReviewStore(env: Record<string, string | undefined> = process.env, provided?: EventRpcClient): EventReviewStore {
  const origin = supabaseServiceOrigin(env.NEXT_PUBLIC_SUPABASE_URL), key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (env.PB_EVENTS_ENABLED !== "true" || !origin || !key?.trim()) throw new EventStoreError("unavailable", 503);
  const client = provided ?? (() => { const admin = createClient(origin, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: (url, init) => fetch(url, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000) }) } }); return { rpc: async (name: string, args: Record<string, unknown>) => admin.rpc(name, args) }; })();
  const base = createEventStore(env, client);
  const rpc = async (name: string, args: Record<string, unknown> = {}) => {
    const { data, error } = await client.rpc(name, args).catch(() => { throw new EventStoreError("unavailable", 503); });
    if (error) throw new EventStoreError(error.message === "PB_EVENT_DENIED" ? "access_denied" : error.message === "PB_EVENT_INVALID" ? "invalid_request" : "unavailable", error.message === "PB_EVENT_DENIED" ? 403 : error.message === "PB_EVENT_INVALID" ? 400 : 503);
    if (data === null || new TextEncoder().encode(JSON.stringify(data)).length > 16384) throw new EventStoreError("unavailable", 503); return data;
  };
  const parsed = <T>(fn: () => T): T => { try { return fn(); } catch { throw new EventStoreError("unavailable", 503); } };
  const capabilities = async () => { const b = await rpc("pb_event_review_capabilities"); parsed(() => { eventClientObject(b, Object.keys(EVENT_REVIEW_LIMITS)); if (Object.entries(EVENT_REVIEW_LIMITS).some(([key, value]) => (b as Record<string, unknown>)[key] !== value)) throw new Error(); }); return EVENT_REVIEW_LIMITS; };
  const ready = async () => { await capabilities(); if (!(await base.capabilities()).ready) throw new EventStoreError("not_ready", 503); };
  const subject = (actor: VerifiedEventActor, event: string) => { const actorId = eventActorId(actor); try { return { p_actor: actorId, p_event: eventClientUuid(event) }; } catch { throw new EventStoreError("invalid_request", 400); } };
  return { capabilities,
    async list(actor, eventId, after, limit = 12) { const args = subject(actor, eventId); if (!Number.isInteger(limit) || limit < 1 || limit > 12) throw new EventStoreError("invalid_request", 400); if (after !== undefined) { try { eventClientUuid(after); } catch { throw new EventStoreError("invalid_request", 400); } } await ready(); const data = await rpc("pb_event_review_list", { ...args, p_after: after ?? null, p_limit: limit }); return parsed(() => parseEventReviewPage(normaliseDates(data), eventId, after, limit)); },
    async access(actor, eventId, submissionId) { const args = subject(actor, eventId); try { eventClientUuid(submissionId); } catch { throw new EventStoreError("invalid_request", 400); } await ready(); const data = await rpc("pb_event_review_access", { ...args, p_submission: submissionId }); return parsed(() => parseEventReviewAccess(normaliseDates(data), eventId, submissionId)); },
  };
}
