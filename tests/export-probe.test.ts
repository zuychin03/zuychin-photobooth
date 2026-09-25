import assert from "node:assert/strict";
import test from "node:test";
import { flatStripProbeSamples } from "../lib/feasibility/export-probe";
import { exportGeometry } from "../lib/exports/geometry";
import { getLayout, stripSize } from "../lib/layouts";

const colours = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]];
test("native parity fixture samples photo interiors and contain margins across all profiles/fits", () => {
  const size = stripSize(getLayout("strip4"));
  for (const profile of ["original", "story", "square", "wallpaper"] as const) for (const fit of ["contain", "cover"] as const) {
    const points = flatStripProbeSamples(exportGeometry(size, profile, { fit }), colours);
    assert.ok(points.length >= 6, `${profile}/${fit}`);
    assert.ok(points.some(point => point.expected.some(value => value === 0)), `${profile}/${fit} needs photo samples`);
    if (fit === "contain") assert.ok(points.some(point => point.expected.every(value => value === 255)), `${profile} needs margin samples`);
  }
  const fit = flatStripProbeSamples(exportGeometry(size, "story", { fit: "contain" }), colours);
  assert.deepEqual(fit.find(point => point.x === .03 && point.y === .03)?.expected, [255, 255, 255]);
  const crop = flatStripProbeSamples(exportGeometry(size, "square", { fit: "cover" }), colours);
  assert.deepEqual(crop.find(point => point.x === .5 && point.y === .03)?.expected, colours[1]);
  assert.deepEqual(crop.find(point => point.x === .5 && point.y === .9)?.expected, colours[2]);
});
