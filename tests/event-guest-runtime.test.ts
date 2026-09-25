import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { takeEventFragment, createEventGuestRuntime, eventGuestEntryReady, invalidateEventGuestSession, type EventGuestSession } from "../lib/events/guest-runtime";
import { createEventGuestClient } from "../lib/events/client";
import { createEventGuestUIFixture } from "../lib/events/guest-ui-fixture";

const eventId = "11111111-1111-4111-8111-111111111111", token = Buffer.alloc(32, 1).toString("base64url");
test("guest entry requires context schema but permits accepted recovery while new uploads pause", () => {
  const caps = { hostVersion: 1, uploadsAvailable: false, downloadsAvailable: true };
  assert.equal(eventGuestEntryReady(caps, false), false); assert.equal(eventGuestEntryReady(caps, true), true);
  assert.equal(eventGuestEntryReady({ ...caps, hostVersion: 0 }, true), false);
  assert.equal(eventGuestEntryReady({ ...caps, downloadsAvailable: false }, true), false);
  assert.equal(eventGuestEntryReady({ ...caps, uploadsAvailable: true }, false), true);
});
test("private fragments are removed synchronously while only a valid public receipt scope survives", () => {
  let replaced = "";
  const read = (hash: string, search = "", kind: "receipt" | "invite" = "receipt") => takeEventFragment(kind, { hash, search, pathname: "/receipt/local" }, value => { replaced = value; });
  assert.deepEqual(read(`#token=${token}`, `?event=${eventId}`), { token, eventId });
  assert.equal(replaced, `/receipt/local?event=${eventId}`);
  assert.deepEqual(read("", `?event=${eventId}`), { token: null, eventId });
  for (const [hash, search] of [[`#token=${token}`, `?event=${eventId}&event=${eventId}`], [`#token=${token}`, `?event=${eventId}&token=${token}`], [`#token=${token}`, "?event=invalid"], [`#token=${token}&token=${token}`, `?event=${eventId}`], [`#event=${eventId}&token=${token}`, "?event=22222222-2222-4222-8222-222222222222"]]) {
    assert.deepEqual(read(hash, search), { token: null, eventId: null }); assert(!replaced.includes(token)); assert(!replaced.includes("#"));
  }
  assert.deepEqual(read(`#invite=${token}`, "", "invite"), { token, eventId: null }); assert.equal(replaced, "/receipt/local");
  assert.deepEqual(read("", `?invite=${token}`, "invite"), { token: null, eventId: null }); assert.equal(replaced, "/receipt/local");
});

test("synthetic guest flow preserves lost reservation identity, upload uncertainty, receipt isolation and withdrawal", async () => {
  const previous = process.env.NODE_ENV; Object.assign(process.env, { NODE_ENV: "development" });
  const f = createEventGuestUIFixture("https://app.example");
  try {
    const entry = createEventGuestClient({ ...f.options, eventId: f.eventId, identity: () => null });
    const session = await entry.redeem(f.options.initialInvite, token);
    const client = createEventGuestClient({ ...f.options, eventId: f.eventId, identity: () => ({ eventId: f.eventId, guestId: session.guestId!, epoch: 1 }) });
    const context = await client.context(); assert.equal(context.look.frameId, "rose"); assert.equal(context.canReserve, true); assert.equal("ownerId" in context, false);
    const input = { requestId: crypto.randomUUID(), submissionId: crypto.randomUUID(), consent: { submission: true, gallery: false, wall: false } };
    f.loseReservation(); await assert.rejects(client.reserve(input)); assert.equal(f.receipts().length, 1);
    const reserved = await client.reserve(input); assert.equal(f.receipts().length, 1); assert.equal(reserved.receipt.gallery, "private");
    const blob = new Blob([new Uint8Array(await sharp({ create: { width: 48, height: 64, channels: 3, background: "pink" } }).jpeg().toBuffer())], { type: "image/jpeg" });
    f.failUpload(); await assert.rejects(client.upload(input.submissionId, blob, await client.mintUpload(input.submissionId)), /upload_uncertain/);
    assert.equal((await client.readReceipt(input.submissionId)).state, "uploading");
    await client.upload(input.submissionId, blob, await client.mintUpload(input.submissionId)); assert.equal((await client.finalise(input.submissionId)).state, "finalising");
    f.setHeld(false); assert.equal((await client.download(input.submissionId)).width, 48);
    const second = await client.reserve({ ...input, requestId: crypto.randomUUID(), submissionId: crypto.randomUUID() });
    await assert.rejects(client.readReceipt(input.submissionId), /access_denied/);
    await client.exchangeReceipt(input.submissionId, reserved.receiptToken); assert.equal((await client.readReceipt(input.submissionId)).state, "ready");
    await assert.rejects(client.exchangeReceipt(second.receipt.submissionId, reserved.receiptToken), /access_denied/);
    await client.consent(input.submissionId, { submission: false, gallery: false, wall: false }); await assert.rejects(client.download(input.submissionId), /access_denied/);
    f.replaceGuest(); await assert.rejects(client.context(), /access_denied/); entry.close(); client.close();
  } finally { f.close(); if (previous === undefined) Reflect.deleteProperty(process.env, "NODE_ENV"); else Object.assign(process.env, { NODE_ENV: previous }); }
});

test("runtime cannot publish a guest after close during an uncooperative pending response", async () => {
  let release!: (response: Response) => void;
  const runtime = createEventGuestRuntime({ eventId, appOrigin: "https://app.example", fetch: () => new Promise(resolve => { release = resolve; }) });
  const pending = runtime.join(token, token); runtime.close(); release(new Response("{}", { headers: { "content-type": "application/json" } }));
  await assert.rejects(pending, /cancelled|identity_changed/);
});

test("confirmed guest authority loss closes both handles without deleting recovery data, transient failure retains them", () => {
  const calls: string[] = [];
  const session = { client: { close: () => calls.push("client") }, journal: { close: () => calls.push("journal"), remove: () => { throw new Error("Must not erase an uncertain previous guest queue"); } } } as unknown as EventGuestSession;
  for (const code of ["timeout", "unavailable", "upload_uncertain", "capacity"]) assert.equal(invalidateEventGuestSession({ code }, session), false);
  assert.deepEqual(calls, []);
  for (const code of ["access_denied", "identity_changed"]) assert.equal(invalidateEventGuestSession({ code }, session), true);
  assert.deepEqual(calls, ["client", "journal", "client", "journal"]);
});
