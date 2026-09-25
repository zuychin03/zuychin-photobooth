import { cloudTimestamp, cloudUuid } from "../projects/cloud-contract";

export const ACTIVITY_LIMITS = Object.freeze({ version: 1, detailLimit: 2000, annotatedLimit: 500, chapterLimit: 100, pageLimit: 50, labelCharacters: 80, responseBytes: 65536, summaryTimezone: "UTC" as const });
export type ActivityAvailability = "available" | "archive_pending" | "archived" | "expired" | "deleted" | "unknown" | "access_lost";
export interface MemoryActivity {
  id: string; mine: boolean; occurredAt: string; provenance: "saved_at" | "verified_at" | "legacy_created_at"; availability: ActivityAvailability;
  source: { kind: "strip" | "project_asset"; id: string; scopeKind: "personal" | "couple" | "project"; scopeId: string | null } | null;
  annotation: { revision: number; chapterId: string | null; occasion: string | null } | null;
}
export interface ActivityPage { items: MemoryActivity[]; nextCursor: string | null }
export interface ActivitySummary { year: number; timezone: "UTC"; basis: "own_source_records"; months: { month: number; total: number }[]; outsideCalendar: number }
export interface MemoryChapter { id: string; title: string; revision: number; createdAt: string }
export interface ChapterInput { id: string; expectedRevision: number; title: string }
export interface ActivityAnnotation { id: string; expectedRevision: number; chapterId: string | null; occasion: string | null }
const invalid = (): never => { throw new Error("invalid_request"); };
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).some(k => typeof k !== "string" || !("value" in Object.getOwnPropertyDescriptor(value, k)!))) return invalid();
  return value as Record<string, unknown>;
}
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number { if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) return invalid(); return value as number; }
export function activityLabel(value: unknown): string { if (typeof value !== "string" || !value.trim() || value !== value.trim() || [...value].length > 80 || /[\u0000-\u001f\u007f-\u009f]/.test(value)) return invalid(); return value; }
export function validateChapterInput(value: unknown): ChapterInput {
  const v = object(value); if (Object.keys(v).sort().join() !== "expectedRevision,id,title") return invalid();
  return { id: cloudUuid(v.id), expectedRevision: integer(v.expectedRevision, -1, 2147483646), title: activityLabel(v.title) };
}
export function validateActivityAnnotation(value: unknown): ActivityAnnotation {
  const v = object(value); if (Object.keys(v).sort().join() !== "chapterId,expectedRevision,id,occasion") return invalid();
  return { id: cloudUuid(v.id), expectedRevision: integer(v.expectedRevision, 0, 2147483646), chapterId: v.chapterId === null ? null : cloudUuid(v.chapterId), occasion: v.occasion === null ? null : activityLabel(v.occasion) };
}
export function parseMemoryActivity(value: unknown): MemoryActivity {
  const v = object(value); if (typeof v.mine !== "boolean" || !["saved_at", "verified_at", "legacy_created_at"].includes(v.provenance as string) || !["available", "archive_pending", "archived", "expired", "deleted", "unknown", "access_lost"].includes(v.availability as string)) return invalid();
  let source: MemoryActivity["source"] = null;
  if (v.availability !== "access_lost") {
    if (!["strip", "project_asset"].includes(v.sourceKind as string) || !["personal", "couple", "project"].includes(v.scopeKind as string) || (v.scopeKind === "personal") !== (v.scopeId === null) || (v.sourceKind === "project_asset") !== (v.scopeKind === "project")) return invalid();
    if ((!v.mine && v.scopeKind === "personal") || (v.sourceKind === "strip" && v.provenance !== "saved_at") || (v.sourceKind === "project_asset" && (v.provenance === "saved_at" || ["archived", "archive_pending"].includes(v.availability as string)))) return invalid();
    source = { kind: v.sourceKind as "strip" | "project_asset", id: cloudUuid(v.sourceId), scopeKind: v.scopeKind as "personal" | "couple" | "project", scopeId: v.scopeId === null ? null : cloudUuid(v.scopeId) };
  } else if (!v.mine || ["sourceKind", "sourceId", "scopeKind", "scopeId"].some(k => Object.hasOwn(v, k))) return invalid();
  const annotation = v.mine ? { revision: integer(v.revision, 0, 2147483647), chapterId: v.chapterId === null ? null : cloudUuid(v.chapterId), occasion: v.occasion === null ? null : activityLabel(v.occasion) } : null;
  return { id: cloudUuid(v.id), mine: v.mine, occurredAt: cloudTimestamp(v.occurredAt), provenance: v.provenance as MemoryActivity["provenance"], availability: v.availability as ActivityAvailability, source, annotation };
}
export function parseActivityPage(value: unknown): ActivityPage {
  const v = object(value); if (!Array.isArray(v.items) || v.items.length > 50) return invalid();
  const items = v.items.map(parseMemoryActivity), nextCursor = v.nextCursor === null ? null : cloudUuid(v.nextCursor);
  if (items.some((item, index) => index > 0 && item.id <= items[index - 1].id) || (nextCursor !== null && items.at(-1)?.id !== nextCursor)) return invalid();
  return { items, nextCursor };
}
export function parseActivitySummary(value: unknown): ActivitySummary {
  const v = object(value); if (v.timezone !== "UTC" || v.basis !== "own_source_records" || !Array.isArray(v.months) || v.months.length !== 12) return invalid();
  const months = v.months.map((value, index) => { const m = object(value); if (m.month !== index + 1) return invalid(); return { month: index + 1, total: integer(m.total) }; });
  return { year: integer(v.year, 1970, 2199), timezone: "UTC", basis: "own_source_records", months, outsideCalendar: integer(v.outsideCalendar) };
}
export function parseMemoryChapter(value: unknown): MemoryChapter { const v = object(value); return { id: cloudUuid(v.id), title: activityLabel(v.title), revision: integer(v.revision, 0, 2147483647), createdAt: cloudTimestamp(v.createdAt) }; }
export function parseMemoryChapters(value: unknown): MemoryChapter[] {
  const v = object(value); if (!Array.isArray(v.chapters) || v.chapters.length > 100) return invalid();
  const result = v.chapters.map(parseMemoryChapter); if (new Set(result.map(c => c.id)).size !== result.length) return invalid(); return result;
}
