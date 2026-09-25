import test from "node:test";
import assert from "node:assert/strict";
import { createMemoriesHandler } from "../lib/server/ritual-requests";
import { createActivityHandler } from "../lib/server/activity-requests";
import { RitualServerError, createRitualStore } from "../lib/server/ritual-store";
import type { ActivityStore } from "../lib/server/activity-store";
import { actorId, coupleId, env, fixtureStore, id, row, schedule } from "./helpers/ritual-http";
const request = (body: unknown, headers: Record<string, string> = {}) => new Request("https://app.test/api/memories", { method: "POST", headers: { origin: "https://app.test", authorization: "Bearer fixture", "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
function fixture() {
  const f = fixtureStore(); let authenticated = 0;
  const ports = { store: async (token: string) => { assert.equal(token, "fixture"); authenticated++; return f.store; } };
  return { ...f, ports, authenticated: () => authenticated, handler: createMemoriesHandler(ports, () => env) };
}
const privateHeaders = (r: Response) => { assert.equal(r.headers.get("cache-control"), "private, no-store"); assert.equal(r.headers.get("referrer-policy"), "no-referrer"); };
test("ritual endpoint rejects disabled flags, non-POST, insecure origins, queries and malformed credentials before store", async () => {
  const f = fixture();
  assert.equal((await createMemoriesHandler(f.ports, () => ({ ...env, PB_MEMORIES_ENABLED: "false" }))(request({ operation: "ritualList", coupleId }))).status, 503);
  for (const [req, status] of [[new Request("https://app.test/api/memories"), 405], [request({}, { origin: "https://foreign.test" }), 403], [request({}, { authorization: "Bearer a,b" }), 401], [request({}, { "sec-fetch-site": "cross-site" }), 403], [new Request("http://app.test/api/memories", request({})), 503], [new Request("https://app.test/api/memories?actor=x", request({})), 400]] as const) {
    const response = await f.handler(req); assert.equal(response.status, status); privateHeaders(response);
  }
  assert.equal(f.authenticated(), 0);
});
test("ritual bodies are exact and never accept actor, proofs, recipient identity or database cursors", async () => {
  const f = fixture();
  for (const body of [
    { operation: "ritualList" }, { operation: "ritualList", coupleId, limit: null }, { operation: "ritualList", coupleId, limit: 21 }, { operation: "ritualList", coupleId, after: "opaque-proof" }, { operation: "ritualList", coupleId, actor: actorId },
    { operation: "ritualCreate", coupleId, input: { id: id(), title: "A", schedule, proof: {} } },
    { operation: "ritualPause", coupleId, id: id(), revision: -1 },
    { operation: "ritualUpgrade", coupleId, id: id(), expectedScheduledAt: "unknown", input: { title: "A", schedule } },
    { operation: "ritualSetChannels", coupleId, id: id(), revision: 0, channels: { email: true, push: false, recipient: actorId } },
    { operation: "ritualContext", coupleId },
  ]) assert.equal((await f.handler(request(body))).status, 400);
  assert.equal((await f.handler(request({}, { "content-length": "8193" }))).status, 413);
  assert.equal((await f.handler(request({}, { "content-type": "text/plain" }))).status, 415);
  assert.equal(f.authenticated(), 0);
});
test("ritual errors hide database details and expose bounded retry only", async () => {
  const f = fixture();
  for (const [error, status, code] of [[new RitualServerError("rate_limited", 429, 17), 429, "rate_limited"], [new RitualServerError("schedule_changed", 409), 409, "schedule_changed"], [new RitualServerError("no_future_occurrence", 409), 409, "no_future_occurrence"], [new RitualServerError("private-sql", 403), 503, "unavailable"], [new Error("private-sql"), 503, "unavailable"]] as const) {
    f.store.list = async () => { throw error; }; const response = await f.handler(request({ operation: "ritualList", coupleId })); assert.equal(response.status, status); assert.deepEqual(await response.json(), { error: code }); privateHeaders(response); if (status === 429) assert.equal(response.headers.get("retry-after"), "17");
  }
});
test("combined route preserves activity operations without invoking ritual authentication", async () => {
  const calls: string[] = [], chapter = { id: id(), title: "Winter", revision: 0, createdAt: "2030-01-01T00:00:00Z" };
  const unused = async (): Promise<never> => { throw new Error("Unexpected activity operation"); };
  const activityStore: ActivityStore = { browse: unused, list: async () => { calls.push("list"); return { items: [], nextCursor: null }; }, chapters: async () => [chapter], deleteChapter: async () => ({ deleted: true }), summary: unused, putChapter: unused, annotate: unused };
  const activity = createActivityHandler({ store: async () => activityStore }, () => env);
  const handler = createMemoriesHandler({ store: async () => { throw new Error("Wrong store"); }, activity }, () => env);
  for (const [body, expected] of [[{ operation: "list" }, { items: [], nextCursor: null }], [{ operation: "chapters" }, { chapters: [chapter] }], [{ operation: "deleteChapter", id: id(), expectedRevision: 0 }, { deleted: true }]] as const) {
    const response = await handler(request(body)); assert.equal(response.status, 200); assert.deepEqual(await response.json(), expected); privateHeaders(response);
  }
  assert.deepEqual(calls, ["list"]);
});
test("real ritual store charges exactly once behind the combined handler and checks capability independently", async () => {
  const calls: string[] = [];
  const handler = createMemoriesHandler({ store: token => createRitualStore(token, { ...env, NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321", SUPABASE_SERVICE_ROLE_KEY: "fixture" }, {
    authenticate: async () => actorId,
    rpc: async (name, args) => { calls.push(name);
      if (name === "pb_ritual_capabilities") return { data: { ready: true, version: 1, maximumPerCouple: 20, pageMaximum: 20, proofSeconds: 30, deliveryVersion: 0 }, error: null };
      if (name === "pb_project_rate") { assert.equal(args.p_actor, actorId); return { data: { allowed: true, retryAfterSeconds: 0 }, error: null }; }
      assert.equal(name, "pb_ritual_list"); assert.equal(args.p_couple, coupleId); return { data: { version: 1, items: [row()], nextCursor: null }, error: null };
    },
  }) }, () => env);
  assert.equal((await handler(request({ operation: "ritualList", coupleId }))).status, 200);
  assert.deepEqual(calls, ["pb_ritual_capabilities", "pb_project_rate", "pb_ritual_list"]);
});
test("ritual handler does not forward extra provider fields or oversized projections", async () => {
  const f = fixture(); f.store.create = async () => ({ ...row(), secret: "provider" });
  const response = await f.handler(request({ operation: "ritualCreate", coupleId, input: { id: id(), title: "Photo date", schedule } }));
  assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: "unavailable" });
  f.store.list = async () => ({ version: 1, items: Array.from({ length: 20 }, (_, index) => ({ ...row(), id: id(index + 10), legacy: true, schedule: null, next: null, active: true, enabled: false, title: "x".repeat(10000) })), nextCursor: null });
  assert.equal((await f.handler(request({ operation: "ritualList", coupleId }))).status, 503);
});
