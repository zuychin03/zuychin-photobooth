import { createHmac } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { exportInteger, exportObject, exportUuid, validateEventExportUpdates } from "../events/export-contract";
import { createEventExportStore, type EventExportStore } from "./event-export-store";
import { createEventObjects, EventObjectError, type EventSigningObjects } from "./event-objects";
import { createEventStore, EventStoreError, verifyEventActor, type EventStore, type VerifiedEventActor } from "./event-store";
import { canonicalPublicOrigin, privateJson, supabaseServiceOrigin } from "./cron-auth";
import { readSmallJson, requireSameOrigin, RequestValidationError } from "./request-security";

export interface EventExportRequestPorts {
  authenticate(token: string, env: Record<string, string | undefined>, signal: AbortSignal): Promise<VerifiedEventActor>;
  stores(env: Record<string, string | undefined>, signal: AbortSignal): { exports: EventExportStore; base: Pick<EventStore, "transportReady" | "rate">; objects: EventSigningObjects };
}
const production: EventExportRequestPorts = {
  async authenticate(token, env, signal) {
    const origin = supabaseServiceOrigin(env.NEXT_PUBLIC_SUPABASE_URL);
    if (!origin || !env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim()) throw new EventStoreError("unavailable", 503);
    const client = createClient(origin, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) }) } });
    return verifyEventActor({ getUser: () => client.auth.getUser(token) });
  },
  stores(env, signal) {
    const origin = supabaseServiceOrigin(env.NEXT_PUBLIC_SUPABASE_URL), key = env.SUPABASE_SERVICE_ROLE_KEY;
    if (!origin || !key?.trim()) throw new EventStoreError("unavailable", 503);
    const client = createClient(origin, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) }) } });
    const rpc = { rpc: async (name: string, args: Record<string, unknown>) => client.rpc(name, args) };
    return { exports: createEventExportStore(env, rpc), base: createEventStore(env, rpc), objects: createEventObjects({ origin, serviceRoleKey: key }) };
  },
};
function parseOperation(b: Record<string, unknown>) {
  const exact = (...keys: string[]) => exportObject(b, ["operation", ...keys]);
  try {
    switch (b.operation) {
      case "list": exact(); return { operation: b.operation } as const;
      case "create": exact("exportId", "generation", ...("afterSubmissionId" in b ? ["afterSubmissionId"] : [])); return { operation: b.operation, exportId: exportUuid(b.exportId), generation: exportInteger(b.generation, 0, 2147483646), after: b.afterSubmissionId === undefined ? undefined : exportUuid(b.afterSubmissionId) } as const;
      case "page": exact("exportId", "generation", ...["after", "limit"].filter(k => k in b)); return { operation: b.operation, exportId: exportUuid(b.exportId), generation: exportInteger(b.generation, 0, 2147483646), after: b.after === undefined ? -1 : exportInteger(b.after, -1, 99), limit: b.limit === undefined ? 10 : exportInteger(b.limit, 1, 10) } as const;
      case "guestbook": case "media": case "access": exact("exportId", "generation", "index"); return { operation: b.operation, exportId: exportUuid(b.exportId), generation: exportInteger(b.generation, 0, 2147483646), index: exportInteger(b.index, 0, 99) } as const;
      case "checkpoint": exact("exportId", "generation", "revision", "updates"); return { operation: b.operation, exportId: exportUuid(b.exportId), generation: exportInteger(b.generation, 0, 2147483646), revision: exportInteger(b.revision, 0, 999999), updates: validateEventExportUpdates(b.updates) } as const;
      case "retire": exact("exportId", "generation", "revision"); return { operation: b.operation, exportId: exportUuid(b.exportId), generation: exportInteger(b.generation, 0, 2147483645), revision: exportInteger(b.revision, 0, 1000000) } as const;
      default: throw new Error();
    }
  } catch { throw new RequestValidationError(400, "invalid_request"); }
}
export function createEventExportHandler(ports: EventExportRequestPorts = production, getEnv: () => Record<string, string | undefined> = () => process.env) {
  return async (request: Request, eventId: string): Promise<Response> => {
    const abort = new AbortController(), stop = () => abort.abort(), timer = setTimeout(stop, 45000);
    request.signal.addEventListener("abort", stop, { once: true }); if (request.signal.aborted) stop();
    const check = () => { if (abort.signal.aborted) throw new EventStoreError("unavailable", 503); };
    let abortListener: () => void = () => {}, retryAfter = 0;
    const cancelled = new Promise<never>((_, reject) => { abortListener = () => reject(new EventStoreError("unavailable", 503)); abort.signal.addEventListener("abort", abortListener, { once: true }); });
    const work = async () => {
      const env = getEnv(), secret = env.PB_EVENT_TRANSPORT_SECRET, url = new URL(request.url);
      if (env.PB_EVENTS_ENABLED !== "true" || !secret || secret.length < 32 || secret.length > 4096 || /\s/.test(secret)) throw new EventStoreError("unavailable", 503);
      if (request.method !== "POST") return privateJson({ error: "method_not_allowed" }, 405);
      const local = env.NODE_ENV === "development" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      if (url.protocol !== "https:" && !(local && url.protocol === "http:") || !local && !canonicalPublicOrigin(env.PB_PUBLIC_ORIGIN)) throw new EventStoreError("unavailable", 503);
      if (url.search) throw new RequestValidationError(400, "invalid_request"); requireSameOrigin(request, env); check();
      try { exportUuid(eventId); } catch { throw new RequestValidationError(400, "invalid_request"); }
      const token = /^Bearer ([^\s,]+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
      if (!token || token.length > 16384) throw new EventStoreError("access_denied", 401);
      const body = parseOperation(await readSmallJson(request)); check();
      const actor = await ports.authenticate(token, env, abort.signal); check();
      const { exports: store, base, objects } = ports.stores(env, abort.signal); await base.transportReady(); check();
      const key = createHmac("sha256", secret).update(JSON.stringify(["event-export", actor.id])).digest("hex"), rate = await base.rate(key, ["create", "checkpoint", "retire"].includes(body.operation) ? "write" : "read"); check();
      if (!rate.allowed) { retryAfter = Math.min(60, Math.max(1, rate.retryAfterSeconds)); throw new RequestValidationError(429, "rate_limited"); }
      let result: unknown;
      switch (body.operation) {
        case "guestbook": if (!store.guestbook) throw new EventStoreError("unavailable", 503); result = await store.guestbook(actor, eventId, body.exportId, body.generation, body.index); break;
        case "retire": result = await store.retire(actor, eventId, body.exportId, body.generation, body.revision); break;
        case "list": result = await store.list(actor, eventId); break;
        case "create": result = await store.create(actor, eventId, body.exportId, body.after, body.generation); break;
        case "page": result = await store.page(actor, eventId, body.exportId, body.generation, body.after, body.limit); break;
        case "checkpoint": result = await store.checkpoint(actor, eventId, body.exportId, body.generation, body.revision, body.updates); break;
        case "access": result = await store.access(actor, eventId, body.exportId, body.generation, body.index); break;
        case "media": {
          const access = await store.access(actor, eventId, body.exportId, body.generation, body.index); check();
          const signed = await objects.signRead(access, access.expiresAt, abort.signal); check();
          const fresh = await store.access(actor, eventId, body.exportId, body.generation, body.index); check();
          const { maxAgeSeconds: ignoredOld, ...original } = access, { maxAgeSeconds: ignoredNew, ...current } = fresh; void ignoredOld; void ignoredNew;
          if (JSON.stringify(original) !== JSON.stringify(current) || Date.parse(signed.expiresAt) <= Date.now() || Date.parse(signed.expiresAt) > Math.min(Date.parse(fresh.expiresAt), Date.now() + fresh.maxAgeSeconds * 1000)) throw new EventStoreError("access_denied", 403);
          result = { ...original, retainedUntil: original.expiresAt, expiresAt: signed.expiresAt, signedUrl: signed.signedUrl }; break;
        }
      }
      check(); return privateJson(result, body.operation === "create" ? 201 : 200);
    };
    try { return await Promise.race([work(), cancelled]); }
    catch (error) {
      if (error instanceof EventObjectError && error.code === "mint_expired") return privateJson({ error: "expired" }, 410);
      const status = error instanceof EventStoreError || error instanceof RequestValidationError ? error.status : 503, code = error instanceof EventStoreError ? error.code : status === 429 ? "rate_limited" : status === 403 ? "origin_denied" : [400, 413, 415].includes(status) ? "invalid_request" : "unavailable";
      const response = privateJson({ error: code }, status); if (status === 429) response.headers.set("Retry-After", String(retryAfter || 60)); return response;
    } finally { clearTimeout(timer); request.signal.removeEventListener("abort", stop); abort.signal.removeEventListener("abort", abortListener); abort.abort(); }
  };
}
