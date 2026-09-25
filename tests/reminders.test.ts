import assert from "node:assert/strict";
import test from "node:test";
import { createReminderHandler, type DueReminder, type ReminderAdapter } from "../lib/server/reminders";
import type { CronEnvironment } from "../lib/server/cron-auth";

const env: CronEnvironment = {
  CRON_SECRET: "fixture-cron-key", NEXT_PUBLIC_SUPABASE_URL: "https://db.example.test",
  SUPABASE_SERVICE_ROLE_KEY: "fixture-service-key", PB_PUBLIC_ORIGIN: "https://booth.example.test",
  RESEND_API_KEY: "fixture-email-key",
};
const date: DueReminder = { id: "date-fixture", couple_id: "couple-fixture", title: `<img src=x onerror="evil()"> & 'hello'`, scheduled_at: "2026-09-20T00:00:00Z", cadence: "once" };
const request = (authorization = "Bearer fixture-cron-key") => new Request("https://evil.example.test/api/reminders", { headers: { authorization, host: "evil.example.test", "x-forwarded-host": "evil.example.test" } });

function fixture(overrides: Partial<ReminderAdapter> = {}, config = env) {
  const calls: string[] = [];
  const emails: Parameters<ReminderAdapter["email"]>[0][] = [];
  const delivered = new Set<string>();
  let active = true;
  const adapter: ReminderAdapter = {
    acquire: async () => { calls.push("acquire"); return true; },
    release: async () => { calls.push("release"); },
    due: async (_now, limit) => { calls.push(`due:${limit}`); return active ? [date] : []; },
    recipients: async () => ({ ids: ["member-fixture"], emails: ["test@example.test"] }),
    deliveries: async () => [...delivered],
    record: async (_date, channel) => { calls.push(`record:${channel}`); delivered.add(channel); },
    complete: async () => { calls.push("complete"); active = false; },
    email: async message => { calls.push("email"); emails.push(message); return { error: null }; },
    subscriptions: async () => [],
    push: async () => { calls.push("push"); },
    removeSubscription: async () => { calls.push("removeSubscription"); },
    ...overrides,
  };
  const handler = createReminderHandler(() => { calls.push("create"); return adapter; }, () => config, () => new Date("2026-09-23T00:00:00Z"));
  return { calls, emails, delivered, adapter, handler };
}
test("event expiry work consumes the existing five-occurrence shared cron budget", async () => {
  let claims = 0, legacy = 0;
  const eventClaim = { eventId: "10000000-0000-4000-8000-000000000001", expiryRevision: 0, expiresAt: "2099-01-01T00:00:00Z", timezone: "UTC", title: "Event", token: "token", channels: [] };
  const f = fixture({ due: async () => Array.from({ length: 5 }, (_, i) => ({ ...date, id: String(i) })), complete: async () => { legacy++; }, events: { claim: async () => { claims++; return eventClaim; }, dispatch: async () => { throw new Error("no targets"); }, record: async () => {}, finish: async () => {} } }, { ...env, PB_EVENTS_ENABLED: "true", PB_EVENT_REMINDERS_ENABLED: "true" });
  const response = await f.handler(request()); assert.equal(response.status, 200); assert.equal((await response.json()).processed, 5); assert.equal(claims, 1); assert.equal(legacy, 4);
});

test("actual reminder handler rejects auth/config before creating privileged adapters", async () => {
  for (const key of ["CRON_SECRET", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "PB_PUBLIC_ORIGIN"]) {
    const f = fixture({}, { ...env, [key]: undefined });
    assert.equal((await f.handler(request())).status, 503);
    assert.deepEqual(f.calls, []);
  }
  const f = fixture();
  assert.equal((await f.handler(request("Bearer wrong"))).status, 401);
  assert.deepEqual(f.calls, []);
});

test("reminder HTML escapes titles and forged hosts cannot change the canonical link", async () => {
  const f = fixture();
  const response = await f.handler(request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await response.json(), { processed: 1, sent: 1, failed: 0 });
  assert.match(f.emails[0].html, /href="https:\/\/booth.example.test\/timeline"/);
  assert.match(f.emails[0].html, /&lt;img src=x onerror=&quot;evil\(\)&quot;&gt; &amp; &#39;hello&#39;/);
  assert.doesNotMatch(f.emails[0].html, /evil\.example\.test|<img/);
  assert.ok(f.calls.includes("due:5"));
});

test("resolved email errors leave the date due and retry with the same idempotency key", async () => {
  const keys: string[] = [];
  let attempts = 0;
  const f = fixture({ email: async message => { keys.push(message.key); return { error: ++attempts === 1 ? { message: "fixture failure" } : null }; } });
  assert.equal((await f.handler(request())).status, 503);
  assert.ok(!f.calls.includes("complete"));
  assert.equal((await f.handler(request())).status, 200);
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
});

test("schedule update failure retries from durable checkpoints without resending email", async () => {
  let attempts = 0;
  const f = fixture({ complete: async () => { if (++attempts === 1) throw new Error("fixture database failure"); } });
  assert.equal((await f.handler(request())).status, 503);
  assert.equal((await f.handler(request())).status, 200);
  assert.equal(f.emails.length, 1);
  assert.equal(attempts, 2);
});

test("database errors are visible, release the lease and cannot pretend delivery succeeded", async () => {
  for (const failure of ["due", "recipients", "deliveries", "record", "release"] as const) {
    const f = fixture({ [failure]: async () => { throw new Error("fixture database error"); } });
    const response = await f.handler(request());
    assert.equal(response.status, 503);
    if (failure !== "release") assert.ok(f.calls.includes("release"));
    if (["due", "recipients", "deliveries"].includes(failure)) assert.equal(f.emails.length, 0);
  }
});

test("overlapping invocations respect a shared token lease", async () => {
  let owner: string | null = null;
  let unblock!: () => void;
  let started!: () => void;
  const blocked = new Promise<void>(resolve => { unblock = resolve; });
  const ready = new Promise<void>(resolve => { started = resolve; });
  const f = fixture({
    acquire: async token => { if (owner && owner !== token) return false; owner = token; return true; },
    release: async token => { assert.equal(owner, token); owner = null; },
    email: async () => { started(); await blocked; return { error: null }; },
  });
  const first = f.handler(request());
  await ready;
  assert.equal((await f.handler(request())).status, 409);
  unblock();
  assert.equal((await first).status, 200);
  assert.equal(owner, null);
});

test("partial push failure retries only unsuccessful browsers", async () => {
  const pushCalls: string[] = [];
  let fail = true;
  const targets = ["one", "two"].map(id => ({ id, endpoint: "https://push.example.test", p256dh: "fixture", auth: "fixture" }));
  const f = fixture({ subscriptions: async () => targets, push: async target => { pushCalls.push(target.id); if (target.id === "two" && fail) throw new Error("fixture push failure"); } }, { ...env, NEXT_PUBLIC_VAPID_PUBLIC_KEY: "fixture-public", VAPID_PRIVATE_KEY: "fixture-private" });
  assert.equal((await f.handler(request())).status, 503);
  fail = false;
  assert.equal((await f.handler(request())).status, 200);
  assert.deepEqual(pushCalls, ["one", "two", "two"]);
  assert.equal(f.emails.length, 1);
});

test("production HTTP adapter treats a resolved provider error as failure without marking sent", async t => {
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
    assert.ok(init?.signal instanceof AbortSignal);
    if (url.hostname === "api.resend.com") {
      assert.match(new Headers(init?.headers).get("Idempotency-Key") ?? "", /^photo-date-/);
      return Response.json({ error: { message: "fixture resolved error" } });
    }
    assert.equal(url.hostname, "db.example.test");
    if (url.pathname.includes("/rpc/")) return Response.json(true);
    if (url.pathname.endsWith("pb_photo_dates")) return Response.json([date]);
    if (url.pathname.endsWith("pb_couples")) return Response.json({ member_a: "member-fixture", member_b: null });
    if (url.pathname.endsWith("profiles")) return Response.json([{ email: "test@example.test" }]);
    if (url.pathname.endsWith("pb_reminder_deliveries")) return Response.json([]);
    throw new Error(`unexpected fixture path ${url.pathname}`);
  });
  const response = await createReminderHandler(undefined, () => env)(request());
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { processed: 1, sent: 0, failed: 1 });
  assert.ok(calls.includes("POST /emails"));
  assert.ok(!calls.some(call => call.includes("pb_record_reminder_delivery") || call.startsWith("PATCH")));
});

test("production HTTP adapter propagates resolved database errors without external delivery", async t => {
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    calls.push(url.pathname);
    assert.equal(url.hostname, "db.example.test");
    if (url.pathname.includes("/rpc/")) return Response.json(true);
    return Response.json({ code: "fixture_failure", message: "fixture unavailable" }, { status: 500 });
  });
  const response = await createReminderHandler(undefined, () => env)(request());
  assert.equal(response.status, 503);
  assert.ok(calls.includes("/rest/v1/pb_photo_dates"));
  assert.ok(calls.includes("/rest/v1/rpc/pb_release_job_lease"));
});
