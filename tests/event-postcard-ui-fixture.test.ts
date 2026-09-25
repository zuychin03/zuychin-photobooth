import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { createPostcardUIFixture } from "../lib/events/postcard-ui-fixture";
import { createEventPostcardClient, createPostcardSourceClient } from "../lib/events/postcard-client";
import { createEventGuestClient } from "../lib/events/client";

test("synthetic postcard keeps exact retries, identities, JPEG approval and withdrawal separate", async () => {
  const old = process.env.NODE_ENV; Object.defineProperty(process.env, "NODE_ENV", { value: "development", configurable: true, writable: true, enumerable: true });
  const fixture = createPostcardUIFixture("http://localhost:3000");
  const connect = (role: number) => {
    fixture.switchRole(role); const scope = fixture.mount();
    const guest = createEventGuestClient({ ...fixture.options, eventId: fixture.eventId, identity: () => ({ eventId: fixture.eventId, guestId: fixture.guests[role], epoch: role }) });
    const client = createEventPostcardClient({ ...fixture.options, guest, decode: async () => ({ width: 480, height: 960, close() {} }) });
    const source = createPostcardSourceClient({ ...fixture.options, source: fixture.source, assertAuthority: scope.assertActive, accessToken: scope.accessToken });
    return { guest, client, source };
  };
  const a = connect(0), proposal = { postcardId: crypto.randomUUID(), submissionId: crypto.randomUUID(), source: fixture.source, design: fixture.design }, requestId = crypto.randomUUID();
  let b: ReturnType<typeof connect> | undefined, again: ReturnType<typeof connect> | undefined;
  try {
    await a.client.capabilities(); fixture.loseTicket(); const ticketRequest = crypto.randomUUID();
    await assert.rejects(a.client.ticket(proposal.postcardId, ticketRequest));
    const ticket = await a.client.ticket(proposal.postcardId, ticketRequest); const first = await a.source.attach(fixture.eventId, ticket.ticket, proposal);
    assert.equal(first.canSubmit, true);
    assert.deepEqual(first.selfConsent, { submission: false, gallery: false, wall: false });
    await assert.rejects(a.client.reserve(proposal.postcardId, proposal.submissionId, requestId));
    await a.client.scopeConsent(proposal.postcardId, first.revision, { submission: true, gallery: false, wall: false });
    b = connect(1); await assert.rejects(a.client.view(proposal.postcardId));
    await assert.rejects(b.client.view(proposal.postcardId));
    const found = await b.source.proposal(proposal.postcardId), bt = await b.client.ticket(proposal.postcardId, crypto.randomUUID());
    const joined = await b.source.attach(fixture.eventId, bt.ticket, found.proposal);
    assert.equal(joined.canSubmit, false);
    await b.client.scopeConsent(proposal.postcardId, joined.revision, { submission: true, gallery: true, wall: false });
    again = connect(0); fixture.loseReservation(); await assert.rejects(again.client.reserve(proposal.postcardId, proposal.submissionId, requestId));
    const reserved = await again.client.reserve(proposal.postcardId, proposal.submissionId, requestId);
    assert.equal(reserved.receipt.state, "reserved"); await assert.rejects(again.client.reserve(proposal.postcardId, proposal.submissionId, crypto.randomUUID()));
    const jpeg = new Blob([new Uint8Array(await sharp({ create: { width: 480, height: 960, channels: 3, background: "pink" } }).jpeg().toBuffer())], { type: "image/jpeg" });
    await again.guest.upload(proposal.submissionId, jpeg, await again.guest.mintUpload(proposal.submissionId)); await again.guest.finalise(proposal.submissionId);
    assert.equal((await again.client.view(proposal.postcardId)).state, "reserved"); await fixture.release();
    const image = await again.client.download(proposal.postcardId); assert.equal(image.blob.size, jpeg.size);
    const approved = await again.client.approveCandidate(image); assert.equal(approved.state, "candidate"); assert.equal(approved.participants.filter(p => p.approved).length, 1);
    fixture.withdraw(); await assert.rejects(again.client.approveCandidate(image)); assert.equal((await again.client.view(proposal.postcardId)).state, "revoked");
  } finally { for (const handle of [a, b, again]) { handle?.client.close(); handle?.guest.close(); handle?.source.close(); } fixture.close(); if (old === undefined) Reflect.deleteProperty(process.env, "NODE_ENV"); else Object.defineProperty(process.env, "NODE_ENV", { value: old, configurable: true, writable: true, enumerable: true }); }
});
