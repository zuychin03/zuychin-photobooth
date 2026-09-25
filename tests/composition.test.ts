import assert from "node:assert/strict";
import { test } from "node:test";
import { composeStrip, stripToBlob, type ComposeInput, type ShotSet } from "../lib/compose";
import { getFilter } from "../lib/filters";
import { getLayout, LAYOUTS, layoutsForMembers, type Role, stripSize } from "../lib/layouts";
import { immutableSource, installCanvasEnvironment, RecordingCanvas } from "./helpers/recording-canvas";

function inputFor(layoutId = "strip4", shots: ShotSet = {}): ComposeInput {
  return {
    layout: getLayout(layoutId),
    shots,
    style: {
      frameColor: "#ffffff",
      inkColor: "#000000",
      patternId: "none",
      filterId: "none",
      caption: "",
      showDate: false,
      stickerStyle: "flat",
    },
    stickers: [],
  };
}

const layoutFixtures = [
  { id: "strip4", size: [536, 1522], cells: ["A0", "A1", "A2", "A3"] },
  { id: "grid4", size: [1034, 926], cells: ["A0", "A1", "A2", "A3"] },
  { id: "strip3", size: [536, 1304], cells: ["A0", "A1", "A2"] },
  { id: "duo-alternate", size: [536, 1522], cells: ["A0", "B1", "A2", "B3"] },
  { id: "duo-split", size: [536, 1522], cells: ["A0", "B0", "A1", "B1", "A2", "B2", "A3", "B3"] },
  { id: "duo-twin", size: [1034, 1522], cells: ["A0", "B0", "A1", "B1", "A2", "B2", "A3", "B3"] },
  { id: "trio", size: [1532, 1522], cells: ["A0", "B0", "C0", "A1", "B1", "C1", "A2", "B2", "C2", "A3", "B3", "C3"] },
  { id: "quad-story", size: [2030, 1522], cells: ["A0", "B0", "C0", "D0", "A1", "B1", "C1", "D1", "A2", "B2", "C2", "D2", "A3", "B3", "C3", "D3"] },
  { id: "quad", size: [2030, 1184], cells: ["A0", "B0", "C0", "D0", "A1", "B1", "C1", "D1", "A2", "B2", "C2", "D2"] },
];

const expectedCells: Record<string, { xs: number[]; ys: number[]; height: number }> = {
  strip4: { xs: [28], ys: [28, 366, 704, 1042], height: 320 },
  grid4: { xs: [28, 526], ys: [28, 406], height: 360 },
  strip3: { xs: [28], ys: [28, 406, 784], height: 360 },
  "duo-alternate": { xs: [28], ys: [28, 366, 704, 1042], height: 320 },
  "duo-split": { xs: [28], ys: [28, 366, 704, 1042], height: 320 },
  "duo-twin": { xs: [28, 526], ys: [28, 366, 704, 1042], height: 320 },
  trio: { xs: [28, 526, 1024], ys: [28, 366, 704, 1042], height: 320 },
  "quad-story": { xs: [28, 526, 1024, 1522], ys: [28, 366, 704, 1042], height: 320 },
  quad: { xs: [28, 526, 1024, 1522], ys: [28, 366, 704], height: 320 },
};

for (const fixture of layoutFixtures) {
  test(`${fixture.id}: strip dimensions and participant shot ownership remain intact`, (t) => {
    installCanvasEnvironment(t);
    const shots: ShotSet = {};
    const sourceNames = new Map<unknown, string>();
    for (const role of ["A", "B", "C", "D"] as Role[]) {
      shots[role] = Array.from({ length: 4 }, (_, index) => {
        const source = immutableSource(1200, 800);
        sourceNames.set(source, `${role}${index}`);
        return source;
      });
    }
    const target = new RecordingCanvas();
    const input = inputFor(fixture.id, shots);
    composeStrip(target.element, input);

    assert.deepEqual([target.width, target.height], fixture.size);
    assert.deepEqual(Object.values(stripSize(input.layout)), fixture.size);
    assert.deepEqual(target.context.draws.map((draw) => sourceNames.get(draw.source)), fixture.cells);
    const cells = expectedCells[fixture.id];
    const expectedClips = cells.ys.flatMap((y) => cells.xs.flatMap((x) => {
      const rect = [x, y, 480, cells.height];
      return fixture.id === "duo-split" ? [rect, rect] : [rect];
    }));
    assert.deepEqual(target.context.draws.map((draw) => draw.clip), expectedClips);
    for (const draw of target.context.draws) {
      const [x, y, width, height] = draw.coordinates.slice(-4);
      const [clipX, clipY, clipWidth, clipHeight] = draw.clip!;
      assert(x >= clipX && y >= clipY);
      assert(x + width <= clipX + clipWidth && y + height <= clipY + clipHeight);
      assert(x >= 28 && x + width <= target.width - 28);
      assert(y >= 28 && y + height <= target.height - 160);
    }
    assert.equal(target.context.savedStateCount, 0);
  });
}

test("shared rooms offer layouts for two, three and four participants", () => {
  assert.equal(LAYOUTS.length, 9);
  assert.deepEqual(layoutsForMembers(2).map((layout) => layout.id), ["duo-alternate", "duo-split", "duo-twin"]);
  assert.deepEqual(layoutsForMembers(3).map((layout) => layout.id), ["trio"]);
  assert.deepEqual(layoutsForMembers(4).map((layout) => layout.id), ["trio", "quad", "quad-story"]);
});

test("cover fitting crops wide and tall originals centrally without stretching", (t) => {
  installCanvasEnvironment(t);
  const landscape = immutableSource(1600, 900);
  const portrait = immutableSource(600, 1200);
  const target = new RecordingCanvas();
  composeStrip(target.element, inputFor("strip4", { A: [landscape, portrait] }));

  assert.deepEqual(target.context.draws[0].coordinates, [125, 0, 1350, 900, 28, 28, 480, 320]);
  assert.deepEqual(target.context.draws[1].coordinates, [0, 400, 600, 400, 28, 366, 480, 320]);
  assert.deepEqual([landscape.width, landscape.height, portrait.width, portrait.height], [1600, 900, 600, 1200]);
});

test("split cells take a centred portrait crop from each participant into separate halves", (t) => {
  installCanvasEnvironment(t);
  const target = new RecordingCanvas();
  composeStrip(target.element, inputFor("duo-split", {
    A: [immutableSource(1600, 900)],
    B: [immutableSource(1600, 900)],
  }));

  assert.deepEqual(target.context.draws.map((draw) => draw.coordinates), [
    [462.5, 0, 675, 900, 28, 28, 240, 320],
    [462.5, 0, 675, 900, 268, 28, 240, 320],
  ]);
  assert.deepEqual(target.context.draws.map((draw) => draw.clip), [[28, 28, 480, 320], [28, 28, 480, 320]]);
});

for (const supportsFilter of [true, false]) {
  test(`output filters preserve originals and spare the caption (canvas filters ${supportsFilter ? "supported" : "unavailable"})`, (t) => {
    installCanvasEnvironment(t, { supportsFilter });
    const source = immutableSource(1200, 800);
    const input = inputFor("strip4", { A: [source] });
    input.style.filterId = "bw";
    input.style.caption = "Our photo";
    Object.freeze(input.style);
    Object.freeze(input.shots.A);
    const target = new RecordingCanvas({ supportsFilter });
    composeStrip(target.element, input);

    assert.equal(target.context.draws[0].source, source);
    assert.equal(target.context.draws[0].filter, supportsFilter ? getFilter("bw").css : undefined);
    assert.equal(target.context.texts.at(-1)?.text, "Our photo");
    assert.equal(target.context.texts.at(-1)?.filter, supportsFilter ? "none" : undefined);
    assert.equal(target.context.fills[0].filter, supportsFilter ? "none" : undefined);
    assert.deepEqual([source.width, source.height], [1200, 800]);
  });
}

test("Together falls back to original photos when cutouts or a known scene are missing", (t) => {
  installCanvasEnvironment(t);
  const source = immutableSource(1200, 800);
  for (const sceneId of ["studio-cream", "unknown-scene"]) {
    const input = inputFor("strip4", { A: [source] });
    input.together = { sceneId, places: {} };
    if (sceneId === "unknown-scene") input.cutouts = { A: [immutableSource(600, 800)] };
    const target = new RecordingCanvas();
    composeStrip(target.element, input);
    assert.equal(target.context.draws.length, 1);
    assert.equal(target.context.draws[0].source, source);
    assert.deepEqual(target.context.draws[0].coordinates, [0, 0, 1200, 800, 28, 28, 480, 320]);
  }
});

test("Together uses both cutouts in the shared cell without modifying raw shots", (t) => {
  installCanvasEnvironment(t);
  const cutA = immutableSource(600, 800);
  const cutB = immutableSource(600, 800);
  const input = inputFor("duo-split", {
    A: [immutableSource(1200, 800)],
    B: [immutableSource(1200, 800)],
  });
  input.together = { sceneId: "studio-cream", places: {} };
  input.cutouts = { A: [cutA], B: [cutB] };
  const target = new RecordingCanvas();
  composeStrip(target.element, input);

  assert.deepEqual(target.context.draws.map((draw) => draw.source), [cutA, cutB]);
  const [left, right] = target.context.draws;
  assert(left.coordinates[0] < right.coordinates[0]);
  assert.deepEqual(left.clip, [28, 28, 480, 320]);
  assert.deepEqual(right.clip, left.clip);
  for (const draw of [left, right]) {
    const [, top, width, height] = draw.coordinates;
    assert(Math.abs(width / height - 0.75) < 1e-10);
    assert(Math.abs(top + height - 348) < 1e-10);
  }
});

test("Together falls back independently for later shots with no cutouts", (t) => {
  installCanvasEnvironment(t);
  const cutout = immutableSource(600, 800);
  const originals = [immutableSource(1200, 800), immutableSource(1200, 800)];
  const input = inputFor("strip4", { A: originals });
  input.together = { sceneId: "studio-cream", places: {} };
  input.cutouts = { A: [cutout, null] };
  const target = new RecordingCanvas();
  composeStrip(target.element, input);

  assert.deepEqual(target.context.draws.map((draw) => draw.source), [cutout, originals[1]]);
  assert.deepEqual(target.context.draws[1].coordinates, [0, 0, 1200, 800, 28, 366, 480, 320]);
  assert.deepEqual(target.context.texts.map((entry) => entry.text), ["…", "…"]);
});

test("missing frames remain explicit placeholders instead of copying another shot", (t) => {
  installCanvasEnvironment(t);
  const target = new RecordingCanvas();
  composeStrip(target.element, inputFor());
  assert.equal(target.context.draws.length, 0);
  assert.deepEqual(target.context.texts.map((entry) => entry.text), ["…", "…", "…", "…"]);
});

for (const fixture of layoutFixtures) {
  test(`${fixture.id}: PNG export doubles resolution while preserving preview geometry`, async (t) => {
    const env = installCanvasEnvironment(t);
    const input = inputFor(fixture.id, { A: [immutableSource(1600, 900)] });
    const preview = new RecordingCanvas();
    composeStrip(preview.element, input);
    const blob = await stripToBlob(input);
    const exported = env.canvases.find((canvas) => canvas.encodes.length > 0)!;

    assert.equal(blob.type, "image/png");
    assert.deepEqual([exported.width, exported.height], fixture.size.map((dimension) => dimension * 2));
    assert.deepEqual(exported.context.draws, preview.context.draws);
    assert.deepEqual(exported.context.transforms[0], { kind: "scale", values: [2, 2] });
    assert.deepEqual(exported.encodes, [{ type: "image/png", quality: undefined }]);
  });
}

test("PNG export failure rejects without claiming a downloadable file", async (t) => {
  installCanvasEnvironment(t, { blobResult: null });
  await assert.rejects(stripToBlob(inputFor()), /export failed/);
});
