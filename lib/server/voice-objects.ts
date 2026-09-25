import { VoiceError } from "../memories/voice-contract";
import { supabaseServiceOrigin } from "./cron-auth";
import { VOICE_BUCKET, voiceDescriptor, type VoiceObject, type VoiceStage } from "./voice-store";
import { isStorageObjectAbsent } from "./storage-absence";

let occupied = 0;
export function createVoiceObjects(env: Record<string, string | undefined>, transport: typeof fetch = fetch) {
  const origin = supabaseServiceOrigin(env.NEXT_PUBLIC_SUPABASE_URL), key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!origin || !key?.trim() || key.length > 16384 || /[\r\n]/.test(key)) throw new VoiceError("unavailable");
  async function request(method: string, path: string, maximum: number, signal?: AbortSignal, body?: BodyInit, headers?: Record<string, string>, presenceOnly = false) {
    if (occupied >= 2) throw new VoiceError("unavailable");
    signal?.throwIfAborted(); occupied++;
    const abort = new AbortController(), active = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal, url = `${origin}/storage/v1${path}`;
    let stop!: () => void;
    const interrupted = new Promise<never>((_, reject) => { stop = () => reject(new VoiceError("timeout", 408)); active.addEventListener("abort", stop, { once: true }); });
    const timer = setTimeout(() => abort.abort(), 10_000);
    const work = (async () => {
      let response: Response | null = null;
      try {
        response = await transport(url, { method, headers: { Authorization: `Bearer ${key}`, apikey: key!, ...headers }, body, signal: active, redirect: "error", cache: "no-store", credentials: "omit" });
        active.throwIfAborted();
        if (response.redirected || response.url !== url || response.status >= 300 && response.status < 400) throw new VoiceError("unavailable");
        if (method === "GET" && path.startsWith("/object/authenticated/") && await isStorageObjectAbsent(response, active)) { active.throwIfAborted(); return { status: 404, data: new Uint8Array() }; }
        if (method === "GET" && response.status === 400) return { status: 400, data: new Uint8Array() };
        if (presenceOnly) return { status: response.status, data: new Uint8Array() };
        const length = response.headers.get("content-length");
        if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum)) throw new VoiceError("unavailable");
        if (!response.body) return { status: response.status, data: new Uint8Array() };
        const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
        const cancel = () => { void reader.cancel().catch(() => {}); }; active.addEventListener("abort", cancel, { once: true });
        try {
          while (true) { const next = await reader.read(); active.throwIfAborted(); if (next.done) break; bytes += next.value.byteLength; if (bytes > maximum || chunks.length >= 4096) throw new VoiceError("unavailable"); chunks.push(next.value); }
        } finally { active.removeEventListener("abort", cancel); void reader.cancel().catch(() => {}); reader.releaseLock(); }
        if (length !== null && Number(length) !== bytes && method !== "HEAD") throw new VoiceError("unavailable");
        const data = new Uint8Array(bytes); let offset = 0; for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
        return { status: response.status, data };
      } finally { void response?.body?.cancel().catch(() => {}); occupied--; clearTimeout(timer); active.removeEventListener("abort", stop); }
    })();
    return Promise.race([work, interrupted]);
  }
  return {
    async upload(input: VoiceStage, bytes: Uint8Array, signal?: AbortSignal) {
      const object = voiceDescriptor(input);
      if (Date.parse(input.expiresAt) <= Date.now() || bytes.byteLength !== object.bytes) throw new VoiceError("expired", 409);
      const r = await request("POST", `/object/${VOICE_BUCKET}/${object.path}`, 65536, signal, new Uint8Array(bytes), { "content-type": "audio/wav", "cache-control": "private, no-store", "x-upsert": "false", "x-metadata": Buffer.from(JSON.stringify({ voice_sha256: object.sha256 })).toString("base64") });
      // Duplicate responses vary by Storage version; only the subsequent byte proof commits.
      if (![200, 201, 400, 409].includes(r.status)) throw new VoiceError("upload_uncertain", 503);
    },
    async read(input: VoiceObject, signal?: AbortSignal) { const object = voiceDescriptor(input), r = await request("GET", `/object/authenticated/${VOICE_BUCKET}/${object.path}`, object.bytes, signal); if (r.status !== 200 || r.data.length !== object.bytes) throw new VoiceError("unavailable"); return r.data; },
    async remove(input: VoiceObject, signal?: AbortSignal) {
      const object = voiceDescriptor(input), r = await request("DELETE", `/object/${VOICE_BUCKET}`, 65536, signal, JSON.stringify({ prefixes: [object.path] }), { "content-type": "application/json" });
      if (r.status !== 200) throw new VoiceError("unavailable");
      let head = await request("HEAD", `/object/${VOICE_BUCKET}/${object.path}`, 2880044, signal);
      if (head.status === 400) head = await request("GET", `/object/authenticated/${VOICE_BUCKET}/${object.path}`, 0, signal, undefined, undefined, true);
      if (head.status !== 200 && head.status !== 404) throw new VoiceError("unavailable"); return head.status === 404;
    },
  };
}
export type VoiceObjects = ReturnType<typeof createVoiceObjects>;
