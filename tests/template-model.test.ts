import assert from "node:assert/strict";
import test from "node:test";
import { MATERIAL_ASSETS, SCENE_ASSETS } from "../lib/assets/registry";
import { parseTemplateRecipe, portableTemplate, validateTemplateDesign, validateTemplateRecipe } from "../lib/templates/model";
import { templateFixture } from "./helpers/template-fixture";

const mutable = () => JSON.parse(JSON.stringify(templateFixture(true)));
test("template validation detaches and freezes geometry; embedded design has no identity metadata", () => {
  const input = mutable(), recipe = validateTemplateRecipe(input);
  input.slots[0].crop.zoom = 4;
  assert.equal(recipe.slots[0].crop.zoom, 1);
  assert(Object.isFrozen(recipe.slots[0].crop));
  const { canvas, requiredSources, slots, layers, decorations, look, defaults } = recipe;
  const design = validateTemplateDesign({ canvas, requiredSources, slots, layers, decorations, look, defaults });
  assert.equal("scope" in design, false);
  assert.throws(() => validateTemplateDesign({ ...design, token: "forbidden" }));
});
test("source requirements match maximum index while repeated and alternate crops retain their mappings", () => {
  const value = mutable(); value.slots.push({ ...value.slots[0], id: "repeat" });
  assert.equal(validateTemplateRecipe(value).slots.length, 2);
  value.requiredSources.A = 2;
  assert.throws(() => validateTemplateRecipe(value), /highest source index/);
  value.slots[1].sourceIndex = 1;
  assert.equal(validateTemplateRecipe(value).requiredSources.A, 2);
  value.slots[1].role = "B";
  assert.throws(() => validateTemplateRecipe(value), /declared source/);
  value.requiredSources = { A: 1, B: 1 }; value.slots[1].sourceIndex = 0;
  assert.equal(Object.keys(validateTemplateRecipe(value).requiredSources).length, 2);
  value.requiredSources.E = 1;
  assert.throws(() => validateTemplateRecipe(value), /Unsupported/);
});
test("alternate source indices and split portrait slices remain portable without inventing shots", () => {
  const value = mutable(); value.requiredSources = { A: 3, B: 4 };
  value.slots = [0, 2].map(index => ({ ...value.slots[0], id: `a-${index}`, sourceIndex: index, sliceX: [0, 0.5] })).concat([1, 3].map(index => ({ ...value.slots[0], id: `b-${index}`, role: "B", sourceIndex: index, sliceX: [0.5, 1] })));
  assert.deepEqual(validateTemplateRecipe(value).requiredSources, { A: 3, B: 4 });
  for (const slice of [[0.5, 0.5], [1, 0], [-0.1, 1], [0, 1, 2], [0]]) {
    value.slots[0].sliceX = slice; assert.throws(() => validateTemplateRecipe(value), /sliceX/);
  }
});
test("normalised geometry, pixel budgets, numeric finiteness and transform bounds are enforced", () => {
  for (const patch of [{ width: 127 }, { width: 4097 }, { width: 4096, height: 4096 }]) assert.throws(() => validateTemplateRecipe({ ...mutable(), canvas: { ...mutable().canvas, ...patch } }));
  for (const patch of [{ x: -0.1 }, { x: 0.9 }, { width: 0 }, { height: Infinity }]) {
    const value = mutable(); Object.assign(value.slots[0], patch); assert.throws(() => validateTemplateRecipe(value));
  }
  for (const patch of [{ zoom: 4.01 }, { rotation: 45 }, { offsetX: NaN }, { mirror: "true" }]) {
    const value = mutable(); Object.assign(value.slots[0].crop, patch); assert.throws(() => validateTemplateRecipe(value));
  }
});
test("layer/source limits, Unicode codepoints and built-in identifiers are bounded", () => {
  const value = mutable(); value.layers = Array.from({ length: 16 }, (_, i) => ({ ...value.layers[0], id: `text-${i}`, text: "🌻".repeat(500) })); value.decorations = [];
  assert.equal(validateTemplateRecipe(value).layers.length, 16);
  value.layers.push({ ...value.layers[0], id: "excess" }); assert.throws(() => validateTemplateRecipe(value), /Layer count/);
  value.layers = [value.layers[0]]; value.layers[0].text += "x"; assert.throws(() => validateTemplateRecipe(value), /oversized text/);
  value.layers[0].text = "caption"; value.slots = Array.from({ length: 17 }, (_, i) => ({ ...value.slots[0], id: `slot-${i}` })); assert.throws(() => validateTemplateRecipe(value), /oversized array/);
  const asset = mutable(); asset.look.materialId = MATERIAL_ASSETS[0].id; asset.look.sceneId = SCENE_ASSETS[0].id;
  assert.equal(validateTemplateRecipe(asset).look.materialId, MATERIAL_ASSETS[0].id);
  asset.look.materialId = SCENE_ASSETS[0].id; assert.throws(() => validateTemplateRecipe(asset), /Unknown material/);
  asset.look.materialId = "https://example.test/image.png"; assert.throws(() => validateTemplateRecipe(asset), /Unknown material/);
});
test("recipes reject source photos, SVG, unknown fields, missing files and duplicate identifiers", () => {
  for (const patch of [{ kind: "photo" }, { mime: "image/svg+xml" }, { width: 2049 }, { bytes: 4 * 1024 * 1024 + 1 }]) {
    const value = mutable(); Object.assign(value.decorations[0], patch); assert.throws(() => validateTemplateRecipe(value));
  }
  const missing = mutable(); missing.layers[1].mediaId = "missing"; assert.throws(() => validateTemplateRecipe(missing), /Missing PNG/);
  const duplicate = mutable(); duplicate.layers[0].id = duplicate.slots[0].id; assert.throws(() => validateTemplateRecipe(duplicate), /Duplicate/);
  for (const field of ["photos", "token", "roomCode", "url", "svg"]) assert.throws(() => validateTemplateRecipe({ ...mutable(), [field]: "forbidden" }));
  const accessor = mutable(); let read = false; Object.defineProperty(accessor.look, "frameId", { get() { read = true; return "film"; } });
  assert.throws(() => validateTemplateRecipe(accessor), /accessor/); assert.equal(read, false);
});
test("portable defaults remove every text layer and caption while retaining layout; explicit opt-in restores text", () => {
  const original = templateFixture(true), portable = portableTemplate(original);
  assert.deepEqual(portable.scope, { kind: "device" }); assert.equal(portable.defaults.caption, "");
  assert.equal(portable.layers[0].kind === "text" && portable.layers[0].text, "");
  assert.deepEqual(portable.slots, original.slots); assert.equal(original.defaults.caption, "Our anniversary");
  assert.equal(portableTemplate(original, true).defaults.caption, original.defaults.caption);
});
test("future recipes preserve exact bounded JSON for read-only recovery", () => {
  const raw = '{"schemaVersion":7,"future":{"opaque":"keep"}}';
  assert.deepEqual(parseTemplateRecipe(raw), { kind: "unsupported", schemaVersion: 7, rawJson: raw, readOnly: true });
  assert.throws(() => parseTemplateRecipe(" ".repeat(65537)), /64 KiB/);
  assert.throws(() => parseTemplateRecipe('{"schemaVersion":0}'));
});

test("Together companions preserve each participant source, crop and placement with bounded unique roles", () => {
  const value = mutable(); value.requiredSources = { A: 1, B: 3 }; value.places = { B: { dx: 0.2, dy: -0.1, scale: 1.2 } };
  const companion = { role: "B", sourceIndex: 2, crop: { ...value.slots[0].crop, rotation: 90 }, filterId: "bw", sliceX: [0.5, 1] };
  value.slots[0].companions = [companion]; value.slots[0].splitFallback = true;
  const checked = validateTemplateRecipe(value);
  assert.equal(checked.slots[0].companions?.[0].sourceIndex, 2); assert.equal(checked.places?.B?.scale, 1.2);
  value.slots[0].companions = [companion, companion]; assert.throws(() => validateTemplateRecipe(value), /different participant/);
  value.slots[0].companions = [{ ...companion, role: "A" }]; assert.throws(() => validateTemplateRecipe(value), /different participant|declared source/);
  value.slots[0].companions = [companion]; value.places.B.scale = 2; assert.throws(() => validateTemplateRecipe(value), /place.scale/);
  value.places.B.scale = 1; value.places.C = { dx: 0, dy: 0, scale: 1 }; assert.throws(() => validateTemplateRecipe(value), /undeclared participant/);
});
