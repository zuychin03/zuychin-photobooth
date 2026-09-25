import assert from "node:assert/strict";
import test from "node:test";
import { nextRitualOccurrence, validateRitualSchedule, type RitualSchedule } from "../lib/memories/ritual-schedule";

const schedule = (patch: Partial<RitualSchedule> = {}): RitualSchedule => ({ version: 1, anchorDate: "2026-01-01", localTime: "09:00", timeZone: "Australia/Sydney", frequency: "daily", interval: 1, paused: false, invalidDate: "clamp", gap: "shift-forward", fold: "later", ...patch });
const next = (patch: Partial<RitualSchedule>, after: string) => nextRitualOccurrence(schedule(patch), after)!;

test("schedules require explicit versioned timezone and calendar policies", () => {
  const value = validateRitualSchedule(schedule()); assert(Object.isFrozen(value));
  for (const patch of [{ version: 2 }, { anchorDate: "2026-02-30" }, { anchorDate: "1969-12-31" }, { anchorDate: "2200-01-01" }, { localTime: "24:00" }, { timeZone: "+10:00" }, { timeZone: "Mars/Olympus" }, { interval: 0 }, { interval: 13 }, { gap: "guess" }, { fold: null }, { extra: true }]) assert.throws(() => validateRitualSchedule({ ...schedule(), ...patch }));
  let read = false; assert.throws(() => validateRitualSchedule({ ...schedule(), get paused() { read = true; return false; } })); assert.equal(read, false);
});
test("Sydney spring gap shifts by its actual gap or explicitly skips the day", () => {
  const rule = { anchorDate: "2026-10-04", localTime: "02:30" }, result = next(rule, "2026-10-03T00:00:00Z");
  assert.equal(result.instant, "2026-10-03T16:30:00.000Z"); assert.equal(result.localTime, "03:30"); assert.deepEqual(result.adjustments, ["gap-shift"]);
  const skipped = next({ ...rule, gap: "skip" }, "2026-10-03T00:00:00Z"); assert.equal(skipped.localDate, "2026-10-05"); assert.equal(skipped.localTime, "02:30");
});
test("Sydney autumn fold chooses one explicit instant and never sends the other copy", () => {
  const rule = { anchorDate: "2026-04-05", localTime: "02:30" };
  const earlier = next({ ...rule, fold: "earlier" }, "2026-04-04T00:00:00Z"), later = next(rule, "2026-04-04T00:00:00Z");
  assert.equal(earlier.instant, "2026-04-04T15:30:00.000Z"); assert.equal(later.instant, "2026-04-04T16:30:00.000Z");
  assert.deepEqual(earlier.adjustments, ["fold-earlier"]); assert.deepEqual(later.adjustments, ["fold-later"]);
  assert.equal(next({ ...rule, fold: "earlier" }, earlier.instant).localDate, "2026-04-06");
  assert.equal(next(rule, "2026-04-04T16:00:00Z").instant, later.instant);
});
test("Lord Howe handles thirty-minute transitions rather than assuming one hour", () => {
  const gap = next({ anchorDate: "2026-10-04", localTime: "02:15", timeZone: "Australia/Lord_Howe" }, "2026-10-03T00:00:00Z");
  assert.equal(gap.instant, "2026-10-03T15:45:00.000Z"); assert.equal(gap.localTime, "02:45");
  const rule = { anchorDate: "2026-04-05", localTime: "01:45", timeZone: "Australia/Lord_Howe" };
  assert.equal(next({ ...rule, fold: "earlier" }, "2026-04-04T00:00:00Z").instant, "2026-04-04T14:45:00.000Z");
  assert.equal(next(rule, "2026-04-04T00:00:00Z").instant, "2026-04-04T15:15:00.000Z");
});
test("foreign zones preserve their own transitions and non-hour offsets", () => {
  assert.equal(next({ anchorDate: "2026-03-08", localTime: "02:30", timeZone: "America/New_York" }, "2026-03-08T00:00:00Z").instant, "2026-03-08T07:30:00.000Z");
  assert.equal(next({ anchorDate: "2026-11-01", localTime: "01:30", timeZone: "America/New_York" }, "2026-11-01T00:00:00Z").instant, "2026-11-01T06:30:00.000Z");
  assert.equal(next({ timeZone: "Asia/Kathmandu" }, "2026-01-01T00:00:00Z").instant, "2026-01-01T03:15:00.000Z");
  assert.equal(next({ timeZone: "Pacific/Chatham" }, "2025-12-31T00:00:00Z").instant, "2025-12-31T19:15:00.000Z");
});
test("month-end clamping retains the original anchor instead of drifting from February", () => {
  const rule = { anchorDate: "2024-01-31", frequency: "monthly" as const, timeZone: "UTC" };
  const february = next(rule, "2024-01-31T09:00:00Z"), march = next(rule, february.instant);
  assert.equal(february.localDate, "2024-02-29"); assert.deepEqual(february.adjustments, ["date-clamp"]);
  assert.equal(march.localDate, "2024-03-31"); assert.deepEqual(march.adjustments, []);
  assert.equal(next({ ...rule, invalidDate: "skip" }, "2024-01-31T09:00:00Z").localDate, "2024-03-31");
});
test("yearly leap-day policy returns to February 29 and respects the non-leap century", () => {
  const rule = { anchorDate: "2024-02-29", frequency: "yearly" as const, timeZone: "UTC" };
  assert.equal(next(rule, "2024-02-29T09:00:00Z").localDate, "2025-02-28");
  assert.equal(next(rule, "2027-02-28T09:00:00Z").localDate, "2028-02-29");
  assert.equal(next({ ...rule, invalidDate: "skip" }, "2024-02-29T09:00:00Z").localDate, "2028-02-29");
  assert.equal(next({ ...rule, anchorDate: "2096-02-29", invalidDate: "skip", interval: 4 }, "2096-02-29T09:00:00Z").localDate, "2104-02-29");
});
test("intervals use the anchor, paused schedules return none, and resume never backfills old reminders", () => {
  const rule = { anchorDate: "2026-01-31", frequency: "weekly" as const, interval: 2, timeZone: "UTC" };
  assert.equal(next(rule, "2026-02-01T00:00:00Z").localDate, "2026-02-14");
  assert.equal(nextRitualOccurrence(schedule({ ...rule, paused: true }), "2026-02-01T00:00:00Z"), null);
  assert.equal(next(rule, "2026-06-01T00:00:00Z").localDate, "2026-06-06");
  assert.equal(nextRitualOccurrence(schedule(), "2200-01-01T00:00:00Z"), null);
  assert.throws(() => nextRitualOccurrence(schedule(), "2026-01-01"));
  assert.throws(() => nextRitualOccurrence(schedule(), "2026-02-30T00:00:00Z"));
});
test("a skipped civil day shifts once without duplicate exact instants", () => {
  const rule = { anchorDate: "2011-12-30", timeZone: "Pacific/Apia" }, shifted = next(rule, "2011-12-29T00:00:00Z");
  assert.equal(shifted.scheduledDate, "2011-12-30"); assert.equal(shifted.localDate, "2011-12-31"); assert.deepEqual(shifted.adjustments, ["gap-shift"]);
  assert.equal(next(rule, shifted.instant).localDate, "2012-01-01");
});
test("results do not depend on process timezone or mutate the schedule", () => {
  const original = process.env.TZ, rule = schedule({ anchorDate: "2026-10-04", localTime: "02:30" }), before = JSON.stringify(rule);
  try {
    process.env.TZ = "America/Los_Angeles"; const a = nextRitualOccurrence(rule, "2026-10-03T00:00:00Z");
    process.env.TZ = "Asia/Tokyo"; const b = nextRitualOccurrence(rule, "2026-10-03T00:00:00Z");
    assert.deepEqual(a, b); assert.equal(JSON.stringify(rule), before); assert(Object.isFrozen(a)); assert(Object.isFrozen(a!.adjustments));
  } finally { if (original === undefined) delete process.env.TZ; else process.env.TZ = original; }
});
