import { createEventReminderAdapter, processEventReminders, type EventReminderAdapter } from "./event-reminders";
import { createHash, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import webpush from "web-push";
import { type Cadence, nextOccurrence } from "../photo-dates";
import { authorizeCron, canonicalPublicOrigin, privateJson, type CronConfig, type CronEnvironment } from "./cron-auth";
import { createRitualReminderAdapter, processRitualReminders, type RitualReminderAdapter } from "./ritual-reminders";

export interface DueReminder {
  id: string;
  couple_id: string;
  title: string;
  scheduled_at: string;
  cadence: Cadence;
}
interface PushTarget { id: string; endpoint: string; p256dh: string; auth: string }
interface Email { to: string[]; subject: string; html: string; key: string }
export interface ReminderAdapter {
  acquire(token: string): Promise<boolean>;
  release(token: string): Promise<void>;
  due(now: string, limit: number): Promise<DueReminder[]>;
  recipients(coupleId: string): Promise<{ ids: string[]; emails: string[] }>;
  deliveries(date: DueReminder): Promise<string[]>;
  record(date: DueReminder, channel: string): Promise<void>;
  complete(date: DueReminder, now: string): Promise<void>;
  email(message: Email, signal?: AbortSignal): Promise<{ error: unknown | null }>;
  subscriptions(ids: string[]): Promise<PushTarget[]>;
  push(target: PushTarget, title: string, topic: string, signal?: AbortSignal, payload?: { title: string; url: string }): Promise<void>;
  removeSubscription(id: string): Promise<void>;
  rituals?: RitualReminderAdapter;
  events?: EventReminderAdapter;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

function reminderHtml(title: string, origin: string): string {
  return `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:auto;padding:24px">
    <p>Zuychin Photobooth</p><h1>It's time for your photo date</h1>
    <p>${escapeHtml(title)}</p><a href="${escapeHtml(origin)}/timeline">Open the booth</a></div>`;
}

const BATCH_SIZE = 5;
const LEASE_SECONDS = 900;

export function createReminderHandler(
  makeAdapter: (config: CronConfig, env: CronEnvironment) => ReminderAdapter = productionAdapter,
  getEnv: () => CronEnvironment = () => process.env,
  now: () => Date = () => new Date(),
) {
  return async (request: Request): Promise<Response> => {
    const env = getEnv();
    const auth = authorizeCron(request, env);
    if (!auth.ok) return auth.response;
    const origin = canonicalPublicOrigin(env.PB_PUBLIC_ORIGIN);
    if (!origin) return privateJson({ error: "reminder configuration unavailable" }, 503);
    const emailEnabled = Boolean(env.RESEND_API_KEY?.trim());
    const pushEnabled = Boolean(env.NEXT_PUBLIC_VAPID_PUBLIC_KEY?.trim() && env.VAPID_PRIVATE_KEY?.trim());
    if (!emailEnabled && !pushEnabled) return privateJson({ skipped: "no reminder channel configured" });
    const token = randomUUID();
    let adapter: ReminderAdapter | undefined;
    let acquired = false;
    let result: Response;
    try {
      adapter = makeAdapter(auth.config, env);
      acquired = await adapter.acquire(token);
      if (!acquired) return privateJson({ skipped: "reminder run already active" }, 409);
      const startedAt = Date.now();
      const timestamp = now().toISOString();
      const due = await adapter.due(timestamp, BATCH_SIZE);
      const event = env.PB_EVENTS_ENABLED === "true" && env.PB_EVENT_REMINDERS_ENABLED === "true" && adapter.events
        ? await processEventReminders(adapter.events, adapter, { token, limit: 1, emailEnabled, pushEnabled, startedAt, emailFrom: env.REMINDER_FROM ?? "Zuychin Photobooth <onboarding@resend.dev>", origin })
        : { processed: 0, sent: 0, failed: 0 };
      const ritual = env.PB_MEMORIES_ENABLED === "true" && adapter.rituals && await adapter.rituals.ready()
        ? await processRitualReminders(adapter.rituals, adapter, { token, limit: Math.min(due.length ? 3 : BATCH_SIZE, BATCH_SIZE - event.processed), emailEnabled, pushEnabled, startedAt, emailFrom: env.REMINDER_FROM ?? "Zuychin Photobooth <onboarding@resend.dev>", html: title => reminderHtml(title, origin) })
        : { processed: 0, sent: 0, failed: 0, skipped: 0 };
      let sent = ritual.sent + event.sent, failed = ritual.failed + event.failed, processed = ritual.processed + event.processed;
      for (const date of due.slice(0, BATCH_SIZE - ritual.processed - event.processed)) {
        if (Date.now() - startedAt >= 45000) break;
        processed++;
        try {
          if (!await adapter.acquire(token)) throw new Error("lease lost");
          const recipients = await adapter.recipients(date.couple_id);
          if (!recipients.ids.length) throw new Error("no recipients");
          const delivered = new Set(await adapter.deliveries(date));
          const key = createHash("sha256").update(`${date.id}:${date.scheduled_at}`).digest("hex");
          if (emailEnabled && recipients.emails.length && !delivered.has("email")) {
            if (Date.now() - startedAt >= 45000) throw new Error("reminder budget exhausted");
            const delivery = await adapter.email({
              to: recipients.emails,
              subject: `Photo date: ${date.title.replace(/[\r\n]/g, " ").slice(0, 200)}`,
              html: reminderHtml(date.title, origin),
              key: `photo-date-${key}`,
            });
            if (delivery.error) throw new Error("email delivery failed");
            await adapter.record(date, "email");
            delivered.add("email");
          }
          if (pushEnabled) {
            const subscriptions = await adapter.subscriptions(recipients.ids);
            // Checkpoint each browser independently before retrying partial delivery.
            let nextPush = 0;
            const sendPush = async (subscription: PushTarget) => {
              const channel = `push:${subscription.id}`;
              if (delivered.has(channel)) return;
              if (Date.now() - startedAt >= 45000) throw new Error("reminder budget exhausted");
              try {
                await adapter!.push(subscription, date.title, key.slice(0, 32));
              } catch (error) {
                const status = (error as { statusCode?: number }).statusCode;
                if (status === 404 || status === 410) {
                  await adapter!.removeSubscription(subscription.id);
                  return;
                }
                throw error;
              }
              await adapter!.record(date, channel);
              delivered.add(channel);
            };
            const pushes = await Promise.allSettled(Array.from({ length: 2 }, async () => { while (nextPush < subscriptions.length) await sendPush(subscriptions[nextPush++]); }));
            if (pushes.some(push => push.status === "rejected")) throw new Error("push delivery failed");
          }
          if (!delivered.size) throw new Error("no successful delivery");
          await adapter.complete(date, timestamp);
          sent++;
        } catch {
          failed++;
        }
      }
      result = privateJson({ processed, sent, failed, ...(ritual.skipped ? { skipped: ritual.skipped } : {}) }, failed ? 503 : 200);
    } catch {
      result = privateJson({ error: "reminder processing failed" }, 503);
    } finally {
      if (acquired && adapter) {
        try {
          await adapter.release(token);
        } catch {
          result = privateJson({ error: "reminder lease release failed" }, 503);
        }
      }
    }
    return result!;
  };
}

function productionAdapter(config: CronConfig, env: CronEnvironment): ReminderAdapter {
  const supabase = createClient(config.supabaseUrl, config.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(10_000) }) },
  });
  async function rpc(name: string, args: Record<string, unknown>) {
    const { data, error } = await supabase.rpc(name, args);
    if (error && name === "pb_ritual_capabilities" && ["PGRST202", "42883"].includes(error.code)) return null;
    if (error) throw new Error("reminder database operation failed");
    return data;
  }
  return {
    events: createEventReminderAdapter(rpc),
    rituals: createRitualReminderAdapter((name, args) => rpc(name, args ?? {})),
    async acquire(token) {
      return await rpc("pb_acquire_job_lease", { p_job: "reminders", p_token: token, p_seconds: LEASE_SECONDS }) === true;
    },
    async release(token) {
      if (await rpc("pb_release_job_lease", { p_job: "reminders", p_token: token }) !== true) throw new Error("lease lost");
    },
    async due(now, limit) {
      const { data, error } = await supabase.from("pb_photo_dates")
        .select("id, couple_id, title, scheduled_at, cadence").eq("active", true)
        .lte("scheduled_at", now).order("scheduled_at").limit(limit);
      if (error) throw new Error("reminder lookup failed");
      return data as DueReminder[];
    },
    async recipients(coupleId) {
      const { data: couple, error } = await supabase.from("pb_couples")
        .select("member_a, member_b").eq("id", coupleId).maybeSingle();
      if (error) throw new Error("couple lookup failed");
      const ids: string[] = couple ? [couple.member_a, couple.member_b].filter(Boolean) : [];
      if (!ids.length) return { ids: [], emails: [] };
      if (!env.RESEND_API_KEY) return { ids, emails: [] };
      const { data: profiles, error: profileError } = await supabase.from("profiles").select("email").in("id", ids);
      if (profileError) throw new Error("profile lookup failed");
      return { ids, emails: [...new Set((profiles ?? []).map(profile => profile.email).filter(Boolean))] };
    },
    async deliveries(date) {
      const { data, error } = await supabase.from("pb_reminder_deliveries").select("channel")
        .eq("date_id", date.id).eq("scheduled_at", date.scheduled_at);
      if (error) throw new Error("delivery lookup failed");
      return (data ?? []).map(row => row.channel);
    },
    async record(date, channel) {
      if (await rpc("pb_record_reminder_delivery", { p_date_id: date.id, p_scheduled_at: date.scheduled_at, p_channel: channel }) !== true) {
        throw new Error("delivery checkpoint failed");
      }
    },
    async complete(date, now) {
      const next = nextOccurrence(date.scheduled_at, date.cadence, new Date(now));
      const { data, error } = await supabase.from("pb_photo_dates")
        .update(next ? { scheduled_at: next, last_sent_at: now } : { active: false, last_sent_at: now })
        .eq("id", date.id).eq("scheduled_at", date.scheduled_at).eq("active", true).select("id");
      if (error || data?.length !== 1) throw new Error("reminder update failed");
    },
    async email(message, signal) {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json", "Idempotency-Key": message.key },
        body: JSON.stringify({ from: env.REMINDER_FROM ?? "Zuychin Photobooth <onboarding@resend.dev>", to: message.to, subject: message.subject, html: message.html }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
      });
      const data = await response.json() as { id?: string; error?: unknown };
      return { error: !response.ok || data.error || !data.id ? "email delivery failed" : null };
    },
    async subscriptions(ids) {
      const { data, error } = await supabase.from("pb_push_subscriptions").select("id, endpoint, p256dh, auth").in("owner", ids).limit(21);
      if (error || (data?.length ?? 0) > 20) throw new Error("push subscription limit exceeded");
      return data as PushTarget[];
    },
    async push(target, title, topic, signal, payload) {
      if (payload && (!/^\/events\/[0-9a-f-]{36}$/.test(payload.url) || payload.title !== "Your event photos expire soon")) throw new Error("invalid reminder payload");
      if (!validPushEndpoint(target.endpoint)) throw new Error("push endpoint unavailable");
      const details = webpush.generateRequestDetails({ endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
        JSON.stringify({ title: payload?.title ?? "It's time for your photo date", body: title, url: payload?.url ?? "/timeline" }), {
          TTL: 3600, topic,
          vapidDetails: { subject: env.VAPID_SUBJECT ?? "mailto:admin@example.com", publicKey: env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!, privateKey: env.VAPID_PRIVATE_KEY! },
        });
      const response = await fetch(details.endpoint, {
        method: details.method, headers: details.headers, body: new Uint8Array(details.body!), redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
      });
      await response.body?.cancel();
      if (!response.ok) throw Object.assign(new Error("push delivery failed"), { statusCode: response.status });
    },
    async removeSubscription(id) {
      const { error } = await supabase.from("pb_push_subscriptions").delete().eq("id", id);
      if (error) throw new Error("subscription deletion failed");
    },
  };
}

export function validPushEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return value.length <= 4096 && url.protocol === "https:" && !url.username && !url.password && !url.hash && !url.port
      && (url.hostname === "fcm.googleapis.com" || url.hostname === "android.googleapis.com" || url.hostname === "web.push.apple.com" || url.hostname === "updates.push.services.mozilla.com" || /^[a-z0-9-]+\.notify\.windows\.com$/.test(url.hostname));
  } catch { return false; }
}
