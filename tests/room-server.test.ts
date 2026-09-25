import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createRoomHandler, validateRoomBody } from "../lib/server/room-requests";
import { RoomServerError, type RoomStore } from "../lib/server/room-store";

const ROOM = "11111111-1111-4111-8111-111111111111", MEMBER = "22222222-2222-4222-8222-222222222222";
const env = { PB_ROOM_V2_ENABLED: "true", PB_ROOM_RATE_SECRET: "fixture-only-not-a-real-secret-value", PB_ROOM_TRUSTED_IP_HEADER: "x-fixture-ip", PB_PUBLIC_ORIGIN: "https://booth.example", NODE_ENV: "production" };
const request = (body: unknown, cookie = "", extra: Record<string, string> = {}) => new Request(`https://booth.example/api/rooms/${ROOM}/state`, { method: "POST", headers: { origin: env.PB_PUBLIC_ORIGIN, "content-type": "application/json", "x-fixture-ip": "192.0.2.1", cookie, ...extra }, body: JSON.stringify(body) });
const store = (overrides: Partial<RoomStore> = {}): RoomStore => ({ ready: async () => {}, rate: async () => {}, create: async () => ({ roomId: ROOM }), join: async () => ({ roomId: ROOM }), call: async () => ({ roomId: ROOM }), ...overrides });

test("disabled, missing-origin and foreign-origin requests have no database effects", async () => {
  let calls = 0; const factory = () => { calls++; return store(); };
  assert.equal((await createRoomHandler("create", factory, () => ({ ...env, PB_ROOM_V2_ENABLED: "false" }))(request({ displayName: "Host" }))).status, 503);
  assert.equal((await createRoomHandler("create", factory, () => ({ ...env, PB_PUBLIC_ORIGIN: "" }))(request({ displayName: "Host" }))).status, 503);
  const denied = await createRoomHandler("create", factory, () => env)(request({ displayName: "Host" }, "", { origin: "https://foreign.example" }));
  assert.equal(denied.status, 403); assert.deepEqual(await denied.json(), { error: "origin_denied" }); assert.equal(calls, 0);
});

test("credential is hashed for persistence and issued only in a room-scoped secure HttpOnly cookie", async () => {
  let storedHash = "", rateHash = "";
  const response = await createRoomHandler("create", () => store({ create: async input => { storedHash = input.hash; rateHash = input.rateHash; return { roomId: ROOM, selfId: input.memberId }; } }), () => env)(request({ displayName: "Host" }));
  assert.equal(response.status, 201);
  const cookie = response.headers.get("set-cookie")!;
  assert.match(cookie, /HttpOnly; SameSite=Strict; Secure/); assert.match(cookie, new RegExp(`Path=/api/rooms/${ROOM};`));
  const token = cookie.split(";")[0].split("=")[1];
  assert.equal(token.length, 43); assert.equal(storedHash, createHash("sha256").update(token).digest("hex")); assert.match(rateHash, /^[a-f0-9]{64}$/);
  const body = await response.text(); assert(!body.includes(token)); assert(!body.includes(storedHash));
  assert.equal(response.headers.get("cache-control"), "private, no-store"); assert.equal(response.headers.get("referrer-policy"), "no-referrer");
});

test("admission exchange has a stable retry token and does not expose the exchange flag", async () => {
  const credential = "A".repeat(43), cookie = `__Secure-pb-room-${ROOM}=${credential}`;
  const hashes: string[] = [];
  const handler = createRoomHandler("state", () => store({ call: async (_room, _hash, _action, _body, nextHash) => { hashes.push(nextHash); return { roomId: ROOM, exchanged: true }; } }), () => env);
  const first = await handler(request({}, cookie), ROOM), second = await handler(request({}, cookie), ROOM);
  assert.equal(first.headers.get("set-cookie"), second.headers.get("set-cookie")); assert.equal(hashes[0], hashes[1]);
  assert.deepEqual(await first.json(), { roomId: ROOM });
});

test("missing, duplicate and foreign-room cookies reject before database access", async () => {
  let calls = 0; const handler = createRoomHandler("state", () => { calls++; return store(); }, () => env);
  for (const cookie of ["", `__Secure-pb-room-${MEMBER}=${"A".repeat(43)}`, `__Secure-pb-room-${ROOM}=${"A".repeat(43)}; __Secure-pb-room-${ROOM}=${"B".repeat(43)}`]) assert.equal((await handler(request({}, cookie), ROOM)).status, 403);
  assert.equal(calls, 0);
});

test("finite bodies, strict message fields and bounded capture profiles reject before storage", async () => {
  let calls = 0; const handler = createRoomHandler("create", () => { calls++; return store(); }, () => env);
  assert.equal((await handler(request({ displayName: "x".repeat(40001) }))).status, 400);
  assert.throws(() => validateRoomBody("signal", { messageId: MEMBER, toMemberId: MEMBER, connectionEpoch: MEMBER, kind: "sdp", payload: "a".repeat(32769) }));
  assert.throws(() => validateRoomBody("signal", { messageId: MEMBER, toMemberId: MEMBER, connectionEpoch: MEMBER, kind: "ice", payload: "{}", fromMemberId: ROOM }));
  assert.throws(() => validateRoomBody("prepare", { captureId: MEMBER, rosterRevision: 1, recipeHash: "a".repeat(64), shotIds: ["one"], fireAt: Date.now() + 10000, intervalMs: 1000, profile: { shotsPerMember: 4, maxPhotoBytes: 1000, maxPhotoPixels: 1000 } }));
  assert.equal(calls, 0);
});

test("rate admission commits separately before an invalid room request and reports retry timing", async () => {
  const order: string[] = [];
  const handler = createRoomHandler("join", () => store({ rate: async () => { order.push("rate"); }, join: async () => { order.push("join"); throw new RoomServerError("access_denied", 403); } }), () => env);
  assert.equal((await handler(request({ code: "ABC234", displayName: "Guest" }))).status, 403); assert.deepEqual(order, ["rate", "join"]);
  const limited = await createRoomHandler("join", () => store({ rate: async () => { throw new RoomServerError("rate_limited", 429); }, join: async () => { assert.fail("must not join"); } }), () => env)(request({ code: "ABC234", displayName: "Guest" }));
  assert.equal(limited.status, 429); assert.equal(limited.headers.get("retry-after"), "60"); assert.deepEqual(await limited.json(), { error: "rate_limited", retryAfterMs: 60000 });
});

test("untrusted proxy lists and absent schema fail closed without calling room mutations", async () => {
  let created = 0;
  const handler = createRoomHandler("create", () => { created++; return store(); }, () => env);
  assert.equal((await handler(request({ displayName: "Host" }, "", { "x-fixture-ip": "192.0.2.1, 192.0.2.2" }))).status, 503); assert.equal(created, 0);
  const missing = createRoomHandler("create", () => store({ ready: async () => { throw new Error("raw SQL details"); }, create: async () => { assert.fail("must not create"); } }), () => env);
  const response = await missing(request({ displayName: "Host" })); assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: "unavailable" });
});
