import { CLOUD_PROJECT_LIMITS, cloudUuid, validateCloudAsset, type CloudAssetInput } from "../projects/cloud-contract";
import { createProjectStore, ProjectServerError, type ProjectStore } from "./project-store";
import { createProjectObjects, type ProjectObjects } from "./project-objects";
import { privateJson, supabaseServiceOrigin } from "./cron-auth";
import { readSmallJson, requireSameOrigin, RequestValidationError } from "./request-security";

type Operation = "capabilities" | "list" | "create" | "view" | "member" | "reserve" | "upload" | "finalise" | "status" | "read" | "delete";
export interface ProjectRequestPorts {
  store(token: string, env: Record<string, string | undefined>): Promise<ProjectStore>;
  objects(env: Record<string, string | undefined>): Pick<ProjectObjects, "mintUpload" | "signRead">;
}
const production: ProjectRequestPorts = {
  store: createProjectStore,
  objects: env => {
    const origin = supabaseServiceOrigin(env.NEXT_PUBLIC_SUPABASE_URL);
    if (!origin || !env.SUPABASE_SERVICE_ROLE_KEY) throw new ProjectServerError("unavailable", 503);
    return createProjectObjects({ origin, serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY });
  },
};
const invalid = (): never => { throw new ProjectServerError("invalid_request", 400); };
function shape(body: Record<string, unknown>, required: string[], optional: string[] = []) {
  if (required.some(key => !Object.hasOwn(body, key)) || Object.keys(body).some(key => !["operation", ...required, ...optional].includes(key))) invalid();
}
function validate(body: Record<string, unknown>): Operation {
  const op = body.operation as Operation;
  if (op === "capabilities") shape(body, []);
  else if (op === "list") {
    shape(body, [], ["after", "limit"]);
    if (body.after !== undefined) cloudUuid(body.after);
    if (body.limit !== undefined && (!Number.isSafeInteger(body.limit) || (body.limit as number) < 1 || (body.limit as number) > 50)) invalid();
  } else if (op === "create") {
    shape(body, ["id", "kind", "title", "maxBytes"]); cloudUuid(body.id);
    if (!["personal", "friend"].includes(body.kind as string) || typeof body.title !== "string" || !body.title.trim() || body.title !== body.title.trim() || [...body.title].length > 100 || /[\u0000-\u001f\u007f]/.test(body.title) || !Number.isSafeInteger(body.maxBytes) || (body.maxBytes as number) < CLOUD_PROJECT_LIMITS.assetBytes || (body.maxBytes as number) > CLOUD_PROJECT_LIMITS.projectBytes) invalid();
  } else if (op === "view") { shape(body, ["projectId"]); cloudUuid(body.projectId); }
  else if (op === "member") {
    shape(body, ["projectId", "userId", "action"]); cloudUuid(body.projectId); cloudUuid(body.userId);
    if (!["invite", "accept", "revoke"].includes(body.action as string)) invalid();
  } else if (op === "reserve") { shape(body, ["projectId", "asset"]); cloudUuid(body.projectId); validateCloudAsset(body.asset); }
  else if (op === "upload") { shape(body, ["projectId", "assetId"]); cloudUuid(body.projectId); cloudUuid(body.assetId); }
  else if (["finalise", "status", "read"].includes(op)) { shape(body, ["assetId"]); cloudUuid(body.assetId); }
  else if (op === "delete") { shape(body, ["projectId"], ["assetId"]); cloudUuid(body.projectId); if (body.assetId !== undefined) cloudUuid(body.assetId); }
  else invalid();
  return op;
}

export function createProjectHandler(ports: ProjectRequestPorts = production, getEnv: () => Record<string, string | undefined> = () => process.env) {
  return async (request: Request): Promise<Response> => {
    try {
      const env = getEnv();
      if (env.PB_CLOUD_PROJECTS_ENABLED !== "true") return privateJson({ enabled: false, error: "unavailable" }, 503);
      if (request.method !== "POST") return privateJson({ error: "method_not_allowed" }, 405);
      const url = new URL(request.url), local = env.NODE_ENV === "development" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      if (url.protocol !== "https:" && !local) throw new ProjectServerError("unavailable", 503);
      if (url.search) invalid();
      requireSameOrigin(request, env);
      const token = /^Bearer ([^\s,]+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
      if (!token || token.length > 16_384) throw new ProjectServerError("access_denied", 401);
      const body = await readSmallJson(request), operation = validate(body);
      const store = await ports.store(token, env);
      await store.rate(operation === "upload" ? "upload" : ["capabilities", "list", "view", "read", "status"].includes(operation) ? "read" : "write");
      const project = body.projectId as string, asset = body.assetId as string;
      if (operation === "capabilities") return privateJson({ enabled: true, version: 1, limits: CLOUD_PROJECT_LIMITS });
      if (operation === "list") return privateJson(await store.list(body.after as string | undefined, body.limit as number | undefined));
      if (operation === "create") return privateJson(await store.create({ id: body.id as string, kind: body.kind as "personal" | "friend", title: body.title as string, maxBytes: body.maxBytes as number }), 201);
      if (operation === "view") return privateJson(await store.view(project));
      if (operation === "member") return privateJson(await store.member(project, body.userId as string, body.action as "invite" | "accept" | "revoke"));
      if (operation === "reserve") return privateJson(await store.reserve(project, body.asset as CloudAssetInput), 201);
      if (operation === "upload") {
        const authorisation = await store.authoriseUpload(project, asset);
        return privateJson(await ports.objects(env).mintUpload(authorisation));
      }
      if (operation === "read") {
        const access = await store.resolveAsset(asset);
        const signed = await ports.objects(env).signRead(access), current = await store.resolveAsset(asset);
        if ((Object.keys(access) as (keyof typeof access)[]).some(key => current[key] !== access[key])) throw new ProjectServerError("unavailable", 503);
        return privateJson({ ...signed, expiresIn: access.expiresIn });
      }
      if (operation === "finalise") return privateJson(await store.enqueueFinalisation(asset), 202);
      if (operation === "status") return privateJson(await store.finalisationStatus(asset));
      return privateJson(await store.delete(project, asset), 202);
    } catch (error) {
      if (error instanceof RequestValidationError) return privateJson({ error: error.status === 403 ? "origin_denied" : "invalid_request" }, error.status);
      if (error instanceof ProjectServerError) {
        const response = privateJson({ error: error.code }, error.status);
        if (error.status === 429) response.headers.set("Retry-After", String(Number.isSafeInteger(error.retryAfterSeconds) && error.retryAfterSeconds! >= 1 && error.retryAfterSeconds! <= 60 ? error.retryAfterSeconds : 60));
        return response;
      }
      if (error instanceof Error && error.message === "invalid_request") return privateJson({ error: "invalid_request" }, 400);
      return privateJson({ error: "unavailable" }, 503);
    }
  };
}
