import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { createEventHostUIFixture, EVENT_FIXTURE_PEOPLE } from "../lib/events/host-ui-fixture";
import { defaultEventInput } from "../lib/events/host-actions";
test("publication rehearsal enforces all consent choices, stale revisions, exact lost approval and private reports", async () => {
  const previous = process.env.NODE_ENV; Object.assign(process.env, { NODE_ENV: "development" });
  const fixture = createEventHostUIFixture("http://localhost:3005");
  try {
    const host = fixture.mount(0), eventId = (await host.list()).events[0].eventId, client = fixture.moderationClient!;
    const jpeg = await sharp({ create: { width: 12, height: 8, channels: 3, background: "#c08090" } }).jpeg().toBuffer();
    await fixture.seedPublicationChoices(new Blob([new Uint8Array(jpeg)], { type: "image/jpeg" }));
    assert.equal((await client.capabilities(eventId)).publicationVersion, 1);
    const page = await client.list(eventId); assert.deepEqual(page.entries.map(v => [v.galleryConsent, v.wallConsent]), [[false, false], [true, false], [false, true], [true, true]]);
    for (const original of page.entries) for (const destination of ["gallery", "wall"] as const) {
      const current = (await client.list(eventId)).entries.find(v => v.submissionId === original.submissionId)!;
      const request = { submissionId: current.submissionId, destination, expectedRevision: current.revision, state: "approved" as const, requestId: crypto.randomUUID() };
      if (current[destination === "gallery" ? "galleryConsent" : "wallConsent"]) assert.equal((await client.decide(eventId, request))[destination], "approved");
      else await assert.rejects(client.decide(eventId, request), /access_denied/);
    }
    const both = (await client.list(eventId)).entries[3], decision = { submissionId: both.submissionId, destination: "gallery" as const, expectedRevision: both.revision, state: "approved" as const, requestId: crypto.randomUUID() };
    fixture.loseNextAcknowledgement(); await assert.rejects(client.decide(eventId, decision), /unavailable/);
    assert.equal((await client.decide(eventId, decision)).revision, both.revision + 1);
    fixture.changePublicationConsent(false); fixture.changePublicationConsent(true);
    assert.equal((await client.decide(eventId, decision)).gallery, "awaiting_approval");
    await assert.rejects(client.decide(eventId, { ...decision, requestId: crypto.randomUUID() }), /conflict/);
    const fresh = (await client.list(eventId)).entries[3]; await client.decide(eventId, { submissionId: fresh.submissionId, destination: "wall", expectedRevision: fresh.revision, state: "hidden" });
    const report = { submissionId: page.entries[0].submissionId, destination: "gallery" as const, requestId: crypto.randomUUID(), reason: "privacy" as const, detail: "Synthetic private report" };
    fixture.loseNextAcknowledgement(); await assert.rejects(client.report(eventId, report), /unavailable/);
    const receipt = await client.report(eventId, report); assert.equal((await client.reports(eventId)).entries.length, 1); assert.equal((await client.resolve(eventId, receipt.reportId)).status, "resolved");
    assert.equal((await client.remove(eventId, page.entries[0].submissionId, 0)).state, "deleted");
    const old = client, moderator = fixture.mount(1); await assert.rejects(old.list(eventId), /identity_changed|cancelled/); await assert.rejects(fixture.moderationClient!.list(eventId), /access_denied/);
    await moderator.manage(eventId, "accept_moderator"); assert.equal((await fixture.moderationClient!.list(eventId)).entries.length, 4);
    fixture.expireSeededEvent(); await assert.rejects(fixture.moderationClient!.list(eventId), /access_denied/);
  } finally { fixture.close(); if (previous === undefined) Reflect.deleteProperty(process.env, "NODE_ENV"); else Object.assign(process.env, { NODE_ENV: previous }); }
});

test("host rehearsal issues the requested independent audience capability kind", async () => {
  const previous = process.env.NODE_ENV; Object.assign(process.env, { NODE_ENV: "development" });
  const fixture = createEventHostUIFixture("http://localhost:3005");
  try {
    const host = fixture.mount(0), eventId = (await host.list()).events[0].eventId;
    for (const kind of ["gallery", "display"] as const) {
      const result = await host.issue(eventId, { requestId: crypto.randomUUID(), kind, expiresAt: new Date(Date.now() + 3600000).toISOString(), rotate: false });
      assert.equal(result.kind, kind);
    }
  } finally { fixture.close(); if (previous === undefined) Reflect.deleteProperty(process.env, "NODE_ENV"); else Object.assign(process.env, { NODE_ENV: previous }); }
});
test("host rehearsal retains lost creations for discovery and isolates moderator/foreign accounts", async () => {
  const previous = process.env.NODE_ENV; Object.assign(process.env, { NODE_ENV: "development" });
  const fixture = createEventHostUIFixture("http://localhost:3005");
  try {
    const owner = fixture.mount(0), event = { ...defaultEventInput(), title: "Rehearsal" }, id = crypto.randomUUID();
    fixture.loseNextAcknowledgement(); await assert.rejects(owner.create(id, event), /unavailable/);
    assert.equal((await owner.list()).events.filter(item => item.eventId === id).length, 1);
    assert.equal((await owner.create(id, event)).eventId, id);
    const old = owner, moderator = fixture.mount(1); await assert.rejects(old.list(), /identity_changed|cancelled/);
    const invitation = (await moderator.list()).events[0]; assert.equal(invitation.membership, "invited");
    await assert.rejects(moderator.settings(invitation.eventId), /access_denied/);
    await moderator.manage(invitation.eventId, "accept_moderator"); assert.equal((await moderator.settings(invitation.eventId)).revision, 0);
    const other = fixture.mount(2), list = await other.list(); assert.equal(list.events.length, 1); assert.ok(list.events.every(item => item.eventId !== id)); assert.equal(other.ownerId, EVENT_FIXTURE_PEOPLE[2].id);
  } finally { fixture.close(); if (previous === undefined) Reflect.deleteProperty(process.env, "NODE_ENV"); else Object.assign(process.env, { NODE_ENV: previous }); }
});
test("host rehearsal exercises stale settings and first contribution locking through the real client", async () => {
  const previous = process.env.NODE_ENV; Object.assign(process.env, { NODE_ENV: "development" });
  const fixture = createEventHostUIFixture("http://localhost:3005");
  try {
    const client = fixture.mount(0), id = (await client.list()).events[0].eventId, initial = await client.settings(id);
    fixture.editElsewhere(); await assert.rejects(client.saveSettings(id, { requestId: crypto.randomUUID(), expectedRevision: initial.revision, settings: { event: initial.event, look: { ...initial.look, caption: "Stale" } } }), /conflict/);
    fixture.acceptContribution(); const current = await client.settings(id); assert.equal(current.locked, true);
    await assert.rejects(client.saveSettings(id, { requestId: crypto.randomUUID(), expectedRevision: current.revision, settings: { event: current.event, look: { ...current.look, caption: "Changed" } } }), /conflict/);
    fixture.oldServer(true); assert.equal((await client.capabilities()).hostVersion, 0);
  } finally { fixture.close(); if (previous === undefined) Reflect.deleteProperty(process.env, "NODE_ENV"); else Object.assign(process.env, { NODE_ENV: previous }); }
});
test("host reminder fixture keeps default off, exact lost-save retry and owner-only preferences", async () => {
  const previous = process.env.NODE_ENV; Object.assign(process.env, { NODE_ENV: "development" });
  const fixture = createEventHostUIFixture("http://localhost:3005");
  try {
    const host = fixture.mount(0), id = (await host.list()).events[0].eventId, client = fixture.reminderClient!;
    const initial = await client.read(id); assert.equal(initial.settings.email, false); assert.equal(initial.settings.push, false);
    fixture.loseNextAcknowledgement(); const request = { expectedRevision: 0, email: true, push: false };
    await assert.rejects(client.save(id, request)); const retry = await client.save(id, request); assert.equal(retry.settings.revision, 1); assert.equal(retry.settings.email, true);
    fixture.reminderTargets(false); const missing = await client.read(id); assert.equal(missing.configured.email, true); assert.equal(missing.settings.emailAvailable, false);
    fixture.mount(1); await assert.rejects(client.read(id), /identity_changed|cancelled/); await assert.rejects(fixture.reminderClient!.read(id), /access_denied/);
  } finally { fixture.close(); if (previous === undefined) Reflect.deleteProperty(process.env, "NODE_ENV"); else Object.assign(process.env, { NODE_ENV: previous }); }
});

test("private review rehearsal uses the real client and isolates invited, withdrawn and replaced accounts", async () => {
  const previous = process.env.NODE_ENV; Object.assign(process.env, { NODE_ENV: "development" });
  let closed = 0;
  const fixture = createEventHostUIFixture("http://localhost:3005", { decode: async () => ({ width: 12, height: 8, close() { closed++; } }) });
  try {
    const jpeg = await sharp({ create: { width: 12, height: 8, channels: 3, background: "#c08090" } }).jpeg().toBuffer();
    const blob = new Blob([new Uint8Array(jpeg)], { type: "image/jpeg" }), host = fixture.mount(0), eventId = (await host.list()).events[0].eventId;
    await fixture.seedReadyContribution(blob); const ownerReview = fixture.reviewClient!;
    assert.equal((await ownerReview.capabilities(eventId)).version, 1);
    const page = await ownerReview.list(eventId), item = page.entries[0];
    assert.equal(item.thumbnailAvailable, true); assert.equal(item.gallery, "private"); assert.equal(item.wall, "private");
    assert.deepEqual(new Uint8Array(await (await ownerReview.download(eventId, item.submissionId)).arrayBuffer()), new Uint8Array(jpeg)); assert.equal(closed, 1);
    const invited = fixture.mount(1); await assert.rejects(ownerReview.list(eventId), /identity_changed|cancelled/);
    await assert.rejects(fixture.reviewClient!.list(eventId), /access_denied/);
    await invited.manage(eventId, "accept_moderator"); assert.equal((await fixture.reviewClient!.list(eventId)).entries.length, 1);
    await fixture.reviewClient!.download(eventId, item.submissionId); assert.equal(closed, 2);
    fixture.withdrawReadyContribution(); assert.equal((await fixture.reviewClient!.list(eventId)).entries[0].thumbnailAvailable, false);
    await assert.rejects(fixture.reviewClient!.access(eventId, item.submissionId), /access_denied/);
    fixture.mount(0); assert.equal((await fixture.reviewClient!.list(eventId)).entries[0].state, "deleted");
    fixture.oldServer(true); await assert.rejects(fixture.reviewClient!.capabilities(eventId), /unavailable/);
    fixture.oldServer(false); fixture.mount(2); await assert.rejects(fixture.reviewClient!.list(eventId), /access_denied/);
  } finally { fixture.close(); if (previous === undefined) Reflect.deleteProperty(process.env, "NODE_ENV"); else Object.assign(process.env, { NODE_ENV: previous }); }
});

test("host guestbook fixture freezes mission retries, locks accepted configuration and pages private withdrawals", async () => {
  const previous = process.env.NODE_ENV; Object.assign(process.env, { NODE_ENV: "development" }); const fixture = createEventHostUIFixture("http://localhost:3005");
  try {
    const host = fixture.mount(0), eventId = (await host.list()).events[0].eventId, settings = await host.missions(eventId), request = { expectedRevision: settings.revision, missionIds: ["same-energy-1"], endsAt: settings.endsAt };
    fixture.loseNextAcknowledgement(); await assert.rejects(host.saveMissions(eventId, request), /unavailable/); assert.equal((await host.saveMissions(eventId, request)).revision, 1);
    fixture.seedGuestbook(); assert.equal((await host.missions(eventId)).locked, true); await assert.rejects(host.saveMissions(eventId, { ...request, expectedRevision: 1, missionIds: [] }), /conflict/);
    const first = await host.guestbook(eventId); assert.equal(first.entries.length, 25); assert(first.nextCursor); assert.equal((await host.guestbook(eventId, { after: first.nextCursor })).entries.length, 1);
    fixture.withdrawGuestbook(); const withdrawn = (await host.guestbook(eventId)).entries[0].note!; assert.equal(withdrawn.withdrawn, true); assert.equal(withdrawn.message, "");
    const invited = fixture.mount(1); await assert.rejects(invited.guestbook(eventId), /access_denied/); await invited.manage(eventId, "accept_moderator"); assert.equal((await invited.guestbook(eventId)).entries.length, 25); await assert.rejects(invited.saveMissions(eventId, request), /access_denied/);
    const outsider = fixture.mount(2); await assert.rejects(outsider.guestbook(eventId), /access_denied/);
  } finally { fixture.close(); if (previous === undefined) Reflect.deleteProperty(process.env, "NODE_ENV"); else Object.assign(process.env, { NODE_ENV: previous }); }
});
