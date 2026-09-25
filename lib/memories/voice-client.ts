import type { CloudIdentity } from "../projects/cloud-client";
import { cloudSha256 } from "../projects/cloud-client";
import { cloudUuid } from "../projects/cloud-contract";
import { readRetainedBody } from "./retained-strip-contract";
import { PCM_VOICE, inspectVoiceWav } from "./voice-wav";
import { VoiceError, parseVoiceSave, parseVoiceSnapshot, voiceRevision, type VoiceSave, type VoiceCaptionSnapshot } from "./voice-contract";

export interface VoiceClientOptions { appOrigin: string; identity(): CloudIdentity | null; accessToken(): Promise<string | null>; fetch?: typeof fetch }
export function createVoiceClient(options: VoiceClientOptions) {
  const origin = new URL(options.appOrigin), initial = options.identity();
  if (origin.origin !== options.appOrigin || origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)) || !initial || !Number.isSafeInteger(initial.epoch) || typeof location !== "undefined" && location.origin !== origin.origin) throw new VoiceError("invalid_configuration");
  const ownerId = cloudUuid(initial.ownerId), epoch = initial.epoch, lifetime = new AbortController(), transport = options.fetch ?? fetch;
  function assertActive(signal?: AbortSignal) {
    const current = options.identity();
    if (!current || current.ownerId !== ownerId || current.epoch !== epoch) { lifetime.abort(); throw new VoiceError("account_changed", 401); }
    if (lifetime.signal.aborted || signal?.aborted) throw new VoiceError("cancelled", 408);
  }
  async function request(id: string, body: Record<string, unknown>, external?: AbortSignal): Promise<VoiceCaptionSnapshot | Blob> {
    cloudUuid(id); assertActive(external);
    const deadline = new AbortController(), signal = AbortSignal.any([lifetime.signal, deadline.signal, ...(external ? [external] : [])]);
    const timer = setTimeout(() => deadline.abort(), 20_000), endpoint = `${origin.origin}/api/memories/${id}/voice`;
    let rejectAbort!: () => void;
    const interrupted = new Promise<never>((_, reject) => { rejectAbort = () => reject(new VoiceError(deadline.signal.aborted ? "timeout" : "cancelled", 408)); signal.addEventListener("abort", rejectAbort, { once: true }); });
    const work = async () => {
      const token = await options.accessToken(); assertActive(signal);
      if (!token || token.length > 16384 || /[\s,]/.test(token)) throw new VoiceError("access_denied", 401);
      const response = await transport(endpoint, { method: "POST", credentials: "omit", cache: "no-store", redirect: "error", signal, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      try {
        assertActive(signal);
        if (response.redirected || response.url && response.url !== endpoint) throw new VoiceError("invalid_response");
        const download = body.operation === "download" && response.ok;
        if (response.headers.get("content-type")?.split(";")[0].trim() !== (download ? "audio/wav" : "application/json")) throw new VoiceError("invalid_response");
        const bytes = await readRetainedBody(response, download ? PCM_VOICE.bytes : 16384, signal); assertActive(signal);
        if (!response.ok) {
          const error = JSON.parse(new TextDecoder().decode(bytes));
          throw new VoiceError(typeof error?.error === "string" && ["access_denied", "source_unavailable", "conflict", "capacity", "quota_exceeded", "invalid_audio", "rate_limited", "unavailable", "invalid_request", "access_changed", "timeout"].includes(error.error) ? error.error : "unavailable", response.status);
        }
        if (download) {
          inspectVoiceWav(bytes); cloudUuid(response.headers.get("x-voice-generation"));
          const hash = await cloudSha256(bytes.buffer); assertActive(signal);
          if (hash !== response.headers.get("x-voice-sha256")) throw new VoiceError("integrity_failed");
          return new Blob([bytes], { type: "audio/wav" });
        }
        return parseVoiceSnapshot(JSON.parse(new TextDecoder().decode(bytes)), id);
      } finally { void response.body?.cancel().catch(() => {}); }
    };
    try { const result = await Promise.race([work(), interrupted]); assertActive(external); return result; }
    finally { clearTimeout(timer); signal.removeEventListener("abort", rejectAbort); deadline.abort(); }
  }
  return {
    ownerId, assertActive, signal: lifetime.signal, close: () => lifetime.abort(),
    read: (id: string, signal?: AbortSignal) => request(id, { operation: "read" }, signal) as Promise<VoiceCaptionSnapshot>,
    save: (id: string, input: VoiceSave, signal?: AbortSignal) => request(id, { operation: "save", ...parseVoiceSave(input) }, signal) as Promise<VoiceCaptionSnapshot>,
    delete: (id: string, input: { requestId: string; revision: number }, signal?: AbortSignal) => request(id, { operation: "delete", requestId: cloudUuid(input.requestId), revision: voiceRevision(input.revision) }, signal) as Promise<VoiceCaptionSnapshot>,
    download: (id: string, signal?: AbortSignal) => request(id, { operation: "download" }, signal) as Promise<Blob>,
  };
}
export type VoiceClient = ReturnType<typeof createVoiceClient>;
