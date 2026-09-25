import { CLOUD_DESIGN_LIMITS, designObject, designRevision, validateCloudDesign } from "../projects/cloud-design";
import { cloudUuid } from "../projects/cloud-contract";
import { privateJson } from "./cron-auth";
import { createProjectDesignStore, type ProjectDesignStore } from "./project-design-store";
import { ProjectServerError } from "./project-store";
import { requireSameOrigin, RequestValidationError } from "./request-security";

async function body(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") throw new RequestValidationError(415, "JSON required");
  const length = Number(request.headers.get("content-length") ?? 0);
  if (!Number.isSafeInteger(length) || length < 0 || length > CLOUD_DESIGN_LIMITS.requestBytes) throw new RequestValidationError(413, "Request too large");
  if (!request.body) throw new RequestValidationError(400, "Body required");
  const reader = request.body.getReader(), chunks: Uint8Array[] = []; let size = 0, expired = false;
  const timer = setTimeout(() => { expired = true; void reader.cancel().catch(() => undefined); }, 5000);
  try {
    while (true) {
      const next = await reader.read(); if (expired) throw new RequestValidationError(408, "Timeout"); if (next.done) break;
      size += next.value.byteLength;
      if (size > CLOUD_DESIGN_LIMITS.requestBytes || chunks.length >= 4096) throw new RequestValidationError(413, "Request too large");
      chunks.push(next.value);
    }
    const data = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data)); } catch { throw new RequestValidationError(400, "Invalid JSON"); }
  } finally { clearTimeout(timer); await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
export function createProjectDesignHandler(createStore: (token: string, env: Record<string, string | undefined>) => Promise<ProjectDesignStore> = createProjectDesignStore, getEnv: () => Record<string, string | undefined> = () => process.env) {
  return async (request: Request): Promise<Response> => {
    try {
      const env = getEnv(), url = new URL(request.url);
      if (env.PB_CLOUD_PROJECTS_ENABLED !== "true") return privateJson({ error: "unavailable" }, 503);
      if (request.method !== "POST") return privateJson({ error: "method_not_allowed" }, 405);
      if (url.protocol !== "https:" && !(env.NODE_ENV === "development" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new ProjectServerError("unavailable", 503);
      if (url.search) throw new Error("invalid_request");
      requireSameOrigin(request, env);
      const token = /^Bearer ([^\s,]+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
      if (!token || token.length > 16384) throw new ProjectServerError("access_denied", 401);
      const raw = await body(request), operation = (raw as Record<string, unknown> | null)?.operation;
      if (!["capabilities", "head", "read", "save", "status"].includes(operation as string)) throw new Error("invalid_request");
      const value = designObject(raw, operation === "capabilities" ? ["operation"] : operation === "head" ? ["operation", "projectId"] : operation === "read" ? ["operation", "projectId", "checkpoint"] : operation === "status" ? ["operation", "projectId", "requestId"] : ["operation", "projectId", "requestId", "expectedRevision", "snapshot"]);
      const projectId = operation === "capabilities" ? "" : cloudUuid(value.projectId);
      if (operation === "read" && !["current", "previous"].includes(value.checkpoint as string)) throw new Error("invalid_request");
      if (operation === "save" || operation === "status") cloudUuid(value.requestId);
      const snapshot = operation === "save" ? validateCloudDesign(value.snapshot) : null;
      if (operation === "save") designRevision(value.expectedRevision);
      const store = await createStore(token, env); await store.rate(operation === "save" ? "write" : "read");
      if (operation === "capabilities") return privateJson(store.capabilities());
      if (operation === "head") return privateJson({ receipt: await store.head(projectId) });
      if (operation === "read") return privateJson({ design: await store.read(projectId, value.checkpoint as "current" | "previous") });
      if (operation === "status") return privateJson({ receipt: await store.status(projectId, value.requestId as string) });
      return privateJson(await store.save(projectId, value.expectedRevision as number | null, value.requestId as string, snapshot!));
    } catch (error) {
      if (error instanceof RequestValidationError) return privateJson({ error: error.status === 403 ? "origin_denied" : error.status === 503 ? "unavailable" : "invalid_request" }, error.status);
      if (error instanceof ProjectServerError && ["access_denied", "unavailable", "conflict", "capacity", "invalid_request", "rate_limited"].includes(error.code)) {
        const response = privateJson({ error: error.code }, error.status);
        if (error.status === 429) response.headers.set("Retry-After", String(Math.max(1, Math.min(60, error.retryAfterSeconds ?? 60))));
        return response;
      }
      return privateJson({ error: error instanceof Error && error.message === "invalid_request" ? "invalid_request" : "unavailable" }, error instanceof Error && error.message === "invalid_request" ? 400 : 503);
    }
  };
}
