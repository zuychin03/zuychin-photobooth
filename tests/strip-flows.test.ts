import assert from "node:assert/strict";
import { test } from "node:test";
import { LAYOUTS, getLayout, layoutsForMembers, stripGeometry, type Role } from "../lib/layouts";
import { appendProjectMedia, applyProjectEdit, configureProjectCapture, createProject, editorNeedsV5, parsePhotoProject, serializePhotoProject, validatePhotoProject } from "../lib/projects/model";
import { importPixelBudget, importSize } from "../lib/projects/import-budget";
import { RESOURCE_LIMITS } from "../lib/projects/resource-bounds";
import { parseTemplateRecipe, templateSchemaFor, validateTemplateDesign, validateTemplateRecipe } from "../lib/templates/model";
import { templateFromProject } from "../lib/templates/from-project";
import { challengeDesign, challengeLayouts } from "../lib/memories/challenge-ui";
import { validateRelayMeta } from "../lib/relay";
import { layoutCategories, layoutMeta } from "../components/LayoutPicker";
import { layoutGlyph } from "../components/LayoutGlyph";

const createdAt = "2026-11-11T00:00:00.000Z", later = "2026-11-11T00:05:00.000Z";
const people = ["10000000-0000-4000-8000-000000000001", "10000000-0000-4000-8000-000000000002", "10000000-0000-4000-8000-000000000003", "10000000-0000-4000-8000-000000000004"];
const participants = (count: number) => (["A", "B", "C", "D"] as Role[]).slice(0, count).map((role, index) => ({ id: people[index], role }));

test("V3 layouts reach each flow by people count and legacy rooms keep the V2 catalogue", () => {
  assert.deepEqual(challengeLayouts(2).map(item => item.id), ["duo-alternate", "duo-split", "duo-twin", "duo-grid", "duo-film"]);
  assert.deepEqual(challengeLayouts(3).map(item => item.id), ["trio", "trio-split", "trio-row"]);
  assert.deepEqual(challengeLayouts(4).map(item => item.id), ["quad", "quad-story", "quad-split", "quad-grid"]);
  assert(layoutsForMembers(2).every(item => item.legacy) && layoutsForMembers(4).every(item => item.legacy));
  assert.deepEqual(layoutCategories(LAYOUTS.filter(item => item.mode === "solo")), ["strips", "grids", "feature", "wide", "single"]);
  assert.deepEqual(layoutCategories(LAYOUTS.filter(item => item.mode === "duo")), ["strips", "grids", "wide", "together"]);
  assert.equal(layoutMeta(LAYOUTS.find(item => item.id === "polaroid")!), "1 photo");
  assert.equal(layoutMeta(LAYOUTS.find(item => item.id === "quad-grid")!), "1 round");
  assert.equal(layoutMeta(LAYOUTS.find(item => item.id === "duo-grid")!, true), "2 photos each");
});

test("every shared V3 layout becomes a challenge design inside the server's slot and source limits", () => {
  for (const count of [2, 3, 4]) for (const layout of challengeLayouts(count)) {
    const { design, members } = challengeDesign(layout.id, people.slice(0, count));
    assert.equal(members.length, count);
    assert(design.slots.length >= 1 && design.slots.length <= 16, layout.id);
    for (const slot of design.slots) assert(slot.sourceIndex >= 0 && slot.sourceIndex <= 3, layout.id);
    assert.deepEqual(Object.keys(design.requiredSources).sort(), members.map(member => member.role).sort(), layout.id);
    assert.equal(Math.max(...Object.values(design.requiredSources)), layout.shots, layout.id);
  }
  const split = challengeDesign("quad-split", people).design;
  assert.equal(split.slots.length, 16);
  assert(split.slots.every(slot => slot.sliceX === undefined));
});

test("relays accept the new duo layouts within the 4-photo relay limit", () => {
  for (const layout of LAYOUTS.filter(item => item.mode === "duo")) validateRelayMeta({ layoutId: layout.id, filterId: "none", sceneId: null, shots: layout.shots });
  assert.throws(() => validateRelayMeta({ layoutId: "trio-split", filterId: "none", sceneId: null, shots: 4 }));
  assert.throws(() => validateRelayMeta({ layoutId: "duo-grid", filterId: "none", sceneId: null, shots: 4 }));
});

test("projects using V3 layouts save as schema 5, never drop back, and stay unreadable to schema 4", () => {
  const legacy = createProject({ createdAt, captureTimeZone: "UTC" });
  assert.equal(legacy.schemaVersion, 4);
  const fresh = createProject({ createdAt, captureTimeZone: "UTC", editor: { layoutId: "feature3" } });
  assert.equal(fresh.schemaVersion, 5); assert.equal(fresh.capture.requiredShots, 3);
  const edited = applyProjectEdit(legacy, { sourceOrder: legacy.sourceOrder, editor: { ...legacy.editor, layoutId: "polaroid" } }, later);
  assert.equal(edited.schemaVersion, 5);
  const back = applyProjectEdit(edited, { sourceOrder: edited.sourceOrder, editor: { ...edited.editor, layoutId: "strip4" } }, later);
  assert.equal(back.schemaVersion, 5);
  assert.throws(() => validatePhotoProject({ ...fresh, schemaVersion: 4 }), /layoutId/);
  assert.equal(parsePhotoProject(serializePhotoProject(fresh)).kind, "current");
  assert.equal(parsePhotoProject(JSON.stringify({ ...fresh, schemaVersion: 6 })).kind, "unsupported");
  const duo = createProject({ mode: "duo", participants: participants(2), createdAt, captureTimeZone: "UTC", editor: { layoutId: "duo-film" } });
  assert.equal(duo.schemaVersion, 5);
  assert(!editorNeedsV5({ layoutId: "quad-story" }) && editorNeedsV5({ layoutId: "quad-grid" }) && !editorNeedsV5({ caption: "x" }));
});

test("every layout glyph has whole-pixel tiles, one even gap between neighbours, and fits its box", () => {
  for (const layout of LAYOUTS) for (const box of [40, 48]) for (const ratio of [1, 1.25, 1.5, 2, 3]) {
    const { width, height, gap, tiles } = layoutGlyph(layout, box, ratio), label = `${layout.id} at ${box}px x${ratio}`;
    assert(width <= Math.round(box * ratio) + 1 && height <= Math.round(box * ratio) + 1, `${label} fits`);
    assert.equal(tiles.length, layout.rows.reduce((sum, row) => sum + row.cells.reduce((count, cell) => count + cell.owners.length, 0), 0), label);
    for (const tile of tiles) {
      assert([tile.x, tile.y, tile.width, tile.height].every(Number.isInteger), `${label} ${tile.key} on whole device pixels`);
      assert(tile.width >= gap && tile.height >= gap && tile.x >= gap && tile.y >= gap && tile.x + tile.width <= width - gap && tile.y + tile.height < height - gap, `${label} ${tile.key} inside the strip`);
      for (const other of tiles) {
        if (other === tile) continue;
        const overlapX = tile.x < other.x + other.width && other.x < tile.x + tile.width, overlapY = tile.y < other.y + other.height && other.y < tile.y + tile.height;
        assert(!(overlapX && overlapY), `${label}: ${tile.key} overlaps ${other.key}`);
        const spacing = overlapY ? Math.max(other.x - tile.x - tile.width, tile.x - other.x - other.width) : overlapX ? Math.max(other.y - tile.y - tile.height, tile.y - other.y - other.height) : Infinity;
        assert(spacing >= gap, `${label}: ${tile.key} and ${other.key} are ${spacing}px apart`);
      }
      const right = tiles.filter(other => other.y < tile.y + tile.height && tile.y < other.y + other.height && other.x > tile.x).map(other => other.x - tile.x - tile.width);
      const below = tiles.filter(other => other.x < tile.x + tile.width && tile.x < other.x + other.width && other.y > tile.y).map(other => other.y - tile.y - tile.height);
      if (right.length) assert.equal(Math.min(...right), gap, `${label}: gap right of ${tile.key}`);
      if (below.length) assert.equal(Math.min(...below), gap, `${label}: gap below ${tile.key}`);
    }
  }
});

test("Six grid and Eight-cut are solo grids with photos in reading order", () => {
  for (const [id, width, height, shots] of [["grid6", 1034, 1304, 6], ["cut8", 1034, 1522, 8]] as const) {
    const layout = getLayout(id), geometry = stripGeometry(layout);
    assert.equal(layout.id, id); assert.equal(layout.mode, "solo"); assert.equal(layout.category, "grids"); assert.equal(layout.shots, shots);
    assert.deepEqual([geometry.width, geometry.height], [width, height]);
    assert.deepEqual(geometry.cells.map(cell => cell.shot), Array.from({ length: shots }, (_, index) => index));
  }
});

test("solo projects hold up to 8 photos under schema 5 while shared projects stay at 4", () => {
  const eight = createProject({ createdAt, captureTimeZone: "UTC", editor: { layoutId: "cut8" } });
  assert.equal(eight.schemaVersion, 5); assert.equal(eight.capture.requiredShots, 8);
  const size = importSize(4032, 3024, importPixelBudget(8));
  const media = Array.from({ length: 8 }, (_, index) => ({ id: `photo-${index}`, kind: "photo" as const, mime: "image/jpeg" as const, bytes: 2_000_000, ...size, participantId: eight.participants[0].id }));
  const filled = appendProjectMedia(eight, media, { ...eight.sourceOrder, A: media.map(item => item.id) }, later, later);
  assert.equal(filled.sourceOrder.A.length, 8);
  assert(filled.media.reduce((sum, item) => sum + item.width * item.height, 0) <= RESOURCE_LIMITS.totalPixels);
  const edited = applyProjectEdit(filled, { sourceOrder: filled.sourceOrder, editor: { ...filled.editor, cellEdits: { "0:A": { sourceIndex: 7, zoom: 1, offsetX: 0, offsetY: 0, rotation: 0, mirror: false, filterId: null } } } }, later);
  assert.equal(edited.editor.cellEdits["0:A"].sourceIndex, 7);
  const legacy = createProject({ createdAt, captureTimeZone: "UTC" });
  assert.throws(() => validatePhotoProject({ ...legacy, capture: { ...legacy.capture, requiredShots: 5 } }), /capture/);
  assert.equal(configureProjectCapture(legacy, { requiredShots: 6 }, { layoutId: "grid6" }, later).schemaVersion, 5);
  assert.throws(() => createProject({ mode: "duo", participants: participants(2), createdAt, captureTimeZone: "UTC", capture: { requiredShots: 5 } }), /capture/);
  const duo = createProject({ mode: "duo", participants: participants(2), createdAt, captureTimeZone: "UTC", editor: { layoutId: "duo-film" } });
  assert.throws(() => applyProjectEdit(duo, { sourceOrder: duo.sourceOrder, editor: { ...duo.editor, cellEdits: { "0:A": { sourceIndex: 4, zoom: 1, offsetX: 0, offsetY: 0, rotation: 0, mirror: false, filterId: null } } } }, later), /cellEdits/);
});

test("imports are scaled to the per-photo share of the project budget", () => {
  assert.equal(importPixelBudget(1), RESOURCE_LIMITS.photoPixels);
  assert.equal(importPixelBudget(4), RESOURCE_LIMITS.photoPixels);
  assert.equal(importPixelBudget(8), RESOURCE_LIMITS.totalPixels / 8);
  assert.deepEqual(importSize(1920, 1080, importPixelBudget(8)), { width: 1920, height: 1080 });
  const scaled = importSize(4032, 3024, importPixelBudget(8));
  assert(scaled.width * scaled.height <= importPixelBudget(8) && scaled.width * scaled.height > importPixelBudget(8) * 0.99);
  assert(Math.abs(scaled.width / scaled.height - 4 / 3) < 0.01);
});

test("templates from 8-photo solo projects need template version 2", () => {
  const eight = createProject({ createdAt, captureTimeZone: "UTC", editor: { layoutId: "cut8" } });
  const design = templateFromProject(eight);
  assert.deepEqual(design.requiredSources, { A: 8 });
  assert.equal(design.slots.length, 8);
  assert.equal(templateSchemaFor(design), 2);
  assert.equal(templateSchemaFor(templateFromProject(createProject({ createdAt, captureTimeZone: "UTC" }))), 1);
  const recipe = { ...design, id: "eight-cut", name: "Eight-cut", revision: 0, scope: { kind: "device" }, createdAt, updatedAt: createdAt };
  assert.equal(validateTemplateRecipe({ ...recipe, schemaVersion: 2 }).schemaVersion, 2);
  assert.throws(() => validateTemplateRecipe({ ...recipe, schemaVersion: 1 }), /source count/);
  assert.equal(parseTemplateRecipe(JSON.stringify({ ...recipe, schemaVersion: 3 })).kind, "unsupported");
  const shared = validateTemplateDesign(templateFromProject(createProject({ mode: "duo", participants: participants(2), createdAt, captureTimeZone: "UTC", editor: { layoutId: "duo-film" } })));
  assert.throws(() => validateTemplateDesign({ ...shared, requiredSources: { ...shared.requiredSources, A: 5 } }), /source count/);
  assert(editorNeedsV5({ template: design }));
});
