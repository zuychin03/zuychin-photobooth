import { EventClientError, type EventHostClient, type EventPublicEvent } from "./client";
import type { EventSettings, EventSettingsInput } from "./host-contract";
import type { EventStatus } from "./contract";

export type EventHostMutation =
  | { kind: "settings"; eventId: string; requestId: string; expectedRevision: number; settings: EventSettingsInput }
  | { kind: "state"; eventId: string; action: "open" | "pause" | "close" | "delete"; previous: EventStatus }
  | { kind: "issue"; eventId: string; requestId: string; expiresAt: string; rotate: boolean }
  | { kind: "moderator"; eventId: string; action: "invite_moderator" | "revoke_moderator"; userId: string }
  | { kind: "revoke"; eventId: string; token: string };
export interface EventHostMutationResult { event?: EventPublicEvent; settings?: EventSettings; issued?: { token: string; expiresAt: string } }
export async function executeEventHostMutation(client: EventHostClient, pending: EventHostMutation, signal: AbortSignal): Promise<EventHostMutationResult> {
  client.assertActive(signal);
  if (pending.kind === "settings") return { settings: await client.saveSettings(pending.eventId, { requestId: pending.requestId, expectedRevision: pending.expectedRevision, settings: pending.settings }, signal) };
  if (pending.kind === "issue") return { issued: await client.issue(pending.eventId, { requestId: pending.requestId, kind: "invite", expiresAt: pending.expiresAt, rotate: pending.rotate }, signal) };
  if (pending.kind === "revoke") return { event: await client.revokeToken(pending.eventId, pending.token, signal) };
  if (pending.kind === "moderator") { await client.manage(pending.eventId, pending.action, { userId: pending.userId }, signal); return {}; }
  const current = await client.dashboard(pending.eventId, { limit: 1 }, signal), target = { open: "open", pause: "paused", close: "closed", delete: "deleted" }[pending.action];
  if (current.event.status === target) return { event: current.event };
  if (current.event.status !== pending.previous) throw new EventClientError("conflict", 409);
  return { event: await client.manage(pending.eventId, pending.action, {}, signal) as EventPublicEvent };
}
export function defaultEventInput(now = Date.now()) {
  return { title: "", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, startsAt: new Date(now + 3600000).toISOString(), closesAt: new Date(now + 5 * 3600000).toISOString(), expiresAt: new Date(now + 7 * 86400000).toISOString(), maxGuests: 25, maxContributions: 100, maxBytes: 250000000 };
}
export function localEventDate(iso: string) {
  const date = new Date(iso); return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
export function eventDateFromLocal(value: string): string | null {
  const parsed = new Date(value); return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}
export function eventScheduleReview(value: { timezone: string; startsAt: string; closesAt: string; expiresAt: string }): string[] | null {
  try {
    const format = new Intl.DateTimeFormat("en-AU", { timeZone: value.timezone, dateStyle: "medium", timeStyle: "short" });
    return [value.startsAt, value.closesAt, value.expiresAt].map(date => format.format(new Date(date)));
  } catch { return null; }
}
