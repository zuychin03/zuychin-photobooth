import assert from "node:assert/strict";
import test from "node:test";
import { memoryAfter, memoryInstantMicros, memoryYearBounds, parseMemoryBrowsePage, validateMemoryBrowse, type MemoryBrowse } from "../lib/memories/activity-browse";
import { ACTIVITY_LIMITS, parseMemoryActivity } from "../lib/memories/activity-contract";
import { createActivityClient } from "../lib/memories/activity-client";
import { createActivityStore } from "../lib/server/activity-store";
import { createActivityHandler } from "../lib/server/activity-requests";
import type { ProjectStorePorts } from "../lib/server/project-store";

const owner = "40000000-0000-4000-8000-000000000001", id = "40000000-0000-4000-8000-000000000002", chapter = "40000000-0000-4000-8000-000000000003";
const query: MemoryBrowse = { year: 2026, timeZone: "Australia/Sydney", chapterId: null, after: null, limit: 2 };
const row = (at = "2026-01-01T00:00:00.000001Z") => ({ id, mine: true, occurredAt: at, provenance: "saved_at", availability: "access_lost", revision: 0, chapterId: null, occasion: null });
const page = (items: unknown[], nextCursor: unknown = null) => ({ version: 1, year: query.year, timeZone: query.timeZone, chapterId: query.chapterId, items, nextCursor });
const env = { PB_MEMORIES_ENABLED: "true", PB_PUBLIC_ORIGIN: "https://app.test", NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "synthetic", NODE_ENV: "production" };
test("activity year bounds follow an explicit civil calendar including the dateline skip", () => {
  assert.deepEqual(memoryYearBounds(2026, "Australia/Sydney"), { start: "2025-12-31T13:00:00.000Z", end: "2026-12-31T13:00:00.000Z" });
  assert.deepEqual(memoryYearBounds(2026, "Asia/Ho_Chi_Minh"), { start: "2025-12-31T17:00:00.000Z", end: "2026-12-31T17:00:00.000Z" });
  const skipped = memoryYearBounds(2011, "Pacific/Apia"); assert.equal((Date.parse(skipped.end) - Date.parse(skipped.start)) / 86_400_000, 364);
  for (const value of [{ ...query, year: 2199 }, { ...query, timeZone: "Mars/Sydney" }, { ...query, limit: 51 }, { ...query, actor: owner }]) assert.throws(() => validateMemoryBrowse(value));
});
test("chronological cursors preserve database microseconds before using the UUID tie break", () => {
  assert.equal(memoryInstantMicros("2026-01-01T00:00:00.123456Z") - memoryInstantMicros("2026-01-01T11:00:00.123455+11:00"), BigInt(1));
  assert(memoryAfter({ occurredAt: "2026-01-01T00:00:00.123455Z", id: chapter }, { occurredAt: "2026-01-01T00:00:00.123456Z", id }));
  assert(memoryAfter({ occurredAt: "2026-01-01T00:00:00Z", id }, { occurredAt: "2026-01-01T00:00:00Z", id: chapter }));
  assert.throws(() => memoryInstantMicros("2026-02-30T00:00:00Z"));
});
test("browse parsing rejects wrong ordering, chapter leakage, cursor and civil-year drift", () => {
  const newer = { ...row(), id: chapter, occurredAt: "2026-01-01T00:00:00.000002Z" }, older = row();
  assert.equal(parseMemoryBrowsePage(page([newer, older], { id, occurredAt: older.occurredAt }), query, parseMemoryActivity).items.length, 2);
  for (const value of [page([older, newer]), page([older, older]), page([row("2026-12-31T14:00:00Z")]), page([older], { id, occurredAt: older.occurredAt }), { ...page([]), timeZone: "UTC" }]) assert.throws(() => parseMemoryBrowsePage(value, query, parseMemoryActivity));
  assert.throws(() => parseMemoryBrowsePage({ ...page([older]), chapterId: chapter }, { ...query, chapterId: chapter }, parseMemoryActivity));
  assert.throws(() => validateMemoryBrowse({ ...query, after: { id, occurredAt: "2025-01-01T00:00:00Z" } }));
});
function fixture() {
  const calls: { name: string; args: Record<string, unknown> }[] = []; let capability = true;
  const ports: ProjectStorePorts = { authenticate: async () => owner, rpc: async (name, args) => { calls.push({ name, args }); return { error: null, data: name === "pb_memory_capabilities" ? { ...ACTIVITY_LIMITS, ready: true } : name === "pb_memory_browse_capabilities" ? capability ? { version: 1, pageLimit: 50, order: "occurred_at_desc_id_desc" } : {} : name === "pb_project_rate" ? { allowed: true, retryAfterSeconds: 0 } : { items: [row()], nextCursor: null } }; } };
  const handler = createActivityHandler({ store: token => createActivityStore(token, env, ports) }, () => env);
  const client = createActivityClient({ appOrigin: "https://app.test", identity: () => ({ ownerId: owner, epoch: 1 }), accessToken: async () => "synthetic", fetch: async (url, init) => handler(new Request(String(url), { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), origin: "https://app.test" } })) });
  return { calls, ports, handler, client, noCapability() { capability = false; } };
}
test("actual browser client, handler and store use one actor-bound chronological query", async () => {
  const f = fixture(); try {
    const result = await f.client.browse(query); assert.equal(result.items[0].source, null);
    assert.deepEqual(f.calls.filter(call => call.name === "pb_project_rate").map(call => call.args), [{ p_actor: owner, p_operation: "read" }]);
    assert.deepEqual(f.calls.at(-1), { name: "pb_memory_browse", args: { p_actor: owner, p_start: "2025-12-31T13:00:00.000Z", p_end: "2026-12-31T13:00:00.000Z", p_chapter: null, p_after_at: null, p_after_id: null, p_limit: 2 } });
  } finally { f.client.close(); }
});
test("missing browse capability disables only browsing and malformed filters fail before authentication", async () => {
  const f = fixture(); f.noCapability(); try { await assert.rejects(f.client.browse(query), /unavailable/); assert.equal((await f.client.list()).items.length, 1); } finally { f.client.close(); }
  const fresh = fixture(); for (const body of [{ operation: "browse", query: { ...query, actor: owner } }, { operation: "browse", query, actor: owner }]) {
    const response = await fresh.handler(new Request("https://app.test/api/memories", { method: "POST", headers: { authorization: "Bearer synthetic", origin: "https://app.test", "content-type": "application/json" }, body: JSON.stringify(body) })); assert.equal(response.status, 400);
  } assert.deepEqual(fresh.calls, []); fresh.client.close();
});
