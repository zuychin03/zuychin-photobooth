import { open } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const CANONICAL = "https://photobooth.zuychin.me";
const MAX = { requests: 2000, concurrency: 10, wallMs: 300000, uploadBytes: 20 * 1024 * 1024, downloadBytes: 64 * 1024 * 1024 };
const UUID = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const PROFILE = { profile: "http-only-prepared-fixtures", cadence: "burst-only-no-pacing", scaling: "repeats-existing-identities", excludes: ["camera", "TURN", "provider-CPU", "database-capacity", "cohort-acceptance"] };
const invalid = () => { throw new Error("invalid_scenario"); };
function object(value) { if (!value || typeof value !== "object" || Array.isArray(value)) invalid(); return value; }
function keys(value, required, optional = []) {
  object(value);
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => ![...required, ...optional].includes(key))) invalid();
}
function integer(value, max, min = 1) { if (!Number.isSafeInteger(value) || value < min || value > max) invalid(); }
function jsonValue(value, depth = 0) {
  if (depth > 8) invalid();
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") { if (!Number.isFinite(value)) invalid(); return; }
  if (typeof value === "string") { if (value.length > 4096) invalid(); return; }
  if (Array.isArray(value)) { if (value.length > 100) invalid(); value.forEach(v => jsonValue(v, depth + 1)); return; }
  object(value); if (Object.keys(value).length > 100) invalid();
  for (const [key, child] of Object.entries(value)) { if (["__proto__", "constructor", "prototype"].includes(key)) invalid(); jsonValue(child, depth + 1); }
}
function targetOrigin(value) {
  if (value === CANONICAL) return value;
  try {
    const url = new URL(value);
    if (url.origin !== value || url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) || !url.port || Number(url.port) < 1024) invalid();
    return value;
  } catch { return invalid(); }
}
function permitted(step) {
  if (step.method === "GET") return ["/", "/booth", "/templates", "/offline.html", "/manifest.webmanifest", "/api/rooms/capabilities"].includes(step.path);
  if (new RegExp(`^/api/rooms/${UUID}/state$`).test(step.path)) return !Object.keys(step.json ?? {}).length && !Object.keys(step.jsonEnv ?? {}).length;
  if (new RegExp(`^/api/rooms/${UUID}/(?:poll|signal)$`).test(step.path)) return !Object.hasOwn(step.json ?? {}, "operation");
  const op = step.json?.operation;
  if (step.path === "/api/projects") return ["capabilities", "list", "view", "read", "status", "reserve", "upload", "finalise"].includes(op);
  if (step.path === "/api/events") return op === "capabilities";
  if (new RegExp(`^/api/events/${UUID}$`).test(step.path)) return ["dashboard", "settings"].includes(op);
  if (new RegExp(`^/api/events/${UUID}/guest$`).test(step.path)) return ["context", "reserve", "reserveMission", "upload", "finalise"].includes(op);
  if (new RegExp(`^/api/events/${UUID}/receipts/${UUID}$`).test(step.path)) return ["read", "media"].includes(op);
  if (new RegExp(`^/api/events/${UUID}/(?:gallery|wall)$`).test(step.path)) return ["capabilities", "list", "validate", "access", "media"].includes(op);
  return false;
}
export function validateScenario(input) {
  keys(input, ["version", "target", "budgets", "actors"]);
  if (input.version !== 1) invalid(); targetOrigin(input.target);
  keys(input.budgets, Object.keys(MAX));
  for (const [key, max] of Object.entries(MAX)) integer(input.budgets[key], max);
  if (!Array.isArray(input.actors) || !input.actors.length || input.actors.length > 100) invalid();
  let steps = 0;
  for (const actor of input.actors) {
    keys(actor, ["steps"]);
    if (!Array.isArray(actor.steps) || !actor.steps.length || actor.steps.length > 20) invalid();
    for (const step of actor.steps) {
      keys(step, ["method", "path", "expectedStatuses", "timeoutMs", "responseBytes"], ["json", "jsonEnv", "headersEnv"]);
      if (!["GET", "POST"].includes(step.method) || typeof step.path !== "string" || !/^\/[A-Za-z0-9/_.,-]*$/.test(step.path) || step.path.includes("..") || step.path.includes("//")) invalid();
      if (step.method === "GET" && (step.json !== undefined || step.jsonEnv !== undefined)) invalid();
      if (step.json !== undefined) { object(step.json); jsonValue(step.json); if (Buffer.byteLength(JSON.stringify(step.json)) > 65536) invalid(); }
      if (!permitted(step)) invalid();
      if (!Array.isArray(step.expectedStatuses) || !step.expectedStatuses.length || step.expectedStatuses.length > 8 || new Set(step.expectedStatuses).size !== step.expectedStatuses.length) invalid();
      step.expectedStatuses.forEach(status => integer(status, 599, 200));
      integer(step.timeoutMs, 10000); integer(step.responseBytes, 2 * 1024 * 1024);
      for (const kind of ["headersEnv", "jsonEnv"]) {
        if (step[kind] === undefined) continue;
        object(step[kind]); if (Object.keys(step[kind]).length > 8) invalid();
        for (const [key, variable] of Object.entries(step[kind])) {
          if (typeof variable !== "string" || !/^[A-Z][A-Z0-9_]{0,79}$/.test(variable)) invalid();
          if (kind === "headersEnv" ? !["authorization", "cookie"].includes(key) : !/^[a-zA-Z][a-zA-Z0-9]{0,63}$/.test(key) || ["operation", "action", "constructor", "prototype"].includes(key)) invalid();
        }
      }
      steps++;
    }
  }
  if (steps > 400) invalid();
  return structuredClone(input);
}
function plan(input, scale) {
  const steps = input.actors.flatMap(actor => actor.steps);
  const requests = steps.length * scale;
  return { scale, journeys: input.actors.length * scale, distinctConfiguredActors: input.actors.length, requests, configuredResponseCeilingBytes: steps.reduce((n, step) => n + step.responseBytes, 0) * scale, withinRequestBudget: requests <= input.budgets.requests, ceilings: { ...input.budgets }, unresolvedEnvironment: steps.some(step => Object.keys(step.headersEnv ?? {}).length || Object.keys(step.jsonEnv ?? {}).length) };
}
function resolveSteps(input, env) {
  return input.actors.map(actor => actor.steps.map(step => {
    const headers = { origin: input.target }, json = { ...step.json };
    for (const [key, name] of Object.entries(step.headersEnv ?? {})) {
      const value = env[name];
      if (typeof value !== "string" || !value.length || value.length > 16384 || /[^\x20-\x7e]/.test(value)) throw new Error("invalid_environment");
      headers[key] = value;
    }
    for (const [key, name] of Object.entries(step.jsonEnv ?? {})) {
      const value = env[name];
      if (typeof value !== "string" || !value.length || value.length > 65536) throw new Error("invalid_environment");
      json[key] = value;
    }
    const body = step.method === "POST" ? JSON.stringify(json) : undefined;
    if (body !== undefined) headers["content-type"] = "application/json";
    const bytes = body === undefined ? 0 : Buffer.byteLength(body);
    if (bytes > 128 * 1024) throw new Error("invalid_environment");
    return { ...step, headers, body, bytes };
  }));
}
export async function runScenario(raw, options = {}) {
  const input = validateScenario(raw), plans = [1, 2, 5].map(scale => plan(input, scale));
  if (!options.execute) return { version: 1, mode: "dry-run", ...PROFILE, plans };
  if (options.confirmTarget !== input.target) throw new Error("target_confirmation_required");
  const scale = options.scale ?? 1; if (![1, 2, 5].includes(scale)) invalid();
  const actors = resolveSteps(input, options.env ?? process.env), planned = plan(input, scale);
  const report = { version: 1, mode: "execute", ...PROFILE, scale, plannedRequests: planned.requests, distinctConfiguredActors: actors.length, requests: 0, completed: 0, statuses: {}, bytes: { upload: 0, download: 0 }, durationMs: 0, latencyScope: "completed-responses", latencyMs: { p50: 0, p95: 0, max: 0 }, stop: "complete" };
  if (!planned.withinRequestBudget || actors.flat().reduce((n, step) => n + step.bytes, 0) * scale > input.budgets.uploadBytes) return { ...report, stop: "planned_budget" };
  const global = new AbortController(), started = performance.now(), latencies = [], transport = options.fetch ?? fetch;
  const stop = code => { if (!global.signal.aborted) { report.stop = code; global.abort(); } };
  const timer = setTimeout(() => stop("wall_timeout"), input.budgets.wallMs);
  const onCancel = () => stop("cancelled"); options.signal?.addEventListener("abort", onCancel, { once: true });
  if (options.signal?.aborted) stop("cancelled");
  let cursor = 0;
  async function request(step) {
    if (global.signal.aborted) return;
    if (report.requests >= input.budgets.requests || report.bytes.upload + step.bytes > input.budgets.uploadBytes) return stop("request_budget");
    report.requests++; report.bytes.upload += step.bytes;
    const begun = performance.now(), timeout = setTimeout(() => stop("request_timeout"), step.timeoutMs);
    let response, reader, interrupt;
    const cancelled = new Promise(resolve => { interrupt = resolve; global.signal.addEventListener("abort", interrupt, { once: true }); });
    const work = (async () => {
      try {
        response = await transport(`${input.target}${step.path}`, { method: step.method, headers: step.headers, body: step.body, signal: global.signal, redirect: "manual", cache: "no-store", credentials: "omit" });
        if (global.signal.aborted) return;
        report.statuses[response.status] = (report.statuses[response.status] ?? 0) + 1;
        if (response.redirected || response.status >= 300 && response.status < 400) return stop("redirect");
        if (response.url && response.url !== `${input.target}${step.path}`) return stop("response_target");
        if ([401, 403].includes(response.status)) return stop("auth_failure");
        if (!step.expectedStatuses.includes(response.status)) return stop("unexpected_status");
        const length = response.headers.get("content-length");
        const encoded = Boolean(response.headers.get("content-encoding")?.trim() && response.headers.get("content-encoding")?.trim().toLowerCase() !== "identity");
        if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) return stop("invalid_length");
        if (!encoded && length !== null && Number(length) > step.responseBytes) return stop("response_budget");
        if (!encoded && length !== null && Number(length) > input.budgets.downloadBytes - report.bytes.download) return stop("download_budget");
        let bytes = 0, chunks = 0;
        reader = response.body?.getReader();
        if (reader) for (;;) {
          const next = await reader.read(); if (global.signal.aborted) return; if (next.done) break;
          bytes += next.value.byteLength; report.bytes.download += next.value.byteLength;
          if (report.bytes.download > input.budgets.downloadBytes) return stop("download_budget");
          if (bytes > step.responseBytes || ++chunks > 4096) return stop("response_budget");
        }
        if (!encoded && length !== null && Number(length) !== bytes) return stop("length_mismatch");
        report.completed++; latencies.push(performance.now() - begun);
      } catch { if (!global.signal.aborted) stop("transport_failure"); }
      finally { if (reader) { void reader.cancel().catch(() => {}); } else void response?.body?.cancel().catch(() => {}); }
    })();
    try { await Promise.race([work, cancelled]); }
    finally { clearTimeout(timeout); global.signal.removeEventListener("abort", interrupt); }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(input.budgets.concurrency, planned.journeys) }, async () => {
      while (!global.signal.aborted) {
        const index = cursor++; if (index >= planned.journeys) return;
        for (const step of actors[index % actors.length]) { if (global.signal.aborted) return; await request(step); }
      }
    }));
  } finally { clearTimeout(timer); options.signal?.removeEventListener("abort", onCancel); }
  latencies.sort((a, b) => a - b);
  const percentile = n => Math.round(latencies[Math.max(0, Math.ceil(latencies.length * n) - 1)] ?? 0);
  report.latencyMs = { p50: percentile(0.5), p95: percentile(0.95), max: percentile(1) };
  report.durationMs = Math.round(performance.now() - started);
  return report;
}

export async function main(args = process.argv.slice(2)) {
  try {
    const flags = new Map();
    for (const arg of args) {
      const match = /^--(scenario|confirm-target|scale)=(.+)$/.exec(arg);
      const key = match?.[1] ?? (arg === "--execute" ? "execute" : arg === "--help" ? "help" : null);
      if (!key || flags.has(key)) invalid(); flags.set(key, match?.[2] ?? true);
    }
    if (flags.has("help")) { console.log("--scenario=FILE [--scale=1|2|5] [--execute --confirm-target=ORIGIN]. Default: dry-run; no environment values or network. HTTP-only prepared fixtures; repeated identities, no browser/provider downloads or retries."); return 0; }
    if (!flags.has("scenario")) invalid();
    const file = await open(flags.get("scenario"), "r"); let bytes;
    try { if ((await file.stat()).size > 128 * 1024) invalid(); bytes = Buffer.alloc(128 * 1024 + 1); const read = await file.read(bytes); if (read.bytesRead > 128 * 1024) invalid(); bytes = bytes.subarray(0, read.bytesRead); } finally { await file.close(); }
    const scale = flags.has("scale") ? Number(flags.get("scale")) : 1; if (![1, 2, 5].includes(scale)) invalid();
    const signal = new AbortController(), cancel = () => signal.abort(); process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
    try {
      const result = await runScenario(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), { execute: flags.has("execute"), confirmTarget: flags.get("confirm-target"), scale, signal: signal.signal });
      console.log(JSON.stringify(result)); return result.stop && result.stop !== "complete" ? 1 : 0;
    } finally { process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); }
  } catch { console.log(JSON.stringify({ version: 1, error: "configuration_or_input_failed" })); return 1; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
