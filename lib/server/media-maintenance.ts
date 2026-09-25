import { authorizeCron, privateJson, type CronConfig, type CronEnvironment } from "./cron-auth";
import { enqueueRetention, lifecycleCapabilities, lifecycleClient, processMediaJobs, type LifecycleCapabilities } from "./media-store";
import { processVoiceMaintenance } from "./voice-maintenance";

export interface MaintenanceAdapter {
  capabilities(): Promise<LifecycleCapabilities>;
  enqueue(capabilities: LifecycleCapabilities): Promise<number>;
  process(): Promise<{ id: string; outcome: "complete" | "retry" | "failed"; code?: string }[]>;
}

function productionAdapter(config: CronConfig): MaintenanceAdapter {
  const client = lifecycleClient(config);
  return { capabilities: () => lifecycleCapabilities(client), enqueue: cap => enqueueRetention(client, cap), process: () => processMediaJobs(client) };
}

export function createMaintenanceHandler(makeAdapter = productionAdapter, getEnv: () => CronEnvironment = () => process.env, voice = processVoiceMaintenance) {
  return async (request: Request): Promise<Response> => {
    const env = getEnv(), auth = authorizeCron(request, env);
    if (!auth.ok) return auth.response;
    let voiceResult: Awaited<ReturnType<typeof processVoiceMaintenance>> | { cleanup: "unavailable" } | undefined;
    if (env.PB_MEMORIES_ENABLED === "true" && env.PB_VOICE_CAPTIONS_ENABLED === "true") {
      try { voiceResult = await voice(env, request.signal); } catch { voiceResult = { cleanup: "unavailable" }; }
    }
    try {
      const adapter = makeAdapter(auth.config);
      const capabilities = await adapter.capabilities();
      const enqueued = await adapter.enqueue(capabilities);
      const results = await adapter.process();
      return privateJson({ enqueued, processed: results.length, completed: results.filter(r => r.outcome === "complete").length, retrying: results.filter(r => r.outcome === "retry").length, failed: results.filter(r => r.outcome === "failed").length, weekStart: capabilities.week_start, ...(voiceResult ? { voice: voiceResult } : {}) }, results.some(r => r.outcome !== "complete") || voiceResult && !["idle", "complete"].includes(voiceResult.cleanup) ? 503 : 200);
    } catch { return privateJson({ error: "Media maintenance is unavailable; queued work is preserved" }, 503); }
  };
}
