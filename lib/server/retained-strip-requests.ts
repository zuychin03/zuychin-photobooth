import { cloudUuid } from "../projects/cloud-contract";
import { RETAINED_STRIP_LIMITS, RetainedStripError, type RetainedStripResolution } from "../memories/retained-strip-contract";
import { privateJson } from "./cron-auth";
import { readSmallJson, requireSameOrigin, RequestValidationError } from "./request-security";
import { createRetainedStripStore, type RetainedStripStore } from "./retained-strip-store";
import { createRetainedStripObjects, type RetainedStripObjects } from "./retained-strip-objects";
import { verifyRetainedStrip } from "./image-finalise";

export interface RetainedStripRequestPorts {
  store(token: string, env: Record<string, string | undefined>, signal: AbortSignal): Promise<RetainedStripStore>;
  objects(env: Record<string, string | undefined>): RetainedStripObjects;
}
const production: RetainedStripRequestPorts = { store: (token, env, signal) => createRetainedStripStore(token, env, undefined, signal), objects: createRetainedStripObjects };
let activeReads = 0;
export function createRetainedStripHandler(ports: RetainedStripRequestPorts = production, getEnv: () => Record<string, string | undefined> = () => process.env) {
  return async (request: Request, sourceId: string): Promise<Response> => {
    const deadline = new AbortController(), signal = AbortSignal.any([request.signal, deadline.signal]); let stop!: () => void;
    const interrupted = new Promise<never>((_, reject) => { stop = () => reject(new RetainedStripError("timeout", 408)); signal.addEventListener("abort", stop, { once: true }); });
    const timer = setTimeout(() => deadline.abort(), RETAINED_STRIP_LIMITS.timeoutMs);
    const work = async () => {
      const env = getEnv();
      if (env.PB_MEMORIES_ENABLED !== "true") throw new RetainedStripError("unavailable");
      if (request.method !== "POST") throw new RetainedStripError("method_not_allowed", 405);
      const url = new URL(request.url), local = env.NODE_ENV === "development" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      if (url.protocol !== "https:" && !local) throw new RetainedStripError("unavailable");
      if (url.search) throw new RetainedStripError("invalid_request", 400);
      requireSameOrigin(request, env);
      let id: string; try { id = cloudUuid(sourceId); } catch { throw new RetainedStripError("invalid_request", 400); }
      const token = /^Bearer ([^\s,]+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
      if (!token || token.length > 16384) throw new RetainedStripError("access_denied", 401);
      const body = await readSmallJson(request);
      if (Object.keys(body).length !== 1 || !["resolve", "download"].includes(body.operation as string)) throw new RetainedStripError("invalid_request", 400);
      if (signal.aborted) throw new RetainedStripError("cancelled", 408);
      if (activeReads >= 2) throw new RetainedStripError("unavailable");
      activeReads++;
      try {
        const store = await ports.store(token, env, signal); await store.rate(); const before = await store.resolve(id);
        const bytes = await ports.objects(env).read(before, body.operation === "download", signal);
        const image = bytes === null ? null : await verifyRetainedStrip(bytes, { signal });
        if (body.operation === "download" && !image) throw new RetainedStripError("unavailable");
        const after = await store.resolve(id);
        if (JSON.stringify(before) !== JSON.stringify(after) || signal.aborted) throw new RetainedStripError("access_changed", 409);
        const resolution: RetainedStripResolution = { version: 1, id, availability: after.availability, bytesLimit: RETAINED_STRIP_LIMITS.bytes };
        if (!image) return privateJson(resolution);
        const headers = new Headers(privateJson({}).headers);
        headers.set("Content-Type", "image/png"); headers.set("Content-Length", String(image.original.length)); headers.set("Content-Disposition", `attachment; filename="strip-${id}.png"`);
        headers.set("X-Content-Type-Options", "nosniff"); headers.set("X-Strip-Id", id); headers.set("X-Strip-Version", "1"); headers.set("X-Strip-Availability", after.availability);
        headers.set("X-Strip-Sha256", image.verified.sha256); headers.set("X-Strip-Width", String(image.verified.width)); headers.set("X-Strip-Height", String(image.verified.height));
        return new Response(new Uint8Array(image.original), { headers });
      } finally { activeReads--; }
    };
    try { return await Promise.race([work(), interrupted]); }
    catch (error) {
      if (error instanceof RequestValidationError) return privateJson({ error: error.status === 403 ? "origin_denied" : "invalid_request" }, error.status);
      if (error instanceof RetainedStripError) { const response = privateJson({ error: ["invalid_request", "access_denied", "unavailable", "source_unavailable", "access_changed", "rate_limited", "timeout", "cancelled", "method_not_allowed"].includes(error.code) ? error.code : "unavailable" }, error.status); if (error.status === 429) response.headers.set("Retry-After", String(error.retryAfterSeconds && error.retryAfterSeconds >= 1 && error.retryAfterSeconds <= 60 ? error.retryAfterSeconds : 60)); return response; }
      return privateJson({ error: "unavailable" }, 503);
    } finally { clearTimeout(timer); signal.removeEventListener("abort", stop); deadline.abort(); }
  };
}
