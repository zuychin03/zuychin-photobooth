import { createClient } from "@supabase/supabase-js";
import { supabaseServiceOrigin } from "./cron-auth";
import { EventStoreError, type EventRpcClient } from "./event-store";

export interface EventWorkerStatus { version: 1; ready: boolean; verifiedAt: string | null; pending: number; maxPending: 2; heartbeatMaxAgeSeconds: 150; admissionPaused?: boolean }
export interface EventReadinessStore { status(): Promise<EventWorkerStatus>; verified(): Promise<EventWorkerStatus> }
export function parseEventWorkerStatus(value: unknown): EventWorkerStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new EventStoreError("unavailable", 503);
  const b = value as Record<string, unknown>;
  const keys = ["version", "ready", "verifiedAt", "pending", "maxPending", "heartbeatMaxAgeSeconds", ...("admissionPaused" in b ? ["admissionPaused"] : [])];
  if (Object.keys(b).sort().join() !== keys.sort().join() || "admissionPaused" in b && (typeof b.admissionPaused !== "boolean" || b.admissionPaused && b.ready) || b.version !== 1 || typeof b.ready !== "boolean" || b.maxPending !== 2 || b.heartbeatMaxAgeSeconds !== 150 || !Number.isSafeInteger(b.pending) || Number(b.pending) < 0 || b.verifiedAt !== null && (typeof b.verifiedAt !== "string" || !Number.isFinite(Date.parse(b.verifiedAt))) || b.ready && b.verifiedAt === null) throw new EventStoreError("unavailable", 503);
  return b as unknown as EventWorkerStatus;
}
export function createEventReadinessStore(env: Record<string, string | undefined> = process.env, provided?: EventRpcClient, signal?: AbortSignal): EventReadinessStore {
  const origin = supabaseServiceOrigin(env.NEXT_PUBLIC_SUPABASE_URL), key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (env.PB_EVENTS_ENABLED !== "true" || !origin || !key?.trim()) throw new EventStoreError("unavailable", 503);
  const client = provided ?? (() => { const admin = createClient(origin, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: (input, init) => fetch(input, { ...init, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000) }) } }); return { rpc: async (name: string, args: Record<string, unknown>) => admin.rpc(name, args) }; })();
  const rpc = async (name: string) => {
    if (signal?.aborted) throw new EventStoreError("unavailable", 503);
    const result = await client.rpc(name, {}).catch(() => { throw new EventStoreError("unavailable", 503); });
    if (result.error || signal?.aborted) throw new EventStoreError("unavailable", 503);
    return parseEventWorkerStatus(result.data);
  };
  return { status: () => rpc("pb_event_worker_status"), verified: () => rpc("pb_event_worker_verified") };
}
