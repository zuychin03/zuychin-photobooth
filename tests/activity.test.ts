import test from "node:test";
import assert from "node:assert/strict";
import { ACTIVITY_LIMITS, parseActivityPage, parseActivitySummary, parseMemoryActivity, validateActivityAnnotation, validateChapterInput } from "../lib/memories/activity-contract";
import { createActivityStore } from "../lib/server/activity-store";
import type { ProjectStorePorts } from "../lib/server/project-store";
const actor = "11111111-1111-4111-8111-111111111111", id = "22222222-2222-4222-8222-222222222222", source = "33333333-3333-4333-8333-333333333333";
const row = () => ({ id, mine: true, occurredAt: "2026-09-23T00:00:00Z", provenance: "saved_at", availability: "available", sourceKind: "strip", sourceId: source, scopeKind: "personal", scopeId: null, revision: 0, chapterId: null, occasion: null });
const env = { PB_MEMORIES_ENABLED: "true", NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321", SUPABASE_SERVICE_ROLE_KEY: "fixture-key" };
function fixture() {
  const calls: { name: string; args: Record<string, unknown> }[] = []; let result: unknown = { items: [row()], nextCursor: null }, current: string | null = actor;
  const ports: ProjectStorePorts = { authenticate: async () => current, rpc: async (name, args) => { calls.push({ name, args }); return { data: name === "pb_memory_capabilities" ? { ...ACTIVITY_LIMITS, ready: true } : name === "pb_project_rate" ? { allowed: true, retryAfterSeconds: 0 } : result, error: null }; } };
  return { ports, calls, result(value: unknown) { result = value; }, actor(value: string | null) { current = value; } };
}
test("broad activity is allowlisted and scope-lost participation has no source descriptors", () => {
  const parsed = parseMemoryActivity({ ...row(), caption: "private", storagePath: "private", signedUrl: "private", subjectId: actor });
  assert.equal(JSON.stringify(parsed).includes("private"), false); assert.equal(parsed.source?.id, source);
  const { sourceKind: _kind, sourceId: _source, scopeKind: _scope, scopeId: _scopeId, ...minimal } = row(); void _kind; void _source; void _scope; void _scopeId;
  const lost = parseMemoryActivity({ ...minimal, availability: "access_lost" }); assert.equal(lost.source, null); assert.equal(lost.mine, true);
  assert.throws(() => parseMemoryActivity({ ...row(), availability: "access_lost" }));
  assert.throws(() => parseMemoryActivity({ ...minimal, mine: false, availability: "access_lost" }));
  assert.equal(parseMemoryActivity({ ...row(), mine: false, scopeKind: "couple", scopeId: source, occasion: "Other person's label" }).annotation, null);
});
test("activity pages reject wrong ordering, cursor and invalid source shapes", () => {
  assert.deepEqual(parseActivityPage({ items: [], nextCursor: null }), { items: [], nextCursor: null });
  for (const value of [{ items: [row(), row()], nextCursor: null }, { items: [row()], nextCursor: source }, { items: [{ ...row(), sourceKind: "project_asset" }], nextCursor: null }]) assert.throws(() => parseActivityPage(value));
});
test("aggregate contract explicitly requires own UTC source counts and twelve months", () => {
  const value = { year: 2026, timezone: "UTC", basis: "own_source_records", months: Array.from({ length: 12 }, (_, i) => ({ month: i + 1, total: i })), outsideCalendar: 0 };
  assert.deepEqual(parseActivitySummary(value), value);
  for (const bad of [{ ...value, timezone: "Australia/Sydney" }, { ...value, basis: "available_photos" }, { ...value, months: value.months.slice(1) }, { ...value, outsideCalendar: -1 }]) assert.throws(() => parseActivitySummary(bad));
});
test("chapter and occasion mutations bound text, ownership surface and CAS revisions", () => {
  assert.deepEqual(validateChapterInput({ id, expectedRevision: -1, title: "Family" }), { id, expectedRevision: -1, title: "Family" });
  assert.throws(() => validateChapterInput({ id, expectedRevision: -1, title: "x".repeat(81) }));
  assert.throws(() => validateChapterInput({ id, expectedRevision: -1, title: "Family", ownerId: source }));
  assert.throws(() => validateActivityAnnotation({ id, expectedRevision: -1, chapterId: null, occasion: null }));
  assert.throws(() => validateActivityAnnotation({ id, expectedRevision: 0, chapterId: null, occasion: "Bad\nlabel" }));
});
test("store configuration and authentication fail before data operations", async () => {
  const f = fixture(); await assert.rejects(createActivityStore("token", { ...env, PB_MEMORIES_ENABLED: "false" }, f.ports), /unavailable/); assert.equal(f.calls.length, 0);
  f.actor(null); await assert.rejects(createActivityStore("token", env, f.ports), /access_denied/); assert.equal(f.calls.length, 0);
});
test("store binds the verified actor and charges the existing rate gate before list", async () => {
  const f = fixture(), store = await createActivityStore("token", env, f.ports); assert.equal((await store.list()).items.length, 1);
  assert.deepEqual(f.calls.slice(1).map(c => c.name), ["pb_project_rate", "pb_memory_list"]);
  assert.equal(f.calls.at(-1)?.args.p_actor, actor); assert.equal(f.calls.at(-1)?.args.p_limit, 20);
  f.result({ items: [row()], nextCursor: null }); await assert.rejects(store.list(source), /unavailable/);
});
test("mutations validate matching IDs/revisions and strip undeclared server fields", async () => {
  const f = fixture(), store = await createActivityStore("token", env, f.ports);
  f.result({ id, title: "Family", revision: 0, createdAt: row().occurredAt, secret: "private" });
  assert.deepEqual(await store.putChapter({ id, expectedRevision: -1, title: "Family" }), { id, title: "Family", revision: 0, createdAt: row().occurredAt });
  f.result({ ...row(), revision: 1, occasion: "Birthday" }); assert.equal((await store.annotate({ id, expectedRevision: 0, chapterId: null, occasion: "Birthday" })).annotation?.occasion, "Birthday");
  f.result({ ...row(), revision: 0, occasion: "Birthday" }); await assert.rejects(store.annotate({ id, expectedRevision: 0, chapterId: null, occasion: "Birthday" }), /unavailable/);
});
test("capability mismatch, malformed rates and database messages fail closed", async () => {
  const f = fixture(); f.ports.rpc = async () => ({ data: { ...ACTIVITY_LIMITS, ready: true, detailLimit: 2001 }, error: null }); await assert.rejects(createActivityStore("token", env, f.ports), /unavailable/);
  const g = fixture(), store = await createActivityStore("token", env, g.ports); g.ports.rpc = async () => ({ data: { allowed: true, retryAfterSeconds: 8 }, error: null }); await assert.rejects(store.list(), /unavailable/);
  g.ports.rpc = async () => ({ data: null, error: { message: "private DB payload" } }); await assert.rejects(store.list(), /unavailable/);
});
