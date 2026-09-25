export interface RitualSchedule {
  version: 1;
  anchorDate: string;
  localTime: string;
  timeZone: string;
  frequency: "daily" | "weekly" | "monthly" | "yearly";
  interval: number;
  paused: boolean;
  invalidDate: "clamp" | "skip";
  gap: "shift-forward" | "skip";
  fold: "earlier" | "later";
}
export interface RitualOccurrence {
  cycle: number;
  scheduledDate: string;
  localDate: string;
  localTime: string;
  instant: string;
  adjustments: readonly ("date-clamp" | "gap-shift" | "fold-earlier" | "fold-later")[];
}
export const RITUAL_SCHEDULE_LIMITS = Object.freeze({ firstYear: 1970, lastYear: 2199, interval: 12, searchCycles: 64, offsetWindowHours: 48 });
type Civil = { year: number; month: number; day: number; hour: number; minute: number; second: number };
const dayMs = 86_400_000;
const bad = (): never => { throw new Error("Invalid ritual schedule; choose an explicit date, time and IANA timezone"); };
const two = (value: number) => String(value).padStart(2, "0");
const dateLabel = (value: Pick<Civil, "year" | "month" | "day">) => `${String(value.year).padStart(4, "0")}-${two(value.month)}-${two(value.day)}`;
const civilMs = (value: Civil) => Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute, value.second);
function calendarDate(value: unknown): Pick<Civil, "year" | "month" | "day"> {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return bad();
  const [year, month, day] = value.split("-").map(Number), parsed = new Date(Date.UTC(year, month - 1, day));
  if (year < RITUAL_SCHEDULE_LIMITS.firstYear || year > RITUAL_SCHEDULE_LIMITS.lastYear || parsed.toISOString().slice(0, 10) !== value) return bad();
  return { year, month, day };
}
function formatter(timeZone: string) {
  return new Intl.DateTimeFormat("en-GB-u-ca-iso8601-nu-latn", { timeZone, calendar: "iso8601", numberingSystem: "latn", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
}
function civil(format: Intl.DateTimeFormat, instant: number): Civil {
  const parts = format.formatToParts(instant), get = (key: string) => Number(parts.find(part => part.type === key)?.value);
  const result = { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
  if (Object.values(result).some(value => !Number.isFinite(value)) || result.hour > 23) return bad();
  return result;
}
export function validateRitualSchedule(value: unknown): RitualSchedule {
  const keys = ["version", "anchorDate", "localTime", "timeZone", "frequency", "interval", "paused", "invalidDate", "gap", "fold"];
  if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return bad();
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some(key => typeof key !== "string" || !keys.includes(key) || !("value" in Object.getOwnPropertyDescriptor(value, key)!))) return bad();
  const s = value as Record<string, unknown>; calendarDate(s.anchorDate);
  if (s.version !== 1 || typeof s.localTime !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(s.localTime)
    || typeof s.timeZone !== "string" || s.timeZone.length > 100 || !/^[A-Za-z][A-Za-z0-9_+/-]*$/.test(s.timeZone)
    || !["daily", "weekly", "monthly", "yearly"].includes(s.frequency as string) || !Number.isSafeInteger(s.interval) || (s.interval as number) < 1 || (s.interval as number) > RITUAL_SCHEDULE_LIMITS.interval
    || typeof s.paused !== "boolean" || !["clamp", "skip"].includes(s.invalidDate as string) || !["shift-forward", "skip"].includes(s.gap as string) || !["earlier", "later"].includes(s.fold as string)) return bad();
  try { formatter(s.timeZone).format(0); } catch { return bad(); }
  return Object.freeze({ ...s }) as unknown as RitualSchedule;
}
function resolve(wall: Civil, schedule: RitualSchedule, format: Intl.DateTimeFormat): { instant: number; actual: Civil; adjustment: RitualOccurrence["adjustments"][number] | null } | null {
  const wanted = civilMs(wall), offsets = new Set<number>();
  for (let hour = -RITUAL_SCHEDULE_LIMITS.offsetWindowHours; hour <= RITUAL_SCHEDULE_LIMITS.offsetWindowHours; hour++) {
    const probe = wanted + hour * 3_600_000;
    offsets.add(civilMs(civil(format, probe)) - probe);
  }
  const candidates = [...offsets].map(offset => {
    const instant = wanted - offset, actual = civil(format, instant); return { instant, actual, difference: civilMs(actual) - wanted };
  }).sort((a, b) => a.instant - b.instant);
  const exact = candidates.filter(candidate => candidate.difference === 0);
  if (exact.length) {
    const chosen = schedule.fold === "earlier" ? exact[0] : exact.at(-1)!;
    return { ...chosen, adjustment: exact.length > 1 ? `fold-${schedule.fold}` : null };
  }
  if (schedule.gap === "skip") return null;
  const after = candidates.filter(candidate => candidate.difference > 0 && candidate.difference <= dayMs).sort((a, b) => a.difference - b.difference)[0];
  if (!after) throw new Error("This timezone transition could not be resolved safely");
  return { ...after, adjustment: "gap-shift" };
}
function candidateDate(anchor: Pick<Civil, "year" | "month" | "day">, schedule: RitualSchedule, cycle: number): { value: Pick<Civil, "year" | "month" | "day">; clamped: boolean } | null {
  if (schedule.frequency === "daily" || schedule.frequency === "weekly") {
    const offset = cycle * schedule.interval * (schedule.frequency === "weekly" ? 7 : 1);
    const next = new Date(Date.UTC(anchor.year, anchor.month - 1, anchor.day) + offset * dayMs);
    return { value: { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() }, clamped: false };
  }
  const months = anchor.year * 12 + anchor.month - 1 + cycle * schedule.interval * (schedule.frequency === "yearly" ? 12 : 1);
  const year = Math.floor(months / 12), month = months % 12 + 1, lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (anchor.day > lastDay && schedule.invalidDate === "skip") return null;
  return { value: { year, month, day: Math.min(anchor.day, lastDay) }, clamped: anchor.day > lastDay };
}
function afterInstant(value: string): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return bad();
  const result = Date.parse(value);
  if (!Number.isFinite(result)) return bad();
  const day = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== value.slice(0, 10)) return bad();
  return result;
}
export function nextRitualOccurrence(input: RitualSchedule, after: string): RitualOccurrence | null {
  const schedule = validateRitualSchedule(input), cursor = afterInstant(after);
  if (schedule.paused) return null;
  const format = formatter(schedule.timeZone), anchor = calendarDate(schedule.anchorDate), at = civil(format, cursor);
  let elapsed: number;
  if (schedule.frequency === "daily" || schedule.frequency === "weekly") elapsed = (Date.UTC(at.year, at.month - 1, at.day) - Date.UTC(anchor.year, anchor.month - 1, anchor.day)) / dayMs / (schedule.frequency === "weekly" ? 7 : 1);
  else elapsed = (at.year - anchor.year) * (schedule.frequency === "yearly" ? 1 : 12) + (schedule.frequency === "yearly" ? 0 : at.month - anchor.month);
  const start = Math.max(0, Math.floor(elapsed / schedule.interval) - 1), [hour, minute] = schedule.localTime.split(":").map(Number);
  for (let cycle = start; cycle < start + RITUAL_SCHEDULE_LIMITS.searchCycles; cycle++) {
    const selected = candidateDate(anchor, schedule, cycle);
    if (!selected) continue;
    if (selected.value.year > RITUAL_SCHEDULE_LIMITS.lastYear) return null;
    const resolved = resolve({ ...selected.value, hour, minute, second: 0 }, schedule, format);
    if (!resolved || resolved.instant <= cursor) continue;
    const adjustments: RitualOccurrence["adjustments"][number][] = [];
    if (selected.clamped) adjustments.push("date-clamp"); if (resolved.adjustment) adjustments.push(resolved.adjustment);
    return Object.freeze({ cycle, scheduledDate: dateLabel(selected.value), localDate: dateLabel(resolved.actual), localTime: `${two(resolved.actual.hour)}:${two(resolved.actual.minute)}`, instant: new Date(resolved.instant).toISOString(), adjustments: Object.freeze(adjustments) });
  }
  throw new Error("No ritual occurrence was resolved within the bounded search");
}
