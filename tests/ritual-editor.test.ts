import assert from "node:assert/strict";
import test from "node:test";
import { reviewRitual, ritualCivil, ritualFields } from "../lib/memories/ritual-editor";
import type { RitualRow } from "../lib/memories/ritual-contract";

const fields = () => ({ ...ritualFields(undefined, "2026-01-01T00:00:00Z"), title: "Our photo", date: "2026-01-31", time: "19:00", frequency: "monthly" as const });
test("ritual review keeps the fixed month-end anchor and reveals clamp", () => {
  const review = reviewRitual(fields(), "2026-02-01T00:00:00Z");
  assert.equal(review.input.schedule.anchorDate, "2026-01-31");
  assert.equal(review.occurrence.localDate, "2026-02-28");
  assert.deepEqual(review.adjustments, ["date-clamp"]);
  assert.equal(review.occurrence.instant, "2026-02-28T08:00:00.000Z");
});
test("one-off gap preview makes the actual local time explicit and rejects skip", () => {
  const draft = { ...fields(), frequency: "once" as const, date: "2026-10-04", time: "02:30" };
  const review = reviewRitual(draft, "2026-09-01T00:00:00Z");
  assert.equal(review.input.schedule.localTime, "03:30");
  assert.deepEqual(review.adjustments, ["gap-shift"]);
  assert.throws(() => reviewRitual({ ...draft, gap: "skip" }, "2026-09-01T00:00:00Z"));
});
test("one-off fold policy selects an instant and cannot recur into another year", () => {
  const draft = { ...fields(), frequency: "once" as const, date: "2026-04-05", time: "02:30" };
  const later = reviewRitual(draft, "2026-04-01T00:00:00Z"), earlier = reviewRitual({ ...draft, fold: "earlier" }, "2026-04-01T00:00:00Z");
  assert.equal(Date.parse(later.occurrence.instant) - Date.parse(earlier.occurrence.instant), 3_600_000);
  assert.throws(() => reviewRitual(draft, "2026-04-06T00:00:00Z"), /future/);
});
test("legacy one-off upgrade preserves an unchanged exact instant including seconds and earlier fold", () => {
  const row = { title: "Legacy", legacy: true, scheduledAt: "2026-04-04T15:30:17.000Z", cadence: "once", schedule: null } as RitualRow;
  const draft = ritualFields(row);
  assert.equal(draft.time, "02:30");
  const review = reviewRitual(draft, "2026-04-01T00:00:00Z", row);
  assert.equal(review.input.schedule.onceAt, row.scheduledAt);
  assert.deepEqual(review.adjustments, []);
  assert.deepEqual(ritualCivil(row.scheduledAt, "Australia/Sydney"), { date: "2026-04-05", time: "02:30" });
});
test("title-only edits preserve an upgraded one-off's earlier fold and sub-minute precision", () => {
  const original = { title: "Legacy", legacy: true, scheduledAt: "2027-04-03T15:30:23.456Z", cadence: "once", schedule: null } as RitualRow;
  const upgraded = reviewRitual(ritualFields(original), "2027-04-01T00:00:00Z", original);
  const row = { ...original, legacy: false, schedule: upgraded.input.schedule };
  const edited = reviewRitual({ ...ritualFields(row), title: "New title" }, "2027-04-01T00:00:00Z", row);
  assert.equal(edited.input.schedule.onceAt, original.scheduledAt);
  const changed = reviewRitual({ ...ritualFields(row), time: "04:00" }, "2027-04-01T00:00:00Z", row);
  assert.notEqual(changed.input.schedule.onceAt, original.scheduledAt);
});
test("preview rejects invalid civil dates, unsupported zones, intervals and title size", () => {
  for (const bad of [{ date: "2026-02-30" }, { zone: "Mars/Sydney" }, { interval: "0" }, { interval: "13" }, { title: " " }, { title: "a".repeat(101) }]) assert.throws(() => reviewRitual({ ...fields(), ...bad }, "2026-01-01T00:00:00Z"));
});
