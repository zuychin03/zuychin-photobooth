import assert from "node:assert/strict";
import test from "node:test";
import { createEventGuestClient, createEventHostClient, EventClientError, parseEventReceipt } from "../lib/events/client";
import { EVENT_LIMITS } from "../lib/events/contract";
import { readFile } from "node:fs/promises";
import type { EventUploadGrant } from "../lib/events/client";
import { DEFAULT_EVENT_LOOK } from "../lib/events/host-contract";

const eventId = "11111111-1111-4111-8111-111111111111", guestId = "22222222-2222-4222-8222-222222222222", id = "33333333-3333-4333-8333-333333333333", appOrigin = "https://app.example";
const token = Buffer.alloc(32, 1).toString("base64url"), identity = { eventId, guestId, epoch: 1 }, consent = { submission: true, gallery: false, wall: false };
const receipt = { submissionId: id, state: "reserved", logicalExpiresAt: "2099-01-01T00:10:00Z", eventExpiresAt: "2099-01-02T00:00:00Z", gallery: "private", wall: "private" };
const session = { eventId, guestId, kind: "contribute", submissionId: null, expiresAt: "2099-01-02T00:00:00Z" };
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
const guest = (fetcher: typeof fetch, extra: Partial<Parameters<typeof createEventGuestClient>[0]> = {}) => createEventGuestClient({ appOrigin, eventId, identity: () => identity, fetch: fetcher, ...extra });
test("guest reservation uses only same-origin cookie authority and exact immutable IDs/consent", async () => {
  const client = guest(async (url, init) => { assert.equal(url, `${appOrigin}/api/events/${eventId}/guest`); assert.equal(init?.credentials, "same-origin"); assert.equal(init?.redirect, "error"); assert.equal(init?.cache, "no-store"); assert.equal(new Headers(init?.headers).get("authorization"), null); assert.deepEqual(JSON.parse(String(init?.body)), { operation: "reserve", requestId: id, submissionId: id, consent, expectedGuestId: guestId }); return json({ receipt, receiptToken: token, replacesBrowserReceipt: true, fragmentOnly: true }); });
  assert.equal((await client.reserve({ requestId: id, submissionId: id, consent })).receiptToken, token);
});
test("guest adoption/replacement is explicit and response scope cannot silently change", async () => {
  const client = guest(async () => json({ ...session, guestId: id })); await assert.rejects(client.session(), /identity_changed/);
  await assert.rejects(client.redeem(token, token), /explicit_replacement_required/);
  const fresh = guest(async () => json({ ...session, replacesBrowserGuestSession: true }), { identity: () => null }); assert.equal((await fresh.redeem(token, token)).guestId, guestId); await assert.rejects(fresh.reserve({ requestId: id, submissionId: id, consent }), /identity_required/);
});
test("closed client and epoch replacement fence uncooperative late responses", async () => {
  let epoch = 1, resolve: ((r: Response) => void) | undefined;
  const client = guest(() => new Promise(r => { resolve = r; }), { identity: () => ({ ...identity, epoch }) }); const pending = client.session(); epoch++; resolve!(json(session)); await assert.rejects(pending, /identity_changed/);
  const closed = guest(() => new Promise(() => undefined)); const work = closed.session(); closed.close(); await assert.rejects(work, /cancelled/);
});
test("host token refresh is account fenced and capabilities never send bearer", async () => {
  let epoch = 1, calls = 0;
  const client = createEventHostClient({ appOrigin, identity: () => ({ ownerId: guestId, epoch }), accessToken: async () => { epoch++; return "synthetic-token"; }, fetch: async () => { calls++; return json({}); } });
  await assert.rejects(client.dashboard(eventId), /identity_changed/); assert.equal(calls, 0);
  const caps = createEventHostClient({ appOrigin, identity: () => ({ ownerId: guestId, epoch: 1 }), accessToken: async () => { throw new Error("Must not authenticate capabilities"); }, fetch: async (_url, init) => { assert.equal(new Headers(init?.headers).has("authorization"), false); return json({ enabled: true, version: 1, transportVersion: 1, limits: EVENT_LIMITS, uploadsAvailable: false, downloadsAvailable: false }); } }); assert.equal((await caps.capabilities()).uploadsAvailable, false);
});
test("malformed and scope-swapped private projections fail instead of propagating secrets", async () => {
  assert.throws(() => parseEventReceipt({ ...receipt, signedUrl: "https://secret.example" })); assert.throws(() => parseEventReceipt({ ...receipt, logicalExpiresAt: "2026-02-31T00:00:00Z" }));
  await assert.rejects(guest(async () => json({ ...receipt, submissionId: guestId })).readReceipt(id));
  await assert.rejects(guest(async () => json({ receipt, receiptToken: `${token.slice(0, -1)}B`, replacesBrowserReceipt: true, fragmentOnly: true })).reserve({ requestId: id, submissionId: id, consent }));
});
test("deadline and bounded error responses preserve finite retry advice without raw server errors", async () => {
  await assert.rejects(guest(() => new Promise(() => undefined), { timeoutMs: 5 }).session(), /timeout/);
  await assert.rejects(guest(async () => json({ error: "rate_limited" }, 429, { "retry-after": "42" })).session(), (error: unknown) => error instanceof EventClientError && error.retryAfterSeconds === 42);
  await assert.rejects(guest(async () => json({ error: "private-secret-error" }, 500)).session(), /unavailable/);
  await assert.rejects(guest(async () => json({}, 200, { "content-length": "65537" })).session(), /response_too_large/);
  let n = 0; const body = new ReadableStream<Uint8Array>({ pull(c) { if (++n <= 4097) c.enqueue(new Uint8Array()); else c.close(); } }); await assert.rejects(guest(async () => new Response(body, { headers: { "content-type": "application/json" } })).session(), /response_too_large/);
});
const storageOrigin = "https://storage.example", uploadPath = `${eventId}/${id}/source`;
const uploadGrant = (): EventUploadGrant => ({ submissionId: id, bucket: "photobooth-event-images-staging-v2", path: uploadPath, signedUrl: `${storageOrigin}/storage/v1/object/upload/sign/photobooth-event-images-staging-v2/${uploadPath}?token=ephemeral`, expiresAt: new Date(Date.now() + 600000).toISOString(), maxBytes: 2000000, overwrite: false });
test("signed upload rejects foreign origins, paths, query fields and overwrite before transfer", async () => {
  let requests = 0; const blob = new Blob([await readFile("tests/fixtures/projects/b.png")], { type: "image/png" }), valid = uploadGrant();
  const c = guest(async () => { requests++; return json({}); }, { storageOrigin });
  for (const mutation of [{ signedUrl: valid.signedUrl.replace(storageOrigin, "https://foreign.example") }, { path: `${guestId}/${id}/source` }, { signedUrl: `${valid.signedUrl}&other=x` }, { overwrite: true }, { expiresAt: "2000-01-01T00:00:00Z" }]) await assert.rejects(c.upload(id, blob, { ...valid, ...mutation } as EventUploadGrant));
  assert.equal(requests, 0);
});
test("raw no-overwrite transfer never sends app credentials and 400 stays uncertain", async () => {
  const blob = new Blob([await readFile("tests/fixtures/projects/b.png")], { type: "image/png" }); let status = 400;
  const c = guest(async (_url, init) => { assert.equal(init?.method, "PUT"); assert.equal(init?.credentials, "omit"); assert.equal(init?.referrerPolicy, "no-referrer"); assert.equal(new Headers(init?.headers).get("x-upsert"), "false"); assert(!new Headers(init?.headers).has("authorization")); assert(init?.body instanceof Blob); return json({}, status); }, { storageOrigin });
  await assert.rejects(c.upload(id, blob, uploadGrant()), /upload_uncertain/); status = 409; assert.equal((await c.upload(id, blob, uploadGrant())).acknowledged, false); status = 200; assert.equal((await c.upload(id, blob, uploadGrant())).acknowledged, true);
});
test("receipt JPEG download repeats authority after bytes and withholds output on revocation", async () => {
  const sharp = (await import("sharp")).default, bytes = await sharp({ create: { width: 8, height: 12, channels: 3, background: "#dd7788" } }).jpeg().toBuffer(); let mediaCalls = 0, revoked = true;
  const c = guest(async (url, init) => { if (String(url).startsWith(storageOrigin)) { assert.equal(init?.credentials, "omit"); return new Response(bytes, { headers: { "content-type": "image/jpeg" } }); } mediaCalls++; if (revoked && mediaCalls % 2 === 0) return json({ error: "access_denied" }, 403); return json({ submissionId: id, bucket: "photobooth-events-v2", path: `${eventId}/${id}/image`, signedUrl: `${storageOrigin}/storage/v1/object/sign/photobooth-events-v2/${eventId}/${id}/image?token=temporary`, expiresAt: new Date(Date.now() + 60000).toISOString(), maxBytes: 2000000, mime: "image/jpeg" }); }, { storageOrigin });
  await assert.rejects(c.download(id), /access_denied/); assert.equal(mediaCalls, 2); revoked = false; const downloaded = await c.download(id); assert.equal(downloaded.width, 8); assert.equal(downloaded.height, 12); assert.equal(downloaded.blob.type, "image/jpeg"); assert.equal(mediaCalls, 4);
});
test("host discovery rejects cursor/scope leakage and settings preserve opaque newer retry revision", async () => {
  const event = { title: "Synthetic gathering", timezone: "Australia/Sydney", startsAt: "2026-01-01T00:00:00Z", closesAt: "2098-01-01T00:00:00Z", expiresAt: "2099-01-01T00:00:00Z", maxGuests: 25, maxContributions: 100, maxBytes: 250000000 };
  let result: unknown = { version: 1, events: [{ eventId, title: event.title, timezone: event.timezone, startsAt: event.startsAt, closesAt: event.closesAt, expiresAt: event.expiresAt, status: "open", role: "moderator", membership: "invited" }], nextCursor: null };
  const c = createEventHostClient({ appOrigin, identity: () => ({ ownerId: guestId, epoch: 1 }), accessToken: async () => "test-session", fetch: async () => json(result) });
  assert.equal((await c.list()).events[0].membership, "invited"); await assert.rejects(c.list({ after: eventId }));
  result = { version: 1, eventId, revision: 5, locked: true, event, look: DEFAULT_EVENT_LOOK }; assert.equal((await c.saveSettings(eventId, { requestId: id, expectedRevision: 1, settings: { event, look: DEFAULT_EVENT_LOOK } })).revision, 5);
  assert.equal((await c.saveSettings(eventId, { requestId: id, expectedRevision: 5, settings: { event, look: DEFAULT_EVENT_LOOK } })).revision, 5);
  result = { ...(result as object), look: { ...DEFAULT_EVENT_LOOK, sceneId: "https://foreign.example/private" } }; await assert.rejects(c.settings(eventId));
});
