import assert from "node:assert/strict";
import test from "node:test";
import { openEventHostRuntime } from "../lib/events/host-runtime";
import type { EventHostClient, EventHostClientOptions } from "../lib/events/client";
const owner = "10000000-0000-4000-8000-000000000001";
const base = { ownerId: owner, appOrigin: "https://fixture.invalid", accessToken: async () => "synthetic" };
test("host runtime close before start performs no authentication or client construction", async () => {
  let starts = 0;
  const handle = openEventHostRuntime({ ...base, subscribe: () => { starts++; return () => {}; } }, () => { starts++; return {} as EventHostClient; });
  handle.close(); await assert.rejects(handle.ready, /cancelled/); assert.equal(starts, 0);
});
test("synchronous authentication invalidation cleans a late subscription before constructing client", async () => {
  let unsubscribed = 0, invalidated = 0, built = 0;
  const handle = openEventHostRuntime({ ...base, subscribe: callback => { callback(null); return () => { unsubscribed++; }; }, onInvalidated: () => { invalidated++; } }, () => { built++; return {} as EventHostClient; });
  await assert.rejects(handle.ready, /identity_changed/); assert.equal(unsubscribed, 1); assert.equal(invalidated, 1); assert.equal(built, 0);
});
test("account loss during client construction closes the arriving client and fences its captured identity", async () => {
  let listener!: (owner: string | null) => void, options!: EventHostClientOptions, closed = 0;
  const handle = openEventHostRuntime({ ...base, subscribe: callback => { listener = callback; return () => {}; } }, input => { options = input; listener(null); return { close: () => { closed++; } } as EventHostClient; });
  await assert.rejects(handle.ready, /identity_changed/); assert.equal(closed, 1); assert.equal(options.identity(), null);
});
test("same account token refresh stays active while switching accounts closes exactly once", async () => {
  let listener!: (owner: string | null) => void, closed = 0, unsubscribed = 0, options!: EventHostClientOptions;
  const handle = openEventHostRuntime({ ...base, subscribe: callback => { listener = callback; return () => { unsubscribed++; }; } }, input => { options = input; return { assertActive() {}, close: () => { closed++; } } as EventHostClient; });
  await handle.ready; listener(owner); assert.equal(closed, 0); listener("another-account"); handle.close(); assert.equal(closed, 1); assert.equal(unsubscribed, 1); assert.equal(options.identity(), null);
});

test("export client shares the host account fence and closes on account change", async () => {
  let listener!: (owner: string | null) => void;
  const handle = openEventHostRuntime({ ...base, storageOrigin: "https://storage.fixture.invalid", subscribe: callback => { listener = callback; return () => {}; } }, () => ({ assertActive() {}, close() {} }) as EventHostClient);
  await handle.ready; assert.ok(handle.exportClient); handle.exportClient.assertActive(); assert.ok(handle.reviewClient); handle.reviewClient.assertActive();
  assert.ok(handle.moderationClient); handle.moderationClient.assertActive();
  listener(null); assert.throws(() => handle.exportClient!.assertActive(), /identity_changed|cancelled/); assert.throws(() => handle.reviewClient!.assertActive(), /identity_changed|cancelled/);
  assert.throws(() => handle.moderationClient!.assertActive(), /identity_changed|cancelled/);
});
