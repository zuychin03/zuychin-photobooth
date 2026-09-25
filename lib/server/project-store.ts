import { createClient } from "@supabase/supabase-js";
import { CLOUD_PROJECT_LIMITS, PROJECT_BUCKET, cloudUuid, projectAssetPath, validateCloudAsset, type CloudAssetInput, type ProjectAssetAccess, type ProjectUploadAuthorisation, parseCloudProject, parseCloudMember, parseCloudProjectView, parseProjectReservation, parseProjectFinalisationStatus, parseProjectFinalisationClaim, type CloudProjectSummary, type CloudProjectMember, type CloudProjectView, type ProjectReservation, type ProjectFinalisationStatus, type ProjectFinalisationClaim, type ProjectFinalisationOutcome, type ProjectCleanupClaim, parseProjectCleanupClaim } from "../projects/cloud-contract";
import { supabaseServiceOrigin } from "./cron-auth";
import { PROJECT_API_LIMITS, parseCloudProjectList, type CloudProjectList, type ProjectRateOperation } from "../projects/cloud-contract";

export class ProjectServerError extends Error {
  constructor(readonly code: string, readonly status: number, readonly retryAfterSeconds?: number) { super(code); }
}
type Rpc = (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string; code?: string } | null }>;
export interface ProjectStorePorts {
  authenticate(token: string): Promise<string | null>;
  rpc: Rpc;
}
export interface ProjectStore {
  rate(operation: ProjectRateOperation): Promise<void>;
  list(after?: string, limit?: number): Promise<CloudProjectList>;
  view(projectId: string): Promise<CloudProjectView>;
  create(input: { id: string; kind: "personal" | "friend"; title: string; maxBytes: number }): Promise<CloudProjectSummary>;
  member(projectId: string, userId: string, action: "invite" | "accept" | "revoke"): Promise<CloudProjectMember>;
  reserve(projectId: string, input: CloudAssetInput): Promise<ProjectReservation>;
  enqueueFinalisation(assetId: string): Promise<ProjectFinalisationStatus>;
  finalisationStatus(assetId: string): Promise<ProjectFinalisationStatus>;
  authoriseUpload(projectId: string, assetId: string): Promise<ProjectUploadAuthorisation>;
  resolveAsset(assetId: string): Promise<ProjectAssetAccess>;
  delete(projectId: string, assetId?: string): Promise<{ pending: boolean }>;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProjectServerError("unavailable", 503);
  return value as Record<string, unknown>;
}
function response<T>(parser: (value: unknown) => T, value: unknown): T { try { return parser(value); } catch { throw new ProjectServerError("unavailable", 503); } }
function finalisationResult(value: unknown, asset: string): ProjectFinalisationStatus {
  const result = response(parseProjectFinalisationStatus, value); if (result.assetId !== asset) throw new ProjectServerError("unavailable", 503); return result;
}
export async function createProjectStore(accessToken: string, env: Record<string, string | undefined> = process.env, ports?: ProjectStorePorts): Promise<ProjectStore> {
  const url = supabaseServiceOrigin(env.NEXT_PUBLIC_SUPABASE_URL), key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (env.PB_CLOUD_PROJECTS_ENABLED !== "true" || !url || !key?.trim()) throw new ProjectServerError("unavailable", 503);
  if (!accessToken?.trim() || accessToken.length > 16384) throw new ProjectServerError("access_denied", 401);
  if (!ports) {
    const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: (input, init) => fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) }) } });
    ports = {
      async authenticate(token) { const { data, error } = await client.auth.getUser(token); return error ? null : data.user?.id ?? null; },
      rpc: async (name, args) => client.rpc(name, args),
    };
  }
  let actor: string;
  try { const id = await ports.authenticate(accessToken); if (!id) throw new Error(); actor = cloudUuid(id); }
  catch { throw new ProjectServerError("access_denied", 401); }
  const rpc = async (name: string, args: Record<string, unknown> = {}) => {
    const { data, error } = await ports.rpc(name, args).catch(() => { throw new ProjectServerError("unavailable", 503); });
    if (error) {
      const mapping: Record<string, [string, number]> = { PB_PROJECT_DENIED: ["access_denied", 403], PB_PROJECT_CAPACITY: ["capacity", 409], PB_PROJECT_CONFLICT: ["conflict", 409], PB_PROJECT_EXPIRED: ["expired", 410], PB_PROJECT_PROTECTED: ["protected_unavailable", 409], PB_PROJECT_INVALID: ["invalid_request", 400], PB_PROJECT_LEASE: ["lease_lost", 409], PB_PROJECT_NOT_READY: ["not_ready", 409] };
      const mapped = mapping[error.message] ?? ["unavailable", 503]; throw new ProjectServerError(mapped[0] as string, mapped[1] as number);
    }
    return object(data);
  };
  const capabilities = await rpc("pb_project_capabilities");
  if (capabilities.version !== CLOUD_PROJECT_LIMITS.version || capabilities.ready !== true || capabilities.members !== 4 || capabilities.files !== 24 || capabilities.projectBytes !== CLOUD_PROJECT_LIMITS.projectBytes || capabilities.readSeconds !== 300 || capabilities.uploadSeconds !== 7200 || capabilities.finalisationVersion !== 1 || capabilities.apiVersion !== PROJECT_API_LIMITS.version) throw new ProjectServerError("unavailable", 503);
  return {
    async rate(operation) {
      if (!["read", "write", "upload"].includes(operation)) throw new ProjectServerError("invalid_request", 400);
      const data = await rpc("pb_project_rate", { p_actor: actor, p_operation: operation });
      if (typeof data.allowed !== "boolean" || !Number.isSafeInteger(data.retryAfterSeconds) || (data.allowed ? data.retryAfterSeconds !== 0 : (data.retryAfterSeconds as number) < 1 || (data.retryAfterSeconds as number) > 60)) throw new ProjectServerError("unavailable", 503);
      if (!data.allowed) throw new ProjectServerError("rate_limited", 429, data.retryAfterSeconds as number);
    },
    async list(after, limit = PROJECT_API_LIMITS.listDefault) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > PROJECT_API_LIMITS.listMaximum) throw new ProjectServerError("invalid_request", 400);
      let cursor: string | null = null;
      try { if (after !== undefined) cursor = cloudUuid(after); } catch { throw new ProjectServerError("invalid_request", 400); }
      const result = response(parseCloudProjectList, await rpc("pb_project_list", { p_actor: actor, p_after: cursor, p_limit: limit }));
      if (result.projects.length > limit || (result.nextCursor !== null && result.projects.length !== limit) || result.projects.some(p => (cursor !== null && p.id <= cursor) || (p.ownerId === actor && p.membership !== "accepted"))) throw new ProjectServerError("unavailable", 503);
      return result;
    },
    async view(project) {
      const result = response(parseCloudProjectView, await rpc("pb_project_view", { p_actor: actor, p_project: cloudUuid(project) }));
      if (result.project.id !== project || !result.members.some(m => m.userId === actor && m.status === "accepted")) throw new ProjectServerError("unavailable", 503); return result;
    },
    async create(input) {
      cloudUuid(input.id);
      if (!["personal", "friend"].includes(input.kind) || typeof input.title !== "string" || input.title.length < 1 || [...input.title].length > 100 || !Number.isSafeInteger(input.maxBytes) || input.maxBytes < CLOUD_PROJECT_LIMITS.assetBytes || input.maxBytes > CLOUD_PROJECT_LIMITS.projectBytes) throw new ProjectServerError("invalid_request", 400);
      const result = response(parseCloudProject, await rpc("pb_project_create", { p_actor: actor, p_project: input.id, p_kind: input.kind, p_title: input.title, p_max_bytes: input.maxBytes }));
      if (result.id !== input.id || result.ownerId !== actor || result.kind !== input.kind || result.title !== input.title || result.maxBytes !== input.maxBytes || result.status !== "active") throw new ProjectServerError("unavailable", 503); return result;
    },
    member: async (project, user, action) => {
      if (!["invite", "accept", "revoke"].includes(action)) throw new ProjectServerError("invalid_request", 400);
      const result = response(parseCloudMember, await rpc("pb_project_member", { p_actor: actor, p_project: cloudUuid(project), p_user: cloudUuid(user), p_action: action }));
      if (result.projectId !== project || result.userId !== user || (action === "accept" && result.status !== "accepted") || (action === "revoke" && result.status !== "revoked")) throw new ProjectServerError("unavailable", 503); return result;
    },
    reserve: (project, input) => {
      const body = validateCloudAsset(input);
      if (body.protection.kind === "challenge" && env.PB_CHALLENGES_ENABLED !== "true") throw new ProjectServerError("protected_unavailable", 409);
      const ready = body.kind === "reference" ? rpc("pb_project_design_capabilities").then(design => {
        if (design.designVersion !== 1 || design.referenceAssets !== true) throw new ProjectServerError("unavailable", 503);
      }) : Promise.resolve();
      cloudUuid(project);
      return ready.then(() => rpc("pb_project_reserve", { p_actor: actor, p_project: project, p_body: body })).then(data => {
        const result = response(parseProjectReservation, data);
        if (result.projectId !== project || result.ownerId !== actor || result.requestId !== body.requestId || ["id", "kind", "mime", "bytes", "width", "height", "sha256"].some(key => result[key as keyof ProjectReservation] !== body[key as keyof CloudAssetInput])) throw new ProjectServerError("unavailable", 503); return result;
      });
    },
    async enqueueFinalisation(asset) { return finalisationResult(await rpc("pb_project_enqueue_finalisation", { p_actor: actor, p_asset: cloudUuid(asset) }), asset); },
    async finalisationStatus(asset) { return finalisationResult(await rpc("pb_project_finalisation_status", { p_actor: actor, p_asset: cloudUuid(asset) }), asset); },
    async authoriseUpload(project, asset) {
      const path = projectAssetPath(project, actor, asset);
      const data = await rpc("pb_project_authorise_upload", { p_actor: actor, p_asset: asset });
      const date = (value: unknown) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
      const mint = date(data.mintBefore), until = date(data.uploadUntil), cleanup = date(data.cleanupAfter), now = Date.now();
      if (data.bucket !== PROJECT_BUCKET || data.path !== path || data.overwrite !== false || !Number.isSafeInteger(data.maxBytes) || (data.maxBytes as number) < 1 || (data.maxBytes as number) > CLOUD_PROJECT_LIMITS.assetBytes || !Number.isFinite(mint) || mint <= now || mint > now + 61000 || until - mint !== CLOUD_PROJECT_LIMITS.uploadSeconds * 1000 || cleanup - until !== CLOUD_PROJECT_LIMITS.cleanupMarginSeconds * 1000) throw new ProjectServerError("unavailable", 503);
      return { bucket: PROJECT_BUCKET, path, maxBytes: data.maxBytes as number, overwrite: false, mintBefore: data.mintBefore as string, uploadUntil: data.uploadUntil as string, cleanupAfter: data.cleanupAfter as string };
    },
    async resolveAsset(asset) {
      cloudUuid(asset); const data = await rpc("pb_project_asset_access", { p_actor: actor, p_asset: asset });
      const parts = typeof data.path === "string" ? data.path.split("/") : [];
      if (data.assetId !== asset || data.bucket !== PROJECT_BUCKET || parts.length !== 3 || parts[2] !== asset || projectAssetPath(parts[0], parts[1], parts[2]) !== data.path || data.expiresIn !== CLOUD_PROJECT_LIMITS.readSeconds || !["image/png", "image/jpeg", "image/webp"].includes(data.mime as string) || !Number.isSafeInteger(data.bytes) || (data.bytes as number) < 1 || (data.bytes as number) > CLOUD_PROJECT_LIMITS.assetBytes || typeof data.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(data.sha256)) throw new ProjectServerError("unavailable", 503);
      return { assetId: asset, bucket: PROJECT_BUCKET, path: data.path as string, bytes: data.bytes as number, mime: data.mime as ProjectAssetAccess["mime"], sha256: data.sha256, expiresIn: CLOUD_PROJECT_LIMITS.readSeconds };
    },
    async delete(project, asset) {
      const data = await rpc("pb_project_delete", { p_actor: actor, p_project: cloudUuid(project), p_asset: asset ? cloudUuid(asset) : null });
      if (typeof data.pending !== "boolean") throw new ProjectServerError("unavailable", 503); return { pending: data.pending };
    },
  };
}

export interface ProjectFinalisationStore {
  claim(): Promise<ProjectFinalisationClaim | null>;
  sweep(limit?: number): Promise<{ expired: number }>;
  claimCleanup(): Promise<ProjectCleanupClaim | null>;
  finishCleanup(claim: ProjectCleanupClaim, confirmedAbsent: boolean): Promise<{ complete: boolean }>;
  finish(claim: ProjectFinalisationClaim, outcome: ProjectFinalisationOutcome): Promise<ProjectFinalisationStatus>;
}
export async function createProjectFinalisationStore(env: Record<string, string | undefined> = process.env, port?: { rpc: Rpc }): Promise<ProjectFinalisationStore> {
  const url = supabaseServiceOrigin(env.NEXT_PUBLIC_SUPABASE_URL), key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (env.PB_CLOUD_PROJECTS_ENABLED !== "true" || !url || !key?.trim()) throw new ProjectServerError("unavailable", 503);
  if (!port) {
    const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: (input, init) => fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) }) } });
    port = { rpc: async (name, args) => client.rpc(name, args) };
  }
  const rpc = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await port.rpc(name, args).catch(() => { throw new ProjectServerError("unavailable", 503); });
    if (result.error) throw new ProjectServerError(result.error.message === "PB_PROJECT_LEASE" ? "lease_lost" : "unavailable", result.error.message === "PB_PROJECT_LEASE" ? 409 : 503);
    return object(result.data);
  };
  const cap = await rpc("pb_project_capabilities"); if (cap.ready !== true || cap.version !== 1 || cap.finalisationVersion !== 1) throw new ProjectServerError("unavailable", 503);
  const liveLease = (leaseUntil: string) => { const now = Date.now(); if (Date.parse(leaseUntil) <= now || Date.parse(leaseUntil) > now + 121000) throw new ProjectServerError("unavailable", 503); };
  return {
    async sweep(limit = 25) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 25) throw new ProjectServerError("invalid_request", 400);
      const result = await rpc("pb_project_sweep", { p_limit: limit });
      if (!Number.isSafeInteger(result.expired) || (result.expired as number) < 0 || (result.expired as number) > limit) throw new ProjectServerError("unavailable", 503);
      return { expired: result.expired as number };
    },
    async claimCleanup() {
      const data = await rpc("pb_project_claim_cleanup"); if (Object.keys(data).length === 0) return null;
      const claim = response(parseProjectCleanupClaim, data); liveLease(claim.leaseUntil); return claim;
    },
    async finishCleanup(claim, confirmedAbsent) {
      if (typeof confirmedAbsent !== "boolean") throw new ProjectServerError("invalid_request", 400);
      const result = await rpc("pb_project_finish_cleanup", { p_asset: cloudUuid(claim.assetId), p_lease: cloudUuid(claim.leaseToken), p_confirmed_absent: confirmedAbsent });
      if (typeof result.complete !== "boolean" || result.complete !== confirmedAbsent) throw new ProjectServerError("unavailable", 503);
      return { complete: result.complete };
    },
    async claim() {
      const data = await rpc("pb_project_claim_finalisation"); if (Object.keys(data).length === 0) return null;
      const claim = response(parseProjectFinalisationClaim, data); liveLease(claim.leaseUntil);
      return claim;
    },
    async finish(value, outcome) {
      const claim = response(parseProjectFinalisationClaim, value);
      if (!outcome || !["verified", "retry", "reject"].includes(outcome.kind)) throw new ProjectServerError("invalid_request", 400);
      let verified = null;
      if (outcome.kind === "verified") {
        const v = outcome.verified;
        if (!v || v.decoded !== true || ["mime", "bytes", "width", "height", "sha256"].some(key => v[key as keyof typeof v] !== claim[key as keyof ProjectFinalisationClaim])) throw new ProjectServerError("invalid_request", 400);
        verified = { mime: v.mime, bytes: v.bytes, width: v.width, height: v.height, sha256: v.sha256, decoded: true };
      }
      return finalisationResult(await rpc("pb_project_finish_finalisation", { p_asset: claim.assetId, p_lease: claim.leaseToken, p_outcome: outcome.kind, p_verified: verified }), claim.assetId);
    },
  };
}
