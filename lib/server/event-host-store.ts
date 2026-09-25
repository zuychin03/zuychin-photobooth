import { createClient } from "@supabase/supabase-js";
import { EVENT_HOST_LIMITS, validateEventLook, type EventGuestContext, type EventHostList, type EventHostSummary, type EventSettings, type EventSettingsInput } from "../events/host-contract";
import { createEventStore, eventActorId, EventStoreError, type EventRpcClient, type VerifiedEventActor } from "./event-store";
import { eventCreate, eventInstant, eventInteger, eventObject, eventUuid } from "./event-http-input";
import { supabaseServiceOrigin } from "./cron-auth";

export interface EventHostStore {
  capabilities(): Promise<typeof EVENT_HOST_LIMITS>;
  list(actor: VerifiedEventActor, after?: string, limit?: number): Promise<EventHostList>;
  settings(actor: VerifiedEventActor, eventId: string): Promise<EventSettings>;
  saveSettings(actor: VerifiedEventActor, eventId: string, requestId: string, expectedRevision: number, input: EventSettingsInput): Promise<EventSettings>;
  guestContext?(eventId: string, tokenHash: string): Promise<EventGuestContext>;
  revokeCapability?(actor: VerifiedEventActor, eventId: string, tokenHash: string): Promise<Record<string, unknown>>;
  inviteModerator?(actor: VerifiedEventActor, eventId: string, userId: string): Promise<Record<string, unknown>>;
}
const malformed = (): never => { throw new EventStoreError("unavailable", 503); };
const invalid = (): never => { throw new EventStoreError("invalid_request", 400); };
export function cleanEventSettings(value: unknown, eventId: string): EventSettings {
  try {
    const b = eventObject(value, ["version", "eventId", "revision", "locked", "event", "look"]);
    if (b.version !== 1 || b.eventId !== eventId || typeof b.locked !== "boolean") return malformed();
    return { version: 1, eventId, revision: eventInteger(b.revision, 0, 2147483647), locked: b.locked, event: eventCreate(b.event), look: validateEventLook(b.look) };
  } catch { return malformed(); }
}
function summary(value: unknown): EventHostSummary {
  const b = eventObject(value, ["eventId", "title", "timezone", "startsAt", "closesAt", "expiresAt", "status", "role", "membership"]);
  if (!["draft", "open", "paused", "closed", "deleted"].includes(String(b.status)) || !["owner", "moderator"].includes(String(b.role)) || !["active", "invited"].includes(String(b.membership)) || b.role === "owner" && b.membership !== "active") return malformed();
  const parsed = eventCreate({ title: b.title, timezone: b.timezone, startsAt: b.startsAt, closesAt: b.closesAt, expiresAt: b.expiresAt, maxGuests: 1, maxContributions: 1, maxBytes: 4100000 });
  return { eventId: eventUuid(b.eventId), title: parsed.title, timezone: parsed.timezone, startsAt: eventInstant(b.startsAt), closesAt: eventInstant(b.closesAt), expiresAt: eventInstant(b.expiresAt), status: b.status as EventHostSummary["status"], role: b.role as EventHostSummary["role"], membership: b.membership as EventHostSummary["membership"] };
}
export function cleanEventHostList(value: unknown, after?: string, limit = 25): EventHostList {
  try {
    const result = eventObject(value, ["version", "events", "nextCursor"]);
    if (result.version !== 1 || !Array.isArray(result.events) || result.events.length > limit || result.nextCursor !== null && !result.events.length) return malformed();
    const events = result.events.map(summary), cursor = result.nextCursor === null ? null : eventUuid(result.nextCursor);
    if (events.some((item, index) => item.eventId <= (index ? events[index - 1].eventId : after ?? "")) || cursor !== null && (events.length !== limit || cursor !== events.at(-1)?.eventId)) return malformed();
    return { version: 1, events, nextCursor: cursor };
  } catch { return malformed(); }
}
export function createEventHostStore(env: Record<string, string | undefined> = process.env, providedClient?: EventRpcClient): EventHostStore {
  const origin = supabaseServiceOrigin(env.NEXT_PUBLIC_SUPABASE_URL), key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (env.PB_EVENTS_ENABLED !== "true" || !origin || !key?.trim()) throw new EventStoreError("unavailable", 503);
  const client = providedClient ?? (() => {
    const admin = createClient(origin, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: (input, init) => fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000) }) } });
    return { rpc: async (name: string, args: Record<string, unknown>) => { const { data, error } = await admin.rpc(name, args); return { data, error }; } };
  })();
  const base = createEventStore(env, client);
  const rpc = async (name: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    if (new TextEncoder().encode(JSON.stringify(args)).length > 8192) return invalid();
    const { data, error } = await client.rpc(name, args).catch(() => { throw new EventStoreError("unavailable", 503); });
    if (error) {
      const codes: Record<string, [ConstructorParameters<typeof EventStoreError>[0], number]> = { PB_EVENT_DENIED: ["access_denied", 403], PB_EVENT_INVALID: ["invalid_request", 400], PB_EVENT_CONFLICT: ["conflict", 409], PB_EVENT_CAPACITY: ["capacity", 409], PB_EVENT_EXPIRED: ["expired", 410], PB_EVENT_NOT_READY: ["not_ready", 503] };
      const [code, status] = codes[error.message ?? ""] ?? ["unavailable", 503]; throw new EventStoreError(code, status);
    }
    if (!data || new TextEncoder().encode(JSON.stringify(data)).length > 65536) return malformed();
    return data;
  };
  const capabilities = async () => {
    const result = await rpc("pb_event_host_capabilities");
    if (!result || typeof result !== "object" || Object.keys(result).length !== Object.keys(EVENT_HOST_LIMITS).length || Object.entries(EVENT_HOST_LIMITS).some(([key, value]) => (result as Record<string, unknown>)[key] !== value)) return malformed();
    return EVENT_HOST_LIMITS;
  };
  const ready = async () => { await capabilities(); if (!(await base.capabilities()).ready) throw new EventStoreError("not_ready", 503); };
  return {
    capabilities,
    async inviteModerator(actor, eventId, userId) {
      const actorId = eventActorId(actor); eventUuid(eventId); eventUuid(userId); await ready();
      const value = await rpc("pb_event_invite_moderator", { p_actor: actorId, p_event: eventId, p_user: userId });
      if (!value || typeof value !== "object" || Array.isArray(value) || (value as Record<string, unknown>).id !== eventId) return malformed(); return value as Record<string, unknown>;
    },
    async revokeCapability(actor, eventId, tokenHash) {
      const actorId = eventActorId(actor); eventUuid(eventId); if (!/^[0-9a-f]{64}$/.test(tokenHash)) return invalid(); await ready();
      const value = await rpc("pb_event_revoke_capability", { p_actor: actorId, p_event: eventId, p_hash: tokenHash });
      if (!value || typeof value !== "object" || Array.isArray(value) || (value as Record<string, unknown>).id !== eventId) return malformed(); return value as Record<string, unknown>;
    },
    async guestContext(eventId, tokenHash) {
      eventUuid(eventId); if (!/^[0-9a-f]{64}$/.test(tokenHash)) return invalid(); await ready();
      const value = await rpc("pb_event_guest_context", { p_event: eventId, p_token: tokenHash });
      try {
      const b = eventObject(value, ["version", "eventId", "title", "timezone", "startsAt", "closesAt", "expiresAt", "status", "look", "capacityAvailable", "canReserve"]);
      if (b.version !== 1 || b.eventId !== eventId || !["draft", "open", "paused", "closed", "deleted"].includes(b.status as string) || typeof b.capacityAvailable !== "boolean" || typeof b.canReserve !== "boolean") return malformed();
      const info = eventCreate({ title: b.title, timezone: b.timezone, startsAt: b.startsAt, closesAt: b.closesAt, expiresAt: b.expiresAt, maxGuests: 1, maxContributions: 1, maxBytes: 4100000 });
      return { version: 1, eventId, title: info.title, timezone: info.timezone, startsAt: info.startsAt, closesAt: info.closesAt, expiresAt: info.expiresAt, status: b.status as EventGuestContext["status"], look: validateEventLook(b.look), capacityAvailable: b.capacityAvailable, canReserve: b.canReserve };
      } catch { return malformed(); }
    },
    async list(actor, after, limit = 25) {
      const actorId = eventActorId(actor); if (after !== undefined) eventUuid(after); eventInteger(limit, 1, 25); await ready();
      const value = await rpc("pb_event_host_list", { p_actor: actorId, p_after: after ?? null, p_limit: limit });
      return cleanEventHostList(value, after, limit);
    },
    async settings(actor, eventId) {
      const actorId = eventActorId(actor); eventUuid(eventId); await ready();
      return cleanEventSettings(await rpc("pb_event_settings", { p_actor: actorId, p_event: eventId }), eventId);
    },
    async saveSettings(actor, eventId, requestId, expectedRevision, input) {
      const actorId = eventActorId(actor); eventUuid(eventId); eventUuid(requestId); eventInteger(expectedRevision, 0, 2147483646);
      let checked: EventSettingsInput;
      try { const b = eventObject(input, ["event", "look"]); checked = { event: eventCreate(b.event), look: validateEventLook(b.look) }; } catch { return invalid(); }
      await ready();
      return cleanEventSettings(await rpc("pb_event_save_settings", { p_actor: actorId, p_event: eventId, p_request: requestId, p_revision: expectedRevision, p_body: checked }), eventId);
    },
  };
}
