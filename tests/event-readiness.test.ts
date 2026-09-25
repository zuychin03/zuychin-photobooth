import assert from "node:assert/strict";
import test from "node:test";
import { createEventReadinessStore, parseEventWorkerStatus } from "../lib/server/event-readiness-store";
import { parseEventRunnerOptions, runEventWorker } from "../lib/server/event-worker-runner";

const env = { PB_EVENTS_ENABLED: "true", NEXT_PUBLIC_SUPABASE_URL: "https://database.example", SUPABASE_SERVICE_ROLE_KEY: "synthetic-only", PB_PUBLIC_ORIGIN: "https://app.example", CRON_SECRET: "synthetic-cron-only" };
const health = { version: 1, ready: true, verifiedAt: "2026-09-23T00:00:00Z", pending: 0, maxPending: 2, heartbeatMaxAgeSeconds: 150 };
test("worker status is independent, strict and never falls back to a ready deployment", async () => {
  assert.deepEqual(parseEventWorkerStatus(health), health);
  for (const patch of [{ version: 2 }, { maxPending: 100 }, { verifiedAt: null }, { pending: -1 }, { extra: "private" }]) assert.throws(() => parseEventWorkerStatus({ ...health, ...patch }));
  const calls: string[] = [], store = createEventReadinessStore(env, { rpc: async name => { calls.push(name); return { data: health, error: null }; } });
  await store.status(); await store.verified(); assert.deepEqual(calls, ["pb_event_worker_status", "pb_event_worker_verified"]);
  await assert.rejects(createEventReadinessStore(env, { rpc: async () => ({ data: null, error: { message: "missing private function" } }) }).status(), /unavailable/);
  assert.throws(() => createEventReadinessStore({ ...env, PB_EVENTS_ENABLED: "false" }), /unavailable/);
});
test("runner is zero-network by default, validates exact origins and refuses unbounded options", async () => {
  let calls = 0; const fetcher: typeof fetch = async () => { calls++; throw new Error(); };
  assert.deepEqual(await runEventWorker(parseEventRunnerOptions([]), {}, { fetch: fetcher }), { stop: "dry_run", passes: 0, completed: 0, expired: 0, configured: false });
  assert.equal((await runEventWorker(parseEventRunnerOptions([]), env, { fetch: fetcher })).configured, true); assert.equal(calls, 0);
  for (const args of [["--max-passes=4"], ["--deadline-ms=300001"], ["--apply=true"], ["--apply", "--apply"], ["--token=secret"]]) assert.throws(() => parseEventRunnerOptions(args));
  for (const origin of ["https://user:secret@app.example", "https://app.example/path", "https://app.example?secret=x", "http://app.example"]) await assert.rejects(runEventWorker(parseEventRunnerOptions([]), { ...env, PB_PUBLIC_ORIGIN: origin }, { fetch: fetcher }));
  await assert.rejects(runEventWorker(parseEventRunnerOptions(["--apply"]), {}, { fetch: fetcher })); assert.equal(calls, 0);
});
test("runner sequentially drains a finite batch, keeps credentials only in its header and stops at idle", async () => {
  let calls = 0, active = 0;
  const result = await runEventWorker(parseEventRunnerOptions(["--apply"]), env, { fetch: async (url, init) => {
    assert.equal(active++, 0); assert.equal(url, "https://app.example/api/events/maintenance"); assert.equal(new Headers(init?.headers).get("authorization"), "Bearer synthetic-cron-only"); assert.equal(init?.redirect, "error"); assert.equal(init?.credentials, "omit");
    await Promise.resolve(); active--; calls++; return Response.json({ expired: 1, job: calls === 3 ? "idle" : "ready", workerReady: true });
  } });
  assert.deepEqual(result, { stop: "idle", passes: 3, completed: 2, expired: 3 }); assert(!JSON.stringify(result).includes(env.CRON_SECRET));
});
test("runner stops on failed passes, redirect, excessive body or deadline without a hidden retry", async () => {
  for (const response of [new Response("secret", { status: 503 }), Response.json({ expired: 0, job: "ready", workerReady: false }), new Response("x".repeat(4097), { headers: { "content-type": "application/json" } }), Object.defineProperty(Response.json({ expired: 0, job: "idle", workerReady: true }), "redirected", { value: true })]) {
    let calls = 0; const result = await runEventWorker(parseEventRunnerOptions(["--apply"]), env, { fetch: async () => { calls++; return response; } }); assert.equal(calls, 1); assert(["retry", "refused"].includes(result.stop));
  }
  let calls = 0; const timed = await runEventWorker({ apply: true, maxPasses: 3, deadlineMs: 5 }, env, { fetch: () => { calls++; return new Promise(() => undefined); } }); assert.equal(timed.stop, "deadline"); assert.equal(calls, 1);
});
