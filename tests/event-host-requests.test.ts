import assert from "node:assert/strict";
import test from "node:test";
import { EVENT_LIMITS, EVENT_TRANSPORT_LIMITS } from "../lib/events/contract";
import { DEFAULT_EVENT_LOOK, EVENT_HOST_LIMITS } from "../lib/events/host-contract";
import { createEventHandler, type EventRequestPorts, type EventRoute } from "../lib/server/event-requests";
import { createEventStore, verifyEventActor, type EventRpcClient } from "../lib/server/event-store";
import { createEventHostStore } from "../lib/server/event-host-store";

const owner = "10000000-0000-4000-8000-000000000001", eventId = "20000000-0000-4000-8000-000000000001", requestId = "30000000-0000-4000-8000-000000000001";
const env = { PB_EVENTS_ENABLED: "true", PB_EVENT_TRANSPORT_SECRET: "synthetic-transport-secret-at-least-32-characters", PB_EVENT_TRUSTED_IP_HEADER: "x-test-ip", PB_PUBLIC_ORIGIN: "https://booth.example", NEXT_PUBLIC_SUPABASE_URL: "https://database.example", SUPABASE_SERVICE_ROLE_KEY: "synthetic-only", NODE_ENV: "production" };
const event = { title: "Synthetic event", timezone: "Australia/Sydney", startsAt: "2026-01-01T00:00:00.000Z", closesAt: "2098-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z", maxGuests: 25, maxContributions: 100, maxBytes: 250000000 };
const settings = { version: 1, eventId, revision: 7, locked: false, event, look: DEFAULT_EVENT_LOOK };
const summary = { eventId, title: event.title, timezone: event.timezone, startsAt: event.startsAt, closesAt: event.closesAt, expiresAt: event.expiresAt, status: "draft", role: "owner", membership: "active" };
function fixture() {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  let response: unknown = settings, allowed = true, compatible = true, failure: string | null = null;
  const rpc: EventRpcClient = { rpc: async (name, args) => {
    calls.push({ name, args });
    if (name === "pb_event_capabilities") return { data: { version: 1, ready: true, deploymentBytes: 250000000, allocatedBytes: 0, limits: EVENT_LIMITS }, error: null };
    if (name === "pb_event_transport_capabilities") return { data: EVENT_TRANSPORT_LIMITS, error: null };
    if (name === "pb_event_check_rate") return { data: { allowed, retryAfterSeconds: allowed ? 0 : 30 }, error: null };
    if (name === "pb_event_host_capabilities") return { data: compatible ? EVENT_HOST_LIMITS : null, error: compatible ? null : { message: "function missing" } };
    if (name === "pb_event_session") return { data: { eventId, guestId: owner, kind: "contribute", submissionId: null, expiresAt: event.expiresAt }, error: null };
    return { data: failure ? null : response, error: failure ? { message: failure } : null };
  } };
  const ports: EventRequestPorts = { readiness: () => ({ status: async () => ({ version: 1, ready: true, verifiedAt: new Date().toISOString(), pending: 0, maxPending: 2, heartbeatMaxAgeSeconds: 150 }), verified: async () => { throw new Error("HTTP cannot heartbeat"); } }), store: input => createEventStore(input, rpc), hostStore: (input, signal) => { assert.equal(signal.aborted, false); return createEventHostStore(input, rpc); }, authenticate: async token => { assert.equal(token, "synthetic-bearer"); return verifyEventActor({ getUser: async () => ({ data: { user: { id: owner } }, error: null }) }); } };
  const request = (body: unknown, authenticated = true, origin = env.PB_PUBLIC_ORIGIN, signal?: AbortSignal) => new Request(`${env.PB_PUBLIC_ORIGIN}/api/events/${eventId}`, { method: "POST", headers: { origin, "content-type": "application/json", "x-test-ip": "192.0.2.1", ...(authenticated ? { authorization: "Bearer synthetic-bearer" } : {}) }, body: JSON.stringify(body), signal });
  const run = (route: EventRoute, body: unknown, authenticated = true) => createEventHandler(route, ports, () => env)(request(body, authenticated), eventId);
  return { ports, calls, request, run, result: (value: unknown) => { response = value; }, limit: () => { allowed = false; }, old: () => { compatible = false; }, fail: (code: string) => { failure = code; } };
}

test("host capability is separate and old event servers retain base capability responses", async () => {
  const f = fixture(); assert.equal((await (await f.run("root", { operation: "capabilities" }, false)).json()).hostVersion, 1);
  f.old(); const legacy = await f.run("root", { operation: "capabilities" }, false);
  assert.equal(legacy.status, 200); assert.equal((await legacy.json()).hostVersion, 0);
  delete f.ports.hostStore;
  assert.equal((await (await f.run("root", { operation: "capabilities" }, false)).json()).hostVersion, 0);
  assert.equal((await f.run("root", { operation: "list" })).status, 503);
});
test("discovery uses verified auth, read budgets and bounded keyset input without foreign fields", async () => {
  const f = fixture(); f.result({ version: 1, events: [summary], nextCursor: null });
  assert.equal((await f.run("root", { operation: "list" }, false)).status, 401);
  for (const body of [{ operation: "list", actor: owner }, { operation: "list", limit: 26 }, { operation: "list", after: "foreign" }]) assert.equal((await f.run("root", body)).status, 400);
  assert.ok(!f.calls.some(call => call.name === "pb_event_host_list"));
  const result = await f.run("root", { operation: "list", limit: 1 }); assert.equal(result.status, 200);
  assert.equal(result.headers.get("cache-control"), "private, no-store"); assert.deepEqual(await result.json(), { version: 1, events: [summary], nextCursor: null });
  assert.equal(f.calls.find(call => call.name === "pb_event_host_list")?.args.p_actor, owner);
  assert.ok(f.calls.filter(call => call.name === "pb_event_check_rate").every(call => call.args.p_bucket === "read"));
  f.result({ version: 1, events: [{ ...summary, token: "secret" }], nextCursor: null });
  const malformed = await f.run("root", { operation: "list" }); assert.equal(malformed.status, 503); assert.ok(!(await malformed.text()).includes("secret"));
});
test("settings saves preserve exact request identity and reject excess/private look input before writes", async () => {
  const f = fixture(), body = { operation: "saveSettings", requestId, expectedRevision: 2, settings: { event, look: DEFAULT_EVENT_LOOK } };
  assert.equal((await f.run("host", { operation: "settings" })).status, 200);
  for (const bad of [{ ...body, expectedRevision: -1 }, { ...body, actor: owner }, { ...body, settings: { event, look: { ...DEFAULT_EVENT_LOOK, sourcePhotos: ["private"] } } }, { ...body, settings: { event, look: { ...DEFAULT_EVENT_LOOK, caption: "a".repeat(161) } } }]) assert.equal((await f.run("host", bad)).status, 400);
  assert.ok(!f.calls.some(call => call.name === "pb_event_save_settings"));
  for (let n = 0; n < 2; n++) { const result = await f.run("host", body); assert.equal(result.status, 200); assert.deepEqual(await result.json(), settings); }
  const writes = f.calls.filter(call => call.name === "pb_event_save_settings"); assert.deepEqual(writes[0].args, writes[1].args);
  assert.equal(writes[0].args.p_revision, 2); assert.equal(writes[0].args.p_request, requestId);
  assert.ok(f.calls.some(call => call.name === "pb_event_check_rate" && call.args.p_bucket === "write"));
  f.fail("PB_EVENT_CONFLICT"); assert.equal((await f.run("host", body)).status, 409);
  f.fail("PB_EVENT_DENIED"); assert.equal((await f.run("host", { operation: "settings" })).status, 403);
});
test("origin and rate denials stop host reads and late cancellation returns no settings", async () => {
  const f = fixture();
  assert.equal((await createEventHandler("host", f.ports, () => env)(f.request({ operation: "settings" }, true, "https://foreign.invalid"), eventId)).status, 403); assert.equal(f.calls.length, 0);
  f.limit(); const limited = await f.run("host", { operation: "settings" }); assert.equal(limited.status, 429); assert.equal(limited.headers.get("retry-after"), "30"); assert.ok(!f.calls.some(call => call.name === "pb_event_settings"));
  const g = fixture(), abort = new AbortController(); let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; }), reached = new Promise<void>(resolve => { entered = resolve; });
  const real = g.ports.hostStore!;
  g.ports.hostStore = (input, signal) => { const store = real(input, signal); return { ...store, settings: async (actor, id) => { entered(); await waiting; return store.settings(actor, id); } }; };
  const pending = createEventHandler("host", g.ports, () => env)(g.request({ operation: "settings" }, true, env.PB_PUBLIC_ORIGIN, abort.signal), eventId);
  await reached; abort.abort(); const cancelled = await pending; assert.equal(cancelled.status, 503); assert.deepEqual(await cancelled.json(), { error: "unavailable" }); release();
});

test("host capability revocation and moderator reinvites use the corrected scoped RPCs", async () => {
  const f = fixture();
  f.result({ id: eventId, title: event.title, timezone: event.timezone, starts_at: event.startsAt, contribution_closes_at: event.closesAt, expires_at: event.expiresAt, max_guests: event.maxGuests, max_contributions: event.maxContributions, max_bytes: event.maxBytes, status: "open" });
  const token = Buffer.alloc(32, 7).toString("base64url");
  assert.equal((await f.run("host", { operation: "revokeToken", token })).status, 200);
  const revoked = f.calls.find(call => call.name === "pb_event_revoke_capability"); assert.equal(revoked?.args.p_actor, owner); assert.equal(revoked?.args.p_event, eventId); assert.match(String(revoked?.args.p_hash), /^[a-f0-9]{64}$/);
  assert.equal((await f.run("host", { operation: "manage", action: "invite_moderator", body: { userId: requestId } })).status, 200);
  assert.equal(f.calls.find(call => call.name === "pb_event_invite_moderator")?.args.p_user, requestId);
  assert(!f.calls.some(call => call.name === "pb_event_manage"));
});

test("guest context uses the current contribution identity and rejects privileged projection fields", async () => {
  const f = fixture(), token = Buffer.alloc(32, 7).toString("base64url"), value = { version: 1, eventId, title: event.title, timezone: event.timezone, startsAt: event.startsAt, closesAt: event.closesAt, expiresAt: event.expiresAt, status: "open", look: DEFAULT_EVENT_LOOK, capacityAvailable: true, canReserve: true };
  const run = (expectedGuestId: string) => createEventHandler("guest", f.ports, () => env)(new Request(`${env.PB_PUBLIC_ORIGIN}/api/events/${eventId}/guest`, { method: "POST", headers: { origin: env.PB_PUBLIC_ORIGIN, "content-type": "application/json", "x-test-ip": "192.0.2.1", cookie: `__Host-pb-event-contribute=${token}` }, body: JSON.stringify({ operation: "context", expectedGuestId }) }), eventId);
  f.result(value); assert.equal((await run(requestId)).status, 403); assert(!f.calls.some(call => call.name === "pb_event_guest_context"));
  const result = await run(owner); assert.equal(result.status, 200); assert.deepEqual(await result.json(), { ...value, serviceAvailable: true }); assert.equal(result.headers.get("referrer-policy"), "no-referrer");
  f.result({ ...value, ownerId: owner }); assert.equal((await run(owner)).status, 503);
});

test("worker readiness gates advertised uploads without hiding read capability or mislabelling event capacity", async () => {
  const f = fixture(); f.ports.objects = () => ({ mintUpload: async () => { throw new Error(); }, signRead: async () => { throw new Error(); } });
  const get = async () => (await f.run("root", { operation: "capabilities" }, false)).json();
  assert.equal((await get()).uploadsAvailable, true);
  const normal = f.ports.readiness!;
  f.ports.readiness = (env, signal) => { const store = normal(env, signal); return { ...store, status: async () => ({ ...await store.status(), ready: false }) }; };
  assert.equal((await get()).uploadsAvailable, false); assert.equal((await get()).downloadsAvailable, true);
  f.ports.readiness = (env, signal) => { const store = normal(env, signal); return { ...store, status: async () => ({ ...await store.status(), pending: 2 }) }; };
  assert.equal((await get()).uploadsAvailable, false);
  delete f.ports.readiness; assert.equal((await get()).uploadsAvailable, false); assert.equal((await get()).downloadsAvailable, true);
});
