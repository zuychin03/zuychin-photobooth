import { createHmac } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { eventClientObject, eventClientUuid } from "../events/client";
import { createEventReviewStore, type EventReviewStore } from "./event-review-store";
import { createEventObjects, type EventSigningObjects } from "./event-objects";
import { createEventStore, EventStoreError, verifyEventActor, type EventStore, type VerifiedEventActor } from "./event-store";
import { canonicalPublicOrigin, privateJson, supabaseServiceOrigin } from "./cron-auth";
import { readSmallJson, requireSameOrigin, RequestValidationError } from "./request-security";

export interface EventReviewRequestPorts {
  authenticate(token: string, env: Record<string, string | undefined>, signal: AbortSignal): Promise<VerifiedEventActor>;
  stores(env: Record<string, string | undefined>, signal: AbortSignal): { review: EventReviewStore; base: Pick<EventStore, "transportReady" | "rate">; objects: Pick<EventSigningObjects, "signRead"> };
}
const production: EventReviewRequestPorts = {
  async authenticate(token, env, signal) { const origin = supabaseServiceOrigin(env.NEXT_PUBLIC_SUPABASE_URL); if (!origin || !env.NEXT_PUBLIC_SUPABASE_ANON_KEY) throw new EventStoreError("unavailable", 503); const client = createClient(origin, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) }) } }); return verifyEventActor({ getUser: () => client.auth.getUser(token) }); },
  stores(env, signal) { const origin = supabaseServiceOrigin(env.NEXT_PUBLIC_SUPABASE_URL), key = env.SUPABASE_SERVICE_ROLE_KEY; if (!origin || !key) throw new EventStoreError("unavailable", 503); const client = createClient(origin, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) }) } }), rpc = { rpc: async (name: string, args: Record<string, unknown>) => client.rpc(name, args) }; return { review: createEventReviewStore(env, rpc), base: createEventStore(env, rpc), objects: createEventObjects({ origin, serviceRoleKey: key }) }; },
};
function operation(value: Record<string, unknown>) {
  try {
    if (value.operation === "capabilities") { eventClientObject(value, ["operation"]); return { operation: value.operation } as const; }
    if (value.operation === "list") { eventClientObject(value, ["operation"], ["after", "limit"]); const limit = value.limit ?? 12; if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 12) throw new Error(); return { operation: value.operation, after: value.after === undefined ? undefined : eventClientUuid(value.after), limit: limit as number } as const; }
    if (value.operation === "access" || value.operation === "media") { eventClientObject(value, ["operation", "submissionId"]); return { operation: value.operation, submissionId: eventClientUuid(value.submissionId) } as const; }
  } catch { /* Invalid shapes share one public error. */ }
  throw new RequestValidationError(400, "invalid_request");
}
export function createEventReviewHandler(ports: EventReviewRequestPorts = production, getEnv: () => Record<string, string | undefined> = () => process.env) {
  return async (request: Request, eventId: string): Promise<Response> => {
    const abort = new AbortController(), stop = () => abort.abort(), timer = setTimeout(stop, 45000); let retryAfter = 0, listener = () => {};
    request.signal.addEventListener("abort", stop, { once: true }); if (request.signal.aborted) stop();
    const check = () => { if (abort.signal.aborted) throw new EventStoreError("unavailable", 503); };
    const interrupted = new Promise<never>((_, reject) => { listener = () => reject(new EventStoreError("unavailable", 503)); abort.signal.addEventListener("abort", listener, { once: true }); });
    const work = async () => {
      const env = getEnv(), url = new URL(request.url), secret = env.PB_EVENT_TRANSPORT_SECRET;
      if (env.PB_EVENTS_ENABLED !== "true" || !secret || secret.length < 32 || secret.length > 4096 || /\s/.test(secret)) throw new EventStoreError("unavailable", 503);
      if (request.method !== "POST") return privateJson({ error: "method_not_allowed" }, 405);
      const local = env.NODE_ENV === "development" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      if (url.protocol !== "https:" && !(local && url.protocol === "http:") || !local && !canonicalPublicOrigin(env.PB_PUBLIC_ORIGIN)) throw new EventStoreError("unavailable", 503);
      if (url.search) throw new RequestValidationError(400, "invalid_request"); requireSameOrigin(request, env); check();
      try { eventClientUuid(eventId); } catch { throw new RequestValidationError(400, "invalid_request"); }
      const token = /^Bearer ([^\s,]+)$/i.exec(request.headers.get("authorization") ?? "")?.[1]; if (!token || token.length > 16384) throw new EventStoreError("access_denied", 401);
      const input = operation(await readSmallJson(request)); check(); const actor = await ports.authenticate(token, env, abort.signal); check();
      const { review, base, objects } = ports.stores(env, abort.signal); await base.transportReady(); check();
      const rate = await base.rate(createHmac("sha256", secret).update(JSON.stringify(["event-review", actor.id])).digest("hex"), "read"); check(); if (!rate.allowed) { retryAfter = Math.min(60, Math.max(1, rate.retryAfterSeconds)); throw new RequestValidationError(429, "rate_limited"); }
      if (input.operation === "capabilities") return privateJson(await review.capabilities());
      if (input.operation === "list") { const result = await review.list(actor, eventId, input.after, input.limit); check(); return privateJson(result); }
      const access = await review.access(actor, eventId, input.submissionId); check();
      if (input.operation === "access") return privateJson(access);
      const signed = await objects.signRead(access, access.expiresAt, abort.signal); check(); const fresh = await review.access(actor, eventId, input.submissionId); check();
      const { maxAgeSeconds: age, ...original } = access, { maxAgeSeconds: freshAge, ...current } = fresh; void age;
      if (JSON.stringify(original) !== JSON.stringify(current) || Date.parse(signed.expiresAt) <= Date.now() || Date.parse(signed.expiresAt) > Math.min(Date.parse(fresh.expiresAt), Date.now() + freshAge * 1000)) throw new EventStoreError("access_denied", 403);
      return privateJson({ ...original, retainedUntil: original.expiresAt, expiresAt: signed.expiresAt, signedUrl: signed.signedUrl });
    };
    try { return await Promise.race([work(), interrupted]); }
    catch (e) { const status = e instanceof EventStoreError || e instanceof RequestValidationError ? e.status : 503, code = e instanceof EventStoreError ? e.code : status === 429 ? "rate_limited" : status === 403 ? "origin_denied" : [400, 413, 415].includes(status) ? "invalid_request" : "unavailable", response = privateJson({ error: code }, status); if (status === 429) response.headers.set("Retry-After", String(retryAfter || 60)); return response; }
    finally { clearTimeout(timer); request.signal.removeEventListener("abort", stop); abort.signal.removeEventListener("abort", listener); abort.abort(); }
  };
}
