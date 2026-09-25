import assert from "node:assert/strict";
import test from "node:test";
import { STORY_DECKS, STORY_CATEGORIES, RELAXED_POSE } from "../lib/stories/catalogue";
import { createStoryPlan, relaxStoryStep, storyCaptureProgress, storyStep, validateStoryPlan } from "../lib/stories/model";
import { applyProjectEdit, configureProjectCapture, createProject, parsePhotoProject, serializePhotoProject, undoProject } from "../lib/projects/model";

test("twelve versioned four-cut decks cover all four categories with authored English", () => {
  assert.equal(STORY_DECKS.length, 12); assert.equal(new Set(STORY_DECKS.map(deck => deck.id)).size, 12);
  for (const category of Object.keys(STORY_CATEGORIES)) assert.equal(STORY_DECKS.filter(deck => deck.category === category).length, 3);
  for (const deck of STORY_DECKS) {
    assert.equal(deck.version, 1); assert.equal(deck.steps.length, 4); assert(Object.isFrozen(deck.steps));
    for (const copy of [deck.title, deck.description, ...deck.steps]) assert(copy.trim().length > 5 && copy.length <= 180);
  }
});
test("a persisted seed gives every peer the same director turns without rebinding participant IDs", () => {
  const plan = createStoryPlan("passing-a-smile", 4294967295);
  for (const members of [["a"], ["a", "b"], ["a", "c", "d"], ["a", "b", "c", "d"]]) {
    const turns = [0, 1, 2, 3].map(index => storyStep(plan, index, members));
    assert.equal(new Set(turns.slice(0, members.length).map(turn => turn.directorId)).size, members.length);
    assert.deepEqual(turns, [0, 1, 2, 3].map(index => storyStep(validateStoryPlan(JSON.parse(JSON.stringify(plan))), index, members)));
  }
  assert.throws(() => storyStep(plan, 4, ["a"])); assert.throws(() => storyStep(plan, 0, ["a", "a"]));
});
test("skipping a pose keeps four capture positions and changes only that prompt", () => {
  const plan = createStoryPlan("birthday-wish", 5), relaxed = relaxStoryStep(plan, 2, true);
  assert.deepEqual(plan.relaxedSteps, []); assert.deepEqual(relaxed.relaxedSteps, [2]);
  assert.equal(storyStep(relaxed, 2, ["a", "b"]).prompt, RELAXED_POSE);
  for (const index of [0, 1, 3]) assert.deepEqual(storyStep(relaxed, index, ["a", "b"]), storyStep(plan, index, ["a", "b"]));
  assert.deepEqual(relaxStoryStep(relaxed, 2, false), plan);
});
test("untrusted story plans reject unknown versions, fields, seeds, duplicate steps and executable properties", () => {
  const plan = createStoryPlan("little-hello", 0);
  for (const value of [{ ...plan, version: 2 }, { ...plan, deckId: "unavailable" }, { ...plan, seed: -1 }, { ...plan, seed: 2 ** 32 }, { ...plan, seed: NaN }, { ...plan, relaxedSteps: [0, 0] }, { ...plan, relaxedSteps: [4] }, { ...plan, url: "https://example.test" }, { ...plan, relaxedSteps: new Array(2) }]) assert.throws(() => validateStoryPlan(value), /invalid_story/);
  let reads = 0;
  const getter = { ...plan }; Object.defineProperty(getter, "seed", { get: () => { reads++; return 1; } });
  assert.throws(() => validateStoryPlan(getter));
  const steps = [0]; Object.defineProperty(steps, "0", { get: () => { reads++; return 0; } });
  assert.throws(() => validateStoryPlan({ ...plan, relaxedSteps: steps })); assert.equal(reads, 0);
});
test("story seeds and relaxed prompts survive durable project serialisation and undo", () => {
  const project = createProject({ editor: { story: createStoryPlan("quiet-company", 42) } });
  const changed = applyProjectEdit(project, { sourceOrder: project.sourceOrder, editor: { ...project.editor, story: relaxStoryStep(project.editor.story!, 1, true) } });
  const reopened = parsePhotoProject(serializePhotoProject(changed));
  assert.equal(reopened.kind, "current");
  if (reopened.kind !== "current") throw new Error("Expected current project");
  assert.deepEqual(reopened.project.editor.story, changed.editor.story);
  assert.deepEqual(undoProject(reopened.project).editor.story, project.editor.story);
  assert.deepEqual(reopened.project.media, []);
});
test("every guided room photo gets its own countdown without a fifth prompt", () => {
  assert.deepEqual(storyCaptureProgress(20_000, 15_000, 0), { step: 0, countdown: 20 });
  assert.deepEqual(storyCaptureProgress(20_000, 15_000, 19_999), { step: 0, countdown: 1 });
  assert.deepEqual(storyCaptureProgress(20_000, 15_000, 20_000), { step: 1, countdown: 15 });
  assert.deepEqual(storyCaptureProgress(20_000, 15_000, 49_500), { step: 2, countdown: 1 });
  assert.deepEqual(storyCaptureProgress(20_000, 15_000, 50_000), { step: 3, countdown: 15 });
  assert.deepEqual(storyCaptureProgress(20_000, 15_000, 65_000), { step: 3, countdown: 0 });
  assert.deepEqual(storyCaptureProgress(20_000, 15_000, 80_000), { step: 3, countdown: 0 });
  assert.throws(() => storyCaptureProgress(20_000, 0, 0));
});
test("story and capture configuration advance one durable revision and reject incompatible shots", () => {
  const previous = createProject({ editor: { layoutId: "strip3" } });
  const plan = createStoryPlan("four-moods", 8);
  const next = configureProjectCapture(previous, { requiredShots: 4, timerSeconds: 10 }, { layoutId: "strip4", story: plan });
  assert.equal(next.revision, previous.revision + 1); assert.equal(next.history.past.length, 1);
  assert.equal(next.capture.requiredShots, 4); assert.equal(next.capture.timerSeconds, 10);
  assert.deepEqual(next.editor.story, plan); assert.equal(previous.editor.story, undefined);
  const restored = undoProject(next); assert.equal(restored.editor.layoutId, previous.editor.layoutId); assert.equal(restored.capture.requiredShots, previous.capture.requiredShots);
  assert.throws(() => configureProjectCapture(next, { requiredShots: 3 }), /four photo positions/);
  assert.throws(() => configureProjectCapture({ ...next, capturedAt: next.createdAt }, { requiredShots: 3 }, { story: null }), /new round/);
  assert.equal(configureProjectCapture(next, { timerSeconds: 5 }).capture.timerSeconds, 5);
});
