import { parseEventExportGuestbook, type EventExportGuestbook } from "../events/guestbook-contract";
import { createClient } from "@supabase/supabase-js";
import { EVENT_EXPORT_LIMITS, exportInteger, exportObject, exportUuid, parseEventExportAccess, parseEventExportPage, parseEventExportSummary, parseEventExportRetired, validateEventExportUpdates, type EventExportRetired, type EventExportAccess, type EventExportPage, type EventExportSummary, type EventExportUpdate } from "../events/export-contract";
import { createEventStore, eventActorId, EventStoreError, type EventRpcClient, type VerifiedEventActor } from "./event-store";
import { supabaseServiceOrigin } from "./cron-auth";

export interface EventExportStore {
  guestbook?(actor: VerifiedEventActor, eventId: string, exportId: string, generation: number, index: number): Promise<EventExportGuestbook>;
  retire(actor: VerifiedEventActor, eventId: string, exportId: string, generation: number, revision: number): Promise<EventExportRetired>;
  capabilities(): Promise<typeof EVENT_EXPORT_LIMITS>;
  create(actor: VerifiedEventActor, eventId: string, exportId: string, afterSubmissionId?: string, generation?: number): Promise<EventExportSummary>;
  list(actor: VerifiedEventActor, eventId: string): Promise<{ version: 1; exports: EventExportSummary[]; retired: EventExportRetired[] }>;
  page(actor: VerifiedEventActor, eventId: string, exportId: string, generation: number, after?: number, limit?: number): Promise<EventExportPage>;
  access(actor: VerifiedEventActor, eventId: string, exportId: string, generation: number, index: number): Promise<EventExportAccess>;
  checkpoint(actor: VerifiedEventActor, eventId: string, exportId: string, generation: number, revision: number, updates: EventExportUpdate[]): Promise<EventExportSummary>;
}
const parse = <T>(fn: () => T): T => { try { return fn(); } catch { throw new EventStoreError("unavailable", 503); } };
const input = <T>(fn: () => T): T => { try { return fn(); } catch { throw new EventStoreError("invalid_request", 400); } };
export function createEventExportStore(env: Record<string, string | undefined> = process.env, providedClient?: EventRpcClient): EventExportStore {
  const origin = supabaseServiceOrigin(env.NEXT_PUBLIC_SUPABASE_URL), key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (env.PB_EVENTS_ENABLED !== "true" || !origin || !key?.trim()) throw new EventStoreError("unavailable", 503);
  const client = providedClient ?? (() => {
    const admin = createClient(origin, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: (url, init) => fetch(url, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000) }) } });
    return { rpc: async (name: string, args: Record<string, unknown>) => admin.rpc(name, args) };
  })();
  const base = createEventStore(env, client);
  const rpc = async (name: string, args: Record<string, unknown> = {}) => {
    if (JSON.stringify(args).length > 8192) throw new EventStoreError("invalid_request", 400);
    const { data, error } = await client.rpc(name, args).catch(() => { throw new EventStoreError("unavailable", 503); });
    if (error) {
      const codes: Record<string, [ConstructorParameters<typeof EventStoreError>[0], number]> = { PB_EVENT_DENIED: ["access_denied", 403], PB_EVENT_INVALID: ["invalid_request", 400], PB_EVENT_CONFLICT: ["conflict", 409], PB_EVENT_CAPACITY: ["capacity", 409], PB_EVENT_EXPIRED: ["expired", 410] };
      const [code, status] = codes[error.message ?? ""] ?? ["unavailable", 503]; throw new EventStoreError(code, status);
    }
    if (data === null || new TextEncoder().encode(JSON.stringify(data)).byteLength > EVENT_EXPORT_LIMITS.manifestBytes) throw new EventStoreError("unavailable", 503);
    return data;
  };
  const capabilities = async () => {
    const b = await rpc("pb_event_export_capabilities");
    parse(() => { exportObject(b, Object.keys(EVENT_EXPORT_LIMITS)); if (Object.entries(EVENT_EXPORT_LIMITS).some(([k, v]) => (b as Record<string, unknown>)[k] !== v)) throw new Error(); });
    return EVENT_EXPORT_LIMITS;
  };
  const ready = async () => { await capabilities(); if (!(await base.capabilities()).ready) throw new EventStoreError("not_ready", 503); };
  const subject = (actor: VerifiedEventActor, eventId: string, exportId?: string) => {
    const id = eventActorId(actor); input(() => { exportUuid(eventId); if (exportId !== undefined) exportUuid(exportId); });
    return { p_actor: id, p_event: eventId, ...(exportId === undefined ? {} : { p_export: exportId }) };
  };
  return {
    capabilities,
    async guestbook(actor, eventId, exportId, generation, index) { await ready(); const data = await rpc("pb_event_export_guestbook", { ...subject(actor, eventId, exportId), p_generation: input(() => exportInteger(generation, 0, 2147483646)), p_index: input(() => exportInteger(index, 0, 99)) }); return parse(() => parseEventExportGuestbook(data, eventId)); },
    async retire(actor, eventId, exportId, generation, revision) {
      const args = subject(actor, eventId, exportId); input(() => { exportInteger(generation, 0, 2147483645); exportInteger(revision, 0, 1000000); }); await ready();
      const data = await rpc("pb_event_export_retire", { ...args, p_generation: generation, p_revision: revision }); return parse(() => { const result = parseEventExportRetired(data); if (result.exportId !== exportId || result.generation !== generation + 1) throw new Error(); return result; });
    },
    async create(actor, eventId, exportId, afterSubmissionId, generation = 0) {
      const args = subject(actor, eventId, exportId); if (afterSubmissionId !== undefined) input(() => exportUuid(afterSubmissionId)); await ready();
      const data = await rpc("pb_event_export_create", { ...args, p_after: afterSubmissionId ?? null, p_generation: input(() => exportInteger(generation, 0, 2147483646)) });
      return parse(() => { const value = parseEventExportSummary(data, eventId, exportId); if (value.generation !== generation || value.afterSubmissionId !== (afterSubmissionId ?? null)) throw new Error(); return value; });
    },
    async list(actor, eventId) {
      const args = subject(actor, eventId); await ready(); const data = await rpc("pb_event_export_list", args);
      return parse(() => {
        const b = exportObject(data, ["version", "exports", "retired"]);
        if (b.version !== 1 || !Array.isArray(b.exports) || b.exports.length > 8 || !Array.isArray(b.retired)) throw new Error();
        const exports = b.exports.map(value => parseEventExportSummary(value, eventId)); if (new Set(exports.map(x => x.exportId)).size !== exports.length) throw new Error();
        const retired = b.retired.map(parseEventExportRetired); if (exports.length + retired.length > 8 || new Set([...exports, ...retired].map(x => x.exportId)).size !== exports.length + retired.length) throw new Error();
        return { version: 1, exports, retired };
      });
    },
    async page(actor, eventId, exportId, generation, after = -1, limit = 10) {
      const args = subject(actor, eventId, exportId); input(() => { exportInteger(after, -1, 99); exportInteger(limit, 1, 10); }); await ready();
      const data = await rpc("pb_event_export_page", { ...args, p_generation: input(() => exportInteger(generation, 0, 2147483646)), p_after: after, p_limit: limit }); return parse(() => parseEventExportPage(data, eventId, exportId, after, limit));
    },
    async access(actor, eventId, exportId, generation, index) {
      const args = subject(actor, eventId, exportId); input(() => exportInteger(index, 0, 99)); await ready();
      const data = await rpc("pb_event_export_access", { ...args, p_generation: input(() => exportInteger(generation, 0, 2147483646)), p_index: index }); return parse(() => parseEventExportAccess(data, eventId));
    },
    async checkpoint(actor, eventId, exportId, generation, revision, updates) {
      const args = subject(actor, eventId, exportId), checked = input(() => { exportInteger(revision, 0, 999999); return validateEventExportUpdates(updates); }); await ready();
      const data = await rpc("pb_event_export_checkpoint", { ...args, p_generation: input(() => exportInteger(generation, 0, 2147483646)), p_revision: revision, p_updates: checked }); return parse(() => parseEventExportSummary(data, eventId, exportId));
    },
  };
}
