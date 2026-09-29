import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { runScenario, validateScenario } from "./deployment-load-harness.mjs";

const target = "https://photobooth.zuychin.me";
const limits = { requests: 100, concurrency: 2, wallMs: 2000, uploadBytes: 100000, downloadBytes: 100000 };
const step = (extra = {}) => ({ method: "POST", path: "/api/projects", json: { operation: "view", projectId: "synthetic" }, expectedStatuses: [200], timeoutMs: 500, responseBytes: 1000, ...extra });
const scenario = (origin = target, steps = [step()], budgets = {}) => ({ version: 1, target: origin, budgets: { ...limits, ...budgets }, actors: [{ steps }] });
async function local(handler) {
  const server = createServer(handler);
  server.on("clientError", (_error, socket) => socket.destroy());
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

test("dry-run plans 1/2/5 scales without resolving environment or contacting transport", async () => {
  const input = scenario(target, [step({ headersEnv: { authorization: "LOAD_TOKEN" }, jsonEnv: { projectId: "LOAD_PROJECT" } })]);
  const result = await runScenario(input, { env: new Proxy({}, { get() { throw new Error("env was read"); } }), fetch: () => { throw new Error("network was used"); } });
  assert.equal(result.mode, "dry-run"); assert.equal(result.profile, "http-only-prepared-fixtures");
  assert.deepEqual(result.plans.map(p => [p.scale, p.requests, p.journeys]), [[1, 1, 1], [2, 2, 2], [5, 5, 5]]);
  assert.equal(result.plans[2].distinctConfiguredActors, 1);
  assert.equal(result.scaling, "repeats-existing-identities");
});

test("configuration rejects unknown fields, arbitrary targets, traversal and administrative operations", () => {
  for (const origin of ["https://evil.test", `${target}/`, `${target}:443`, "http://photobooth.zuychin.me", "http://127.0.0.2:3000", "http://user@127.0.0.1:3000"]) assert.throws(() => validateScenario(scenario(origin)));
  const badSteps = [
    step({ method: "DELETE" }), step({ path: "//evil.test/x" }), step({ path: "/api/../api/projects" }), step({ path: "/api/%2e%2e/projects" }),
    step({ path: "/api/projects#token=x" }), step({ path: "/api/projects?operation=delete" }), step({ path: "/api/projects\\delete" }),
    step({ path: "/api/events/maintenance" }), step({ path: "/api/reminders" }), step({ path: "/auth/callback" }),
    ...["delete", "member", "invite", "revoke", "create", "session", "manage", "withdraw"].map(operation => step({ json: { operation } })),
    step({ jsonEnv: { operation: "OP" } }), step({ headersEnv: { host: "HOST" } }), step({ retry: 2 }), step({ timeoutMs: 0 }), step({ responseBytes: 99999999 }),
  ];
  for (const bad of badSteps) assert.throws(() => validateScenario(scenario(target, [bad])));
  assert.throws(() => validateScenario({ ...scenario(), schedules: [] }));
  assert.throws(() => validateScenario(scenario(target, [step()], { concurrency: 11 })));
});

test("execute requires exact target confirmation and preflights every secret before any request", async () => {
  let calls = 0;
  const ports = { execute: true, fetch: async () => { calls++; throw new Error("not reached"); } };
  await assert.rejects(runScenario(scenario(), ports));
  await assert.rejects(runScenario(scenario(), { ...ports, confirmTarget: "https://evil.test" }));
  const input = scenario(target, [step(), step({ headersEnv: { authorization: "MISSING" } })]);
  await assert.rejects(runScenario(input, { ...ports, confirmTarget: target, env: {} }));
  assert.equal(calls, 0);
});

test("actual loopback HTTP preserves sequential journey dependencies and bounds scaled concurrency", async () => {
  let active = 0, maximum = 0; const seen = [], byActor = new Map();
  const f = await local(async (req, res) => {
    active++; maximum = Math.max(maximum, active);
    let body = ""; for await (const chunk of req) body += chunk;
    const value = JSON.parse(body), actor = req.headers.authorization;
    assert.equal(req.headers.origin, f.origin);
    if (value.phase === 2) assert(byActor.get(actor) >= 1);
    if (value.phase === 1) byActor.set(actor, (byActor.get(actor) ?? 0) + 1);
    seen.push(value.phase); await new Promise(resolve => setTimeout(resolve, 15));
    res.writeHead(200, { "content-type": "application/json" }); res.end('{"private":"discarded"}'); active--;
  });
  try {
    const input = scenario(f.origin, [step({ json: { operation: "view", phase: 1 }, headersEnv: { authorization: "ACTOR" } }), step({ json: { operation: "status", phase: 2 }, headersEnv: { authorization: "ACTOR" } })]);
    const result = await runScenario(input, { execute: true, confirmTarget: f.origin, scale: 5, env: { ACTOR: "synthetic-private-actor" } });
    assert.equal(result.stop, "complete"); assert.equal(result.requests, 10); assert.equal(result.completed, 10);
    assert.equal(result.statuses[200], 10); assert.equal(seen.length, 10); assert(maximum <= 2); assert(maximum > 1);
    assert(result.bytes.upload > 0 && result.bytes.download > 0); assert(result.latencyMs.p95 >= result.latencyMs.p50);
    assert(!JSON.stringify(result).includes("synthetic-private-actor")); assert(!JSON.stringify(result).includes("discarded"));
  } finally { await f.close(); }
});

test("request and upload ceilings refuse execution before network rather than truncate actor journeys", async () => {
  let calls = 0; const fetch = async () => { calls++; throw new Error("unused"); };
  for (const budget of [{ requests: 1 }, { uploadBytes: 1 }]) {
    const result = await runScenario(scenario(target, [step()], budget), { execute: true, confirmTarget: target, scale: 2, fetch });
    assert.equal(result.stop, "planned_budget");
  }
  assert.equal(calls, 0);
});

test("global download ceiling aborts streaming and prevents dependent requests", async () => {
  let calls = 0;
  const f = await local((_req, res) => { calls++; res.writeHead(200); res.write("123456"); const timer = setInterval(() => res.write("123456"), 10); res.on("close", () => clearInterval(timer)); });
  try {
    const result = await runScenario(scenario(f.origin, [step(), step()], { concurrency: 1, downloadBytes: 10 }), { execute: true, confirmTarget: f.origin });
    assert.equal(result.stop, "download_budget"); assert.equal(calls, 1); assert(result.bytes.download > 10); assert.equal(result.bytes.download % 6, 0);
  } finally { await f.close(); }
});

test("per-request and global deadlines abort stalled HTTP with no retries", async () => {
  let calls = 0;
  const f = await local(() => { calls++; });
  try {
    for (const [timeoutMs, wallMs, expected] of [[30, 1000, "request_timeout"], [500, 40, "wall_timeout"]]) {
      const result = await runScenario(scenario(f.origin, [step({ timeoutMs }), step()], { wallMs }), { execute: true, confirmTarget: f.origin });
      assert.equal(result.stop, expected); assert.equal(result.requests, 1);
    }
    assert.equal(calls, 2);
  } finally { await f.close(); }
});

test("redirect and authentication failures abort globally even when listed as expected", async () => {
  for (const status of [302, 401, 403]) {
    let calls = 0;
    const f = await local((_req, res) => { calls++; res.writeHead(status, { location: "http://127.0.0.1:1/private?token=not-logged" }); res.end("private failure payload"); });
    try {
      const result = await runScenario(scenario(f.origin, [step({ expectedStatuses: [status] }), step()], { concurrency: 1 }), { execute: true, confirmTarget: f.origin });
      assert.equal(result.stop, status === 302 ? "redirect" : "auth_failure"); assert.equal(calls, 1);
      assert(!JSON.stringify(result).includes("private"));
    } finally { await f.close(); }
  }
});

test("transport exceptions and response payloads cannot leak secrets into receipts", async () => {
  const result = await runScenario(scenario(target), { execute: true, confirmTarget: target, fetch: async () => { throw new Error("Bearer private-secret https://private.test/token"); } });
  assert.equal(result.stop, "transport_failure"); assert(!JSON.stringify(result).includes("private-secret"));
});

test("declared oversized responses stop before body consumption while expected saturation stays measurable", async () => {
  let calls = 0;
  const f = await local((_req, res) => {
    calls++;
    if (calls === 1) { res.writeHead(503); res.end("temporarily unavailable"); }
    else { res.writeHead(200, { "content-length": "9000000" }); res.flushHeaders(); }
  });
  try {
    const result = await runScenario(scenario(f.origin, [step({ expectedStatuses: [503] }), step(), step()]), { execute: true, confirmTarget: f.origin });
    assert.equal(result.stop, "response_budget"); assert.equal(result.completed, 1); assert.equal(calls, 2);
    assert.deepEqual(result.statuses, { 200: 1, 503: 1 }); assert.equal(result.bytes.download, Buffer.byteLength("temporarily unavailable"));
  } finally { await f.close(); }
});

test("external cancellation stops a run and discards late transport responses without changing its receipt", async () => {
  let release, started; const ready = new Promise(resolve => { started = resolve; });
  const signal = new AbortController(); let cancelled = false;
  const pending = runScenario(scenario(target), { execute: true, confirmTarget: target, signal: signal.signal, fetch: () => { started(); return new Promise(resolve => { release = resolve; }); } });
  await ready; signal.abort(); const result = await pending, snapshot = JSON.stringify(result);
  assert.equal(result.stop, "cancelled"); assert.equal(result.requests, 1);
  release(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert(cancelled); assert.equal(JSON.stringify(result), snapshot);
});

test("compressed HTTP responses count decoded bytes without comparing them to compressed Content-Length", async () => {
  const decoded = "synthetic page ".repeat(200), encoded = gzipSync(decoded);
  const f = await local((_req, res) => { res.writeHead(200, { "content-encoding": "gzip", "content-length": String(encoded.length) }); res.end(encoded); });
  try {
    const input = scenario(f.origin, [step({ method: "GET", path: "/", json: undefined, responseBytes: 5000 })]);
    const result = await runScenario(input, { execute: true, confirmTarget: f.origin });
    assert.equal(result.stop, "complete"); assert.equal(result.bytes.download, Buffer.byteLength(decoded));
    const bounded = await runScenario(scenario(f.origin, [step({ responseBytes: 1000 })]), { execute: true, confirmTarget: f.origin });
    assert.equal(bounded.stop, "response_budget"); assert.equal(bounded.bytes.download, Buffer.byteLength(decoded));
  } finally { await f.close(); }
});

test("prepared-room HTTP actions are permitted without exposing room lifecycle controls", async () => {
  const room = "00000000-0000-4000-8000-000000000001";
  const steps = [
    step({ method: "GET", path: "/api/rooms/capabilities", json: undefined }),
    step({ path: `/api/rooms/${room}/state`, json: {} }),
    step({ path: `/api/rooms/${room}/poll`, json: { cursor: 0 } }),
    step({ path: `/api/rooms/${room}/signal`, json: { messageId: room, toMemberId: room, connectionEpoch: room, kind: "ice", payload: "prepared-fixture" } }),
  ];
  const plan = await runScenario(scenario(target, steps)); assert.equal(plan.plans[0].requests, 4);
  for (const action of ["create", "join", "admit", "remove", "lock", "end", "prepare", "commit", "abort", "capture"]) assert.throws(() => validateScenario(scenario(target, [step({ path: `/api/rooms/${room}/${action}`, json: {} })])));
  assert.throws(() => validateScenario(scenario(target, [step({ path: `/api/rooms/${room}/state`, json: { renewConnection: true } })])));
  const input = scenario(); input.actors = Array.from({ length: 100 }, () => ({ steps })); input.budgets.requests = 2000;
  const full = await runScenario(input); assert.equal(full.plans[2].requests, 2000); assert.equal(full.plans[2].distinctConfiguredActors, 100);
  assert.equal(full.cadence, "burst-only-no-pacing");
});
