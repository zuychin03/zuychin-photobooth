import { supabaseServiceOrigin } from "./cron-auth";

export interface AdmissionOptions { apply: boolean; action: "status" | "pause" | "resume"; revision: number | null }
export interface AdmissionState { version: 1; paused: boolean; revision: number }
export function parseAdmissionOptions(args: readonly string[]): AdmissionOptions {
  const result: AdmissionOptions = { apply: false, action: "status", revision: null }, seen = new Set<string>();
  for (const arg of args) {
    const [key, value] = arg.split("=");
    if (seen.has(key)) throw new Error("Invalid options"); seen.add(key);
    if (arg === "--apply") result.apply = true;
    else if (key === "--action" && ["status", "pause", "resume"].includes(value) && arg === `${key}=${value}`) result.action = value as AdmissionOptions["action"];
    else if (key === "--expected-revision" && /^(0|[1-9][0-9]{0,9})$/.test(value ?? "") && Number(value) <= 2147483647 && arg === `${key}=${value}`) result.revision = Number(value);
    else throw new Error("Invalid options");
  }
  if (result.action === "status" ? result.revision !== null : result.revision === null) throw new Error("Expected revision required for mutation");
  return result;
}
export function parseAdmissionState(value: unknown): AdmissionState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Unavailable control");
  const b = value as Record<string, unknown>;
  if (Object.keys(b).sort().join() !== "paused,revision,version" || b.version !== 1 || typeof b.paused !== "boolean" || !Number.isSafeInteger(b.revision) || Number(b.revision) < 0 || Number(b.revision) > 2147483647) throw new Error("Unavailable control");
  return b as unknown as AdmissionState;
}
export async function runEventAdmission(options: AdmissionOptions, env: Record<string, string | undefined>, ports: { fetch?: typeof fetch; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<{ mode: "dry_run"; configured: boolean; action: string } | { mode: "applied"; state: AdmissionState }> {
  const origin = supabaseServiceOrigin(env.NEXT_PUBLIC_SUPABASE_URL), key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (origin?.startsWith("http:") && env.NODE_ENV !== "development") throw new Error("Invalid origin");
  const configured = Boolean(origin && key?.trim());
  if (!options.apply) return { mode: "dry_run", configured, action: options.action };
  if (!configured || !origin || !key) throw new Error("Missing configuration");
  const timeoutMs = ports.timeoutMs ?? 10000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) throw new Error("Invalid timeout");
  const abort = new AbortController(), signal = ports.signal ? AbortSignal.any([ports.signal, abort.signal]) : abort.signal;
  let listener: (() => void) | undefined;
  const interrupted = new Promise<never>((_, reject) => { listener = () => reject(new Error("Admission result unconfirmed")); signal.addEventListener("abort", listener, { once: true }); if (signal.aborted) listener(); });
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  const work = async () => {
    if (signal.aborted) throw new Error("Cancelled");
    const endpoint = `${origin}/rest/v1/rpc/pb_event_admission_control`;
    const response = await (ports.fetch ?? fetch)(endpoint, { method: "POST", headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ p_paused: options.action === "status" ? null : options.action === "pause", p_expected_revision: options.revision }), redirect: "error", cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer", signal });
    if (signal.aborted || !response.ok || response.redirected || response.url && response.url !== endpoint || !/^application\/json(?:;|$)/i.test(response.headers.get("content-type") ?? "")) { void response.body?.cancel().catch(() => {}); throw new Error("Admission result unconfirmed"); }
    const reader = response.body?.getReader(), chunks: Uint8Array[] = []; let size = 0;
    const cancel = () => { void reader?.cancel().catch(() => {}); }; signal.addEventListener("abort", cancel, { once: true });
    try { if (!reader) throw new Error("Missing response"); for (;;) { const part = await reader.read(); if (signal.aborted) throw new Error("Cancelled"); if (part.done) break; size += part.value.length; if (size > 4096 || chunks.length >= 64) throw new Error("Invalid response"); chunks.push(part.value); } }
    finally { signal.removeEventListener("abort", cancel); if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); } }
    const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const state = parseAdmissionState(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    if (options.action !== "status" && (state.paused !== (options.action === "pause") || state.revision < options.revision! || state.revision > options.revision! + 1)) throw new Error("Admission result unconfirmed");
    return { mode: "applied" as const, state };
  };
  try { return await Promise.race([work(), interrupted]); } finally { clearTimeout(timer); if (listener) signal.removeEventListener("abort", listener); abort.abort(); }
}
