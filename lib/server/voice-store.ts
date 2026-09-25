import { createClient } from "@supabase/supabase-js";
import { cloudTimestamp, cloudUuid } from "../projects/cloud-contract";
import { VoiceError, parseVoiceSnapshot, type VoiceCaptionSnapshot } from "../memories/voice-contract";
import { supabaseServiceOrigin } from "./cron-auth";
import type { ProjectStorePorts } from "./project-store";

export const VOICE_BUCKET = "photobooth-voice-captions";
export interface VoiceObject { generation: string; actor: string; activityId: string; path: string; bytes: number; samples: number; sha256: string }
export interface VoiceStage extends VoiceObject { expiresAt: string }
export interface VoiceCleanup extends VoiceObject { lease: string; leaseUntil: string; attempts: number }
export type VoiceSaved = { status: "complete"; snapshot: VoiceCaptionSnapshot } | { status: "staged"; stage: VoiceStage };
export interface VoiceSaveInput { requestId: string; revision: number; text: string; operation: "keep" | "remove" | "replace" | "delete"; audio: { bytes: number; samples: number; sha256: string } | null }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new VoiceError("unavailable"); return value as Record<string, unknown>; }
export function voiceDescriptor(value: unknown): VoiceObject {
  try {
    const v = object(value), generation = cloudUuid(v.generation), actor = cloudUuid(v.actor), activityId = cloudUuid(v.activityId);
    if (v.path !== `${actor}/${activityId}/${generation}.wav` || !Number.isInteger(v.samples) || (v.samples as number) < 1 || (v.samples as number) > 1440000 || v.bytes !== 44 + (v.samples as number) * 2 || typeof v.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(v.sha256)) throw new Error();
    return { generation, actor, activityId, path: v.path as string, bytes: v.bytes as number, samples: v.samples as number, sha256: v.sha256 };
  } catch { throw new VoiceError("unavailable"); }
}
async function connection(env: Record<string, string | undefined>, signal?: AbortSignal, ports?: ProjectStorePorts) {
  const origin = supabaseServiceOrigin(env.NEXT_PUBLIC_SUPABASE_URL), key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (env.PB_MEMORIES_ENABLED !== "true" || env.PB_VOICE_CAPTIONS_ENABLED !== "true" || !origin || !key?.trim()) throw new VoiceError("unavailable");
  if (!ports) {
    const client = createClient(origin, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]) }) } });
    ports = { authenticate: async token => { const { data, error } = await client.auth.getUser(token); return error ? null : data.user?.id ?? null; }, rpc: async (name, args) => client.rpc(name, args) };
  }
  const rpc = async (name: string, args: Record<string, unknown> = {}) => {
    signal?.throwIfAborted(); const result = await ports!.rpc(name, args); signal?.throwIfAborted();
    if (result.error) {
      const codes: Record<string, [string, number]> = { PB_VOICE_DENIED: ["access_denied", 403], PB_MEMORY_DENIED: ["access_denied", 403], PB_PROJECT_DENIED: ["access_denied", 403], PB_RETAINED_DENIED: ["access_denied", 403], PB_RETAINED_UNAVAILABLE: ["source_unavailable", 409], PB_VOICE_CONFLICT: ["conflict", 409], PB_VOICE_CAPACITY: ["capacity", 409], PB_VOICE_EXPIRED: ["expired", 409], PB_VOICE_INVALID: ["invalid_request", 400], PB_VOICE_NOT_READY: ["not_ready", 409] };
      const [code, status] = codes[result.error.message] ?? ["unavailable", 503]; throw new VoiceError(code, status);
    }
    if (new TextEncoder().encode(JSON.stringify(result.data)).length > 16384) throw new VoiceError("unavailable"); return object(result.data);
  };
  const cap = await rpc("pb_voice_capabilities");
  if (cap.version !== 1 || cap.ready !== true || cap.actorBytes !== 57600880 || cap.generations !== 20 || cap.heads !== 500 || cap.receipts !== 100) throw new VoiceError("unavailable");
  return { rpc, ports };
}
export async function createVoiceStore(token: string, env: Record<string, string | undefined> = process.env, signal?: AbortSignal, ports?: ProjectStorePorts) {
  if (!token || token.length > 16384 || /[\s,]/.test(token)) throw new VoiceError("access_denied", 401);
  const { rpc, ports: provider } = await connection(env, signal, ports);
  let actor: string; try { actor = cloudUuid(await provider.authenticate(token)); } catch { throw new VoiceError("access_denied", 401); }
  const authenticate = async () => { signal?.throwIfAborted(); if (await provider.authenticate(token) !== actor) throw new VoiceError("access_denied", 401); signal?.throwIfAborted(); };
  const parse = (value: unknown, activity: string) => { try { return parseVoiceSnapshot(value, activity); } catch { throw new VoiceError("unavailable"); } };
  return {
    actor,
    async rate(operation: "read" | "write") { const r = await rpc("pb_project_rate", { p_actor: actor, p_operation: operation }); if (r.allowed === false && Number.isInteger(r.retryAfterSeconds) && (r.retryAfterSeconds as number) >= 1 && (r.retryAfterSeconds as number) <= 60) throw new VoiceError("rate_limited", 429); if (r.allowed !== true || r.retryAfterSeconds !== 0) throw new VoiceError("unavailable"); },
    async read(activityId: string) { await authenticate(); return parse(await rpc("pb_voice_read", { p_actor: actor, p_activity: cloudUuid(activityId) }), activityId); },
    async save(activityId: string, input: VoiceSaveInput): Promise<VoiceSaved> {
      await authenticate();
      const r = await rpc("pb_voice_save", { p_actor: actor, p_activity: cloudUuid(activityId), p_request: input.requestId, p_revision: input.revision, p_text: input.text, p_operation: input.operation, p_audio: input.audio });
      if (r.status === "complete") return { status: "complete", snapshot: parse(r.snapshot, activityId) };
      const stage = { ...voiceDescriptor(r), expiresAt: cloudTimestamp(r.expiresAt) };
      if (r.status !== "staged" || stage.actor !== actor || stage.activityId !== activityId || stage.generation !== input.requestId || !input.audio || stage.bytes !== input.audio.bytes || stage.samples !== input.audio.samples || stage.sha256 !== input.audio.sha256 || Date.parse(stage.expiresAt) <= Date.now() || Date.parse(stage.expiresAt) > Date.now() + 601_000) throw new VoiceError("unavailable");
      return { status: "staged", stage };
    },
    async finish(activityId: string, requestId: string, sha256: string) { await authenticate(); return parse(await rpc("pb_voice_finish", { p_actor: actor, p_activity: cloudUuid(activityId), p_request: cloudUuid(requestId), p_sha256: sha256 }), activityId); },
  };
}
export type VoiceStore = Awaited<ReturnType<typeof createVoiceStore>>;
export async function createVoiceMaintenanceStore(env: Record<string, string | undefined>, signal?: AbortSignal, ports?: ProjectStorePorts) {
  const { rpc } = await connection(env, signal, ports);
  return {
    async sweep() { const r = await rpc("pb_voice_sweep", { p_limit: 25 }); if (!Number.isInteger(r.queued) || (r.queued as number) < 0 || (r.queued as number) > 50) throw new VoiceError("unavailable"); return r.queued as number; },
    async claim(): Promise<VoiceCleanup | null> { const r = await rpc("pb_voice_claim_cleanup"); if (!Object.keys(r).length) return null; const result = { ...voiceDescriptor(r), lease: cloudUuid(r.lease), leaseUntil: cloudTimestamp(r.leaseUntil), attempts: r.attempts as number }; if (!Number.isInteger(result.attempts) || result.attempts < 1 || result.attempts > 8) throw new VoiceError("unavailable"); return result; },
    async finish(claim: VoiceCleanup, absent: boolean) { const r = await rpc("pb_voice_finish_cleanup", { p_generation: claim.generation, p_lease: claim.lease, p_absent: absent }); if (r.complete !== absent) throw new VoiceError("unavailable"); return absent; },
  };
}
