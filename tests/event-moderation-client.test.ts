import test from "node:test";
import assert from "node:assert/strict";
import { createEventModerationClient } from "../lib/events/moderation-client";
import { EVENT_PUBLICATION_LIMITS } from "../lib/events/publication-contract";

const ownerId = "50000000-0000-4000-8000-000000000001", eventId = "50000000-0000-4000-8000-000000000010", submissionId = "50000000-0000-4000-8000-000000000100", requestId = "50000000-0000-4000-8000-000000000200";
const entry = { submissionId, revision: 4, createdAt: "2026-09-23T00:00:00.000Z", state: "ready", gallery: "approved", wall: "private", galleryConsent: true, wallConsent: false, thumbnailAvailable: true };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const setup = (fetcher: typeof fetch, extra: Partial<Parameters<typeof createEventModerationClient>[0]> = {}) => createEventModerationClient({ appOrigin: "https://booth.example", identity: () => ({ ownerId, epoch: 1 }), accessToken: async () => "fixture-token", fetch: fetcher, ...extra });

test("moderation client uses exact private actor-bound requests and validates publication capability", async () => {
  const calls: Record<string, unknown>[] = [];
  const client = setup(async (url, init) => {
    assert.equal(url, `https://booth.example/api/events/${eventId}/moderation`); assert.equal(init?.credentials, "omit"); assert.equal(init?.cache, "no-store"); assert.equal(init?.redirect, "error"); assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer fixture-token");
    const body = JSON.parse(String(init?.body)); calls.push(body);
    return json(body.operation === "capabilities" ? EVENT_PUBLICATION_LIMITS : body.operation === "list" ? { version: 1, eventId, entries: [entry], nextCursor: null } : entry);
  });
  assert.equal((await client.capabilities(eventId)).freshnessMs, 10000);
  assert.equal((await client.list(eventId)).entries[0].submissionId, submissionId);
  await client.decide(eventId, { submissionId, destination: "gallery", expectedRevision: 3, state: "approved", requestId });
  assert.deepEqual(calls[2], { operation: "decide", submissionId, destination: "gallery", expectedRevision: 3, state: "approved", requestId }); client.close();
});

test("privacy decisions cannot allocate approval receipts and changed scopes are rejected", async () => {
  let calls = 0;
  const client = setup(async () => { calls++; return json({ ...entry, submissionId: requestId }); });
  await assert.rejects(client.decide(eventId, { submissionId, destination: "gallery", expectedRevision: 3, state: "hidden", requestId } as never)); assert.equal(calls, 0);
  await assert.rejects(client.decide(eventId, { submissionId, destination: "gallery", expectedRevision: 3, state: "hidden" }), { code: "invalid_response" });
  await assert.rejects(client.list(eventId, undefined, 13), { code: "invalid_request" }); client.close();
});

test("account changes while waiting for a token prevent a moderation request", async () => {
  let epoch = 1, resolve!: (value: string) => void, calls = 0;
  const client = setup(async () => { calls++; return json(entry); }, { identity: () => ({ ownerId, epoch }), accessToken: () => new Promise(r => { resolve = r; }) });
  const pending = client.list(eventId); epoch = 2; resolve("fixture-token");
  await assert.rejects(pending, { code: "identity_changed" }); assert.equal(calls, 0); client.close();
});

test("uncooperative token and fetch waits settle at the client deadline without replay", async () => {
  let calls = 0;
  for (const stalledToken of [true, false]) {
    const client = setup(async () => { calls++; return new Promise<Response>(() => {}); }, { timeoutMs: 5, ...(stalledToken ? { accessToken: () => new Promise<string | null>(() => {}) } : {}) });
    await assert.rejects(client.list(eventId), { code: "timeout" }); client.close();
  }
  assert.equal(calls, 1);
});

test("tiny response chunks and stale removal responses fail closed", async () => {
  const client = setup(async () => new Response(new ReadableStream({ start(controller) { for (let i = 0; i < 65; i++) controller.enqueue(new Uint8Array([32])); controller.close(); } }), { headers: { "Content-Type": "application/json" } }));
  await assert.rejects(client.list(eventId), { code: "response_too_large" }); client.close();
  const stale = setup(async () => json({ ...entry, state: "deleted", revision: 2 }));
  await assert.rejects(stale.remove(eventId, submissionId, 3), { code: "invalid_response" }); stale.close();
});

test("missing publication capability and foreign resolved reports are not accepted", async () => {
  const client = setup(async (_url, init) => json(JSON.parse(String(init?.body)).operation === "capabilities" ? { ...EVENT_PUBLICATION_LIMITS, publicationVersion: 0 } : { version: 1, reportId: submissionId, status: "resolved" }));
  await assert.rejects(client.capabilities(eventId), { code: "update_required" });
  await assert.rejects(client.resolve(eventId, requestId), { code: "invalid_response" }); client.close();
});

test("host reports bound Unicode details and retain exact request identity", async () => {
  const calls: unknown[] = [], client = setup(async (_url, init) => { calls.push(JSON.parse(String(init?.body))); return json({ version: 1, reportId: requestId, status: "open" }); });
  const report = { submissionId, destination: "gallery" as const, requestId, reason: "privacy" as const, detail: "🙂".repeat(500) };
  await client.report(eventId, report); await client.report(eventId, report);
  assert.deepEqual(calls[0], calls[1]);
  await assert.rejects(client.report(eventId, { ...report, detail: "🙂".repeat(501) }), { code: "invalid_request" });
  await assert.rejects(client.report(eventId, { ...report, detail: "unsafe\u0000detail" }), { code: "invalid_request" });
  assert.equal(calls.length, 2); client.close();
});
