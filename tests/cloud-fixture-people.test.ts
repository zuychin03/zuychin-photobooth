import assert from "node:assert/strict";
import test from "node:test";
import { cloudFixturePeople } from "../lib/projects/cloud-fixture-people";
import { challengeDesign, challengeLayouts } from "../lib/memories/challenge-ui";
import { prepareChallengeCreate } from "../lib/memories/challenge-contract";

test("synthetic pair retains account identities and larger groups have valid collective assignments", () => {
  const pair = cloudFixturePeople();
  assert.deepEqual(pair.map(person => person.name), ["Alex", "Bao"]);
  for (const count of [3, 4] as const) {
    const people = cloudFixturePeople(count);
    assert.deepEqual(people.slice(0, 2), pair);
    assert.equal(new Set(people.map(person => person.ownerId)).size, count);
    for (const layout of challengeLayouts(count)) {
      const request = prepareChallengeCreate({ id: "10000000-0000-4000-8000-000000000100", ...challengeDesign(layout.id, people.map(person => person.ownerId)), policy: "all_submitted", expiresAt: new Date(Date.now() + 3600000).toISOString() });
      assert.equal(new Set(request.assignments.map(item => item.userId)).size, count);
      assert.ok(request.assignments.every(item => people.some(person => person.ownerId === item.userId)));
    }
  }
});
