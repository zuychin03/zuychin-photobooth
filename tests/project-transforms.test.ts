import assert from "node:assert/strict";
import test from "node:test";
import { defaultCellEdit, photoPlacement, validateCellEdit } from "../lib/projects/transforms";
import { composeStrip, stripToBlob, type ComposeInput } from "../lib/compose";
import { getLayout } from "../lib/layouts";
import { installCanvasEnvironment, immutableSource, RecordingCanvas } from "./helpers/recording-canvas";

test("crop extremes stay within the photo for portrait, landscape and quarter-turn rotation", () => {
  for (const [width, height] of [[600, 1200], [1600, 900], [900, 900]]) {
    for (const rotation of [0, 90, 180, 270] as const) {
      for (const zoom of [1, 2, 4]) {
        const place = photoPlacement(width, height, 480, 320, { ...defaultCellEdit(0), zoom, rotation, offsetX: 1, offsetY: -1 });
        const rotatedWidth = (rotation % 180 ? height : width) * place.scale;
        const rotatedHeight = (rotation % 180 ? width : height) * place.scale;
        assert(Math.abs(place.translateX) <= (rotatedWidth - 480) / 2 + 1e-8);
        assert(Math.abs(place.translateY) <= (rotatedHeight - 320) / 2 + 1e-8);
        assert(rotatedWidth >= 480 - 1e-8 && rotatedHeight >= 320 - 1e-8);
      }
    }
  }
});

test("malformed crop controls never reach drawing", () => {
  for (const change of [{ zoom: 0.5 }, { zoom: Infinity }, { offsetX: 2 }, { rotation: 45 }, { sourceIndex: 4 }, { sourceIndex: 0.5 }, { filterId: "url(https://example.invalid)" }, { mirror: "true" }]) {
    assert.throws(() => validateCellEdit({ ...defaultCellEdit(0), ...change }));
  }
  assert.throws(() => validateCellEdit({ ...defaultCellEdit(0), url: "https://example.invalid" }));
});

function input(): ComposeInput {
  return { layout: getLayout("strip4"), shots: { A: [immutableSource(1200, 800), immutableSource(800, 1200)] },
    style: { frameColor: "#fff", inkColor: "#000", patternId: "none", filterId: "none", caption: "Fixed date", showDate: true, stickerStyle: "flat" }, stickers: [],
    capturedAt: "2026-09-21T14:30:00.000Z", captureTimeZone: "Australia/Sydney",
    cellEdits: { "0:A": { ...defaultCellEdit(1), zoom: 2, rotation: 90, mirror: true, filterId: "bw" } } };
}

test("preview and export use identical photo edits and the saved capture timezone", async t => {
  const env = installCanvasEnvironment(t); const value = input(); const canvas = new RecordingCanvas();
  composeStrip(canvas.element, value); await stripToBlob(value);
  const exported = env.canvases.find(item => item.encodes.length)!;
  assert.equal(canvas.context.draws[0].source, value.shots.A![1]);
  assert.match(canvas.context.draws[0].filter!, /grayscale/);
  assert.equal(canvas.context.draws[1].filter, "none");
  assert.deepEqual(exported.context.draws, canvas.context.draws);
  assert.deepEqual(exported.context.texts, canvas.context.texts);
  assert.equal(canvas.context.texts.at(-1)?.text, "22·09·2026");
  assert.equal(canvas.context.texts.at(-1)?.filter, "none");
  assert.deepEqual([value.shots.A![1]!.width, value.shots.A![1]!.height], [800, 1200]);
});
