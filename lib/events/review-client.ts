import { EventClientError, eventClientInstant, eventClientObject, eventClientUuid, type EventHostClientOptions } from "./client";
import { EVENT_REVIEW_LIMITS, parseEventReviewAccess, parseEventReviewPage, type EventReviewAccess } from "./review-contract";
import { inspectImageHeader } from "../projects/images";

export interface EventReviewClientOptions extends EventHostClientOptions { storageOrigin: string; decode?(blob: Blob): Promise<{ width: number; height: number; close(): void }> }
const fail = (code = "invalid_response"): never => { throw new EventClientError(code); };
let decoding = false;
export function createEventReviewClient(options: EventReviewClientOptions) {
  const origin = (value: string) => { const u = new URL(value); if (u.origin !== value || u.username || u.password || u.protocol !== "https:" && !(u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname))) return fail("invalid_configuration"); return u.origin; };
  const appOrigin = origin(options.appOrigin), storageOrigin = origin(options.storageOrigin), initial = options.identity(), lifetime = new AbortController(), fetcher = options.fetch ?? fetch, timeoutMs = options.timeoutMs ?? 10000;
  if (!initial || !Number.isSafeInteger(initial.epoch) || initial.epoch < 0 || typeof location !== "undefined" && location.origin !== appOrigin || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) return fail("invalid_configuration");
  const ownerId = eventClientUuid(initial.ownerId), initialKey = JSON.stringify(initial); let busy = false;
  const assertActive = (signal?: AbortSignal) => { if (JSON.stringify(options.identity()) !== initialKey) { lifetime.abort(); fail("identity_changed"); } if (lifetime.signal.aborted || signal?.aborted) fail("cancelled"); };
  async function run<T>(signal: AbortSignal | undefined, task: (active: AbortSignal) => Promise<T>): Promise<T> {
    assertActive(signal); if (busy) return fail("busy"); busy = true; const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(), timeoutMs), active = AbortSignal.any([lifetime.signal, deadline.signal, ...(signal ? [signal] : [])]); let listener = () => {};
    const interrupted = new Promise<never>((_, reject) => { listener = () => reject(new EventClientError(deadline.signal.aborted ? "timeout" : "cancelled")); active.addEventListener("abort", listener, { once: true }); });
    const work = (async () => { try { return await task(active); } finally { busy = false; } })();
    try { const value = await Promise.race([work, interrupted]); assertActive(signal); return value; }
    catch (e) { assertActive(signal); if (e instanceof EventClientError) throw e; throw new EventClientError("invalid_response"); }
    finally { clearTimeout(timer); active.removeEventListener("abort", listener); deadline.abort(); }
  }
  async function read(response: Response, maximum: number, active: AbortSignal) {
    const length = response.headers.get("content-length"); if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum)) { void response.body?.cancel(); return fail("response_too_large"); }
    const reader = response.body?.getReader(), chunks: Uint8Array[] = []; let size = 0; const cancel = () => { void reader?.cancel().catch(() => undefined); }; active.addEventListener("abort", cancel, { once: true });
    try { if (reader) while (true) { assertActive(active); const part = await reader.read(); assertActive(active); if (part.done) break; size += part.value.length; if (size > maximum || chunks.length >= 4096) return fail("response_too_large"); chunks.push(part.value); } }
    finally { active.removeEventListener("abort", cancel); if (reader) { void reader.cancel().catch(() => undefined); reader.releaseLock(); } }
    const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; } return bytes;
  }
  async function request(eventId: string, operation: string, args: object, active: AbortSignal) {
    eventClientUuid(eventId); assertActive(active); const token = await options.accessToken(); assertActive(active); if (!token || token.length > 16384 || /[\s,]/.test(token)) return fail("access_denied");
    const endpoint = `${appOrigin}/api/events/${eventId}/review`, response = await fetcher(endpoint, { method: "POST", credentials: "omit", cache: "no-store", redirect: "error", signal: active, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ operation, ...args }) });
    if (active.aborted || response.redirected || response.url && response.url !== endpoint) { void response.body?.cancel(); assertActive(active); return fail(); }
    if (!/^application\/json(?:;|$)/i.test(response.headers.get("content-type") ?? "")) { void response.body?.cancel(); return fail(); }
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await read(response, 16384, active))); assertActive(active);
    if (!response.ok) { const b = eventClientObject(value, ["error"]), codes = ["access_denied", "expired", "invalid_request", "unavailable", "not_ready", "rate_limited", "origin_denied"]; throw new EventClientError(codes.includes(String(b.error)) ? String(b.error) : "unavailable", response.status); } return value;
  }
  const access = async (eventId: string, submissionId: string, active: AbortSignal) => parseEventReviewAccess(await request(eventId, "access", { submissionId: eventClientUuid(submissionId) }, active), eventId, submissionId);
  const same = (a: EventReviewAccess, b: EventReviewAccess) => a.submissionId === b.submissionId && a.path === b.path && a.bytes === b.bytes && a.sha256 === b.sha256 && a.expiresAt === b.expiresAt;
  return { ownerId, assertActive, close() { lifetime.abort(); },
    capabilities(eventId: string, signal?: AbortSignal) { return run(signal, async active => { const b = eventClientObject(await request(eventId, "capabilities", {}, active), Object.keys(EVENT_REVIEW_LIMITS)); if (Object.entries(EVENT_REVIEW_LIMITS).some(([key, value]) => b[key] !== value)) return fail("unavailable"); return EVENT_REVIEW_LIMITS; }); },
    list(eventId: string, after?: string, limit = 12, signal?: AbortSignal) { return run(signal, async active => { if (!Number.isInteger(limit) || limit < 1 || limit > 12) return fail("invalid_request"); return parseEventReviewPage(await request(eventId, "list", { ...(after === undefined ? {} : { after: eventClientUuid(after) }), limit }, active), eventId, after, limit); }); },
    access(eventId: string, submissionId: string, signal?: AbortSignal) { return run(signal, active => access(eventId, submissionId, active)); },
    download(eventId: string, submissionId: string, signal?: AbortSignal) { return run(signal, async active => {
      if (decoding) return fail("busy"); decoding = true; let bitmap: { width: number; height: number; close(): void } | undefined;
      try {
        const b = eventClientObject(await request(eventId, "media", { submissionId: eventClientUuid(submissionId) }, active), ["submissionId", "bucket", "path", "bytes", "mime", "sha256", "expiresAt", "retainedUntil", "signedUrl"]), { signedUrl, retainedUntil, expiresAt, ...fields } = b;
        const descriptor = parseEventReviewAccess({ ...fields, expiresAt: retainedUntil, maxAgeSeconds: 300 }, eventId, submissionId), until = Date.parse(eventClientInstant(expiresAt));
        if (until <= Date.now() || until > Math.min(Date.parse(descriptor.expiresAt), Date.now() + 300000) || typeof signedUrl !== "string" || signedUrl.length > 20000) return fail();
        const url = new URL(signedUrl); if (url.origin !== storageOrigin || url.pathname !== `/storage/v1/object/sign/${descriptor.bucket}/${descriptor.path}` || url.username || url.password || url.hash || [...url.searchParams.keys()].join() !== "token" || !url.searchParams.get("token") || url.searchParams.get("token")!.length > 16384) return fail();
        const response = await fetcher(url.href, { method: "GET", credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer", signal: active });
        if (active.aborted || response.status !== 200 || response.redirected || response.url && response.url !== url.href || response.headers.get("content-type")?.split(";")[0] !== "image/jpeg") { void response.body?.cancel(); assertActive(active); return fail("source_unavailable"); }
        const bytes = await read(response, descriptor.bytes, active); let info: ReturnType<typeof inspectImageHeader>;
        try { info = inspectImageHeader(bytes); } catch { return fail("invalid_image"); } assertActive(active);
        if (bytes.length !== descriptor.bytes || info.mime !== "image/jpeg" || info.width > 400 || info.height > 400) return fail("invalid_image");
        if (descriptor.sha256) { const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(v => v.toString(16).padStart(2, "0")).join(""); assertActive(active); if (hash !== descriptor.sha256) return fail("invalid_image"); }
        const blob = new Blob([bytes], { type: "image/jpeg" }); bitmap = await (options.decode ? options.decode(blob) : createImageBitmap(blob, { imageOrientation: "from-image" })); assertActive(active);
        if (bitmap.width !== info.width || bitmap.height !== info.height) return fail("invalid_image");
        if (!same(descriptor, await access(eventId, submissionId, active))) return fail("access_denied"); assertActive(active); return blob;
      } finally { bitmap?.close(); decoding = false; }
    }); },
  };
}
export type EventReviewClient = ReturnType<typeof createEventReviewClient>;
