import assert from "node:assert/strict";
import test from "node:test";
import { designFromRecipe, templateForNewProject } from "../lib/templates/application";
import { validateTemplateDesign } from "../lib/templates/model";
import { templateFixture } from "./helpers/template-fixture";
test("new-project role assignment preserves crops and source indices without changing the saved recipe", () => {
  const original = designFromRecipe(templateFixture());
  const design = validateTemplateDesign({ ...original, requiredSources: { B: 3, D: 4 }, slots: [{ ...original.slots[0], role: "B", sourceIndex: 2 }, { ...original.slots[0], id: "other", role: "D", sourceIndex: 3 }] });
  const next = templateForNewProject(design);
  assert.equal(next.mode, "duo"); assert.deepEqual(next.roles, ["A", "B"]); assert.equal(next.requiredShots, 4);
  assert.deepEqual(next.design.requiredSources, { A: 3, B: 4 }); assert.deepEqual(next.design.slots.map(slot => slot.sourceIndex), [2, 3]);
  assert.deepEqual(design.slots.map(slot => slot.role), ["B", "D"]);
  assert.deepEqual(next.design.slots[0].crop, design.slots[0].crop);
});
test("new-project role assignment includes Together companions and their placements", () => {
  const original = designFromRecipe(templateFixture());
  const design = validateTemplateDesign({ ...original, requiredSources: { B: 1, D: 2 }, places: { D: { dx: 0.2, dy: 0.1, scale: 1.1 } }, slots: [{ ...original.slots[0], role: "B", companions: [{ role: "D", sourceIndex: 1, crop: original.slots[0].crop }], splitFallback: true }] });
  const next = templateForNewProject(design);
  assert.deepEqual(next.design.requiredSources, { A: 1, B: 2 });
  assert.equal(next.design.slots[0].companions?.[0].role, "B");
  assert.deepEqual(next.design.places?.B, design.places?.D);
  assert.equal(next.design.slots[0].splitFallback, true);
});
