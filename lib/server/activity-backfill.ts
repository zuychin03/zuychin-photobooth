import { ACTIVITY_LIMITS } from "../memories/activity-contract";
import { supabaseServiceOrigin } from "./cron-auth";

export interface BackfillOptions { apply: boolean; batchSize: number; maxBatches: number; deadlineMs: number }
export const BACKFILL_DEFAULTS: Readonly<BackfillOptions> = Object.freeze({ apply: false, batchSize: 25, maxBatches: 10, deadlineMs: 60_000 });
export type BackfillStop = "dry_run" | "no_unlocked_work" | "batch_limit" | "deadline" | "interrupted" | "unavailable" | "uncertain";
export interface BackfillResult { mode: "dry_run" | "apply"; origin: string; stop: BackfillStop; acknowledgedBatches: number; processed: number; checkpoint: "server_activity_recorded_at" }
export class BackfillInputError extends Error { constructor() { super("Invalid backfill options or service configuration. No credentials are printed."); } }

export function parseBackfillOptions(args: readonly string[]): BackfillOptions {
  const options = { ...BACKFILL_DEFAULTS }, seen = new Set<string>();
  for (const arg of args) {
    const [key, value, extra] = arg.split("=");
    if (seen.has(key) || extra !== undefined) throw new BackfillInputError();
    seen.add(key);
    if (key === "--apply" && value === undefined) { options.apply = true; continue; }
    if (!value || !/^\d+$/.test(value)) throw new BackfillInputError();
    if (key === "--batch-size") options.batchSize = Number(value);
    else if (key === "--max-batches") options.maxBatches = Number(value);
    else if (key === "--deadline-ms") options.deadlineMs = Number(value);
    else throw new BackfillInputError();
  }
  validateOptions(options);
  return options;
}
function validateOptions(options: BackfillOptions) {
  if (typeof options.apply !== "boolean" || !Number.isInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > 100
    || !Number.isInteger(options.maxBatches) || options.maxBatches < 1 || options.maxBatches > 20
    || !Number.isInteger(options.deadlineMs) || options.deadlineMs < 1000 || options.deadlineMs > 120_000) throw new BackfillInputError();
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_response");
  return value as Record<string, unknown>;
}

export async function runActivityBackfill(
  options: BackfillOptions,
  env: Record<string, string | undefined>,
  ports: { fetch?: typeof fetch; now?: () => number; signal?: AbortSignal; progress?: (value: { acknowledgedBatches: number; processed: number }) => void } = {},
): Promise<BackfillResult> {
  validateOptions(options);
  const origin = supabaseServiceOrigin(env.NEXT_PUBLIC_SUPABASE_URL), key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!origin || !key || key.length < 16 || key.length > 16384 || /[\s,]/.test(key)) throw new BackfillInputError();
  const result: BackfillResult = { mode: options.apply ? "apply" : "dry_run", origin, stop: "dry_run", acknowledgedBatches: 0, processed: 0, checkpoint: "server_activity_recorded_at" };
  if (!options.apply) return result;
  const request = ports.fetch ?? fetch, now = ports.now ?? (() => performance.now()), end = now() + options.deadlineMs;
  let mutationOutstanding = false;
  const rpc = async (name: "pb_memory_capabilities" | "pb_memory_backfill", body: object) => {
    const remaining = end - now();
    if (remaining <= 0 || ports.signal?.aborted) throw new Error("stopped");
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), Math.min(10_000, remaining));
    const abort = () => controller.abort(); ports.signal?.addEventListener("abort", abort, { once: true });
    let rejectAbort: (() => void) | undefined;
    const cancelled = new Promise<never>((_, reject) => { rejectAbort = () => reject(new Error("stopped")); controller.signal.addEventListener("abort", rejectAbort, { once: true }); });
    const work = async () => {
      const url = `${origin}/rest/v1/rpc/${name}`;
      if (name === "pb_memory_backfill") mutationOutstanding = true;
      const response = await request(url, { method: "POST", headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body), redirect: "error", cache: "no-store", signal: controller.signal });
      const length = response.headers.get("content-length");
      if (controller.signal.aborted || !response.ok || response.redirected || response.url && response.url !== url
        || !/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")
        || length !== null && (!/^\d+$/.test(length) || Number(length) > 4096) || !response.body) {
        void response.body?.cancel().catch(() => undefined); throw new Error("invalid_response");
      }
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
      try {
        for (let count = 0; ; count++) {
          const next = await reader.read();
          if (controller.signal.aborted) throw new Error("stopped");
          if (next.done) break;
          bytes += next.value.byteLength;
          if (bytes > 4096 || count >= 128) throw new Error("invalid_response");
          chunks.push(next.value);
        }
        const joined = new Uint8Array(bytes); let offset = 0;
        for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
        return object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(joined)));
      } finally { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
    };
    try { return await Promise.race([work(), cancelled]); }
    finally { clearTimeout(timer); ports.signal?.removeEventListener("abort", abort); if (rejectAbort) controller.signal.removeEventListener("abort", rejectAbort); controller.abort(); }
  };
  try {
    if (ports.signal?.aborted) { result.stop = "interrupted"; return result; }
    const capability = await rpc("pb_memory_capabilities", {});
    if (capability.ready !== true || (["version", "detailLimit", "annotatedLimit", "chapterLimit", "pageLimit", "summaryTimezone"] as const).some(field => capability[field] !== ACTIVITY_LIMITS[field])) throw new Error("unavailable");
    while (result.acknowledgedBatches < options.maxBatches) {
      if (ports.signal?.aborted) { result.stop = "interrupted"; return result; }
      if (now() >= end) { result.stop = "deadline"; return result; }
      const batch = await rpc("pb_memory_backfill", { p_limit: options.batchSize });
      if (Object.keys(batch).length !== 1 || !Number.isInteger(batch.processed) || (batch.processed as number) < 0 || (batch.processed as number) > options.batchSize) throw new Error("invalid_response");
      mutationOutstanding = false; result.acknowledgedBatches++; result.processed += batch.processed as number;
      ports.progress?.({ acknowledgedBatches: result.acknowledgedBatches, processed: result.processed });
      if (batch.processed === 0) { result.stop = "no_unlocked_work"; return result; }
    }
    result.stop = "batch_limit"; return result;
  } catch {
    result.stop = mutationOutstanding ? "uncertain" : ports.signal?.aborted ? "interrupted" : now() >= end ? "deadline" : "unavailable";
    return result;
  }
}
