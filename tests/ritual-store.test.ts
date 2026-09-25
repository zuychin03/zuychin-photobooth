import assert from "node:assert/strict";
import test from "node:test";
import { computeRitualProof, parseRitualRow, validateRitualDefinition, validateRitualInput, type RitualDefinition, type RitualRow } from "../lib/memories/ritual-contract";
import { createRitualStore } from "../lib/server/ritual-store";
import type { ProjectStorePorts } from "../lib/server/project-store";
const actor = "11111111-1111-4111-8111-111111111111", couple = "22222222-2222-4222-8222-222222222222", id = "33333333-3333-4333-8333-333333333333";
const env = { PB_MEMORIES_ENABLED: "true", NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321", SUPABASE_SERVICE_ROLE_KEY: "fixture-not-a-secret" };
const schedule: RitualDefinition = { version: 1, anchorDate: "2030-01-31", localTime: "09:00", timeZone: "Australia/Sydney", frequency: "monthly", interval: 1, invalidDate: "clamp", gap: "shift-forward", fold: "later", onceAt: null };
const now = "2030-02-01T00:00:00.000Z";
function fixture() {
  const calls: { name: string; args: Record<string, unknown> }[] = []; let identity: string | null = actor, error: string | null = null, deniedRate = false;
  let row: RitualRow = { id, coupleId: couple, creatorId: actor, title: "Photo date", revision: 0, legacy: false, schedule, next: computeRitualProof(schedule, now).occurrence, scheduledAt: "2030-02-27T22:00:00.000Z", cadence: "monthly", active: false, enabled: true, paused: false, channels: { email: false, push: false } };
  let response: unknown; let cap: unknown = { ready: true, version: 1, maximumPerCouple: 20, pageMaximum: 20, proofSeconds: 30, deliveryVersion: 0 };
  const ports: ProjectStorePorts = { authenticate: async () => identity, rpc: async (name, args) => {
    calls.push({ name, args });
    if (name === "pb_ritual_capabilities") return { data: cap, error: null };
    if (name === "pb_project_rate") return { data: { allowed: !deniedRate, retryAfterSeconds: deniedRate ? 17 : 0 }, error: null };
    if (name === "pb_ritual_context") return { data: { now, row: args.p_id === null ? null : row }, error: null };
    if (error) return { data: null, error: { message: error } };
    if (name === "pb_ritual_list") return { data: response ?? { version: 1, items: [row], nextCursor: null }, error: null };
    return { data: response ?? row, error: null };
  } };
  return { ports, calls, row: () => row, setRow: (value: RitualRow) => { row = value; }, response: (value: unknown) => { response = value; }, cap: (value: unknown) => { cap = value; }, identity: (value: string | null) => { identity = value; }, error: (value: string) => { error = value; }, rate: () => { deniedRate = true; } };
}
test("ritual definition uses explicit zone, bounded public cadence and an exact one-off instant", () => {
  assert.deepEqual(validateRitualDefinition(schedule), schedule);
  for (const bad of [{ ...schedule, frequency: "daily" }, { ...schedule, timeZone: "" }, { ...schedule, timeZone: "Mars/Crater" }, { ...schedule, interval: 13 }, { ...schedule, nextInstant: now }, { ...schedule, onceAt: now }, { ...schedule, anchorDate: "2030-02-30" }]) assert.throws(() => validateRitualDefinition(bad));
  const once = { ...schedule, frequency: "once", onceAt: "2030-01-30T22:00:45.000Z" }; assert.equal(validateRitualDefinition(once).onceAt, once.onceAt);
  assert.throws(() => validateRitualDefinition({ ...once, onceAt: "2030-01-30T23:00:45.000Z" }));
  const proof = computeRitualProof(validateRitualDefinition(once), "2030-01-01T00:00:00Z"); assert.equal(proof.occurrence?.instant, once.onceAt);
  assert.equal(computeRitualProof(validateRitualDefinition(once), now).occurrence, null);
});
test("server-time recurrence preserves month-end anchor and skips elapsed occurrences", () => {
  const proof = computeRitualProof(schedule, now); assert.equal(proof.occurrence?.instant, "2030-02-27T22:00:00.000Z"); assert.equal(proof.occurrence?.cycle, 1); assert.deepEqual(proof.occurrence?.adjustments, ["date-clamp"]);
  assert.equal(computeRitualProof(schedule, "2030-03-01T00:00:00Z").occurrence?.scheduledDate, "2030-03-31"); assert.equal(schedule.anchorDate, "2030-01-31");
});
test("strict mutation inputs reject actor/proof injection and accessors without invoking them", () => {
  const input = { id, title: "Photo date", schedule }; assert.deepEqual(validateRitualInput(input), input);
  for (const bad of [{ ...input, actor }, { ...input, proof: {} }, { ...input, title: " ".repeat(2) }, { ...input, title: "❤".repeat(101) }]) assert.throws(() => validateRitualInput(bad));
  let invoked = false; const bad = { ...schedule }; Object.defineProperty(bad, "timeZone", { get() { invoked = true; return "UTC"; } }); assert.throws(() => validateRitualDefinition(bad)); assert.equal(invoked, false);
});
test("feature, configuration, identity and standalone ritual capability fail closed", async () => {
  const f = fixture();
  for (const bad of [{ ...env, PB_MEMORIES_ENABLED: "false" }, { ...env, SUPABASE_SERVICE_ROLE_KEY: "" }, { ...env, NEXT_PUBLIC_SUPABASE_URL: "http://example.invalid" }]) await assert.rejects(createRitualStore("fixture-token", bad, f.ports), /unavailable/);
  assert.equal(f.calls.length, 0); f.identity(null); await assert.rejects(createRitualStore("fixture-token", env, f.ports), /access_denied/); assert.equal(f.calls.length, 0);
  f.identity(actor); f.cap({ ready: true, version: 1, activityVersion: 1 }); await assert.rejects(createRitualStore("fixture-token", env, f.ports), /unavailable/);
});
test("create binds authenticated actor and computes occurrence only from database time", async () => {
  const f = fixture(), store = await createRitualStore("fixture-token", env, f.ports);
  await store.create(couple, { id, title: "Photo date", schedule });
  assert.deepEqual(f.calls.map(c => c.name), ["pb_ritual_capabilities", "pb_project_rate", "pb_ritual_context", "pb_ritual_save"]);
  const args = f.calls.at(-1)!.args; assert.equal(args.p_actor, actor); assert.equal(args.p_couple, couple); assert.equal(args.p_action, "create"); assert.deepEqual(args.p_proof, computeRitualProof(schedule, now));
  assert(!f.calls.some(c => c.name === "pb_memory_capabilities"));
});
test("explicit legacy upgrade carries original instant fence and never guesses its timezone", async () => {
  const f = fixture(), current = f.row(), store = await createRitualStore("fixture-token", env, f.ports);
  f.setRow({ ...current, legacy: true, schedule: null, next: null, active: true, enabled: false }); f.response({ ...current, revision: 1 });
  await store.upgrade(couple, id, current.scheduledAt, { title: current.title, schedule }); assert.equal(f.calls.at(-1)!.args.p_expected_legacy, current.scheduledAt); assert.equal(f.calls.at(-1)!.args.p_revision, 0);
});
test("edit and resume reject stale revisions before submitting a proof", async () => {
  const f = fixture(), store = await createRitualStore("fixture-token", env, f.ports); f.setRow({ ...f.row(), revision: 2 });
  await assert.rejects(store.edit(couple, id, 1, { title: "Edited", schedule }), /conflict/); await assert.rejects(store.resume(couple, id, 1), /conflict/);
  assert(!f.calls.some(c => c.name === "pb_ritual_action" || c.name === "pb_ritual_save"));
});
test("per-recipient channels have no caller recipient field and are separately revision fenced", async () => {
  const f = fixture(), store = await createRitualStore("fixture-token", env, f.ports);
  await assert.rejects(store.setChannels(couple, id, 0, { email: true, push: false, recipient: couple } as never), /invalid_request/);
  f.response({ ...f.row(), revision: 1, channels: { email: true, push: false } });
  await store.setChannels(couple, id, 0, { email: true, push: false }); const args = f.calls.at(-1)!.args;
  assert.equal(args.p_actor, actor); assert.equal(args.p_action, "channels"); assert.equal(args.p_revision, 0); assert.deepEqual(args.p_channels, { email: true, push: false });
});
test("rate denial prevents context reads and mutations, and SQL denials remain conservative", async () => {
  const f = fixture(), store = await createRitualStore("fixture-token", env, f.ports); f.rate();
  await assert.rejects(store.create(couple, { id, title: "Photo date", schedule }), error => error instanceof Error && "retryAfterSeconds" in error && error.retryAfterSeconds === 17);
  assert.equal(f.calls.at(-1)!.name, "pb_project_rate");
  const g = fixture(), allowed = await createRitualStore("fixture-token", env, g.ports); g.error("PB_RITUAL_DENIED"); await assert.rejects(allowed.pause(couple, id, 0), /access_denied/);
});
test("projections reject legacy-worker exposure, wrong scope and invalid paging", async () => {
  const f = fixture(), store = await createRitualStore("fixture-token", env, f.ports);
  assert.throws(() => parseRitualRow({ ...f.row(), active: true })); assert.throws(() => parseRitualRow({ ...f.row(), schedule: null }));
  f.response({ version: 1, items: [{ ...f.row(), coupleId: actor }], nextCursor: null }); await assert.rejects(store.list(couple), /unavailable/);
  f.response({ version: 1, items: [f.row(), f.row()], nextCursor: null }); await assert.rejects(store.list(couple), /unavailable/);
  await assert.rejects(store.list(couple, undefined, 21), /invalid_request/);
});

test("delivery capability keeps management available and terminal uncertainty remains readable", async () => {
  const f = fixture(); f.cap({ ready: true, version: 1, maximumPerCouple: 20, pageMaximum: 20, proofSeconds: 30, deliveryVersion: 1 });
  const terminal = { ...f.row(), enabled: false, delivery: { status: "uncertain" as const, attempts: 5 } }; f.setRow(terminal);
  const store = await createRitualStore("fixture-token", env, f.ports); assert.deepEqual((await store.list(couple)).items[0].delivery, terminal.delivery);
  assert.throws(() => parseRitualRow({ ...terminal, enabled: true })); assert.throws(() => parseRitualRow({ ...terminal, delivery: { status: "uncertain", attempts: 6 } }));
});
