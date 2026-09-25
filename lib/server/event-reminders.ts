import { createHash, randomUUID } from "node:crypto";
import { eventInstant, eventInteger, eventObject, eventUuid } from "./event-http-input";
import type { ReminderAdapter } from "./reminders";

type Rpc = (name: string, args: Record<string, unknown>) => Promise<unknown>;
export interface EventReminderClaim { eventId: string; expiryRevision: number; expiresAt: string; timezone: string; title: string; token: string; channels: string[] }
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const unavailable = (): never => { throw new Error("event reminder unavailable"); };
export function createEventReminderAdapter(rpc: Rpc) {
  return {
    async claim(run: string, email: boolean, push: boolean): Promise<EventReminderClaim | null> {
      const token = randomUUID(), value = await rpc("pb_event_reminder_claim", { p_run: run, p_token: token, p_email: email, p_push: push });
      if (value === null) return null;
      const b = eventObject(value, ["eventId", "expiryRevision", "expiresAt", "timezone", "title", "token", "channels"]);
      if (b.token !== token || typeof b.title !== "string" || b.title.length > 100 || /[\r\n]/.test(b.title) || typeof b.timezone !== "string" || !Array.isArray(b.channels) || b.channels.length > 11 || new Set(b.channels).size !== b.channels.length || b.channels.some(c => typeof c !== "string" || c !== "email" && !/^push:[0-9a-f-]{36}$/.test(c))) return unavailable();
      new Intl.DateTimeFormat("en-AU", { timeZone: b.timezone });
      return { eventId: eventUuid(b.eventId), expiryRevision: eventInteger(b.expiryRevision, 0, 1000000), expiresAt: eventInstant(b.expiresAt), timezone: b.timezone, title: b.title, token, channels: b.channels as string[] };
    },
    async dispatch(claim: EventReminderClaim, channel: string, payloadHash?: string) {
      const b = eventObject(await rpc("pb_event_reminder_dispatch", { p_event: claim.eventId, p_token: claim.token, p_channel: channel, p_hash: payloadHash ?? null }), ["state", "target"]);
      if (!["send", "delivered", "gone", "uncertain"].includes(String(b.state))) return unavailable();
      if (b.state !== "send") { if (b.target !== null) return unavailable(); return { state: String(b.state), target: null }; }
      const target = eventObject(b.target, channel === "email" ? ["email"] : ["id", "endpoint", "p256dh", "auth"]);
      if (channel === "email") { if (typeof target.email !== "string" || target.email.length > 320 || /\s/.test(target.email) || !target.email.includes("@")) return unavailable(); }
      else { if (`push:${eventUuid(target.id)}` !== channel || ["endpoint", "p256dh", "auth"].some(k => typeof target[k] !== "string" || !(target[k] as string).length || (target[k] as string).length > (k === "endpoint" ? 4096 : 256))) return unavailable(); }
      return { state: "send", target };
    },
    async record(claim: EventReminderClaim, channel: string, outcome: "delivered" | "gone", target?: Record<string, unknown>) { if (await rpc("pb_event_reminder_record", { p_event: claim.eventId, p_token: claim.token, p_channel: channel, p_outcome: outcome, p_target: target ?? null }) !== true) return unavailable(); },
    async finish(claim: EventReminderClaim, failed: boolean) { if (await rpc("pb_event_reminder_finish", { p_event: claim.eventId, p_token: claim.token, p_failed: failed }) !== true) return unavailable(); },
  };
}
export type EventReminderAdapter = ReturnType<typeof createEventReminderAdapter>;
export async function processEventReminders(store: EventReminderAdapter, provider: Pick<ReminderAdapter, "acquire" | "email" | "push">, options: { token: string; limit: number; startedAt: number; emailEnabled: boolean; pushEnabled: boolean; emailFrom: string; origin: string }) {
  const result = { processed: 0, sent: 0, failed: 0 };
  if (!Number.isInteger(options.limit) || options.limit < 0 || options.limit > 5) return unavailable();
  const budget = () => { if (Date.now() - options.startedAt >= 45000) return unavailable(); };
  const check = async () => { budget(); if (!await provider.acquire(options.token)) return unavailable(); budget(); };
  const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  for (let i = 0; i < options.limit && Date.now() - options.startedAt < 45000; i++) {
    await check(); const claim = await store.claim(options.token, options.emailEnabled, options.pushEnabled); if (!claim) break;
    result.processed++; let failed = false, sent = false;
    for (const channel of claim.channels) {
      try {
        if (channel === "email" ? !options.emailEnabled : !options.pushEnabled) { failed = true; continue; }
        await check(); if (Date.parse(claim.expiresAt) <= Date.now()) return unavailable();
        const first = await store.dispatch(claim, channel); if (first.state !== "send") continue;
        const target = first.target!, url = `/events/${claim.eventId}`, deadline = new Intl.DateTimeFormat("en-AU", { timeZone: claim.timezone, dateStyle: "medium", timeStyle: "short" }).format(new Date(claim.expiresAt));
        const title = "Your event photos expire soon", body = `${claim.title}. Export before ${deadline} (${claim.timezone}). Expiry is not delayed by this reminder.`;
        const key = hash([claim.eventId, claim.expiryRevision, claim.expiresAt, channel]), payload = { target, title, body, url, from: options.emailFrom };
        const fresh = await store.dispatch(claim, channel, hash(payload));
        if (fresh.state !== "send") continue;
        if (JSON.stringify(fresh.target) !== JSON.stringify(target)) throw new Error("target changed");
        await check();
        if (channel === "email") {
          if (!options.emailEnabled) throw new Error("channel unavailable");
          budget(); const response = await provider.email({ to: [target.email as string], subject: title, html: `<p>${escape(body)}</p><a href="${escape(options.origin + url)}">Open event export</a>`, key: `event-expiry-${key}` }, AbortSignal.timeout(10000));
          if (response.error) throw new Error("provider failed");
        } else {
          if (!options.pushEnabled) throw new Error("channel unavailable");
          try { budget(); await provider.push(target as unknown as Parameters<ReminderAdapter["push"]>[0], body, key.slice(0, 32), AbortSignal.timeout(10000), { title, url }); }
          catch (error) { if ([404, 410].includes((error as { statusCode?: number }).statusCode ?? 0)) { await store.record(claim, channel, "gone", target); continue; } throw error; }
        }
        await store.record(claim, channel, "delivered"); sent = true;
      } catch { failed = true; break; }
    }
    try { await store.finish(claim, failed); } catch { failed = true; }
    if (failed) result.failed++; else if (sent) result.sent++;
  }
  return result;
}
