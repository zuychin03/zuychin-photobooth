import test from "node:test";
import assert from "node:assert/strict";
import { createRitualClient, RitualClientError } from "../lib/memories/ritual-client";
import { createMemoriesHandler } from "../lib/server/ritual-requests";
import { actorId, coupleId, env, fixtureStore, id, row, schedule } from "./helpers/ritual-http";
const code = (expected: string) => (error: unknown) => error instanceof RitualClientError && error.code === expected;
function fixture(value: unknown = { version: 1, items: [], nextCursor: null }) {
  let identity: { ownerId: string; epoch: number } | null = { ownerId: actorId, epoch: 1 }, tokens = 0;
  const calls: RequestInit[] = [];
  const options = { appOrigin: "https://app.test", identity: () => identity, accessToken: async () => `fixture-${++tokens}`, fetch: (async (_url, init) => { calls.push(init!); return Response.json(value); }) as typeof fetch };
  return { options, calls, change() { identity = { ownerId: actorId, epoch: 2 }; }, leave() { identity = null; }, client: createRitualClient(options) };
}
test("all eight real browser-client and handler shapes agree, including exact legacy instant and CAS", async () => {
  const f = fixtureStore(), handler = createMemoriesHandler({ store: async token => { assert.equal(token, "fixture"); return f.store; } }, () => env);
  const client = createRitualClient({ appOrigin: "https://app.test", identity: () => ({ ownerId: actorId, epoch: 1 }), accessToken: async () => "fixture", fetch: async (url, init) => {
    const headers = new Headers(init?.headers); headers.set("Origin", "https://app.test"); return handler(new Request(url, { ...init, headers }));
  } });
  const input = { title: "Photo date", schedule };
  assert.equal((await client.list(coupleId)).items[0].id, id());
  assert.equal((await client.create(coupleId, { id: id(), ...input })).revision, 0);
  assert.equal((await client.upgrade(coupleId, id(), row().scheduledAt, input)).revision, 1);
  assert.equal((await client.edit(coupleId, id(), 4, { ...input, title: "Renamed" })).title, "Renamed");
  assert.equal((await client.pause(coupleId, id(), 5)).paused, true);
  assert.equal((await client.resume(coupleId, id(), 6)).paused, false);
  assert.deepEqual((await client.setChannels(coupleId, id(), 7, { email: true, push: false })).channels, { email: true, push: false });
  assert.deepEqual(await client.delete(coupleId, id(), 8), { id: id(), deleted: true, revision: 9 });
  assert.deepEqual(f.calls.map(call => call[0]), ["list", "create", "upgrade", "edit", "pause", "resume", "setChannels", "delete"]);
  assert(f.calls.every(call => call[1] === coupleId)); assert.equal(f.calls[2][3], row().scheduledAt);
});
test("calls use fresh tokens and fixed same-origin no-store transport; close cancels without remote mutation", async () => {
  const f = fixture(); await f.client.list(coupleId); await f.client.list(coupleId, id(), 2);
  for (const [index, call] of f.calls.entries()) { assert.equal((call.headers as Record<string, string>).Authorization, `Bearer fixture-${index + 1}`); assert.equal(call.credentials, "omit"); assert.equal(call.cache, "no-store"); assert.equal(call.redirect, "error"); }
  assert.deepEqual(JSON.parse(f.calls[1].body as string), { operation: "ritualList", coupleId, after: id(), limit: 2 });
  f.client.close(); await assert.rejects(f.client.list(coupleId), code("cancelled")); assert.equal(f.calls.length, 2);
});
test("explicit original couple is validated and never inferred from account changes", async () => {
  const f = fixture();
  for (const input of ["", "current", actorId + "/other"]) await assert.rejects(f.client.list(input), code("invalid_request"));
  await assert.rejects(f.client.list(coupleId, undefined, 21), code("invalid_request"));
  await assert.rejects(f.client.create(coupleId, { id: id(), title: "A", schedule, proof: {} } as never), code("invalid_request"));
  await assert.rejects(f.client.setChannels(coupleId, id(), 0, { email: true, push: false, recipient: actorId } as never), code("invalid_request"));
  assert.equal(f.calls.length, 0);
});
test("account changes during token retrieval or response stream discard all results", async () => {
  const f = fixture(); let release!: (token: string) => void;
  const client = createRitualClient({ ...f.options, accessToken: () => new Promise(resolve => { release = resolve; }) });
  const pending = client.list(coupleId); f.change(); release("fixture"); await assert.rejects(pending, code("account_changed")); assert.equal(f.calls.length, 0);
  const g = fixture(), streamed = createRitualClient({ ...g.options, fetch: async () => new Response(new ReadableStream({ pull(c) { g.leave(); c.enqueue(new TextEncoder().encode("{}")); c.close(); } }), { headers: { "content-type": "application/json" } }) });
  await assert.rejects(streamed.list(coupleId), code("account_changed"));
});
test("identity loss wins over a simultaneous local abort", async () => {
  const f = fixture(), controller = new AbortController();
  const client = createRitualClient({ ...f.options, accessToken: async () => { f.leave(); controller.abort(); return "fixture"; } });
  await assert.rejects(client.list(coupleId, undefined, 20, controller.signal), code("account_changed")); assert.equal(f.calls.length, 0);
});
test("unknown fields, wrong scopes, wrong IDs and stale mutation acknowledgements fail closed", async () => {
  for (const patch of [{ coupleId: actorId }, { id: id(9) }, { revision: 0 }, { secret: "provider" }, { legacy: true }]) {
    await assert.rejects(fixture({ ...row(), revision: 1, paused: true, enabled: false, ...patch }).client.pause(coupleId, id(), 0), code("invalid_response"));
  }
  await assert.rejects(fixture({ ...row(), revision: 1, channels: { email: false, push: false } }).client.setChannels(coupleId, id(), 0, { email: true, push: false }), code("invalid_response"));
  await assert.rejects(fixture({ id: id(), deleted: true, revision: 0 }).client.delete(coupleId, id(), 0), code("invalid_response"));
  await assert.rejects(fixture({ version: 1, items: [{ ...row(), coupleId: actorId }], nextCursor: null }).client.list(coupleId), code("invalid_response"));
  await assert.rejects(fixture({ version: 1, items: [row(), row()], nextCursor: null }).client.list(coupleId), code("invalid_response"));
});
test("legacy rows stay explicit and read-only until the caller provides an upgrade definition", async () => {
  const legacy = { ...row(), legacy: true, active: true, schedule: null, next: null, enabled: false };
  assert.equal((await fixture({ version: 1, items: [legacy], nextCursor: null }).client.list(coupleId)).items[0].legacy, true);
  await assert.rejects(fixture(legacy).client.create(coupleId, { id: id(), title: "Photo date", schedule }), code("invalid_response"));
});
test("response bytes, fragment counts, content type, UTF-8 and redirect metadata are bounded", async () => {
  const f = fixture();
  for (const response of [Response.json({}, { headers: { "content-length": "65537" } }), new Response(new ReadableStream({ start(c) { for (let i = 0; i < 4097; i++) c.enqueue(new Uint8Array([32])); c.close(); } }), { headers: { "content-type": "application/json" } })]) await assert.rejects(createRitualClient({ ...f.options, fetch: async () => response }).list(coupleId), code("response_too_large"));
  for (const response of [new Response("{}"), new Response(new Uint8Array([255]), { headers: { "content-type": "application/json" } })]) await assert.rejects(createRitualClient({ ...f.options, fetch: async () => response }).list(coupleId), code("invalid_response"));
  const moved = Response.json({}); Object.defineProperty(moved, "url", { value: "https://foreign.test/api/memories" }); await assert.rejects(createRitualClient({ ...f.options, fetch: async () => moved }).list(coupleId), code("invalid_response"));
});
test("stalled tokens and streams are timed out and local abort never sends another operation", async () => {
  const f = fixture(); await assert.rejects(createRitualClient({ ...f.options, accessToken: () => new Promise(() => {}), timeoutMs: 5 }).list(coupleId), code("timeout"));
  let cancelled = false;
  await assert.rejects(createRitualClient({ ...f.options, timeoutMs: 5, fetch: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "content-type": "application/json" } }) }).list(coupleId), code("timeout")); assert.equal(cancelled, true);
  const controller = new AbortController(); controller.abort(); await assert.rejects(f.client.pause(coupleId, id(), 0, controller.signal), code("cancelled")); assert.equal(f.calls.length, 0);
});
test("public error mapping preserves actionable conflicts and bounded backoff without provider text", async () => {
  const f = fixture();
  for (const [error, status, expected] of [["rate_limited", 429, "rate_limited"], ["schedule_changed", 409, "schedule_changed"], ["no_future_occurrence", 409, "no_future_occurrence"], ["unavailable", 503, "unavailable"], ["private-provider-error", 500, "unavailable"]] as const) {
    const client = createRitualClient({ ...f.options, fetch: async () => Response.json({ error }, { status, headers: { "retry-after": "17" } }) });
    await assert.rejects(client.list(coupleId), error => code(expected)(error) && (status !== 429 || (error as RitualClientError).retryAfterSeconds === 17));
  }
});
