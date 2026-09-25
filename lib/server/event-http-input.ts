import { EVENT_LIMITS, type EventConsent, type EventCreateInput, type EventManageAction } from "../events/contract";
import { RequestValidationError } from "./request-security";

export const eventInvalid = (): never => { throw new RequestValidationError(400, "invalid_request"); };
export function eventObject(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return eventInvalid();
  const record = value as Record<string, unknown>;
  if (required.some(key => !Object.hasOwn(record, key)) || Object.keys(record).some(key => !required.includes(key) && !optional.includes(key))) return eventInvalid();
  return record;
}
export function eventUuid(value: unknown): string { if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) return eventInvalid(); return value; }
export function eventSecret(value: unknown): string { if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value) || Buffer.from(value, "base64url").toString("base64url") !== value) return eventInvalid(); return value; }
export function eventInteger(value: unknown, minimum: number, maximum: number): number { if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) return eventInvalid(); return value as number; }
export function eventInstant(value: unknown): string {
  const parts = typeof value === "string" ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value) : null;
  if (!parts) return eventInvalid();
  const [year, month, day, hour, minute, second] = parts.slice(1, 7).map(Number), leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  if (!year || month < 1 || month > 12 || day < 1 || day > [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] || hour > 23 || minute > 59 || second > 59 || Number(parts[7] ?? 0) > 23 || Number(parts[8] ?? 0) > 59 || !Number.isFinite(Date.parse(value as string))) return eventInvalid();
  return new Date(value as string).toISOString();
}
export function eventCreate(value: unknown): EventCreateInput {
  const b = eventObject(value, ["title", "timezone", "startsAt", "closesAt", "expiresAt", "maxGuests", "maxContributions", "maxBytes"]);
  if (typeof b.title !== "string" || b.title !== b.title.trim() || [...b.title].length < 1 || [...b.title].length > 100 || /[\u0000-\u001f\u007f-\u009f]/.test(b.title) || typeof b.timezone !== "string" || b.timezone.length > 100) return eventInvalid();
  try { new Intl.DateTimeFormat("en", { timeZone: b.timezone }); } catch { return eventInvalid(); }
  const startsAt = eventInstant(b.startsAt), closesAt = eventInstant(b.closesAt), expiresAt = eventInstant(b.expiresAt);
  if (startsAt >= closesAt || closesAt > expiresAt) return eventInvalid();
  return { title: b.title, timezone: b.timezone, startsAt, closesAt, expiresAt, maxGuests: eventInteger(b.maxGuests, 1, EVENT_LIMITS.guests), maxContributions: eventInteger(b.maxContributions, 1, EVENT_LIMITS.contributions), maxBytes: eventInteger(b.maxBytes, EVENT_LIMITS.imageBytes + EVENT_LIMITS.derivativeBytes, EVENT_LIMITS.eventBytes) };
}
export function eventConsent(value: unknown): EventConsent {
  const b = eventObject(value, ["submission", "gallery", "wall"]);
  if ([b.submission, b.gallery, b.wall].some(value => typeof value !== "boolean")) return eventInvalid();
  return { submission: b.submission as boolean, gallery: b.gallery as boolean, wall: b.wall as boolean };
}
export function eventManage(action: unknown, value: unknown): { action: EventManageAction; body: Record<string, unknown> } {
  if (typeof action !== "string") return eventInvalid();
  if (action === "update") return { action, body: { ...eventCreate(value) } };
  if (["open", "pause", "close", "delete", "accept_moderator"].includes(action)) { eventObject(value, []); return { action: action as EventManageAction, body: {} }; }
  if (["revoke_guest", "invite_moderator", "revoke_moderator", "remove_submission"].includes(action)) {
    const key = action === "revoke_guest" ? "guestId" : action === "remove_submission" ? "submissionId" : "userId", b = eventObject(value, [key]);
    return { action: action as EventManageAction, body: { [key]: eventUuid(b[key]) } };
  }
  if (action === "publication") {
    const b = eventObject(value, ["submissionId", "destination", "state"]);
    if (!["gallery", "wall"].includes(b.destination as string) || !["approved", "hidden", "rejected"].includes(b.state as string)) return eventInvalid();
    return { action, body: { submissionId: eventUuid(b.submissionId), destination: b.destination, state: b.state } };
  }
  return eventInvalid();
}
