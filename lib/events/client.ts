import { parseEventOwnConsent } from "./own-consent";
import { EVENT_MISSIONS, parseEventGuestbookNote, parseEventMissions, validateGuestbookText } from "./guestbook-contract";
import { EVENT_LIMITS, type EventConsent, type EventCreateInput, type EventReceipt, type EventSession, type EventStatus } from "./contract";
import { inspectImageHeader } from "../projects/images";
import { validateEventLook, type EventGuestContext, type EventHostList, type EventHostSummary, type EventSettings, type EventSettingsInput } from "./host-contract";

export class EventClientError extends Error {
  constructor(public readonly code: string, public readonly status = 0, public readonly retryAfterSeconds?: number) { super(code); this.name = "EventClientError"; }
}
const fail = (code = "invalid_response"): never => { throw new EventClientError(code); };
export function eventClientObject(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return fail();
  const record = value as Record<string, unknown>;
  if (required.some(key => !Object.hasOwn(record, key)) || Object.keys(record).some(key => !required.includes(key) && !optional.includes(key)) || Object.values(Object.getOwnPropertyDescriptors(record)).some(d => !Object.hasOwn(d, "value"))) return fail();
  return record;
}
export function eventClientUuid(value: unknown): string { if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) return fail("invalid_request"); return value; }
function integer(value: unknown, low: number, high: number): number { if (!Number.isSafeInteger(value) || (value as number) < low || (value as number) > high) return fail(); return value as number; }
export function eventClientInstant(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) return fail();
  const normal = new Date(value).toISOString(); if (normal.slice(0, 19) !== value.slice(0, 19)) return fail(); return normal;
}
function secret(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value)) return fail("invalid_request"); return value;
}
export function eventClientConsent(value: unknown): EventConsent {
  const v = eventClientObject(value, ["submission", "gallery", "wall"]);
  if ([v.submission, v.gallery, v.wall].some(x => typeof x !== "boolean")) return fail("invalid_request");
  return { submission: v.submission as boolean, gallery: v.gallery as boolean, wall: v.wall as boolean };
}
export function parseEventReceipt(value: unknown, submissionId?: string): EventReceipt {
  const v = eventClientObject(value, ["submissionId", "state", "logicalExpiresAt", "eventExpiresAt", "gallery", "wall"]);
  const id = eventClientUuid(v.submissionId), logicalExpiresAt = eventClientInstant(v.logicalExpiresAt), eventExpiresAt = eventClientInstant(v.eventExpiresAt);
  if (submissionId && id !== submissionId || logicalExpiresAt > eventExpiresAt || !["reserved", "uploading", "finalising", "ready", "failed", "expired", "deleted"].includes(v.state as string) || ![v.gallery, v.wall].every(x => ["private", "awaiting_approval", "approved", "hidden", "rejected"].includes(x as string))) return fail();
  return { submissionId: id, state: v.state as EventReceipt["state"], logicalExpiresAt, eventExpiresAt, gallery: v.gallery as EventReceipt["gallery"], wall: v.wall as EventReceipt["wall"] };
}
export interface EventPublicEvent extends EventCreateInput { eventId: string; status: EventStatus }
function createInput(value: unknown): EventCreateInput {
  const v = eventClientObject(value, ["title", "timezone", "startsAt", "closesAt", "expiresAt", "maxGuests", "maxContributions", "maxBytes"]);
  if (typeof v.title !== "string" || v.title.trim() !== v.title || [...v.title].length < 1 || [...v.title].length > 100 || /[\u0000-\u001f\u007f-\u009f]/.test(v.title) || typeof v.timezone !== "string" || v.timezone.length > 100) return fail("invalid_request");
  try { new Intl.DateTimeFormat("en", { timeZone: v.timezone }); } catch { return fail("invalid_request"); }
  const startsAt = eventClientInstant(v.startsAt), closesAt = eventClientInstant(v.closesAt), expiresAt = eventClientInstant(v.expiresAt);
  if (startsAt >= closesAt || closesAt > expiresAt) return fail("invalid_request");
  return { title: v.title, timezone: v.timezone, startsAt, closesAt, expiresAt, maxGuests: integer(v.maxGuests, 1, 25), maxContributions: integer(v.maxContributions, 1, 100), maxBytes: integer(v.maxBytes, 4100000, EVENT_LIMITS.eventBytes) };
}
export function parseEventPublicEvent(value: unknown, eventId?: string): EventPublicEvent {
  const v = eventClientObject(value, ["eventId", "status", "title", "timezone", "startsAt", "closesAt", "expiresAt", "maxGuests", "maxContributions", "maxBytes"]);
  const { eventId: id, status, ...input } = v;
  if (eventId && id !== eventId || !["draft", "open", "paused", "closed", "deleted"].includes(status as string)) return fail();
  return { ...createInput(input), eventId: eventClientUuid(id), status: status as EventStatus };
}
export interface EventHostDashboard { event: EventPublicEvent; submissions: EventReceipt[]; usage: { guests: number; count: number; bytes: number; stagingBytes: number; derivativeBytes: number } }
export interface EventBrowserOptions { appOrigin: string; fetch?: typeof fetch; timeoutMs?: number }
export interface EventHostIdentity { ownerId: string; epoch: number }
export interface EventGuestIdentity { eventId: string; guestId: string; epoch: number }
export interface EventHostClientOptions extends EventBrowserOptions { identity(): EventHostIdentity | null; accessToken(): Promise<string | null> }
export interface EventGuestClientOptions extends EventBrowserOptions { eventId: string; storageOrigin?: string; identity(): EventGuestIdentity | null }
export interface EventUploadGrant { submissionId: string; bucket: "photobooth-event-images-staging-v2"; path: string; signedUrl: string; expiresAt: string; maxBytes: number; overwrite: false }
export interface EventMediaGrant { submissionId: string; bucket: "photobooth-events-v2"; path: string; signedUrl: string; expiresAt: string; maxBytes: number; mime: "image/jpeg" }
export type EventHostAction = "update" | "open" | "pause" | "close" | "delete" | "revoke_guest" | "invite_moderator" | "accept_moderator" | "revoke_moderator" | "publication" | "remove_submission";
function transport(options: EventBrowserOptions, identity: () => unknown, accessToken?: () => Promise<string | null>) {
  let url: URL; try { url = new URL(options.appOrigin); } catch { return fail("invalid_configuration"); }
  if (url.origin !== options.appOrigin || url.username || url.password || url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) || typeof location !== "undefined" && location.origin !== url.origin) fail("invalid_configuration");
  const initial = JSON.stringify(identity()), lifetime = new AbortController(), timeoutMs = options.timeoutMs ?? 10000;
  integer(timeoutMs, 1, 45000);
  function assertActive(signal?: AbortSignal) { if (JSON.stringify(identity()) !== initial) { lifetime.abort(); fail("identity_changed"); } if (lifetime.signal.aborted || signal?.aborted) fail("cancelled"); }
  async function request(path: string, operation: string, input: object, signal?: AbortSignal, authenticated = !!accessToken): Promise<unknown> {
    assertActive(signal);
    const body = JSON.stringify({ operation, ...input }); if (new TextEncoder().encode(body).length > 8192) fail("invalid_request");
    const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(), timeoutMs), active = AbortSignal.any([lifetime.signal, deadline.signal, ...(signal ? [signal] : [])]);
    let onAbort: (() => void) | undefined;
    const interrupted = new Promise<never>((_, reject) => { onAbort = () => reject(new EventClientError(deadline.signal.aborted ? "timeout" : "cancelled")); active.addEventListener("abort", onAbort, { once: true }); });
    const work = async () => {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (authenticated) { const token = await accessToken!(); assertActive(active); if (!token || token.length > 16384 || /[\s,]/.test(token)) fail("access_denied"); headers.Authorization = `Bearer ${token}`; }
      const endpoint = `${url.origin}/api/events${path}`, response = await (options.fetch ?? fetch)(endpoint, { method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error", signal: active, headers, body });
      if (active.aborted) { void response.body?.cancel(); assertActive(active); } assertActive(active);
      if (response.redirected || response.url && response.url !== endpoint) { void response.body?.cancel(); fail(); }
      const length = response.headers.get("content-length"); if (length !== null && (!/^\d+$/.test(length) || Number(length) > 65536)) { void response.body?.cancel(); fail("response_too_large"); }
      if (!/^application\/json(?:;|$)/i.test(response.headers.get("content-type") ?? "")) { void response.body?.cancel(); fail(); }
      const reader = response.body?.getReader(), chunks: Uint8Array[] = []; let size = 0;
      const cancel = () => { void reader?.cancel().catch(() => undefined); }; active.addEventListener("abort", cancel, { once: true });
      try { if (reader) while (true) { assertActive(active); const next = await reader.read(); assertActive(active); if (next.done) break; size += next.value.length; if (size > 65536 || chunks.length >= 4096) fail("response_too_large"); chunks.push(next.value); } }
      finally { active.removeEventListener("abort", cancel); if (reader) { void reader.cancel().catch(() => undefined); reader.releaseLock(); } }
      const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      let value: unknown; try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { return fail(); }
      if (!response.ok) { const v = eventClientObject(value, ["error"]), codes = ["unavailable", "invalid_request", "access_denied", "origin_denied", "capacity", "conflict", "expired", "not_ready", "lease_lost", "rate_limited"]; const retry = Number(response.headers.get("retry-after")); throw new EventClientError(typeof v.error === "string" && codes.includes(v.error) ? v.error : "unavailable", response.status, response.status === 429 && Number.isInteger(retry) && retry >= 1 && retry <= 60 ? retry : undefined); }
      assertActive(active); return value;
    };
    try { const result = await Promise.race([work(), interrupted]); assertActive(signal); return result; }
    catch (error) { assertActive(signal); if (error instanceof EventClientError) throw error; throw new EventClientError("network_error"); }
    finally { clearTimeout(timer); if (onAbort) active.removeEventListener("abort", onAbort); deadline.abort(); }
  }
  async function capabilities(signal?: AbortSignal) {
    const v = eventClientObject(await request("", "capabilities", {}, signal, false), ["enabled", "version", "transportVersion", "limits", "uploadsAvailable", "downloadsAvailable"], ["hostVersion", "guestbookVersion", "ownConsentVersion"]), limits = eventClientObject(v.limits, Object.keys(EVENT_LIMITS));
    if (v.ownConsentVersion !== undefined && v.ownConsentVersion !== 0 && v.ownConsentVersion !== 1 || v.guestbookVersion !== undefined && v.guestbookVersion !== 0 && v.guestbookVersion !== 1 || v.enabled !== true || v.version !== 1 || v.transportVersion !== 1 || v.hostVersion !== undefined && v.hostVersion !== 0 && v.hostVersion !== 1 || typeof v.uploadsAvailable !== "boolean" || typeof v.downloadsAvailable !== "boolean" || Object.entries(EVENT_LIMITS).some(([key, value]) => limits[key] !== value)) fail();
    return { enabled: true as const, version: 1 as const, transportVersion: 1 as const, hostVersion: (v.hostVersion ?? 0) as 0 | 1, guestbookVersion: (v.guestbookVersion ?? 0) as 0 | 1, ownConsentVersion: (v.ownConsentVersion ?? 0) as 0 | 1, limits: EVENT_LIMITS, uploadsAvailable: v.uploadsAvailable as boolean, downloadsAvailable: v.downloadsAvailable as boolean };
  }
  let binaryBusy = false;
  async function binary(endpoint: string, init: RequestInit, maximum: number, signal?: AbortSignal) {
    assertActive(signal); if (binaryBusy) fail("busy"); binaryBusy = true; const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(), timeoutMs), active = AbortSignal.any([lifetime.signal, deadline.signal, ...(signal ? [signal] : [])]); let onAbort: (() => void) | undefined;
    const interrupted = new Promise<never>((_, reject) => { onAbort = () => reject(new EventClientError(deadline.signal.aborted ? "timeout" : "cancelled")); active.addEventListener("abort", onAbort, { once: true }); });
    const work = async () => {
      const response = await (options.fetch ?? fetch)(endpoint, { ...init, credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer", signal: active });
      if (active.aborted) { void response.body?.cancel(); assertActive(active); } assertActive(active);
      if (response.redirected || response.url && response.url !== endpoint) { void response.body?.cancel(); fail(); }
      const length = response.headers.get("content-length"); if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum)) { void response.body?.cancel(); fail("response_too_large"); }
      const chunks: Uint8Array[] = [], reader = response.body?.getReader(); let size = 0; const cancel = () => { void reader?.cancel().catch(() => undefined); }; active.addEventListener("abort", cancel, { once: true });
      try { if (reader) while (true) { assertActive(active); const next = await reader.read(); assertActive(active); if (next.done) break; size += next.value.length; if (size > maximum || chunks.length >= 4096) fail("response_too_large"); chunks.push(next.value); } }
      finally { active.removeEventListener("abort", cancel); if (reader) { void reader.cancel().catch(() => undefined); reader.releaseLock(); } }
      const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; } return { bytes, status: response.status, ok: response.ok, mime: response.headers.get("content-type") };
    };
    try { const result = await Promise.race([work(), interrupted]); assertActive(signal); return result; }
    catch (error) { assertActive(signal); if (error instanceof EventClientError) throw error; throw new EventClientError("network_error"); }
    finally { binaryBusy = false; clearTimeout(timer); if (onAbort) active.removeEventListener("abort", onAbort); deadline.abort(); }
  }
  return { request, capabilities, binary, assertActive, close() { lifetime.abort(); } };
}
export function createEventHostClient(options: EventHostClientOptions) {
  const initial = options.identity(); if (!initial) return fail("identity_changed"); const ownerId = eventClientUuid(initial.ownerId); integer(initial.epoch, 0, Number.MAX_SAFE_INTEGER);
  const io = transport(options, options.identity, options.accessToken);
  function settings(value: unknown, eventId: string): EventSettings {
    const v = eventClientObject(value, ["version", "eventId", "revision", "locked", "event", "look"]); if (v.version !== 1 || v.eventId !== eventId || typeof v.locked !== "boolean") return fail();
    let look: EventSettings["look"]; try { look = validateEventLook(v.look); } catch { return fail(); }
    return { version: 1, eventId, revision: integer(v.revision, 0, Number.MAX_SAFE_INTEGER), locked: v.locked, event: createInput(v.event), look };
  }
  return {
    ownerId, capabilities: io.capabilities, assertActive: io.assertActive, close: io.close,
    async list(page: { after?: string; limit?: number } = {}, signal?: AbortSignal): Promise<EventHostList> {
      const limit = integer(page.limit ?? 25, 1, 25), after = page.after === undefined ? undefined : eventClientUuid(page.after), v = eventClientObject(await io.request("", "list", { limit, ...(after ? { after } : {}) }, signal), ["version", "events", "nextCursor"]);
      if (v.version !== 1 || !Array.isArray(v.events) || v.events.length > limit) return fail();
      const events: EventHostSummary[] = v.events.map(value => { const r = eventClientObject(value, ["eventId", "title", "timezone", "startsAt", "closesAt", "expiresAt", "status", "role", "membership"]), parsed = parseEventPublicEvent({ eventId: r.eventId, title: r.title, timezone: r.timezone, startsAt: r.startsAt, closesAt: r.closesAt, expiresAt: r.expiresAt, status: r.status, maxGuests: 1, maxContributions: 1, maxBytes: 4100000 }); if (!["owner", "moderator"].includes(r.role as string) || !["active", "invited"].includes(r.membership as string) || r.role === "owner" && r.membership !== "active") return fail(); return { eventId: parsed.eventId, title: parsed.title, timezone: parsed.timezone, startsAt: parsed.startsAt, closesAt: parsed.closesAt, expiresAt: parsed.expiresAt, status: parsed.status, role: r.role as EventHostSummary["role"], membership: r.membership as EventHostSummary["membership"] }; });
      const nextCursor = v.nextCursor === null ? null : eventClientUuid(v.nextCursor);
      if (new Set(events.map(e => e.eventId)).size !== events.length || events.some((e, index) => e.eventId <= (index ? events[index - 1].eventId : after ?? "")) || nextCursor && (events.length !== limit || events.at(-1)?.eventId !== nextCursor)) return fail(); return { version: 1, events, nextCursor };
    },
    async settings(eventId: string, signal?: AbortSignal) { const id = eventClientUuid(eventId); return settings(await io.request(`/${id}`, "settings", {}, signal), id); },
    async saveSettings(eventId: string, input: { requestId: string; expectedRevision: number; settings: EventSettingsInput }, signal?: AbortSignal) {
      eventClientObject(input, ["requestId", "expectedRevision", "settings"]); eventClientObject(input.settings, ["event", "look"]);
      let look: EventSettings["look"]; try { look = validateEventLook(input.settings.look); } catch { return fail("invalid_request"); }
      const id = eventClientUuid(eventId), expectedRevision = integer(input.expectedRevision, 0, Number.MAX_SAFE_INTEGER), result = settings(await io.request(`/${id}`, "saveSettings", { requestId: eventClientUuid(input.requestId), expectedRevision, settings: { event: createInput(input.settings.event), look } }, signal), id);
      if (result.revision < expectedRevision) return fail(); return result;
    },
    async missions(eventId: string, signal?: AbortSignal) { const id = eventClientUuid(eventId); return parseEventMissions(await io.request(`/${id}`, "missions", {}, signal), id); },
    async saveMissions(eventId: string, value: { expectedRevision: number; missionIds: string[]; endsAt: string }, signal?: AbortSignal) { const id = eventClientUuid(eventId); eventClientObject(value, ["expectedRevision", "missionIds", "endsAt"]); integer(value.expectedRevision, 0, 999999); if (!Array.isArray(value.missionIds) || value.missionIds.length > 6 || new Set(value.missionIds).size !== value.missionIds.length || value.missionIds.some(mid => !EVENT_MISSIONS.some(m => m.id === mid))) fail("invalid_request"); return parseEventMissions(await io.request(`/${id}`, "saveMissions", { ...value, endsAt: eventClientInstant(value.endsAt) }, signal), id); },
    async guestbook(eventId: string, page: { after?: string; limit?: number } = {}, signal?: AbortSignal) {
      const id = eventClientUuid(eventId), limit = integer(page.limit ?? 25, 1, 25), after = page.after === undefined ? undefined : eventClientUuid(page.after);
      const b = eventClientObject(await io.request(`/${id}`, "guestbook", { limit, ...(after ? { after } : {}) }, signal), ["version", "entries", "nextCursor"]); if (b.version !== 1 || !Array.isArray(b.entries) || b.entries.length > limit) fail(); let previous = after ?? "";
      const entries = (b.entries as unknown[]).map(item => { const e = eventClientObject(item, ["submissionId", "note", "unavailable"]), submissionId = eventClientUuid(e.submissionId); if (submissionId <= previous || e.unavailable !== (e.note === null)) fail(); previous = submissionId; return { submissionId, note: e.note === null ? null : parseEventGuestbookNote(e.note, id, submissionId), unavailable: e.unavailable as boolean }; });
      const nextCursor = b.nextCursor === null ? null : eventClientUuid(b.nextCursor); if (nextCursor !== null && (entries.length !== limit || nextCursor !== previous)) fail(); return { version: 1 as const, entries, nextCursor };
    },
    async create(eventId: string, input: EventCreateInput, signal?: AbortSignal) { const id = eventClientUuid(eventId); return parseEventPublicEvent(await io.request("", "create", { eventId: id, event: createInput(input) }, signal), id); },
    async dashboard(eventId: string, page: { after?: string; limit?: number } = {}, signal?: AbortSignal): Promise<EventHostDashboard> {
      const id = eventClientUuid(eventId), limit = integer(page.limit ?? 25, 1, 25), after = page.after === undefined ? undefined : eventClientUuid(page.after);
      const v = eventClientObject(await io.request(`/${id}`, "dashboard", { limit, ...(after ? { after } : {}) }, signal), ["event", "submissions", "usage"]), u = eventClientObject(v.usage, ["guests", "count", "bytes", "stagingBytes", "derivativeBytes"]);
      if (!Array.isArray(v.submissions) || v.submissions.length > limit) return fail(); const submissions = v.submissions.map(value => parseEventReceipt(value));
      if (new Set(submissions.map(s => s.submissionId)).size !== submissions.length || after && submissions.some(s => s.submissionId <= after)) fail();
      return { event: parseEventPublicEvent(v.event, id), submissions, usage: { guests: integer(u.guests, 0, 25), count: integer(u.count, 0, 100), bytes: integer(u.bytes, 0, EVENT_LIMITS.eventBytes), stagingBytes: integer(u.stagingBytes, 0, EVENT_LIMITS.eventBytes), derivativeBytes: integer(u.derivativeBytes, 0, EVENT_LIMITS.eventBytes) } };
    },
    async manage(eventId: string, action: EventHostAction, body: Record<string, unknown> = {}, signal?: AbortSignal) {
      if (action === "update") body = { ...createInput(body) };
      else if (["open", "pause", "close", "delete", "accept_moderator"].includes(action)) eventClientObject(body, []);
      else if (["revoke_guest", "invite_moderator", "revoke_moderator", "remove_submission"].includes(action)) { const key = action === "revoke_guest" ? "guestId" : action === "remove_submission" ? "submissionId" : "userId"; eventClientObject(body, [key]); eventClientUuid(body[key]); }
      else if (action === "publication") { eventClientObject(body, ["submissionId", "destination", "state"]); eventClientUuid(body.submissionId); if (!["gallery", "wall"].includes(body.destination as string) || !["approved", "hidden", "rejected"].includes(body.state as string)) fail("invalid_request"); }
      else fail("invalid_request");
      const id = eventClientUuid(eventId), result = await io.request(`/${id}`, "manage", { action, body }, signal);
      if (action === "accept_moderator") { const v = eventClientObject(result, ["accepted"]); if (v.accepted !== true) fail(); return { accepted: true as const }; }
      return parseEventPublicEvent(result, id);
    },
    async issue(eventId: string, input: { requestId: string; kind: "invite" | "gallery" | "display"; expiresAt: string; rotate: boolean }, signal?: AbortSignal) {
      eventClientObject(input, ["requestId", "kind", "expiresAt", "rotate"]); const requested = eventClientInstant(input.expiresAt);
      if (!["invite", "gallery", "display"].includes(input.kind) || typeof input.rotate !== "boolean" || input.rotate && input.kind !== "invite") fail("invalid_request");
      const v = eventClientObject(await io.request(`/${eventClientUuid(eventId)}`, "issue", { ...input, requestId: eventClientUuid(input.requestId), expiresAt: requested }, signal), ["kind", "token", "expiresAt", "fragmentOnly"]), expiresAt = eventClientInstant(v.expiresAt);
      if (v.kind !== input.kind || v.fragmentOnly !== true || expiresAt > requested) fail(); return { kind: input.kind, token: secret(v.token), expiresAt, fragmentOnly: true as const };
    },
    async revokeToken(eventId: string, token: string, signal?: AbortSignal) { const id = eventClientUuid(eventId); return parseEventPublicEvent(await io.request(`/${id}`, "revokeToken", { token: secret(token) }, signal), id); },
  };
}
export function createEventGuestClient(options: EventGuestClientOptions) {
  const eventId = eventClientUuid(options.eventId), initial = options.identity();
  if (initial && (eventClientUuid(initial.eventId) !== eventId || !eventClientUuid(initial.guestId))) fail("identity_changed"); if (initial) integer(initial.epoch, 0, Number.MAX_SAFE_INTEGER);
  const io = transport(options, options.identity), path = `/${eventId}/guest`;
  function grant(value: unknown, submissionId: string, upload: true): EventUploadGrant;
  function grant(value: unknown, submissionId: string, upload: false): EventMediaGrant;
  function grant(value: unknown, submissionId: string, upload: boolean): EventUploadGrant | EventMediaGrant {
    const v = eventClientObject(value, ["submissionId", "bucket", "path", "signedUrl", "expiresAt", "maxBytes", upload ? "overwrite" : "mime"]), expectedBucket = upload ? "photobooth-event-images-staging-v2" : "photobooth-events-v2", expectedPath = `${eventId}/${submissionId}/${upload ? "source" : "image"}`, expiresAt = eventClientInstant(v.expiresAt);
    if (!options.storageOrigin) return fail("provider_unavailable");
    let origin: URL, signed: URL; try { origin = new URL(options.storageOrigin); signed = new URL(v.signedUrl as string); } catch { return fail(); }
    if (origin.origin !== options.storageOrigin || origin.username || origin.password || origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)) || v.submissionId !== submissionId || v.bucket !== expectedBucket || v.path !== expectedPath || v.maxBytes !== EVENT_LIMITS.imageBytes || upload && v.overwrite !== false || !upload && v.mime !== "image/jpeg" || signed.origin !== origin.origin || signed.username || signed.password || signed.hash || signed.pathname !== `/storage/v1/object/${upload ? "upload/sign" : "sign"}/${expectedBucket}/${expectedPath}` || [...signed.searchParams.keys()].join() !== "token" || !signed.searchParams.get("token") || signed.href.length > 16384 || Date.parse(expiresAt) <= Date.now() || Date.parse(expiresAt) > Date.now() + (upload ? EVENT_LIMITS.uploadSeconds : EVENT_LIMITS.readSeconds) * 1000) return fail();
    return upload ? { submissionId, bucket: "photobooth-event-images-staging-v2", path: expectedPath, signedUrl: signed.href, expiresAt, maxBytes: EVENT_LIMITS.imageBytes, overwrite: false } : { submissionId, bucket: "photobooth-events-v2", path: expectedPath, signedUrl: signed.href, expiresAt, maxBytes: EVENT_LIMITS.imageBytes, mime: "image/jpeg" };
  }
  function session(value: unknown, redeemed = false): EventSession {
    const v = eventClientObject(value, ["eventId", "kind", "guestId", "submissionId", "expiresAt", ...(redeemed ? ["replacesBrowserGuestSession"] : [])]);
    if (v.eventId !== eventId || v.kind !== "contribute" || v.submissionId !== null || redeemed && v.replacesBrowserGuestSession !== true) return fail();
    const guestId = eventClientUuid(v.guestId); if (initial && guestId !== initial.guestId) fail("identity_changed");
    return { eventId, kind: "contribute", guestId, submissionId: null, expiresAt: eventClientInstant(v.expiresAt) };
  }
  function guest() { io.assertActive(); if (!initial) return fail("identity_required"); return initial.guestId; }
  return {
    eventId, guestId: initial?.guestId ?? null, capabilities: io.capabilities, assertActive: io.assertActive, close: io.close,
    async redeem(inviteToken: string, nonce: string, signal?: AbortSignal) { if (initial) fail("explicit_replacement_required"); return session(await io.request(path, "redeem", { inviteToken: secret(inviteToken), nonce: secret(nonce) }, signal), true); },
    async session(signal?: AbortSignal) { return session(await io.request(path, "session", {}, signal)); },
    async context(signal?: AbortSignal): Promise<EventGuestContext> {
      const v = eventClientObject(await io.request(path, "context", { expectedGuestId: guest() }, signal), ["version", "eventId", "title", "timezone", "startsAt", "closesAt", "expiresAt", "status", "look", "capacityAvailable", "canReserve"], ["serviceAvailable"]);
      if (v.version !== 1 || v.eventId !== eventId || v.serviceAvailable !== undefined && typeof v.serviceAvailable !== "boolean" || v.canReserve && v.serviceAvailable === false || typeof v.capacityAvailable !== "boolean" || typeof v.canReserve !== "boolean" || v.canReserve && (!v.capacityAvailable || v.status !== "open")) return fail();
      const event = parseEventPublicEvent({ eventId, title: v.title, timezone: v.timezone, startsAt: v.startsAt, closesAt: v.closesAt, expiresAt: v.expiresAt, status: v.status, maxGuests: 1, maxContributions: 1, maxBytes: 4100000 });
      let look: EventGuestContext["look"]; try { look = validateEventLook(v.look); } catch { return fail(); }
      return { version: 1, eventId, title: event.title, timezone: event.timezone, startsAt: event.startsAt, closesAt: event.closesAt, expiresAt: event.expiresAt, status: event.status, look, capacityAvailable: v.capacityAvailable, canReserve: v.canReserve, ...(v.serviceAvailable === undefined ? {} : { serviceAvailable: v.serviceAvailable as boolean }) };
    },
    async missions(signal?: AbortSignal) { return parseEventMissions(await io.request(path, "missions", { expectedGuestId: guest() }, signal), eventId); },
    async guestbook(submissionId: string, signal?: AbortSignal) { const id = eventClientUuid(submissionId); return parseEventGuestbookNote(await io.request(path, "guestbook", { submissionId: id, expectedGuestId: guest() }, signal), eventId, id); },
    async receiptGuestbook(submissionId: string, signal?: AbortSignal) { const id = eventClientUuid(submissionId); return parseEventGuestbookNote(await io.request(`/${eventId}/receipts/${id}`, "guestbook", {}, signal), eventId, id); },
    async saveGuestbook(submissionId: string, value: { requestId: string; expectedRevision: number; message: string; signature: string }, signal?: AbortSignal) {
      const id = eventClientUuid(submissionId); eventClientObject(value, ["requestId", "expectedRevision", "message", "signature"]); const text = validateGuestbookText(value.message, value.signature), requestId = eventClientUuid(value.requestId);
      const b = eventClientObject(await io.request(path, "saveGuestbook", { submissionId: id, expectedGuestId: guest(), requestId, expectedRevision: integer(value.expectedRevision, 0, 999999), ...text }, signal), ["acceptedRequestId", "acceptedRevision", "current"]), current = parseEventGuestbookNote(b.current, eventId, id);
      if (b.acceptedRequestId !== requestId) fail(); return { acceptedRequestId: requestId, acceptedRevision: integer(b.acceptedRevision, 1, current.revision), current };
    },
    async withdrawGuestbook(submissionId: string, receiptOnly = false, signal?: AbortSignal) { const id = eventClientUuid(submissionId), b = eventClientObject(await io.request(receiptOnly ? `/${eventId}/receipts/${id}` : path, "withdrawGuestbook", receiptOnly ? {} : { submissionId: id, expectedGuestId: guest() }, signal), ["submissionId", "withdrawn"]); if (b.submissionId !== id || b.withdrawn !== true) fail(); return { submissionId: id, withdrawn: true as const }; },
    async reserveMission(input: { requestId: string; submissionId: string; consent: EventConsent; missionId: string | null }, signal?: AbortSignal) {
      eventClientObject(input, ["requestId", "submissionId", "consent", "missionId"]); const consent = eventClientConsent(input.consent); if (!consent.submission || input.missionId !== null && !EVENT_MISSIONS.some(m => m.id === input.missionId)) fail("invalid_request");
      const submissionId = eventClientUuid(input.submissionId), v = eventClientObject(await io.request(path, "reserveMission", { requestId: eventClientUuid(input.requestId), submissionId, consent, missionId: input.missionId, expectedGuestId: guest() }, signal), ["receipt", "receiptToken", "replacesBrowserReceipt", "fragmentOnly"]);
      if (v.replacesBrowserReceipt !== true || v.fragmentOnly !== true) fail(); return { receipt: parseEventReceipt(v.receipt, submissionId), receiptToken: secret(v.receiptToken), replacesBrowserReceipt: true as const, fragmentOnly: true as const };
    },
    async reserve(input: { requestId: string; submissionId: string; consent: EventConsent }, signal?: AbortSignal) {
      eventClientObject(input, ["requestId", "submissionId", "consent"]); const consent = eventClientConsent(input.consent); if (!consent.submission) fail("invalid_request");
      const submissionId = eventClientUuid(input.submissionId), v = eventClientObject(await io.request(path, "reserve", { requestId: eventClientUuid(input.requestId), submissionId, consent, expectedGuestId: guest() }, signal), ["receipt", "receiptToken", "replacesBrowserReceipt", "fragmentOnly"]);
      if (v.replacesBrowserReceipt !== true || v.fragmentOnly !== true) fail(); return { receipt: parseEventReceipt(v.receipt, submissionId), receiptToken: secret(v.receiptToken), replacesBrowserReceipt: true as const, fragmentOnly: true as const };
    },
    async ownConsent(submissionId: string, signal?: AbortSignal) { const id = eventClientUuid(submissionId); return parseEventOwnConsent(await io.request(path, "ownConsent", { submissionId: id, expectedGuestId: guest() }, signal), eventId, id); },
    async saveOwnConsent(submissionId: string, value: { expectedRevision: number; gallery: boolean; wall: boolean }, signal?: AbortSignal) { const id = eventClientUuid(submissionId); eventClientObject(value, ["expectedRevision", "gallery", "wall"]); if (typeof value.gallery !== "boolean" || typeof value.wall !== "boolean") fail("invalid_request"); return parseEventOwnConsent(await io.request(path, "saveOwnConsent", { submissionId: id, expectedGuestId: guest(), expectedRevision: integer(value.expectedRevision, 0, 2147483647), gallery: value.gallery, wall: value.wall }, signal), eventId, id); },
    async consent(submissionId: string, consent: EventConsent, signal?: AbortSignal) { const id = eventClientUuid(submissionId); return parseEventReceipt(await io.request(path, "consent", { submissionId: id, consent: eventClientConsent(consent), expectedGuestId: guest() }, signal), id); },
    async finalise(submissionId: string, signal?: AbortSignal) { const id = eventClientUuid(submissionId); return parseEventReceipt(await io.request(path, "finalise", { submissionId: id, expectedGuestId: guest() }, signal), id); },
    async exchangeReceipt(submissionId: string, token: string, signal?: AbortSignal) { const id = eventClientUuid(submissionId); return parseEventReceipt(await io.request(`/${eventId}/receipts/${id}`, "exchange", { token: secret(token) }, signal), id); },
    async readReceipt(submissionId: string, signal?: AbortSignal) { const id = eventClientUuid(submissionId); return parseEventReceipt(await io.request(`/${eventId}/receipts/${id}`, "read", {}, signal), id); },
    async mintUpload(submissionId: string, signal?: AbortSignal): Promise<EventUploadGrant> { const id = eventClientUuid(submissionId); return grant(await io.request(path, "upload", { submissionId: id, expectedGuestId: guest() }, signal), id, true); },
    async upload(submissionId: string, blob: Blob, authorisation: EventUploadGrant, signal?: AbortSignal): Promise<{ acknowledged: boolean }> {
      guest(); const id = eventClientUuid(submissionId), checked = grant(authorisation, id, true); if (!(blob instanceof Blob) || blob.size < 1 || blob.size > EVENT_LIMITS.imageBytes) fail("invalid_request");
      const info = inspectImageHeader(new Uint8Array(await blob.arrayBuffer())); io.assertActive(signal);
      const result = await io.binary(checked.signedUrl, { method: "PUT", headers: { "Content-Type": info.mime, "x-upsert": "false" }, body: blob }, 65536, signal);
      if (!result.ok && result.status !== 409) throw new EventClientError("upload_uncertain", result.status); return { acknowledged: result.ok };
    },
    async media(submissionId: string, signal?: AbortSignal): Promise<EventMediaGrant> { const id = eventClientUuid(submissionId); return grant(await io.request(`/${eventId}/receipts/${id}`, "media", {}, signal), id, false); },
    async download(submissionId: string, signal?: AbortSignal): Promise<{ blob: Blob; width: number; height: number }> {
      const id = eventClientUuid(submissionId), endpoint = `/${eventId}/receipts/${id}`, before = grant(await io.request(endpoint, "media", {}, signal), id, false);
      const result = await io.binary(before.signedUrl, { method: "GET" }, EVENT_LIMITS.imageBytes, signal); if (!result.ok) throw new EventClientError("source_unavailable", result.status);
      const info = inspectImageHeader(result.bytes); if (info.mime !== "image/jpeg" || !/^image\/jpeg(?:;|$)/i.test(result.mime ?? "")) fail();
      grant(await io.request(endpoint, "media", {}, signal), id, false); io.assertActive(signal);
      return { blob: new Blob([result.bytes], { type: "image/jpeg" }), width: info.width, height: info.height };
    },
  };
}
export type EventHostClient = ReturnType<typeof createEventHostClient>;
export type EventGuestClient = ReturnType<typeof createEventGuestClient>;
