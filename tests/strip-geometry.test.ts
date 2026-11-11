import assert from "node:assert/strict";
import { test } from "node:test";
import { CELL_GAP, CELL_W, FOOTER_H, LAYOUTS, STRIP_MARGIN, canvasBand, cellShotIndex, layoutCellCount, layoutRoles, shotAspect, splitSlice, stripGeometry, stripSize } from "../lib/layouts";

const legacyFormula = {
  strip4: { cols: 1, rows: 4, aspect: 3 / 2, pattern: null },
  grid4: { cols: 2, rows: 2, aspect: 4 / 3, pattern: null },
  strip3: { cols: 1, rows: 3, aspect: 4 / 3, pattern: null },
  "duo-alternate": { cols: 1, rows: 4, aspect: 3 / 2, pattern: ["A", "B", "A", "B"] },
  "duo-split": { cols: 1, rows: 4, aspect: 3 / 2, pattern: ["AB", "AB", "AB", "AB"] },
  "duo-twin": { cols: 2, rows: 4, aspect: 3 / 2, pattern: ["A", "B", "A", "B", "A", "B", "A", "B"] },
  trio: { cols: 3, rows: 4, aspect: 3 / 2, pattern: Array.from({ length: 12 }, (_, i) => "ABC"[i % 3]) },
  quad: { cols: 4, rows: 3, aspect: 3 / 2, pattern: Array.from({ length: 12 }, (_, i) => "ABCD"[i % 4]) },
  "quad-story": { cols: 4, rows: 4, aspect: 3 / 2, pattern: Array.from({ length: 16 }, (_, i) => "ABCD"[i % 4]) },
} as const;

test("V2 layouts keep the uniform grid geometry, owners and shot order they had before rows of cells", () => {
  for (const [id, old] of Object.entries(legacyFormula)) {
    const layout = LAYOUTS.find(item => item.id === id)!;
    assert(layout.legacy, id);
    const cellH = CELL_W / old.aspect, geometry = stripGeometry(layout);
    assert.deepEqual(stripSize(layout), {
      width: STRIP_MARGIN * 2 + old.cols * CELL_W + (old.cols - 1) * CELL_GAP,
      height: STRIP_MARGIN * 2 + old.rows * cellH + (old.rows - 1) * CELL_GAP + FOOTER_H,
    });
    assert.equal(geometry.cells.length, old.cols * old.rows);
    geometry.cells.forEach((cell, i) => {
      const owner = old.pattern?.[i] ?? "A";
      assert.deepEqual([cell.x, cell.y, cell.width, cell.height], [STRIP_MARGIN + (i % old.cols) * (CELL_W + CELL_GAP), STRIP_MARGIN + Math.floor(i / old.cols) * (cellH + CELL_GAP), CELL_W, cellH]);
      assert.deepEqual(cell.owners, owner === "AB" ? ["A", "B"] : [owner]);
      assert.equal(cell.shot, layout.mode === "solo" ? i : Math.floor(i / old.cols));
      assert.equal(cellShotIndex(layout, i), cell.shot);
    });
    assert.deepEqual(geometry.band, { x: STRIP_MARGIN, y: geometry.height - STRIP_MARGIN - FOOTER_H, width: geometry.width - STRIP_MARGIN * 2, height: FOOTER_H });
  }
});

test("every layout's cells fill each row, stay inside the photo area and never overlap", () => {
  for (const layout of LAYOUTS) {
    const geometry = stripGeometry(layout), content = geometry.width - geometry.margin * 2;
    assert(Number.isInteger(geometry.width) && Number.isInteger(geometry.height), layout.id);
    assert.equal(layoutCellCount(layout), geometry.cells.length);
    const rows = new Map<number, typeof geometry.cells[number][]>();
    for (const cell of geometry.cells) rows.set(cell.y, [...(rows.get(cell.y) ?? []), cell]);
    for (const row of rows.values()) {
      const used = row.reduce((sum, cell) => sum + cell.width, 0) + (row.length - 1) * geometry.gap;
      assert(Math.abs(used - content) < 1e-9, `${layout.id} row width`);
    }
    for (const cell of geometry.cells) {
      assert(cell.x >= geometry.margin - 1e-9 && cell.x + cell.width <= geometry.width - geometry.margin + 1e-9, `${layout.id} x`);
      assert(cell.y >= geometry.margin && cell.y + cell.height <= geometry.band.y, `${layout.id} y`);
      assert(cell.shot >= 0 && cell.shot < layout.shots, `${layout.id} shot`);
      for (const other of geometry.cells) if (other !== cell) {
        const apart = cell.x + cell.width <= other.x + 1e-9 || other.x + other.width <= cell.x + 1e-9 || cell.y + cell.height <= other.y || other.y + other.height <= cell.y;
        assert(apart, `${layout.id} cells ${cell.index} and ${other.index} overlap`);
      }
    }
  }
});

test("every round appears in the strip and no role shows the same round twice", () => {
  for (const layout of LAYOUTS) {
    const cells = stripGeometry(layout).cells;
    assert.deepEqual([...new Set(cells.map(cell => cell.shot))].sort((a, b) => a - b), Array.from({ length: layout.shots }, (_, shot) => shot), layout.id);
    for (const role of layoutRoles(layout)) {
      const shots = cells.filter(cell => cell.owners.includes(role)).map(cell => cell.shot);
      assert.equal(new Set(shots).size, shots.length, `${layout.id} ${role}`);
    }
  }
});

test("capture framing follows the cell that shows a shot and halves for a split", () => {
  assert.equal(shotAspect(LAYOUTS.find(item => item.id === "strip4")!, 2), 3 / 2);
  assert.equal(shotAspect(LAYOUTS.find(item => item.id === "grid4")!, 0), 4 / 3);
  assert.equal(shotAspect(LAYOUTS.find(item => item.id === "duo-split")!, 0), 3 / 4);
  assert.deepEqual(splitSlice(2), [0.25, 0.75]);
  assert.deepEqual(splitSlice(3), [0, 1]);
  assert.deepEqual(canvasBand(536, 1522), { x: 28, y: 1362, width: 480, height: 132 });
});
