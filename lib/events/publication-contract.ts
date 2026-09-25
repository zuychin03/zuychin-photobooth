import { eventClientInstant, eventClientObject, eventClientUuid } from "./client";

export const EVENT_PUBLICATION_LIMITS = Object.freeze({ publicationVersion: 1, pageItems: 12, wallItems: 3, pollMs: 5000, freshnessMs: 10000, thumbnailBytes: 100000, imageBytes: 2000000, readSeconds: 300, reportCharacters: 500, reports: 100 });
export type EventDestination = "gallery" | "wall";
export type PublicationState = "private" | "awaiting_approval" | "approved" | "hidden" | "rejected";
export type EventReportReason = "privacy" | "inappropriate" | "other";
export interface EventAudienceSession { version: 1; eventId: string; destination: EventDestination; sessionId: string; eventTitle: string; checkedAt: string; expiresAt: string }
export interface EventAudienceEntry { submissionId: string; revision: number; createdAt: string }
export interface EventAudiencePage { version: 1; eventId: string; destination: EventDestination; eventTitle: string; checkedAt: string; expiresAt: string; entries: EventAudienceEntry[]; nextCursor: string | null }
export interface EventAudienceValidation { version: 1; eventId: string; destination: EventDestination; checkedAt: string; expiresAt: string; entries: { submissionId: string; revision: number }[] }
export interface EventAudienceAccess { submissionId: string; revision: number; bucket: "photobooth-events-v2"; path: string; variant: "thumbnail" | "image"; bytes: number; mime: "image/jpeg"; sha256: string | null; width: number | null; height: number | null; expiresAt: string; maxAgeSeconds: number }
export interface EventAudienceMedia extends Omit<EventAudienceAccess, "maxAgeSeconds"> { signedUrl: string; retainedUntil: string }
export interface EventModerationEntry { submissionId: string; revision: number; createdAt: string; state: string; gallery: PublicationState; wall: PublicationState; galleryConsent: boolean; wallConsent: boolean; thumbnailAvailable: boolean }
export interface EventModerationPage { version: 1; eventId: string; entries: EventModerationEntry[]; nextCursor: string | null }
export interface EventReportReceipt { version: 1; reportId: string; status: "open" | "resolved" }
export interface EventReportEntry extends EventReportReceipt { submissionId: string; destination: EventDestination; reason: EventReportReason; detail: string; createdAt: string }
export interface EventReportPage { version: 1; eventId: string; entries: EventReportEntry[]; nextCursor: string | null }
const invalid = (): never => { throw new Error("Invalid event publication response"); };
export const publicationRevision = (v: unknown): number => Number.isSafeInteger(v) && (v as number) >= 0 ? v as number : invalid();
export const publicationDestination = (v: unknown): EventDestination => v === "gallery" || v === "wall" ? v : invalid();
const title = (v: unknown): string => typeof v === "string" && [...v].length >= 1 && [...v].length <= 100 && !/[\u0000-\u001f\u007f]/.test(v) ? v : invalid();
const state = (v: unknown): PublicationState => ["private", "awaiting_approval", "approved", "hidden", "rejected"].includes(String(v)) ? v as PublicationState : invalid();
function scope(b: Record<string, unknown>, eventId: string, destination?: EventDestination) {
  if (b.version !== 1 || b.eventId !== eventClientUuid(eventId) || destination && b.destination !== destination) invalid();
}
function freshness(b: Record<string, unknown>) { const checkedAt = eventClientInstant(b.checkedAt), expiresAt = eventClientInstant(b.expiresAt); if (checkedAt >= expiresAt) invalid(); return { checkedAt, expiresAt }; }
export function parseEventAudienceSession(value: unknown, eventId: string, destination: EventDestination): EventAudienceSession {
  const b = eventClientObject(value, ["version", "eventId", "destination", "sessionId", "eventTitle", "checkedAt", "expiresAt"]); scope(b, eventId, destination);
  return { version: 1, eventId, destination, sessionId: eventClientUuid(b.sessionId), eventTitle: title(b.eventTitle), ...freshness(b) };
}
export function parseEventAudiencePage(value: unknown, eventId: string, destination: EventDestination, after?: string, limit = 12): EventAudiencePage {
  const b = eventClientObject(value, ["version", "eventId", "destination", "eventTitle", "checkedAt", "expiresAt", "entries", "nextCursor"]); scope(b, eventId, destination);
  if (!Array.isArray(b.entries) || b.entries.length > limit || limit < 1 || limit > 12) invalid(); let previous = after ?? "";
  const entries = (b.entries as unknown[]).map(v => { const e = eventClientObject(v, ["submissionId", "revision", "createdAt"]), submissionId = eventClientUuid(e.submissionId); if (submissionId <= previous) invalid(); previous = submissionId; return { submissionId, revision: publicationRevision(e.revision), createdAt: eventClientInstant(e.createdAt) }; });
  const nextCursor = b.nextCursor === null ? null : eventClientUuid(b.nextCursor); if (nextCursor && (entries.length !== limit || entries.at(-1)?.submissionId !== nextCursor)) invalid();
  return { version: 1, eventId, destination, eventTitle: title(b.eventTitle), ...freshness(b), entries, nextCursor };
}
export function parseEventAudienceValidation(value: unknown, eventId: string, destination: EventDestination, requested: readonly string[]): EventAudienceValidation {
  const b = eventClientObject(value, ["version", "eventId", "destination", "checkedAt", "expiresAt", "entries"]); scope(b, eventId, destination);
  if (requested.length > 12 || new Set(requested).size !== requested.length || !Array.isArray(b.entries) || b.entries.length > requested.length) invalid();
  const seen = new Set<string>(); const entries = (b.entries as unknown[]).map(v => { const e = eventClientObject(v, ["submissionId", "revision"]), submissionId = eventClientUuid(e.submissionId); if (!requested.includes(submissionId) || seen.has(submissionId)) invalid(); seen.add(submissionId); return { submissionId, revision: publicationRevision(e.revision) }; });
  return { version: 1, eventId, destination, ...freshness(b), entries };
}
export function parseEventAudienceAccess(value: unknown, eventId: string, submissionId: string, variant: "thumbnail" | "image"): EventAudienceAccess {
  const b = eventClientObject(value, ["submissionId", "revision", "bucket", "path", "variant", "bytes", "mime", "sha256", "width", "height", "expiresAt", "maxAgeSeconds"]);
  if (b.submissionId !== eventClientUuid(submissionId) || b.bucket !== "photobooth-events-v2" || b.path !== `${eventClientUuid(eventId)}/${submissionId}/${variant}` || b.variant !== variant || b.mime !== "image/jpeg" || !Number.isSafeInteger(b.bytes) || (b.bytes as number) < 1 || (b.bytes as number) > (variant === "thumbnail" ? 100000 : 2000000) || b.sha256 !== null && (typeof b.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(b.sha256)) || !Number.isInteger(b.maxAgeSeconds) || (b.maxAgeSeconds as number) < 1 || (b.maxAgeSeconds as number) > 300) invalid();
  if ((b.width === null) !== (b.height === null)) invalid();
  if (b.width !== null && (!Number.isInteger(b.width) || !Number.isInteger(b.height) || (b.width as number) < 1 || (b.height as number) < 1 || (b.width as number) > (variant === "thumbnail" ? 400 : 4096) || (b.height as number) > (variant === "thumbnail" ? 400 : 4096) || (b.width as number) * (b.height as number) > 12000000)) invalid();
  if (variant === "image" && (b.width === null || b.sha256 === null)) invalid();
  return { ...b, revision: publicationRevision(b.revision), expiresAt: eventClientInstant(b.expiresAt) } as unknown as EventAudienceAccess;
}
export function parseEventModerationEntry(value: unknown): EventModerationEntry {
  const b = eventClientObject(value, ["submissionId", "revision", "createdAt", "state", "gallery", "wall", "galleryConsent", "wallConsent", "thumbnailAvailable"]);
  if (!["reserved", "uploading", "finalising", "ready", "failed", "expired", "deleted"].includes(String(b.state)) || [b.galleryConsent, b.wallConsent, b.thumbnailAvailable].some(v => typeof v !== "boolean")) invalid();
  return { ...b, submissionId: eventClientUuid(b.submissionId), revision: publicationRevision(b.revision), createdAt: eventClientInstant(b.createdAt), gallery: state(b.gallery), wall: state(b.wall) } as unknown as EventModerationEntry;
}
function page<T>(value: unknown, eventId: string, after: string | undefined, limit: number, parse: (v: unknown) => T, id: (v: T) => string) {
  const b = eventClientObject(value, ["version", "eventId", "entries", "nextCursor"]); scope(b, eventId); if (!Array.isArray(b.entries) || b.entries.length > limit || limit < 1 || limit > 12) invalid(); let previous = after ?? "";
  const entries = (b.entries as unknown[]).map(v => { const e = parse(v), key = id(e); if (key <= previous) invalid(); previous = key; return e; }); const nextCursor = b.nextCursor === null ? null : eventClientUuid(b.nextCursor); if (nextCursor && (entries.length !== limit || id(entries.at(-1)!) !== nextCursor)) invalid(); return { version: 1 as const, eventId, entries, nextCursor };
}
export const parseEventModerationPage = (value: unknown, eventId: string, after?: string, limit = 12): EventModerationPage => page(value, eventId, after, limit, parseEventModerationEntry, e => e.submissionId);
export function parseEventReportReceipt(value: unknown): EventReportReceipt { const b = eventClientObject(value, ["version", "reportId", "status"]); if (b.version !== 1 || b.status !== "open" && b.status !== "resolved") invalid(); return { version: 1, reportId: eventClientUuid(b.reportId), status: b.status as "open" | "resolved" }; }
export function parseEventReportPage(value: unknown, eventId: string, after?: string, limit = 12): EventReportPage {
  return page(value, eventId, after, limit, v => { const b = eventClientObject(v, ["version", "reportId", "status", "submissionId", "destination", "reason", "detail", "createdAt"]); if (!["privacy", "inappropriate", "other"].includes(String(b.reason)) || typeof b.detail !== "string" || [...b.detail].length > 500) invalid(); return { ...parseEventReportReceipt({ version: b.version, reportId: b.reportId, status: b.status }), submissionId: eventClientUuid(b.submissionId), destination: publicationDestination(b.destination), reason: b.reason as EventReportReason, detail: b.detail as string, createdAt: eventClientInstant(b.createdAt) }; }, e => e.reportId);
}
