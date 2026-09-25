import { parseEventExportGuestbook } from "./guestbook-contract";
import { EVENT_EXPORT_LIMITS, exportInteger, exportObject, exportUuid, parseEventExportAccess, parseEventExportPage, parseEventExportSummary, parseEventExportRetired, validateEventExportUpdates, type EventExportAccess, type EventExportEntry, type EventExportUpdate } from "./export-contract";
import { inspectImageHeader } from "../projects/images";

export class EventExportError extends Error { constructor(readonly code: string, readonly status = 0) { super(code); } }
export interface EventExportClientOptions {
  appOrigin: string; storageOrigin: string; identity(): { ownerId: string; epoch: number } | null;
  accessToken(): Promise<string | null>; fetch?: typeof fetch; timeoutMs?: number;
  decode?: (blob: Blob) => Promise<{ width: number; height: number; close(): void }>;
}
const fail = (code = "invalid_response"): never => { throw new EventExportError(code); };
function origin(value: string, local: boolean) {
  const url = new URL(value);
  if (url.origin !== value || url.username || url.password || url.protocol !== "https:" && !(local && url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) return fail("invalid_configuration");
  return value;
}
const identityFields = (value: EventExportAccess) => ({ bucket: value.bucket, path: value.path, bytes: value.bytes, mime: value.mime, width: value.width, height: value.height, sha256: value.sha256, submissionId: value.submissionId, expiresAt: value.expiresAt });
export function sameExportMedia(access: EventExportAccess, entry: EventExportEntry) {
  const expected = entry.media && { ...entry.media, submissionId: entry.submissionId, expiresAt: entry.expiresAt };
  return !!expected && Object.entries(identityFields(access)).every(([key, value]) => expected[key as keyof typeof expected] === value);
}
let activeDownloads = 0;
export function createEventExportClient(options: EventExportClientOptions) {
  const appOrigin = origin(options.appOrigin, true), storageOrigin = origin(options.storageOrigin, appOrigin.startsWith("http://")), initial = options.identity(), fetcher = options.fetch ?? fetch;
  if (!initial || typeof location !== "undefined" && location.origin !== appOrigin) return fail("invalid_configuration");
  const ownerId = exportUuid(initial.ownerId), epoch = exportInteger(initial.epoch, 0, Number.MAX_SAFE_INTEGER), lifetime = new AbortController(), timeoutMs = options.timeoutMs ?? 10000;
  exportInteger(timeoutMs, 1, 10000); let working = false;
  const assertActive = (signal?: AbortSignal) => { const current = options.identity(); if (!current || current.ownerId !== ownerId || current.epoch !== epoch) { lifetime.abort(); fail("identity_changed"); } if (lifetime.signal.aborted || signal?.aborted) fail("cancelled"); };
  async function run<T>(signal: AbortSignal | undefined, work: (active: AbortSignal) => Promise<T>, milliseconds = timeoutMs): Promise<T> {
    assertActive(signal); if (working) return fail("busy"); working = true;
    const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(), milliseconds), active = AbortSignal.any([lifetime.signal, deadline.signal, ...(signal ? [signal] : [])]);
    let onAbort = () => {};
    const interrupted = new Promise<never>((_, reject) => { onAbort = () => reject(new EventExportError(deadline.signal.aborted ? "timeout" : "cancelled")); active.addEventListener("abort", onAbort, { once: true }); });
    const actual = (async () => { try { const result = await work(active); assertActive(active); return result; } finally { working = false; } })();
    try { return await Promise.race([actual, interrupted]); }
    catch (error) { assertActive(signal); if (error instanceof EventExportError) throw error; return fail("network_error"); }
    finally { clearTimeout(timer); active.removeEventListener("abort", onAbort); }
  }
  async function read(response: Response, limit: number, active: AbortSignal) {
    const length = response.headers.get("content-length"), reader = response.body?.getReader();
    const chunks: Uint8Array[] = []; let total = 0;
    const cancel = () => { void reader?.cancel().catch(() => {}); }; active.addEventListener("abort", cancel, { once: true });
    try {
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) fail("response_too_large");
      if (reader) while (true) { assertActive(active); const next = await reader.read(); assertActive(active); if (next.done) break; total += next.value.length; if (total > limit || chunks.length >= 4096) fail("response_too_large"); chunks.push(next.value); }
      if (length !== null && Number(length) !== total) fail("integrity_failed");
      const result = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; } return result;
    } finally { active.removeEventListener("abort", cancel); cancel(); reader?.releaseLock(); }
  }
  async function request(eventId: string, operation: string, data: Record<string, unknown>, active: AbortSignal) {
    exportUuid(eventId); assertActive(active); const token = await options.accessToken(); assertActive(active);
    if (!token || token.length > 16384 || /[\s,]/.test(token)) fail("access_denied");
    const body = JSON.stringify({ operation, ...data }); if (body.length > 8192) fail("invalid_request");
    const url = `${appOrigin}/api/events/${eventId}/exports`, response = await fetcher(url, { method: "POST", credentials: "omit", cache: "no-store", redirect: "error", signal: active, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body });
    if (active.aborted || response.redirected || response.url && response.url !== url) { void response.body?.cancel(); assertActive(active); fail(); }
    if (!/^application\/json(?:;|$)/i.test(response.headers.get("content-type") ?? "")) { void response.body?.cancel(); fail(); }
    const bytes = await read(response, EVENT_EXPORT_LIMITS.manifestBytes, active); assertActive(active);
    let result: unknown; try { result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { return fail(); }
    if (!response.ok) {
      const b = exportObject(result, ["error"]), allowed = ["invalid_request", "access_denied", "origin_denied", "capacity", "conflict", "expired", "unavailable", "not_ready", "rate_limited"];
      throw new EventExportError(allowed.includes(String(b.error)) ? String(b.error) : "unavailable", response.status);
    }
    return result;
  }
  const accessWork = async (eventId: string, exportId: string, generation: number, index: number, active: AbortSignal) => parseEventExportAccess(await request(eventId, "access", { exportId: exportUuid(exportId), generation: exportInteger(generation, 0, 2147483646), index: exportInteger(index, 0, 99) }, active), eventId);
  return {
    retire(eventId: string, exportId: string, generation: number, revision: number, signal?: AbortSignal) { return run(signal, async active => { const result = parseEventExportRetired(await request(eventId, "retire", { exportId: exportUuid(exportId), generation: exportInteger(generation, 0, 2147483645), revision: exportInteger(revision, 0, 1000000) }, active)); if (result.exportId !== exportId || result.generation !== generation + 1) return fail(); return result; }); },
    ownerId, assertActive, close() { lifetime.abort(); },
    list(eventId: string, signal?: AbortSignal) { return run(signal, async active => {
      const b = exportObject(await request(eventId, "list", {}, active), ["version", "exports", "retired"]);
      if (b.version !== 1 || !Array.isArray(b.exports) || b.exports.length > 8 || !Array.isArray(b.retired)) return fail();
      const exports = b.exports.map(v => parseEventExportSummary(v, eventId)); if (new Set(exports.map(v => v.exportId)).size !== exports.length) return fail(); const retired = b.retired.map(parseEventExportRetired); if (exports.length + retired.length > 8 || new Set([...exports, ...retired].map(x => x.exportId)).size !== exports.length + retired.length) return fail(); return { version: 1 as const, exports, retired };
    }); },
    create(eventId: string, exportId: string, afterSubmissionId?: string, generation = 0, signal?: AbortSignal) { return run(signal, async active => {
      const result = parseEventExportSummary(await request(eventId, "create", { exportId: exportUuid(exportId), generation: exportInteger(generation, 0, 2147483646), ...(afterSubmissionId ? { afterSubmissionId: exportUuid(afterSubmissionId) } : {}) }, active), eventId, exportId);
      if (result.generation !== generation || result.afterSubmissionId !== (afterSubmissionId ?? null)) return fail(); return result;
    }); },
    page(eventId: string, exportId: string, generation: number, after = -1, limit = 10, signal?: AbortSignal) { return run(signal, async active => parseEventExportPage(await request(eventId, "page", { exportId: exportUuid(exportId), generation: exportInteger(generation, 0, 2147483646), after: exportInteger(after, -1, 99), limit: exportInteger(limit, 1, 10) }, active), eventId, exportId, after, limit)); },
    guestbook(eventId: string, exportId: string, generation: number, index: number, signal?: AbortSignal) { return run(signal, async active => parseEventExportGuestbook(await request(eventId, "guestbook", { exportId: exportUuid(exportId), generation: exportInteger(generation, 0, 2147483646), index: exportInteger(index, 0, 99) }, active), eventId)); },
    access(eventId: string, exportId: string, generation: number, index: number, signal?: AbortSignal) { return run(signal, active => accessWork(eventId, exportId, generation, index, active)); },
    checkpoint(eventId: string, exportId: string, generation: number, revision: number, updates: EventExportUpdate[], signal?: AbortSignal) { return run(signal, async active => parseEventExportSummary(await request(eventId, "checkpoint", { exportId: exportUuid(exportId), generation: exportInteger(generation, 0, 2147483646), revision: exportInteger(revision, 0, 999999), updates: validateEventExportUpdates(updates) }, active), eventId, exportId)); },
    download(eventId: string, exportId: string, generation: number, entry: EventExportEntry, signal?: AbortSignal) { return run(signal, async active => {
      if (activeDownloads) return fail("busy"); activeDownloads++;
      let bytes: Uint8Array | undefined, delivered = false;
      try {
        const value = exportObject(await request(eventId, "media", { exportId: exportUuid(exportId), generation: exportInteger(generation, 0, 2147483646), index: exportInteger(entry.index, 0, 99) }, active), ["bucket", "path", "bytes", "mime", "width", "height", "sha256", "submissionId", "expiresAt", "retainedUntil", "signedUrl"]);
        const { signedUrl, retainedUntil, expiresAt: signedExpiry, ...fields } = value;
        const descriptor = parseEventExportAccess({ ...fields, expiresAt: retainedUntil, maxAgeSeconds: 300 }, eventId);
        if (!sameExportMedia(descriptor, entry) || typeof signedExpiry !== "string" || !Number.isFinite(Date.parse(signedExpiry)) || Date.parse(signedExpiry) <= Date.now() || Date.parse(signedExpiry) > Math.min(Date.parse(descriptor.expiresAt), Date.now() + 300000) || typeof signedUrl !== "string" || signedUrl.length > 20000) return fail();
        const url = new URL(signedUrl), expected = `/storage/v1/object/sign/${descriptor.bucket}/${descriptor.path}`;
        if (url.origin !== storageOrigin || url.pathname !== expected || url.username || url.password || url.hash || [...url.searchParams.keys()].length !== 1 || !url.searchParams.get("token") || url.searchParams.get("token")!.length > 16384) return fail();
        const response = await fetcher(url.href, { method: "GET", credentials: "omit", cache: "no-store", redirect: "error", signal: active });
        if (active.aborted) { void response.body?.cancel(); assertActive(active); } assertActive(active);
        if (response.status !== 200 || response.redirected || response.url && response.url !== url.href || response.headers.get("content-type")?.split(";")[0] !== "image/jpeg") { void response.body?.cancel(); fail("download_failed"); }
        bytes = await read(response, descriptor.bytes, active); assertActive(active);
        const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)))].map(x => x.toString(16).padStart(2, "0")).join(""); assertActive(active);
        if (bytes.length !== descriptor.bytes || hash !== descriptor.sha256) return fail("integrity_failed");
        const header = inspectImageHeader(bytes); if (header.mime !== descriptor.mime || header.width !== descriptor.width || header.height !== descriptor.height) return fail("integrity_failed");
        const bitmap = await (options.decode ?? (blob => createImageBitmap(blob, { imageOrientation: "from-image" })))(new Blob([new Uint8Array(bytes)], { type: descriptor.mime }));
        try { assertActive(active); if (bitmap.width !== descriptor.width || bitmap.height !== descriptor.height) fail("integrity_failed"); } finally { bitmap.close(); }
        if (!sameExportMedia(await accessWork(eventId, exportId, generation, entry.index, active), entry)) return fail("access_denied"); assertActive(active);
        delivered = true; return bytes;
      } finally { if (!delivered) bytes?.fill(0); activeDownloads--; }
    }, Math.max(timeoutMs, 30000)); },
  };
}
export type EventExportClient = ReturnType<typeof createEventExportClient>;
