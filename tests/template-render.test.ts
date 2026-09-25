import assert from "node:assert/strict";
import test from "node:test";
import { CELL_GAP, CELL_W, LAYOUTS, ROLES, STRIP_MARGIN, cellShotIndex, stripSize } from "../lib/layouts";
import { createProject, validatePhotoProject } from "../lib/projects/model";
import { defaultCellEdit } from "../lib/projects/transforms";
import { templateFromProject } from "../lib/templates/from-project";
import { composeStrip, compositionSize, type ComposeInput } from "../lib/compose";

test("eight built-in layouts become bounded templates with unchanged roles, source indices and pixel geometry", () => {
  for (const layout of LAYOUTS) {
    const count = layout.mode === "solo" ? 1 : layout.mode === "duo" ? 2 : layout.minMembers!;
    const project = createProject({ mode: layout.mode, participants: ROLES.slice(0, count).map(role => ({ id: `person-${role}`, role })), editor: { layoutId: layout.id } });
    const design = templateFromProject(project), size = stripSize(layout);
    assert.deepEqual(design.canvas, size);
    assert.deepEqual(compositionSize({ layout, template: design }), size);
    let index = 0;
    for (let cell = 0; cell < layout.cols * layout.rows; cell++) {
      const owner = layout.duoPattern?.[cell] ?? "A", roles = owner === "AB" ? ["A", "B"] : [owner];
      roles.forEach((role, half) => {
        const slot = design.slots[index++];
        assert.equal(slot.role, role); assert.equal(slot.sourceIndex, cellShotIndex(layout, cell));
        assert(Math.abs(slot.x * size.width - (STRIP_MARGIN + (cell % layout.cols) * (CELL_W + CELL_GAP) + half * CELL_W / 2)) < 1e-8);
        assert(Math.abs(slot.y * size.height - (STRIP_MARGIN + Math.floor(cell / layout.cols) * (CELL_W / layout.cellAspect + CELL_GAP))) < 1e-8);
        assert(Math.abs(slot.width * size.width - CELL_W / roles.length) < 1e-8);
        if (owner === "AB") assert.deepEqual(slot.sliceX, [0.25, 0.75]);
      });
    }
    assert.equal(design.slots.length, index);
  }
});

test("saving a current layout retains source replacement, crop transform and per-cell filter", () => {
  const project = createProject({ editor: { cellEdits: { "0:A": { ...defaultCellEdit(2), zoom: 1.5, offsetX: 0.15, offsetY: -0.1, rotation: 90, mirror: true, filterId: "bw" } }, caption: "Current caption", showDate: false } });
  const design = templateFromProject(project), first = design.slots[0];
  assert.equal(first.sourceIndex, 2); assert.equal(first.filterId, "bw");
  assert.deepEqual(first.crop, { zoom: 1.5, offsetX: 0.15, offsetY: -0.1, rotation: 90, mirror: true });
  assert.equal(design.defaults.caption, "Current caption"); assert.equal(design.defaults.showDate, false);
});

test("saving an edited template preserves geometry while refreshing current look and caption defaults", () => {
  const initial = createProject(), existing = templateFromProject(initial);
  const project = validatePhotoProject({ ...initial, editor: { ...initial.editor, template: existing, filterId: "sepia", caption: "Edited", showDate: false, materialId: "rose-washi-paper-v2" } });
  const saved = templateFromProject(project);
  assert.deepEqual(saved.slots, existing.slots); assert.deepEqual(saved.layers, existing.layers);
  assert.equal(saved.look.filterId, "sepia"); assert.equal(saved.look.materialId, "rose-washi-paper-v2"); assert.deepEqual(saved.defaults, { caption: "Edited", showDate: false });
});

test("Together recipes keep every participant in each full-width cell and retain scene placements", () => {
  for (const layout of LAYOUTS.filter(layout => layout.mode !== "solo")) {
    const roles = ROLES.slice(0, layout.mode === "duo" ? 2 : layout.minMembers!), places = { A: { dx: -0.1, dy: 0.05, scale: 1.15 }, B: { dx: 0.08, dy: 0, scale: 0.9 } };
    const project = createProject({ mode: layout.mode, participants: roles.map(role => ({ id: `person-${role}`, role })), editor: { layoutId: layout.id, sceneId: "studio-cream", places, cellEdits: { "0:A": { ...defaultCellEdit(2), filterId: "bw" } } } });
    const design = templateFromProject(project);
    assert.equal(design.slots.length, layout.rows * layout.cols); assert.deepEqual(design.places, places);
    for (const slot of design.slots) {
      assert.deepEqual([slot.role, ...(slot.companions ?? []).map(source => source.role)].sort(), roles);
      assert(Math.abs(slot.width * design.canvas.width - CELL_W) < 1e-8);
    }
    assert.equal(design.slots[0].sourceIndex, 2); assert.equal(design.slots[0].filterId, "bw");
    if (layout.id === "duo-split") { assert(design.slots.every(slot => slot.splitFallback)); assert.deepEqual(design.slots[0].companions?.[0].sliceX, [0.25, 0.75]); }
  }
});

test("Together renderer groups both ready people and atomically falls back to split originals when one cutout is missing", () => {
  const layout = LAYOUTS.find(layout => layout.id === "duo-split")!;
  const project = createProject({ mode: "duo", participants: [{ id: "a", role: "A" }, { id: "b", role: "B" }], editor: { layoutId: layout.id, sceneId: "studio-cream" } });
  const template = templateFromProject(project);
  const photoA = { width: 240, height: 160 } as HTMLCanvasElement, photoB = { width: 240, height: 160 } as HTMLCanvasElement;
  const cutA = { width: 120, height: 160 } as HTMLCanvasElement, cutB = { width: 120, height: 160 } as HTMLCanvasElement;
  const calls: unknown[][] = [];
  const context = new Proxy({}, { get: (_target, key) => key === "drawImage" ? (...args: unknown[]) => calls.push(args) : String(key).startsWith("create") ? () => ({ addColorStop() {} }) : () => {} }) as CanvasRenderingContext2D;
  const canvas = { width: 0, height: 0, getContext: () => context } as unknown as HTMLCanvasElement;
  const input: ComposeInput = { layout, template, shots: { A: [photoA, photoA, photoA, photoA], B: [photoB, photoB, photoB, photoB] }, cutouts: { A: [cutA, cutA, cutA, cutA], B: [cutB, cutB, cutB, cutB] }, together: { sceneId: "studio-cream", places: {} }, stickers: [], style: { frameColor: "#ffffff", inkColor: "#000000", patternId: "none", filterId: "none", caption: "", showDate: false, stickerStyle: "flat" } };
  composeStrip(canvas, input);
  assert.equal(calls.filter(call => call[0] === cutA).length, 4); assert.equal(calls.filter(call => call[0] === cutB).length, 4);
  assert.equal(calls.filter(call => call[0] === photoA || call[0] === photoB).length, 0);
  calls.length = 0;
  composeStrip(canvas, { ...input, cutouts: { ...input.cutouts, B: [null, null, null, null] } });
  assert.equal(calls.filter(call => call[0] === cutA || call[0] === cutB).length, 0);
  assert.equal(calls.filter(call => call[0] === photoA).length, 4); assert.equal(calls.filter(call => call[0] === photoB).length, 4);
});
