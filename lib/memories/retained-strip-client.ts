import type { CloudIdentity } from "../projects/cloud-client";
import { cloudUuid } from "../projects/cloud-contract";
import { inspectRetainedPngHeader } from "../projects/images";
import { RETAINED_STRIP_LIMITS, RetainedStripError, parseRetainedResolution, readRetainedBody, type RetainedStripDownload, type RetainedStripResolution } from "./retained-strip-contract";

export interface RetainedStripClientOptions { appOrigin: string; identity(): CloudIdentity | null; accessToken(): Promise<string | null>; fetch?: typeof fetch; timeoutMs?: number }
export function createRetainedStripClient(options: RetainedStripClientOptions) {
  const origin = new URL(options.appOrigin), initial = options.identity(), timeoutMs = options.timeoutMs ?? RETAINED_STRIP_LIMITS.timeoutMs;
  if (origin.origin !== options.appOrigin || origin.username || origin.password || origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)) || typeof location !== "undefined" && location.origin !== origin.origin || !initial || !Number.isSafeInteger(initial.epoch) || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > RETAINED_STRIP_LIMITS.timeoutMs) throw new RetainedStripError("invalid_configuration");
  const ownerId = cloudUuid(initial.ownerId), epoch = initial.epoch, lifetime = new AbortController(), transport = options.fetch ?? fetch;
  function assertActive(signal?: AbortSignal) {
    const identity = options.identity();
    if (!identity || identity.ownerId !== ownerId || identity.epoch !== epoch) { lifetime.abort(); throw new RetainedStripError("account_changed", 401); }
    if (lifetime.signal.aborted || signal?.aborted) throw new RetainedStripError("cancelled", 408);
  }
  async function request(id: string, operation: "resolve" | "download", external?: AbortSignal): Promise<RetainedStripResolution | RetainedStripDownload> {
    cloudUuid(id); assertActive(external);
    const endpoint = `${origin.origin}/api/media/strips/${id}/read`, deadline = new AbortController(), signal = AbortSignal.any([lifetime.signal, deadline.signal, ...(external ? [external] : [])]);
    let stop!: () => void;
    const interrupted = new Promise<never>((_, reject) => { stop = () => reject(new RetainedStripError(deadline.signal.aborted ? "timeout" : "cancelled", 408)); signal.addEventListener("abort", stop, { once: true }); });
    const timer = setTimeout(() => deadline.abort(), timeoutMs);
    const work = async () => {
      const token = await options.accessToken(); assertActive(signal);
      if (!token || token.length > 16384 || /[\s,]/.test(token)) throw new RetainedStripError("access_denied", 401);
      const response = await transport(endpoint, { method: "POST", credentials: "omit", redirect: "error", cache: "no-store", signal, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ operation }) });
      try { assertActive(signal); } catch (error) { void response.body?.cancel().catch(() => {}); throw error; }
      if (response.redirected || response.url && response.url !== endpoint) { void response.body?.cancel().catch(() => {}); throw new RetainedStripError("invalid_response"); }
      const mime = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
      if (mime !== (operation === "download" && response.ok ? "image/png" : "application/json")) { void response.body?.cancel().catch(() => {}); throw new RetainedStripError("invalid_response"); }
      const bytes = await readRetainedBody(response, operation === "download" && response.ok ? RETAINED_STRIP_LIMITS.bytes : 8192, signal); assertActive(signal);
      if (!response.ok) {
        let error: unknown; try { error = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new RetainedStripError("invalid_response"); }
        const code = error && typeof error === "object" && "error" in error ? error.error : null, retry = Number(response.headers.get("retry-after"));
        throw new RetainedStripError(typeof code === "string" && ["invalid_request", "access_denied", "origin_denied", "unavailable", "source_unavailable", "access_changed", "rate_limited", "timeout", "cancelled"].includes(code) ? code : "unavailable", response.status, response.status === 429 && Number.isInteger(retry) && retry >= 1 && retry <= 60 ? retry : undefined);
      }
      if (operation === "resolve") return parseRetainedResolution(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), id);
      const resolution = parseRetainedResolution({ version: Number(response.headers.get("x-strip-version")), id: response.headers.get("x-strip-id"), availability: response.headers.get("x-strip-availability"), bytesLimit: RETAINED_STRIP_LIMITS.bytes }, id);
      const width = Number(response.headers.get("x-strip-width")), height = Number(response.headers.get("x-strip-height")), sha256 = response.headers.get("x-strip-sha256"), info = inspectRetainedPngHeader(bytes);
      if (info.mime !== "image/png" || width !== info.width || height !== info.height || !sha256 || !/^[a-f0-9]{64}$/.test(sha256)) throw new RetainedStripError("invalid_response");
      const actual = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.buffer))].map(v => v.toString(16).padStart(2, "0")).join(""); assertActive(signal);
      if (actual !== sha256) throw new RetainedStripError("integrity_failed");
      return { ...resolution, blob: new Blob([bytes], { type: "image/png" }), width, height, sha256 };
    };
    try { const result = await Promise.race([work(), interrupted]); assertActive(external); return result; }
    catch (error) { assertActive(external); if (error instanceof RetainedStripError) throw error; throw new RetainedStripError("unavailable"); }
    finally { clearTimeout(timer); signal.removeEventListener("abort", stop); deadline.abort(); }
  }
  return { ownerId, assertActive, close() { lifetime.abort(); }, resolve: (id: string, signal?: AbortSignal) => request(id, "resolve", signal) as Promise<RetainedStripResolution>, download: (id: string, signal?: AbortSignal) => request(id, "download", signal) as Promise<RetainedStripDownload> };
}
export type RetainedStripClient = ReturnType<typeof createRetainedStripClient>;
