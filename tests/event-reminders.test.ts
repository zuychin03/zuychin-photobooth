import assert from "node:assert/strict";
import test from "node:test";
import { createEventReminderAdapter, processEventReminders, type EventReminderAdapter, type EventReminderClaim } from "../lib/server/event-reminders";
import type { ReminderAdapter } from "../lib/server/reminders";
import { createEventReminderHandler } from "../lib/server/event-reminder-requests";
import { verifyEventActor } from "../lib/server/event-store";
import { createEventReminderStore } from "../lib/server/event-reminder-store";
import { createEventReminderClient } from "../lib/events/reminder-client";
const eventId = "10000000-0000-4000-8000-000000000001";
const claim: EventReminderClaim = { eventId, expiryRevision: 0, expiresAt: new Date(Date.now() + 3600000).toISOString(), timezone: "Australia/Sydney", title: "<Party>", token: eventId, channels: ["email"] };
const options = () => ({ token: eventId, limit: 1, startedAt: Date.now(), emailEnabled: true, pushEnabled: true, emailFrom: "owner@example.invalid", origin: "https://booth.example" });
function fixture() {
  const calls: string[] = [], messages: unknown[] = [];
  const store: EventReminderAdapter = { claim: async () => claim, dispatch: async (_c, _channel, hash) => { calls.push(hash ? "begin" : "read"); return { state: "send", target: { email: "owner@example.invalid" } }; }, record: async () => { calls.push("record"); }, finish: async (_c, failed) => { calls.push(failed ? "failed" : "finish"); } };
  const provider: Pick<ReminderAdapter, "acquire" | "email" | "push"> = { acquire: async () => true, email: async message => { calls.push("send"); messages.push(message); return { error: null }; }, push: async () => {} };
  return { calls, messages, store, provider };
}
test("event delivery rechecks before send, escapes copy and checkpoints acknowledgement", async () => {
  const f = fixture(), result = await processEventReminders(f.store, f.provider, options());
  assert.equal(result.sent, 1); assert.deepEqual(f.calls, ["read", "begin", "send", "record", "finish"]);
  const message = f.messages[0] as { html: string; key: string }; assert.match(message.html, /&lt;Party&gt;/); assert.match(message.html, new RegExp(`/events/${eventId}`)); assert.match(message.key, /^event-expiry-[a-f0-9]{64}$/);
});
test("changed recipient between authority checks never receives a send", async () => {
  const f = fixture(); f.store.dispatch = async (_c, _channel, hash) => ({ state: "send", target: { email: hash ? "changed@example.invalid" : "owner@example.invalid" } });
  const result = await processEventReminders(f.store, f.provider, options()); assert.equal(result.failed, 1); assert.equal(f.messages.length, 0);
});
test("uncertain and already delivered targets never resend", async () => {
  for (const state of ["uncertain", "delivered", "gone"]) { const f = fixture(); f.store.dispatch = async () => ({ state, target: null }); await processEventReminders(f.store, f.provider, options()); assert.equal(f.messages.length, 0); }
});
test("provider failure retains a failed checkpoint without claiming success", async () => {
  const f = fixture(); f.provider.email = async () => ({ error: "failure" }); const result = await processEventReminders(f.store, f.provider, options());
  assert.equal(result.failed, 1); assert.equal(result.sent, 0); assert.ok(!f.calls.includes("record")); assert.ok(f.calls.includes("failed"));
});
test("exhausted shared time budget never claims work", async () => {
  const f = fixture(); f.store.claim = async () => { throw new Error("must not claim"); };
  assert.deepEqual(await processEventReminders(f.store, f.provider, { ...options(), startedAt: Date.now() - 45001 }), { processed: 0, sent: 0, failed: 0 });
});
test("claim parser rejects unbounded target lists before delivery", async () => {
  const adapter = createEventReminderAdapter(async (_name, args) => ({ ...claim, token: args.p_token, channels: Array(12).fill("email") }));
  await assert.rejects(adapter.claim(eventId, true, true));
});
test("event reminder endpoint remains unavailable by default without touching auth", async () => {
  let called = false;
  const handler = createEventReminderHandler({ authenticate: async () => { called = true; throw new Error(); }, stores: () => { throw new Error(); } }, () => ({}));
  const response = await handler(new Request("https://booth.example/api/events/id/reminder", { method: "POST" }), eventId);
  assert.equal(response.status, 503); assert.equal(called, false);
});
test("owner HTTP settings use verified identity, distinguish channel availability and reject arbitrary targets", async () => {
  const calls: Record<string, unknown>[] = [], expiresAt = "2099-01-02T00:00:00.000Z";
  const projection = { version: 1, eventId, revision: 0, email: false, push: false, expiresAt, scheduledAt: "2099-01-01T00:00:00.000Z", status: "idle", emailAvailable: true, pushAvailable: false };
  const env = { PB_EVENTS_ENABLED: "true", PB_EVENT_REMINDERS_ENABLED: "true", PB_EVENT_TRANSPORT_SECRET: "synthetic-secret-at-least-32-characters", PB_PUBLIC_ORIGIN: "https://booth.example", RESEND_API_KEY: "synthetic" };
  const handler = createEventReminderHandler({ authenticate: () => verifyEventActor({ getUser: async () => ({ data: { user: { id: eventId } }, error: null }) }), stores: () => ({ reminder: createEventReminderStore({ rpc: async (_name, args) => { calls.push(args); return { data: projection, error: null }; } }), base: { transportReady: async () => {}, rate: async () => ({ allowed: true, retryAfterSeconds: 0 }) } }) }, () => env);
  const request = (body: unknown) => new Request(`https://booth.example/api/events/${eventId}/reminder`, { method: "POST", headers: { origin: "https://booth.example", "content-type": "application/json", authorization: "Bearer synthetic" }, body: JSON.stringify(body) });
  const response = await handler(request({ operation: "read" }), eventId); assert.equal(response.status, 200); assert.equal(calls[0].p_actor, eventId);
  const result = await response.json(); assert.deepEqual(result.configured, { email: true, push: false }); assert.equal(result.settings.emailAvailable, true);
  assert.equal((await handler(request({ operation: "save", expectedRevision: 0, email: true, push: false, target: "foreign@example.invalid" }), eventId)).status, 400);
  assert.equal((await handler(request({ operation: "save", expectedRevision: 0, email: false, push: true }), eventId)).status, 503); assert.equal(calls.length, 1);
});
test("reminder client fences an account switch before consuming a late settings response", async () => {
  let identity: { ownerId: string; epoch: number } | null = { ownerId: eventId, epoch: 1 }, release!: () => void;
  const client = createEventReminderClient({ appOrigin: "https://booth.example", identity: () => identity, accessToken: async () => "synthetic", fetch: async () => { await new Promise<void>(resolve => { release = resolve; }); return new Response("{}"); } });
  const pending = client.read(eventId); await new Promise(resolve => setTimeout(resolve, 0)); identity = null; release(); await assert.rejects(pending, /identity_changed/); client.close();
});
test("slow lease renewal crossing the budget prevents provider dispatch", async context => {
  let time = 0, renewals = 0; context.mock.method(Date, "now", () => time);
  const f = fixture(); f.provider.acquire = async () => { if (++renewals === 3) time = 45001; return true; };
  const result = await processEventReminders(f.store, f.provider, { ...options(), startedAt: 0 });
  assert.equal(result.failed, 1); assert.equal(f.messages.length, 0); assert.ok(!f.calls.includes("send"));
});
test("push gone acknowledgement includes the exact attempted subscription for conditional removal", async () => {
  const f = fixture(), target = { id: eventId, endpoint: "https://push.example/sub", p256dh: "key", auth: "auth" }; let captured: unknown;
  f.store.claim = async () => ({ ...claim, channels: [`push:${eventId}`] }); f.store.dispatch = async () => ({ state: "send", target });
  f.provider.push = async () => { throw { statusCode: 410 }; }; f.store.record = async (_c, _channel, outcome, exact) => { assert.equal(outcome, "gone"); captured = exact; };
  await processEventReminders(f.store, f.provider, options()); assert.deepEqual(captured, target);
});
test("client cancellation settles even when token, fetch or body ignores abort", async () => {
  for (const phase of ["token", "fetch", "body"]) {
    const client = createEventReminderClient({ appOrigin: "https://booth.example", identity: () => ({ ownerId: eventId, epoch: 1 }), timeoutMs: 10,
      accessToken: () => phase === "token" ? new Promise(() => {}) : Promise.resolve("synthetic"),
      fetch: () => phase === "fetch" ? new Promise(() => {}) : Promise.resolve(new Response(new ReadableStream({ pull: () => new Promise(() => {}), cancel: () => new Promise(() => {}) }))),
    });
    await assert.rejects(client.read(eventId), /cancelled/); client.close();
  }
});
test("client rejects excessive response chunk counts below the byte limit", async () => {
  const client = createEventReminderClient({ appOrigin: "https://booth.example", identity: () => ({ ownerId: eventId, epoch: 1 }), accessToken: async () => "synthetic", fetch: async () => new Response(new ReadableStream({ start(controller) { for (let i = 0; i < 65; i++) controller.enqueue(new Uint8Array()); controller.close(); } })) });
  await assert.rejects(client.read(eventId), /unavailable/); client.close();
});

test("reminder RPC offsets preserve the one-day schedule for strict clients", async () => {
 const actor = await verifyEventActor({ getUser: async () => ({ data: { user: { id: eventId } }, error: null }) });
 let value: unknown = { version: 1, eventId, revision: 0, email: false, push: false, expiresAt: "2099-01-02T10:30:00+10:30", scheduledAt: "2099-01-01T00:00:00+00:00", status: "idle", emailAvailable: true, pushAvailable: false };
 const store = createEventReminderStore({ rpc: async () => ({ data: value, error: null }) });
 const result = await store.settings(actor, eventId);
 assert.equal(result.expiresAt, "2099-01-02T00:00:00.000Z"); assert.equal(result.scheduledAt, "2099-01-01T00:00:00.000Z");
 const { parseEventReminder } = await import("../lib/events/reminder-contract"); assert.deepEqual(parseEventReminder(result,eventId),result);
 value = { ...result, scheduledAt: 0 }; await assert.rejects(store.settings(actor,eventId), /unavailable/);
 value = { ...result, extra: true }; await assert.rejects(store.settings(actor,eventId), /unavailable/);
});
