import assert from "node:assert/strict";
import test from "node:test";
import { prepareEventMissionEdit } from "../lib/events/mission-edit";
const current = { version: 1 as const, eventId: "11111111-1111-4111-8111-111111111111", revision: 7, missionIds: [], endsAt: "2026-09-23T10:00:00.000Z", locked: false };
const window = { startsAt: "2026-09-23T00:00:00.000Z", closesAt: current.endsAt };
test("mission edit captures revision and copies selection without extending fixed event window", () => {
  const ids = ["same-energy-1"], request = prepareEventMissionEdit(current, ids, current.endsAt, window); ids.push("same-energy-2"); assert.deepEqual(request.missionIds, ["same-energy-1"]); assert.equal(request.expectedRevision, 7); assert.equal(request.endsAt, current.endsAt);
  for (const end of ["invalid", window.startsAt, "2026-09-23T10:00:00.001Z"]) assert.throws(() => prepareEventMissionEdit(current, [], end, window));
  assert.deepEqual(prepareEventMissionEdit(current, [], current.endsAt, window).missionIds, []);
});
test("accepted contribution lock and invented or repeated poses refuse a new edit", () => {
  assert.throws(() => prepareEventMissionEdit({ ...current, locked: true }, [], current.endsAt, window));
  assert.throws(() => prepareEventMissionEdit(current, ["invented"], current.endsAt, window));
  assert.throws(() => prepareEventMissionEdit(current, ["same-energy-1", "same-energy-1"], current.endsAt, window));
});
