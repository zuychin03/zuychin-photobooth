import { createClient } from "@supabase/supabase-js";
import { cloudTimestamp, cloudUuid } from "../projects/cloud-contract";
import { RETAINED_STRIP_LIMITS, RetainedStripError, retainedObject, type RetainedAvailability } from "../memories/retained-strip-contract";
import { supabaseServiceOrigin } from "./cron-auth";
import type { ProjectStorePorts } from "./project-store";

export interface RetainedStripDescriptor { version: 1; id: string; ownerId: string; originalCoupleId: string | null; storagePath: string; availability: RetainedAvailability; archive: { publicId: string; url: string; verifiedAt: string } | null }
export function parseRetainedDescriptor(value: unknown, id: string): RetainedStripDescriptor {
  try {
    const v = retainedObject(value, ["version", "id", "ownerId", "originalCoupleId", "storagePath", "availability", "archive"]), ownerId = cloudUuid(v.ownerId);
    if (v.version !== 1 || cloudUuid(v.id) !== id || v.storagePath !== `${ownerId}/${id}.png` || !["available", "archive_pending", "archived"].includes(v.availability as string)) throw new Error();
    const originalCoupleId = v.originalCoupleId === null ? null : cloudUuid(v.originalCoupleId); let archive: RetainedStripDescriptor["archive"] = null;
    if (v.availability === "archived") {
      const a = retainedObject(v.archive, ["publicId", "url", "verifiedAt"]);
      if (a.publicId !== `zuychin-photobooth/${ownerId}/${id}` || typeof a.url !== "string" || a.url.length > 4096) throw new Error();
      const url = new URL(a.url); if (url.protocol !== "https:" || url.hostname !== "res.cloudinary.com" || url.port || url.username || url.password || url.search || url.hash) throw new Error();
      archive = { publicId: a.publicId, url: a.url, verifiedAt: cloudTimestamp(a.verifiedAt) };
    } else if (v.archive !== null) throw new Error();
    return { version: 1, id, ownerId, originalCoupleId, storagePath: v.storagePath as string, availability: v.availability as RetainedAvailability, archive };
  } catch { throw new RetainedStripError("unavailable"); }
}
export async function createRetainedStripStore(token: string, env: Record<string, string | undefined>, ports?: ProjectStorePorts, signal?: AbortSignal) {
  const origin = supabaseServiceOrigin(env.NEXT_PUBLIC_SUPABASE_URL), key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (env.PB_MEMORIES_ENABLED !== "true" || !origin || !key?.trim()) throw new RetainedStripError("unavailable");
  if (!token || token.length > 16384 || /[\s,]/.test(token)) throw new RetainedStripError("access_denied", 401);
  if (!ports) {
    const client = createClient(origin, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: (input, init) => fetch(input, { ...init, redirect: "error", cache: "no-store", signal: AbortSignal.any([AbortSignal.timeout(10000), ...(signal ? [signal] : []), ...(init?.signal ? [init.signal] : [])]) }) } });
    ports = { authenticate: async value => { const { data, error } = await client.auth.getUser(value); return error ? null : data.user?.id ?? null; }, rpc: async (name, args) => client.rpc(name, args) };
  }
  const actual = ports;
  const authenticate = async () => { try { return cloudUuid(await actual.authenticate(token)); } catch { throw new RetainedStripError("access_denied", 401); } };
  const actor = await authenticate();
  const rpc = async (name: string, args: Record<string, unknown> = {}) => {
    if (signal?.aborted) throw new RetainedStripError("cancelled", 408);
    const { data, error } = await actual.rpc(name, args);
    if (error) throw new RetainedStripError(error.message === "PB_RETAINED_DENIED" || error.message === "PB_MEMORY_DENIED" ? "access_denied" : "unavailable", error.message === "PB_RETAINED_DENIED" || error.message === "PB_MEMORY_DENIED" ? 403 : 503);
    return data;
  };
  const cap = retainedObject(await rpc("pb_retained_strip_capabilities"), ["version", "ready", "maximumBytes"]);
  if (cap.version !== 1 || cap.ready !== true || cap.maximumBytes !== RETAINED_STRIP_LIMITS.bytes) throw new RetainedStripError("unavailable");
  return {
    actor,
    async rate() {
      const value = retainedObject(await rpc("pb_project_rate", { p_actor: actor, p_operation: "read" }), ["allowed", "retryAfterSeconds"]);
      if (value.allowed === true && value.retryAfterSeconds === 0) return;
      if (value.allowed === false && Number.isInteger(value.retryAfterSeconds) && (value.retryAfterSeconds as number) >= 1 && (value.retryAfterSeconds as number) <= 60) throw new RetainedStripError("rate_limited", 429, value.retryAfterSeconds as number);
      throw new RetainedStripError("unavailable");
    },
    async resolve(id: string) {
      cloudUuid(id); if (await authenticate() !== actor) throw new RetainedStripError("access_denied", 401);
      return parseRetainedDescriptor(await rpc("pb_retained_strip_read", { p_actor: actor, p_id: id }), id);
    },
  };
}
export type RetainedStripStore = Awaited<ReturnType<typeof createRetainedStripStore>>;
