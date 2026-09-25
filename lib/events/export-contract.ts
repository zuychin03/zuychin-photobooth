export const EVENT_EXPORT_LIMITS = Object.freeze({ version: 1, retirementVersion: 1, manifests: 8, entries: 100, pageItems: 10, pageBytes: 20_000_000, manifestBytes: 131_072 });
export interface EventExportMedia { bucket: "photobooth-events-v2"; path: string; bytes: number; mime: "image/jpeg"; width: number; height: number; sha256: string }
export type EventExportFailure = "unavailable" | "download_failed" | "integrity_failed" | "cancelled" | "zip_failed";
export interface EventExportProgress { status: "pending" | "prepared" | "confirmed_saved" | "failed"; error: EventExportFailure | null }
export interface EventExportUpdate extends Omit<EventExportProgress, "status"> { index: number; status: Exclude<EventExportProgress["status"], "pending"> }
export interface EventExportSummary { version: 1; eventId: string; exportId: string; generation: number; createdAt: string; expiresAt: string; total: number; afterSubmissionId: string | null; nextSubmissionCursor: string | null; revision: number }
export interface EventExportEntry { guestbookRevision?: number | null; index: number; submissionId: string; createdAt: string; expiresAt: string; state: "reserved" | "uploading" | "finalising" | "ready" | "failed" | "expired" | "deleted"; caption: null; captionStatus: "not_collected"; media: EventExportMedia | null; unavailable: string | null; progress: EventExportProgress }
export interface EventExportPage { summary: EventExportSummary; entries: EventExportEntry[]; nextCursor: number | null }
export interface EventExportAccess extends EventExportMedia { submissionId: string; expiresAt: string; maxAgeSeconds: number }
const invalid = (): never => { throw new Error("Invalid event export contract"); };
export const exportUuid = (v: unknown): string => typeof v === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v) ? v : invalid();
export const exportInteger = (v: unknown, min: number, max: number): number => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max ? v as number : invalid();
function instant(v: unknown): string {
  const parts = typeof v === "string" ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(v) : null;
  if (!parts) return invalid();
  const [year, month, day, hour, minute, second] = parts.slice(1, 7).map(Number), leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  if (!year || month < 1 || month > 12 || day < 1 || day > [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] || hour > 23 || minute > 59 || second > 59 || Number(parts[7] ?? 0) > 23 || Number(parts[8] ?? 0) > 59 || !Number.isFinite(Date.parse(v as string))) return invalid();
  return new Date(v as string).toISOString();
}
export function exportObject(v: unknown, keys: string[]): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).length !== keys.length || keys.some(key => !Object.hasOwn(v, key))) return invalid();
  return v as Record<string, unknown>;
}
export function parseEventExportSummary(v: unknown, eventId: string, exportId?: string): EventExportSummary {
  const b = exportObject(v, ["version", "eventId", "exportId", "generation", "createdAt", "expiresAt", "total", "afterSubmissionId", "nextSubmissionCursor", "revision"]);
  if (b.version !== 1 || b.eventId !== eventId || exportId !== undefined && b.exportId !== exportId) return invalid();
  const total = exportInteger(b.total, 0, 100), after = b.afterSubmissionId === null ? null : exportUuid(b.afterSubmissionId), next = b.nextSubmissionCursor === null ? null : exportUuid(b.nextSubmissionCursor);
  if (next !== null && (total !== 100 || next <= (after ?? ""))) return invalid();
  return { version: 1, eventId: exportUuid(eventId), exportId: exportUuid(b.exportId), generation: exportInteger(b.generation, 0, 2147483646), createdAt: instant(b.createdAt), expiresAt: instant(b.expiresAt), total, afterSubmissionId: after, nextSubmissionCursor: next, revision: exportInteger(b.revision, 0, 1000000) };
}
function media(v: unknown, eventId: string, submissionId: string): EventExportMedia {
  const b = exportObject(v, ["bucket", "path", "bytes", "mime", "width", "height", "sha256"]), width = exportInteger(b.width, 1, 4096), height = exportInteger(b.height, 1, 4096);
  if (b.bucket !== "photobooth-events-v2" || b.path !== `${eventId}/${submissionId}/image` || b.mime !== "image/jpeg" || width * height > 12582912 || typeof b.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(b.sha256)) return invalid();
  return { bucket: b.bucket, path: b.path, bytes: exportInteger(b.bytes, 1, 2000000), mime: b.mime, width, height, sha256: b.sha256 };
}
function progress(v: unknown): EventExportProgress {
  const b = exportObject(v, ["status", "error"]);
  if (!["pending", "prepared", "confirmed_saved", "failed"].includes(String(b.status)) || (b.status === "failed" ? !["unavailable", "download_failed", "integrity_failed", "cancelled", "zip_failed"].includes(String(b.error)) : b.error !== null)) return invalid();
  return { status: b.status as EventExportProgress["status"], error: b.error as EventExportFailure | null };
}
export function parseEventExportPage(v: unknown, eventId: string, exportId: string, after = -1, limit = 10): EventExportPage {
  exportInteger(after, -1, 99); exportInteger(limit, 1, 10);
  const b = exportObject(v, ["summary", "entries", "nextCursor"]), summary = parseEventExportSummary(b.summary, eventId, exportId);
  if (!Array.isArray(b.entries) || b.entries.length > limit) return invalid();
  let previous = after === -1 ? summary.afterSubmissionId ?? "" : "", bytes = 0;
  const entries = b.entries.map((item, offset): EventExportEntry => {
    const e = exportObject(item, ["index", "submissionId", "createdAt", "expiresAt", "state", "caption", "captionStatus", "media", "unavailable", "progress", ...(item && typeof item === "object" && "guestbookRevision" in item ? ["guestbookRevision"] : [])]), submissionId = exportUuid(e.submissionId), index = exportInteger(e.index, 0, 99);
    if (index !== after + offset + 1 || index >= summary.total || submissionId <= previous || !["reserved", "uploading", "finalising", "ready", "failed", "expired", "deleted"].includes(String(e.state)) || e.caption !== null || e.captionStatus !== "not_collected") return invalid();
    previous = submissionId;
    const descriptor = e.media === null ? null : media(e.media, eventId, submissionId), status = progress(e.progress);
    if (descriptor ? e.state !== "ready" || e.unavailable !== null : !["reserved", "uploading", "finalising", "failed", "expired", "deleted", "unavailable"].includes(String(e.unavailable)) || status.status !== "failed") return invalid();
    bytes += descriptor?.bytes ?? 0;
    return { ...(Object.hasOwn(e, "guestbookRevision") ? { guestbookRevision: e.guestbookRevision === null ? null : exportInteger(e.guestbookRevision, 0, 1000000) } : {}), index, submissionId, createdAt: instant(e.createdAt), expiresAt: instant(e.expiresAt), state: e.state as EventExportEntry["state"], caption: null, captionStatus: "not_collected", media: descriptor, unavailable: e.unavailable as string | null, progress: status };
  });
  const expectedCount = Math.min(limit, Math.max(0, summary.total - after - 1)), last = after + entries.length, next = last + 1 < summary.total ? last : null;
  if (entries.length !== expectedCount || b.nextCursor !== next || bytes > EVENT_EXPORT_LIMITS.pageBytes) return invalid();
  return { summary, entries, nextCursor: next };
}
export function parseEventExportAccess(v: unknown, eventId: string): EventExportAccess {
  const b = exportObject(v, ["bucket", "path", "bytes", "mime", "width", "height", "sha256", "submissionId", "expiresAt", "maxAgeSeconds"]), submissionId = exportUuid(b.submissionId);
  const { submissionId: ignoredId, expiresAt, maxAgeSeconds, ...descriptor } = b; void ignoredId;
  return { ...media(descriptor, eventId, submissionId), submissionId, expiresAt: instant(expiresAt), maxAgeSeconds: exportInteger(maxAgeSeconds, 1, 300) };
}
export function validateEventExportUpdates(v: unknown): EventExportUpdate[] {
  if (!Array.isArray(v) || !v.length || v.length > 10) return invalid();
  const seen = new Set<number>();
  return v.map(item => {
    const b = exportObject(item, ["index", "status", "error"]), index = exportInteger(b.index, 0, 99), p = progress({ status: b.status, error: b.error });
    if (p.status === "pending" || seen.has(index)) return invalid(); seen.add(index);
    return { index, status: p.status, error: p.error };
  });
}

export interface EventExportRetired { exportId: string; generation: number }
export function parseEventExportRetired(v: unknown): EventExportRetired { const b = exportObject(v, ["exportId", "generation"]); return { exportId: exportUuid(b.exportId), generation: exportInteger(b.generation, 1, 2147483646) }; }
