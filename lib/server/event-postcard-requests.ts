import { createHash, createHmac } from "node:crypto";
import { isIP } from "node:net";
import { createClient } from "@supabase/supabase-js";
import { createEventPostcardStore, EventPostcardError, type EventPostcardStore } from "./event-postcard-store";
import { createEventStore, EventStoreError, verifyEventActor, type EventStore, type VerifiedEventActor } from "./event-store";
import { createEventObjects, type EventSigningObjects } from "./event-objects";
import { canonicalPublicOrigin, privateJson, supabaseServiceOrigin } from "./cron-auth";
import { requireSameOrigin, RequestValidationError } from "./request-security";
import { eventConsent, eventInteger, eventObject, eventSecret, eventUuid } from "./event-http-input";
import { parsePostcardProposal, parsePostcardSource } from "../events/postcard-contract";

export interface EventPostcardRequestPorts {
  open(env: Record<string, string | undefined>, signal: AbortSignal): { postcards: EventPostcardStore; events: Pick<EventStore, "transportReady" | "rate">; objects: Pick<EventSigningObjects, "signRead"> };
  authenticate(token: string, env: Record<string, string | undefined>, signal: AbortSignal): Promise<VerifiedEventActor>;
}
const production: EventPostcardRequestPorts = {
  open(env, signal) { const origin = supabaseServiceOrigin(env.NEXT_PUBLIC_SUPABASE_URL), key = env.SUPABASE_SERVICE_ROLE_KEY; if (!origin || !key?.trim()) throw new EventStoreError("unavailable", 503); const admin = createClient(origin, key, { auth: { autoRefreshToken: false, persistSession: false }, global: { fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) }) } }), rpc = { rpc: async (name: string, args: Record<string, unknown>) => admin.rpc(name, args) }; return { postcards: createEventPostcardStore(rpc), events: createEventStore(env, rpc), objects: createEventObjects({ origin, serviceRoleKey: key }) }; },
  async authenticate(token, env, signal) { const origin = supabaseServiceOrigin(env.NEXT_PUBLIC_SUPABASE_URL), key = env.NEXT_PUBLIC_SUPABASE_ANON_KEY; if (!origin || !key) throw new EventStoreError("unavailable", 503); const client = createClient(origin, key, { auth: { autoRefreshToken: false, persistSession: false }, global: { fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) }) } }); return verifyEventActor({ getUser: () => client.auth.getUser(token) }); },
};
const digest = (token: string) => createHash("sha256").update(token).digest("hex");
const cookie = (request: Request, name: string) => { const header = request.headers.get("cookie") ?? ""; if (header.length > 16384) throw new EventStoreError("access_denied", 403); const found = header.split(";").map(v => v.trim().split("=")).filter(([key]) => key === name); if (found.length !== 1 || found[0].length !== 2) throw new EventStoreError("access_denied", 403); try { return eventSecret(found[0][1]); } catch { throw new EventStoreError("access_denied", 403); } };
async function body(request: Request, signal: AbortSignal, maximum: number) {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new RequestValidationError(415, "invalid_request");
  const declared = Number(request.headers.get("content-length") ?? 0); if (!Number.isSafeInteger(declared) || declared < 0 || declared > maximum || !request.body) throw new RequestValidationError(413, "invalid_request");
  const reader = request.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  const cancel = () => { void reader.cancel().catch(() => undefined); }; signal.addEventListener("abort", cancel, { once: true });
  try { while (true) { if (signal.aborted) throw new EventStoreError("unavailable", 503); const part = await reader.read(); if (signal.aborted) throw new EventStoreError("unavailable", 503); if (part.done) break; size += part.value.length; if (size > maximum || chunks.length >= 128) throw new RequestValidationError(413, "invalid_request"); chunks.push(part.value); } }
  finally { signal.removeEventListener("abort", cancel); void reader.cancel().catch(() => undefined); reader.releaseLock(); }
  const bytes = new Uint8Array(size); let at = 0; for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
  try { const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(); return parsed as Record<string, unknown>; } catch { throw new RequestValidationError(400, "invalid_request"); }
}
export function createEventPostcardHandler(route: "event" | "room" | "challenge", ports: EventPostcardRequestPorts = production, getEnv: () => Record<string, string | undefined> = () => process.env) {
  return async (request: Request, id: string): Promise<Response> => {
    const abort = new AbortController(), signal = AbortSignal.any([request.signal, abort.signal]); let listener = () => {}, retry = 0;
    const timer = setTimeout(() => abort.abort(), 20000), interrupted = new Promise<never>((_, reject) => { listener = () => reject(new EventStoreError("unavailable", 503)); signal.addEventListener("abort", listener, { once: true }); if (signal.aborted) listener(); });
    const check = () => { if (signal.aborted) throw new EventStoreError("unavailable", 503); };
    const work = async () => {
      const env = getEnv(), url = new URL(request.url), secret = env.PB_EVENT_TRANSPORT_SECRET, local = env.NODE_ENV === "development" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname), secure = !local;
      if (env.PB_EVENTS_ENABLED !== "true" || !secret || secret.length < 32 || secret.length > 4096 || /\s/.test(secret) || route === "room" && env.PB_ROOM_V2_ENABLED !== "true" || route === "challenge" && (env.PB_CLOUD_PROJECTS_ENABLED !== "true" || env.PB_CHALLENGES_ENABLED !== "true")) throw new EventStoreError("unavailable", 503);
      if (request.method !== "POST") return privateJson({ error: "method_not_allowed" }, 405);
      if (url.protocol !== "https:" && !(local && url.protocol === "http:") || !local && !canonicalPublicOrigin(env.PB_PUBLIC_ORIGIN)) throw new EventStoreError("unavailable", 503);
      if (url.search) throw new RequestValidationError(400, "invalid_request"); requireSameOrigin(request, env); eventUuid(id); check();
      const b = await body(request, signal, route === "event" ? 8192 : 80000); check(); const shape = (required: string[]) => eventObject(b, ["operation", ...required]);
      const ipHeader = env.PB_EVENT_TRUSTED_IP_HEADER, ip = ipHeader && /^[a-z][a-z0-9-]{0,63}$/.test(ipHeader) ? request.headers.get(ipHeader)?.trim() : local ? "127.0.0.1" : null; if (!ip || !isIP(ip)) throw new EventStoreError("unavailable", 503);
      const { postcards, events, objects } = ports.open(env, signal); await events.transportReady(); check();
      const derive = (...values: unknown[]) => createHmac("sha256", secret).update(JSON.stringify(values)).digest("base64url");
      const rate = async (key: string) => { const value = await events.rate(digest(derive("postcard-rate", key)), ["view", "proposal", "candidate", "capabilities"].includes(String(b.operation)) ? "read" : "write"); check(); if (!value.allowed) { retry = Math.max(1, Math.min(60, value.retryAfterSeconds)); throw new RequestValidationError(429, "rate_limited"); } };
      await rate(`ip:${isIP(ip) === 6 ? new URL(`http://[${ip}]`).hostname : ip}`);
      if (b.operation === "capabilities") { shape([]); return privateJson(await postcards.capabilities()); }
      if (route !== "event") {
        if (b.operation !== "attach" && b.operation !== "proposal") throw new RequestValidationError(400, "invalid_request");
        shape(b.operation === "attach" ? ["eventId", "ticket", "proposal"] : ["postcardId", "source"]);
        let proposal, source; try { proposal = b.operation === "attach" ? parsePostcardProposal(b.proposal) : null; source = proposal?.source ?? parsePostcardSource(b.source); } catch { throw new RequestValidationError(400, "invalid_request"); }
        if (source.id !== id || route === "room" !== (source.kind === "room")) throw new RequestValidationError(400, "invalid_request");
        let authority;
        if (route === "room") { const roomHash = digest(cookie(request, `${secure ? "__Secure-" : ""}pb-room-${id}`)); await rate(`room:${id}:${roomHash}`); authority = { roomHash }; }
        else { const token = /^Bearer ([^\s,]+)$/i.exec(request.headers.get("authorization") ?? "")?.[1]; if (!token || token.length > 16384) throw new EventStoreError("access_denied", 401); const actor = await ports.authenticate(token, env, signal); check(); await rate(`actor:${actor.id}`); authority = { actor }; }
        const result = proposal ? await postcards.attach(eventUuid(b.eventId), digest(eventSecret(b.ticket)), proposal, authority) : await postcards.proposal(eventUuid(b.postcardId), source, authority); check(); return privateJson(result);
      }
      const guestId = eventUuid(b.expectedGuestId), postcardId = eventUuid(b.postcardId), hash = digest(cookie(request, `${secure ? "__Host-" : ""}pb-event-contribute`)); await rate(`guest:${id}:${hash}`);
      const required = ["expectedGuestId", "postcardId"];
      if (b.operation === "ticket") { shape([...required, "requestId"]); const requestId = eventUuid(b.requestId), ticket = derive("postcard-ticket", id, guestId, postcardId, requestId, hash); const result = await postcards.ticket(id, hash, guestId, postcardId, requestId, digest(ticket)); check(); return privateJson({ ...result, ticket }); }
      if (b.operation === "view") { shape(required); const result = await postcards.view(id, hash, guestId, postcardId); check(); return privateJson(result); }
      if (b.operation === "scopeConsent") { shape([...required, "expectedRevision", "consent"]); const result = await postcards.consent(id, hash, guestId, postcardId, eventInteger(b.expectedRevision, 0, Number.MAX_SAFE_INTEGER), eventConsent(b.consent)); check(); return privateJson(result); }
      if (b.operation === "approveCandidate") { shape([...required, "sha256"]); if (typeof b.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(b.sha256)) throw new RequestValidationError(400, "invalid_request"); const result = await postcards.approve(id, hash, guestId, postcardId, b.sha256); check(); return privateJson(result); }
      if (b.operation === "reserve") { shape([...required, "requestId"]); const requestId = eventUuid(b.requestId), receiptToken = derive("postcard-receipt", id, guestId, postcardId, requestId, hash); const receipt = await postcards.reserve(id, hash, guestId, postcardId, requestId, digest(receiptToken)); check(); return privateJson({ receipt, receiptToken, fragmentOnly: true }); }
      if (b.operation === "candidate") {
        shape(required); const access = await postcards.candidate(id, hash, guestId, postcardId); check(); const signed = await objects.signRead(access, access.expiresAt, signal); check(); const fresh = await postcards.candidate(id, hash, guestId, postcardId); check();
        const { maxAgeSeconds: oldAge, ...oldValue } = access, { maxAgeSeconds, ...newValue } = fresh; void oldAge;
        if (JSON.stringify(oldValue) !== JSON.stringify(newValue) || Date.parse(signed.expiresAt) <= Date.now() || Date.parse(signed.expiresAt) > Math.min(Date.parse(fresh.expiresAt), Date.now() + maxAgeSeconds * 1000)) throw new EventStoreError("access_denied", 403);
        return privateJson({ ...oldValue, retainedUntil: oldValue.expiresAt, expiresAt: signed.expiresAt, signedUrl: signed.signedUrl });
      }
      throw new RequestValidationError(400, "invalid_request");
    };
    try { return await Promise.race([work(), interrupted]); }
    catch (error) { const known = error instanceof EventStoreError || error instanceof EventPostcardError || error instanceof RequestValidationError, status = known ? error.status : 503, code = error instanceof EventStoreError || error instanceof EventPostcardError ? error.code : status === 429 ? "rate_limited" : status === 403 ? "origin_denied" : [400, 413, 415].includes(status) ? "invalid_request" : "unavailable", response = privateJson({ error: code }, status); if (status === 429) response.headers.set("Retry-After", String(retry || 60)); return response; }
    finally { clearTimeout(timer); signal.removeEventListener("abort", listener); abort.abort(); }
  };
}
