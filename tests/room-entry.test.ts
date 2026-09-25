import assert from "node:assert/strict";
import test from "node:test";
import { createRoomEntryApi, forgetRememberedRoom, isV2RoomCode, rememberedRoomId, rememberRoom, roomDisplayName, roomEntryError, roomEntryRoute, roomV2Url } from "../lib/rtc/entry-v2";
import { RoomApiError } from "../lib/rtc/signaling-v2";
import { EPOCH, MEMBER_A, ROOM_ID, SESSION_ID } from "./helpers/room-fixture";
import type { RoomState } from "../lib/server/room-contract";

const state = (): RoomState => ({ roomId: ROOM_ID, sessionId: SESSION_ID, hostId: MEMBER_A, selfId: MEMBER_A, selfRole: "A", code: "ALC234", connectionEpoch: EPOCH, status: "open", locked: false, rosterRevision: 1, expiresAt: 10000, serverNow: 1000, members: [{ id: MEMBER_A, role: "A", displayName: "Host", status: "admitted", connectionEpoch: EPOCH }], capture: null });
const response = (value: unknown, status = 200) => Response.json(value, { status });
const route = (code: string, query: string) => roomEntryRoute(code, new URLSearchParams(query));

test("only explicit v2 links use the admission flow and host flags never grant host authority", () => {
  assert.deepEqual(route("ABC234", "host=1"), { kind: "legacy" });
  assert.deepEqual(route("ABC234", ""), { kind: "legacy" });
  assert.deepEqual(route("new", "v=2&host=1"), { kind: "create" });
  assert.deepEqual(route("alc234", "v=2&host=1&token=not-authority"), { kind: "join", code: "ALC234" });
  assert.deepEqual(route("ALC234", `v=2&id=${ROOM_ID}&host=1`), { kind: "resume", code: "ALC234", roomId: ROOM_ID });
  for (const [code, query] of [["new", `v=2&id=${ROOM_ID}`], ["ABC234", "v=2&id=bad"], ["ABC234", "v=2&id="], ["ABC234", `v=2&id=${ROOM_ID}&id=${ROOM_ID}`], ["ABC234", "v=2&v=2"], ["../api", "v=2"], ["ABC01Z", "v=2"]]) assert.deepEqual(route(code, query), { kind: "invalid" });
});
test("public room URLs contain only validated lookup/ID data and match the server code alphabet", () => {
  assert.equal(isV2RoomCode("ALC234"), true); assert.equal(isV2RoomCode("ABC01Z"), false);
  assert.equal(roomV2Url("ALC234"), "/room/ALC234?v=2");
  assert.equal(roomV2Url("ALC234", ROOM_ID), `/room/ALC234?v=2&id=${ROOM_ID}`);
  for (const value of ["javascript:alert(1)", "../../private", "ALC234?host=1", "abc234"]) assert.throws(() => roomV2Url(value));
  assert.throws(() => roomV2Url("ALC234", `${ROOM_ID}&token=secret`));
});
test("display names are trimmed and bounded before any creation request", async () => {
  assert.equal(roomDisplayName("  Bạn bè  "), "Bạn bè");
  let calls = 0;
  const api = createRoomEntryApi({ fetch: (async () => { calls++; return response(state()); }) as typeof fetch });
  for (const name of ["", "   ", "x".repeat(41), "Name\nSecond", "Name\u0000"]) await assert.rejects(api.enter({ kind: "create" }, name), /invalid_name/);
  await assert.rejects(api.enter({ kind: "join", code: "BAD" }, "Guest"), /invalid_request/);
  assert.equal(calls, 0);
});
test("capabilities fail closed; create/join use bounded same-origin cookie requests without URL authority", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const api = createRoomEntryApi({ fetch: (async (url, init) => {
    calls.push({ url: String(url), init: init! });
    return response(String(url).endsWith("capabilities") ? { enabled: true, protocol: 2 } : state());
  }) as typeof fetch });
  await api.capabilities(); await api.enter({ kind: "create" }, " Host "); await api.enter({ kind: "join", code: "ALC234" }, "Guest");
  assert.deepEqual(calls.map(item => item.url), ["/api/rooms/capabilities", "/api/rooms", "/api/rooms/join"]);
  assert.equal(calls[0].init.method, "GET"); assert.equal(calls[0].init.body, undefined);
  assert.deepEqual(JSON.parse(calls[1].init.body as string), { displayName: "Host" });
  assert.deepEqual(JSON.parse(calls[2].init.body as string), { displayName: "Guest", code: "ALC234" });
  for (const call of calls) { assert.equal(call.init.credentials, "same-origin"); assert.equal(call.init.cache, "no-store"); assert.equal(call.init.redirect, "error"); assert(call.init.signal instanceof AbortSignal); assert(!call.url.includes("?")); }
  for (const payload of [{ enabled: false, protocol: 2 }, { enabled: true, protocol: 1 }, { enabled: true }]) await assert.rejects(createRoomEntryApi({ fetch: (async () => response(payload)) as typeof fetch }).capabilities(), /unavailable/);
});
test("mismatched/malformed room responses and oversized bodies cannot open a workspace", async () => {
  for (const payload of [{ ...state(), code: "XYZ789" }, { ...state(), roomId: "foreign" }, { ...state(), members: [] }]) {
    await assert.rejects(createRoomEntryApi({ fetch: (async () => response(payload)) as typeof fetch }).enter({ kind: "join", code: "ALC234" }, "Guest"), /invalid_response/);
  }
  let cancelled = false;
  const oversized = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(65537)); }, cancel() { cancelled = true; } });
  await assert.rejects(createRoomEntryApi({ fetch: (async () => new Response(oversized)) as typeof fetch }).capabilities(), /invalid_response/);
  assert.equal(cancelled, true);
});
test("aborted entry and late creation responses never produce a usable room result", async () => {
  const controller = new AbortController(); let calls = 0;
  controller.abort();
  const api = createRoomEntryApi({ signal: controller.signal, fetch: (async () => { calls++; return response(state()); }) as typeof fetch });
  await assert.rejects(api.enter({ kind: "create" }, "Host"), { name: "AbortError" }); assert.equal(calls, 0);
  const late = new AbortController();
  const delayed = createRoomEntryApi({ signal: late.signal, fetch: (async () => { late.abort(); return response(state()); }) as typeof fetch });
  await assert.rejects(delayed.enter({ kind: "create" }, "Host"), { name: "AbortError" });
});
test("rate-limit and denied responses retain actionable errors without leaking raw server detail", async () => {
  const api = createRoomEntryApi({ fetch: (async () => response({ error: "rate_limited", retryAfterMs: 999999 }, 429)) as typeof fetch });
  await assert.rejects(api.enter({ kind: "create" }, "Host"), error => error instanceof RoomApiError && error.retryAfterMs === 60000 && /Wait a minute/.test(roomEntryError(error)));
  assert.match(roomEntryError(new RoomApiError("access_denied", 403), true), /ask to join again/);
  assert.match(roomEntryError(new RoomApiError("unavailable", 503)), /solo booth/);
  assert(!roomEntryError(new Error("private SQL detail")).includes("SQL"));
});
test("public room hints are scoped, bounded, replaceable and never contain membership authority", () => {
  const items = new Map<string, string>(), storage = { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => { items.set(key, value); } };
  rememberRoom("device", state(), storage);
  assert.equal(rememberedRoomId("device", "ALC234", storage), ROOM_ID);
  assert.equal(rememberedRoomId(`account:${MEMBER_A}`, "ALC234", storage), null);
  assert.deepEqual(JSON.parse([...items.values()][0]), [{ code: "ALC234", roomId: ROOM_ID }]);
  forgetRememberedRoom("device", "ALC234", SESSION_ID, storage);
  assert.equal(rememberedRoomId("device", "ALC234", storage), ROOM_ID);
  forgetRememberedRoom("device", "ALC234", ROOM_ID, storage);
  assert.equal(rememberedRoomId("device", "ALC234", storage), null);
  for (let index = 2; index <= 9; index++) rememberRoom("device", { code: `ABCDE${index}`, roomId: crypto.randomUUID() }, storage);
  rememberRoom("device", state(), storage);
  assert.equal(JSON.parse([...items.values()][0]).length, 8);
  items.set("pb-room-v2-lookup:device", JSON.stringify([{ code: "ALC234", roomId: "javascript:alert(1)" }]));
  assert.equal(rememberedRoomId("device", "ALC234", storage), null);
  const blocked = { getItem: () => { throw new Error("Storage blocked"); }, setItem: () => { throw new Error("Storage blocked"); } };
  assert.equal(rememberedRoomId("device", "ALC234", blocked), null);
  assert.doesNotThrow(() => rememberRoom("device", state(), blocked));
});
