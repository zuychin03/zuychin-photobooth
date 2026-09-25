import { createHash } from "node:crypto";
import { cloudUuid } from "../projects/cloud-contract";
import { VoiceError, VOICE_BODY_LIMIT, parseVoiceSave, voiceObject, voiceRevision } from "../memories/voice-contract";
import { inspectVoiceWav } from "../memories/voice-wav";
import { privateJson } from "./cron-auth";
import { RequestValidationError, requireSameOrigin } from "./request-security";
import { createVoiceStore, type VoiceStore, type VoiceObject } from "./voice-store";
import { createVoiceObjects, type VoiceObjects } from "./voice-objects";

export interface VoiceRequestPorts { store(token: string, env: Record<string, string | undefined>, signal: AbortSignal): Promise<VoiceStore>; objects(env: Record<string, string | undefined>): VoiceObjects }
const production: VoiceRequestPorts = { store: createVoiceStore, objects: createVoiceObjects };
let occupied = 0;
async function body(request: Request, signal: AbortSignal): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new VoiceError("invalid_request", 400);
  const length = request.headers.get("content-length"); if (length !== null && (!/^\d+$/.test(length) || Number(length) > VOICE_BODY_LIMIT)) throw new VoiceError("invalid_request", 413);
  if (!request.body) throw new VoiceError("invalid_request", 400);
  const reader = request.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); }; signal.addEventListener("abort", cancel, { once: true });
  try { while (true) { const next = await reader.read(); signal.throwIfAborted(); if (next.done) break; size += next.value.length; if (size > VOICE_BODY_LIMIT || chunks.length >= 4096) throw new VoiceError("invalid_request", 413); chunks.push(next.value); } }
  finally { signal.removeEventListener("abort", cancel); void reader.cancel().catch(() => {}); reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return voiceObject(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), ["operation", "requestId", "revision", "text", "audio"]); } catch { throw new VoiceError("invalid_request", 400); }
}
function verify(bytes: Uint8Array) { try { return { ...inspectVoiceWav(bytes), sha256: createHash("sha256").update(bytes).digest("hex") }; } catch { throw new VoiceError("invalid_audio", 400); } }
export function createVoiceHandler(ports: VoiceRequestPorts = production, getEnv: () => Record<string, string | undefined> = () => process.env) {
  return async (request: Request, activityId: string): Promise<Response> => {
    const env = getEnv(), deadline = new AbortController(), signal = AbortSignal.any([request.signal, deadline.signal]);
    let stop!: () => void;
    const interrupted = new Promise<never>((_, reject) => { stop = () => reject(new VoiceError("timeout", 408)); signal.addEventListener("abort", stop, { once: true }); });
    const timer = setTimeout(() => deadline.abort(), 45_000);
    const work = async () => {
      if (env.PB_MEMORIES_ENABLED !== "true" || env.PB_VOICE_CAPTIONS_ENABLED !== "true") throw new VoiceError("unavailable");
      if (request.method !== "POST") throw new VoiceError("method_not_allowed", 405);
      const url = new URL(request.url), local = env.NODE_ENV === "development" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      if (url.protocol !== "https:" && !local) throw new VoiceError("unavailable");
      if (url.search) throw new VoiceError("invalid_request", 400); requireSameOrigin(request, env);
      try { cloudUuid(activityId); } catch { throw new VoiceError("invalid_request", 400); }
      const token = /^Bearer ([^\s,]+)$/i.exec(request.headers.get("authorization") ?? "")?.[1]; if (!token || token.length > 16384) throw new VoiceError("access_denied", 401);
      if (occupied >= 2) throw new VoiceError("unavailable"); occupied++;
      let wav: Uint8Array | undefined, downloaded: Uint8Array | undefined;
      try {
        signal.throwIfAborted(); const input = await body(request, signal), operation = input.operation;
        if (!["read", "save", "delete", "download"].includes(operation as string)) throw new VoiceError("invalid_request", 400);
        const { operation: ignored, ...payload } = input; void ignored;
        let save: ReturnType<typeof parseVoiceSave> | null = null;
        try {
          if (operation === "save") save = parseVoiceSave(payload);
          else if (operation === "delete") { voiceObject(payload, ["requestId", "revision"]); cloudUuid(payload.requestId); voiceRevision(payload.revision); }
          else if (Object.keys(payload).length) throw new Error();
        } catch { throw new VoiceError("invalid_request", 400); }
        const store = await ports.store(token, env, signal); await store.rate(operation === "save" || operation === "delete" ? "write" : "read"); signal.throwIfAborted();
        if (operation === "read") return privateJson(await store.read(activityId));
        if (operation === "delete") { const result = await store.save(activityId, { requestId: payload.requestId as string, revision: payload.revision as number, text: "", operation: "delete", audio: null }); if (result.status !== "complete") throw new VoiceError("unavailable"); return privateJson(result.snapshot); }
        if (operation === "save" && save) {
          let audio: { bytes: number; samples: number; sha256: string } | null = null;
          if (save.audio.operation === "replace") { wav = Buffer.from(save.audio.wav, "base64"); if (Buffer.from(wav).toString("base64") !== save.audio.wav) throw new VoiceError("invalid_audio", 400); const checked = verify(wav); audio = { bytes: checked.bytes, samples: checked.samples, sha256: checked.sha256 }; }
          const result = await store.save(activityId, { requestId: save.requestId, revision: save.revision, text: save.text, operation: save.audio.operation, audio });
          if (result.status === "complete") return privateJson(result.snapshot);
          if (!wav || !audio) throw new VoiceError("unavailable"); signal.throwIfAborted();
          const objects = ports.objects(env); await objects.upload(result.stage, wav, signal); downloaded = await objects.read(result.stage, signal);
          const checked = verify(downloaded); if (checked.sha256 !== audio.sha256 || checked.bytes !== audio.bytes || checked.samples !== audio.samples) throw new VoiceError("integrity_failed", 409);
          signal.throwIfAborted(); return privateJson(await store.finish(activityId, save.requestId, checked.sha256));
        }
        const before = await store.read(activityId); if (!before.audio) throw new VoiceError("not_found", 404);
        const audio = before.audio, object: VoiceObject = { ...audio, actor: store.actor, activityId, path: `${store.actor}/${activityId}/${audio.generation}.wav` };
        downloaded = await ports.objects(env).read(object, signal); const checked = verify(downloaded);
        if (checked.sha256 !== audio.sha256 || checked.bytes !== audio.bytes || checked.samples !== audio.samples) throw new VoiceError("integrity_failed", 409);
        const after = await store.read(activityId); signal.throwIfAborted(); if (JSON.stringify(before) !== JSON.stringify(after)) throw new VoiceError("conflict", 409);
        const headers = new Headers(privateJson({}).headers); headers.set("Content-Type", "audio/wav"); headers.set("Content-Length", String(downloaded.length)); headers.set("Content-Disposition", `attachment; filename="voice-${activityId}.wav"`); headers.set("X-Voice-Sha256", audio.sha256); headers.set("X-Voice-Generation", audio.generation);
        return new Response(new Uint8Array(downloaded), { headers });
      } finally { wav?.fill(0); downloaded?.fill(0); occupied--; }
    };
    try { return await Promise.race([work(), interrupted]); }
    catch (error) { if (error instanceof RequestValidationError) return privateJson({ error: error.status === 403 ? "origin_denied" : "invalid_request" }, error.status); const failure = error instanceof VoiceError ? error : new VoiceError(signal.aborted ? "timeout" : "unavailable", signal.aborted ? 408 : 503); const response = privateJson({ error: failure.code }, failure.status); if (failure.status === 429) response.headers.set("Retry-After", "60"); return response; }
    finally { clearTimeout(timer); signal.removeEventListener("abort", stop); deadline.abort(); }
  };
}
