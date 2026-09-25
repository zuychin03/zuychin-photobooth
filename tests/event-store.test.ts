import assert from "node:assert/strict";
import test from "node:test";
import { EVENT_LIMITS } from "../lib/events/contract";
import { createEventStore, verifyEventActor, type EventRpcClient, type VerifiedEventActor } from "../lib/server/event-store";

const eventId = "11111111-1111-4111-8111-111111111111", submissionId = "22222222-2222-4222-8222-222222222222", guestId = "33333333-3333-4333-8333-333333333333";
const token = "a".repeat(64), env = { PB_EVENTS_ENABLED: "true", NEXT_PUBLIC_SUPABASE_URL: "https://fixture.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "fixture-only" };
const caps = { version: 1, ready: true, deploymentBytes: 250_000_000, allocatedBytes: 0, limits: EVENT_LIMITS };
function fixture(value: unknown = {}) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  let capability: unknown = caps, result = value, error: { message: string; code?: string } | null = null;
  const client: EventRpcClient = { rpc: async (name, args) => { calls.push({ name, args }); return { data: name === "pb_event_capabilities" ? capability : result, error: name === "pb_event_capabilities" ? null : error }; } };
  return { store: createEventStore(env, client), calls, client, capability: (value: unknown) => { capability = value; }, result: (value: unknown) => { result = value; }, error: (value: { message: string; code?: string }) => { error = value; } };
}
const receipt = () => ({ submissionId, state: "reserved", logicalExpiresAt: "2026-09-23T00:10:00Z", eventExpiresAt: "2026-10-23T00:00:00Z", gallery: "private", wall: "private" });

test("event adapter is disabled without explicit configuration and rejects incompatible schema budgets", async () => {
  const f = fixture(); assert.throws(() => createEventStore({ ...env, PB_EVENTS_ENABLED: "false" }, f.client), /unavailable/);
  f.capability({ ...caps, ready: false }); await assert.rejects(f.store.claimJobs(), /not_ready/); assert.equal(f.calls.length, 1);
  f.capability({ ...caps, limits: { ...EVENT_LIMITS, imageBytes: 1 } }); await assert.rejects(f.store.capabilities(), /unavailable/);
});
test("owner operations require an actor obtained from verified Supabase user lookup", async () => {
  const f = fixture({ accepted: true });
  await assert.rejects(f.store.manage({ id: guestId } as VerifiedEventActor, eventId, "open"), /access_denied/); assert.equal(f.calls.length, 0);
  await assert.rejects(verifyEventActor({ getUser: async () => ({ data: { user: null }, error: null }) }), /access_denied/);
  const actor = await verifyEventActor({ getUser: async () => ({ data: { user: { id: guestId } }, error: null }) });
  await f.store.manage(actor, eventId, "open"); assert.equal(f.calls.at(-1)?.args.p_actor, guestId); assert(Object.isFrozen(actor));
});
test("reservation contract binds exact receipt session and server-generated object path", async () => {
  const f = fixture({ ...receipt(), stagingHeldBytes: EVENT_LIMITS.imageBytes, derivativeHeldBytes: EVENT_LIMITS.derivativeBytes, stagingPath: `${eventId}/${submissionId}/source` });
  const input = { eventId, tokenHash: token, submissionId, requestId: crypto.randomUUID(), receiptHash: "b".repeat(64), contributors: [guestId], consent: { submission: true, gallery: false, wall: false } };
  assert.equal((await f.store.reserve(input)).submissionId, submissionId); assert.equal(f.calls.at(-1)?.args.p_receipt_hash, input.receiptHash);
  f.result({ ...receipt(), submissionId: guestId }); await assert.rejects(f.store.receipt(eventId, token, submissionId), /unavailable/);
  await assert.rejects(f.store.reserve({ ...input, contributors: [] }), /invalid_request/);
});
test("upload permission requires the exact bounded bucket/path, issuance window and no overwrite", async () => {
  const mint = Date.now() + 60_000;
  const good = { bucket: "photobooth-event-images-staging-v2", path: `${eventId}/${submissionId}/source`, generation: 1, mintBefore: new Date(mint).toISOString(), authorisationUntil: new Date(mint + 7_200_000).toISOString(), cleanupAfter: new Date(mint + 7_500_000).toISOString(), maxBytes: EVENT_LIMITS.imageBytes, overwrite: false };
  const f = fixture(good); assert.equal((await f.store.authoriseUpload(eventId, token, submissionId)).generation, 1);
  for (const bad of [{ overwrite: true }, { path: "another/event/source" }, { maxBytes: 10_000_000 }, { generation: 9 }, { cleanupAfter: good.authorisationUntil }]) { f.result({ ...good, ...bad }); await assert.rejects(f.store.authoriseUpload(eventId, token, submissionId), /unavailable/); }
});
test("private reads accept only the exact delivery object and at most five minutes", async () => {
  const good = { bucket: "photobooth-events-v2", path: `${eventId}/${submissionId}/image`, maxAgeSeconds: 300 }, f = fixture(good);
  assert.equal((await f.store.readAccess(eventId, token, submissionId, "receipt")).maxAgeSeconds, 300);
  for (const bad of [{ bucket: "photobooth-strips" }, { path: "foreign/image" }, { maxAgeSeconds: 301 }]) { f.result({ ...good, ...bad }); await assert.rejects(f.store.readAccess(eventId, token, submissionId, "receipt"), /unavailable/); }
});
test("job errors are bounded codes without SQL details and invalid batches perform no RPC", async () => {
  const f = fixture(); await assert.rejects(f.store.claimJobs(11), /invalid_request/); assert.equal(f.calls.length, 0);
  f.error({ message: "PB_EVENT_LEASE" }); await assert.rejects(f.store.finishJob(eventId, submissionId, "complete"), /lease_lost/);
  f.error({ message: "private SQL detail with object path" }); await assert.rejects(f.store.claimJobs(), error => error instanceof Error && error.message === "unavailable");
});
test("guest finalisation returns only its receipt and cannot expose worker lease fields", async () => {
  const expected = { ...receipt(), state: "finalising" }, f = fixture({ ...expected, lease_token: crypto.randomUUID(), checkpoint: { privateWorkerContext: true } });
  assert.deepEqual(await f.store.enqueueFinalise(eventId, token, submissionId), expected);
  f.result({ ...expected, submissionId: guestId }); await assert.rejects(f.store.enqueueFinalise(eventId, token, submissionId), /unavailable/);
});
