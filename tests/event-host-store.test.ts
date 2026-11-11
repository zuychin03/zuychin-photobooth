import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { EVENT_LIMITS } from "../lib/events/contract";
import { DEFAULT_EVENT_LOOK, EVENT_FILTER_IDS, EVENT_FRAME_IDS, EVENT_FRAME_IDS_V2, EVENT_HOST_LIMITS, EVENT_SCENE_IDS, eventLookVersion, validateEventLook, type EventLook } from "../lib/events/host-contract";
import { DEFAULT_STRIP, STRIP_CHOICES } from "../lib/strip-style";
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
  let hostCaps: unknown = EVENT_HOST_LIMITS, lookCaps: unknown = null;
  const store = createEventHostStore(env, { rpc: async (name, args) => {
    calls.push({ name, args });
    if (name === "pb_event_look_capabilities") return lookCaps ? { data: lookCaps, error: null } : { data: null, error: { message: "function does not exist" } };
    return { data: name === "pb_event_host_capabilities" ? hostCaps : name === "pb_event_capabilities" ? { version: 1, ready: true, deploymentBytes: 250000000, allocatedBytes: 0, limits: EVENT_LIMITS } : result, error: null };
  } });
  return { store, calls, set: (next: unknown) => { result = next; }, caps: (next: unknown) => { hostCaps = next; }, lookCaps: (next: unknown) => { lookCaps = next; } };
}
test("event looks use only current frame/filter and event scene catalogue with bounded Unicode captions", () => {
  assert.deepEqual(EVENT_FRAME_IDS, FRAMES.filter(item => !item.v3).map(item => item.id)); assert.deepEqual(EVENT_FRAME_IDS_V2, FRAMES.map(item => item.id));
  assert.deepEqual(EVENT_FILTER_IDS, FILTERS.map(item => item.id));
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
const v2Look = { ...DEFAULT_EVENT_LOOK, version: 2, frameId: "peach", strip: { ...DEFAULT_STRIP, finish: "rounded", sprockets: true, date: "photo" } } as const satisfies EventLook;
test("look version 2 carries the V3 frames and a strip style while version 1 stays closed", () => {
  assert.deepEqual(validateEventLook(v2Look), v2Look);
  const plain = { ...DEFAULT_EVENT_LOOK, version: 2 }; assert.deepEqual(validateEventLook(plain), plain);
  for (const look of [{ ...DEFAULT_EVENT_LOOK, frameId: "cherry" }, { ...DEFAULT_EVENT_LOOK, strip: v2Look.strip }, { ...v2Look, version: 3 }, { ...v2Look, frameId: "gold" },
    { ...v2Look, strip: { ...v2Look.strip, finish: "glossy" } }, { ...v2Look, strip: { finish: "rounded" } }, { ...v2Look, strip: { ...v2Look.strip, extra: true } }, { ...v2Look, strip: null }, { ...v2Look, strip: undefined }]) assert.throws(() => validateEventLook(look), JSON.stringify(look));
  assert.equal(eventLookVersion(DEFAULT_EVENT_LOOK), 1); assert.equal(eventLookVersion({ frameId: "rose", strip: DEFAULT_STRIP }), 1);
  assert.equal(eventLookVersion({ frameId: "kraft" }), 2); assert.equal(eventLookVersion({ frameId: "rose", strip: v2Look.strip }), 2);
});
test("version 2 looks save only once migration 029 reports the look capability", async () => {
  const result = { version: 1, eventId: id(1), revision: 3, locked: false, event, look: v2Look }, f = fixture(result), who = await actor();
  await assert.rejects(f.store.saveSettings(who, id(1), id(2), 2, { event, look: v2Look }), /unavailable/);
  assert.equal(f.calls.some(call => call.name === "pb_event_save_settings"), false);
  f.lookCaps({ version: 1, lookVersion: 1 }); await assert.rejects(f.store.saveSettings(who, id(1), id(2), 2, { event, look: v2Look }), /unavailable/);
  f.lookCaps({ version: 1, lookVersion: 2 }); assert.deepEqual(await f.store.saveSettings(who, id(1), id(2), 2, { event, look: v2Look }), result);
  assert.deepEqual(f.calls.at(-1)?.args.p_body, { event, look: v2Look });
  const before = f.calls.filter(call => call.name === "pb_event_look_capabilities").length; f.lookCaps(null); f.set({ ...result, look: DEFAULT_EVENT_LOOK });
  await f.store.saveSettings(who, id(1), id(2), 2, { event, look: DEFAULT_EVENT_LOOK });
  assert.equal(f.calls.filter(call => call.name === "pb_event_look_capabilities").length, before);
});
test("migration 029 lists the same V2 frames and strip values as the client", () => {
  const sql = readFileSync(new URL("../database/migrations/029_v3_strip_variations.sql", import.meta.url), "utf8");
  const look = sql.slice(sql.indexOf("FUNCTION public.pb_event_valid_look"), sql.indexOf("FUNCTION public.pb_event_look_capabilities"));
  const quoted = (text: string) => [...text.matchAll(/'([^']+)'/g)].map(match => match[1]);
  const frameLists = [...look.matchAll(/->>'frameId' IN \(([^)]*)\)/g)].map(match => quoted(match[1]));
  assert.deepEqual(frameLists, [[...EVENT_FRAME_IDS], [...EVENT_FRAME_IDS_V2]]);
  const strip = sql.slice(sql.indexOf("FUNCTION public.pb_event_valid_strip"), sql.indexOf("FUNCTION public.pb_event_valid_look"));
  assert.deepEqual(quoted(strip.match(/\?& ARRAY\[([^\]]*)\]/)![1]), Object.keys(DEFAULT_STRIP));
  for (const [key, choices] of Object.entries(STRIP_CHOICES)) {
    const list = strip.match(new RegExp(`->>'${key}' IN \\(([^)]*)\\)`));
    assert.ok(list, key); assert.deepEqual(quoted(list[1]).sort(), choices.map(([value]) => value).sort(), key);
  }
  assert.match(strip, /jsonb_typeof\(p_strip->'sprockets'\)='boolean'/);
});
