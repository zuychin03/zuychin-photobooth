import { createHash, createHmac } from "node:crypto";
import { isIP } from "node:net";
import { createClient } from "@supabase/supabase-js";
import { createEventPublicationStore, EventPublicationError, type EventPublicationStore } from "./event-publication-store";
import { createEventObjects, type EventSigningObjects } from "./event-objects";
import { createEventStore, EventStoreError, verifyEventActor, type EventStore, type VerifiedEventActor } from "./event-store";
import { canonicalPublicOrigin, privateJson, supabaseServiceOrigin } from "./cron-auth";
import { eventInteger, eventObject, eventSecret, eventUuid } from "./event-http-input";
import { readSmallJson, requireSameOrigin, RequestValidationError } from "./request-security";
import type { EventDestination, EventReportReason } from "../events/publication-contract";

export interface EventPublicationPorts {
  authenticate(token: string, env: Record<string, string | undefined>, signal: AbortSignal): Promise<VerifiedEventActor>;
  stores(env: Record<string, string | undefined>, signal: AbortSignal): { publication: EventPublicationStore; base: Pick<EventStore, "transportReady" | "rate">; objects: Pick<EventSigningObjects, "signRead"> };
}
const production: EventPublicationPorts = {
  async authenticate(token, env, signal) { const origin = supabaseServiceOrigin(env.NEXT_PUBLIC_SUPABASE_URL); if (!origin || !env.NEXT_PUBLIC_SUPABASE_ANON_KEY) throw new EventPublicationError("unavailable", 503); const client = createClient(origin, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) }) } }); return verifyEventActor({ getUser: () => client.auth.getUser(token) }); },
  stores(env, signal) { const origin = supabaseServiceOrigin(env.NEXT_PUBLIC_SUPABASE_URL), key = env.SUPABASE_SERVICE_ROLE_KEY; if (!origin || !key?.trim()) throw new EventPublicationError("unavailable", 503); const admin = createClient(origin, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) }) } }), rpc = { rpc: async (name: string, args: Record<string, unknown>) => admin.rpc(name, args) }; return { publication: createEventPublicationStore(env, rpc), base: createEventStore(env, rpc), objects: createEventObjects({ origin, serviceRoleKey: key }) }; },
};
const cookieName = (destination: EventDestination, secure: boolean) => `${secure ? "__Host-" : ""}pb-event-${destination === "wall" ? "display" : "gallery"}`;
function cookie(request: Request, destination: EventDestination, secure: boolean) {
  const header = request.headers.get("cookie") ?? ""; if (header.length > 16384) throw new EventPublicationError("access_denied", 403);
  const candidates = header.split(";").map(p => p.trim().split("=")).filter(([key]) => key === cookieName(destination, secure));
  if (candidates.length !== 1 || candidates[0].length !== 2) throw new EventPublicationError("access_denied", 403);
  try { return eventSecret(candidates[0][1]); } catch { throw new EventPublicationError("access_denied", 403); }
}
export function createEventPublicationHandler(route: EventDestination | "moderation", ports: EventPublicationPorts = production, getEnv: () => Record<string, string | undefined> = () => process.env) {
  return async (request: Request, eventId: string): Promise<Response> => {
    const abort = new AbortController(), stop = () => abort.abort(), timer = setTimeout(stop, 15000); let retryAfter = 0, listener = () => {};
    request.signal.addEventListener("abort", stop, { once: true }); if (request.signal.aborted) stop();
    const check = () => { if (abort.signal.aborted) throw new EventPublicationError("unavailable", 503); };
    const interrupted = new Promise<never>((_, reject) => { listener = () => reject(new EventPublicationError("unavailable", 503)); abort.signal.addEventListener("abort", listener, { once: true }); if (abort.signal.aborted) listener(); });
    const work = async () => {
      const env = getEnv(), url = new URL(request.url), secret = env.PB_EVENT_TRANSPORT_SECRET;
      if (env.PB_EVENTS_ENABLED !== "true" || !secret || secret.length < 32 || secret.length > 4096 || /\s/.test(secret)) throw new EventPublicationError("unavailable", 503);
      if (request.method !== "POST") return privateJson({ error: "method_not_allowed" }, 405);
      const local = env.NODE_ENV === "development" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname), secure = !local;
      if (url.protocol !== "https:" && !(local && url.protocol === "http:") || !local && !canonicalPublicOrigin(env.PB_PUBLIC_ORIGIN)) throw new EventPublicationError("unavailable", 503);
      if (url.search) throw new RequestValidationError(400, "invalid_request"); requireSameOrigin(request, env); eventUuid(eventId); check();
      const b = await readSmallJson(request); check(); if (typeof b.operation !== "string") throw new RequestValidationError(400, "invalid_request");
      const { publication, base, objects } = ports.stores(env, abort.signal); await base.transportReady(); check();
      const rate = async (key: string, bucket: "read" | "write" | "redeem") => { const v = await base.rate(createHmac("sha256", secret).update(`publication:${key}`).digest("hex"), bucket); check(); if (!v.allowed) { retryAfter = Math.min(60, Math.max(1, v.retryAfterSeconds)); throw new RequestValidationError(429, "rate_limited"); } };
      const shape = (required: string[] = [], optional: string[] = []) => eventObject(b, ["operation", ...required], optional);
      const pagination = () => ({ after: b.after === undefined ? undefined : eventUuid(b.after), limit: b.limit === undefined ? 12 : eventInteger(b.limit, 1, 12) });
      if (route === "moderation") {
        const token = /^Bearer ([^\s,]+)$/i.exec(request.headers.get("authorization") ?? "")?.[1]; if (!token || token.length > 16384) throw new EventPublicationError("access_denied", 401);
        const actor = await ports.authenticate(token, env, abort.signal); check(); await rate(`actor:${actor.id}`, ["capabilities", "list", "reports"].includes(b.operation) ? "read" : "write");
        if (b.operation === "capabilities") { shape(); return privateJson(await publication.capabilities()); }
        if (b.operation === "list" || b.operation === "reports") { shape([], ["after", "limit"]); const p = pagination(), result = b.operation === "list" ? await publication.moderation(actor, eventId, p.after, p.limit) : await publication.reports(actor, eventId, p.after, p.limit); check(); return privateJson(result); }
        if (b.operation === "decide") { shape(["submissionId", "destination", "expectedRevision", "state"], ["requestId"]); if (!["gallery", "wall"].includes(String(b.destination)) || !["approved", "hidden", "rejected"].includes(String(b.state))) throw new RequestValidationError(400, "invalid_request"); const result = await publication.decide(actor, eventId, { submissionId: eventUuid(b.submissionId), destination: b.destination as EventDestination, expectedRevision: eventInteger(b.expectedRevision, 0, Number.MAX_SAFE_INTEGER), state: b.state as "approved" | "hidden" | "rejected", ...(b.requestId === undefined ? {} : { requestId: eventUuid(b.requestId) }) }); check(); return privateJson(result); }
        if (b.operation === "remove") { shape(["submissionId", "expectedRevision"]); const result = await publication.remove(actor, eventId, eventUuid(b.submissionId), eventInteger(b.expectedRevision, 0, Number.MAX_SAFE_INTEGER)); check(); return privateJson(result); }
        if (b.operation === "report") { shape(["submissionId", "destination", "requestId", "reason", "detail"]); if (!["gallery", "wall"].includes(String(b.destination)) || !["privacy", "inappropriate", "other"].includes(String(b.reason)) || typeof b.detail !== "string" || [...b.detail].length > 500 || /[\u0000-\u001f\u007f]/.test(b.detail)) throw new RequestValidationError(400, "invalid_request"); const result = await publication.hostReport(actor, eventId, { submissionId: eventUuid(b.submissionId), destination: b.destination as EventDestination, requestId: eventUuid(b.requestId), reason: b.reason as EventReportReason, detail: b.detail }); check(); return privateJson(result); }
        if (b.operation === "resolve") { shape(["reportId"]); const result = await publication.resolve(actor, eventId, eventUuid(b.reportId)); check(); return privateJson(result); }
        throw new RequestValidationError(400, "invalid_request");
      }
      const ipHeader = env.PB_EVENT_TRUSTED_IP_HEADER, ip = ipHeader && /^[a-z][a-z0-9-]{0,63}$/.test(ipHeader) ? request.headers.get(ipHeader)?.trim() : local ? "127.0.0.1" : null;
      if (!ip || !isIP(ip)) throw new EventPublicationError("unavailable", 503);
      const bucket = b.operation === "exchange" ? "redeem" : b.operation === "report" ? "write" : "read";
      await rate(`ip:${isIP(ip) === 6 ? new URL(`http://[${ip}]`).hostname : ip}`, bucket);
      if (b.operation === "capabilities") { shape(); return privateJson(await publication.capabilities()); }
      const token = b.operation === "exchange" ? eventSecret(b.token) : cookie(request, route, secure), hash = createHash("sha256").update(token).digest("hex"); await rate(`audience:${eventId}:${route}:${hash}`, bucket);
      if (b.operation === "exchange" || b.operation === "session") {
        shape(b.operation === "exchange" ? ["token"] : []); const session = await publication.session(eventId, hash, route); check(); const response = privateJson(session);
        if (b.operation === "exchange") { const seconds = Math.min(30 * 86400, Math.floor((Date.parse(session.expiresAt) - Date.now()) / 1000)); if (seconds < 1) throw new EventPublicationError("expired", 410); response.headers.append("Set-Cookie", `${cookieName(route, secure)}=${token}; Path=${secure ? "/" : "/api/events"}; Max-Age=${seconds}; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`); }
        return response;
      }
      const sessionId = eventUuid(b.expectedSessionId);
      if (b.operation === "list") { shape(["expectedSessionId"], ["after", "limit"]); const p = pagination(), result = await publication.list(eventId, hash, route, sessionId, p.after, p.limit); check(); return privateJson(result); }
      if (b.operation === "validate") { shape(["expectedSessionId", "submissionIds"]); if (!Array.isArray(b.submissionIds) || b.submissionIds.length > 12 || new Set(b.submissionIds).size !== b.submissionIds.length) throw new RequestValidationError(400, "invalid_request"); const result = await publication.validate(eventId, hash, route, sessionId, b.submissionIds.map(eventUuid)); check(); return privateJson(result); }
      if (b.operation === "report") { shape(["expectedSessionId", "requestId", "submissionId", "reason", "detail"]); if (!["privacy", "inappropriate", "other"].includes(String(b.reason)) || typeof b.detail !== "string" || [...b.detail].length > 500 || /[\u0000-\u001f\u007f]/.test(b.detail)) throw new RequestValidationError(400, "invalid_request"); const result = await publication.report(eventId, hash, route, sessionId, { requestId: eventUuid(b.requestId), submissionId: eventUuid(b.submissionId), reason: b.reason as EventReportReason, detail: b.detail }); check(); return privateJson(result); }
      if (b.operation === "access" || b.operation === "media") {
        shape(["expectedSessionId", "submissionId", "variant"]); if (b.variant !== "thumbnail" && b.variant !== "image" || route === "wall" && b.variant !== "thumbnail") throw new RequestValidationError(400, "invalid_request");
        const id = eventUuid(b.submissionId), access = await publication.access(eventId, hash, route, sessionId, id, b.variant); check(); if (b.operation === "access") return privateJson(access);
        const signed = await objects.signRead(access, access.expiresAt, abort.signal); check(); const fresh = await publication.access(eventId, hash, route, sessionId, id, b.variant); check();
        const { maxAgeSeconds: age, ...original } = access, { maxAgeSeconds: freshAge, ...current } = fresh; void age;
        if (JSON.stringify(original) !== JSON.stringify(current) || Date.parse(signed.expiresAt) <= Date.now() || Date.parse(signed.expiresAt) > Math.min(Date.parse(fresh.expiresAt), Date.now() + freshAge * 1000)) throw new EventPublicationError("access_denied", 403);
        return privateJson({ ...original, retainedUntil: original.expiresAt, expiresAt: signed.expiresAt, signedUrl: signed.signedUrl });
      }
      throw new RequestValidationError(400, "invalid_request");
    };
    try { return await Promise.race([work(), interrupted]); }
    catch (e) { const status = e instanceof EventPublicationError || e instanceof EventStoreError || e instanceof RequestValidationError ? e.status : 503, code = e instanceof EventPublicationError || e instanceof EventStoreError ? e.code : status === 429 ? "rate_limited" : status === 403 ? "origin_denied" : [400, 413, 415].includes(status) ? "invalid_request" : "unavailable", response = privateJson({ error: code }, status); if (status === 429) response.headers.set("Retry-After", String(retryAfter || 60)); return response; }
    finally { clearTimeout(timer); request.signal.removeEventListener("abort", stop); abort.signal.removeEventListener("abort", listener); abort.abort(); }
  };
}
