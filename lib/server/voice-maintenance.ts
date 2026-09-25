import { createVoiceMaintenanceStore } from "./voice-store";
import { createVoiceObjects, type VoiceObjects } from "./voice-objects";

export async function processVoiceMaintenance(env: Record<string, string | undefined>, signal?: AbortSignal, ports?: { store: Awaited<ReturnType<typeof createVoiceMaintenanceStore>>; objects: Pick<VoiceObjects, "remove"> }) {
  const store = ports?.store ?? await createVoiceMaintenanceStore(env, signal), objects = ports?.objects ?? createVoiceObjects(env);
  const queued = await store.sweep(), claim = await store.claim();
  if (!claim) return { queued, cleanup: "idle" as const };
  if (signal?.aborted || Date.parse(claim.leaseUntil) <= Date.now()) return { queued, cleanup: "retained" as const };
  let absent = false; try { absent = await objects.remove(claim, signal); } catch { /* Unknown provider state stays charged. */ }
  if (signal?.aborted || Date.parse(claim.leaseUntil) <= Date.now()) return { queued, cleanup: "retained" as const };
  const complete = await store.finish(claim, absent);
  return { queued, cleanup: complete ? "complete" as const : claim.attempts >= 8 ? "failed" as const : "retry" as const };
}
