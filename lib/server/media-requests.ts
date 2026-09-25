import { randomUUID } from "node:crypto";
import { supabaseServiceOrigin, privateJson, type CronEnvironment } from "./cron-auth";
import { lifecycleCapabilities, lifecycleClient, processMediaJobs } from "./media-store";
import { readSmallJson, requireSameOrigin, RequestValidationError } from "./request-security";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Operation = "archive" | "release" | "delete";

interface OperationAdapter {
  authorise(): Promise<boolean>;
  ready(): Promise<void>;
  enqueue(id: string, operation: Operation, requestId: string): Promise<string>;
  process(jobId: string): Promise<{ id: string; outcome: "complete" | "retry" | "failed"; code?: string }[]>;
}

async function productionAdapter(env: CronEnvironment): Promise<OperationAdapter> {
  const url = supabaseServiceOrigin(env.NEXT_PUBLIC_SUPABASE_URL);
  if (!url || !env.SUPABASE_SERVICE_ROLE_KEY?.trim() || !env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim()) throw new RequestValidationError(503, "Cloud operations are not configured");
  const { createClient } = await import("../supabase/server");
  const userClient = await createClient({ fetchTimeoutMs: 10_000 });
  const admin = lifecycleClient({ supabaseUrl: url, serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY });
  return {
    async authorise() {
      const { data, error } = await userClient.auth.getUser();
      return !error && Boolean(data.user);
    },
    async ready() { await lifecycleCapabilities(admin); },
    async enqueue(id, operation, requestId) {
      const { data, error } = await userClient.rpc("pb_enqueue_strip_operation", { p_strip_id: id, p_operation: operation, p_request_id: requestId });
      if (error) throw new RequestValidationError(409, "This strip cannot accept the requested operation");
      const job = Array.isArray(data) ? data[0] : data;
      if (!job || typeof job.id !== "string") throw new RequestValidationError(503, "Operation could not be recorded");
      return job.id;
    },
    process: jobId => processMediaJobs(admin, jobId),
  };
}

export function createStripOperationHandler(makeAdapter = productionAdapter, getEnv: () => CronEnvironment = () => process.env) {
  return async (request: Request, deleteId?: string): Promise<Response> => {
    try {
      const env = getEnv();
      requireSameOrigin(request, env);
      const body = await readSmallJson(request);
      const id = deleteId ?? body.id;
      const requestId = body.requestId ?? randomUUID();
      const allowed = deleteId ? ["requestId"] : ["id", "kept", "requestId"];
      if (Object.keys(body).some(key => !allowed.includes(key)) || typeof id !== "string" || !UUID.test(id) || typeof requestId !== "string" || !UUID.test(requestId) || (!deleteId && typeof body.kept !== "boolean")) return privateJson({ error: "Invalid strip operation" }, 400);
      const adapter = await makeAdapter(env);
      if (!await adapter.authorise()) return privateJson({ error: "Sign in is required" }, 401);
      await adapter.ready();
      const operation = deleteId ? "delete" : body.kept ? "archive" : "release";
      const jobId = await adapter.enqueue(id, operation, requestId);
      const result = (await adapter.process(jobId)).find(item => item.id === jobId);
      if (result?.outcome === "failed") return privateJson({ error: result.code === "archive_is_only_copy" ? "This archive is the only copy. Use Delete to remove it." : "The operation needs attention; its recovery record was retained", jobId }, 409);
      const pending = !result || result.outcome !== "complete";
      return privateJson({ jobId, pending, ...(deleteId ? { deleted: !pending } : { kept: Boolean(body.kept), pushed: body.kept === true && !pending }) }, pending ? 202 : 200);
    } catch (error) {
      if (error instanceof RequestValidationError) return privateJson({ error: error.message }, error.status);
      return privateJson({ error: "The operation could not finish; any recorded job remains available for retry" }, 503);
    }
  };
}
