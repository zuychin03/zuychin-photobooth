import test from "node:test";
import assert from "node:assert/strict";
import { challengeHasFourPoses, challengeStoryForReview, challengeStoryPose } from "../components/cloud/challenge-story-review";
import { createStoryPlan, relaxStoryStep } from "../lib/stories/model";
import { RELAXED_POSE, STORY_DECKS } from "../lib/stories/catalogue";
const members = [{ userId: "B", role: "B" }, { userId: "A", role: "A" }];
test("alternating assignments follow collective source indices rather than assignment slots", () => {
  const plan = createStoryPlan("little-hello", 7), assignments = [{ slot: 0, userId: "A", sourceIndex: 0 }, { slot: 1, userId: "A", sourceIndex: 2 }, { slot: 2, userId: "B", sourceIndex: 1 }, { slot: 3, userId: "B", sourceIndex: 3 }];
  assert.equal(challengeHasFourPoses(assignments), true);
  assert.deepEqual(assignments.map(item => challengeStoryPose(plan, item.sourceIndex, members).number), [1, 3, 2, 4]);
  assert.equal(challengeStoryPose(plan, assignments[1].sourceIndex, members).prompt, STORY_DECKS[0].steps[2]);
  assert.equal(challengeStoryPose(plan, 0, members).directorId, "B");
  assert.equal(challengeHasFourPoses(assignments.filter(item => item.sourceIndex !== 3)), false);
});
test("frozen review keeps the exact story, seed and relaxed steps even if the form differs", () => {
  const frozen = relaxStoryStep(createStoryPlan("quiet-company", 12345), 2, true), changed = createStoryPlan("little-hello", 999);
  assert.equal(challengeStoryForReview(changed, { story: frozen }), frozen);
  assert.equal(challengeStoryPose(frozen, 2, members).prompt, RELAXED_POSE);
  assert.equal(challengeStoryForReview(changed, {}), null);
  assert.equal(challengeStoryForReview(changed, null), changed);
});
