import assert from "node:assert/strict";
import test from "node:test";
import { EVENT_LIMITS } from "../lib/events/contract";
import { DEFAULT_EVENT_LOOK, EVENT_FILTER_IDS, EVENT_FRAME_IDS, EVENT_HOST_LIMITS, EVENT_SCENE_IDS, validateEventLook } from "../lib/events/host-contract";
import { createEventHostStore } from "../lib/server/event-host-store";
import { verifyEventActor, type VerifiedEventActor } from "../lib/server/event-store";
import { FRAMES } from "../lib/decor";
import { FILTERS } from "../lib/filters";
import { CURATED_ASSETS } from "../lib/assets/registry";

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const env = { PB_EVENTS_ENABLED: "true", NEXT_PUBLIC_SUPABASE_URL: "https://fixture.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "synthetic" };
const event = { title: "Graduation", timezone: "Australia/Sydney", startsAt: "2026-10-01T00:00:00.000Z", closesAt: "2026-10-02T00:00:00.000Z", expiresAt: "2026-11-01T00:00:00.000Z", maxGuests: 25, maxContributions: 100, maxBytes: 250000000 };
const row = (n: number) => ({ eventId: id(n), title: event.title, timezone: event.timezone, startsAt: event.startsAt, closesAt: event.closesAt, expiresAt: event.expiresAt, status: "closed", role: "moderator", membership: "invited" });
const actor = () => verifyEventActor({ getUser: async () => ({ data: { user: { id: id(99) } }, error: null }) });
function fixture(result: unknown) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  let hostCaps: unknown = EVENT_HOST_LIMITS;
  const store = createEventHostStore(env, { rpc: async (name, args) => { calls.push({ name, args }); return { data: name === "pb_event_host_capabilities" ? hostCaps : name === "pb_event_capabilities" ? { version: 1, ready: true, deploymentBytes: 250000000, allocatedBytes: 0, limits: EVENT_LIMITS } : result, error: null }; } });
  return { store, calls, set: (next: unknown) => { result = next; }, caps: (next: unknown) => { hostCaps = next; } };
}
test("event looks use only current frame/filter and event scene catalogue with bounded Unicode captions", () => {
  assert.deepEqual(EVENT_FRAME_IDS, FRAMES.map(item => item.id)); assert.deepEqual(EVENT_FILTER_IDS, FILTERS.map(item => item.id));
  assert.deepEqual(EVENT_SCENE_IDS, CURATED_ASSETS.filter(item => item.category === "events").map(item => item.id));
  assert.equal(validateEventLook({ ...DEFAULT_EVENT_LOOK, caption: "🎓".repeat(160) }).caption.length, 320);
  for (const patch of [{ caption: "x".repeat(161) }, { caption: "line\nbreak" }, { caption: "\u0085" }, { caption: "\ud800" }, { caption: "\udfff" }, { sceneId: "https://foreign.invalid/a.png" }, { sceneId: "blob:local" }, { themeId: "love" }, { token: "private" }, { sourcePhotos: [] }, { showDate: "false" }]) assert.throws(() => validateEventLook({ ...DEFAULT_EVENT_LOOK, ...patch }));
});
test("host discovery rejects forged actors and unbounded requests before RPC", async () => {
  const f = fixture({ version: 1, events: [], nextCursor: null });
  await assert.rejects(f.store.list({ id: id(99) } as VerifiedEventActor), /access_denied/);
  await assert.rejects(f.store.list(await actor(), undefined, 26)); assert.equal(f.calls.length, 0);
  f.caps({ ...EVENT_HOST_LIMITS, listLimit: 100 }); await assert.rejects(f.store.list(await actor()), /unavailable/);
});
test("host discovery enforces ascending bounded cursors and rejects secret or foreign-shaped responses", async () => {
  const f = fixture({ version: 1, events: [row(2), row(3)], nextCursor: id(3) }), who = await actor();
  assert.equal((await f.store.list(who, id(1), 2)).nextCursor, id(3));
  assert.deepEqual(f.calls.at(-1)?.args, { p_actor: who.id, p_after: id(1), p_limit: 2 });
  for (const events of [[row(1)], [row(3), row(2)], [row(2), row(2)], [{ ...row(2), token: "secret" }], [{ ...row(2), membership: "revoked" }]]) { f.set({ version: 1, events, nextCursor: null }); await assert.rejects(f.store.list(who, id(1), 2), /unavailable/); }
  f.set({ version: 1, events: [row(2)], nextCursor: id(9) }); await assert.rejects(f.store.list(who, undefined, 2), /unavailable/);
});
test("settings bind event identity, exact request and revision without leaking extra fields", async () => {
  const result = { version: 1, eventId: id(1), revision: 8, locked: true, event, look: DEFAULT_EVENT_LOOK }, f = fixture(result), who = await actor();
  assert.deepEqual(await f.store.saveSettings(who, id(1), id(2), 2, { event, look: DEFAULT_EVENT_LOOK }), result);
  assert.deepEqual(f.calls.at(-1)?.args, { p_actor: who.id, p_event: id(1), p_request: id(2), p_revision: 2, p_body: { event, look: DEFAULT_EVENT_LOOK } });
  f.set({ ...result, eventId: id(4) }); await assert.rejects(f.store.settings(who, id(1)), /unavailable/);
  f.set({ ...result, creation_fingerprint: event }); await assert.rejects(f.store.settings(who, id(1)), /unavailable/);
  const prior = f.calls.length; await assert.rejects(f.store.saveSettings(who, id(1), id(2), 2, { event, look: { ...DEFAULT_EVENT_LOOK, caption: "a".repeat(161) } }), /invalid_request/); assert.equal(f.calls.length, prior);
});
