import { createClient } from "@supabase/supabase-js";
import { cloudUuid } from "../projects/cloud-contract";
import { CHALLENGE_LIMITS, CHALLENGE_DISCOVERY, challengeHash, challengeListLimit, parseChallengeList, prepareChallengeCreate, validateChallengeCreate, validateChallengeSubmission, type ChallengeList, type ChallengeCreate, type ChallengeSubmission, type ChallengeView, type ChallengeResult, type PartialReveal, type PartialResult } from "../memories/challenge-contract";
import { supabaseServiceOrigin } from "./cron-auth";
import type { ProjectStorePorts } from "./project-store";
import { CHALLENGE_PARTIALS, parsePartialDetail, parsePartialList, parseChallengeUploadList, type ChallengeUploadList, type PartialDetail, type PartialList } from "../memories/challenge-contract";

export class ChallengeServerError extends Error { constructor(readonly code: string, readonly status: number) { super(code); } }
export interface ChallengeStore {
  readonly storyVersion?: 0 | 1;
  listUploads(challengeId: string, after?: string, limit?: number): Promise<ChallengeUploadList>;
  listPartials(challengeId: string, after?: string, limit?: number): Promise<PartialList>;
  partialDetail(partialId: string, digest: string): Promise<PartialDetail>;
  list(projectId: string, after?: string, limit?: number): Promise<ChallengeList>;
  create(projectId: string, input: ChallengeCreate): Promise<ChallengeView>;
  view(challengeId: string): Promise<ChallengeResult>;
  manage(challengeId: string, action: "accept" | "decline" | "open" | "cancel" | "withdraw"): Promise<ChallengeView>;
  submit(challengeId: string, input: ChallengeSubmission): Promise<ChallengeView>;
  proposePartial(challengeId: string, partialId: string, contributors: readonly string[]): Promise<PartialReveal>;
  partial(partialId: string): Promise<PartialResult>;
  consentPartial(partialId: string, digest: string, consent: boolean): Promise<PartialReveal>;
  commitPartial(partialId: string, digest: string): Promise<PartialReveal>;
}
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new ChallengeServerError("unavailable", 503); return value as Record<string, unknown>; }
const date = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
function view(value: unknown, expected: string): ChallengeResult {
  try {
    const v = object(value);
    if (v.unsupported === true) { if (v.id !== expected || v.reason !== "recipe_unavailable") throw new Error(); return { id: expected, projectId: cloudUuid(v.projectId), unsupported: true, reason: "recipe_unavailable" }; }
    if (v.id !== expected || !["draft", "open", "revealed", "cancelled", "expired"].includes(v.status as string) || !["immediate", "all_submitted"].includes(v.policy as string) || !date(v.expiresAt) || v.revealedAt !== null && !date(v.revealedAt) || typeof v.accessLost !== "boolean" || !Array.isArray(v.members) || v.members.length < 2 || v.members.length > 4 || !Array.isArray(v.assignments) || !Array.isArray(v.visibleSources) || v.visibleSources.length > 16) throw new Error();
    const members = v.members.map(item => { const m = object(item); if (!["A", "B", "C", "D"].includes(m.role as string) || !["invited", "accepted", "declined", "withdrawn"].includes(m.status as string) || typeof m.submitted !== "boolean") throw new Error(); return { userId: cloudUuid(m.userId), role: m.role as string, status: m.status as ChallengeView["members"][number]["status"], submitted: m.submitted }; });
    const shape = prepareChallengeCreate({ id: expected, design: v.design, policy: v.policy, expiresAt: v.expiresAt, members: members.map(m => ({ userId: m.userId, role: m.role })), ...(Object.hasOwn(v, "story") ? { story: v.story } : {}) });
    if (JSON.stringify(v.assignments) !== JSON.stringify(shape.assignments)) {
      if (!Array.isArray(v.assignments) || v.assignments.length !== shape.assignments.length || v.assignments.some((item, i) => { const a = object(item), b = shape.assignments[i]; return a.slot !== b.slot || a.userId !== b.userId || a.sourceIndex !== b.sourceIndex || Object.keys(a).length !== 3; })) throw new Error();
    }
    const seen = new Set<string>();
    const visibleSources = v.visibleSources.map(item => { const s = object(item), key = `${s.userId}:${s.sourceIndex}`; if (seen.has(key) || !shape.assignments.some(a => a.userId === s.userId && a.sourceIndex === s.sourceIndex)) throw new Error(); seen.add(key); return { userId: cloudUuid(s.userId), sourceIndex: s.sourceIndex as number, assetId: cloudUuid(s.assetId) }; });
    return { id: expected, projectId: cloudUuid(v.projectId), status: v.status as ChallengeView["status"], policy: shape.policy, recipeHash: challengeHash(v.recipeHash), design: shape.design, expiresAt: v.expiresAt, revealedAt: v.revealedAt as string | null, revealHash: v.revealHash === null ? null : challengeHash(v.revealHash), accessLost: v.accessLost, members, assignments: shape.assignments, visibleSources, ...(shape.story ? { story: shape.story } : {}) };
  } catch { throw new ChallengeServerError("unavailable", 503); }
}
function current(value: ChallengeResult): ChallengeView { if ("unsupported" in value) throw new ChallengeServerError("update_required", 409); return value; }
function bodyPublic(body: ChallengeCreate): ChallengeCreate { return { id: body.id, design: body.design, policy: body.policy, expiresAt: body.expiresAt, members: body.members, ...(body.story ? { story: body.story } : {}) }; }
function partial(value: unknown, expected: string): PartialResult {
  try {
    const p = object(value);
    if (p.unsupported === true) { if (p.id !== expected || p.reason !== "recipe_unavailable") throw new Error(); return { id: expected, challengeId: cloudUuid(p.challengeId), unsupported: true, reason: "recipe_unavailable" }; }
    if (p.id !== expected || !["pending", "rejected", "revealed"].includes(p.status as string) || typeof p.accessLost !== "boolean" || !Array.isArray(p.contributors) || p.contributors.length < 1 || p.contributors.length > 4) throw new Error();
    const contributors = p.contributors.map(cloudUuid); if (new Set(contributors).size !== contributors.length) throw new Error();
    return { id: expected, digest: challengeHash(p.digest), status: p.status as PartialReveal["status"], contributors, accessLost: p.accessLost };
  } catch { throw new ChallengeServerError("unavailable", 503); }
}
function currentPartial(value: PartialResult): PartialReveal { if ("unsupported" in value) throw new ChallengeServerError("update_required", 409); return value; }
export async function createChallengeStore(accessToken: string, env: Record<string, string | undefined> = process.env, ports?: ProjectStorePorts): Promise<ChallengeStore> {
  const url = supabaseServiceOrigin(env.NEXT_PUBLIC_SUPABASE_URL), key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (env.PB_CHALLENGES_ENABLED !== "true" || env.PB_CLOUD_PROJECTS_ENABLED !== "true" || !url || !key?.trim()) throw new ChallengeServerError("unavailable", 503);
  if (!accessToken?.trim() || accessToken.length > 16384) throw new ChallengeServerError("access_denied", 401);
  if (!ports) {
    const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: (input, init) => fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) }) } });
    ports = { async authenticate(token) { const { data, error } = await client.auth.getUser(token); return error ? null : data.user?.id ?? null; }, rpc: async (name, args) => client.rpc(name, args) };
  }
  let actor: string; try { actor = cloudUuid(await ports.authenticate(accessToken)); } catch { throw new ChallengeServerError("access_denied", 401); }
  const rpc = async (name: string, args: Record<string, unknown> = {}) => {
    if (new TextEncoder().encode(JSON.stringify(args)).length > CHALLENGE_LIMITS.requestBytes) throw new ChallengeServerError("invalid_request", 400);
    const { data, error } = await ports.rpc(name, args).catch(() => { throw new ChallengeServerError("unavailable", 503); });
    if (error) {
      const codes: Record<string, [string, number]> = { PB_CHALLENGE_DENIED: ["access_denied", 403], PB_PROJECT_DENIED: ["access_denied", 403], PB_CHALLENGE_CONFLICT: ["conflict", 409], PB_CHALLENGE_EXPIRED: ["expired", 410], PB_CHALLENGE_NOT_READY: ["not_ready", 409], PB_CHALLENGE_CAPACITY: ["capacity", 409], PB_CHALLENGE_INVALID: ["invalid_request", 400], PB_CHALLENGE_UPDATE_REQUIRED: ["update_required", 409] };
      const [code, status] = codes[error.message] ?? ["unavailable", 503]; throw new ChallengeServerError(code, status);
    }
    if (data === null || new TextEncoder().encode(JSON.stringify(data)).length > CHALLENGE_LIMITS.responseBytes) throw new ChallengeServerError("unavailable", 503); return data;
  };
  const capabilities = object(await rpc("pb_challenge_capabilities"));
  if (capabilities.ready !== true || capabilities.version !== CHALLENGE_LIMITS.version || capabilities.recipeVersion !== 1 || capabilities.members !== 4 || capabilities.slots !== 16 || capabilities.sourcesPerMember !== 4 || capabilities.proposals !== 20 || capabilities.challengesPerProject !== 32) throw new ChallengeServerError("unavailable", 503);
  return {
    storyVersion: capabilities.storyVersion === 1 ? 1 : 0,
    async listUploads(challengeId, after, limit) {
      const id = cloudUuid(challengeId), cursor = after === undefined ? null : cloudUuid(after), maximum = challengeListLimit(limit);
      if (capabilities.ownUploadsVersion !== 1 || capabilities.uploadListMaximum !== 20) throw new ChallengeServerError("unavailable", 503);
      const result = await rpc("pb_challenge_upload_list", { p_actor: actor, p_challenge: id, p_after: cursor, p_limit: maximum });
      try { return parseChallengeUploadList(result, actor, after, maximum); } catch { throw new ChallengeServerError("unavailable", 503); }
    },
    async listPartials(challengeId, after, limit) {
      const id = cloudUuid(challengeId), cursor = after === undefined ? null : cloudUuid(after), maximum = challengeListLimit(limit);
      if (capabilities.partialVersion !== CHALLENGE_PARTIALS.version || capabilities.partialListMaximum !== CHALLENGE_PARTIALS.maximum) throw new ChallengeServerError("unavailable", 503);
      const result = await rpc("pb_challenge_partial_list", { p_actor: actor, p_challenge: id, p_after: cursor, p_limit: maximum });
      try { return parsePartialList(result, id, actor, after, maximum); } catch { throw new ChallengeServerError("unavailable", 503); }
    },
    async partialDetail(partialId, digest) {
      const id = cloudUuid(partialId), hash = challengeHash(digest);
      if (capabilities.partialVersion !== CHALLENGE_PARTIALS.version || capabilities.partialListMaximum !== CHALLENGE_PARTIALS.maximum) throw new ChallengeServerError("unavailable", 503);
      const result = await rpc("pb_challenge_partial_details", { p_actor: actor, p_partial: id, p_digest: hash });
      try { return parsePartialDetail(result, id, hash, actor); } catch { throw new ChallengeServerError("unavailable", 503); }
    },
    async list(projectId, after, limit) {
      const project = cloudUuid(projectId), cursor = after === undefined ? null : cloudUuid(after), maximum = challengeListLimit(limit);
      if (capabilities.discoveryVersion !== CHALLENGE_DISCOVERY.version || capabilities.listMaximum !== CHALLENGE_DISCOVERY.maximum) throw new ChallengeServerError("unavailable", 503);
      const result = await rpc("pb_challenge_list", { p_actor: actor, p_project: project, p_after: cursor, p_limit: maximum });
      try { return parseChallengeList(result, project, after, maximum); } catch { throw new ChallengeServerError("unavailable", 503); }
    },
    async create(projectId, input) {
      const body = prepareChallengeCreate(input);
      if (body.story && capabilities.storyVersion !== 1) throw new ChallengeServerError("update_required", 409);
      const result = current(view(await rpc("pb_challenge_create", { p_actor: actor, p_project: cloudUuid(projectId), p_body: body }), body.id));
      const expected = validateChallengeCreate(bodyPublic(body));
      if (result.projectId !== projectId || JSON.stringify(validateChallengeCreate({ id: result.id, design: result.design, policy: result.policy, expiresAt: result.expiresAt, members: result.members.map(m => ({ userId: m.userId, role: m.role })), ...(result.story ? { story: result.story } : {}) })) !== JSON.stringify(expected)) throw new ChallengeServerError("unavailable", 503);
      return result;
    },
    async view(id) { return view(await rpc("pb_challenge_view", { p_actor: actor, p_challenge: cloudUuid(id) }), id); },
    async manage(id, action) { if (!["accept", "decline", "open", "cancel", "withdraw"].includes(action)) throw new ChallengeServerError("invalid_request", 400); return current(view(await rpc("pb_challenge_manage", { p_actor: actor, p_challenge: cloudUuid(id), p_action: action }), id)); },
    async submit(id, input) { return current(view(await rpc("pb_challenge_submit", { p_actor: actor, p_challenge: cloudUuid(id), p_body: validateChallengeSubmission(input) }), id)); },
    async proposePartial(id, partialId, contributors) { if (!Array.isArray(contributors) || contributors.length < 1 || contributors.length > 4 || new Set(contributors).size !== contributors.length) throw new ChallengeServerError("invalid_request", 400); return currentPartial(partial(await rpc("pb_challenge_propose_partial", { p_actor: actor, p_challenge: cloudUuid(id), p_partial: cloudUuid(partialId), p_users: contributors.map(cloudUuid) }), partialId)); },
    async partial(id) { return partial(await rpc("pb_challenge_partial_view", { p_actor: actor, p_partial: cloudUuid(id) }), id); },
    async consentPartial(id, digest, consent) { if (typeof consent !== "boolean") throw new ChallengeServerError("invalid_request", 400); return currentPartial(partial(await rpc("pb_challenge_partial_consent", { p_actor: actor, p_partial: cloudUuid(id), p_digest: challengeHash(digest), p_consent: consent }), id)); },
    async commitPartial(id, digest) { return currentPartial(partial(await rpc("pb_challenge_commit_partial", { p_actor: actor, p_partial: cloudUuid(id), p_digest: challengeHash(digest) }), id)); },
  };
}
