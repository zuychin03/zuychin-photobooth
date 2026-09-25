import { createEventOwnConsentStore } from "../lib/server/event-own-consent-store";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { EVENT_LIMITS, EVENT_TRANSPORT_LIMITS } from "../lib/events/contract";
import { createEventHandler, type EventRequestPorts, type EventRoute } from "../lib/server/event-requests";
import { createEventStore, verifyEventActor } from "../lib/server/event-store";
import { createEventGuestClient, createEventHostClient } from "../lib/events/client";

const owner = "10000000-0000-4000-8000-000000000001", event = "20000000-0000-4000-8000-000000000001", submission = "30000000-0000-4000-8000-000000000001", requestId = "40000000-0000-4000-8000-000000000001";
const token = Buffer.alloc(32, 7).toString("base64url"), nonce = Buffer.alloc(32, 8).toString("base64url"), expiry = "2099-01-01T00:00:00.000Z";
const env = { PB_EVENTS_ENABLED: "true", PB_EVENT_TRANSPORT_SECRET: "synthetic-transport-secret-at-least-32-characters", PB_EVENT_TRUSTED_IP_HEADER: "x-test-ip", PB_PUBLIC_ORIGIN: "https://booth.example", NEXT_PUBLIC_SUPABASE_URL: "https://database.example", SUPABASE_SERVICE_ROLE_KEY: "synthetic-service-key", NODE_ENV: "production" };
const input = { title: "Synthetic gathering", timezone: "Australia/Sydney", startsAt: "2026-01-01T00:00:00.000Z", closesAt: "2098-01-01T00:00:00.000Z", expiresAt: expiry, maxGuests: 25, maxContributions: 100, maxBytes: 250000000 };
const row = { id: event, title: input.title, timezone: input.timezone, starts_at: input.startsAt, contribution_closes_at: input.closesAt, expires_at: expiry, max_guests: 25, max_contributions: 100, max_bytes: 250000000, status: "open", owner_id: owner, creation_fingerprint: { secret: "must never escape" }, maintained_at: "private" };
const receipt = { submissionId: submission, state: "reserved", logicalExpiresAt: expiry, eventExpiresAt: expiry, gallery: "private", wall: "private" };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function fixture(rpcExpiry?: string) {
  const calls: { name: string; args: Record<string, unknown> }[] = [], sessions = new Map<string, { eventId: string; kind: string; guestId: string; submissionId: string | null; expiresAt: string }>();
  let allowed = true, support = true, revoked = false, authenticated = 0;
  const ports: EventRequestPorts = {
    readiness: () => ({ status: async () => ({ version: 1, ready: true, verifiedAt: new Date().toISOString(), pending: 0, maxPending: 2, heartbeatMaxAgeSeconds: 150 }), verified: async () => { throw new Error("HTTP cannot heartbeat"); } }),
    authenticate: async value => { assert.equal(value, "synthetic-auth-bearer"); authenticated++; return verifyEventActor({ getUser: async () => ({ data: { user: { id: owner } }, error: null }) }); },
    store: currentEnv => createEventStore(currentEnv, { rpc: async (name, args) => {
      calls.push({ name, args }); let data: unknown = null;
      if (name === "pb_event_transport_capabilities") data = { ...EVENT_TRANSPORT_LIMITS, version: support ? 1 : 0 };
      else if (name === "pb_event_capabilities") data = { version: 1, ready: true, deploymentBytes: 250000000, allocatedBytes: 0, limits: EVENT_LIMITS };
      else if (name === "pb_event_check_rate") data = { allowed, retryAfterSeconds: allowed ? 0 : 42 };
      else if (name === "pb_event_create" || name === "pb_event_manage") data = args.p_action === "accept_moderator" ? { accepted: true } : row;
      else if (name === "pb_event_dashboard") data = { event: row, submissions: [receipt], usage: { guests: 1, count: 1, bytes: 4100000, stagingBytes: 2000000, derivativeBytes: 2100000 }, privateToken: "must never escape" };
      else if (name === "pb_event_issue_capability") data = { kind: args.p_kind, expiresAt: rpcExpiry ?? args.p_expires };
      else if (name === "pb_event_redeem") { assert.equal(args.p_invite_hash, hash(token)); sessions.set(String(args.p_contribute_hash), { eventId: String(args.p_event), kind: "contribute", guestId: String(args.p_guest), submissionId: null, expiresAt: expiry }); data = { guestId: args.p_guest }; }
      else if (name === "pb_event_session") {
        const session = sessions.get(String(args.p_hash));
        if (revoked || !session || session.eventId !== args.p_event || session.kind !== args.p_kind || session.submissionId !== args.p_submission) return { data: null, error: { message: "PB_EVENT_DENIED" } };
        data = { ...session, expiresAt: rpcExpiry ?? session.expiresAt };
      } else if (name === "pb_event_reserve") {
        const session = sessions.get(String(args.p_token))!; assert.deepEqual(args.p_contributors, [session.guestId]);
        sessions.set(String(args.p_receipt_hash), { ...session, kind: "receipt", submissionId: String(args.p_submission) });
        data = { ...receipt, stagingPath: `${event}/${submission}/source`, stagingHeldBytes: 2000000, derivativeHeldBytes: 2100000 };
      } else if (["pb_event_receipt", "pb_event_consent", "pb_event_enqueue_finalise"].includes(name)) data = receipt;
      else throw new Error(`Unexpected fixture RPC ${name}`);
      return { data, error: null };
    } }),
  };
  const request = (body: unknown, cookie?: string, auth = false, overrides: RequestInit = {}) => new Request(`https://booth.example/api/events/${event}`, { method: "POST", headers: { origin: "https://booth.example", "content-type": "application/json", "x-test-ip": "192.0.2.1", ...(cookie ? { cookie } : {}), ...(auth ? { authorization: "Bearer synthetic-auth-bearer" } : {}) }, body: JSON.stringify(body), ...overrides });
  const run = (route: EventRoute, body: unknown, cookie?: string, auth = false) => createEventHandler(route, ports, () => env)(request(body, cookie, auth), event, submission);
  return { calls, ports, request, run, sessions, setAllowed: (v: boolean) => { allowed = v; }, setSupport: (v: boolean) => { support = v; }, revoke: () => { revoked = true; }, authenticated: () => authenticated };
}

test("PostgreSQL expiry offsets survive the real store, HTTP handler and strict browser clients", async () => {
  for (const rpcExpiry of ["2099-01-01T00:00:00+00:00", "2099-01-01T10:30:00+10:30"]) {
    const f = fixture(rpcExpiry);
    const bridge = (route: EventRoute): typeof fetch => async (_input, init) => f.run(route, JSON.parse(String(init?.body)), undefined, route === "host");
    const host = createEventHostClient({ appOrigin: env.PB_PUBLIC_ORIGIN, identity: () => ({ ownerId: owner, epoch: 1 }), accessToken: async () => "synthetic-auth-bearer", fetch: bridge("host") });
    const guest = createEventGuestClient({ appOrigin: env.PB_PUBLIC_ORIGIN, eventId: event, identity: () => null, fetch: bridge("guest") });
    try {
      const issued = await host.issue(event, { requestId, kind: "invite", expiresAt: expiry, rotate: false });
      assert.equal(issued.expiresAt, expiry);
      const redeemed = await guest.redeem(token, nonce);
      assert.equal(redeemed.expiresAt, expiry);
      assert(f.calls.some(call => call.name === "pb_event_issue_capability"));
      assert(f.calls.some(call => call.name === "pb_event_session"));
    } finally { host.close(); guest.close(); }
  }
});

test("disabled, wrong-origin, query-token and non-POST requests cannot touch the event store", async () => {
  const f = fixture();
  assert.equal((await createEventHandler("root", f.ports, () => ({ ...env, PB_EVENTS_ENABLED: "false" }))(f.request({ operation: "capabilities" }))).status, 503);
  assert.equal((await createEventHandler("root", f.ports, () => env)(f.request({}, undefined, false, { headers: { origin: "https://foreign.example" } }))).status, 403);
  assert.equal((await createEventHandler("root", f.ports, () => env)(new Request(`https://booth.example/api/events?token=${token}`, { method: "POST", headers: { origin: env.PB_PUBLIC_ORIGIN } }))).status, 400);
  const get = await createEventHandler("root", f.ports, () => env)(new Request("https://booth.example/api/events")); assert.equal(get.status, 405); assert.equal(get.headers.get("cache-control"), "private, no-store"); assert.equal(f.calls.length, 0);
});

test("durable rate denial and missing transport schema prevent authenticated mutation", async () => {
  const f = fixture(); f.setAllowed(false);
  const limited = await f.run("root", { operation: "create", eventId: event, event: input }, undefined, true);
  assert.equal(limited.status, 429); assert.equal(limited.headers.get("retry-after"), "42"); assert.equal(f.authenticated(), 0);
  f.setAllowed(true); f.setSupport(false); assert.equal((await f.run("root", { operation: "create", eventId: event, event: input }, undefined, true)).status, 503);
  assert(!f.calls.some(call => call.name === "pb_event_create"));
});

test("host auth derives the service actor and public projections omit raw database fields", async () => {
  const f = fixture();
  assert.equal((await f.run("root", { operation: "create", eventId: event, event: input })).status, 401);
  assert.equal((await f.run("root", { operation: "create", eventId: event, event: input, actor: owner }, undefined, true)).status, 400);
  const response = await f.run("root", { operation: "create", eventId: event, event: input }, undefined, true), body = await response.json();
  assert.equal(response.status, 201); assert.equal(body.eventId, event); assert(!JSON.stringify(body).includes("fingerprint"));
  assert.equal(f.calls.find(call => call.name === "pb_event_create")!.args.p_actor, owner);
  const dashboard = await f.run("host", { operation: "dashboard" }, undefined, true); assert.equal(dashboard.status, 200); assert(!(await dashboard.text()).includes("must never escape"));
});

test("invite redemption is account-free, deterministic on retry and creates only a secure bounded contribution cookie", async () => {
  const f = fixture(), body = { operation: "redeem", inviteToken: token, nonce };
  const first = await f.run("guest", body), second = await f.run("guest", body);
  assert.equal(first.status, 201); assert.equal(second.status, 201); assert.equal(f.authenticated(), 0);
  const header = first.headers.get("set-cookie")!; assert.match(header, /^__Host-pb-event-contribute=/); assert.match(header, /Path=\/;/); assert.match(header, /HttpOnly; SameSite=Strict; Secure$/); assert(!header.includes("Domain="));
  assert.equal(header.split(";")[0], second.headers.get("set-cookie")!.split(";")[0]);
  const data = await first.text(); assert(!data.includes(token)); assert(!data.includes(nonce)); assert(!data.includes("contributeHash"));
  const redeems = f.calls.filter(call => call.name === "pb_event_redeem"); assert.deepEqual(redeems[0].args, redeems[1].args);
  assert.equal(first.headers.get("referrer-policy"), "no-referrer"); assert.equal(first.headers.get("cache-control"), "private, no-store");
});

test("reservation creates a private receipt before upload, preserves consent and separates cookie powers", async () => {
  const f = fixture(), guest = await f.run("guest", { operation: "redeem", inviteToken: token, nonce });
  const contributionCookie = guest.headers.get("set-cookie")!.split(";")[0];
  const reserved = await f.run("guest", { operation: "reserve", requestId, submissionId: submission, expectedGuestId: (await guest.clone().json()).guestId, consent: { submission: true, gallery: false, wall: false } }, contributionCookie);
  assert.equal(reserved.status, 201); const data = await reserved.json(); assert.equal(data.receipt.state, "reserved"); assert.equal(data.receipt.gallery, "private"); assert.equal(data.receipt.wall, "private"); assert(!JSON.stringify(data).includes("staging"));
  const receiptCookie = reserved.headers.get("set-cookie")!.split(";")[0]; assert.match(receiptCookie, /^__Host-pb-event-receipt=/);
  assert.equal((await f.run("receipt", { operation: "read" }, contributionCookie)).status, 403);
  assert.equal((await f.run("guest", { operation: "session" }, receiptCookie)).status, 403);
  assert.equal((await f.run("receipt", { operation: "read" }, receiptCookie)).status, 200);
  assert.equal((await f.run("receipt", { operation: "exchange", token: data.receiptToken })).status, 200);
  assert.equal((await f.run("receipt", { operation: "exchange", token: contributionCookie.split("=")[1] })).status, 403);
  f.revoke(); assert.equal((await f.run("receipt", { operation: "read" }, receiptCookie)).status, 403);
});

test("cross-event/submission and duplicate cookies are rejected without receipt data", async () => {
  const f = fixture(), guest = await f.run("guest", { operation: "redeem", inviteToken: token, nonce });
  const c = guest.headers.get("set-cookie")!.split(";")[0];
  assert.equal((await f.run("guest", { operation: "session" }, `${c}; ${c}`)).status, 403);
  const foreign = await createEventHandler("guest", f.ports, () => env)(f.request({ operation: "session" }, c), "20000000-0000-4000-8000-000000000002"); assert.equal(foreign.status, 403);
  const reserved = await f.run("guest", { operation: "reserve", requestId, submissionId: submission, expectedGuestId: (await guest.clone().json()).guestId, consent: { submission: true, gallery: true, wall: false } }, c);
  const read = await createEventHandler("receipt", f.ports, () => env)(f.request({ operation: "read" }, reserved.headers.get("set-cookie")!.split(";")[0]), event, "30000000-0000-4000-8000-000000000002"); assert.equal(read.status, 403);
});

test("host issuance hashes server-derived tokens, retains exact retries and cannot accept caller hash authority", async () => {
  const f = fixture(), body = { operation: "issue", requestId, kind: "invite", expiresAt: expiry, rotate: false };
  const a = await f.run("host", body, undefined, true), b = await f.run("host", body, undefined, true);
  const first = await a.json(), second = await b.json(); assert.equal(a.status, 201); assert.equal(first.token, second.token);
  const issued = f.calls.find(call => call.name === "pb_event_issue_capability")!; assert.equal(issued.args.p_hash, hash(first.token)); assert.equal(issued.args.p_actor, owner);
  assert.equal((await f.run("host", { ...body, hash: "a".repeat(64) }, undefined, true)).status, 400);
  assert.equal((await f.run("host", { operation: "manage", action: "invite", body: { hash: "a".repeat(64) } }, undefined, true)).status, 400);
});

test("a replaced contribution cookie cannot mutate under a previously selected guest", async () => {
  const f = fixture(), guest = await f.run("guest", { operation: "redeem", inviteToken: token, nonce }), cookie = guest.headers.get("set-cookie")!.split(";")[0];
  for (const operation of ["reserve", "consent", "finalise"]) {
    const body = { operation, submissionId: submission, expectedGuestId: owner, ...(operation === "reserve" ? { requestId } : {}), ...(operation !== "finalise" ? { consent: { submission: true, gallery: false, wall: false } } : {}) };
    assert.equal((await f.run("guest", body, cookie)).status, 403);
  }
  assert(!f.calls.some(call => ["pb_event_reserve", "pb_event_consent", "pb_event_enqueue_finalise"].includes(call.name)));
});

test("body limits, invalid consent, identities and provider operations cannot dispatch mutations", async () => {
  const f = fixture();
  assert.equal((await createEventHandler("root", f.ports, () => env)(f.request({ padding: "x".repeat(8193) }))).status, 413);
  assert.equal((await f.run("root", { operation: "create", eventId: event, event: { ...input, maxBytes: 250000001 } }, undefined, true)).status, 400);
  assert.equal((await f.run("root", { operation: "create", eventId: event, event: { ...input, startsAt: "2026-02-31T12:00:00Z" } }, undefined, true)).status, 400);
  const guest = await f.run("guest", { operation: "redeem", inviteToken: token, nonce }), c = guest.headers.get("set-cookie")!.split(";")[0];
  assert.equal((await f.run("guest", { operation: "reserve", requestId, submissionId: submission, expectedGuestId: (await guest.clone().json()).guestId, consent: { submission: false, gallery: false, wall: false } }, c)).status, 400);
  assert.equal((await f.run("guest", { operation: "authoriseUpload", submissionId: submission }, c)).status, 400);
  assert(!f.calls.some(call => ["pb_event_create", "pb_event_reserve", "pb_event_authorise_upload"].includes(call.name)));
});

test("excessive empty body chunks are bounded before any service work", async () => {
  const f = fixture(), body = new ReadableStream<Uint8Array>({ start(controller) { for (let index = 0; index < 4097; index++) controller.enqueue(new Uint8Array()); controller.close(); } });
  const request = new Request("https://booth.example/api/events", { method: "POST", headers: { origin: env.PB_PUBLIC_ORIGIN, "content-type": "application/json", "x-test-ip": "192.0.2.1" }, body, duplex: "half" } as RequestInit);
  const response = await createEventHandler("root", f.ports, () => env)(request); assert.equal(response.status, 413); assert.equal(f.calls.length, 0);
});

test("expired verified session cannot install a cookie and cancellation cannot attach a late session", async () => {
  const f = fixture(); let finish: (() => void) | undefined, entered: (() => void) | undefined;
  const inSession = new Promise<void>(resolve => { entered = resolve; });
  const latePorts: EventRequestPorts = { ...f.ports, store: (currentEnv, signal) => {
    const store = f.ports.store(currentEnv, signal); return { ...store, session: async (...args) => { const value = await store.session(...args); entered!(); await new Promise<void>(resolve => { finish = resolve; }); return value; } };
  } };
  const controller = new AbortController(), request = f.request({ operation: "redeem", inviteToken: token, nonce }, undefined, false, { signal: controller.signal });
  const pending = createEventHandler("guest", latePorts, () => env)(request, event); await inSession; controller.abort();
  const response = await pending; assert.equal(response.status, 503); assert.equal(response.headers.get("set-cookie"), null); finish!(); await new Promise(resolve => setImmediate(resolve));
  const expiredPorts: EventRequestPorts = { ...f.ports, store: (currentEnv, signal) => { const store = f.ports.store(currentEnv, signal); return { ...store, session: async (...args) => ({ ...await store.session(...args), expiresAt: "2000-01-01T00:00:00Z" }) }; } };
  const expired = await createEventHandler("guest", expiredPorts, () => env)(f.request({ operation: "redeem", inviteToken: token, nonce }), event);
  assert.equal(expired.status, 410); assert.equal(expired.headers.get("set-cookie"), null);
});

test("local development allows loopback HTTP without Secure, production refuses it", async () => {
  const f = fixture(), local = { ...env, NODE_ENV: "development", PB_PUBLIC_ORIGIN: undefined, PB_EVENT_TRUSTED_IP_HEADER: undefined };
  const req = () => new Request(`http://127.0.0.1:3005/api/events/${event}/guest`, { method: "POST", headers: { origin: "http://127.0.0.1:3005", "content-type": "application/json" }, body: JSON.stringify({ operation: "redeem", inviteToken: token, nonce }) });
  const response = await createEventHandler("guest", f.ports, () => local)(req(), event); assert.equal(response.status, 201); assert.match(response.headers.get("set-cookie")!, /^pb-event-contribute=/); assert(!response.headers.get("set-cookie")!.includes("; Secure"));
  assert.equal((await createEventHandler("guest", f.ports, () => env)(req(), event)).status, 503);
});



test("own consent read and CAS mutation require exact contributor session and strict revision body", async () => {
  const f = fixture(); let calls = 0;
  f.ports.ownConsent = () => createEventOwnConsentStore({ rpc: async (name, args) => { calls++; assert.equal(name, "pb_event_own_consent"); assert.equal(args.p_event, event); assert.equal(args.p_submission, submission); assert.equal(typeof args.p_hash, "string"); assert.equal(args.p_guest, guestId); return { error: null, data: { version: 1, eventId: event, submissionId: submission, revision: 7, consent: { submission: true, gallery: args.p_gallery ?? false, wall: args.p_wall ?? true }, receipt } }; } });
  const joined = await f.run("guest", { operation: "redeem", inviteToken: token, nonce }), guestId = (await joined.json()).guestId, cookie = joined.headers.get("set-cookie")!.split(";")[0];
  const read = { operation: "ownConsent", submissionId: submission, expectedGuestId: guestId };
  assert.equal((await f.run("guest", read, cookie)).status, 200);
  assert.equal((await f.run("guest", { ...read, expectedGuestId: owner }, cookie)).status, 403); assert.equal(calls, 1);
  assert.equal((await f.run("guest", { ...read, operation: "saveOwnConsent", expectedRevision: 7, gallery: false, wall: false }, cookie)).status, 200);
  assert.equal((await f.run("guest", { ...read, operation: "saveOwnConsent", expectedRevision: 7, gallery: "false", wall: false }, cookie)).status, 400); assert.equal(calls, 2);
  assert.equal((await f.run("receipt", { operation: "saveOwnConsent", expectedRevision: 7, gallery: true, wall: true }, cookie)).status, 400);
});
