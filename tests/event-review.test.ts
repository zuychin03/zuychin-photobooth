import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { createHash } from "node:crypto";
import { EVENT_REVIEW_LIMITS, parseEventReviewAccess, parseEventReviewPage, type EventReviewAccess } from "../lib/events/review-contract";
import { createEventReviewClient } from "../lib/events/review-client";
import { createEventReviewStore } from "../lib/server/event-review-store";
import { createEventReviewHandler, type EventReviewRequestPorts } from "../lib/server/event-review-requests";
import { createEventObjects } from "../lib/server/event-objects";
import { verifyEventActor, EventStoreError } from "../lib/server/event-store";
import { EVENT_LIMITS } from "../lib/events/contract";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, eventId = id(1), submissionId = id(2), ownerId = id(3), expiresAt = "2099-01-01T00:00:00.000Z", instant = "2026-09-23T00:00:00.000Z";
const access: EventReviewAccess = { submissionId, bucket: "photobooth-events-v2", path: `${eventId}/${submissionId}/thumbnail`, bytes: 100, mime: "image/jpeg", sha256: null, expiresAt, maxAgeSeconds: 300 };
const entry = { submissionId, state: "ready" as const, logicalExpiresAt: instant, eventExpiresAt: expiresAt, gallery: "private" as const, wall: "private" as const, createdAt: instant, thumbnailAvailable: true }, page = { version: 1 as const, eventId, entries: [entry], nextCursor: null };
const env = { PB_EVENTS_ENABLED: "true", PB_PUBLIC_ORIGIN: "https://app.example", PB_EVENT_TRANSPORT_SECRET: "fixture-private-review-transport-secret", NEXT_PUBLIC_SUPABASE_URL: "https://storage.example", SUPABASE_SERVICE_ROLE_KEY: "fixture" };
const actor = () => verifyEventActor({ getUser: async () => ({ data: { user: { id: ownerId } }, error: null }) });
const request = (body: unknown, headers: Record<string, string> = {}) => new Request(`https://app.example/api/events/${eventId}/review`, { method: "POST", headers: { Origin: "https://app.example", Authorization: "Bearer fixture", "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

test("private review projections reject foreign paths, concealed extras, oversized batches and non-ready thumbnails", () => {
  assert.deepEqual(parseEventReviewPage(page, eventId), page); assert.deepEqual(parseEventReviewAccess(access, eventId), access);
  for (const bad of [{ ...access, path: `${eventId}/${submissionId}/image` }, { ...access, bytes: 100001 }, { ...access, sha256: "wrong" }, { ...access, submissionId: id(8) }, { ...access, signedUrl: "private" }]) assert.throws(() => parseEventReviewAccess(bad, eventId));
  assert.throws(() => parseEventReviewPage({ ...page, entries: [{ ...entry, state: "deleted" }] }, eventId));
  assert.throws(() => parseEventReviewPage({ ...page, entries: [{ ...entry, guestId: id(6) }] }, eventId));
  assert.throws(() => parseEventReviewPage({ ...page, entries: [entry, entry] }, eventId));
  assert.throws(() => parseEventReviewPage({ ...page, nextCursor: submissionId }, eventId));
});
test("review store binds verified actor, separate schema version and exact response identity", async () => {
  let schema = true, result: unknown = page; const calls: { name: string; args: Record<string, unknown> }[] = [];
  const store = createEventReviewStore(env, { rpc: async (name, args) => { calls.push({ name, args }); return { data: name === "pb_event_review_capabilities" ? { ...EVENT_REVIEW_LIMITS, version: schema ? 1 : 2 } : name === "pb_event_capabilities" ? { version: 1, ready: true, deploymentBytes: 250000000, allocatedBytes: 0, limits: EVENT_LIMITS } : result, error: null }; } });
  assert.deepEqual(await store.list(await actor(), eventId), page); assert.equal(calls.at(-1)?.args.p_actor, ownerId);
  await assert.rejects(store.list({ id: ownerId } as Awaited<ReturnType<typeof actor>>, eventId), /access_denied/);
  result = { ...page, eventId: id(8) }; await assert.rejects(store.list(await actor(), eventId), /unavailable/);
  schema = false; await assert.rejects(store.list(await actor(), eventId), /unavailable/);
});
function ports() {
  let allowed = true, rate = true, calls = 0, minted = 0;
  const value: EventReviewRequestPorts = { authenticate: async () => actor(), stores: () => ({
    base: { transportReady: async () => {}, rate: async () => { calls++; return { allowed: rate, retryAfterSeconds: 8 }; } },
    review: { capabilities: async () => EVENT_REVIEW_LIMITS, list: async () => page, access: async () => { if (!allowed) throw new EventStoreError("access_denied", 403); return access; } },
    objects: { signRead: async () => { minted++; return { signedUrl: "https://storage.example/private", expiresAt: new Date(Date.now() + 200000).toISOString() }; } },
  }) };
  return { value, deny() { allowed = false; }, limit() { rate = false; }, get calls() { return calls; }, get minted() { return minted; } };
}
test("review HTTP requires actor/origin/exact body, charges once and publishes no link after mid-mint revocation", async () => {
  const p = ports(), handler = createEventReviewHandler(p.value, () => env);
  for (const [req, status] of [[request({ operation: "list", actor: ownerId }), 400], [request({ operation: "list" }, { Origin: "https://foreign.example" }), 403], [request({ operation: "list" }, { Authorization: "" }), 401]] as const) assert.equal((await handler(req, eventId)).status, status);
  assert.equal((await handler(request({ operation: "list" }), eventId)).status, 200); assert.equal(p.calls, 1);
  const original = p.value.stores; p.value.stores = (...args) => { const stores = original(...args); stores.objects.signRead = async () => { p.deny(); return { signedUrl: "private", expiresAt: new Date(Date.now() + 200000).toISOString() }; }; return stores; };
  const denied = await handler(request({ operation: "media", submissionId }), eventId); assert.equal(denied.status, 403); assert(!JSON.stringify(await denied.json()).includes("signedUrl")); assert.match(denied.headers.get("cache-control")!, /no-store/);
  p.limit(); const limited = await handler(request({ operation: "list" }), eventId); assert.equal(limited.status, 429); assert.equal(limited.headers.get("retry-after"), "8");
});
async function browserFixture(decode?: (blob: Blob) => Promise<{ width: number; height: number; close(): void }>) {
  const bytes = await sharp({ create: { width: 12, height: 8, channels: 3, background: "#d7869b" } }).jpeg().toBuffer(), descriptor = { ...access, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  let identity: { ownerId: string; epoch: number } | null = { ownerId, epoch: 1 }, allowed = true, closed = 0, changed = false;
  const p = ports(); p.value.stores = () => ({ base: { transportReady: async () => {}, rate: async () => ({ allowed: true, retryAfterSeconds: 0 }) }, review: { capabilities: async () => EVENT_REVIEW_LIMITS, list: async () => page, access: async () => { if (!allowed) throw new EventStoreError("access_denied", 403); return descriptor; } }, objects: { signRead: async () => ({ signedUrl: `https://storage.example/storage/v1/object/sign/${descriptor.bucket}/${descriptor.path}?token=private`, expiresAt: new Date(Date.now() + 200000).toISOString() }) } });
  const handler = createEventReviewHandler(p.value, () => env), client = createEventReviewClient({ appOrigin: "https://app.example", storageOrigin: "https://storage.example", identity: () => identity, accessToken: async () => "fixture", decode: decode ?? (async () => ({ width: 12, height: 8, close() { closed++; } })), fetch: async (url, init) => {
    if (String(url).startsWith("https://storage.example")) { const sent = new Uint8Array(bytes); if (changed) sent[sent.length - 1] ^= 1; return new Response(sent, { headers: { "content-type": "image/jpeg" } }); }
    return handler(new Request(String(url), { ...init, headers: { ...init?.headers as Record<string, string>, Origin: "https://app.example" } }), eventId);
  } });
  return { client, deny() { allowed = false; }, switchAccount() { identity = null; }, corrupt() { changed = true; }, get closed() { return closed; } };
}
test("actual browser client and HTTP shapes verify thumbnail hash/decode and never accept modified bytes", async () => {
  const f = await browserFixture(); assert.deepEqual(await f.client.capabilities(eventId), EVENT_REVIEW_LIMITS); assert.deepEqual(await f.client.list(eventId), page); assert.equal((await f.client.download(eventId, submissionId)).type, "image/jpeg"); assert.equal(f.closed, 1);
  f.corrupt(); await assert.rejects(f.client.download(eventId, submissionId), /invalid_image/); f.client.close();
});
test("revocation during native decode discards thumbnail and closes borrowed decode result", async () => {
  let close = 0; const f = await browserFixture(async () => { f.deny(); return { width: 12, height: 8, close() { close++; } }; });
  await assert.rejects(f.client.download(eventId, submissionId), /access_denied/); assert.equal(close, 1); f.client.close();
});
test("cancelled native decode retains the slot until settlement; account change wins over generic cancellation", async () => {
  let release!: () => void, started!: () => void, closed = 0; const begins = new Promise<void>(resolve => { started = resolve; });
  const f = await browserFixture(async () => { started(); await new Promise<void>(resolve => { release = resolve; }); return { width: 12, height: 8, close() { closed++; } }; }), abort = new AbortController(), pending = f.client.download(eventId, submissionId, abort.signal);
  await begins; abort.abort(); await assert.rejects(pending, /cancelled/); await assert.rejects(f.client.list(eventId), /busy/); release(); await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(closed, 1);
  f.switchAccount(); await assert.rejects(f.client.list(eventId), /identity_changed/);
});
test("provider signer allows exact private thumbnail and image paths but never staging or path traversal", async () => {
  const now = Date.now(); let calls = 0;
  const objects = createEventObjects({ origin: "https://storage.example", serviceRoleKey: "fixture" }, { now: () => now, fetch: async (url, init) => { calls++; const path = String(url).split("/object/sign/")[1], exp = Math.floor(now / 1000) + JSON.parse(String(init?.body)).expiresIn, token = `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ url: path, exp })).toString('base64url')}.signature`; return Object.defineProperty(new Response(JSON.stringify({ signedURL: `/object/sign/${path}?token=${token}` }), { headers: { "content-type": "application/json" } }), "url", { value: String(url) }); } });
  for (const kind of ["thumbnail", "image"]) assert.match((await objects.signRead({ ...access, path: `${eventId}/${submissionId}/${kind}` }, expiresAt)).signedUrl, new RegExp(`/${kind}\\?token=`));
  for (const path of [`${eventId}/${submissionId}/source`, `${eventId}/../thumbnail`, `${eventId}/${submissionId}/thumbnail/extra`]) await assert.rejects(objects.signRead({ ...access, path }, expiresAt), /invalid_descriptor/);
  assert.equal(calls, 2);
});

test("review RPC offsets normalise without accepting malformed response shapes", async () => {
 let value: unknown = { ...page, entries: [{ ...entry, createdAt: "2026-09-23T10:30:00+10:30", logicalExpiresAt: "2026-09-23T00:00:00+00:00", eventExpiresAt: "2099-01-01T00:00:00+00:00" }] };
 const store = createEventReviewStore(env, { rpc: async name => ({ data: name === "pb_event_review_capabilities" ? EVENT_REVIEW_LIMITS : name === "pb_event_capabilities" ? { version: 1, ready: true, deploymentBytes: 250000000, allocatedBytes: 0, limits: EVENT_LIMITS } : value, error: null }) });
 assert.deepEqual(parseEventReviewPage(await store.list(await actor(), eventId), eventId), page);
 value = { ...access, expiresAt: "2099-01-01T10:30:00+10:30" };
 assert.deepEqual(parseEventReviewAccess(await store.access(await actor(), eventId, submissionId), eventId), access);
 for (const invalid of [{ ...access, expiresAt: null }, { ...access, expiresAt: "2099-02-30T00:00:00+00:00" }, { ...access, extra: true }]) { value = invalid; await assert.rejects(store.access(await actor(), eventId, submissionId), /unavailable/); }
});
