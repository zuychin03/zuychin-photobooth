import { EventClientError, eventClientObject, type EventBrowserOptions } from "./client";

export interface PostcardTransportOptions extends EventBrowserOptions {
  assertAuthority(signal?: AbortSignal): void;
  accessToken?(): Promise<string | null>;
}
export function postcardOrigin(value: string): string {
  const url = new URL(value);
  if (url.origin !== value || url.username || url.password || url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new EventClientError("invalid_configuration");
  return url.origin;
}
export function createPostcardTransport(options: PostcardTransportOptions) {
  const origin = postcardOrigin(options.appOrigin), lifetime = new AbortController(), timeout = options.timeoutMs ?? 10000;
  if (typeof location !== "undefined" && location.origin !== origin || !Number.isInteger(timeout) || timeout < 1 || timeout > 30000) throw new EventClientError("invalid_configuration");
  let operations = 0;
  const assertActive = (signal?: AbortSignal) => { options.assertAuthority(signal); if (lifetime.signal.aborted || signal?.aborted) throw new EventClientError("cancelled"); };
  async function run<T>(signal: AbortSignal | undefined, task: (active: AbortSignal) => Promise<T>): Promise<T> {
    assertActive(signal); if (operations >= 2) throw new EventClientError("busy"); operations++;
    const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(), timeout), active = AbortSignal.any([lifetime.signal, deadline.signal, ...(signal ? [signal] : [])]); let abort = () => {};
    const interrupted = new Promise<never>((_, reject) => { abort = () => reject(new EventClientError(deadline.signal.aborted ? "timeout" : "cancelled")); active.addEventListener("abort", abort, { once: true }); });
    const work = (async () => { try { return await task(active); } finally { operations--; } })();
    try { const result = await Promise.race([work, interrupted]); assertActive(signal); return result; }
    catch (error) { assertActive(signal); if (error instanceof EventClientError) throw error; throw new EventClientError("invalid_response"); }
    finally { clearTimeout(timer); active.removeEventListener("abort", abort); deadline.abort(); }
  }
  async function bytes(response: Response, maximum: number, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum)) { void response.body?.cancel(); throw new EventClientError("response_too_large"); }
    const reader = response.body?.getReader(), chunks: Uint8Array[] = []; let size = 0;
    const abort = () => { void reader?.cancel().catch(() => {}); }; signal.addEventListener("abort", abort, { once: true });
    try { if (reader) while (true) { assertActive(signal); const part = await reader.read(); assertActive(signal); if (part.done) break; size += part.value.length; if (size > maximum || chunks.length >= 4096) throw new EventClientError("response_too_large"); chunks.push(part.value); } }
    finally { signal.removeEventListener("abort", abort); if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); } }
    const result = new Uint8Array(size); let offset = 0; for (const part of chunks) { result.set(part, offset); offset += part.length; } return result;
  }
  async function request(path: string, operation: string, input: object, signal: AbortSignal, authenticated = false): Promise<unknown> {
    assertActive(signal);
    if (!/^\/api\/(events|rooms|challenges)\/[a-f0-9-]{36}\/postcards$/.test(path)) throw new EventClientError("invalid_request");
    const body = JSON.stringify({ operation, ...input }); if (new TextEncoder().encode(body).length > (path.startsWith("/api/events/") ? 8192 : 80000)) throw new EventClientError("invalid_request");
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (authenticated) { const token = await options.accessToken?.(); assertActive(signal); if (!token || token.length > 16384 || /[\s,]/.test(token)) throw new EventClientError("access_denied"); headers.Authorization = `Bearer ${token}`; }
    const endpoint = `${origin}${path}`, response = await (options.fetch ?? fetch)(endpoint, { method: "POST", credentials: authenticated ? "omit" : "same-origin", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer", headers, signal, body });
    if (signal.aborted || response.redirected || response.url && response.url !== endpoint || !/^application\/json(?:;|$)/i.test(response.headers.get("content-type") ?? "")) { void response.body?.cancel(); assertActive(signal); throw new EventClientError("invalid_response"); }
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await bytes(response, 98304, signal))); assertActive(signal);
    if (!response.ok) { const b = eventClientObject(value, ["error"]), code = String(b.error); throw new EventClientError(["access_denied", "identity_changed", "expired", "conflict", "capacity", "not_ready", "invalid_request", "rate_limited", "origin_denied", "unavailable", "update_required"].includes(code) ? code : "unavailable", response.status); }
    return value;
  }
  return { run, request, bytes, assertActive, fetch: options.fetch ?? fetch, close() { lifetime.abort(); } };
}
