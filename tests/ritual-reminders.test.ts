import assert from "node:assert/strict";
import test from "node:test";
import { createReminderHandler, validPushEndpoint, type ReminderAdapter } from "../lib/server/reminders";
import { createRitualReminderAdapter, processRitualReminders, type RitualClaim, type RitualReminderAdapter, type RitualTarget } from "../lib/server/ritual-reminders";
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const env = { CRON_SECRET: "fixture-cron", NEXT_PUBLIC_SUPABASE_URL: "https://db.example.test", SUPABASE_SERVICE_ROLE_KEY: "fixture-service", PB_PUBLIC_ORIGIN: "https://booth.example.test", PB_MEMORIES_ENABLED: "true", RESEND_API_KEY: "fixture-email", NEXT_PUBLIC_VAPID_PUBLIC_KEY: "fixture-public", VAPID_PRIVATE_KEY: "fixture-private" };
const request = () => new Request("https://untrusted.example.test/api/reminders", { headers: { authorization: "Bearer fixture-cron" } });
const email = (n: number): RitualTarget => ({ recipientId: id(n), channel: "email", target: { email: `person${n}@example.invalid` } });
function fixture(targets: RitualTarget[] = [email(1), email(2)]) {
  const calls: string[] = [], messages: Parameters<ReminderAdapter["email"]>[0][] = [], hashes = new Map<string, string>(), states = new Map<string, "dispatching" | "delivered" | "gone">();
  let active = true, paused = false, finishFailures = 0, recordFailures = 0, claimCount = 0, lastRun = "";
  const claim: RitualClaim = { id: id(30), dateId: id(31), revision: 2, cycle: 0, scheduledAt: "2026-09-22T00:00:00.000Z", title: "<b>Private date</b>", token: id(32), targets };
  const key = (target: RitualTarget) => `${target.recipientId}:${target.channel}`;
  const rituals: RitualReminderAdapter = {
    ready: async () => true,
    claim: async (run, token) => { calls.push("claim"); if (!active || lastRun === run) return null; lastRun = run; claimCount++; return { ...claim, token }; },
    begin: async (_claim, target, hash) => {
      calls.push(`begin:${key(target)}`); if (paused) throw new Error("fence lost");
      const state = states.get(key(target)); if (state === "delivered" || state === "gone") return state;
      if (state === "dispatching" && (target.channel !== "email" || hashes.get(key(target)) !== hash)) return "uncertain";
      states.set(key(target), "dispatching"); hashes.set(key(target), hash); return "send";
    },
    record: async (_claim, target, outcome) => { calls.push(`record:${key(target)}`); if (paused || recordFailures-- > 0) throw new Error("checkpoint unavailable"); states.set(key(target), outcome === "sent" ? "delivered" : "gone"); },
    finish: async () => { calls.push("finish"); if (paused || finishFailures-- > 0) throw new Error("finish unavailable"); assert(targets.every(t => ["delivered", "gone"].includes(states.get(key(t)) ?? ""))); active = false; },
    fail: async (_claim, uncertain) => { calls.push(`fail:${uncertain}`); if (uncertain) active = false; },
  };
  const adapter: ReminderAdapter = {
    acquire: async () => true, release: async () => { calls.push("release"); }, due: async () => [], recipients: async () => ({ ids: [], emails: [] }), deliveries: async () => [], record: async () => {}, complete: async () => {},
    email: async message => { calls.push(`email:${message.to[0]}`); messages.push(message); return { error: null }; }, subscriptions: async () => [], push: async () => { calls.push("push"); }, removeSubscription: async () => {}, rituals,
  };
  const handler = (configuration = env) => createReminderHandler(() => adapter, () => configuration);
  return { rituals, adapter, calls, messages, states, claim, handler, pause: () => { paused = true; }, finishFailure: () => { finishFailures = 1; }, recordFailure: () => { recordFailures = 1; }, claimCount: () => claimCount };
}
test("actual scheduler sends individual ritual emails only after dispatch fences and checkpoints before finish", async () => {
  const f = fixture(), response = await f.handler()(request()); assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { processed: 1, sent: 1, failed: 0 }); assert.equal(f.messages.length, 2); assert(f.messages.every(m => m.to.length === 1)); assert.notEqual(f.messages[0].key, f.messages[1].key);
  assert(f.messages.every(m => m.key.startsWith("ritual-") && m.html.includes("&lt;b&gt;Private date&lt;/b&gt;") && m.html.includes("https://booth.example.test/timeline")));
  for (let n = 1; n <= 2; n++) assert(f.calls.indexOf(`begin:${id(n)}:email`) < f.calls.indexOf(`email:person${n}@example.invalid`));
  assert(f.calls.lastIndexOf(`record:${id(2)}:email`) < f.calls.indexOf("finish"));
});
test("email errors and sent-but-unrecorded acknowledgement retry with the exact same key and payload hash", async () => {
  for (const lostAck of [false, true]) {
    const f = fixture([email(1)]), original = f.adapter.email; let fail = true;
    if (lostAck) f.recordFailure();
    else f.adapter.email = async (...args) => { const response = await original(...args); if (fail) { fail = false; return { error: "fixture rejected" }; } return response; };
    assert.equal((await f.handler()(request())).status, 503); assert(!f.calls.includes("finish"));
    assert.equal((await f.handler()(request())).status, 200); assert.equal(f.messages.length, 2); assert.deepEqual(f.messages[0], f.messages[1]);
  }
});
test("durable checkpoint survives completion failure and prevents another provider send", async () => {
  const f = fixture([email(1)]); f.finishFailure(); assert.equal((await f.handler()(request())).status, 503); assert.equal((await f.handler()(request())).status, 200); assert.equal(f.messages.length, 1);
});
test("pause before dispatch prevents calls; pause after send prevents acknowledgement and advancement", async () => {
  const before = fixture([email(1)]); before.pause(); assert.equal((await before.handler()(request())).status, 503); assert.equal(before.messages.length, 0); assert(!before.calls.includes("finish"));
  const after = fixture([email(1)]), send = after.adapter.email; after.adapter.email = async (...args) => { const result = await send(...args); after.pause(); return result; };
  assert.equal((await after.handler()(request())).status, 503); assert.equal(after.messages.length, 1); assert(!after.calls.includes("finish")); assert.notEqual(after.states.get(`${id(1)}:email`), "delivered");
});
test("an uncertain push is not automatically resent and a changed email payload stops retry", async () => {
  const target: RitualTarget = { recipientId: id(1), channel: `push:${id(3)}`, target: { id: id(3), endpoint: "https://fcm.googleapis.com/fixture", p256dh: "fixture", auth: "fixture" } }, f = fixture([target]);
  f.states.set(`${id(1)}:${target.channel}`, "dispatching"); assert.equal((await f.handler()(request())).status, 503); assert(!f.calls.includes("push")); assert(f.calls.includes("fail:true"));
  const changed = fixture([email(1)]); changed.recordFailure(); assert.equal((await changed.handler()(request())).status, 503);
  assert.equal((await changed.handler({ ...env, PB_PUBLIC_ORIGIN: "https://changed.example.test" })(request())).status, 503); assert.equal(changed.messages.length, 1); assert(changed.calls.includes("fail:true"));
});
test("push 410 is durably skipped and does not count as a delivered occurrence", async () => {
  const target: RitualTarget = { recipientId: id(1), channel: `push:${id(3)}`, target: { id: id(3), endpoint: "https://fcm.googleapis.com/fixture", p256dh: "fixture", auth: "fixture" } }, f = fixture([target]);
  f.adapter.push = async () => { throw Object.assign(new Error("gone"), { statusCode: 410 }); };
  const response = await f.handler()(request()); assert.equal(response.status, 200); assert.deepEqual(await response.json(), { processed: 1, sent: 0, failed: 0, skipped: 1 }); assert.equal(f.states.get(`${id(1)}:${target.channel}`), "gone");
});
test("provider concurrency never exceeds two for the maximum 22 targets and carries abort signals", async () => {
  const targets = [email(1), email(2), ...Array.from({ length: 20 }, (_, i): RitualTarget => ({ recipientId: id(i % 2 + 1), channel: `push:${id(100 + i)}`, target: { id: id(100 + i), endpoint: "https://fcm.googleapis.com/fixture", p256dh: "fixture", auth: "fixture" } }))], f = fixture(targets);
  let active = 0, peak = 0, count = 0;
  const work = async (signal?: AbortSignal) => { assert(signal instanceof AbortSignal); active++; peak = Math.max(peak, active); await new Promise(resolve => setImmediate(resolve)); count++; active--; };
  f.adapter.email = async (_message, signal) => { await work(signal); return { error: null }; }; f.adapter.push = async (_target, _title, _topic, signal) => work(signal);
  assert.equal((await f.handler()(request())).status, 200); assert.equal(count, 22); assert.equal(peak, 2); assert.equal(active, 0);
});
test("the existing scheduler shares its five-occurrence budget between ritual and legacy work", async () => {
  const f = fixture([email(1)]); let claimed = 0, legacy = 0;
  f.rituals.claim = async (_run, token) => ({ ...f.claim, id: id(200 + ++claimed), token }); f.rituals.begin = async () => "send"; f.rituals.record = async () => {}; f.rituals.finish = async () => {};
  f.adapter.due = async () => Array.from({ length: 5 }, (_, n) => ({ id: id(300 + n), couple_id: id(40), title: "Legacy", scheduled_at: "2026-01-01T00:00:00Z", cadence: "once" }));
  f.adapter.recipients = async () => ({ ids: [id(1)], emails: ["legacy@example.invalid"] }); f.adapter.complete = async () => { legacy++; };
  const response = await f.handler()(request()); assert.equal(response.status, 200); assert.deepEqual(await response.json(), { processed: 5, sent: 5, failed: 0 }); assert.equal(claimed, 3); assert.equal(legacy, 2);
});
test("old delivery capability disables only ritual delivery, retaining the legacy path", async () => {
  const f = fixture(); f.rituals.ready = async () => false;
  const response = await f.handler()(request()); assert.equal(response.status, 200); assert.equal(f.claimCount(), 0); assert.equal(f.messages.length, 0);
  const missing = createRitualReminderAdapter(async () => null); assert.equal(await missing.ready(), false);
});

test("target budget stops new sends, retains completed checkpoints and resumes the remaining targets", async t => {
  let clock = 0; t.mock.method(Date, "now", () => clock);
  const targets = Array.from({ length: 6 }, (_, i): RitualTarget => ({ recipientId: id(1), channel: `push:${id(100 + i)}`, target: { id: id(100 + i), endpoint: "https://fcm.googleapis.com/fixture", p256dh: "fixture", auth: "fixture" } })), f = fixture(targets);
  let count = 0;
  f.adapter.push = async () => { count++; clock = 46000; await new Promise(resolve => setImmediate(resolve)); };
  assert.equal((await f.handler()(request())).status, 503); assert.equal(count, 2); assert.equal([...f.states.values()].filter(s => s === "delivered").length, 2); assert(!f.calls.includes("finish"));
  clock = 0; f.adapter.push = async () => { count++; };
  assert.equal((await f.handler()(request())).status, 200); assert.equal(count, 6); assert(f.calls.includes("finish"));
});

test("exhausted lease terminalisations consume the same five-occurrence pass budget without sending", async () => {
  const f = fixture(); let claims = 0;
  f.rituals.claim = async (_run, token) => ({ ...f.claim, id: id(500 + ++claims), token, terminal: true, targets: [] });
  const result = await processRitualReminders(f.rituals, f.adapter, { token: id(90), limit: 5, emailEnabled: true, pushEnabled: true, emailFrom: "fixture", html: title => title });
  assert.deepEqual(result, { processed: 5, failed: 5, sent: 0, skipped: 0 }); assert.equal(claims, 5); assert.equal(f.messages.length, 0); assert(!f.calls.includes("finish"));
});
test("SQL adapter computes completion from fresh database time and rejects malformed capability", async () => {
  const calls: { name: string; args?: Record<string, unknown> }[] = [], schedule = { version: 1, anchorDate: "2030-01-31", localTime: "09:00", timeZone: "Australia/Sydney", frequency: "monthly", interval: 1, invalidDate: "clamp", gap: "shift-forward", fold: "later", onceAt: null };
  const adapter = createRitualReminderAdapter(async (name, args) => { calls.push({ name, args }); if (name === "pb_ritual_finish_context") return { now: "2030-03-01T00:00:00Z", schedule }; return true; });
  await adapter.finish(fixture().claim); assert.equal((calls[1].args?.p_proof as { occurrence: { scheduledDate: string } }).occurrence.scheduledDate, "2030-03-31");
  await assert.rejects(adapter.ready());
});
test("push destinations reject local addresses, credentials, redirects-by-host and nonstandard ports", () => {
  for (const url of ["https://fcm.googleapis.com/send/capability", "https://updates.push.services.mozilla.com/wpush/v2/capability", "https://web.push.apple.com/capability", "https://wns.notify.windows.com/capability"]) assert.equal(validPushEndpoint(url), true);
  for (const url of ["http://fcm.googleapis.com/x", "https://127.0.0.1/x", "https://[::1]/x", "https://fcm.googleapis.com.evil.test/x", "https://example.test/x", "https://user@fcm.googleapis.com/x", "https://fcm.googleapis.com:8443/x", "https://fcm.googleapis.com/x#fragment"]) assert.equal(validPushEndpoint(url), false);
});
