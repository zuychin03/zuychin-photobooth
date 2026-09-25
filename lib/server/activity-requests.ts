import { cloudUuid } from "../projects/cloud-contract";
import { validateActivityAnnotation, validateChapterInput } from "../memories/activity-contract";
import { validateMemoryBrowse } from "../memories/activity-browse";
import { ActivityServerError, createActivityStore, type ActivityStore } from "./activity-store";
import { privateJson } from "./cron-auth";
import { readSmallJson, requireSameOrigin, RequestValidationError } from "./request-security";

export interface ActivityRequestPorts { store(token: string, env: Record<string, string | undefined>): Promise<ActivityStore> }
const invalid = (): never => { throw new RequestValidationError(400, "Invalid memory request"); };
function operation(value: Record<string, unknown>) {
  try {
    const exact = (...keys: string[]) => { if (Object.keys(value).sort().join() !== ["operation", ...keys].sort().join()) invalid(); };
    const revision = (v: unknown) => { if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 2147483646) invalid(); return v as number; };
    switch (value.operation) {
      case "browse": exact("query"); return { operation: "browse" as const, query: validateMemoryBrowse(value.query) };
      case "list": {
        exact(...["after", "limit"].filter(k => Object.hasOwn(value, k)));
        const limit = value.limit ?? 20;
        if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 50 || value.limit === null) invalid();
        return { operation: "list" as const, after: Object.hasOwn(value, "after") ? cloudUuid(value.after) : undefined, limit: limit as number };
      }
      case "summary": exact("year"); if (!Number.isInteger(value.year) || (value.year as number) < 1970 || (value.year as number) > 2199) invalid(); return { operation: "summary" as const, year: value.year as number };
      case "chapters": exact(); return { operation: "chapters" as const };
      case "putChapter": exact("chapter"); return { operation: "putChapter" as const, chapter: validateChapterInput(value.chapter) };
      case "annotate": exact("annotation"); return { operation: "annotate" as const, annotation: validateActivityAnnotation(value.annotation) };
      case "deleteChapter": exact("id", "expectedRevision"); return { operation: "deleteChapter" as const, id: cloudUuid(value.id), expectedRevision: revision(value.expectedRevision) };
      default: return invalid();
    }
  } catch { return invalid(); }
}
const publicErrors: Readonly<Record<string, readonly number[]>> = { access_denied: [401, 403], invalid_request: [400], conflict: [409], capacity: [409], chapter_not_empty: [409], rate_limited: [429], unavailable: [503] };
export function createActivityHandler(ports: ActivityRequestPorts = { store: createActivityStore }, getEnv: () => Record<string, string | undefined> = () => process.env) {
  return async (request: Request): Promise<Response> => {
    try {
      const env = getEnv();
      if (env.PB_MEMORIES_ENABLED !== "true") return privateJson({ enabled: false, error: "unavailable" }, 503);
      if (request.method !== "POST") return privateJson({ error: "method_not_allowed" }, 405);
      const url = new URL(request.url), local = env.NODE_ENV === "development" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      if (url.protocol !== "https:" && !local) return privateJson({ error: "unavailable" }, 503);
      if (url.search) return invalid();
      requireSameOrigin(request, env);
      const token = /^Bearer ([^\s,]+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
      if (!token || token.length > 16384) return privateJson({ error: "access_denied" }, 401);
      const input = operation(await readSmallJson(request)), store = await ports.store(token, env);
      switch (input.operation) {
        case "browse": return privateJson(await store.browse(input.query));
        case "list": return privateJson(await store.list(input.after, input.limit));
        case "summary": return privateJson(await store.summary(input.year));
        case "chapters": return privateJson({ chapters: await store.chapters() });
        case "putChapter": return privateJson(await store.putChapter(input.chapter));
        case "annotate": return privateJson(await store.annotate(input.annotation));
        case "deleteChapter": return privateJson(await store.deleteChapter(input.id, input.expectedRevision));
      }
    } catch (error) {
      if (error instanceof RequestValidationError) return privateJson({ error: error.status === 403 ? "origin_denied" : error.status === 503 ? "unavailable" : "invalid_request" }, error.status);
      if (error instanceof ActivityServerError && Object.hasOwn(publicErrors, error.code) && publicErrors[error.code].includes(error.status)) {
        const response = privateJson({ error: error.code }, error.status);
        if (error.status === 429) response.headers.set("Retry-After", String(Number.isInteger(error.retryAfterSeconds) && error.retryAfterSeconds! >= 1 && error.retryAfterSeconds! <= 60 ? error.retryAfterSeconds : 60));
        return response;
      }
      return privateJson({ error: "unavailable" }, 503);
    }
  };
}
