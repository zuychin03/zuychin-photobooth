import { createClient } from "@supabase/supabase-js";
import { cloudTimestamp, cloudUuid } from "../projects/cloud-contract";
import { RITUAL_LIMITS, computeRitualProof, parseRitualPage, parseRitualRow, ritualObject, ritualRevision, validateRitualChannels, validateRitualEdit, validateRitualInput, type RitualChannels, type RitualEdit, type RitualInput, type RitualPage, type RitualRow } from "../memories/ritual-contract";
import { supabaseServiceOrigin } from "./cron-auth";
import type { ProjectStorePorts } from "./project-store";

export class RitualServerError extends Error { constructor(readonly code: string, readonly status: number, readonly retryAfterSeconds?: number) { super(code); } }
export interface RitualStore {
  list(coupleId: string, after?: string, limit?: number): Promise<RitualPage>;
  create(coupleId: string, input: RitualInput): Promise<RitualRow>;
  upgrade(coupleId: string, id: string, expectedScheduledAt: string, input: RitualEdit): Promise<RitualRow>;
  edit(coupleId: string, id: string, revision: number, input: RitualEdit): Promise<RitualRow>;
  pause(coupleId: string, id: string, revision: number): Promise<RitualRow>;
  resume(coupleId: string, id: string, revision: number): Promise<RitualRow>;
  delete(coupleId: string, id: string, revision: number): Promise<{ id: string; deleted: true; revision: number }>;
  setChannels(coupleId: string, id: string, revision: number, channels: RitualChannels): Promise<RitualRow>;
}
const parse = <T>(fn: (v: unknown) => T, value: unknown): T => { try { return fn(value); } catch { throw new RitualServerError("unavailable", 503); } };
const validate = <T>(fn: (v: unknown) => T, value: unknown): T => { try { return fn(value); } catch { throw new RitualServerError("invalid_request", 400); } };
export async function createRitualStore(accessToken: string, env: Record<string, string | undefined> = process.env, ports?: ProjectStorePorts): Promise<RitualStore> {
  const origin = supabaseServiceOrigin(env.NEXT_PUBLIC_SUPABASE_URL), key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (env.PB_MEMORIES_ENABLED !== "true" || !origin || !key?.trim()) throw new RitualServerError("unavailable", 503);
  if (!accessToken || accessToken.length > 16384 || /[\s,]/.test(accessToken)) throw new RitualServerError("access_denied", 401);
  if (!ports) {
    const client = createClient(origin, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: (input, init) => fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) }) } });
    ports = { authenticate: async token => { const { data, error } = await client.auth.getUser(token); return error ? null : data.user?.id ?? null; }, rpc: async (name, args) => client.rpc(name, args) };
  }
  let actor: string; try { actor = cloudUuid(await ports.authenticate(accessToken)); } catch { throw new RitualServerError("access_denied", 401); }
  const rpc = async (name: string, args: Record<string, unknown> = {}) => {
    if (new TextEncoder().encode(JSON.stringify(args)).length > RITUAL_LIMITS.requestBytes) throw new RitualServerError("invalid_request", 400);
    const { data, error } = await ports.rpc(name, args).catch(() => { throw new RitualServerError("unavailable", 503); });
    if (error) {
      const mapping: Record<string, [string, number]> = { PB_RITUAL_DENIED: ["access_denied", 403], PB_RITUAL_CONFLICT: ["conflict", 409], PB_RITUAL_CAPACITY: ["capacity", 409], PB_RITUAL_INVALID: ["invalid_request", 400], PB_RITUAL_STALE_PROOF: ["schedule_changed", 409], PB_RITUAL_NO_FUTURE: ["no_future_occurrence", 409] };
      const [code, status] = mapping[error.message] ?? ["unavailable", 503]; throw new RitualServerError(code, status);
    }
    if (data === null || new TextEncoder().encode(JSON.stringify(data)).length > RITUAL_LIMITS.responseBytes) throw new RitualServerError("unavailable", 503); return data;
  };
  const cap = parse(v => ritualObject(v, ["ready", "version", "maximumPerCouple", "pageMaximum", "proofSeconds", "deliveryVersion"]), await rpc("pb_ritual_capabilities"));
  if (cap.ready !== true || cap.version !== 1 || cap.maximumPerCouple !== 20 || cap.pageMaximum !== 20 || cap.proofSeconds !== 30 || ![0, 1].includes(cap.deliveryVersion as number)) throw new RitualServerError("unavailable", 503);
  const rate = async (operation: "read" | "write") => {
    const result = parse(v => ritualObject(v, ["allowed", "retryAfterSeconds"]), await rpc("pb_project_rate", { p_actor: actor, p_operation: operation }));
    if (result.allowed === true && result.retryAfterSeconds === 0) return;
    if (result.allowed === false && Number.isInteger(result.retryAfterSeconds) && (result.retryAfterSeconds as number) >= 1 && (result.retryAfterSeconds as number) <= 60) throw new RitualServerError("rate_limited", 429, result.retryAfterSeconds as number);
    throw new RitualServerError("unavailable", 503);
  };
  const context = async (couple: string, id: string | null) => {
    const v = parse(value => ritualObject(value, ["now", "row"]), await rpc("pb_ritual_context", { p_actor: actor, p_couple: couple, p_id: id }));
    const now = parse(cloudTimestamp, v.now), row = v.row === null ? null : parse(parseRitualRow, v.row);
    if (id === null ? row !== null : !row || row.id !== id || row.coupleId !== couple) throw new RitualServerError("unavailable", 503);
    return { now, row };
  };
  const rowResult = (value: unknown, couple: string, id: string) => { const row = parse(parseRitualRow, value); if (row.id !== id || row.coupleId !== couple || row.legacy) throw new RitualServerError("unavailable", 503); return row; };
  const save = async (coupleId: string, id: string, action: "create" | "upgrade" | "edit", revision: number, input: RitualEdit, expectedLegacy: string | null) => {
    const couple = validate(cloudUuid, coupleId), dateId = validate(cloudUuid, id), rev = validate(ritualRevision, revision), checked = validate(validateRitualEdit, input);
    await rate("write"); const c = await context(couple, action === "create" ? null : dateId);
    if (c.row && (c.row.creatorId !== actor || c.row.revision !== rev || (action === "upgrade") !== c.row.legacy)) throw new RitualServerError("conflict", 409);
    const proof = computeRitualProof(checked.schedule, c.now);
    const result = rowResult(await rpc("pb_ritual_save", { p_actor: actor, p_couple: couple, p_id: dateId, p_action: action, p_revision: rev, p_title: checked.title, p_schedule: checked.schedule, p_proof: proof, p_expected_legacy: expectedLegacy }), couple, dateId);
    if (result.creatorId !== actor || action !== "create" && (result.revision !== rev + 1 || result.title !== checked.title || JSON.stringify(result.schedule) !== JSON.stringify(checked.schedule))) throw new RitualServerError("unavailable", 503);
    return result;
  };
  const action = async (coupleId: string, id: string, revision: number, operation: "pause" | "resume" | "delete" | "channels", channels: RitualChannels | null = null) => {
    const couple = validate(cloudUuid, coupleId), dateId = validate(cloudUuid, id), rev = validate(ritualRevision, revision);
    await rate("write"); const c = operation === "resume" ? await context(couple, dateId) : null;
    if (c && (!c.row?.schedule || c.row.revision !== rev)) throw new RitualServerError("conflict", 409);
    const value = await rpc("pb_ritual_action", { p_actor: actor, p_couple: couple, p_id: dateId, p_revision: rev, p_action: operation, p_proof: c ? computeRitualProof(c.row!.schedule!, c.now) : null, p_channels: channels });
    if (operation !== "delete") {
      const result = rowResult(value, couple, dateId);
      if (result.revision !== rev + 1 || operation === "pause" && !result.paused || operation === "resume" && result.paused || operation === "channels" && JSON.stringify(result.channels) !== JSON.stringify(channels)) throw new RitualServerError("unavailable", 503);
    }
    return { value, couple, dateId };
  };
  return {
    async list(coupleId, after, limit = 20) {
      const couple = validate(cloudUuid, coupleId), cursor = after === undefined ? null : validate(cloudUuid, after);
      if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new RitualServerError("invalid_request", 400);
      await rate("read"); return parse(v => parseRitualPage(v, couple, cursor, limit), await rpc("pb_ritual_list", { p_actor: actor, p_couple: couple, p_after: cursor, p_limit: limit }));
    },
    async create(coupleId, input) { const checked = validate(validateRitualInput, input); return save(coupleId, checked.id, "create", 0, { title: checked.title, schedule: checked.schedule }, null); },
    async upgrade(coupleId, id, expectedScheduledAt, input) { return save(coupleId, id, "upgrade", 0, input, validate(cloudTimestamp, expectedScheduledAt)); },
    async edit(coupleId, id, revision, input) { return save(coupleId, id, "edit", revision, input, null); },
    async pause(coupleId, id, revision) { const r = await action(coupleId, id, revision, "pause"); return rowResult(r.value, r.couple, r.dateId); },
    async resume(coupleId, id, revision) { const r = await action(coupleId, id, revision, "resume"); return rowResult(r.value, r.couple, r.dateId); },
    async setChannels(coupleId, id, revision, channels) { const checked = validate(validateRitualChannels, channels), r = await action(coupleId, id, revision, "channels", checked); return rowResult(r.value, r.couple, r.dateId); },
    async delete(coupleId, id, revision) {
      const r = await action(coupleId, id, revision, "delete"), value = parse(v => ritualObject(v, ["id", "deleted", "revision"]), r.value);
      if (value.id !== id || value.deleted !== true || value.revision !== revision + 1) throw new RitualServerError("unavailable", 503);
      return { id, deleted: true, revision: revision + 1 };
    },
  };
}
