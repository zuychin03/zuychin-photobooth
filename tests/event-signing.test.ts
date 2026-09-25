import assert from "node:assert/strict";
import test from "node:test";
import { EVENT_LIMITS, EVENT_TRANSPORT_LIMITS, type EventUploadAuthorisation } from "../lib/events/contract";
import { createEventObjects } from "../lib/server/event-objects";
import { createEventHandler, type EventRequestPorts } from "../lib/server/event-requests";
import { createEventStore } from "../lib/server/event-store";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const event = id(1), submission = id(2), guest = id(3), origin = "https://storage.example", key = "synthetic-service-key";
const initial = Date.parse("2026-09-23T00:00:00Z"), iso = (time: number) => new Date(time).toISOString();
const authorisation = (now = initial): EventUploadAuthorisation => ({ bucket: "photobooth-event-images-staging-v2", path: `${event}/${submission}/source`, generation: 1, mintBefore: iso(now + 60000), authorisationUntil: iso(now + 7260000), cleanupAfter: iso(now + 7560000), maxBytes: 2000000, overwrite: false });
const access = { bucket: "photobooth-events-v2" as const, path: `${event}/${submission}/image`, maxAgeSeconds: 300 };
const jwt = (claims: Record<string, unknown>) => `${Buffer.from('{"alg":"HS256"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.synthetic`;
const response = (url: string, body: unknown, status = 200) => Object.defineProperty(new Response(JSON.stringify(body), { status }), "url", { value: url });
const transport = (fn: (url: string, init: RequestInit) => Response | Promise<Response>): typeof fetch => async (url, init) => fn(String(url), init!);
const uploadUrl = (claims: Record<string, unknown> = {}, now = initial) => `/object/upload/sign/${authorisation().bucket}/${authorisation().path}?token=${jwt({ url: `${authorisation().bucket}/${authorisation().path}`, exp: now / 1000 + 7200, upsert: false, scope: "upload", ...claims })}`;
const readUrl = (claims: Record<string, unknown> = {}, now = initial) => `/object/sign/${access.bucket}/${access.path}?token=${jwt({ url: `${access.bucket}/${access.path}`, exp: now / 1000 + 290, scope: "download", ...claims })}`;

test("event upload signing uses immutable SDK protocol and validates fixed path and native lifetime", async () => {
  const objects = createEventObjects({ origin, serviceRoleKey: key }, { now: () => initial, fetch: transport((url, init) => {
    assert.equal(url, `${origin}/storage/v1/object/upload/sign/${authorisation().bucket}/${authorisation().path}`);
    assert.equal(init.method, "POST"); assert.equal(new Headers(init.headers).has("x-upsert"), false);
    assert.equal(init.redirect, "error"); assert.equal(init.cache, "no-store"); assert.equal(init.credentials, "omit");
    assert.deepEqual(JSON.parse(init.body as string), {}); return response(url, { url: uploadUrl() });
  }) });
  const signed = await objects.mintUpload(authorisation());
  assert.equal(signed.expiresAt, iso(initial + 7200000)); assert(signed.signedUrl.startsWith(origin));
  assert.deepEqual(Object.keys(signed).sort(), ["expiresAt", "signedUrl"]);
});

test("wrong upload path, scope, overwrite, malformed token and excessive expiry are rejected", async () => {
  const bad = [uploadUrl({ url: `foreign/${submission}/source` }), uploadUrl({ upsert: true }), uploadUrl({ scope: "download" }), uploadUrl({ exp: initial / 1000 + 7261 }), uploadUrl({ exp: initial / 1000 - 1 }), uploadUrl({ exp: "later" }), uploadUrl().replace("?token=", "?extra=x&token="), uploadUrl().replace("/object/", "https://foreign.example/object/"), uploadUrl().split("?")[0] + "?token=opaque"];
  for (const url of bad) await assert.rejects(createEventObjects({ origin, serviceRoleKey: key }, { now: () => initial, fetch: transport(requestUrl => response(requestUrl, { url })) }).mintUpload(authorisation()), /provider_failure/);
});

test("mint deadline fences before request and after a late response", async () => {
  let calls = 0, time = initial;
  const objects = createEventObjects({ origin, serviceRoleKey: key }, { now: () => time, fetch: transport(url => { calls++; time += 60000; return response(url, { url: uploadUrl() }); }) });
  await assert.rejects(objects.mintUpload(authorisation()), /mint_expired/); assert.equal(calls, 1);
  await assert.rejects(objects.mintUpload(authorisation()), /mint_expired/); assert.equal(calls, 1);
  await assert.rejects(objects.mintUpload({ ...authorisation(time), path: `${event}/${submission}/image` }), /invalid_descriptor/); assert.equal(calls, 1);
});

test("receipt signing reserves latency headroom and bounds token to immutable promised retention", async () => {
  let requested = 0;
  const objects = createEventObjects({ origin, serviceRoleKey: key }, { now: () => initial, fetch: transport((url, init) => {
    requested = JSON.parse(init.body as string).expiresIn;
    return response(url, { signedURL: readUrl({ exp: initial / 1000 + requested }) });
  }) });
  assert.equal((await objects.signRead(access, iso(initial + 86400000))).expiresAt, iso(initial + 290000)); assert.equal(requested, 290);
  assert.equal((await objects.signRead(access, iso(initial + 40000))).expiresAt, iso(initial + 30000)); assert.equal(requested, 30);
  await assert.rejects(objects.signRead(access, iso(initial + 10000)), /mint_expired/);
});

test("receipt signing rejects provider grants beyond deadline and inappropriate scope claims", async () => {
  for (const claims of [{ exp: initial / 1000 + 301 }, { upsert: false }, { owner: id(4) }, { role: "service_role" }, { scope: "upload" }, { url: `${access.bucket}/${event}/${id(9)}/image` }]) {
    const objects = createEventObjects({ origin, serviceRoleKey: key }, { now: () => initial, fetch: transport(url => response(url, { signedURL: readUrl(claims) })) });
    await assert.rejects(objects.signRead(access, iso(initial + 86400000)), /provider_failure/);
  }
});

function fixture() {
  const env = { PB_EVENTS_ENABLED: "true", PB_EVENT_TRANSPORT_SECRET: "synthetic-secret-at-least-thirty-two-characters", PB_EVENT_TRUSTED_IP_HEADER: "x-test-ip", PB_PUBLIC_ORIGIN: "https://booth.example", NEXT_PUBLIC_SUPABASE_URL: origin, SUPABASE_SERVICE_ROLE_KEY: key };
  const calls: string[] = []; let revoked = false, deniedRead = false, state = "ready", afterMint: () => void = () => {}, providerCalls = 0;
  const receipt = () => ({ submissionId: submission, state, logicalExpiresAt: iso(Date.now() + 600000), eventExpiresAt: iso(Date.now() + 86400000), gallery: "private", wall: "private" });
  const ports: EventRequestPorts = {
    readiness: () => ({ status: async () => ({ version: 1, ready: true, verifiedAt: new Date().toISOString(), pending: 0, maxPending: 2, heartbeatMaxAgeSeconds: 150 }), verified: async () => { throw new Error("HTTP cannot heartbeat"); } }),
    authenticate: async () => { throw new Error("guest must not authenticate an account"); },
    store: current => createEventStore(current, { rpc: async (name, args) => {
      calls.push(name);
      if (name === "pb_event_capabilities") return { data: { version: 1, ready: true, deploymentBytes: 250000000, allocatedBytes: 0, limits: EVENT_LIMITS }, error: null };
      if (name === "pb_event_transport_capabilities") return { data: EVENT_TRANSPORT_LIMITS, error: null };
      if (name === "pb_event_check_rate") return { data: { allowed: true, retryAfterSeconds: 0 }, error: null };
      if (name === "pb_event_session") return revoked ? { data: null, error: { message: "PB_EVENT_DENIED" } } : { data: { eventId: event, kind: args.p_kind, guestId: guest, submissionId: args.p_kind === "receipt" ? submission : null, expiresAt: iso(Date.now() + 86400000) }, error: null };
      if (name === "pb_event_authorise_upload") return { data: authorisation(Date.now()), error: null };
      if (name === "pb_event_receipt") return { data: receipt(), error: null };
      if (name === "pb_event_read_access") return deniedRead ? { data: null, error: { message: "PB_EVENT_DENIED" } } : { data: access, error: null };
      throw new Error(`unexpected fixture call ${name}`);
    } }),
    objects: () => createEventObjects({ origin, serviceRoleKey: key }, { fetch: transport((url, init) => {
      providerCalls++; const at = Math.floor(Date.now() / 1000) * 1000;
      const result = url.includes("/upload/") ? { url: uploadUrl({}, at) } : { signedURL: readUrl({ exp: at / 1000 + JSON.parse(init.body as string).expiresIn }, at) };
      afterMint(); return response(url, result);
    }) }),
  };
  const token = Buffer.alloc(32, 1).toString("base64url");
  const run = (route: "guest" | "receipt", body: unknown, controller?: AbortController) => createEventHandler(route, ports, () => env)(new Request(`https://booth.example/api/events/${event}`, { method: "POST", signal: controller?.signal, headers: { origin: env.PB_PUBLIC_ORIGIN, "content-type": "application/json", "x-test-ip": "192.0.2.1", cookie: `__Host-pb-event-${route === "guest" ? "contribute" : "receipt"}=${token}` }, body: JSON.stringify(body) }), event, submission);
  return { run, calls, providerCalls: () => providerCalls, setAfterMint: (fn: () => void) => { afterMint = fn; }, revoke: () => { revoked = true; }, denyRead: () => { deniedRead = true; }, setState: (v: string) => { state = v; } };
}

test("guest upload endpoint persists authorisation before provider mint and returns only exact upload descriptor", async () => {
  const f = fixture(), result = await f.run("guest", { operation: "upload", submissionId: submission, expectedGuestId: guest });
  assert.equal(result.status, 200); const data = await result.json();
  assert.equal(data.submissionId, submission); assert.equal(data.path, authorisation().path); assert.equal(data.overwrite, false); assert.equal(data.maxBytes, 2000000);
  assert.equal(data.token, undefined); assert.equal(data.generation, undefined); assert.equal(result.headers.get("cache-control"), "private, no-store");
  assert(f.calls.includes("pb_event_authorise_upload")); assert(f.calls.filter(name => name === "pb_event_check_rate").length >= 2); assert.equal(f.providerCalls(), 1);
});

test("swapped guest cookie, revocation during mint and caller abort cannot release upload capability", async () => {
  const f = fixture(); assert.equal((await f.run("guest", { operation: "upload", submissionId: submission, expectedGuestId: id(9) })).status, 403); assert.equal(f.providerCalls(), 0); assert(!f.calls.includes("pb_event_authorise_upload"));
  f.setAfterMint(f.revoke); assert.equal((await f.run("guest", { operation: "upload", submissionId: submission, expectedGuestId: guest })).status, 403);
  const aborted = fixture(), controller = new AbortController(); aborted.setAfterMint(() => controller.abort());
  const result = await aborted.run("guest", { operation: "upload", submissionId: submission, expectedGuestId: guest }, controller); assert.equal(result.status, 503); assert(!(await result.text()).includes("signedUrl"));
});

test("receipt media requires ready exact receipt and reauthorises after signing", async () => {
  const f = fixture(), result = await f.run("receipt", { operation: "media" }); assert.equal(result.status, 200);
  const data = await result.json(); assert.equal(data.bucket, access.bucket); assert.equal(data.path, access.path); assert.equal(data.mime, "image/jpeg"); assert.equal(data.sha256, undefined);
  assert.equal(f.calls.filter(name => name === "pb_event_read_access").length, 2);
  assert.equal(f.calls.filter(name => name === "pb_event_session").length, 2);
  const notReady = fixture(); notReady.setState("finalising"); assert.equal((await notReady.run("receipt", { operation: "media" })).status, 409); assert.equal(notReady.providerCalls(), 0);
  const revoked = fixture(); revoked.setAfterMint(revoked.denyRead); const denied = await revoked.run("receipt", { operation: "media" }); assert.equal(denied.status, 403); assert(!(await denied.text()).includes("signedUrl"));
});
