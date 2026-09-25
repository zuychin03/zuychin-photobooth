import { cloudTimestamp, cloudUuid } from "../projects/cloud-contract";
import { RITUAL_LIMITS, parseRitualPage, parseRitualRow, ritualObject, ritualRevision, validateRitualChannels, validateRitualEdit, validateRitualInput } from "../memories/ritual-contract";
import { createActivityHandler } from "./activity-requests";
import { RitualServerError, createRitualStore, type RitualStore } from "./ritual-store";
import { privateJson } from "./cron-auth";
import { readSmallJson, requireSameOrigin, RequestValidationError } from "./request-security";

export interface RitualRequestPorts {
  store(token: string, env: Record<string, string | undefined>): Promise<RitualStore>;
  activity?(request: Request): Promise<Response>;
}
const invalid = (): never => { throw new RequestValidationError(400, "Invalid ritual request"); };
function operation(value: Record<string, unknown>) {
  try {
    const exact = (...keys: string[]) => ritualObject(value, ["operation", "coupleId", ...keys]);
    const coupleId = cloudUuid(value.coupleId);
    switch (value.operation) {
      case "ritualList": {
        exact(...["after", "limit"].filter(k => Object.hasOwn(value, k)));
        const limit = value.limit === undefined ? 20 : value.limit;
        if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > RITUAL_LIMITS.pageMaximum) return invalid();
        return { operation: value.operation, coupleId, after: Object.hasOwn(value, "after") ? cloudUuid(value.after) : undefined, limit: limit as number } as const;
      }
      case "ritualCreate": exact("input"); return { operation: value.operation, coupleId, input: validateRitualInput(value.input) } as const;
      case "ritualUpgrade": exact("id", "expectedScheduledAt", "input"); return { operation: value.operation, coupleId, id: cloudUuid(value.id), expectedScheduledAt: cloudTimestamp(value.expectedScheduledAt), input: validateRitualEdit(value.input) } as const;
      case "ritualEdit": exact("id", "revision", "input"); return { operation: value.operation, coupleId, id: cloudUuid(value.id), revision: ritualRevision(value.revision), input: validateRitualEdit(value.input) } as const;
      case "ritualPause": case "ritualResume": case "ritualDelete":
        exact("id", "revision"); return { operation: value.operation, coupleId, id: cloudUuid(value.id), revision: ritualRevision(value.revision) } as const;
      case "ritualSetChannels": exact("id", "revision", "channels"); return { operation: value.operation, coupleId, id: cloudUuid(value.id), revision: ritualRevision(value.revision), channels: validateRitualChannels(value.channels) } as const;
      default: return invalid();
    }
  } catch { return invalid(); }
}
const publicErrors: Readonly<Record<string, readonly number[]>> = { access_denied: [401, 403], invalid_request: [400], conflict: [409], capacity: [409], schedule_changed: [409], no_future_occurrence: [409], rate_limited: [429], unavailable: [503] };

export function createMemoriesHandler(ports: RitualRequestPorts = { store: createRitualStore }, getEnv: () => Record<string, string | undefined> = () => process.env) {
  const activity = ports.activity ?? createActivityHandler(undefined, getEnv);
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
      const value = await readSmallJson(request);
      if (typeof value.operation !== "string" || !value.operation.startsWith("ritual")) {
        // Reconstruct only the already bounded body, without teeing an untrusted stream.
        const headers = new Headers(request.headers); headers.delete("content-length");
        return await activity(new Request(request.url, { method: "POST", headers, body: JSON.stringify(value), signal: request.signal }));
      }
      const input = operation(value), store = await ports.store(token, env);
      let result: unknown;
      switch (input.operation) {
        case "ritualList": result = parseRitualPage(await store.list(input.coupleId, input.after, input.limit), input.coupleId, input.after ?? null, input.limit); break;
        case "ritualCreate": result = parseRitualRow(await store.create(input.coupleId, input.input)); break;
        case "ritualUpgrade": result = parseRitualRow(await store.upgrade(input.coupleId, input.id, input.expectedScheduledAt, input.input)); break;
        case "ritualEdit": result = parseRitualRow(await store.edit(input.coupleId, input.id, input.revision, input.input)); break;
        case "ritualPause": result = parseRitualRow(await store.pause(input.coupleId, input.id, input.revision)); break;
        case "ritualResume": result = parseRitualRow(await store.resume(input.coupleId, input.id, input.revision)); break;
        case "ritualSetChannels": result = parseRitualRow(await store.setChannels(input.coupleId, input.id, input.revision, input.channels)); break;
        case "ritualDelete": {
          const row = ritualObject(await store.delete(input.coupleId, input.id, input.revision), ["id", "deleted", "revision"]);
          if (row.id !== input.id || row.deleted !== true || row.revision !== input.revision + 1) throw new Error("Invalid acknowledgement");
          result = { id: input.id, deleted: true, revision: input.revision + 1 }; break;
        }
      }
      if (new TextEncoder().encode(JSON.stringify(result)).length > RITUAL_LIMITS.responseBytes) throw new Error("Oversized response");
      return privateJson(result);
    } catch (error) {
      if (error instanceof RequestValidationError) return privateJson({ error: error.status === 403 ? "origin_denied" : error.status === 503 ? "unavailable" : "invalid_request" }, error.status);
      if (error instanceof RitualServerError && Object.hasOwn(publicErrors, error.code) && publicErrors[error.code].includes(error.status)) {
        const response = privateJson({ error: error.code }, error.status);
        if (error.status === 429) response.headers.set("Retry-After", String(Number.isInteger(error.retryAfterSeconds) && error.retryAfterSeconds! >= 1 && error.retryAfterSeconds! <= 60 ? error.retryAfterSeconds : 60));
        return response;
      }
      return privateJson({ error: "unavailable" }, 503);
    }
  };
}
