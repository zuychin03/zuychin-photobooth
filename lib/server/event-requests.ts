import { createEventOwnConsentStore } from "./event-own-consent-store";
import { createEventGuestbookStore } from "./event-guestbook-store";
import { EVENT_MISSIONS, validateGuestbookText } from "../events/guestbook-contract";
import { createHash, createHmac } from "node:crypto";
import { isIP } from "node:net";
import { createClient } from "@supabase/supabase-js";
import { EVENT_LIMITS, type EventReceipt, type EventSession } from "../events/contract";
import { canonicalPublicOrigin, privateJson, supabaseServiceOrigin } from "./cron-auth";
import { createEventStore, EventStoreError, verifyEventActor, type EventStore, type VerifiedEventActor } from "./event-store";
import { eventConsent, eventCreate, eventInstant, eventInteger, eventInvalid, eventManage, eventObject, eventSecret, eventUuid } from "./event-http-input";
import { readSmallJson, requireSameOrigin, RequestValidationError } from "./request-security";
import { createEventObjects, EventObjectError, type EventSigningObjects } from "./event-objects";
import { cleanEventHostList, cleanEventSettings, createEventHostStore, type EventHostStore } from "./event-host-store";
import { EVENT_HOST_LIMITS, validateEventLook } from "../events/host-contract";
import { createEventReadinessStore, type EventReadinessStore } from "./event-readiness-store";

export type EventRoute = "root" | "host" | "guest" | "receipt";
export interface EventRequestPorts {
  ownConsent?(env: Record<string, string | undefined>, signal: AbortSignal): ReturnType<typeof createEventOwnConsentStore>;
  guestbook?(env: Record<string, string | undefined>, signal: AbortSignal): ReturnType<typeof createEventGuestbookStore>;
  store(env: Record<string, string | undefined>, signal: AbortSignal): EventStore;
  authenticate(token: string, env: Record<string, string | undefined>, signal: AbortSignal): Promise<VerifiedEventActor>;
  objects?(env: Record<string, string | undefined>): EventSigningObjects;
  hostStore?(env: Record<string, string | undefined>, signal: AbortSignal): EventHostStore;
  readiness?(env: Record<string, string | undefined>, signal: AbortSignal): EventReadinessStore;
}
const production: EventRequestPorts = {
  ownConsent(env, signal) {
    const origin = supabaseServiceOrigin(env.NEXT_PUBLIC_SUPABASE_URL);
    if (!origin || !env.SUPABASE_SERVICE_ROLE_KEY?.trim()) throw new EventStoreError("unavailable", 503);
    const client = createClient(origin, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false }, global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) }) } });
    return createEventOwnConsentStore({ rpc: async (name, args) => client.rpc(name, args) });
  },
  guestbook(env, signal) {
    const origin = supabaseServiceOrigin(env.NEXT_PUBLIC_SUPABASE_URL);
    if (!origin || !env.SUPABASE_SERVICE_ROLE_KEY?.trim()) throw new EventStoreError("unavailable", 503);
    const client = createClient(origin, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false }, global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) }) } });
    return createEventGuestbookStore({ rpc: async (name, args) => client.rpc(name, args) });
  },
  readiness: (env, signal) => createEventReadinessStore(env, undefined, signal),
  hostStore(env, signal) {
    const origin = supabaseServiceOrigin(env.NEXT_PUBLIC_SUPABASE_URL);
    if (!origin || !env.SUPABASE_SERVICE_ROLE_KEY?.trim()) throw new EventStoreError("unavailable", 503);
    const client = createClient(origin, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false }, global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) }) } });
    return createEventHostStore(env, { rpc: async (name, args) => client.rpc(name, args) });
  },
  objects(env) {
    const origin = supabaseServiceOrigin(env.NEXT_PUBLIC_SUPABASE_URL);
    if (!origin || !env.SUPABASE_SERVICE_ROLE_KEY?.trim()) throw new EventStoreError("unavailable", 503);
    return createEventObjects({ origin, serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY });
  },
  store(env, signal) {
    const origin = supabaseServiceOrigin(env.NEXT_PUBLIC_SUPABASE_URL);
    if (!origin || !env.SUPABASE_SERVICE_ROLE_KEY?.trim()) throw new EventStoreError("unavailable", 503);
    const client = createClient(origin, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false }, global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) }) } });
    return createEventStore(env, { rpc: async (name, args) => client.rpc(name, args) });
  },
  async authenticate(token, env, signal) {
    const origin = supabaseServiceOrigin(env.NEXT_PUBLIC_SUPABASE_URL), key = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!origin || !key?.trim()) throw new EventStoreError("unavailable", 503);
    const client = createClient(origin, key, { auth: { autoRefreshToken: false, persistSession: false }, global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) }) } });
    return verifyEventActor({ getUser: () => client.auth.getUser(token) });
  },
};
const digest = (token: string) => createHash("sha256").update(token).digest("hex");
const cookieName = (kind: "contribute" | "receipt", secure: boolean) => `${secure ? "__Host-" : ""}pb-event-${kind}`;
function cookie(request: Request, kind: "contribute" | "receipt", secure: boolean): string {
  const header = request.headers.get("cookie") ?? "";
  if (header.length > 16384) throw new EventStoreError("access_denied", 403);
  const matches = header.split(";").map(part => part.trim().split("=")).filter(([name]) => name === cookieName(kind, secure));
  if (matches.length !== 1 || matches[0].length !== 2) throw new EventStoreError("access_denied", 403);
  try { return eventSecret(matches[0][1]); } catch { throw new EventStoreError("access_denied", 403); }
}
function setCookie(response: Response, kind: "contribute" | "receipt", token: string, secure: boolean, expiresAt: string) {
  const seconds = Math.min(30 * 86400, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000));
  if (!Number.isFinite(seconds) || seconds < 1) throw new EventStoreError("expired", 410);
  response.headers.append("Set-Cookie", `${cookieName(kind, secure)}=${token}; Path=${secure ? "/" : "/api/events"}; Max-Age=${seconds}; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`);
}
function cleanReceipt(value: EventReceipt, id: string): EventReceipt {
  if (value.submissionId !== id || !["reserved", "uploading", "finalising", "ready", "failed", "expired", "deleted"].includes(value.state) || ![value.gallery, value.wall].every(v => ["private", "awaiting_approval", "approved", "hidden", "rejected"].includes(v))) throw new EventStoreError("unavailable", 503);
  return { submissionId: id, state: value.state, logicalExpiresAt: eventInstant(value.logicalExpiresAt), eventExpiresAt: eventInstant(value.eventExpiresAt), gallery: value.gallery, wall: value.wall };
}
function cleanEvent(value: Record<string, unknown>, id: string) {
  if (value.id !== id || !["draft", "open", "paused", "closed", "deleted"].includes(value.status as string)) throw new EventStoreError("unavailable", 503);
  return { eventId: id, status: value.status, ...eventCreate({ title: value.title, timezone: value.timezone, startsAt: value.starts_at, closesAt: value.contribution_closes_at, expiresAt: value.expires_at, maxGuests: value.max_guests, maxContributions: value.max_contributions, maxBytes: value.max_bytes }) };
}

export function createEventHandler(route: EventRoute, ports: EventRequestPorts = production, getEnv: () => Record<string, string | undefined> = () => process.env) {
  return async (request: Request, eventId?: string, submissionId?: string): Promise<Response> => {
    const controller = new AbortController(), expire = () => controller.abort();
    const timer = setTimeout(expire, 45_000); request.signal.addEventListener("abort", expire, { once: true }); if (request.signal.aborted) expire();
    const check = () => { if (controller.signal.aborted) throw new EventStoreError("unavailable", 503); };
    let rejectAbort: (() => void) | undefined;
    const cancelled = new Promise<never>((_, reject) => { rejectAbort = () => reject(new EventStoreError("unavailable", 503)); controller.signal.addEventListener("abort", rejectAbort, { once: true }); });
    let retryAfter = 0;
    const work = async (): Promise<Response> => {
      const env = getEnv(), url = new URL(request.url), secret = env.PB_EVENT_TRANSPORT_SECRET;
      if (env.PB_EVENTS_ENABLED !== "true" || !secret || secret.length < 32 || secret.length > 4096 || /\s/.test(secret)) throw new EventStoreError("unavailable", 503);
      if (request.method !== "POST") return privateJson({ error: "method_not_allowed" }, 405);
      const local = env.NODE_ENV === "development" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
      if (url.protocol !== "https:" && !(local && url.protocol === "http:") || !local && !canonicalPublicOrigin(env.PB_PUBLIC_ORIGIN)) throw new EventStoreError("unavailable", 503);
      if (url.search) return eventInvalid(); requireSameOrigin(request, env); check();
      const ipHeader = env.PB_EVENT_TRUSTED_IP_HEADER;
      const ip = ipHeader && /^[a-z][a-z0-9-]{0,63}$/.test(ipHeader) ? request.headers.get(ipHeader)?.trim() : local ? "127.0.0.1" : null;
      if (!ip || !isIP(ip)) throw new EventStoreError("unavailable", 503);
      const canonicalIp = isIP(ip) === 6 ? new URL(`http://[${ip}]`).hostname : ip;
      const derive = (...values: unknown[]) => createHmac("sha256", secret).update(JSON.stringify(values)).digest("base64url");
      const b = await readSmallJson(request); check();
      const operation = b.operation; if (typeof operation !== "string") return eventInvalid();
      const shape = (...keys: string[]) => eventObject(b, ["operation", ...keys]);
      if (route !== "root") eventUuid(eventId); if (route === "receipt") eventUuid(submissionId);
      const store = ports.store(env, controller.signal); await store.transportReady(); check();
      const rate = async (identity: string, bucket: "read" | "write" | "redeem") => {
        const response = await store.rate(digest(derive("rate", identity)), bucket); check();
        if (!response.allowed) { retryAfter = eventInteger(response.retryAfterSeconds, 1, 60); throw new RequestValidationError(429, "rate_limited"); }
      };
      const readOnly = ["capabilities", "dashboard", "session", "read", "media", "list", "settings", "context", "missions", "guestbook", "ownConsent"].includes(operation);
      await rate(`ip:${canonicalIp}`, operation === "redeem" || operation === "exchange" ? "redeem" : readOnly ? "read" : "write");
      const capabilities = await store.capabilities(); check(); if (!capabilities.ready) throw new EventStoreError("not_ready", 503);
      const host = () => { if (!ports.hostStore) throw new EventStoreError("unavailable", 503); return ports.hostStore(env, controller.signal); };
      const worker = async () => { if (!ports.readiness) throw new EventStoreError("unavailable", 503); const status = await ports.readiness(env, controller.signal).status(); check(); return status; };
      if (route === "root" && operation === "capabilities") {
        shape(); let hostVersion = 0;
        try { const result = await host().capabilities(); if (Object.entries(EVENT_HOST_LIMITS).every(([key, value]) => result[key as keyof typeof EVENT_HOST_LIMITS] === value)) hostVersion = 1; } catch { /* Older event servers retain their base capabilities. */ }
        let ownConsentVersion = 0;
        try { if ((await ports.ownConsent?.(env, controller.signal).capabilities())?.version === 1) ownConsentVersion = 1; } catch { /* Older deployments keep publication edits unavailable. */ }
        let guestbookVersion = 0;
        try { if ((await ports.guestbook?.(env, controller.signal).capabilities())?.version === 1) guestbookVersion = 1; } catch { /* Guestbook remains unavailable on older event deployments. */ }
        let accepting = false;
        try { const status = await worker(); accepting = status.ready && status.pending < status.maxPending; } catch { /* Reads remain available while worker readiness is absent. */ }
        check(); return privateJson({ enabled: true, version: 1, transportVersion: 1, hostVersion, guestbookVersion, ownConsentVersion, limits: EVENT_LIMITS, uploadsAvailable: !!ports.objects && hostVersion === 1 && accepting, downloadsAvailable: !!ports.objects });
      }
      if (route === "root" || route === "host") {
        const bearer = /^Bearer ([^\s,]+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
        if (!bearer || bearer.length > 16384) throw new EventStoreError("access_denied", 401);
        const actor = await ports.authenticate(bearer, env, controller.signal); check(); await rate(`actor:${actor.id}`, readOnly ? "read" : "write");
        if (route === "root" && operation === "create") {
          shape("eventId", "event"); const id = eventUuid(b.eventId), input = eventCreate(b.event);
          const result = await store.create(actor, id, input); check(); return privateJson(cleanEvent(result, id), 201);
        }
        if (route === "root" && operation === "list") {
          eventObject(b, ["operation"], ["after", "limit"]);
          const after = b.after === undefined ? undefined : eventUuid(b.after), limit = b.limit === undefined ? 25 : eventInteger(b.limit, 1, 25);
          const result = await host().list(actor, after, limit); check(); return privateJson(cleanEventHostList(result, after, limit));
        }
        if (route !== "host") return eventInvalid();
        if (["missions", "saveMissions", "guestbook"].includes(operation)) {
          const book = ports.guestbook?.(env, controller.signal); if (!book) throw new EventStoreError("unavailable", 503);
          let result;
          if (operation === "guestbook") { eventObject(b, ["operation"], ["after", "limit"]); result = await book.list(actor, eventId!, b.after === undefined ? undefined : eventUuid(b.after), b.limit === undefined ? 25 : eventInteger(b.limit, 1, 25)); }
          else if (operation === "missions") { shape(); result = await book.missions(actor, eventId!); }
          else { shape("expectedRevision", "missionIds", "endsAt"); if (!Array.isArray(b.missionIds) || b.missionIds.length > 6 || new Set(b.missionIds).size !== b.missionIds.length || b.missionIds.some(id => !EVENT_MISSIONS.some(m => m.id === id))) return eventInvalid(); result = await book.missions(actor, eventId!, { expectedRevision: eventInteger(b.expectedRevision, 0, 999999), missionIds: b.missionIds as string[], endsAt: eventInstant(b.endsAt) }); }
          check(); return privateJson(result);
        }
        if (operation === "settings") { shape(); const result = await host().settings(actor, eventId!); check(); return privateJson(cleanEventSettings(result, eventId!)); }
        if (operation === "saveSettings") {
          shape("requestId", "expectedRevision", "settings");
          const requestId = eventUuid(b.requestId), revision = eventInteger(b.expectedRevision, 0, 2147483646), settings = eventObject(b.settings, ["event", "look"]), event = eventCreate(settings.event);
          let look; try { look = validateEventLook(settings.look); } catch { return eventInvalid(); }
          const result = await host().saveSettings(actor, eventId!, requestId, revision, { event, look }); check(); return privateJson(cleanEventSettings(result, eventId!));
        }
        if (operation === "dashboard") {
          eventObject(b, ["operation"], ["after", "limit"]);
          const result = await store.dashboard(actor, eventId!, b.after === undefined ? undefined : eventUuid(b.after), b.limit === undefined ? 25 : eventInteger(b.limit, 1, 25)); check();
          return privateJson({ event: cleanEvent(result.event, eventId!), submissions: result.submissions.map(item => cleanReceipt(item, eventUuid(item.submissionId))), usage: { guests: eventInteger(result.usage.guests, 0, 25), count: eventInteger(result.usage.count, 0, 100), bytes: eventInteger(result.usage.bytes, 0, EVENT_LIMITS.eventBytes), stagingBytes: eventInteger(result.usage.stagingBytes, 0, EVENT_LIMITS.eventBytes), derivativeBytes: eventInteger(result.usage.derivativeBytes, 0, EVENT_LIMITS.eventBytes) } });
        }
        if (operation === "manage") {
          shape("action", "body"); const action = eventManage(b.action, b.body);
          let result: Record<string, unknown>;
          if (action.action === "invite_moderator") { const host = ports.hostStore?.(env, controller.signal); if (!host?.inviteModerator) throw new EventStoreError("unavailable", 503); result = await host.inviteModerator(actor, eventId!, action.body.userId as string); }
          else result = await store.manage(actor, eventId!, action.action, action.body); check();
          if (action.action === "accept_moderator") { if (result.accepted !== true) throw new EventStoreError("unavailable", 503); return privateJson({ accepted: true }); }
          return privateJson(cleanEvent(result, eventId!));
        }
        if (operation === "issue") {
          shape("requestId", "kind", "expiresAt", "rotate"); const requestId = eventUuid(b.requestId), expiresAt = eventInstant(b.expiresAt);
          if (!["invite", "gallery", "display"].includes(b.kind as string) || typeof b.rotate !== "boolean" || b.rotate && b.kind !== "invite") return eventInvalid();
          const kind = b.kind as "invite" | "gallery" | "display", token = derive("issue", actor.id, eventId, requestId, kind, expiresAt, b.rotate);
          const issued = await store.issue(actor, eventId!, requestId, kind, digest(token), expiresAt, b.rotate); check();
          return privateJson({ kind, token, expiresAt: issued.expiresAt, fragmentOnly: true }, 201);
        }
        if (operation === "revokeToken") { shape("token"); const tokenHash = digest(eventSecret(b.token)), host = ports.hostStore?.(env, controller.signal); if (!host?.revokeCapability) throw new EventStoreError("unavailable", 503); const result = await host.revokeCapability(actor, eventId!, tokenHash); check(); return privateJson(cleanEvent(result, eventId!)); }
        return eventInvalid();
      }
      const secure = url.protocol === "https:";
      if (route === "guest") {
        if (operation === "redeem") {
          shape("inviteToken", "nonce"); const invite = eventSecret(b.inviteToken), nonce = eventSecret(b.nonce), token = derive("contribute", eventId, invite, nonce), hex = digest(derive("guest", eventId, invite, nonce)).slice(0, 32);
          const guestId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
          await store.redeem(eventId!, digest(invite), guestId, digest(token)); check();
          const session = await store.session(eventId!, digest(token), "contribute"); check();
          if (session.guestId !== guestId) throw new EventStoreError("unavailable", 503);
          const response = privateJson({ ...session, replacesBrowserGuestSession: true }, 201); setCookie(response, "contribute", token, secure, session.expiresAt); return response;
        }
        const token = cookie(request, "contribute", secure), session = await store.session(eventId!, digest(token), "contribute"); check();
        await rate(`guest:${eventId}:${session.guestId}`, readOnly ? "read" : "write");
        const guestFence = () => { if (eventUuid(b.expectedGuestId) !== session.guestId) throw new EventStoreError("access_denied", 403); };
        if (["missions", "guestbook", "saveGuestbook", "withdrawGuestbook"].includes(operation)) {
          const book = ports.guestbook?.(env, controller.signal); if (!book) throw new EventStoreError("unavailable", 503);
          shape("expectedGuestId", ...(operation === "missions" ? [] : ["submissionId"]), ...(operation === "saveGuestbook" ? ["requestId", "expectedRevision", "message", "signature"] : [])); guestFence();
          let result;
          if (operation === "missions") result = await book.guestMissions(eventId!, digest(token), session.guestId!);
          else { const id = eventUuid(b.submissionId);
            if (operation === "saveGuestbook") { let text; try { text = validateGuestbookText(b.message, b.signature); } catch { return eventInvalid(); } result = await book.save(eventId!, digest(token), session.guestId!, id, { requestId: eventUuid(b.requestId), expectedRevision: eventInteger(b.expectedRevision, 0, 999999), ...text }); }
            else result = operation === "withdrawGuestbook" ? await book.withdraw(eventId!, digest(token), "contribute", id, session.guestId!) : await book.read(eventId!, digest(token), "contribute", id, session.guestId!);
          }
          check(); return privateJson(result);
        }
        if (operation === "session") { shape(); return privateJson(session); }
        if (operation === "context") {
          shape("expectedGuestId"); guestFence(); const host = ports.hostStore?.(env, controller.signal);
          if (!host?.guestContext) throw new EventStoreError("unavailable", 503);
          const result = await host.guestContext(eventId!, digest(token)); check();
          let serviceAvailable = false; try { const status = await worker(); serviceAvailable = status.ready && status.pending < status.maxPending; } catch { /* Existing guests can recover without admitting a new photo. */ }
          return privateJson({ ...result, serviceAvailable, canReserve: result.canReserve && serviceAvailable });
        }
        if (operation === "reserve" || operation === "reserveMission") {
          shape("requestId", "submissionId", "consent", "expectedGuestId", ...(operation === "reserveMission" ? ["missionId"] : [])); guestFence(); const requestId = eventUuid(b.requestId), id = eventUuid(b.submissionId), consent = eventConsent(b.consent); if (!consent.submission || !session.guestId) return eventInvalid();
          await worker();
          const receiptToken = derive("receipt", eventId, token, id, requestId);
          if (operation === "reserveMission") {
            if (b.missionId !== null && !EVENT_MISSIONS.some(m => m.id === b.missionId)) return eventInvalid();
            const book = ports.guestbook?.(env, controller.signal); if (!book) throw new EventStoreError("unavailable", 503);
            await book.reserve(eventId!, digest(token), session.guestId, { requestId, submissionId: id, receiptHash: digest(receiptToken), consent, missionId: b.missionId as string | null });
          } else await store.reserve({ eventId: eventId!, tokenHash: digest(token), requestId, submissionId: id, receiptHash: digest(receiptToken), contributors: [session.guestId], consent }); check();
          const receiptSession = await store.session(eventId!, digest(receiptToken), "receipt", id); check();
          const receipt = await store.receipt(eventId!, digest(receiptToken), id); check();
          const response = privateJson({ receipt: cleanReceipt(receipt, id), receiptToken, replacesBrowserReceipt: true, fragmentOnly: true }, 201);
          setCookie(response, "receipt", receiptToken, secure, receiptSession.expiresAt); return response;
        }
        if (operation === "ownConsent" || operation === "saveOwnConsent") {
          shape("submissionId", "expectedGuestId", ...(operation === "saveOwnConsent" ? ["expectedRevision", "gallery", "wall"] : [])); guestFence();
          const own = ports.ownConsent?.(env, controller.signal); if (!own) throw new EventStoreError("unavailable", 503);
          let update: { expectedRevision: number; gallery: boolean; wall: boolean } | undefined;
          if (operation === "saveOwnConsent") { if (typeof b.gallery !== "boolean" || typeof b.wall !== "boolean") return eventInvalid(); update = { expectedRevision: eventInteger(b.expectedRevision, 0, 2147483647), gallery: b.gallery, wall: b.wall }; }
          const result = await own.read(eventId!, digest(token), session.guestId!, eventUuid(b.submissionId), update); check(); return privateJson(result);
        }
        if (operation === "consent" || operation === "finalise") {
          shape("submissionId", "expectedGuestId", ...(operation === "consent" ? ["consent"] : [])); guestFence(); const id = eventUuid(b.submissionId);
          const result = operation === "consent" ? await store.consent(eventId!, digest(token), id, eventConsent(b.consent)) : await store.enqueueFinalise(eventId!, digest(token), id); check(); return privateJson(cleanReceipt(result, id));
        }
        if (operation === "upload") {
          shape("submissionId", "expectedGuestId"); guestFence(); const id = eventUuid(b.submissionId);
          if (!ports.objects) throw new EventStoreError("unavailable", 503);
          if (!(await worker()).ready) throw new EventStoreError("not_ready", 503);
          const authorisation = await store.authoriseUpload(eventId!, digest(token), id); check();
          const signed = await ports.objects(env).mintUpload(authorisation, controller.signal); check();
          const fresh = await store.session(eventId!, digest(token), "contribute"); check();
          if (fresh.guestId !== session.guestId || Date.now() >= Date.parse(authorisation.mintBefore) || Date.parse(signed.expiresAt) > Date.parse(authorisation.authorisationUntil)) throw new EventStoreError("expired", 410);
          return privateJson({ submissionId: id, bucket: authorisation.bucket, path: authorisation.path, signedUrl: signed.signedUrl, expiresAt: signed.expiresAt, maxBytes: EVENT_LIMITS.imageBytes, overwrite: false });
        }
        return eventInvalid();
      }
      if (operation === "guestbook" || operation === "withdrawGuestbook") {
        shape(); const token = cookie(request, "receipt", secure), book = ports.guestbook?.(env, controller.signal); if (!book) throw new EventStoreError("unavailable", 503);
        await store.session(eventId!, digest(token), "receipt", submissionId); check(); await rate(`receipt:${eventId}:${submissionId}:${digest(token)}`, readOnly ? "read" : "write");
        const result = operation === "guestbook" ? await book.read(eventId!, digest(token), "receipt", submissionId!) : await book.withdraw(eventId!, digest(token), "receipt", submissionId!); check(); return privateJson(result);
      }
      if (!["exchange", "read", "media"].includes(operation)) return eventInvalid(); shape(...(operation === "exchange" ? ["token"] : []));
      const token = operation === "exchange" ? eventSecret(b.token) : cookie(request, "receipt", secure);
      const session: EventSession = await store.session(eventId!, digest(token), "receipt", submissionId); check();
      await rate(`receipt:${eventId}:${submissionId}:${digest(token)}`, "read");
      const receipt = cleanReceipt(await store.receipt(eventId!, digest(token), submissionId!), submissionId!); check();
      if (operation === "media") {
        if (!ports.objects || receipt.state !== "ready") throw new EventStoreError("not_ready", 409);
        const access = await store.readAccess(eventId!, digest(token), submissionId!, "receipt"); check();
        const signed = await ports.objects(env).signRead(access, receipt.eventExpiresAt, controller.signal); check();
        await store.session(eventId!, digest(token), "receipt", submissionId); check();
        const freshReceipt = cleanReceipt(await store.receipt(eventId!, digest(token), submissionId!), submissionId!); check();
        const fresh = await store.readAccess(eventId!, digest(token), submissionId!, "receipt"); check();
        if (fresh.path !== access.path || fresh.bucket !== access.bucket || freshReceipt.state !== "ready" || Date.parse(signed.expiresAt) <= Date.now() || Date.parse(signed.expiresAt) > Math.min(Date.parse(freshReceipt.eventExpiresAt), Date.now() + fresh.maxAgeSeconds * 1000)) throw new EventStoreError("access_denied", 403);
        return privateJson({ submissionId, bucket: access.bucket, path: access.path, signedUrl: signed.signedUrl, expiresAt: signed.expiresAt, maxBytes: EVENT_LIMITS.imageBytes, mime: "image/jpeg" });
      }
      const response = privateJson(receipt);
      if (operation === "exchange") setCookie(response, "receipt", token, secure, session.expiresAt); return response;
    };
    try { return await Promise.race([work(), cancelled]); }
    catch (error) {
      if (error instanceof EventObjectError && error.code === "mint_expired") return privateJson({ error: "expired" }, 410);
      const status = error instanceof EventStoreError || error instanceof RequestValidationError ? error.status : 503;
      const code = error instanceof EventStoreError ? error.code : status === 429 ? "rate_limited" : status === 403 ? "origin_denied" : status === 400 || status === 413 || status === 415 ? "invalid_request" : "unavailable";
      const response = privateJson({ error: code }, status); if (status === 429) response.headers.set("Retry-After", String(Math.max(1, Math.min(60, retryAfter || 60)))); return response;
    } finally { clearTimeout(timer); request.signal.removeEventListener("abort", expire); if (rejectAbort) controller.signal.removeEventListener("abort", rejectAbort); controller.abort(); }
  };
}
