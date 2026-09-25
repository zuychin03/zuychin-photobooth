import { createClient } from "@supabase/supabase-js";
import { cloudUuid } from "../projects/cloud-contract";
import { ACTIVITY_LIMITS, parseActivityPage, parseActivitySummary, parseMemoryActivity, parseMemoryChapter, parseMemoryChapters, validateActivityAnnotation, validateChapterInput, type ActivityAnnotation, type ChapterInput } from "../memories/activity-contract";
import { supabaseServiceOrigin } from "./cron-auth";
import type { ProjectStorePorts } from "./project-store";
import { memoryYearBounds, parseMemoryBrowsePage, validateMemoryBrowse, type MemoryBrowse } from "../memories/activity-browse";

export class ActivityServerError extends Error { constructor(readonly code: string, readonly status: number, readonly retryAfterSeconds?: number) { super(code); } }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new ActivityServerError("unavailable", 503); return value as Record<string, unknown>; }
function parse<T>(parser: (value: unknown) => T, value: unknown): T { try { return parser(value); } catch { throw new ActivityServerError("unavailable", 503); } }
function validate<T>(parser: (value: unknown) => T, value: unknown): T { try { return parser(value); } catch { throw new ActivityServerError("invalid_request", 400); } }
export async function createActivityStore(accessToken: string, env: Record<string, string | undefined> = process.env, ports?: ProjectStorePorts) {
  const origin = supabaseServiceOrigin(env.NEXT_PUBLIC_SUPABASE_URL), key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (env.PB_MEMORIES_ENABLED !== "true" || !origin || !key?.trim()) throw new ActivityServerError("unavailable", 503);
  if (!accessToken || accessToken.length > 16384 || /[\s,]/.test(accessToken)) throw new ActivityServerError("access_denied", 401);
  if (!ports) {
    const client = createClient(origin, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(10_000) }) } });
    ports = { authenticate: async token => { const { data, error } = await client.auth.getUser(token); return error ? null : data.user?.id ?? null; }, rpc: async (name, args) => client.rpc(name, args) };
  }
  let actor: string; try { actor = cloudUuid(await ports.authenticate(accessToken)); } catch { throw new ActivityServerError("access_denied", 401); }
  const rpc = async (name: string, args: Record<string, unknown> = {}) => {
    const { data, error } = await ports.rpc(name, args).catch(() => { throw new ActivityServerError("unavailable", 503); });
    if (error) {
      const mapping: Record<string, [string, number]> = { PB_MEMORY_DENIED: ["access_denied", 403], PB_MEMORY_CONFLICT: ["conflict", 409], PB_MEMORY_CAPACITY: ["capacity", 409], PB_MEMORY_NOT_EMPTY: ["chapter_not_empty", 409], PB_MEMORY_INVALID: ["invalid_request", 400] };
      const [code, status] = mapping[error.message] ?? ["unavailable", 503]; throw new ActivityServerError(code, status);
    }
    if (new TextEncoder().encode(JSON.stringify(data)).byteLength > ACTIVITY_LIMITS.responseBytes) throw new ActivityServerError("unavailable", 503); return object(data);
  };
  const capability = await rpc("pb_memory_capabilities");
  if (capability.ready !== true || ["version", "detailLimit", "annotatedLimit", "chapterLimit", "pageLimit", "summaryTimezone"].some(k => capability[k] !== ACTIVITY_LIMITS[k as keyof typeof ACTIVITY_LIMITS])) throw new ActivityServerError("unavailable", 503);
  const rate = async (operation: "read" | "write") => {
    const result = await rpc("pb_project_rate", { p_actor: actor, p_operation: operation });
    if (result.allowed === true && result.retryAfterSeconds === 0) return;
    if (result.allowed === false && Number.isInteger(result.retryAfterSeconds) && (result.retryAfterSeconds as number) >= 1 && (result.retryAfterSeconds as number) <= 60) throw new ActivityServerError("rate_limited", 429, result.retryAfterSeconds as number);
    throw new ActivityServerError("unavailable", 503);
  };
  return {
    async browse(value: MemoryBrowse) {
      const query = validate(validateMemoryBrowse, value);
      const cap = await rpc("pb_memory_browse_capabilities");
      if (cap.version !== 1 || cap.pageLimit !== 50 || cap.order !== "occurred_at_desc_id_desc") throw new ActivityServerError("unavailable", 503);
      await rate("read"); const bounds = memoryYearBounds(query.year, query.timeZone);
      const result = await rpc("pb_memory_browse", { p_actor: actor, p_start: bounds.start, p_end: bounds.end, p_chapter: query.chapterId, p_after_at: query.after?.occurredAt ?? null, p_after_id: query.after?.id ?? null, p_limit: query.limit });
      return parse(value => parseMemoryBrowsePage({ ...object(value), version: 1, year: query.year, timeZone: query.timeZone, chapterId: query.chapterId }, query, parseMemoryActivity), result);
    },
    async list(after?: string, limit = 20) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new ActivityServerError("invalid_request", 400);
      const cursor = after === undefined ? null : validate(cloudUuid, after); await rate("read"); const result = parse(parseActivityPage, await rpc("pb_memory_list", { p_actor: actor, p_after: cursor, p_limit: limit }));
      if (result.items.length > limit || result.items.some(a => cursor !== null && a.id <= cursor)) throw new ActivityServerError("unavailable", 503); return result;
    },
    async summary(year: number) {
      if (!Number.isInteger(year) || year < 1970 || year > 2199) throw new ActivityServerError("invalid_request", 400);
      await rate("read"); const result = parse(parseActivitySummary, await rpc("pb_memory_summary", { p_actor: actor, p_year: year })); if (result.year !== year) throw new ActivityServerError("unavailable", 503); return result;
    },
    async chapters() { await rate("read"); return parse(parseMemoryChapters, await rpc("pb_memory_chapters_list", { p_actor: actor })); },
    async putChapter(input: ChapterInput) {
      const body = validate(validateChapterInput, input); await rate("write"); const result = parse(parseMemoryChapter, await rpc("pb_memory_chapter_put", { p_actor: actor, p_id: body.id, p_expected: body.expectedRevision, p_title: body.title }));
      if (result.id !== body.id || result.title !== body.title || result.revision !== body.expectedRevision + 1) throw new ActivityServerError("unavailable", 503); return result;
    },
    async annotate(input: ActivityAnnotation) {
      const body = validate(validateActivityAnnotation, input); await rate("write"); const result = parse(parseMemoryActivity, await rpc("pb_memory_annotate", { p_actor: actor, p_id: body.id, p_expected: body.expectedRevision, p_chapter: body.chapterId, p_occasion: body.occasion }));
      if (result.id !== body.id || !result.mine || result.annotation?.revision !== body.expectedRevision + 1 || result.annotation.chapterId !== body.chapterId || result.annotation.occasion !== body.occasion) throw new ActivityServerError("unavailable", 503); return result;
    },
    async deleteChapter(id: string, expectedRevision: number) {
      validate(cloudUuid, id); if (!Number.isInteger(expectedRevision) || expectedRevision < 0 || expectedRevision > 2147483646) throw new ActivityServerError("invalid_request", 400);
      await rate("write"); const result = await rpc("pb_memory_chapter_delete", { p_actor: actor, p_id: id, p_expected: expectedRevision }); if (result.deleted !== true) throw new ActivityServerError("unavailable", 503); return { deleted: true as const };
    },
  };
}
export type ActivityStore = Awaited<ReturnType<typeof createActivityStore>>;
