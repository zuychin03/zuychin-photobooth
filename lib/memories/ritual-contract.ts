import { cloudTimestamp, cloudUuid } from "../projects/cloud-contract";
import { nextRitualOccurrence, validateRitualSchedule, type RitualOccurrence, type RitualSchedule } from "./ritual-schedule";

export const RITUAL_LIMITS = Object.freeze({ version: 1, maximumPerCouple: 20, pageMaximum: 20, titleCodePoints: 100, requestBytes: 8192, responseBytes: 65536, proofSeconds: 30 });
export interface RitualDefinition extends Omit<RitualSchedule, "frequency" | "paused"> { frequency: "once" | "weekly" | "monthly" | "yearly"; onceAt: string | null }
export interface RitualInput { id: string; title: string; schedule: RitualDefinition }
export interface RitualEdit { title: string; schedule: RitualDefinition }
export interface RitualChannels { email: boolean; push: boolean }
export interface RitualDeliveryStatus { status: "idle" | "pending" | "retrying" | "failed" | "uncertain"; attempts: number }
export interface RitualRow {
  id: string; coupleId: string; creatorId: string; title: string; revision: number; legacy: boolean;
  scheduledAt: string; cadence: RitualDefinition["frequency"]; active: boolean;
  schedule: RitualDefinition | null; next: RitualOccurrence | null; paused: boolean; enabled: boolean; channels: RitualChannels;
  delivery?: RitualDeliveryStatus;
}
export interface RitualPage { version: 1; items: RitualRow[]; nextCursor: string | null }
export interface RitualProof { computedAt: string; occurrence: RitualOccurrence | null }
const invalid = (): never => { throw new Error("Invalid ritual contract"); };
export function ritualObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalid();
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some(key => typeof key !== "string" || !keys.includes(key) || !("value" in Object.getOwnPropertyDescriptor(value, key)!))) return invalid();
  return value as Record<string, unknown>;
}
export function ritualRevision(value: unknown): number { if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 2147483646) return invalid(); return value as number; }
export function ritualTitle(value: unknown): string { if (typeof value !== "string" || !value.trim() || Array.from(value).length > 100 || /[\u0000-\u001f\u007f]/.test(value)) return invalid(); return value; }
export function validateRitualDefinition(value: unknown): RitualDefinition {
  const v = ritualObject(value, ["version", "anchorDate", "localTime", "timeZone", "frequency", "interval", "invalidDate", "gap", "fold", "onceAt"]);
  if (!["once", "weekly", "monthly", "yearly"].includes(v.frequency as string)) return invalid();
  const checked = validateRitualSchedule({ version: v.version, anchorDate: v.anchorDate, localTime: v.localTime, timeZone: v.timeZone, frequency: v.frequency === "once" ? "yearly" : v.frequency, interval: v.interval, invalidDate: v.invalidDate, gap: v.gap, fold: v.fold, paused: false });
  let onceAt: string | null = null;
  if (v.frequency === "once") {
    onceAt = new Date(cloudTimestamp(v.onceAt)).toISOString();
    if (checked.interval !== 1) return invalid();
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: checked.timeZone, calendar: "iso8601", numberingSystem: "latn", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(onceAt));
    const part = (name: string) => parts.find(p => p.type === name)?.value;
    if (`${part("year")}-${part("month")}-${part("day")}` !== checked.anchorDate || `${part("hour")}:${part("minute")}` !== checked.localTime) return invalid();
  } else if (v.onceAt !== null) return invalid();
  return { version: 1, anchorDate: checked.anchorDate, localTime: checked.localTime, timeZone: checked.timeZone, frequency: v.frequency as RitualDefinition["frequency"], interval: checked.interval, invalidDate: checked.invalidDate, gap: checked.gap, fold: checked.fold, onceAt };
}
export function validateRitualInput(value: unknown): RitualInput { const v = ritualObject(value, ["id", "title", "schedule"]); return { id: cloudUuid(v.id), title: ritualTitle(v.title), schedule: validateRitualDefinition(v.schedule) }; }
export function validateRitualEdit(value: unknown): RitualEdit { const v = ritualObject(value, ["title", "schedule"]); return { title: ritualTitle(v.title), schedule: validateRitualDefinition(v.schedule) }; }
export function validateRitualChannels(value: unknown): RitualChannels { const v = ritualObject(value, ["email", "push"]); if (typeof v.email !== "boolean" || typeof v.push !== "boolean") return invalid(); return { email: v.email, push: v.push }; }
export function computeRitualProof(input: RitualDefinition, databaseNow: string): RitualProof {
  const schedule = validateRitualDefinition(input), computedAt = new Date(cloudTimestamp(databaseNow)).toISOString();
  if (schedule.frequency === "once") return { computedAt, occurrence: Date.parse(schedule.onceAt!) > Date.parse(computedAt) ? { cycle: 0, scheduledDate: schedule.anchorDate, localDate: schedule.anchorDate, localTime: schedule.localTime, instant: schedule.onceAt!, adjustments: [] } : null };
  const { onceAt, ...recurrence } = schedule; void onceAt;
  return { computedAt, occurrence: nextRitualOccurrence({ ...recurrence, frequency: schedule.frequency, paused: false }, computedAt) };
}
function occurrence(value: unknown): RitualOccurrence | null {
  if (value === null) return null;
  const v = ritualObject(value, ["cycle", "scheduledDate", "localDate", "localTime", "instant", "adjustments"]);
  if (!Number.isSafeInteger(v.cycle) || (v.cycle as number) < 0 || (v.cycle as number) > 1000000 || ![v.scheduledDate, v.localDate].every(d => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)) || typeof v.localTime !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(v.localTime) || !Array.isArray(v.adjustments) || v.adjustments.length > 2 || v.adjustments.some(a => !["date-clamp", "gap-shift", "fold-earlier", "fold-later"].includes(a))) return invalid();
  return { cycle: v.cycle as number, scheduledDate: v.scheduledDate as string, localDate: v.localDate as string, localTime: v.localTime, instant: new Date(cloudTimestamp(v.instant)).toISOString(), adjustments: v.adjustments };
}
export function parseRitualRow(value: unknown): RitualRow {
  const hasDelivery = value !== null && typeof value === "object" && Object.hasOwn(value, "delivery");
  const v = ritualObject(value, ["id", "coupleId", "creatorId", "title", "revision", "legacy", "scheduledAt", "cadence", "active", "schedule", "next", "paused", "enabled", "channels", ...(hasDelivery ? ["delivery"] : [])]);
  let delivery: RitualDeliveryStatus | undefined;
  if (hasDelivery) {
    const d = ritualObject(v.delivery, ["status", "attempts"]);
    if (!["idle", "pending", "retrying", "failed", "uncertain"].includes(d.status as string) || !Number.isInteger(d.attempts) || (d.attempts as number) < 0 || (d.attempts as number) > 5) return invalid();
    delivery = { status: d.status as RitualDeliveryStatus["status"], attempts: d.attempts as number };
  }
  if (typeof v.legacy !== "boolean" || ![v.active, v.paused, v.enabled].every(b => typeof b === "boolean") || !["once", "weekly", "monthly", "yearly"].includes(v.cadence as string) || typeof v.title !== "string" || Array.from(v.title).length > 10000) return invalid();
  const schedule = v.schedule === null ? null : validateRitualDefinition(v.schedule), next = occurrence(v.next), revision = ritualRevision(v.revision);
  if (v.legacy ? schedule !== null || next !== null || revision !== 0 || v.enabled || v.paused : !schedule || v.active || schedule.frequency !== v.cadence || (v.enabled && (!next || v.paused))) return invalid();
  const scheduledAt = new Date(cloudTimestamp(v.scheduledAt)).toISOString();
  const terminalDelivery = delivery?.status === "failed" || delivery?.status === "uncertain";
  if (terminalDelivery && v.enabled || !v.legacy && (next && next.instant !== scheduledAt || !v.paused && Boolean(next) !== v.enabled && !(next && !v.enabled && terminalDelivery))) return invalid();
  return { id: cloudUuid(v.id), coupleId: cloudUuid(v.coupleId), creatorId: cloudUuid(v.creatorId), title: v.title, revision, legacy: v.legacy, scheduledAt, cadence: v.cadence as RitualRow["cadence"], active: v.active as boolean, schedule, next, paused: v.paused as boolean, enabled: v.enabled as boolean, channels: validateRitualChannels(v.channels), ...(delivery ? { delivery } : {}) };
}
export function parseRitualPage(value: unknown, coupleId: string, after: string | null, limit: number): RitualPage {
  const v = ritualObject(value, ["version", "items", "nextCursor"]);
  if (v.version !== 1 || !Array.isArray(v.items) || v.items.length > limit) return invalid();
  const items = v.items.map(parseRitualRow), nextCursor = v.nextCursor === null ? null : cloudUuid(v.nextCursor);
  let previous = after; for (const item of items) { if (item.coupleId !== coupleId || previous && item.id <= previous) return invalid(); previous = item.id; }
  if (nextCursor !== null && (items.length !== limit || nextCursor !== items.at(-1)?.id)) return invalid();
  return { version: 1, items, nextCursor };
}
