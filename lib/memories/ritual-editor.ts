import { computeRitualProof, validateRitualEdit, type RitualDefinition, type RitualEdit, type RitualRow } from "./ritual-contract";
import { nextRitualOccurrence, type RitualOccurrence } from "./ritual-schedule";

export interface RitualFields {
  title: string; date: string; time: string; zone: string; frequency: RitualDefinition["frequency"];
  interval: string; invalidDate: RitualDefinition["invalidDate"]; gap: RitualDefinition["gap"]; fold: RitualDefinition["fold"];
}
export function ritualCivil(instant: string, zone: string) {
  const parts = new Intl.DateTimeFormat("en-AU", { timeZone: zone, calendar: "iso8601", numberingSystem: "latn", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(instant));
  const part = (name: string) => parts.find(value => value.type === name)?.value;
  return { date: `${part("year")}-${part("month")}-${part("day")}`, time: `${part("hour")}:${part("minute")}` };
}
export function ritualFields(row?: RitualRow, now = new Date().toISOString()): RitualFields {
  const schedule = row?.schedule, zone = schedule?.timeZone ?? "Australia/Sydney";
  const civil = ritualCivil(row?.scheduledAt ?? new Date(Date.parse(now) + 86_400_000).toISOString(), zone);
  return { title: row?.title ?? "", date: schedule?.anchorDate ?? civil.date, time: schedule?.localTime ?? (row ? civil.time : "19:00"), zone, frequency: row?.cadence ?? "weekly", interval: String(schedule?.interval ?? 1), invalidDate: schedule?.invalidDate ?? "clamp", gap: schedule?.gap ?? "shift-forward", fold: schedule?.fold ?? "later" };
}
export interface RitualReview { input: RitualEdit; occurrence: RitualOccurrence; adjustments: RitualOccurrence["adjustments"] }
export function reviewRitual(fields: RitualFields, now: string, legacy?: RitualRow): RitualReview {
  const interval = fields.frequency === "once" ? 1 : Number(fields.interval);
  const base = { version: 1 as const, anchorDate: fields.date, localTime: fields.time, timeZone: fields.zone.trim(), interval, invalidDate: fields.invalidDate, gap: fields.gap, fold: fields.fold };
  let schedule: RitualDefinition, adjustments: RitualOccurrence["adjustments"] = [];
  if (fields.frequency === "once") {
    // A one-off is resolved from its own date, never advanced into another year.
    const resolved = nextRitualOccurrence({ ...base, frequency: "yearly", paused: false }, new Date(Date.parse(`${fields.date}T00:00:00Z`) - 172_800_000).toISOString());
    if (!resolved || resolved.cycle !== 0) throw new Error("That local time does not occur. Choose another time or allow the daylight-saving adjustment.");
    let onceAt = resolved.instant;
    const existingInstant = legacy?.legacy && legacy.cadence === "once" ? legacy.scheduledAt : legacy?.schedule?.frequency === "once" && legacy.schedule.timeZone === base.timeZone && legacy.schedule.fold === fields.fold && legacy.schedule.gap === fields.gap ? legacy.schedule.onceAt : null;
    if (existingInstant) {
      const original = ritualCivil(existingInstant, base.timeZone);
      if (original.date === fields.date && original.time === fields.time) onceAt = existingInstant;
    }
    const actual = ritualCivil(onceAt, base.timeZone);
    schedule = { ...base, anchorDate: actual.date, localTime: actual.time, frequency: "once", onceAt };
    adjustments = onceAt === resolved.instant ? resolved.adjustments : [];
  } else schedule = { ...base, frequency: fields.frequency, onceAt: null };
  const input = validateRitualEdit({ title: fields.title.trim(), schedule });
  const occurrence = computeRitualProof(input.schedule, now).occurrence;
  if (!occurrence) throw new Error("Choose a future date and time. This schedule has no upcoming occurrence.");
  return { input, occurrence, adjustments: [...new Set([...adjustments, ...occurrence.adjustments])] };
}
export function ritualInstant(instant: string, zone: string): string {
  return new Intl.DateTimeFormat("en-AU", { timeZone: zone, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short" }).format(new Date(instant));
}
export function ritualError(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? error.code : "";
  if (code === "account_changed" || code === "access_denied") return "This account can no longer manage these reminders. Return to your album and check your pairing.";
  if (code === "unavailable") return "Rituals could not be loaded or confirmed here at the moment. Refresh before making another change.";
  if (code === "capacity") return "This pair already has 20 reminders. Delete one you no longer need before adding another.";
  if (code === "conflict" || code === "schedule_changed") return "This reminder changed. Refresh and review its current schedule before trying again.";
  if (code === "no_future_occurrence") return "This schedule has no future occurrence. Choose a later date or edit the repeat settings.";
  if (code === "invalid_request") return "Check the title, date, time and timezone before trying again.";
  if (code === "rate_limited") return "Too many requests. Wait a minute, then refresh and try again.";
  return "The response could not be confirmed. Your change may have arrived. Refresh before another action; retry a new ritual with the same reviewed request.";
}
