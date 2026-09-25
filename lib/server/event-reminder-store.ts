import { eventInstant } from "./event-http-input";
import { parseEventReminder } from "../events/reminder-contract";
import { eventActorId, EventStoreError, type EventRpcClient, type VerifiedEventActor } from "./event-store";

function normaliseDates(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid event response");
  const result = { ...value } as Record<string, unknown>;
  for (const key of ["expiresAt","scheduledAt"]) if (Object.hasOwn(result, key)) result[key] = eventInstant(result[key]);
  return result;
}
export function createEventReminderStore(client: EventRpcClient) {
  return { async settings(actor: VerifiedEventActor, eventId: string, save?: { expectedRevision: number; email: boolean; push: boolean }) {
    const { data, error } = await client.rpc("pb_event_reminder_settings", { p_actor: eventActorId(actor), p_event: eventId, p_revision: save?.expectedRevision ?? null, p_email: save?.email ?? null, p_push: save?.push ?? null });
    if (error) {
      if (error.message === "PB_EVENT_DENIED") throw new EventStoreError("access_denied", 403);
      if (error.message === "PB_EVENT_CONFLICT") throw new EventStoreError("conflict", 409);
      if (error.message === "PB_EVENT_EXPIRED") throw new EventStoreError("expired", 410);
      throw new EventStoreError("unavailable", 503);
    }
    try { return parseEventReminder(normaliseDates(data), eventId); } catch { throw new EventStoreError("unavailable", 503); }
  } };
}
