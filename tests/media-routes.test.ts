import assert from "node:assert/strict";
import test from "node:test";
import { createMaintenanceHandler, type MaintenanceAdapter } from "../lib/server/media-maintenance";
import { createStripOperationHandler } from "../lib/server/media-requests";
import { RequestValidationError, readSmallJson } from "../lib/server/request-security";

const ID = "11111111-1111-4111-8111-111111111111";
const JOB = "22222222-2222-4222-8222-222222222222";
const env = { CRON_SECRET: "test-only-secret", NEXT_PUBLIC_SUPABASE_URL: "https://database.example", SUPABASE_SERVICE_ROLE_KEY: "test-only-service-key", PB_PUBLIC_ORIGIN: "https://booth.example", NODE_ENV: "production" };
const capabilities = { version: 1 as const, ready: true, week_start: "2026-09-21T00:00:00.000Z", legacy_retention_not_before: "2026-09-01T00:00:00.000Z" };

function mutation(body: unknown = { id: ID, kept: true }, origin = env.PB_PUBLIC_ORIGIN, method = "POST") {
  return new Request("https://booth.example/api/keep", { method, headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });
}

test("both maintenance routes reject absent or query-string auth before any adapter work", async () => {
  let calls = 0;
  const handler = createMaintenanceHandler(() => { calls++; throw new Error("must not create client"); }, () => env);
  for (const url of ["https://booth.example/api/retention", "https://booth.example/api/media/maintenance?secret=test-only-secret"]) {
    const response = await handler(new Request(url));
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
  }
  assert.equal(calls, 0);
});

test("misconfigured cron and missing lifecycle capability cannot enqueue destructive work", async () => {
  let created = 0, enqueued = 0;
  const adapter: MaintenanceAdapter = { capabilities: async () => { throw new Error("missing schema"); }, enqueue: async () => { enqueued++; return 1; }, process: async () => [] };
  const request = () => new Request("https://booth.example/api/retention", { headers: { authorization: "Bearer test-only-secret" } });
  const disabled = createMaintenanceHandler(() => { created++; return adapter; }, () => ({ ...env, CRON_SECRET: "" }));
  assert.equal((await disabled(request())).status, 503);
  assert.equal(created, 0);
  const missingSchema = createMaintenanceHandler(() => adapter, () => env);
  assert.equal((await missingSchema(request())).status, 503);
  assert.equal(enqueued, 0);
});

test("maintenance reports retries instead of counting them as completed deletions", async () => {
  const handler = createMaintenanceHandler(() => ({ capabilities: async () => capabilities, enqueue: async () => 3, process: async () => [{ id: ID, outcome: "complete" }, { id: JOB, outcome: "retry" }] }), () => env);
  const response = await handler(new Request("https://booth.example/api/media/maintenance", { headers: { authorization: "Bearer test-only-secret" } }));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { enqueued: 3, processed: 2, completed: 1, retrying: 1, failed: 0, weekStart: capabilities.week_start });
});

test("foreign Origin, missing configured origin and oversized mutation never construct auth clients", async () => {
  let created = 0;
  const factory = async () => { created++; throw new Error("must not run"); };
  const handler = createStripOperationHandler(factory, () => env);
  assert.equal((await handler(mutation(undefined, "https://foreign.example"))).status, 403);
  assert.equal((await createStripOperationHandler(factory, () => ({ ...env, PB_PUBLIC_ORIGIN: "" }))(mutation())).status, 503);
  assert.equal((await handler(mutation({ id: ID, kept: true, padding: "x".repeat(8192) }))).status, 413);
  assert.equal(created, 0);
});

test("an unauthenticated mutation cannot probe schema, enqueue or process jobs", async () => {
  const handler = createStripOperationHandler(async () => ({ authorise: async () => false, ready: async () => { assert.fail("schema accessed"); }, enqueue: async () => { assert.fail("job enqueued"); }, process: async () => { assert.fail("job processed"); } }), () => env);
  assert.equal((await handler(mutation())).status, 401);
});

test("owner denial in the database cannot reach the privileged worker", async () => {
  const handler = createStripOperationHandler(async () => ({ authorise: async () => true, ready: async () => {}, enqueue: async () => { throw new RequestValidationError(409, "Operation denied"); }, process: async () => { assert.fail("worker ran"); } }), () => env);
  assert.equal((await handler(mutation())).status, 409);
});

test("a queued keep response never claims its archive has completed", async () => {
  const handler = createStripOperationHandler(async () => ({ authorise: async () => true, ready: async () => {}, enqueue: async (_id, operation) => { assert.equal(operation, "archive"); return JOB; }, process: async () => [] }), () => env);
  const response = await handler(mutation());
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { jobId: JOB, pending: true, kept: true, pushed: false });
});

test("a completed deletion retains the caller's idempotency key and reports success", async () => {
  const handler = createStripOperationHandler(async () => ({ authorise: async () => true, ready: async () => {}, enqueue: async (id, operation, requestId) => { assert.equal(id, ID); assert.equal(operation, "delete"); assert.equal(requestId, JOB); return JOB; }, process: async () => [{ id: JOB, outcome: "complete" }] }), () => env);
  const response = await handler(mutation({ requestId: JOB }, env.PB_PUBLIC_ORIGIN, "DELETE"), ID);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { jobId: JOB, pending: false, deleted: true });
});

test("last-copy release refusal produces an actionable response without success", async () => {
  const handler = createStripOperationHandler(async () => ({ authorise: async () => true, ready: async () => {}, enqueue: async () => JOB, process: async () => [{ id: JOB, outcome: "failed", code: "archive_is_only_copy" }] }), () => env);
  const response = await handler(mutation({ id: ID, kept: false }));
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /only copy/);
});

test("the body reader enforces actual UTF-8 bytes and rejects unsupported representations", async () => {
  await assert.rejects(readSmallJson(mutation("📷".repeat(3000))), { status: 413 });
  await assert.rejects(readSmallJson(mutation([])), { status: 400 });
  await assert.rejects(readSmallJson(new Request("https://booth.example/api/keep", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" })), { status: 415 });
});
