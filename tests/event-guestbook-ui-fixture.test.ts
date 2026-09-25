import assert from "node:assert/strict";
import test from "node:test";
import { createEventGuestUIFixture } from "../lib/events/guest-ui-fixture";
import { createEventGuestClient } from "../lib/events/client";

test("guestbook fixture preserves exact text ack, private scope, refusal withdrawal and ready-only mission acknowledgement", async () => {
  const old = process.env.NODE_ENV; Object.assign(process.env, { NODE_ENV: "development" });
  const fixture = createEventGuestUIFixture("https://app.example");
  let identity: { eventId: string; guestId: string; epoch: number } | null = null;
  let client = createEventGuestClient({ ...fixture.options, eventId: fixture.eventId, identity: () => identity });
  try {
    const joined = await client.redeem(fixture.options.initialInvite, "A".repeat(43)); identity = { eventId: fixture.eventId, guestId: joined.guestId!, epoch: 1 }; client.close(); client = createEventGuestClient({ ...fixture.options, eventId: fixture.eventId, identity: () => identity });
    const missions = await client.missions(), id = crypto.randomUUID();
    const reserved = await client.reserveMission({ requestId: crypto.randomUUID(), submissionId: id, consent: { submission: true, gallery: true, wall: true }, missionId: missions.missionIds[0] });
    assert.equal(reserved.receipt.state, "reserved"); const initial = await client.guestbook(id); assert.equal(initial.missionCompleted, false);
    const request = { requestId: crypto.randomUUID(), expectedRevision: 0, message: "A lovely day 🌸", signature: "Guest" };
    fixture.loseTextSave(); await assert.rejects(client.saveGuestbook(id, request), /network_error/);
    const retried = await client.saveGuestbook(id, request); assert.equal(retried.acceptedRevision, 1); assert.equal(retried.current.message, request.message);
    fixture.refuseTextSave(true); await assert.rejects(client.saveGuestbook(id, { ...request, requestId: crypto.randomUUID(), expectedRevision: 1 }), /capacity/);
    await client.withdrawGuestbook(id); const withdrawn = await client.guestbook(id); assert.equal(withdrawn.message, ""); assert.equal(withdrawn.signature, ""); assert.equal(withdrawn.withdrawn, true);
    fixture.refuseTextSave(false); const late = await client.saveGuestbook(id, request); assert.equal(late.acceptedRevision, 1); assert.equal(late.current.revision, 2); assert.equal(late.current.withdrawn, true);
    const grant = await client.mintUpload(id); await fixture.options.fetch(grant.signedUrl, { method: "PUT", body: new Blob(["synthetic bytes"]) });
    await client.finalise(id); assert.equal((await client.guestbook(id)).missionCompleted, false); fixture.setHeld(false); assert.equal((await client.guestbook(id)).missionCompleted, true);
    fixture.replaceGuest(); await assert.rejects(client.guestbook(id), /access_denied/);
  } finally { client.close(); fixture.close(); if (old === undefined) Reflect.deleteProperty(process.env, "NODE_ENV"); else Object.assign(process.env, { NODE_ENV: old }); }
});

test("permission fixture rejects stale restoration after lost acknowledgement and allows independent paused withdrawals", async () => {
  const old = process.env.NODE_ENV; Object.assign(process.env, { NODE_ENV: "development" }); const fixture = createEventGuestUIFixture("https://app.example");
  const entry = createEventGuestClient({ ...fixture.options, eventId: fixture.eventId, identity: () => null }); let client: ReturnType<typeof createEventGuestClient> | undefined;
  try {
    const joined = await entry.redeem(fixture.options.initialInvite, "A".repeat(43)); client = createEventGuestClient({ ...fixture.options, eventId: fixture.eventId, identity: () => ({ eventId: fixture.eventId, guestId: joined.guestId!, epoch: 1 }) });
    const id = crypto.randomUUID(), reservation = { submissionId: id, requestId: crypto.randomUUID(), consent: { submission: true, gallery: false, wall: false } }; await client.reserve(reservation);
    const original = await client.ownConsent(id); assert.deepEqual(original.consent, reservation.consent);
    const request = { expectedRevision: original.revision, gallery: true, wall: false }; fixture.loseConsentSave(); await assert.rejects(client.saveOwnConsent(id, request), /network_error/); assert.equal((await client.saveOwnConsent(id, request)).revision, 1);
    fixture.withdrawPublicationElsewhere(); await assert.rejects(client.saveOwnConsent(id, request), /conflict/); assert.equal((await client.ownConsent(id)).consent.gallery, false);
    fixture.setStatus("paused"); const latest = await client.ownConsent(id); await client.saveOwnConsent(id, { expectedRevision: latest.revision, gallery: false, wall: true }); fixture.setStatus("closed"); await client.saveOwnConsent(id, { expectedRevision: latest.revision + 1, gallery: false, wall: false });
    assert.equal((await client.reserve(reservation)).receipt.submissionId, id); assert.equal((await client.guestbook(id)).withdrawn, false);
    const receiptClient = createEventGuestClient({ ...fixture.options, eventId: fixture.eventId, identity: () => null }); await assert.rejects(receiptClient.saveOwnConsent(id, request), /identity_required/); receiptClient.close();
  } finally { entry.close(); client?.close(); fixture.close(); if (old === undefined) Reflect.deleteProperty(process.env, "NODE_ENV"); else Object.assign(process.env, { NODE_ENV: old }); }
});
