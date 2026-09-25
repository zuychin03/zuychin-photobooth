import assert from "node:assert/strict";
import test from "node:test";
import { challengeDesign, challengeLayouts, challengeOwnedUploads, challengeSubmission } from "../lib/memories/challenge-ui";
import { prepareChallengeCreate } from "../lib/memories/challenge-contract";

const id = (value: number) => `10000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
test("offered challenge layouts assign every selected contributor and preserve sparse sources", () => {
  for (const count of [2, 3, 4]) for (const layout of challengeLayouts(count)) {
    const shape = challengeDesign(layout.id, Array.from({ length: count }, (_, index) => id(index + 1)));
    const created = prepareChallengeCreate({ id: id(20), ...shape, policy: "all_submitted", expiresAt: "2027-01-01T00:00:00.000Z" });
    assert.equal(new Set(created.assignments.map(source => source.userId)).size, count);
    assert.equal(created.design.defaults.showDate, false);
    assert.ok(created.assignments.every(source => source.sourceIndex < 4));
  }
  assert.deepEqual(prepareChallengeCreate({ id: id(20), ...challengeDesign("duo-alternate", [id(1), id(2)]), policy: "all_submitted", expiresAt: "2027-01-01T00:00:00.000Z" }).assignments.map(source => source.sourceIndex), [0, 2, 1, 3]);
  assert.throws(() => challengeDesign("trio", [id(1), id(2), id(3), id(4)]));
});
test("submission retry ID survives remount and source order without crossing account or challenge", async () => {
  const sources = [{ sourceIndex: 2, assetId: id(8) }, { sourceIndex: 0, assetId: id(9) }];
  const original = await challengeSubmission(id(20), id(1), sources);
  assert.deepEqual(await challengeSubmission(id(20), id(1), [...sources].reverse()), original);
  assert.notEqual((await challengeSubmission(id(21), id(1), sources)).requestId, original.requestId);
  assert.notEqual((await challengeSubmission(id(20), id(2), sources)).requestId, original.requestId);
  assert.notEqual((await challengeSubmission(id(20), id(1), [{ sourceIndex: 0, assetId: id(8) }, { sourceIndex: 2, assetId: id(9) }])).requestId, original.requestId);
  await assert.rejects(challengeSubmission(id(20), id(1), [{ sourceIndex: 0, assetId: id(8) }, { sourceIndex: 2, assetId: id(8) }]));
});
test("authoritative recovery includes all 24 permitted photos and bounds an endless page source", async () => {
  const uploads = Array.from({ length: 24 }, (_, index) => ({ id: id(index + 30), ownerId: id(1), kind: "photo" as const, mime: "image/png" as const, bytes: 100, width: 20, height: 20, sha256: "a".repeat(64) }));
  let calls = 0;
  const all = await challengeOwnedUploads({ listUploads: async (_id, after) => { calls++; const next = after ? uploads.slice(20) : uploads.slice(0, 20); return { version: 1, uploads: next, nextCursor: after ? null : next.at(-1)!.id }; } }, id(20));
  assert.equal(all.length, 24); assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(challengeOwnedUploads({ listUploads: async () => { calls++; return { version: 1, uploads: [], nextCursor: id(90) }; } }, id(20)));
  assert.equal(calls, 2);
});
