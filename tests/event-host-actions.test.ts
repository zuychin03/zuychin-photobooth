import assert from "node:assert/strict";
import test from "node:test";
import { eventScheduleReview, executeEventHostMutation } from "../lib/events/host-actions";
import type { EventHostClient } from "../lib/events/client";
test("event timezone review preserves the input instants and handles invalid zone text safely", () => {
  const value = { timezone: "Australia/Sydney", startsAt: "2026-10-05T00:00:00.000Z", closesAt: "2026-10-05T01:00:00.000Z", expiresAt: "2026-10-06T00:00:00.000Z" }, before = JSON.stringify(value);
  assert.match(eventScheduleReview(value)![0], /11:00/);
  assert.notDeepEqual(eventScheduleReview(value), eventScheduleReview({ ...value, timezone: "UTC" }));
  assert.equal(eventScheduleReview({ ...value, timezone: "invalid/zone" }), null); assert.equal(JSON.stringify(value), before);
});
test("state retry reconciles an already committed close without repeating the mutation", async () => {
  let mutations = 0;
  const client = { assertActive() {}, dashboard: async () => ({ event: { eventId: "event", status: "closed" } }), manage: async () => { mutations++; } } as unknown as EventHostClient;
  const result = await executeEventHostMutation(client, { kind: "state", eventId: "event", action: "close", previous: "open" }, new AbortController().signal);
  assert.equal(result.event?.status, "closed"); assert.equal(mutations, 0);
});
test("a changed state prevents an old open request from overwriting a later pause or close", async () => {
  let mutations = 0;
  const client = { assertActive() {}, dashboard: async () => ({ event: { status: "closed" } }), manage: async () => { mutations++; } } as unknown as EventHostClient;
  await assert.rejects(executeEventHostMutation(client, { kind: "state", eventId: "event", action: "open", previous: "draft" }, new AbortController().signal), /conflict/); assert.equal(mutations, 0);
});
test("lost invitation acknowledgement retries its frozen nonce and expiry without minting new identity", async () => {
  const calls: unknown[] = [], client = { assertActive() {}, issue: async (_id: string, input: unknown) => { calls.push(input); if (calls.length === 1) throw new Error("lost acknowledgement"); return { token: "same-token", expiresAt: "2099-01-01T00:00:00.000Z" }; } } as unknown as EventHostClient;
  const request = { kind: "issue" as const, eventId: "event", requestId: "stable-request", expiresAt: "2099-01-01T00:00:00.000Z", rotate: true }, signal = new AbortController().signal;
  await assert.rejects(executeEventHostMutation(client, request, signal)); await executeEventHostMutation(client, request, signal); assert.deepEqual(calls[0], calls[1]);
});
