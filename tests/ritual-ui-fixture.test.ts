import assert from "node:assert/strict";
import { test } from "node:test";
import { createRitualUIFixture, ritualFixtureCouple as couple } from "../lib/memories/ritual-ui-fixture";
import { RitualClientError } from "../lib/memories/ritual-client";
import { reviewRitual, ritualFields } from "../lib/memories/ritual-editor";

const code = (expected: string) => (error: unknown) => error instanceof RitualClientError && error.code === expected;
const input = () => reviewRitual({ ...ritualFields(), title: "Our reviewed photo date" }, new Date().toISOString()).input;

test("a lost create acknowledgement retries the exact identity without another ritual", async () => {
  const fixture = createRitualUIFixture("https://app.test"), owner = fixture.mount(0);
  try {
    const before = await owner.client.list(couple), request = { id: "30000000-0000-4000-8000-000000000001", ...input() };
    fixture.failNext("after"); await assert.rejects(owner.client.create(couple, request), code("network_error"));
    const afterLost = await owner.client.list(couple);
    assert.equal(afterLost.items.length, before.items.length + 1);
    const retry = await owner.client.create(couple, request), afterRetry = await owner.client.list(couple);
    assert.equal(retry.id, request.id); assert.equal(retry.revision, 0);
    assert.equal(afterRetry.items.length, afterLost.items.length);
    assert.equal(afterRetry.items.filter(row => row.id === request.id).length, 1);
    await assert.rejects(owner.client.create(couple, { ...request, title: "Changed request" }), code("conflict"));
  } finally { owner.close(); }
});

test("a partner can change only their own channels without changing the creator's choices", async () => {
  const fixture = createRitualUIFixture("https://app.test"), owner = fixture.mount(0), partner = fixture.mount(1);
  try {
    const initial = (await owner.client.list(couple)).items.find(row => !row.legacy && row.enabled)!;
    const own = await owner.client.setChannels(couple, initial.id, initial.revision, { email: true, push: false });
    const partnerView = (await partner.client.list(couple)).items.find(row => row.id === initial.id)!;
    assert.deepEqual(partnerView.channels, { email: false, push: false });
    const changed = await partner.client.setChannels(couple, initial.id, own.revision, { email: false, push: true });
    assert.deepEqual(changed.channels, { email: false, push: true });
    const ownerView = (await owner.client.list(couple)).items.find(row => row.id === initial.id)!;
    assert.deepEqual(ownerView.channels, { email: true, push: false });
    assert.equal(ownerView.revision, initial.revision + 2);
  } finally { owner.close(); partner.close(); }
});

test("the partner cannot edit, pause, resume, delete or upgrade the creator's reminders", async () => {
  const fixture = createRitualUIFixture("https://app.test"), partner = fixture.mount(1);
  try {
    const initial = await partner.client.list(couple), row = initial.items.find(row => !row.legacy && row.enabled)!, legacy = initial.items.find(row => row.legacy)!;
    await assert.rejects(partner.client.edit(couple, row.id, row.revision, input()), code("access_denied"));
    await assert.rejects(partner.client.pause(couple, row.id, row.revision), code("access_denied"));
    await assert.rejects(partner.client.resume(couple, row.id, row.revision), code("access_denied"));
    await assert.rejects(partner.client.delete(couple, row.id, row.revision), code("access_denied"));
    const reviewed = reviewRitual(ritualFields(legacy), new Date().toISOString(), legacy);
    await assert.rejects(partner.client.upgrade(couple, legacy.id, legacy.scheduledAt, reviewed.input), code("access_denied"));
    assert.deepEqual(await partner.client.list(couple), initial);
  } finally { partner.close(); }
});

test("a concurrent channel revision invalidates stale creator edits and requires a refreshed CAS", async () => {
  const fixture = createRitualUIFixture("https://app.test"), owner = fixture.mount(0), partner = fixture.mount(1);
  try {
    const row = (await owner.client.list(couple)).items.find(row => !row.legacy && row.enabled)!;
    await partner.client.setChannels(couple, row.id, row.revision, { email: true, push: true });
    await assert.rejects(owner.client.pause(couple, row.id, row.revision), code("conflict"));
    const refreshed = (await owner.client.list(couple)).items.find(item => item.id === row.id)!;
    assert.equal(refreshed.paused, false);
    const paused = await owner.client.pause(couple, row.id, refreshed.revision);
    assert.equal(paused.paused, true); assert.equal(paused.revision, row.revision + 2);
  } finally { owner.close(); partner.close(); }
});

test("confirmed unpair denies discovery and mutations to the original couple for both participants", async () => {
  const fixture = createRitualUIFixture("https://app.test"), owner = fixture.mount(0), partner = fixture.mount(1);
  try {
    const row = (await owner.client.list(couple)).items.find(row => !row.legacy && row.enabled)!;
    fixture.unpair();
    await assert.rejects(owner.client.list(couple), code("access_denied"));
    await assert.rejects(partner.client.list(couple), code("access_denied"));
    await assert.rejects(owner.client.pause(couple, row.id, row.revision), code("access_denied"));
    await assert.rejects(partner.client.setChannels(couple, row.id, row.revision, { email: true, push: false }), code("access_denied"));
  } finally { owner.close(); partner.close(); }
});

test("legacy once upgrade preserves its exact instant and requires the unchanged legacy acknowledgement", async () => {
  const fixture = createRitualUIFixture("https://app.test"), owner = fixture.mount(0);
  try {
    const legacy = (await owner.client.list(couple)).items.find(row => row.legacy)!;
    const reviewed = reviewRitual(ritualFields(legacy), new Date().toISOString(), legacy);
    assert.equal(reviewed.input.schedule.onceAt, legacy.scheduledAt);
    await assert.rejects(owner.client.upgrade(couple, legacy.id, new Date(Date.parse(legacy.scheduledAt) + 1000).toISOString(), reviewed.input), code("conflict"));
    const upgraded = await owner.client.upgrade(couple, legacy.id, legacy.scheduledAt, reviewed.input);
    assert.equal(upgraded.legacy, false); assert.equal(upgraded.revision, 1);
    assert.equal(upgraded.scheduledAt, legacy.scheduledAt); assert.equal(upgraded.schedule?.onceAt, legacy.scheduledAt);
    const renamed = reviewRitual({ ...ritualFields(upgraded), title: "Renamed only" }, new Date().toISOString(), upgraded);
    assert.equal((await owner.client.edit(couple, upgraded.id, upgraded.revision, renamed.input)).scheduledAt, legacy.scheduledAt);
  } finally { owner.close(); }
});
