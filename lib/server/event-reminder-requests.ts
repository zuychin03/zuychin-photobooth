import { createHmac } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { createEventReminderStore } from "./event-reminder-store";
import { createEventStore, EventStoreError, verifyEventActor, type EventStore, type VerifiedEventActor } from "./event-store";
import { eventInteger, eventObject, eventUuid } from "./event-http-input";
import { canonicalPublicOrigin, privateJson, supabaseServiceOrigin } from "./cron-auth";
import { readSmallJson, requireSameOrigin, RequestValidationError } from "./request-security";
export interface EventReminderPorts {
  authenticate(token: string, env: Record<string, string | undefined>, signal: AbortSignal): Promise<VerifiedEventActor>;
  stores(env: Record<string, string | undefined>, signal: AbortSignal): { reminder: ReturnType<typeof createEventReminderStore>; base: Pick<EventStore, "transportReady" | "rate"> };
}
const production: EventReminderPorts = {
  async authenticate(token, env, signal) {
    const origin = supabaseServiceOrigin(env.NEXT_PUBLIC_SUPABASE_URL);
    if (!origin || !env.NEXT_PUBLIC_SUPABASE_ANON_KEY) throw new EventStoreError("unavailable", 503);
    const client = createClient(origin, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: (url, init) => fetch(url, { ...init, signal }) } });
    return verifyEventActor({ getUser: () => client.auth.getUser(token) });
  },
  stores(env, signal) {
    const origin = supabaseServiceOrigin(env.NEXT_PUBLIC_SUPABASE_URL);
    if (!origin || !env.SUPABASE_SERVICE_ROLE_KEY) throw new EventStoreError("unavailable", 503);
    const admin = createClient(origin, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: (url, init) => fetch(url, { ...init, signal }) } });
    const client = { rpc: async (name: string, args: Record<string, unknown>) => admin.rpc(name, args) };
    return { reminder: createEventReminderStore(client), base: createEventStore(env, client) };
  },
};
export function createEventReminderHandler(ports: EventReminderPorts = production, getEnv: () => Record<string, string | undefined> = () => process.env) {
  return async (request: Request, eventId: string) => {
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10000)]), check = () => { if (signal.aborted) throw new EventStoreError("unavailable", 503); };
    try {
      const env = getEnv(), secret = env.PB_EVENT_TRANSPORT_SECRET, url = new URL(request.url);
      if (env.PB_EVENTS_ENABLED !== "true" || env.PB_EVENT_REMINDERS_ENABLED !== "true" || !secret || secret.length < 32 || secret.length > 4096 || /\s/.test(secret)) throw new EventStoreError("unavailable", 503);
      if (request.method !== "POST") return privateJson({ error: "method_not_allowed" }, 405);
      const local = env.NODE_ENV === "development" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      if (url.protocol !== "https:" && !(local && url.protocol === "http:") || !local && !canonicalPublicOrigin(env.PB_PUBLIC_ORIGIN)) throw new EventStoreError("unavailable", 503);
      if (url.search) throw new RequestValidationError(400, "invalid_request"); requireSameOrigin(request, env); eventUuid(eventId);
      const token = /^Bearer ([^\s,]+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
      if (!token || token.length > 16384) throw new EventStoreError("access_denied", 401);
      const b = await readSmallJson(request), save = b.operation === "save";
      eventObject(b, save ? ["operation", "expectedRevision", "email", "push"] : ["operation"]);
      if (!save && b.operation !== "read" || save && (typeof b.email !== "boolean" || typeof b.push !== "boolean")) throw new RequestValidationError(400, "invalid_request");
      const input = save ? { expectedRevision: eventInteger(b.expectedRevision, 0, 999999), email: b.email as boolean, push: b.push as boolean } : undefined;
      const configured = { email: Boolean(env.RESEND_API_KEY?.trim()), push: Boolean(env.NEXT_PUBLIC_VAPID_PUBLIC_KEY?.trim() && env.VAPID_PRIVATE_KEY?.trim()) };
      if (input && (input.email && !configured.email || input.push && !configured.push)) throw new EventStoreError("unavailable", 503);
      const actor = await ports.authenticate(token, env, signal); check(); const { reminder, base } = ports.stores(env, signal);
      await base.transportReady(); check(); const rate = await base.rate(createHmac("sha256", secret).update(`event-reminder:${actor.id}`).digest("hex"), save ? "write" : "read"); check();
      if (!rate.allowed) return privateJson({ error: "rate_limited" }, 429);
      const settings = await reminder.settings(actor, eventId, input); check(); return privateJson({ settings, configured });
    } catch (error) {
      const status = error instanceof EventStoreError || error instanceof RequestValidationError ? error.status : 503;
      return privateJson({ error: error instanceof EventStoreError ? error.code : status === 403 ? "origin_denied" : [400, 413, 415].includes(status) ? "invalid_request" : "unavailable" }, status);
    }
  };
}
