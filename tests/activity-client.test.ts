import test from "node:test";
import assert from "node:assert/strict";
import { ActivityClientError, createActivityClient, parseActivityListResponse, parseActivityResponse } from "../lib/memories/activity-client";
import { createActivityHandler } from "../lib/server/activity-requests";
import type { ActivityStore } from "../lib/server/activity-store";
const id = (n = 1) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const activity = () => ({ id: id(), mine: true, occurredAt: "2026-01-01T00:00:00Z", provenance: "saved_at", availability: "available", source: { kind: "strip", id: id(3), scopeKind: "personal", scopeId: null }, annotation: { revision: 0, chapterId: null, occasion: null } });
function fixture(value: unknown = { items: [], nextCursor: null }) {
  let identity: { ownerId: string; epoch: number } | null = { ownerId: id(9), epoch: 1 }, token = 0;
  const calls: RequestInit[] = [];
  const options = { appOrigin: "https://app.test", identity: () => identity, accessToken: async () => `fixture-${++token}`, fetch: (async (_url, init) => { calls.push(init!); return Response.json(value); }) as typeof fetch };
  return { options, calls, change() { identity = { ownerId: id(9), epoch: 2 }; }, client: createActivityClient(options) };
}
const code = (expected: string) => (error: unknown) => error instanceof ActivityClientError && error.code === expected;
test("HTTP activity parser drops extras and enforces minimal lost/shared projections", () => {
  const raw = activity(); assert.deepEqual(parseActivityResponse({ ...raw, signedUrl: "private" }), raw);
  assert.equal(parseActivityResponse({ ...raw, availability: "access_lost", source: null }).source, null);
  assert.throws(() => parseActivityResponse({ ...raw, availability: "access_lost" }), code("invalid_response"));
  assert.throws(() => parseActivityResponse({ ...raw, mine: false }), code("invalid_response"));
  assert.throws(() => parseActivityListResponse({ items: [raw, raw], nextCursor: null }), code("invalid_response"));
});
test("client uses fresh tokens, private same-origin calls, UUID keyset and close fence", async () => {
  const f = fixture(); await f.client.list(); await f.client.list(id(), 2);
  assert.equal((f.calls[0].headers as Record<string, string>).Authorization, "Bearer fixture-1"); assert.equal((f.calls[1].headers as Record<string, string>).Authorization, "Bearer fixture-2");
  assert.equal(f.calls[0].credentials, "omit"); assert.equal(f.calls[0].cache, "no-store"); assert.equal(f.calls[0].redirect, "error");
  f.client.close(); await assert.rejects(f.client.list(), code("cancelled")); assert.equal(f.calls.length, 2);
});
test("account changes while awaiting a token never send a request", async () => {
  const f = fixture(); let release!: (token: string) => void;
  const client = createActivityClient({ ...f.options, accessToken: () => new Promise(resolve => { release = resolve; }) });
  const pending = client.list(); f.change(); release("fixture"); await assert.rejects(pending, code("account_changed")); assert.equal(f.calls.length, 0);
});
test("account changes while streaming discard the projection", async () => {
  const f = fixture(); const client = createActivityClient({ ...f.options, fetch: async () => new Response(new ReadableStream({ pull(controller) { f.change(); controller.enqueue(new TextEncoder().encode('{}')); controller.close(); } }), { headers: { "content-type": "application/json" } }) });
  await assert.rejects(client.list(), code("account_changed"));
});
test("response bytes, tiny chunk count, content type and stalled tokens are bounded", async () => {
  const f = fixture();
  for (const response of [Response.json({}, { headers: { "content-length": "65537" } }), new Response(new ReadableStream({ start(c) { for (let i = 0; i < 4097; i++) c.enqueue(new Uint8Array([32])); c.close(); } }), { headers: { "content-type": "application/json" } })]) await assert.rejects(createActivityClient({ ...f.options, fetch: async () => response }).list(), code("response_too_large"));
  await assert.rejects(createActivityClient({ ...f.options, fetch: async () => new Response("{}") }).list(), code("invalid_response"));
  await assert.rejects(createActivityClient({ ...f.options, accessToken: () => new Promise(() => {}), timeoutMs: 5 }).list(), code("timeout"));
});
test("mutation responses must match exact ID, labels and incremented revision", async () => {
  const chapter = { id: id(), expectedRevision: -1, title: "Winter" };
  const good = fixture({ id: id(), title: "Winter", revision: 0, createdAt: "2026-01-01T00:00:00Z" }); assert.equal((await good.client.putChapter(chapter)).revision, 0);
  for (const patch of [{ id: id(2) }, { revision: 1 }, { title: "Other" }]) await assert.rejects(fixture({ id: id(), title: "Winter", revision: 0, createdAt: "2026-01-01T00:00:00Z", ...patch }).client.putChapter(chapter), code("invalid_response"));
  const annotation = { id: id(), expectedRevision: 0, chapterId: null, occasion: "Birthday" };
  await assert.rejects(fixture(activity()).client.annotate(annotation), code("invalid_response"));
  assert.equal((await fixture({ ...activity(), annotation: { revision: 1, chapterId: null, occasion: "Birthday" } }).client.annotate(annotation)).annotation?.revision, 1);
});
test("UTC summary cannot be relabelled as local totals, wrong year and cursor are rejected", async () => {
  const summary = { year: 2026, timezone: "UTC", basis: "own_source_records", months: Array.from({ length: 12 }, (_, i) => ({ month: i + 1, total: 0 })), outsideCalendar: 0 };
  assert.equal((await fixture(summary).client.summary(2026)).timezone, "UTC");
  for (const patch of [{ timezone: "Australia/Sydney" }, { year: 2025 }]) await assert.rejects(fixture({ ...summary, ...patch }).client.summary(2026), code("invalid_response"));
  await assert.rejects(fixture({ items: [activity()], nextCursor: null }).client.list(id()), code("invalid_response"));
});
test("errors do not expose provider text and cancellation remains local", async () => {
  const f = fixture(), client = createActivityClient({ ...f.options, fetch: async () => Response.json({ error: "private-sql" }, { status: 500 }) });
  await assert.rejects(client.chapters(), code("unavailable"));
  const controller = new AbortController(); controller.abort(); await assert.rejects(f.client.deleteChapter(id(), 0, controller.signal), code("cancelled")); assert.equal(f.calls.length, 0);
});
test("real client and HTTP handler agree on normalised activity and chapter envelopes", async () => {
  const row = parseActivityResponse(activity()), chapter = { id: id(4), title: "Winter", revision: 2, createdAt: "2026-01-01T00:00:00Z" };
  const store = { list: async () => ({ items: [row], nextCursor: null }), chapters: async () => [chapter] } as ActivityStore;
  const handler = createActivityHandler({ store: async token => { assert.equal(token, "fixture"); return store; } }, () => ({ PB_MEMORIES_ENABLED: "true", PB_PUBLIC_ORIGIN: "https://app.test", NODE_ENV: "production" }));
  const client = createActivityClient({ appOrigin: "https://app.test", identity: () => ({ ownerId: id(9), epoch: 1 }), accessToken: async () => "fixture", fetch: async (url, init) => {
    const headers = new Headers(init?.headers); headers.set("Origin", "https://app.test"); return handler(new Request(url, { ...init, headers }));
  } });
  assert.deepEqual((await client.list()).items, [row]); assert.deepEqual(await client.chapters(), [chapter]);
});
test("stalled response streams are cancelled at the deadline and invalid UTF-8 is rejected", async () => {
  const f = fixture(); let cancelled = false;
  const client = createActivityClient({ ...f.options, timeoutMs: 5, fetch: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "content-type": "application/json" } }) });
  await assert.rejects(client.list(), code("timeout")); assert.equal(cancelled, true);
  await assert.rejects(createActivityClient({ ...f.options, fetch: async () => new Response(new Uint8Array([0xff]), { headers: { "content-type": "application/json" } }) }).list(), code("invalid_response"));
});
