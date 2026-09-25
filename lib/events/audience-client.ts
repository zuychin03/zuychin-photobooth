import { EventClientError, eventClientInstant, eventClientObject, eventClientUuid } from "./client";
import { EVENT_PUBLICATION_LIMITS, parseEventAudienceAccess, parseEventAudiencePage, parseEventAudienceSession, parseEventAudienceValidation, parseEventReportReceipt, type EventAudienceEntry, type EventDestination, type EventReportReason } from "./publication-contract";
import { inspectImageHeader } from "../projects/images";

export interface EventAudienceClientOptions {
  appOrigin: string; storageOrigin: string; eventId: string; destination: EventDestination;
  fetch?: typeof fetch; timeoutMs?: number;
  decode?(blob: Blob): Promise<{ width: number; height: number; close(): void }>;
}
export interface EventAudienceReport { requestId: string; submissionId: string; reason: EventReportReason; detail: string }
const fail = (code = "invalid_response"): never => { throw new EventClientError(code); };
let nativeBusy = false;
export function createEventAudienceClient(options: EventAudienceClientOptions) {
  const origin = (value: string) => { const url = new URL(value); if (url.origin !== value || url.username || url.password || url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) fail("invalid_configuration"); return url.origin; };
  const appOrigin = origin(options.appOrigin), storageOrigin = origin(options.storageOrigin), eventId = eventClientUuid(options.eventId), destination = options.destination;
  if (!["gallery", "wall"].includes(destination) || typeof location !== "undefined" && location.origin !== appOrigin) fail("invalid_configuration");
  const endpoint = `${appOrigin}/api/events/${eventId}/${destination}`, fetcher = options.fetch ?? fetch, lifetime = new AbortController(), timeout = options.timeoutMs ?? 8000;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 10000) fail("invalid_configuration");
  let sessionId: string | null = null, operations = 0, binaryBusy = false;
  const assertActive = (signal?: AbortSignal) => { if (lifetime.signal.aborted || signal?.aborted) fail("cancelled"); };
  async function run<T>(signal: AbortSignal | undefined, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    assertActive(signal); if (operations >= 2) fail("busy"); operations++;
    const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(), timeout), active = AbortSignal.any([lifetime.signal, deadline.signal, ...(signal ? [signal] : [])]); let listener = () => {};
    const interrupted = new Promise<never>((_, reject) => { listener = () => reject(new EventClientError(deadline.signal.aborted ? "timeout" : "cancelled")); active.addEventListener("abort", listener, { once: true }); });
    const work = (async () => { try { return await task(active); } finally { operations--; } })();
    try { const result = await Promise.race([work, interrupted]); assertActive(signal); return result; }
    catch (error) { assertActive(signal); if (error instanceof EventClientError) throw error; throw new EventClientError("invalid_response"); }
    finally { clearTimeout(timer); active.removeEventListener("abort", listener); deadline.abort(); }
  }
  async function bytes(response: Response, maximum: number, signal: AbortSignal) {
    const length = response.headers.get("content-length"); if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum)) { void response.body?.cancel(); fail("response_too_large"); }
    const reader = response.body?.getReader(), chunks: Uint8Array[] = []; let size = 0; const abort = () => { void reader?.cancel().catch(() => undefined); }; signal.addEventListener("abort", abort, { once: true });
    try { if (reader) while (true) { assertActive(signal); const part = await reader.read(); assertActive(signal); if (part.done) break; size += part.value.length; if (size > maximum || chunks.length >= 4096) fail("response_too_large"); chunks.push(part.value); } }
    finally { signal.removeEventListener("abort", abort); if (reader) { void reader.cancel().catch(() => undefined); reader.releaseLock(); } }
    const result = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; } return result;
  }
  async function request(operation: string, input: object, signal: AbortSignal, bound = true) {
    assertActive(signal); if (bound && !sessionId) fail("access_denied");
    const body = JSON.stringify({ operation, ...input, ...(bound ? { expectedSessionId: sessionId } : {}) }); if (new TextEncoder().encode(body).length > 4096) fail("invalid_request");
    const response = await fetcher(endpoint, { method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer", signal, headers: { "Content-Type": "application/json" }, body });
    if (signal.aborted || response.redirected || response.url && response.url !== endpoint || !/^application\/json(?:;|$)/i.test(response.headers.get("content-type") ?? "")) { void response.body?.cancel(); assertActive(signal); fail(); }
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await bytes(response, 32768, signal))); assertActive(signal);
    if (!response.ok) { const b = eventClientObject(value, ["error"]), code = ["access_denied", "identity_changed", "expired", "unavailable", "not_ready", "invalid_request", "conflict", "capacity", "rate_limited", "origin_denied"].includes(String(b.error)) ? String(b.error) : "unavailable"; if (code === "identity_changed") sessionId = null; throw new EventClientError(code, response.status); } return value;
  }
  const fresh = <T extends { checkedAt: string; expiresAt: string }>(value: T) => { if (Date.parse(value.expiresAt) <= Date.now() || Date.parse(value.checkedAt) > Date.now() + 5000 || Date.parse(value.checkedAt) < Date.now() - 10000) fail("expired"); return value; };
  const validation = async (ids: string[], signal: AbortSignal) => fresh(parseEventAudienceValidation(await request("validate", { submissionIds: ids }, signal), eventId, destination, ids));
  return { eventId, destination, assertActive, close() { lifetime.abort(); sessionId = null; },
    capabilities(signal?: AbortSignal) { return run(signal, async active => { const value = eventClientObject(await request("capabilities", {}, active, false), Object.keys(EVENT_PUBLICATION_LIMITS)); if (Object.entries(EVENT_PUBLICATION_LIMITS).some(([key, expected]) => value[key] !== expected)) fail("unavailable"); return EVENT_PUBLICATION_LIMITS; }); },
    session(signal?: AbortSignal) { return run(signal, async active => { const result = fresh(parseEventAudienceSession(await request("session", {}, active, false), eventId, destination)); if (sessionId && sessionId !== result.sessionId) { sessionId = null; fail("identity_changed"); } sessionId = result.sessionId; return result; }); },
    exchange(token: string, signal?: AbortSignal) { return run(signal, async active => { if (!/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(token)) fail("invalid_request"); const result = fresh(parseEventAudienceSession(await request("exchange", { token }, active, false), eventId, destination)); if (sessionId && sessionId !== result.sessionId) fail("identity_changed"); sessionId = result.sessionId; return result; }); },
    list(after?: string, limit = destination === "wall" ? 3 : 12, signal?: AbortSignal) { return run(signal, async active => { if (!Number.isInteger(limit) || limit < 1 || limit > (destination === "wall" ? 3 : 12)) fail("invalid_request"); return fresh(parseEventAudiencePage(await request("list", { ...(after ? { after: eventClientUuid(after) } : {}), limit }, active), eventId, destination, after, limit)); }); },
    validate(submissionIds: string[], signal?: AbortSignal) { return run(signal, active => { if (submissionIds.length > 12 || new Set(submissionIds).size !== submissionIds.length) fail("invalid_request"); return validation(submissionIds.map(eventClientUuid), active); }); },
    report(input: EventAudienceReport, signal?: AbortSignal) { return run(signal, async active => { if (!["privacy", "inappropriate", "other"].includes(input.reason) || typeof input.detail !== "string" || [...input.detail].length > 500 || /[\u0000-\u001f\u007f]/.test(input.detail)) fail("invalid_request"); return parseEventReportReceipt(await request("report", { ...input, requestId: eventClientUuid(input.requestId), submissionId: eventClientUuid(input.submissionId) }, active)); }); },
    download(entry: Pick<EventAudienceEntry, "submissionId" | "revision">, variant: "thumbnail" | "image", signal?: AbortSignal) { return run(signal, async active => {
      if (binaryBusy || nativeBusy) fail("busy"); if (destination === "wall" && variant !== "thumbnail") fail("access_denied"); binaryBusy = true; nativeBusy = true; let bitmap: { width: number; height: number; close(): void } | undefined;
      try {
        const b = eventClientObject(await request("media", { submissionId: eventClientUuid(entry.submissionId), variant }, active), ["submissionId", "revision", "bucket", "path", "variant", "bytes", "mime", "sha256", "width", "height", "expiresAt", "signedUrl", "retainedUntil"]);
        const { signedUrl, retainedUntil, expiresAt, ...fields } = b, descriptor = parseEventAudienceAccess({ ...fields, expiresAt: retainedUntil, maxAgeSeconds: 300 }, eventId, entry.submissionId, variant), until = Date.parse(eventClientInstant(expiresAt));
        if (descriptor.revision !== entry.revision || until <= Date.now() || until > Math.min(Date.parse(descriptor.expiresAt), Date.now() + 300000) || typeof signedUrl !== "string" || signedUrl.length > 20000) fail("access_denied");
        const url = new URL(signedUrl as string); if (url.origin !== storageOrigin || url.pathname !== `/storage/v1/object/sign/${descriptor.bucket}/${descriptor.path}` || url.username || url.password || url.hash || [...url.searchParams.keys()].join() !== "token" || !url.searchParams.get("token") || url.searchParams.get("token")!.length > 16384) fail();
        const response = await fetcher(url.href, { method: "GET", credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer", signal: active });
        if (active.aborted || response.status !== 200 || response.redirected || response.url && response.url !== url.href || response.headers.get("content-type")?.split(";")[0] !== "image/jpeg") { void response.body?.cancel(); assertActive(active); fail("source_unavailable"); }
        const data = await bytes(response, descriptor.bytes, active); let info: ReturnType<typeof inspectImageHeader>;
        try { info = inspectImageHeader(data); } catch { return fail("invalid_image"); } assertActive(active);
        if (data.length !== descriptor.bytes || info.mime !== "image/jpeg" || info.width > (variant === "thumbnail" ? 400 : 4096) || info.height > (variant === "thumbnail" ? 400 : 4096) || info.width * info.height > 12000000 || descriptor.width !== null && (info.width !== descriptor.width || info.height !== descriptor.height)) fail("invalid_image");
        if (descriptor.sha256) { const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))].map(x => x.toString(16).padStart(2, "0")).join(""); assertActive(active); if (digest !== descriptor.sha256) fail("invalid_image"); }
        const blob = new Blob([data], { type: "image/jpeg" }); bitmap = await (options.decode ? options.decode(blob) : createImageBitmap(blob, { imageOrientation: "from-image" })); assertActive(active);
        if (bitmap.width !== info.width || bitmap.height !== info.height) fail("invalid_image");
        const valid = await validation([entry.submissionId], active); if (!valid.entries.some(x => x.submissionId === entry.submissionId && x.revision === entry.revision)) fail("access_denied"); assertActive(active); return blob;
      } finally { bitmap?.close(); binaryBusy = false; nativeBusy = false; }
    }); },
  };
}
export type EventAudienceClient = ReturnType<typeof createEventAudienceClient>;
