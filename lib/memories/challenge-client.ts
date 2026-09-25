import { cloudTimestamp, cloudUuid } from "../projects/cloud-contract";
import type { CloudIdentity } from "../projects/cloud-client";
import { parsePartialDetail, parsePartialList, parseChallengeUploadList } from "./challenge-contract";
import { CHALLENGE_LIMITS, challengeHash, challengeListLimit, parseChallengeList, prepareChallengeCreate, validateChallengeCreate, validateChallengeSubmission, type ChallengeCreate, type ChallengeResult, type ChallengeSubmission, type ChallengeView, type PartialResult, type PartialReveal } from "./challenge-contract";

export class ChallengeClientError extends Error {
  constructor(readonly code: string, readonly status = 0, readonly retryAfterSeconds?: number) { super(code); this.name = "ChallengeClientError"; }
}
export interface ChallengeClientOptions {
  appOrigin: string; identity(): CloudIdentity | null; accessToken(): Promise<string | null>;
  fetch?: typeof fetch; timeoutMs?: number;
}
const invalid = (): never => { throw new ChallengeClientError("invalid_response"); };
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).some(key => typeof key !== "string" || !("value" in Object.getOwnPropertyDescriptor(value, key)!))) return invalid();
  return value as Record<string, unknown>;
}
function list(value: unknown, min: number, max: number): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max || Reflect.ownKeys(value).length !== value.length + 1) return invalid();
  for (let i = 0; i < value.length; i++) if (!("value" in (Object.getOwnPropertyDescriptor(value, String(i)) ?? {}))) return invalid();
  return value;
}
export function parseChallengeResponse(value: unknown, expectedId: string): ChallengeResult {
  try {
    cloudUuid(expectedId); const v = object(value);
    if (v.id !== expectedId) return invalid();
    if (v.unsupported === true) {
      if (v.reason !== "recipe_unavailable") return invalid();
      return { id: expectedId, projectId: cloudUuid(v.projectId), unsupported: true, reason: "recipe_unavailable" };
    }
    if (!["draft", "open", "revealed", "cancelled", "expired"].includes(v.status as string) || typeof v.accessLost !== "boolean") return invalid();
    const members = list(v.members, 2, 4).map(value => {
      const m = object(value);
      if (!["A", "B", "C", "D"].includes(m.role as string) || !["invited", "accepted", "declined", "withdrawn"].includes(m.status as string) || typeof m.submitted !== "boolean") return invalid();
      return { userId: cloudUuid(m.userId), role: m.role as string, status: m.status as ChallengeView["members"][number]["status"], submitted: m.submitted };
    });
    const shape = prepareChallengeCreate({ id: expectedId, design: v.design, policy: v.policy, expiresAt: cloudTimestamp(v.expiresAt), members: members.map(m => ({ userId: m.userId, role: m.role })), ...(Object.hasOwn(v, "story") ? { story: v.story } : {}) });
    const assignments = list(v.assignments, 2, CHALLENGE_LIMITS.slots);
    if (assignments.length !== shape.assignments.length || assignments.some((value, index) => { const a = object(value), b = shape.assignments[index]; return a.slot !== b.slot || a.userId !== b.userId || a.sourceIndex !== b.sourceIndex; })) return invalid();
    const used = new Set<string>(), assets = new Set<string>();
    const visibleSources = list(v.visibleSources, 0, CHALLENGE_LIMITS.slots).map(value => {
      const s = object(value), userId = cloudUuid(s.userId), assetId = cloudUuid(s.assetId), key = `${userId}:${s.sourceIndex}`;
      if (used.has(key) || assets.has(assetId) || !shape.assignments.some(a => a.userId === userId && a.sourceIndex === s.sourceIndex) || !members.some(m => m.userId === userId && m.submitted)) return invalid();
      used.add(key); assets.add(assetId); return { userId, sourceIndex: s.sourceIndex as number, assetId };
    });
    return { id: expectedId, projectId: cloudUuid(v.projectId), status: v.status as ChallengeView["status"], policy: shape.policy, recipeHash: challengeHash(v.recipeHash), design: shape.design, expiresAt: shape.expiresAt, revealedAt: v.revealedAt === null ? null : cloudTimestamp(v.revealedAt), revealHash: v.revealHash === null ? null : challengeHash(v.revealHash), accessLost: v.accessLost, members, assignments: shape.assignments, visibleSources, ...(shape.story ? { story: shape.story } : {}) };
  } catch { return invalid(); }
}
export function parsePartialResponse(value: unknown, expectedId: string): PartialResult {
  try {
    cloudUuid(expectedId); const p = object(value); if (p.id !== expectedId) return invalid();
    if (p.unsupported === true) {
      if (p.reason !== "recipe_unavailable") return invalid();
      return { id: expectedId, challengeId: cloudUuid(p.challengeId), unsupported: true, reason: "recipe_unavailable" };
    }
    if (!["pending", "rejected", "revealed"].includes(p.status as string) || typeof p.accessLost !== "boolean") return invalid();
    const contributors = list(p.contributors, 1, CHALLENGE_LIMITS.members).map(cloudUuid);
    if (new Set(contributors).size !== contributors.length) return invalid();
    return { id: expectedId, digest: challengeHash(p.digest), status: p.status as PartialReveal["status"], contributors, accessLost: p.accessLost };
  } catch { return invalid(); }
}
function current(value: ChallengeResult): ChallengeView { if ("unsupported" in value) throw new ChallengeClientError("update_required", 409); return value; }
function currentPartial(value: PartialResult): PartialReveal { if ("unsupported" in value) throw new ChallengeClientError("update_required", 409); return value; }
function creationShape(view: ChallengeView): ChallengeCreate { return validateChallengeCreate({ id: view.id, design: view.design, policy: view.policy, expiresAt: view.expiresAt, members: view.members.map(m => ({ userId: m.userId, role: m.role })), ...(view.story ? { story: view.story } : {}) }); }

export function createChallengeClient(options: ChallengeClientOptions) {
  let origin: URL; try { origin = new URL(options.appOrigin); } catch { throw new ChallengeClientError("invalid_configuration"); }
  if (origin.origin !== options.appOrigin || (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))) || (typeof location !== "undefined" && location.origin !== origin.origin)) throw new ChallengeClientError("invalid_configuration");
  const initial = options.identity(); if (!initial) throw new ChallengeClientError("account_changed");
  const ownerId = cloudUuid(initial.ownerId), epoch = initial.epoch, timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(epoch) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) throw new ChallengeClientError("invalid_configuration");
  const lifetime = new AbortController(), fetcher = options.fetch ?? fetch, endpoint = `${origin.origin}/api/challenges`;
  const frozen = new Map<string, string>(), partials = new Map<string, string>();
  function assertActive(signal?: AbortSignal) {
    const identity = options.identity();
    if (!identity || identity.ownerId !== ownerId || identity.epoch !== epoch) { lifetime.abort(); throw new ChallengeClientError("account_changed"); }
    if (signal?.aborted || lifetime.signal.aborted) throw new ChallengeClientError("cancelled");
  }
  function remember(cache: Map<string, string>, id: string, fingerprint: string) {
    const prior = cache.get(id); if (prior !== undefined && prior !== fingerprint) return invalid();
    if (!cache.has(id) && cache.size >= 64) cache.delete(cache.keys().next().value!);
    cache.set(id, fingerprint);
  }
  function view(value: unknown, id: string): ChallengeResult {
    const result = parseChallengeResponse(value, id);
    if (!("unsupported" in result)) remember(frozen, id, JSON.stringify({ projectId: result.projectId, recipeHash: result.recipeHash, recipe: creationShape(result) }));
    return result;
  }
  function partial(value: unknown, id: string): PartialResult {
    const result = parsePartialResponse(value, id);
    if (!("unsupported" in result)) remember(partials, id, JSON.stringify({ digest: result.digest, contributors: [...result.contributors].sort() }));
    return result;
  }
  async function request(operation: string, data: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    assertActive(signal); const body = JSON.stringify({ operation, ...data });
    if (new TextEncoder().encode(body).byteLength > CHALLENGE_LIMITS.requestBytes) throw new ChallengeClientError("invalid_request");
    const deadline = new AbortController(), active = AbortSignal.any([lifetime.signal, deadline.signal, ...(signal ? [signal] : [])]), timer = setTimeout(() => deadline.abort(), timeoutMs);
    let abort: (() => void) | undefined;
    const interrupted = new Promise<never>((_, reject) => { abort = () => reject(new ChallengeClientError(deadline.signal.aborted ? "timeout" : "cancelled")); active.addEventListener("abort", abort, { once: true }); });
    const work = async () => {
      const token = await options.accessToken(); assertActive(active);
      if (!token || token.length > 16_384 || /[\s,]/.test(token)) throw new ChallengeClientError("access_denied", 401);
      const response = await fetcher(endpoint, { method: "POST", credentials: "omit", redirect: "error", cache: "no-store", signal: active, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body }); assertActive(active);
      if (response.redirected || (response.url && response.url !== endpoint)) return invalid();
      const length = response.headers.get("content-length");
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > CHALLENGE_LIMITS.responseBytes)) { void response.body?.cancel().catch(() => undefined); throw new ChallengeClientError("response_too_large"); }
      if (!response.body) return invalid();
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
      const cancel = () => { void reader.cancel().catch(() => undefined); }; active.addEventListener("abort", cancel, { once: true });
      try {
        while (true) {
          assertActive(active); const next = await reader.read(); assertActive(active); if (next.done) break;
          size += next.value.byteLength; if (size > CHALLENGE_LIMITS.responseBytes || chunks.length >= 4096) throw new ChallengeClientError("response_too_large"); chunks.push(next.value);
        }
      } finally { active.removeEventListener("abort", cancel); void reader.cancel().catch(() => undefined); reader.releaseLock(); }
      const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      let value: unknown; try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { return invalid(); }
      if (!response.ok) {
        const code = object(value).error, allowed = ["access_denied", "origin_denied", "invalid_request", "conflict", "expired", "not_ready", "capacity", "update_required", "rate_limited", "unavailable"];
        const retry = Number(response.headers.get("retry-after"));
        throw new ChallengeClientError(typeof code === "string" && allowed.includes(code) ? code : "unavailable", response.status, response.status === 429 && Number.isSafeInteger(retry) && retry >= 1 && retry <= 60 ? retry : undefined);
      }
      return value;
    };
    try { const value = await Promise.race([work(), interrupted]); assertActive(signal); return value; }
    catch (error) { assertActive(signal); if (error instanceof ChallengeClientError) throw error; throw new ChallengeClientError("network_error"); }
    finally { clearTimeout(timer); if (abort) active.removeEventListener("abort", abort); }
  }
  function typed<Args extends unknown[], Result>(fn: (...args: Args) => Promise<Result>) {
    return async (...args: Args): Promise<Result> => { try { return await fn(...args); } catch (error) { if (error instanceof ChallengeClientError) throw error; throw new ChallengeClientError(error instanceof Error && error.message === "invalid_request" ? "invalid_request" : "invalid_response"); } };
  }
  return {
    ownerId, assertActive, close() { lifetime.abort(); frozen.clear(); partials.clear(); },
    listUploads: typed(async (challengeId: string, after?: string, limit?: number, signal?: AbortSignal) => {
      cloudUuid(challengeId); if (after !== undefined) cloudUuid(after); const maximum = challengeListLimit(limit);
      const result = await request("listUploads", { challengeId, ...(after === undefined ? {} : { after }), limit: maximum }, signal);
      try { return parseChallengeUploadList(result, ownerId, after, maximum); } catch { return invalid(); }
    }),
    listPartials: typed(async (challengeId: string, after?: string, limit?: number, signal?: AbortSignal) => {
      cloudUuid(challengeId); if (after !== undefined) cloudUuid(after); const maximum = challengeListLimit(limit);
      const result = await request("listPartials", { challengeId, ...(after === undefined ? {} : { after }), limit: maximum }, signal);
      try { return parsePartialList(result, challengeId, ownerId, after, maximum); } catch { return invalid(); }
    }),
    partialDetail: typed(async (partialId: string, digest: string, signal?: AbortSignal) => {
      cloudUuid(partialId); challengeHash(digest);
      const value = await request("partialDetail", { partialId, digest }, signal);
      try {
        const result = parsePartialDetail(value, partialId, digest, ownerId);
        if (!("unsupported" in result)) remember(partials, partialId, JSON.stringify({ digest: result.digest, contributors: result.contributors.map(c => c.userId).sort() }));
        return result;
      } catch { return invalid(); }
    }),
    capabilities: typed(async (signal?: AbortSignal) => {
      const value = object(await request("capabilities", {}, signal)), limits = object(value.limits);
      if (value.enabled !== true || value.version !== CHALLENGE_LIMITS.version || Object.entries(CHALLENGE_LIMITS).some(([key, limit]) => limits[key] !== limit)) return invalid();
      if (value.storyVersion !== undefined && value.storyVersion !== 0 && value.storyVersion !== 1) return invalid();
      return { enabled: true as const, version: CHALLENGE_LIMITS.version, limits: CHALLENGE_LIMITS, storyVersion: (value.storyVersion ?? 0) as 0 | 1 };
    }),
    list: typed(async (projectId: string, after?: string, limit?: number, signal?: AbortSignal) => {
      cloudUuid(projectId); if (after !== undefined) cloudUuid(after); const maximum = challengeListLimit(limit);
      const result = await request("list", { projectId, ...(after !== undefined ? { after } : {}), limit: maximum }, signal);
      try { return parseChallengeList(result, projectId, after, maximum); } catch { return invalid(); }
    }),
    create: typed(async (projectId: string, input: ChallengeCreate, signal?: AbortSignal) => {
      const challenge = validateChallengeCreate(input), result = current(view(await request("create", { projectId: cloudUuid(projectId), challenge }, signal), challenge.id));
      if (result.projectId !== projectId || JSON.stringify(creationShape(result)) !== JSON.stringify(challenge)) return invalid(); return result;
    }),
    view: typed(async (challengeId: string, signal?: AbortSignal) => view(await request("view", { challengeId: cloudUuid(challengeId) }, signal), challengeId)),
    manage: typed(async (challengeId: string, action: "accept" | "decline" | "open" | "cancel" | "withdraw", signal?: AbortSignal) => {
      if (!["accept", "decline", "open", "cancel", "withdraw"].includes(action)) throw new ChallengeClientError("invalid_request");
      return current(view(await request("manage", { challengeId: cloudUuid(challengeId), action }, signal), challengeId));
    }),
    submit: typed(async (challengeId: string, input: ChallengeSubmission, signal?: AbortSignal) => current(view(await request("submit", { challengeId: cloudUuid(challengeId), submission: validateChallengeSubmission(input) }, signal), challengeId))),
    proposePartial: typed(async (challengeId: string, partialId: string, contributors: readonly string[], signal?: AbortSignal) => {
      const users = list(contributors, 1, CHALLENGE_LIMITS.members).map(cloudUuid); if (new Set(users).size !== users.length) throw new ChallengeClientError("invalid_request");
      const result = currentPartial(partial(await request("proposePartial", { challengeId: cloudUuid(challengeId), partialId: cloudUuid(partialId), contributors: users }, signal), partialId));
      if (JSON.stringify([...result.contributors].sort()) !== JSON.stringify([...users].sort())) return invalid(); return result;
    }),
    partial: typed(async (partialId: string, signal?: AbortSignal) => partial(await request("partial", { partialId: cloudUuid(partialId) }, signal), partialId)),
    consentPartial: typed(async (partialId: string, digest: string, consent: boolean, signal?: AbortSignal) => {
      if (typeof consent !== "boolean") throw new ChallengeClientError("invalid_request");
      const result = currentPartial(partial(await request("consentPartial", { partialId: cloudUuid(partialId), digest: challengeHash(digest), consent }, signal), partialId));
      if (result.digest !== digest || (!consent && result.status !== "rejected")) return invalid(); return result;
    }),
    commitPartial: typed(async (partialId: string, digest: string, signal?: AbortSignal) => {
      const result = currentPartial(partial(await request("commitPartial", { partialId: cloudUuid(partialId), digest: challengeHash(digest) }, signal), partialId));
      if (result.digest !== digest || result.status !== "revealed" || result.accessLost) return invalid(); return result;
    }),
  };
}
export type ChallengeClient = ReturnType<typeof createChallengeClient>;
