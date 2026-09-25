import type { CloudIdentity } from "../projects/cloud-client";
import { parseMemoryBrowsePage, validateMemoryBrowse, type MemoryBrowse } from "./activity-browse";
import { cloudUuid } from "../projects/cloud-contract";
import { ACTIVITY_LIMITS, parseActivityPage, parseActivitySummary, parseMemoryActivity, parseMemoryChapter, parseMemoryChapters, validateActivityAnnotation, validateChapterInput, type ActivityAnnotation, type ChapterInput } from "./activity-contract";

export class ActivityClientError extends Error {
  constructor(readonly code: string, readonly status = 0, readonly retryAfterSeconds?: number) { super(code); this.name = "ActivityClientError"; }
}
export interface ActivityClientOptions {
  appOrigin: string; identity(): CloudIdentity | null; accessToken(): Promise<string | null>;
  fetch?: typeof fetch; timeoutMs?: number;
}
const invalid = (): never => { throw new ActivityClientError("invalid_response"); };
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).some(k => typeof k !== "string" || !("value" in Object.getOwnPropertyDescriptor(value, k)!))) return invalid();
  return value as Record<string, unknown>;
}
function flatActivity(value: unknown) {
  const v = object(value), source = v.source === null ? null : object(v.source), annotation = v.annotation === null ? null : object(v.annotation);
  if ((v.availability === "access_lost") !== (source === null) || (v.mine === true) !== (annotation !== null)) return invalid();
  return { id: v.id, mine: v.mine, occurredAt: v.occurredAt, provenance: v.provenance, availability: v.availability,
    ...(source ? { sourceKind: source.kind, sourceId: source.id, scopeKind: source.scopeKind, scopeId: source.scopeId } : {}),
    ...(annotation ? { revision: annotation.revision, chapterId: annotation.chapterId, occasion: annotation.occasion } : {}) };
}
function output<T>(parser: (value: unknown) => T, value: unknown): T { try { return parser(value); } catch { return invalid(); } }
function input<T>(parser: (value: unknown) => T, value: unknown): T { try { return parser(value); } catch { throw new ActivityClientError("invalid_request"); } }
export function parseActivityResponse(value: unknown) { return output(parseMemoryActivity, flatActivity(value)); }
export function parseActivityListResponse(value: unknown) {
  const v = object(value); if (!Array.isArray(v.items) || v.items.length > ACTIVITY_LIMITS.pageLimit) return invalid();
  return output(parseActivityPage, { items: v.items.map(flatActivity), nextCursor: v.nextCursor });
}
export function createActivityClient(options: ActivityClientOptions) {
  let origin: URL; try { origin = new URL(options.appOrigin); } catch { throw new ActivityClientError("invalid_configuration"); }
  if (origin.origin !== options.appOrigin || (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))) || (typeof location !== "undefined" && location.origin !== origin.origin)) throw new ActivityClientError("invalid_configuration");
  const initial = options.identity(); if (!initial) throw new ActivityClientError("account_changed");
  const ownerId = input(cloudUuid, initial.ownerId), epoch = initial.epoch, timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(epoch) || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) throw new ActivityClientError("invalid_configuration");
  const lifetime = new AbortController(), fetcher = options.fetch ?? fetch, endpoint = `${origin.origin}/api/memories`;
  function assertActive(signal?: AbortSignal) {
    const identity = options.identity();
    if (!identity || identity.ownerId !== ownerId || identity.epoch !== epoch) { lifetime.abort(); throw new ActivityClientError("account_changed"); }
    if (signal?.aborted || lifetime.signal.aborted) throw new ActivityClientError("cancelled");
  }
  async function request(operation: string, data: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    assertActive(signal); const body = JSON.stringify({ operation, ...data });
    if (new TextEncoder().encode(body).byteLength > 8192) throw new ActivityClientError("invalid_request");
    const deadline = new AbortController(), active = AbortSignal.any([lifetime.signal, deadline.signal, ...(signal ? [signal] : [])]), timer = setTimeout(() => deadline.abort(), timeoutMs);
    let abort: (() => void) | undefined;
    const interrupted = new Promise<never>((_, reject) => { abort = () => reject(new ActivityClientError(deadline.signal.aborted ? "timeout" : "cancelled")); active.addEventListener("abort", abort, { once: true }); });
    const work = async () => {
      const token = await options.accessToken(); assertActive(active);
      if (!token || token.length > 16384 || /[\s,]/.test(token)) throw new ActivityClientError("access_denied", 401);
      const response = await fetcher(endpoint, { method: "POST", credentials: "omit", redirect: "error", cache: "no-store", signal: active, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body });
      try { assertActive(active); } catch (error) { void response.body?.cancel().catch(() => undefined); throw error; }
      const length = response.headers.get("content-length");
      if (response.redirected || (response.url && response.url !== endpoint) || response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") { void response.body?.cancel().catch(() => undefined); return invalid(); }
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > ACTIVITY_LIMITS.responseBytes)) { void response.body?.cancel().catch(() => undefined); throw new ActivityClientError("response_too_large"); }
      if (!response.body) return invalid();
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
      const cancel = () => { void reader.cancel().catch(() => undefined); }; active.addEventListener("abort", cancel, { once: true });
      try {
        while (true) {
          assertActive(active); const next = await reader.read(); assertActive(active); if (next.done) break;
          size += next.value.byteLength; if (size > ACTIVITY_LIMITS.responseBytes || chunks.length >= 4096) throw new ActivityClientError("response_too_large"); chunks.push(next.value);
        }
      } finally { active.removeEventListener("abort", cancel); void reader.cancel().catch(() => undefined); reader.releaseLock(); }
      const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      let value: unknown; try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { return invalid(); }
      if (!response.ok) {
        const code = object(value).error, allowed = ["access_denied", "origin_denied", "invalid_request", "conflict", "capacity", "chapter_not_empty", "rate_limited", "unavailable"], retry = Number(response.headers.get("retry-after"));
        throw new ActivityClientError(typeof code === "string" && allowed.includes(code) ? code : "unavailable", response.status, response.status === 429 && Number.isInteger(retry) && retry >= 1 && retry <= 60 ? retry : undefined);
      }
      return value;
    };
    try { const value = await Promise.race([work(), interrupted]); assertActive(signal); return value; }
    catch (error) { assertActive(signal); if (error instanceof ActivityClientError) throw error; throw new ActivityClientError("network_error"); }
    finally { clearTimeout(timer); if (abort) active.removeEventListener("abort", abort); }
  }
  return {
    ownerId, assertActive, close() { lifetime.abort(); },
    async browse(value: MemoryBrowse, signal?: AbortSignal) {
      const query = input(validateMemoryBrowse, value);
      return output(value => parseMemoryBrowsePage(value, query, parseActivityResponse), await request("browse", { query }, signal));
    },
    async list(after?: string, limit = 20, signal?: AbortSignal) {
      if (after !== undefined) input(cloudUuid, after);
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new ActivityClientError("invalid_request");
      const result = parseActivityListResponse(await request("list", { ...(after === undefined ? {} : { after }), limit }, signal));
      if (result.items.length > limit || result.items.some(a => after !== undefined && a.id <= after)) return invalid(); return result;
    },
    async summary(year: number, signal?: AbortSignal) {
      if (!Number.isInteger(year) || year < 1970 || year > 2199) throw new ActivityClientError("invalid_request");
      const result = output(parseActivitySummary, await request("summary", { year }, signal)); if (result.year !== year) return invalid(); return result;
    },
    async chapters(signal?: AbortSignal) { return output(parseMemoryChapters, await request("chapters", {}, signal)); },
    async putChapter(value: ChapterInput, signal?: AbortSignal) {
      const chapter = input(validateChapterInput, value), result = output(parseMemoryChapter, await request("putChapter", { chapter }, signal));
      if (result.id !== chapter.id || result.title !== chapter.title || result.revision !== chapter.expectedRevision + 1) return invalid(); return result;
    },
    async annotate(value: ActivityAnnotation, signal?: AbortSignal) {
      const annotation = input(validateActivityAnnotation, value), result = parseActivityResponse(await request("annotate", { annotation }, signal));
      if (result.id !== annotation.id || !result.mine || result.annotation?.revision !== annotation.expectedRevision + 1 || result.annotation.chapterId !== annotation.chapterId || result.annotation.occasion !== annotation.occasion) return invalid(); return result;
    },
    async deleteChapter(id: string, expectedRevision: number, signal?: AbortSignal) {
      input(cloudUuid, id); if (!Number.isInteger(expectedRevision) || expectedRevision < 0 || expectedRevision > 2147483646) throw new ActivityClientError("invalid_request");
      const result = object(await request("deleteChapter", { id, expectedRevision }, signal)); if (result.deleted !== true) return invalid(); return { deleted: true as const };
    },
  };
}
export type ActivityClient = ReturnType<typeof createActivityClient>;
