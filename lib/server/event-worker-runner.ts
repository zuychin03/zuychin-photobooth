export interface EventRunnerOptions { apply: boolean; maxPasses: number; deadlineMs: number }
export function parseEventRunnerOptions(args: readonly string[]): EventRunnerOptions {
  const result = { apply: false, maxPasses: 3, deadlineMs: 300000 }, seen = new Set<string>();
  for (const arg of args) {
    const [key, raw, extra] = arg.split("=");
    if (seen.has(key) || extra !== undefined) throw new Error("Invalid options"); seen.add(key);
    if (key === "--apply" && raw === undefined) result.apply = true;
    else if (["--max-passes", "--deadline-ms"].includes(key) && raw && /^\d+$/.test(raw)) {
      const value = Number(raw), max = key === "--max-passes" ? 3 : 300000;
      if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error("Invalid bounds");
      if (key === "--max-passes") result.maxPasses = value; else result.deadlineMs = value;
    } else throw new Error("Invalid options");
  }
  return result;
}
export interface EventRunnerResult { stop: "dry_run" | "idle" | "pass_limit" | "deadline" | "cancelled" | "retry" | "refused"; passes: number; completed: number; expired: number; configured?: boolean }
export async function runEventWorker(options: EventRunnerOptions, env: Record<string, string | undefined>, ports: { fetch?: typeof fetch; signal?: AbortSignal; now?: () => number } = {}): Promise<EventRunnerResult> {
  if (typeof options.apply !== "boolean" || !Number.isSafeInteger(options.maxPasses) || options.maxPasses < 1 || options.maxPasses > 3 || !Number.isSafeInteger(options.deadlineMs) || options.deadlineMs < 1 || options.deadlineMs > 300000) throw new Error("Invalid bounds");
  let origin: URL | undefined;
  if (env.PB_PUBLIC_ORIGIN) {
    origin = new URL(env.PB_PUBLIC_ORIGIN);
    if (origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash || origin.protocol !== "https:" && !(env.NODE_ENV === "development" && origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))) throw new Error("Invalid origin");
  }
  const secret = env.CRON_SECRET, configured = !!origin && !!secret?.trim() && !/[\r\n]/.test(secret) && env.PB_EVENTS_ENABLED === "true";
  const result: EventRunnerResult = { stop: "dry_run", passes: 0, completed: 0, expired: 0 };
  if (!options.apply) return { ...result, configured };
  if (!configured) throw new Error("Missing worker configuration");
  const endpoint = `${origin!.origin}/api/events/maintenance`, now = ports.now ?? Date.now, deadline = now() + options.deadlineMs;
  for (let n = 0; n < options.maxPasses; n++) {
    if (ports.signal?.aborted) return { ...result, stop: "cancelled" };
    if (now() >= deadline) return { ...result, stop: "deadline" };
    const abort = new AbortController(), signal = ports.signal ? AbortSignal.any([ports.signal, abort.signal]) : abort.signal;
    let timer: ReturnType<typeof setTimeout> | undefined, onAbort: (() => void) | undefined;
    const interrupted = new Promise<never>((_, reject) => { onAbort = () => reject(new Error("Stopped")); signal.addEventListener("abort", onAbort, { once: true }); timer = setTimeout(() => abort.abort(), Math.min(95000, deadline - now())); });
    const work = async () => {
      const response = await (ports.fetch ?? fetch)(endpoint, { method: "GET", headers: { Authorization: `Bearer ${secret}` }, redirect: "error", cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer", signal });
      if (signal.aborted || response.redirected || response.url && response.url !== endpoint) { void response.body?.cancel(); throw new Error("Refused response"); }
      if (response.status !== 200) { void response.body?.cancel(); return { stop: response.status === 409 || response.status === 503 ? "retry" : "refused" } as const; }
      const length = response.headers.get("content-length");
      if (!/^application\/json(?:;|$)/i.test(response.headers.get("content-type") ?? "") || length !== null && (!/^\d+$/.test(length) || Number(length) > 4096)) { void response.body?.cancel(); throw new Error("Invalid response"); }
      const reader = response.body?.getReader(), chunks: Uint8Array[] = []; let size = 0;
      const cancel = () => { void reader?.cancel().catch(() => undefined); }; signal.addEventListener("abort", cancel, { once: true });
      try { if (reader) while (true) { const item = await reader.read(); if (signal.aborted) throw new Error("Stopped"); if (item.done) break; size += item.value.length; if (size > 4096 || chunks.length >= 64) throw new Error("Invalid response"); chunks.push(item.value); } }
      finally { signal.removeEventListener("abort", cancel); if (reader) { void reader.cancel().catch(() => undefined); reader.releaseLock(); } }
      const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Record<string, unknown>;
      if (!value || typeof value !== "object" || Object.keys(value).sort().join() !== ["expired", "job", "workerReady"].sort().join() || !Number.isSafeInteger(value.expired) || Number(value.expired) < 0 || Number(value.expired) > 25 || !["idle", "ready", "candidate", "deleted"].includes(String(value.job)) || value.workerReady !== true) throw new Error("Invalid response");
      return { stop: value.job === "idle" ? "idle" : null, expired: Number(value.expired), completed: value.job === "idle" ? 0 : 1 } as const;
    };
    try {
      const pass = await Promise.race([work(), interrupted]); if (signal.aborted) return { ...result, stop: ports.signal?.aborted ? "cancelled" : "deadline" };
      if (pass.stop === "retry" || pass.stop === "refused") return { ...result, stop: pass.stop };
      if (typeof pass.expired !== "number" || typeof pass.completed !== "number") return { ...result, stop: "refused" };
      result.passes++; result.expired += pass.expired; result.completed += pass.completed;
      if (pass.stop === "idle") return { ...result, stop: "idle" };
    } catch { return { ...result, stop: signal.aborted ? ports.signal?.aborted ? "cancelled" : "deadline" : "refused" }; }
    finally { clearTimeout(timer); if (onAbort) signal.removeEventListener("abort", onAbort); abort.abort(); }
  }
  return { ...result, stop: "pass_limit" };
}
