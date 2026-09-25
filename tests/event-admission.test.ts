import test from "node:test";
import assert from "node:assert/strict";
import { parseAdmissionOptions, runEventAdmission } from "../lib/server/event-admission-control";
import { parseEventWorkerStatus } from "../lib/server/event-readiness-store";

const env = { NEXT_PUBLIC_SUPABASE_URL: "https://database.example", SUPABASE_SERVICE_ROLE_KEY: "synthetic-only" };
test("admission control defaults to zero network and requires explicit finite CAS options", async () => {
  let calls = 0;
  assert.deepEqual(await runEventAdmission(parseAdmissionOptions([]), env, { fetch: async () => { calls++; throw new Error(); } }), { mode: "dry_run", configured: true, action: "status" });
  assert.equal(calls, 0);
  for (const args of [["--action=pause"], ["--action=resume", "--expected-revision=-1"], ["--expected-revision=1"], ["--apply", "--apply"], ["--action=status=hidden"], ["--expected-revision=2147483648", "--action=pause"]]) assert.throws(() => parseAdmissionOptions(args));
});
test("admission control keeps service credentials in headers and validates the acknowledged mutation", async () => {
  const options = parseAdmissionOptions(["--apply", "--action=pause", "--expected-revision=2"]);
  const result = await runEventAdmission(options, env, { fetch: async (url, init) => {
    assert.equal(url, `${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/rpc/pb_event_admission_control`);
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`);
    assert.deepEqual(JSON.parse(String(init?.body)), { p_paused: true, p_expected_revision: 2 });
    assert.equal(init?.redirect, "error"); return Response.json({ version: 1, paused: true, revision: 3 });
  } });
  assert.deepEqual(result, { mode: "applied", state: { version: 1, paused: true, revision: 3 } });
  assert(!JSON.stringify(result).includes(env.SUPABASE_SERVICE_ROLE_KEY));
  for (const value of [{ version: 1, paused: false, revision: 3 }, { version: 1, paused: true, revision: 4 }, { version: 0, paused: true, revision: 3 }]) await assert.rejects(runEventAdmission(options, env, { fetch: async () => Response.json(value) }));
});
test("old schema, excessive response and ignored-abort fetch never acknowledge a pause", async () => {
  const options = parseAdmissionOptions(["--apply"]);
  for (const response of [new Response("private SQL details", { status: 404 }), new Response("x".repeat(4097), { headers: { "Content-Type": "application/json" } })]) await assert.rejects(runEventAdmission(options, env, { fetch: async () => response }));
  await assert.rejects(runEventAdmission(options, env, { timeoutMs: 5, fetch: () => new Promise(() => {}) }), /unconfirmed/);
  await assert.rejects(runEventAdmission(options, { ...env, NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1" }));
});
test("readiness accepts an intentional pause without reporting admission ready", () => {
  const health = { version: 1, ready: false, verifiedAt: new Date().toISOString(), pending: 1, maxPending: 2, heartbeatMaxAgeSeconds: 150, admissionPaused: true };
  assert.equal(parseEventWorkerStatus(health).admissionPaused, true);
  assert.throws(() => parseEventWorkerStatus({ ...health, ready: true }));
  assert.throws(() => parseEventWorkerStatus({ ...health, admissionPaused: "true" }));
});
