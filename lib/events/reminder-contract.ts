import { eventClientInstant, eventClientObject, eventClientUuid } from "./client";
export interface EventReminderSettings {
  version: 1; eventId: string; revision: number; email: boolean; push: boolean; expiresAt: string; scheduledAt: string;
  status: "idle" | "queued" | "leased" | "completed" | "failed" | "uncertain" | "cancelled";
  emailAvailable: boolean; pushAvailable: boolean;
}
export function parseEventReminder(value: unknown, eventId: string): EventReminderSettings {
  const b = eventClientObject(value, ["version", "eventId", "revision", "email", "push", "expiresAt", "scheduledAt", "status", "emailAvailable", "pushAvailable"]);
  if (b.version !== 1 || eventClientUuid(b.eventId) !== eventId || !Number.isInteger(b.revision) || (b.revision as number) < 0 || (b.revision as number) > 1000000 || [b.email, b.push, b.emailAvailable, b.pushAvailable].some(v => typeof v !== "boolean") || !["idle", "queued", "leased", "completed", "failed", "uncertain", "cancelled"].includes(String(b.status))) throw new Error("invalid reminder response");
  const expiresAt = eventClientInstant(b.expiresAt), scheduledAt = eventClientInstant(b.scheduledAt);
  if (Date.parse(expiresAt) - Date.parse(scheduledAt) !== 86400000) throw new Error("invalid reminder schedule");
  return { ...b, expiresAt, scheduledAt } as unknown as EventReminderSettings;
}
