import type { CloudIdentity } from "../projects/cloud-client";
import { cloudTimestamp, cloudUuid } from "../projects/cloud-contract";
import { RITUAL_LIMITS, parseRitualPage, parseRitualRow, ritualObject, ritualRevision, validateRitualChannels, validateRitualEdit, validateRitualInput, type RitualChannels, type RitualEdit, type RitualInput } from "./ritual-contract";

export class RitualClientError extends Error {
  constructor(readonly code: string, readonly status = 0, readonly retryAfterSeconds?: number) { super(code); this.name = "RitualClientError"; }
}
export interface RitualClientOptions {
  appOrigin: string; identity(): CloudIdentity | null; accessToken(): Promise<string | null>;
  fetch?: typeof fetch; timeoutMs?: number;
}
const invalid = (): never => { throw new RitualClientError("invalid_response"); };
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function output<T>(parser: (value: unknown) => T, value: unknown): T { try { return parser(value); } catch { return invalid(); } }
function input<T>(parser: (value: unknown) => T, value: unknown): T { try { return parser(value); } catch { throw new RitualClientError("invalid_request"); } }
export function createRitualClient(options: RitualClientOptions) {
  let origin: URL; try { origin = new URL(options.appOrigin); } catch { throw new RitualClientError("invalid_configuration"); }
  if (origin.origin !== options.appOrigin || (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))) || (typeof location !== "undefined" && location.origin !== origin.origin)) throw new RitualClientError("invalid_configuration");
  const initial = options.identity(); if (!initial) throw new RitualClientError("account_changed");
  const ownerId = input(cloudUuid, initial.ownerId), epoch = initial.epoch, timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(epoch) || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) throw new RitualClientError("invalid_configuration");
  const lifetime = new AbortController(), fetcher = options.fetch ?? fetch, endpoint = `${origin.origin}/api/memories`;
  function assertActive(signal?: AbortSignal) {
    const identity = options.identity();
    if (!identity || identity.ownerId !== ownerId || identity.epoch !== epoch) { lifetime.abort(); throw new RitualClientError("account_changed"); }
    if (signal?.aborted || lifetime.signal.aborted) throw new RitualClientError("cancelled");
  }
  async function request(operation: string, data: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    assertActive(signal); const body = JSON.stringify({ operation, ...data });
    if (new TextEncoder().encode(body).byteLength > 8192) throw new RitualClientError("invalid_request");
    const deadline = new AbortController(), active = AbortSignal.any([lifetime.signal, deadline.signal, ...(signal ? [signal] : [])]), timer = setTimeout(() => deadline.abort(), timeoutMs);
    let abort: (() => void) | undefined;
    const interrupted = new Promise<never>((_, reject) => { abort = () => reject(new RitualClientError(deadline.signal.aborted ? "timeout" : "cancelled")); active.addEventListener("abort", abort, { once: true }); });
    const work = async () => {
      const token = await options.accessToken(); assertActive(active);
      if (!token || token.length > 16384 || /[\s,]/.test(token)) throw new RitualClientError("access_denied", 401);
      const response = await fetcher(endpoint, { method: "POST", credentials: "omit", redirect: "error", cache: "no-store", signal: active, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body });
      try { assertActive(active); } catch (error) { void response.body?.cancel().catch(() => undefined); throw error; }
      const length = response.headers.get("content-length");
      if (response.redirected || (response.url && response.url !== endpoint) || response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") { void response.body?.cancel().catch(() => undefined); return invalid(); }
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > RITUAL_LIMITS.responseBytes)) { void response.body?.cancel().catch(() => undefined); throw new RitualClientError("response_too_large"); }
      if (!response.body) return invalid();
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
      const cancel = () => { void reader.cancel().catch(() => undefined); }; active.addEventListener("abort", cancel, { once: true });
      try {
        while (true) {
          assertActive(active); const next = await reader.read(); assertActive(active); if (next.done) break;
          size += next.value.byteLength; if (size > RITUAL_LIMITS.responseBytes || chunks.length >= 4096) throw new RitualClientError("response_too_large"); chunks.push(next.value);
        }
      } finally { active.removeEventListener("abort", cancel); void reader.cancel().catch(() => undefined); reader.releaseLock(); }
      const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      let value: unknown; try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { return invalid(); }
      if (!response.ok) {
        const code = object(value).error, allowed = ["access_denied", "origin_denied", "invalid_request", "conflict", "capacity", "schedule_changed", "no_future_occurrence", "rate_limited", "unavailable"], retry = Number(response.headers.get("retry-after"));
        throw new RitualClientError(typeof code === "string" && allowed.includes(code) ? code : "unavailable", response.status, response.status === 429 && Number.isInteger(retry) && retry >= 1 && retry <= 60 ? retry : undefined);
      }
      return value;
    };
    try { const value = await Promise.race([work(), interrupted]); assertActive(signal); return value; }
    catch (error) { assertActive(signal); if (error instanceof RitualClientError) throw error; throw new RitualClientError("network_error"); }
    finally { clearTimeout(timer); if (abort) active.removeEventListener("abort", abort); }
  }
  const rowResult = (value: unknown, coupleId: string, id: string, revision?: number) => {
    const row = output(parseRitualRow, value);
    if (row.coupleId !== coupleId || row.id !== id || row.legacy || revision !== undefined && row.revision !== revision + 1) return invalid();
    return row;
  };
  const context = (coupleId: string, id: string, revision: number) => ({ coupleId: input(cloudUuid, coupleId), id: input(cloudUuid, id), revision: input(ritualRevision, revision) });
  const action = async (operation: "ritualPause" | "ritualResume", coupleId: string, id: string, revision: number, signal?: AbortSignal) => {
    const row = rowResult(await request(operation, context(coupleId, id, revision), signal), coupleId, id, revision);
    if (row.paused !== (operation === "ritualPause")) return invalid(); return row;
  };
  return {
    ownerId, assertActive, close() { lifetime.abort(); },
    async list(coupleId: string, after?: string, limit = 20, signal?: AbortSignal) {
      input(cloudUuid, coupleId); if (after !== undefined) input(cloudUuid, after);
      if (!Number.isInteger(limit) || limit < 1 || limit > RITUAL_LIMITS.pageMaximum) throw new RitualClientError("invalid_request");
      return output(v => parseRitualPage(v, coupleId, after ?? null, limit), await request("ritualList", { coupleId, ...(after === undefined ? {} : { after }), limit }, signal));
    },
    async create(coupleId: string, value: RitualInput, signal?: AbortSignal) {
      input(cloudUuid, coupleId); const checked = input(validateRitualInput, value);
      const row = rowResult(await request("ritualCreate", { coupleId, input: checked }, signal), coupleId, checked.id);
      if (row.creatorId !== ownerId) return invalid(); return row;
    },
    async upgrade(coupleId: string, id: string, expectedScheduledAt: string, value: RitualEdit, signal?: AbortSignal) {
      const checked = input(validateRitualEdit, value), data = context(coupleId, id, 0);
      const row = rowResult(await request("ritualUpgrade", { coupleId: data.coupleId, id: data.id, expectedScheduledAt: input(cloudTimestamp, expectedScheduledAt), input: checked }, signal), coupleId, id, 0);
      if (row.creatorId !== ownerId || row.title !== checked.title || JSON.stringify(row.schedule) !== JSON.stringify(checked.schedule)) return invalid(); return row;
    },
    async edit(coupleId: string, id: string, revision: number, value: RitualEdit, signal?: AbortSignal) {
      const checked = input(validateRitualEdit, value), row = rowResult(await request("ritualEdit", { ...context(coupleId, id, revision), input: checked }, signal), coupleId, id, revision);
      if (row.creatorId !== ownerId || row.title !== checked.title || JSON.stringify(row.schedule) !== JSON.stringify(checked.schedule)) return invalid(); return row;
    },
    pause: (coupleId: string, id: string, revision: number, signal?: AbortSignal) => action("ritualPause", coupleId, id, revision, signal),
    resume: (coupleId: string, id: string, revision: number, signal?: AbortSignal) => action("ritualResume", coupleId, id, revision, signal),
    async setChannels(coupleId: string, id: string, revision: number, value: RitualChannels, signal?: AbortSignal) {
      const channels = input(validateRitualChannels, value), row = rowResult(await request("ritualSetChannels", { ...context(coupleId, id, revision), channels }, signal), coupleId, id, revision);
      if (row.channels.email !== channels.email || row.channels.push !== channels.push) return invalid(); return row;
    },
    async delete(coupleId: string, id: string, revision: number, signal?: AbortSignal) {
      const row = output(v => ritualObject(v, ["id", "deleted", "revision"]), await request("ritualDelete", context(coupleId, id, revision), signal));
      if (row.id !== id || row.deleted !== true || row.revision !== revision + 1) return invalid();
      return { id, deleted: true as const, revision: revision + 1 };
    },
  };
}
export type RitualClient = ReturnType<typeof createRitualClient>;
