import { createClient } from "@supabase/supabase-js";
import { CLOUD_DESIGN_LIMITS, designObject, designRevision, parseCloudDesignReceipt, parseCloudDesignRecord, validateCloudDesign, type CloudDesignRecord, type CloudDesignReceipt, type CloudDesignSnapshot } from "../projects/cloud-design";
import { cloudUuid } from "../projects/cloud-contract";
import { createProjectStore, ProjectServerError, type ProjectStore, type ProjectStorePorts } from "./project-store";
import { supabaseServiceOrigin } from "./cron-auth";

export interface ProjectDesignStore extends Pick<ProjectStore, "rate"> {
  capabilities(): { designVersion: 1; retirementVersion: 1; limits: typeof CLOUD_DESIGN_LIMITS; referenceAssets: true };
  head(projectId: string): Promise<CloudDesignReceipt | null>;
  read(projectId: string, checkpoint?: "current" | "previous"): Promise<CloudDesignRecord | null>;
  save(projectId: string, expectedRevision: number | null, requestId: string, snapshot: CloudDesignSnapshot): Promise<CloudDesignReceipt>;
  status(projectId: string, requestId: string): Promise<CloudDesignReceipt | null>;
}
export async function createProjectDesignStore(token: string, env: Record<string, string | undefined> = process.env, ports?: ProjectStorePorts): Promise<ProjectDesignStore> {
  if (!ports) {
    const url = supabaseServiceOrigin(env.NEXT_PUBLIC_SUPABASE_URL), key = env.SUPABASE_SERVICE_ROLE_KEY;
    if (env.PB_CLOUD_PROJECTS_ENABLED !== "true" || !url || !key?.trim()) throw new ProjectServerError("unavailable", 503);
    const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: (input, init) => fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) }) } });
    ports = { async authenticate(value) { const { data, error } = await client.auth.getUser(value); return error ? null : data.user?.id ?? null; }, rpc: async (name, args) => client.rpc(name, args) };
  }
  const port = ports; let actor: string | null = null;
  const base = await createProjectStore(token, env, { ...port, async authenticate(value) { actor = await port.authenticate(value); return actor; } });
  const rpc = async (name: string, args: Record<string, unknown> = {}) => {
    let result;
    try { result = await port.rpc(name, args); } catch { throw new ProjectServerError("unavailable", 503); }
    if (result.error) {
      const mappings: Record<string, [string, number]> = { PB_PROJECT_DENIED: ["access_denied", 403], PB_PROJECT_CONFLICT: ["conflict", 409], PB_PROJECT_CAPACITY: ["capacity", 409], PB_PROJECT_INVALID: ["invalid_request", 400] };
      const [code, status] = mappings[result.error.message] ?? ["unavailable", 503]; throw new ProjectServerError(code, status);
    }
    return result.data;
  };
  const cap = await rpc("pb_project_design_capabilities") as Record<string, unknown> | null;
  if (!cap || cap.designVersion !== 1 || cap.retirementVersion !== 1 || cap.snapshotBytes !== CLOUD_DESIGN_LIMITS.snapshotBytes || cap.bindings !== 24 || cap.checkpoints !== 2 || cap.receipts !== 100 || cap.referenceAssets !== true) throw new ProjectServerError("unavailable", 503);
  function projection<T>(parse: () => T): T { try { return parse(); } catch { throw new ProjectServerError("unavailable", 503); } }
  return {
    rate: base.rate,
    capabilities: () => ({ designVersion: 1, retirementVersion: 1, limits: CLOUD_DESIGN_LIMITS, referenceAssets: true }),
    async head(projectId) {
      const result = await rpc("pb_project_design_head", { p_actor: actor, p_project: cloudUuid(projectId) });
      return projection(() => { const value = designObject(result, ["receipt"]); return value.receipt === null ? null : parseCloudDesignReceipt(value.receipt, projectId); });
    },
    async read(projectId, checkpoint = "current") {
      if (!["current", "previous"].includes(checkpoint)) throw new ProjectServerError("invalid_request", 400);
      const result = await rpc("pb_project_design_read", { p_actor: actor, p_project: cloudUuid(projectId), p_checkpoint: checkpoint });
      return projection(() => parseCloudDesignRecord(result, projectId));
    },
    async save(projectId, expectedRevision, requestId, snapshot) {
      const checked = validateCloudDesign(snapshot), expected = designRevision(expectedRevision);
      if (checked.project.schemaVersion === 4 && cap.exportSettingsVersion !== 1) throw new ProjectServerError("unavailable", 503);
      const result = await rpc("pb_project_design_save", { p_actor: actor, p_project: cloudUuid(projectId), p_request: cloudUuid(requestId), p_expected: expected, p_snapshot: checked });
      const receipt = projection(() => parseCloudDesignReceipt(result, projectId, requestId));
      if (receipt.revision !== (expected === null ? 0 : expected + 1)) throw new ProjectServerError("unavailable", 503);
      return receipt;
    },
    async status(projectId, requestId) {
      const result = await rpc("pb_project_design_status", { p_actor: actor, p_project: cloudUuid(projectId), p_request: cloudUuid(requestId) });
      return projection(() => { const value = designObject(result, ["receipt"]); return value.receipt === null ? null : parseCloudDesignReceipt(value.receipt, projectId, requestId); });
    },
  };
}
