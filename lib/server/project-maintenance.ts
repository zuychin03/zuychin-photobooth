import { authorizeCron, privateJson, type CronConfig, type CronEnvironment } from "./cron-auth";
import { createProjectFinalisationStore, type ProjectFinalisationStore } from "./project-store";
import { createProjectObjects, ProjectObjectError, type ProjectObjects } from "./project-objects";
import { ImageFinaliseError, verifyProjectOriginal } from "./image-finalise";
import type { ProjectFinalisationClaim, ProjectFinalisationOutcome } from "../projects/cloud-contract";

export interface ProjectMaintenancePorts {
  store: ProjectFinalisationStore;
  objects: Pick<ProjectObjects, "download" | "removeAndConfirmAbsent">;
  verify?: typeof verifyProjectOriginal;
  now?: () => number;
}
export interface ProjectMaintenanceResult {
  expired: number | null;
  finalisation: "idle" | "ready" | "retry" | "failed" | "retained";
  cleanup: "idle" | "complete" | "retry" | "failed" | "retained";
}

function permanentImageFailure(error: unknown): boolean {
  return error instanceof ImageFinaliseError && ["invalid_image", "metadata_mismatch", "output_too_large"].includes(error.code)
    || error instanceof ProjectObjectError && ["object_too_large", "size_mismatch"].includes(error.code);
}

export async function processProjectMaintenance(ports: ProjectMaintenancePorts, signal?: AbortSignal): Promise<ProjectMaintenanceResult> {
  const { store, objects } = ports, now = ports.now ?? Date.now, verify = ports.verify ?? verifyProjectOriginal;
  const live = (leaseUntil: string) => !signal?.aborted && Date.parse(leaseUntil) > now();
  const finalise = async (): Promise<ProjectMaintenanceResult["finalisation"]> => {
    let claim: ProjectFinalisationClaim | null = null, bytes: Uint8Array | undefined, verified: Awaited<ReturnType<typeof verify>> | undefined;
    try {
      if (signal?.aborted) return "retained";
      claim = await store.claim();
      if (!claim) return "idle";
      if (!live(claim.leaseUntil) || !live(claim.reservedUntil)) return "retained";
      let outcome: ProjectFinalisationOutcome;
      try {
        bytes = await objects.download({ bucket: claim.bucket, path: claim.path, bytes: claim.bytes });
        if (!live(claim.leaseUntil) || !live(claim.reservedUntil)) return "retained";
        const remaining = Math.min(10_000, Date.parse(claim.leaseUntil) - now(), Date.parse(claim.reservedUntil) - now());
        verified = await verify(bytes, claim, { signal, timeoutMs: remaining });
        outcome = { kind: "verified", verified: verified.verified };
      } catch (error) { outcome = { kind: permanentImageFailure(error) ? "reject" : "retry" }; }
      if (!live(claim.leaseUntil) || !live(claim.reservedUntil)) return "retained";
      // An uncertain finish is left to the lease protocol, never downgraded by a second assertion.
      const finished = await store.finish(claim, outcome);
      if (finished.assetStatus === "ready" && finished.status === "complete") return "ready";
      if (finished.status === "failed") return "failed";
      return finished.status === "retry" ? "retry" : "retained";
    } catch { return "retained"; }
    finally { bytes?.fill(0); verified?.original.fill(0); }
  };
  const cleanup = async (): Promise<ProjectMaintenanceResult["cleanup"]> => {
    try {
      if (signal?.aborted) return "retained";
      const claim = await store.claimCleanup();
      if (!claim) return "idle";
      if (!live(claim.leaseUntil)) return "retained";
      let absent = false;
      try { absent = await objects.removeAndConfirmAbsent({ bucket: claim.bucket, path: claim.path }); }
      catch { /* Unknown provider state keeps the reservation charged. */ }
      if (!live(claim.leaseUntil)) return "retained";
      const finished = await store.finishCleanup(claim, absent);
      return finished.complete ? "complete" : claim.attempts >= 8 ? "failed" : "retry";
    } catch { return "retained"; }
  };
  let expired: number | null = null;
  if (!signal?.aborted) try { expired = (await store.sweep(25)).expired; } catch { /* Other already queued work can still be attempted. */ }
  const [finalisation, cleaned] = await Promise.all([finalise(), cleanup()]);
  return { expired, finalisation, cleanup: cleaned };
}

async function productionPorts(config: CronConfig, env: CronEnvironment): Promise<ProjectMaintenancePorts> {
  return { store: await createProjectFinalisationStore(env), objects: createProjectObjects({ origin: config.supabaseUrl, serviceRoleKey: config.serviceRoleKey }) };
}

export function createProjectMaintenanceHandler(makePorts = productionPorts, getEnv: () => CronEnvironment = () => process.env) {
  let running = false;
  return async (request: Request): Promise<Response> => {
    const env = getEnv();
    if (env.PB_CLOUD_PROJECTS_ENABLED !== "true") return privateJson({ error: "Project maintenance is unavailable" }, 503);
    const auth = authorizeCron(request, env);
    if (!auth.ok) return auth.response;
    if (running) return privateJson({ error: "Project maintenance is already running" }, 409);
    running = true;
    try {
      const result = await processProjectMaintenance(await makePorts(auth.config, env), request.signal);
      const uncertain = result.expired === null || ["retry", "retained"].includes(result.finalisation) || ["retry", "failed", "retained"].includes(result.cleanup);
      return privateJson(result, uncertain ? 503 : 200);
    } catch { return privateJson({ error: "Project maintenance is unavailable; queued work is preserved" }, 503); }
    finally { running = false; }
  };
}
