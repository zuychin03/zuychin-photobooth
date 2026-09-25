import { cloudTimestamp, cloudUuid } from "../projects/cloud-contract";
import type { MemoryActivity } from "./activity-contract";
import { nextRitualOccurrence } from "./ritual-schedule";

export interface MemoryCursor { occurredAt: string; id: string }
export interface MemoryBrowse { year: number; timeZone: string; chapterId: string | null; after: MemoryCursor | null; limit: number }
export interface MemoryBrowsePage { version: 1; year: number; timeZone: string; chapterId: string | null; items: MemoryActivity[]; nextCursor: MemoryCursor | null }
const bad = (): never => { throw new Error("invalid_request"); };
function exact(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).length !== keys.length || Reflect.ownKeys(value).some(key => typeof key !== "string" || !keys.includes(key) || !("value" in Object.getOwnPropertyDescriptor(value, key)!))) return bad();
  return value as Record<string, unknown>;
}
export function memoryInstantMicros(value: unknown): bigint {
  const timestamp = cloudTimestamp(value), [year, month, day] = timestamp.slice(0, 10).split("-").map(Number);
  if (new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) !== timestamp.slice(0, 10) || Number(timestamp.slice(11, 13)) > 23) return bad();
  const fraction = /\.(\d{1,6})/.exec(timestamp)?.[1] ?? "";
  return BigInt(Date.parse(timestamp)) * BigInt(1000) + BigInt(fraction.padEnd(6, "0").slice(3));
}
function cursor(value: unknown): MemoryCursor | null {
  if (value === null) return null;
  const v = exact(value, ["occurredAt", "id"]); memoryInstantMicros(v.occurredAt);
  return { occurredAt: v.occurredAt as string, id: cloudUuid(v.id) };
}
export function memoryYearBounds(year: number, timeZone: string) {
  if (!Number.isInteger(year) || year < 1970 || year > 2198 || typeof timeZone !== "string") return bad();
  const boundary = (y: number) => {
    const date = `${y}-01-01`;
    const result = nextRitualOccurrence({ version: 1, anchorDate: date, localTime: "00:00", timeZone, frequency: "yearly", interval: 1, invalidDate: "clamp", gap: "shift-forward", fold: "earlier", paused: false }, new Date(Date.parse(`${date}T00:00:00Z`) - 172_800_000).toISOString());
    if (!result || result.cycle !== 0) return bad(); return result.instant;
  };
  return { start: boundary(year), end: boundary(year + 1) };
}
export function validateMemoryBrowse(value: unknown): MemoryBrowse {
  const v = exact(value, ["year", "timeZone", "chapterId", "after", "limit"]);
  if (!Number.isInteger(v.limit) || (v.limit as number) < 1 || (v.limit as number) > 50) return bad();
  const bounds = memoryYearBounds(v.year as number, v.timeZone as string), after = cursor(v.after);
  if (after && (memoryInstantMicros(after.occurredAt) < memoryInstantMicros(bounds.start) || memoryInstantMicros(after.occurredAt) >= memoryInstantMicros(bounds.end))) return bad();
  return { year: v.year as number, timeZone: v.timeZone as string, chapterId: v.chapterId === null ? null : cloudUuid(v.chapterId), after, limit: v.limit as number };
}
export function memoryAfter(a: MemoryCursor, b: MemoryCursor): boolean {
  const left = memoryInstantMicros(a.occurredAt), right = memoryInstantMicros(b.occurredAt);
  return left < right || left === right && a.id < b.id;
}
export function parseMemoryBrowsePage(value: unknown, query: MemoryBrowse, decode: (item: unknown) => MemoryActivity): MemoryBrowsePage {
  const v = exact(value, ["version", "year", "timeZone", "chapterId", "items", "nextCursor"]);
  if (v.version !== 1 || v.year !== query.year || v.timeZone !== query.timeZone || v.chapterId !== query.chapterId || !Array.isArray(v.items) || v.items.length > query.limit) return bad();
  const items = v.items.map(decode), bounds = memoryYearBounds(query.year, query.timeZone), nextCursor = cursor(v.nextCursor);
  let previous = query.after;
  for (const item of items) {
    if (memoryInstantMicros(item.occurredAt) < memoryInstantMicros(bounds.start) || memoryInstantMicros(item.occurredAt) >= memoryInstantMicros(bounds.end) || previous && !memoryAfter(item, previous) || query.chapterId && (!item.mine || item.annotation?.chapterId !== query.chapterId)) return bad();
    previous = item;
  }
  if (new Set(items.map(item => item.id)).size !== items.length || nextCursor && (items.length !== query.limit || nextCursor.id !== items.at(-1)?.id || memoryInstantMicros(nextCursor.occurredAt) !== memoryInstantMicros(items.at(-1)?.occurredAt))) return bad();
  return { version: 1, year: query.year, timeZone: query.timeZone, chapterId: query.chapterId, items, nextCursor };
}
