import test from "node:test";
import assert from "node:assert/strict";
import { createActivityHandler } from "../lib/server/activity-requests";
import { ActivityServerError, type ActivityStore } from "../lib/server/activity-store";
const id = "00000000-0000-4000-8000-000000000001";
const env = { PB_MEMORIES_ENABLED: "true", PB_PUBLIC_ORIGIN: "https://app.test", NODE_ENV: "production" };
const request = (body: unknown, headers: Record<string, string> = {}) => new Request("https://app.test/api/memories", { method: "POST", headers: { origin: "https://app.test", authorization: "Bearer fixture", "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
function fixture() {
  const calls: unknown[][] = [];
  const store: ActivityStore = {
    browse: async () => { throw new Error("Unexpected browse"); },
    list: async (...args) => { calls.push(["list", ...args]); return { items: [], nextCursor: null }; },
    summary: async year => { calls.push(["summary", year]); return { year, timezone: "UTC", basis: "own_source_records", months: Array.from({ length: 12 }, (_, i) => ({ month: i + 1, total: 0 })), outsideCalendar: 0 }; },
    chapters: async () => { calls.push(["chapters"]); return []; },
    putChapter: async c => { calls.push(["putChapter", c]); return { id: c.id, title: c.title, revision: c.expectedRevision + 1, createdAt: "2026-01-01T00:00:00Z" }; },
    annotate: async () => { throw new ActivityServerError("conflict", 409); },
    deleteChapter: async (...args) => { calls.push(["deleteChapter", ...args]); return { deleted: true }; },
  };
  const ports = { store: async (token: string) => { calls.push(["authenticate", token]); return store; } };
  return { calls, store, ports, handler: createActivityHandler(ports, () => env) };
}
function privateHeaders(response: Response) { assert.equal(response.headers.get("cache-control"), "private, no-store"); assert.equal(response.headers.get("referrer-policy"), "no-referrer"); }
test("activity flags, method, origin, bearer, TLS and query fail before stores", async () => {
  const f = fixture();
  const off = await createActivityHandler(f.ports, () => ({ ...env, PB_MEMORIES_ENABLED: "false" }))(request({ operation: "list" })); assert.equal(off.status, 503); privateHeaders(off);
  for (const [req, status] of [
    [new Request("https://app.test/api/memories"), 405], [request({ operation: "list" }, { origin: "https://foreign.test" }), 403],
    [request({ operation: "list" }, { authorization: "Bearer a,b" }), 401], [request({ operation: "list" }, { "sec-fetch-site": "cross-site" }), 403],
    [new Request("http://app.test/api/memories", request({ operation: "list" })), 503], [new Request("https://app.test/api/memories?actor=123", request({ operation: "list" })), 400],
  ] as const) { const res = await f.handler(req); assert.equal(res.status, status); privateHeaders(res); }
  assert.deepEqual(f.calls, []);
});
test("activity finite exact bodies reject actor and malformed CAS before authentication", async () => {
  const f = fixture();
  for (const body of [{ operation: "list", actor: id }, { operation: "list", limit: 51 }, { operation: "list", limit: null }, { operation: "summary", year: 1969 }, { operation: "chapters", sourceId: id }, { operation: "deleteChapter", id, expectedRevision: -1 }, { operation: "putChapter", chapter: { id, title: "A", expectedRevision: -1, owner: id } }, { operation: "backfill" }]) assert.equal((await f.handler(request(body))).status, 400);
  assert.equal((await f.handler(request({}, { "content-length": "8193" }))).status, 413);
  assert.equal((await f.handler(request({}, { "content-type": "text/plain" }))).status, 415);
  assert.deepEqual(f.calls, []);
});
test("activity operations call one store method, preserving UTC and exact revisions", async () => {
  const f = fixture();
  for (const body of [{ operation: "list", after: id, limit: 2 }, { operation: "summary", year: 2026 }, { operation: "chapters" }, { operation: "putChapter", chapter: { id, expectedRevision: -1, title: "Our winter" } }, { operation: "deleteChapter", id, expectedRevision: 3 }]) {
    const res = await f.handler(request(body)); assert.equal(res.status, 200); privateHeaders(res);
    if (body.operation === "summary") assert.equal((await res.json()).timezone, "UTC");
  }
  assert.deepEqual(f.calls.filter(c => c[0] !== "authenticate").map(c => c[0]), ["list", "summary", "chapters", "putChapter", "deleteChapter"]);
  assert.deepEqual(f.calls.at(-1), ["deleteChapter", id, 3]);
});
test("activity public errors are sanitised and rate retry is bounded", async () => {
  const f = fixture();
  for (const [error, status, code] of [[new ActivityServerError("rate_limited", 429, 12), 429, "rate_limited"], [new ActivityServerError("chapter_not_empty", 409), 409, "chapter_not_empty"], [new ActivityServerError("secret-provider-message", 403), 503, "unavailable"], [new Error("secret-provider-message"), 503, "unavailable"]] as const) {
    f.store.chapters = async () => { throw error; }; const res = await f.handler(request({ operation: "chapters" })); assert.equal(res.status, status); assert.deepEqual(await res.json(), { error: code }); if (status === 429) assert.equal(res.headers.get("retry-after"), "12");
  }
});
