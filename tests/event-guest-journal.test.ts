import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { nextEventGuestRecord, validateEventGuestRecord, matchEventGuestImage, reserveEventGuestRecord, uploadEventGuestRecord, type EventGuestRecord, type EventGuestJournal } from "../lib/events/guest-journal";
import { createEventGuestClient } from "../lib/events/client";
import { inspectImageHeader } from "../lib/projects/images";
const eventId = "11111111-1111-4111-8111-111111111111", guestId = "22222222-2222-4222-8222-222222222222", id = "33333333-3333-4333-8333-333333333333", now = Date.parse("2026-09-23T00:00:00Z");
async function record(retain = false): Promise<EventGuestRecord> { const bytes = await readFile("tests/fixtures/projects/b.png"), info = inspectImageHeader(bytes); return { version: 1, eventId, guestId, requestId: id, submissionId: id, revision: 0, consent: { submission: true, gallery: false, wall: false }, image: { ...info, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 86400000).toISOString(), stage: "prepared", receipt: null, keepOnDevice: retain, blob: retain ? new Blob([bytes], { type: info.mime }) : null }; }
const receipt = { submissionId: id, state: "reserved" as const, logicalExpiresAt: new Date(now + 600000).toISOString(), eventExpiresAt: new Date(now + 86400000).toISOString(), gallery: "private" as const, wall: "private" as const };
test("queue defaults to metadata only, refuses secret fields and requires explicit retained-byte agreement", async () => { const r = await record(); assert.equal(validateEventGuestRecord(r).blob, null); assert.throws(() => validateEventGuestRecord({ ...r, receiptToken: "secret" })); assert.throws(() => validateEventGuestRecord({ ...r, blob: new Blob(["x"]) })); assert.throws(() => validateEventGuestRecord({ ...r, expiresAt: new Date(now + 86400001).toISOString() })); });
test("interrupted stages retain original identity/consent and ready acknowledgement alone clears retained bytes", async () => { let r = await record(true); r = nextEventGuestRecord(r, { stage: "reserving" }, now); r = nextEventGuestRecord(r, { stage: "reserved", receipt }, now); r = nextEventGuestRecord(r, { stage: "uploading" }, now); const old = r; r = nextEventGuestRecord(r, { stage: "uploading" }, now); assert.equal(r.image.sha256, old.image.sha256); assert.equal(r.requestId, old.requestId); assert.deepEqual(r.consent, old.consent); assert(r.blob); assert.throws(() => nextEventGuestRecord(r, { stage: "ready" }, now)); const ready = nextEventGuestRecord(r, { stage: "ready", receipt: { ...receipt, state: "ready" } }, now); assert.equal(ready.blob, null); assert.throws(() => nextEventGuestRecord(ready, { stage: "uploading" }, now)); assert.throws(() => nextEventGuestRecord(r, { stage: "uploaded" }, now + 86400000), /queue_expired/); });
test("reselected file must match original digest, type and dimensions even with equal byte length", async () => { const r = await record(true); await matchEventGuestImage(r, r.blob!); const bytes = new Uint8Array(await r.blob!.arrayBuffer()); bytes[bytes.length - 1] ^= 1; await assert.rejects(matchEventGuestImage(r, new Blob([bytes])), /image_mismatch/); });
test("host retention extensions update receipts without extending device retention or the upload deadline", async () => {
  const original = { ...await record(true), stage: "reserved" as const, receipt }, extended = { ...receipt, eventExpiresAt: new Date(now + 172800000).toISOString() };
  const refreshed = nextEventGuestRecord(original, { stage: "reserved", receipt: extended }, now);
  assert.equal(refreshed.receipt?.eventExpiresAt, extended.eventExpiresAt);
  assert.equal(refreshed.expiresAt, original.expiresAt);
  assert.equal(refreshed.receipt?.logicalExpiresAt, receipt.logicalExpiresAt);
  assert.equal(refreshed.blob, original.blob);
  assert.throws(() => nextEventGuestRecord(refreshed, { stage: "reserved", receipt }, now), /conflict/);
  assert.throws(() => nextEventGuestRecord(refreshed, { stage: "reserved", receipt: { ...extended, logicalExpiresAt: new Date(now + 700000).toISOString() } }, now), /conflict/);
  const ready = nextEventGuestRecord(refreshed, { stage: "ready", receipt: { ...extended, state: "ready" } }, now);
  assert.equal(ready.blob, null); assert.equal(ready.expiresAt, original.expiresAt);
});
test("reservation persists ambiguous intent before network and retries same identifiers after lost acknowledgement", async () => {
  let stored = await record(), attempts = 0; const order: string[] = [];
  const journal = { eventId, guestId, assertActive() {}, get: async () => stored, update: async (_id: string, revision: number, patch: Parameters<EventGuestJournal["update"]>[2]) => { assert.equal(stored.revision, revision); order.push(`journal:${patch.stage}`); return stored = nextEventGuestRecord(stored, patch, now); } } as unknown as EventGuestJournal;
  const client = createEventGuestClient({ appOrigin: "https://app.example", eventId, identity: () => ({ eventId, guestId, epoch: 1 }), fetch: async (_url, init) => { order.push("network"); assert.equal(stored.stage, "reserving"); const body = JSON.parse(String(init?.body)); assert.equal(body.requestId, id); assert.equal(body.submissionId, id); if (++attempts === 1) throw new Error("Lost response"); return new Response(JSON.stringify({ receipt, receiptToken: Buffer.alloc(32).toString("base64url"), replacesBrowserReceipt: true, fragmentOnly: true }), { headers: { "content-type": "application/json" } }); } });
  await assert.rejects(reserveEventGuestRecord(journal, client, id), /network_error/); assert.equal(stored.stage, "reserving"); await reserveEventGuestRecord(journal, client, id); assert.equal(stored.stage, "reserved"); assert.deepEqual(order, ["journal:reserving", "network", "journal:reserving", "network", "journal:reserved"]); assert(!("receiptToken" in stored));
});
test("failed local intent persistence dispatches no reservation", async () => { let calls = 0; const journal = { eventId, guestId, assertActive() {}, get: async () => record(), update: async () => { throw new Error("QuotaExceededError"); } } as unknown as EventGuestJournal; const client = createEventGuestClient({ appOrigin: "https://app.example", eventId, identity: () => ({ eventId, guestId, epoch: 1 }), fetch: async () => { calls++; throw new Error("Unexpected"); } }); await assert.rejects(reserveEventGuestRecord(journal, client, id), /QuotaExceededError/); assert.equal(calls, 0); });
test("interrupted PUT remains retryable with identical bytes; finalising recovery needs no original reselect", async () => {
  let stored = { ...await record(true), stage: "reserved" as const, receipt } as EventGuestRecord, failPut = true, puts = 0, finalises = 0;
  const journal = { eventId, guestId, assertActive() {}, get: async () => stored, update: async (_id: string, revision: number, patch: Parameters<EventGuestJournal["update"]>[2]) => { assert.equal(stored.revision, revision); return stored = nextEventGuestRecord(stored, patch, now); } } as unknown as EventGuestJournal;
  const client = createEventGuestClient({ appOrigin: "https://app.example", storageOrigin: "https://storage.example", eventId, identity: () => ({ eventId, guestId, epoch: 1 }), fetch: async (url, init) => {
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    if (String(url).startsWith("https://storage.example")) { puts++; assert.equal(stored.stage, "uploading"); if (failPut) return json({}, 400); return json({}, 409); }
    const body = JSON.parse(String(init?.body)); if (body.operation === "upload") return json({ submissionId: id, bucket: "photobooth-event-images-staging-v2", path: `${eventId}/${id}/source`, signedUrl: `https://storage.example/storage/v1/object/upload/sign/photobooth-event-images-staging-v2/${eventId}/${id}/source?token=temporary`, expiresAt: new Date(Date.now() + 600000).toISOString(), maxBytes: 2000000, overwrite: false });
    assert.equal(body.operation, "finalise"); finalises++; return json({ ...receipt, state: finalises === 1 ? "finalising" : "ready" });
  } });
  await assert.rejects(uploadEventGuestRecord(journal, client, id), /upload_uncertain/); assert.equal(stored.stage, "uploading"); assert.equal(finalises, 0); assert(stored.blob);
  failPut = false; await uploadEventGuestRecord(journal, client, id); assert.equal(stored.stage, "finalising"); assert.equal(puts, 2);
  stored = { ...stored, blob: null, keepOnDevice: false }; await uploadEventGuestRecord(journal, client, id); assert.equal(stored.stage, "ready"); assert.equal(puts, 2); assert.equal(finalises, 2);
});

test("legacy records preserve reservation identity and mission records pin exact optional choice across retry", async () => {
  const legacy = await record(true), parsed = validateEventGuestRecord(legacy);
  assert.deepEqual(parsed, legacy); assert.equal(parsed.missionChoice, undefined);
  for (const missionId of [null, "same-energy-1"]) {
    let stored = validateEventGuestRecord({ ...legacy, missionChoice: { version: 1, missionId } }), attempts = 0;
    const journal = { eventId, guestId, assertActive() {}, get: async () => stored, update: async (_id: string, revision: number, patch: Parameters<EventGuestJournal["update"]>[2]) => { assert.equal(stored.revision, revision); return stored = nextEventGuestRecord(stored, patch, now); } } as unknown as EventGuestJournal;
    const client = createEventGuestClient({ appOrigin: "https://app.example", eventId, identity: () => ({ eventId, guestId, epoch: 1 }), fetch: async (_url, init) => { const body = JSON.parse(String(init?.body)); assert.equal(stored.stage, "reserving"); assert.equal(body.operation, "reserveMission"); assert.equal(body.missionId, missionId); assert.equal(body.requestId, legacy.requestId); assert.equal(body.expectedGuestId, guestId); if (++attempts === 1) throw new Error("Lost response"); return new Response(JSON.stringify({ receipt, receiptToken: Buffer.alloc(32).toString("base64url"), replacesBrowserReceipt: true, fragmentOnly: true }), { headers: { "content-type": "application/json" } }); } });
    await assert.rejects(reserveEventGuestRecord(journal, client, id), /network_error/);
    stored = validateEventGuestRecord(structuredClone(stored));
    await reserveEventGuestRecord(journal, client, id);
    assert.equal(stored.missionChoice?.missionId, missionId); assert.equal(stored.expiresAt, legacy.expiresAt); assert.equal(stored.image.sha256, legacy.image.sha256);
    client.close();
  }
  assert.throws(() => validateEventGuestRecord({ ...legacy, missionChoice: { version: 1, missionId: "unlisted" } }));
});
