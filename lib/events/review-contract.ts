import { eventClientInstant, eventClientObject, eventClientUuid, parseEventReceipt } from "./client";
import type { EventReceipt } from "./contract";

export const EVENT_REVIEW_LIMITS = Object.freeze({ version: 1, pageItems: 12, thumbnailBytes: 100000, thumbnailEdge: 400 });
export interface EventReviewEntry extends EventReceipt { createdAt: string; thumbnailAvailable: boolean }
export interface EventReviewPage { version: 1; eventId: string; entries: EventReviewEntry[]; nextCursor: string | null }
export interface EventReviewAccess { submissionId: string; bucket: "photobooth-events-v2"; path: string; bytes: number; mime: "image/jpeg"; sha256: string | null; expiresAt: string; maxAgeSeconds: number }
const invalid = (): never => { throw new Error("Invalid private event review"); };
export function parseEventReviewPage(value: unknown, eventId: string, after?: string, limit = 12): EventReviewPage {
  const b = eventClientObject(value, ["version", "eventId", "entries", "nextCursor"]);
  if (b.version !== 1 || b.eventId !== eventId || !Array.isArray(b.entries) || b.entries.length > limit || !Number.isInteger(limit) || limit < 1 || limit > 12) return invalid();
  let previous = after ?? "";
  const entries = b.entries.map(value => { const r = eventClientObject(value, ["submissionId", "state", "logicalExpiresAt", "eventExpiresAt", "gallery", "wall", "createdAt", "thumbnailAvailable"]), { createdAt, thumbnailAvailable, ...receipt } = r;
    const parsed = parseEventReceipt(receipt); if (parsed.submissionId <= previous || typeof thumbnailAvailable !== "boolean" || thumbnailAvailable && parsed.state !== "ready") return invalid(); previous = parsed.submissionId;
    return { ...parsed, createdAt: eventClientInstant(createdAt), thumbnailAvailable };
  });
  const nextCursor = b.nextCursor === null ? null : eventClientUuid(b.nextCursor);
  if (nextCursor && (entries.length !== limit || entries.at(-1)?.submissionId !== nextCursor)) return invalid();
  return { version: 1, eventId: eventClientUuid(eventId), entries, nextCursor };
}
export function parseEventReviewAccess(value: unknown, eventId: string, submissionId?: string): EventReviewAccess {
  const b = eventClientObject(value, ["submissionId", "bucket", "path", "bytes", "mime", "sha256", "expiresAt", "maxAgeSeconds"]), id = eventClientUuid(b.submissionId);
  if (submissionId && id !== submissionId || b.bucket !== "photobooth-events-v2" || b.path !== `${eventClientUuid(eventId)}/${id}/thumbnail` || b.mime !== "image/jpeg" || !Number.isSafeInteger(b.bytes) || (b.bytes as number) < 1 || (b.bytes as number) > 100000 || b.sha256 !== null && (typeof b.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(b.sha256)) || !Number.isSafeInteger(b.maxAgeSeconds) || (b.maxAgeSeconds as number) < 1 || (b.maxAgeSeconds as number) > 300) return invalid();
  return { submissionId: id, bucket: b.bucket, path: b.path, bytes: b.bytes as number, mime: b.mime, sha256: b.sha256 as string | null, expiresAt: eventClientInstant(b.expiresAt), maxAgeSeconds: b.maxAgeSeconds as number };
}
