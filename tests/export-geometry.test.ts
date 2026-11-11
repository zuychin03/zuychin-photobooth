import assert from "node:assert/strict";
import test from "node:test";
import type { ComposeInput } from "../lib/compose";
import { getLayout, stripSize } from "../lib/layouts";
import { boundedRaster, exportGeometry, fitRect, mmToPixels, mmToPoints, placedWidth, sourceResolution } from "../lib/exports/geometry";
import { paintExportGeometry } from "../lib/exports/still";
import { createPhotoLoopFrames } from "../lib/exports/photo-loop";
import { immutableSource, installCanvasEnvironment, RecordingCanvas } from "./helpers/recording-canvas";
import { defaultCellEdit } from "../lib/projects/transforms";
import { templateFixture } from "./helpers/template-fixture";

const canvas = (width: number, height: number) => ({ width, height }) as HTMLCanvasElement;
function input(layout = "strip4"): ComposeInput {
  return { layout: getLayout(layout), shots: { A: Array.from({ length: 4 }, () => canvas(1600, 1200)), B: Array.from({ length: 4 }, () => canvas(1600, 1200)) },
    style: { frameColor: "#ffffff", inkColor: "#000000", patternId: "none", filterId: "none", caption: "", showDate: false, stickerStyle: "noto" }, stickers: [] };
}
test("physical page dimensions and centred two-up preserve source aspect without stretching", () => {
  assert.equal(mmToPixels(50.8), 600); assert.equal(mmToPixels(152.4), 1800);
  assert.ok(Math.abs(mmToPoints(50.8) - 144) < 1e-10); assert.ok(Math.abs(mmToPoints(152.4) - 432) < 1e-10);
  const size = stripSize(getLayout("grid4")), geometry = exportGeometry(size, "print-two-up");
  assert.equal(geometry.width, 101.6); assert.equal(geometry.height, 152.4);
  assert.deepEqual(geometry.placements.map(item => item.tile.x), [0, 50.8]);
  for (const { draw, box } of geometry.placements) {
    assert.ok(Math.abs(draw.width / draw.height - size.width / size.height) < 1e-12);
    assert.ok(draw.width <= box.width + 1e-10 && draw.height <= box.height + 1e-10);
    assert.ok(Math.abs(draw.y + draw.height / 2 - box.y - box.height / 2) < 1e-10);
  }
});
test("story fits, wallpaper crops, and original keeps bounded incumbent 2x geometry", () => {
  const size = { width: 500, height: 1500 };
  const story = exportGeometry(size, "story"), wallpaper = exportGeometry(size, "wallpaper");
  assert.equal(story.fit, "contain"); assert.equal(wallpaper.fit, "cover");
  assert.deepEqual([story.width, story.height], [1080, 1920]);
  assert.equal(story.placements[0].draw.width, 640);
  assert.equal(wallpaper.placements[0].draw.height, 3240);
  assert.equal(wallpaper.placements[0].draw.y, -660);
  assert.deepEqual(exportGeometry(size, "original").raster, { width: 1000, height: 3000, scale: 2 });
  const bounded = boundedRaster({ width: 4000, height: 3000 }, 2);
  assert.ok(bounded.width <= 4096 && bounded.height <= 4096 && bounded.width * bounded.height <= 12 * 1024 * 1024);
});
test("A4 contact sheet contains three exact-size strips, explicit margins, and no full-page raster", () => {
  const geometry = exportGeometry({ width: 536, height: 1600 }, "a4-contact");
  assert.deepEqual([geometry.width, geometry.height], [210, 297]);
  assert.equal(geometry.placements.length, 3);
  for (const { tile } of geometry.placements) {
    assert.deepEqual([tile.width, tile.height], [50.8, 152.4]);
    assert.ok(tile.x >= 10 && tile.x + tile.width <= 200 && tile.y >= 10 && tile.y + tile.height <= 287);
  }
  assert.ok(geometry.raster.width < 600 && geometry.raster.height < 1800);
});
test("invalid geometry/fit/margins and oversized allocations fail before rendering", () => {
  for (const value of [0, -1, Infinity, NaN]) assert.throws(() => exportGeometry({ width: value, height: 200 }, "square"));
  assert.throws(() => fitRect({ width: 100, height: 100 }, { x: NaN, y: 0, width: 1, height: 1 }, "contain"));
  assert.throws(() => exportGeometry({ width: 100, height: 100 }, "print-strip", { marginMm: 11 }));
  assert.throws(() => exportGeometry({ width: 100, height: 100 }, "square", { fit: "stretch" as "contain" }));
});
test("effective resolution falls with crop zoom, accounts for rotation, and never gains detail from output upscaling", () => {
  const original = input(), geometry = exportGeometry(stripSize(original.layout), "print-strip");
  const before = sourceResolution(original, geometry);
  original.shots.A![0] = canvas(320, 240);
  const small = sourceResolution(original, geometry);
  original.cellEdits = { "0:A": { ...defaultCellEdit(0), zoom: 2, rotation: 90, mirror: true } };
  const cropped = sourceResolution(original, geometry);
  assert.ok(small.sources[0].effectivePpi! < before.sources[0].effectivePpi!);
  assert.ok(cropped.sources[0].effectivePpi! < small.sources[0].effectivePpi!);
  assert.ok(cropped.warnings.some(value => value.includes("below 300")));
  assert.equal(cropped.sources[0].sourceIndex, 0);
});
test("split portraits count sliced pixels; companion fallback and Together report exactly rendered sources", () => {
  const split = input("duo-split"), geometry = exportGeometry(stripSize(split.layout), "print-strip");
  const splitReport = sourceResolution(split, geometry);
  assert.equal(splitReport.sources.length, 8);
  assert.deepEqual(splitReport.sources.slice(0, 2).map(item => item.role), ["A", "B"]);
  const base = templateFixture();
  split.template = { ...base, requiredSources: { A: 1, B: 1 }, slots: [{ ...base.slots[0], companions: [{ role: "B", sourceIndex: 0, crop: base.slots[0].crop }], splitFallback: true }] };
  const customGeometry = exportGeometry(base.canvas, "print-strip");
  assert.equal(sourceResolution(split, customGeometry).sources.length, 2);
  split.together = { sceneId: "sunset", places: { A: { dx: 0, dy: 0, scale: 1.6 } } };
  split.cutouts = { A: [canvas(200, 400)], B: [canvas(200, 400)] };
  const together = sourceResolution(split, customGeometry);
  assert.ok(together.sources.every(item => item.kind === "cutout"));
  assert.ok(together.sources[0].effectivePpi! < together.sources[1].effectivePpi!);
  split.cutouts.B = [null];
  assert.ok(sourceResolution(split, customGeometry).sources.every(item => item.kind === "photo"));
  split.shots.B = [null];
  assert.ok(sourceResolution(split, customGeometry).warnings.some(item => item.includes("empty")));
});
test("horizontal source slicing reduces effective density in a wide template cell", () => {
  const current = input(), base = templateFixture();
  current.shots.A![0] = canvas(320, 240);
  current.template = { ...base, slots: [{ ...base.slots[0], width: .8, height: .1 }] };
  const geometry = exportGeometry(base.canvas, "print-strip");
  const full = sourceResolution(current, geometry).sources[0].effectivePpi!;
  current.template = { ...current.template, slots: [{ ...current.template.slots[0], sliceX: [.25, .75] }] };
  const sliced = sourceResolution(current, geometry).sources[0].effectivePpi!;
  assert.ok(Math.abs(sliced - full / 2) < 1e-9);
});

test("whole-pixel rounding does not claim a resource cap, but oversized cover crops do", () => {
  const current = input(), base = templateFixture();
  current.template = { ...base, canvas: { width: 536, height: 1522 } };
  const print = sourceResolution(current, exportGeometry(current.template.canvas, "a4-contact"));
  assert.ok(!print.warnings.some(warning => warning.includes("4096 pixels")));
  current.template = { ...base, canvas: { width: 120, height: 4000 } };
  const cover = sourceResolution(current, exportGeometry(current.template.canvas, "square", { fit: "cover" }));
  assert.ok(cover.warnings.some(warning => warning.includes("4096 pixels")));
});

test("wide strips turn 90 degrees to run down every print tile, while image profiles keep them level", () => {
  for (const layout of ["film4", "duo-film", "trio-row"]) {
    const size = stripSize(getLayout(layout));
    for (const profile of ["print-strip", "print-two-up", "a4-contact"] as const) {
      const geometry = exportGeometry(size, profile);
      for (const placement of geometry.placements) {
        const { draw, box } = placement;
        assert.equal(placement.rotated, true, `${layout} ${profile}`);
        assert.ok(Math.abs(draw.height / draw.width - size.width / size.height) < 1e-9, "rotated aspect");
        assert.ok(draw.width <= box.width + 1e-9 && draw.height <= box.height + 1e-9);
        assert.equal(placedWidth(placement), draw.height);
        assert.ok(draw.height > exportGeometry({ width: size.height, height: size.width }, profile).placements[0].draw.height - 1e-9);
      }
    }
    for (const profile of ["original", "story", "square", "wallpaper"] as const) assert.equal(exportGeometry(size, profile).placements[0].rotated, false);
  }
  for (const layout of ["strip4", "cut8", "grid6", "quad-split"]) assert.equal(exportGeometry(stripSize(getLayout(layout)), "print-strip").placements[0].rotated, false, layout);
  const film = exportGeometry(stripSize(getLayout("film4")), "print-strip");
  assert.deepEqual(film.raster, boundedRaster({ width: 2030, height: 828 }, film.placements[0].draw.height / 2030 * 300 / 25.4));
  assert.ok(film.raster.width > 1300, "the raster follows the long printed edge");
});

test("painting a rotated placement turns the strip clockwise inside its box", (t) => {
  installCanvasEnvironment(t);
  const geometry = exportGeometry(stripSize(getLayout("film4")), "print-strip"), page = new RecordingCanvas(), source = new RecordingCanvas();
  page.width = 600; page.height = 1800;
  paintExportGeometry(page.element, source.element, geometry);
  const { draw } = geometry.placements[0];
  assert.deepEqual(page.context.transforms.slice(1), [{ kind: "translate", values: [draw.x + draw.width / 2, draw.y + draw.height / 2] }, { kind: "rotate", values: [Math.PI / 2] }]);
  assert.deepEqual(page.context.draws[0].coordinates, [-draw.height / 2, -draw.width / 2, draw.height, draw.width]);
});

test("feature and eight-photo strips report the resolution of every cell", () => {
  const eight = { ...input("cut8"), shots: { A: Array.from({ length: 8 }, () => canvas(1600, 1200)) } };
  const report = sourceResolution(eight, exportGeometry(stripSize(getLayout("cut8")), "print-strip"));
  assert.equal(report.sources.length, 8);
  assert.deepEqual(report.sources.map(item => item.sourceIndex), [0, 1, 2, 3, 4, 5, 6, 7]);
  const feature = sourceResolution(input("feature4"), exportGeometry(stripSize(getLayout("feature4")), "original"));
  assert.ok(feature.sources[0].pixelsPerOutputPixel! < feature.sources[1].pixelsPerOutputPixel!, "the wide feature cell spends more output pixels per source pixel");
});

test("photo loops cycle through every photo of an Eight-cut", async (t) => {
  const { canvases } = installCanvasEnvironment(t);
  const eight = { ...input("cut8"), shots: { A: Array.from({ length: 8 }, () => immutableSource(1200, 800)) } };
  const frames = await createPhotoLoopFrames(eight);
  assert.equal(frames.length, 8);
  assert.equal(canvases[0].encodes.length, 8);
  await assert.rejects(createPhotoLoopFrames({ ...eight, shots: { A: [immutableSource(1200, 800)] } }), /two to eight photos/);
});
