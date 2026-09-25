import { createHash } from "node:crypto";
import { EVENT_LIMITS, type EventObjectAccess, type EventUploadAuthorisation } from "../events/contract";
import { supabaseServiceOrigin } from "./cron-auth";
import { isStorageObjectAbsent } from "./storage-absence";

export interface EventObjectDescriptor { eventId: string; submissionId: string; kind: "source" | "image" | "thumbnail" }
export interface EventObjectUpload extends EventObjectDescriptor { kind: "image" | "thumbnail"; jobId: string; lease: string; leaseUntil: string; mime: "image/jpeg"; bytes: number; sha256: string }
export interface EventObjects {
  download(object: EventObjectDescriptor, signal?: AbortSignal): Promise<Uint8Array | null>;
  upload(object: EventObjectUpload, bytes: Uint8Array, signal?: AbortSignal): Promise<void>;
  removeAndConfirmAbsent(object: EventObjectDescriptor, signal?: AbortSignal): Promise<boolean>;
}
export interface EventSignedObject { signedUrl: string; expiresAt: string }
export interface EventSigningObjects {
  mintUpload(authorisation: EventUploadAuthorisation, signal?: AbortSignal): Promise<EventSignedObject>;
  signRead(access: EventObjectAccess, expiresBefore: string, signal?: AbortSignal): Promise<EventSignedObject>;
}
export class EventObjectError extends Error {
  constructor(readonly code: "invalid_descriptor" | "provider_failure" | "deadline" | "cancelled" | "object_too_large" | "size_mismatch" | "lease_lost" | "mint_expired" | "busy") { super(code); }
}
const fail = (code: EventObjectError["code"]): never => { throw new EventObjectError(code); };
const uuid = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
let activeRequests = 0;
export function eventObjectLocation(value: EventObjectDescriptor) {
  if (!value || !uuid(value.eventId) || !uuid(value.submissionId) || !["source", "image", "thumbnail"].includes(value.kind)) return fail("invalid_descriptor");
  return { bucket: value.kind === "source" ? "photobooth-event-images-staging-v2" : "photobooth-events-v2", path: `${value.eventId}/${value.submissionId}/${value.kind}`, maxBytes: value.kind === "thumbnail" ? EVENT_LIMITS.thumbnailBytes : EVENT_LIMITS.imageBytes };
}
function exactLocation(bucket: string, path: string, kind: "source" | "image" | "thumbnail") {
  const parts = typeof path === "string" ? path.split("/") : [];
  if (parts.length !== 3) return fail("invalid_descriptor");
  const expected = eventObjectLocation({ eventId: parts[0], submissionId: parts[1], kind });
  if (bucket !== expected.bucket || path !== expected.path) return fail("invalid_descriptor");
  return expected;
}
function parseSignedObject(value: unknown, origin: string, endpoint: string, objectPath: string, kind: "upload" | "download", now: number, until: number): EventSignedObject {
  try {
    if (typeof value !== "string" || value.length > 20000) return fail("provider_failure");
    const url = new URL(value.startsWith("/object/") ? `${origin}/storage/v1${value}` : value), token = url.searchParams.get("token");
    if (url.origin !== origin || url.pathname !== `/storage/v1${endpoint}` || url.username || url.password || url.hash || [...url.searchParams.keys()].length !== 1 || !token || token.length > 16384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return fail("provider_failure");
    const payload: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(token.split(".")[1], "base64url")));
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return fail("provider_failure");
    const p = payload as Record<string, unknown>, expiry = typeof p.exp === "number" ? p.exp * 1000 : NaN;
    // These are expiry constraints on the trusted provider response, not caller authentication.
    if (!Number.isSafeInteger(p.exp) || expiry <= now || expiry > until || p.url !== objectPath || p.scope !== undefined && p.scope !== kind || (kind === "upload" ? p.upsert !== false : ["upsert", "owner", "role", "transform"].some(key => key in p))) return fail("provider_failure");
    return { signedUrl: url.href, expiresAt: new Date(expiry).toISOString() };
  } catch { return fail("provider_failure"); }
}
export function createEventObjects(config: { origin: string; serviceRoleKey: string }, ports: { fetch?: typeof fetch; now?: () => number; timeoutMs?: number } = {}): EventObjects & EventSigningObjects {
  const origin = supabaseServiceOrigin(config.origin), key = config.serviceRoleKey, transport = ports.fetch ?? fetch, now = ports.now ?? Date.now, timeoutMs = ports.timeoutMs ?? 10_000;
  if (!origin || origin !== config.origin || !key?.trim() || key.length > 16384 || /[\r\n]/.test(key) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) return fail("invalid_descriptor");
  async function request(method: string, path: string, maximum: number, signal?: AbortSignal, body?: BodyInit, extra?: Record<string, string>, presenceOnly = false) {
    if (signal?.aborted) return fail("cancelled"); if (activeRequests >= 2) return fail("busy"); activeRequests++;
    const deadline = new AbortController(), active = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal, timer = setTimeout(() => deadline.abort(), timeoutMs), url = `${origin}/storage/v1${path}`;
    const check = () => { if (signal?.aborted) fail("cancelled"); if (deadline.signal.aborted) fail("deadline"); };
    let response: Response | undefined;
    try {
      response = await transport(url, { method, headers: { Authorization: `Bearer ${key}`, apikey: key, ...extra }, body, signal: active, redirect: "error", cache: "no-store", credentials: "omit" }); check();
      if (response.redirected || response.url !== url || response.status >= 300 && response.status < 400) return fail("provider_failure");
      if (method === "GET" && path.startsWith("/object/authenticated/") && await isStorageObjectAbsent(response, active)) { check(); return { status: 404, bytes: new Uint8Array() }; }
      if (presenceOnly && response.status === 200) return { status: 200, bytes: new Uint8Array() };
      if (method === "HEAD" || response.status !== 200 && !(method === "POST" && response.status === 201)) return { status: response.status, bytes: new Uint8Array() };
      const length = response.headers.get("content-length");
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum)) return fail("object_too_large");
      if (!response.body) return { status: response.status, bytes: new Uint8Array() };
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
      const cancel = () => { void reader.cancel().catch(() => {}); }; active.addEventListener("abort", cancel, { once: true });
      try {
        while (true) { check(); const next = await reader.read(); check(); if (next.done) break; size += next.value.byteLength; if (size > maximum || chunks.length >= 4096) fail("object_too_large"); chunks.push(next.value); }
      } finally { active.removeEventListener("abort", cancel); void reader.cancel().catch(() => {}); reader.releaseLock(); }
      if (length !== null && Number(length) !== size) return fail("size_mismatch");
      const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      return { status: response.status, bytes };
    } catch (error) { check(); if (error instanceof EventObjectError) throw error; return fail("provider_failure"); }
    finally { void response?.body?.cancel().catch(() => {}); clearTimeout(timer); activeRequests--; }
  }
  async function json(path: string, body: unknown, signal?: AbortSignal) {
    const response = await request("POST", path, 65536, signal, JSON.stringify(body), { "content-type": "application/json" }).catch(error => {
      if (error instanceof EventObjectError && ["object_too_large", "size_mismatch"].includes(error.code)) return fail("provider_failure");
      throw error;
    });
    if (response.status !== 200) return fail("provider_failure");
    try {
      const result: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.bytes));
      if (!result || typeof result !== "object" || Array.isArray(result)) return fail("provider_failure");
      return result as Record<string, unknown>;
    } catch { return fail("provider_failure"); }
  }
  return {
    async mintUpload(authorisation, signal) {
      const d = exactLocation(authorisation.bucket, authorisation.path, "source"), mint = Date.parse(authorisation.mintBefore), until = Date.parse(authorisation.authorisationUntil), cleanup = Date.parse(authorisation.cleanupAfter);
      if (!Number.isFinite(mint) || until - mint !== EVENT_LIMITS.uploadSeconds * 1000 || cleanup - until !== EVENT_LIMITS.cleanupMarginSeconds * 1000 || mint > now() + 61000 || authorisation.overwrite !== false || authorisation.maxBytes !== EVENT_LIMITS.imageBytes || !Number.isSafeInteger(authorisation.generation) || authorisation.generation < 1 || authorisation.generation > 8) return fail("invalid_descriptor");
      const fence = () => { if (now() >= mint) fail("mint_expired"); };
      const endpoint = `/object/upload/sign/${d.bucket}/${d.path}`;
      fence();
      // The installed SDK omits x-upsert to request an immutable signed upload.
      const data = await json(endpoint, {}, signal); fence();
      return parseSignedObject(data.url, origin, endpoint, `${d.bucket}/${d.path}`, "upload", now(), Math.min(until, now() + EVENT_LIMITS.uploadSeconds * 1000));
    },
    async signRead(access, expiresBefore, signal) {
      const d = exactLocation(access.bucket, access.path, typeof access.path === "string" && access.path.endsWith("/thumbnail") ? "thumbnail" : "image"), promised = Date.parse(expiresBefore), started = now();
      if (!Number.isFinite(promised) || !Number.isSafeInteger(access.maxAgeSeconds) || access.maxAgeSeconds < 1 || access.maxAgeSeconds > EVENT_LIMITS.readSeconds) return fail("invalid_descriptor");
      const until = Math.min(promised, started + access.maxAgeSeconds * 1000);
      // Reserve the full provider deadline so issuance latency cannot extend a read grant.
      const seconds = Math.floor((until - started) / 1000) - 10;
      if (seconds < 1) return fail("mint_expired");
      const endpoint = `/object/sign/${d.bucket}/${d.path}`, data = await json(endpoint, { expiresIn: seconds }, signal);
      return parseSignedObject(data.signedURL, origin, endpoint, `${d.bucket}/${d.path}`, "download", now(), until);
    },
    async download(object, signal) {
      const d = eventObjectLocation(object), response = await request("GET", `/object/authenticated/${d.bucket}/${d.path}`, d.maxBytes, signal);
      if (response.status === 404) return null;
      if (response.status !== 200) return fail("provider_failure");
      if (!response.bytes.length) return fail("size_mismatch");
      return response.bytes;
    },
    async upload(object, bytes, signal) {
      const d = eventObjectLocation(object);
      if (!["image", "thumbnail"].includes(object.kind) || !uuid(object.jobId) || !uuid(object.lease) || object.mime !== "image/jpeg" || !Number.isFinite(Date.parse(object.leaseUntil)) || !Number.isSafeInteger(object.bytes) || object.bytes < 1 || object.bytes > d.maxBytes || !(bytes instanceof Uint8Array) || bytes.length !== object.bytes || hash(bytes) !== object.sha256) return fail("invalid_descriptor");
      if (now() >= Date.parse(object.leaseUntil)) return fail("lease_lost");
      // Raw-byte uploads use the installed Storage SDK's metadata header protocol.
      const response = await request("POST", `/object/${d.bucket}/${d.path}`, 65536, signal, new Uint8Array(bytes), { "content-type": object.mime, "cache-control": "max-age=0", "x-upsert": "false", "x-metadata": Buffer.from(JSON.stringify({ eventJobId: object.jobId, eventLease: object.lease })).toString("base64") }).catch(error => {
        if (error instanceof EventObjectError && ["object_too_large", "size_mismatch"].includes(error.code)) return fail("provider_failure");
        throw error;
      });
      if (now() >= Date.parse(object.leaseUntil)) return fail("lease_lost");
      // Duplicate and ambiguous responses require an independent byte readback.
      if (![200, 201, 400, 409].includes(response.status)) return fail("provider_failure");
    },
    async removeAndConfirmAbsent(object, signal) {
      const d = eventObjectLocation(object), removed = await request("DELETE", `/object/${d.bucket}`, 65536, signal, JSON.stringify({ prefixes: [d.path] }), { "content-type": "application/json" });
      if (removed.status !== 200) return fail("provider_failure");
      let confirmed = await request("HEAD", `/object/${d.bucket}/${d.path}`, 0, signal);
      if (confirmed.status === 400) confirmed = await request("GET", `/object/authenticated/${d.bucket}/${d.path}`, 0, signal, undefined, undefined, true);
      if (confirmed.status === 404) return true;
      if (confirmed.status === 200) return false;
      return fail("provider_failure");
    },
  };
}
