export const CLOUD_PROJECT_LIMITS = Object.freeze({ version: 1, members: 4, files: 24, projectBytes: 64 * 1024 * 1024, assetBytes: 10 * 1024 * 1024, edge: 4096, pixels: 12 * 1024 * 1024, totalPixels: 48 * 1024 * 1024, readSeconds: 300, uploadSeconds: 7200, cleanupMarginSeconds: 300 });
export const PROJECT_BUCKET = "photobooth-projects-v2";
export const PROJECT_API_LIMITS = Object.freeze({ version: 1, readPerMinute: 120, writePerMinute: 30, uploadPerMinute: 12, listDefault: 20, listMaximum: 50 });
export type ProjectRateOperation = "read" | "write" | "upload";
export interface CloudProjectListItem { id: string; ownerId: string; kind: "personal" | "friend"; title: string; createdAt: string; membership: "accepted" | "invited" }
export interface CloudProjectList { projects: CloudProjectListItem[]; nextCursor: string | null }
export type ProjectProtection = { kind: "none"; id: null } | { kind: "challenge"; id: string };
export interface CloudAssetInput {
  id: string; requestId: string; kind: "photo" | "decoration" | "reference";
  mime: "image/jpeg" | "image/png" | "image/webp";
  bytes: number; width: number; height: number; sha256: string; protection: ProjectProtection;
}
export interface ProjectAssetAccess {
  assetId: string; bucket: typeof PROJECT_BUCKET; path: string; mime: CloudAssetInput["mime"];
  bytes: number; sha256: string; expiresIn: number;
}
export interface ProjectUploadAuthorisation {
  bucket: typeof PROJECT_BUCKET; path: string; maxBytes: number; overwrite: false;
  mintBefore: string; uploadUntil: string; cleanupAfter: string;
}
export interface CloudProjectSummary { id: string; ownerId: string; kind: "personal" | "friend"; title: string; maxBytes: number; status: "active" | "deleted"; createdAt: string }
export interface CloudProjectMember { projectId: string; userId: string; status: "invited" | "accepted" | "revoked" }
export interface CloudProjectAsset { id: string; ownerId: string; kind: CloudAssetInput["kind"]; mime: CloudAssetInput["mime"]; bytes: number; width: number; height: number; sha256: string }
export interface CloudProjectView { project: CloudProjectSummary; members: Omit<CloudProjectMember, "projectId">[]; assets: CloudProjectAsset[] }
export interface ProjectReservation extends CloudProjectAsset { projectId: string; requestId: string; status: "reserved" | "ready"; reservedUntil: string }
export interface ProjectFinalisationStatus {
  assetId: string; status: "not_queued" | "queued" | "running" | "retry" | "complete" | "failed";
  assetStatus: "reserved" | "ready" | "deleted" | "expired"; attempts: number; reservedUntil: string;
  failure: "invalid_image" | "deadline" | "access_lost" | "attempts_exhausted" | "provider_retry" | null;
}
export interface ProjectFinalisationClaim extends CloudAssetInput {
  assetId: string; projectId: string; ownerId: string; bucket: typeof PROJECT_BUCKET; path: string;
  reservedUntil: string; leaseToken: string; leaseUntil: string; attempts: number;
}
export interface ProjectVerifiedImage { mime: CloudAssetInput["mime"]; bytes: number; width: number; height: number; sha256: string; decoded: true }
export type ProjectFinalisationOutcome = { kind: "verified"; verified: ProjectVerifiedImage } | { kind: "retry" | "reject" };
export interface ProjectCleanupClaim { assetId: string; bucket: typeof PROJECT_BUCKET; path: string; leaseToken: string; leaseUntil: string; attempts: number }

const badProjection = (): never => { throw new Error("unavailable"); };
function projection(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return badProjection();
  if (Reflect.ownKeys(value).some(key => typeof key !== "string" || !("value" in Object.getOwnPropertyDescriptor(value, key)!))) return badProjection();
  return value as Record<string, unknown>;
}
export function cloudTimestamp(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) return badProjection();
  return value;
}
export function parseCloudProjectList(value: unknown): CloudProjectList {
  const data = projection(value);
  if (!Array.isArray(data.projects) || data.projects.length > PROJECT_API_LIMITS.listMaximum) return badProjection();
  const projects = data.projects.map(value => {
    const p = projection(value);
    if (!["personal", "friend"].includes(p.kind as string) || !["accepted", "invited"].includes(p.membership as string) || typeof p.title !== "string" || [...p.title].length < 1 || [...p.title].length > 100 || (p.kind === "personal" && p.membership === "invited")) return badProjection();
    return { id: cloudUuid(p.id), ownerId: cloudUuid(p.ownerId), kind: p.kind as CloudProjectListItem["kind"], title: p.title, createdAt: cloudTimestamp(p.createdAt), membership: p.membership as CloudProjectListItem["membership"] };
  });
  const nextCursor = data.nextCursor === null ? null : cloudUuid(data.nextCursor);
  if (projects.some((p, index) => index > 0 && p.id <= projects[index - 1].id) || (nextCursor !== null && projects.at(-1)?.id !== nextCursor)) return badProjection();
  return { projects, nextCursor };
}
export function parseCloudProject(value: unknown): CloudProjectSummary {
  const p = projection(value);
  if (!["personal", "friend"].includes(p.kind as string) || !["active", "deleted"].includes(p.status as string) || typeof p.title !== "string" || [...p.title].length < 1 || [...p.title].length > 100 || !Number.isSafeInteger(p.max_bytes) || (p.max_bytes as number) < CLOUD_PROJECT_LIMITS.assetBytes || (p.max_bytes as number) > CLOUD_PROJECT_LIMITS.projectBytes) return badProjection();
  return { id: cloudUuid(p.id), ownerId: cloudUuid(p.owner_id), kind: p.kind as CloudProjectSummary["kind"], title: p.title, maxBytes: p.max_bytes as number, status: p.status as CloudProjectSummary["status"], createdAt: cloudTimestamp(p.created_at) };
}
export function parseCloudMember(value: unknown): CloudProjectMember {
  const m = projection(value); if (!["invited", "accepted", "revoked"].includes(m.status as string)) return badProjection();
  return { projectId: cloudUuid(m.project_id), userId: cloudUuid(m.user_id), status: m.status as CloudProjectMember["status"] };
}
function parseAsset(value: unknown): CloudProjectAsset {
  const a = projection(value), id = cloudUuid(a.id);
  const valid = validateCloudAsset({ id, requestId: id, kind: a.kind, mime: a.mime, bytes: a.bytes, width: a.width, height: a.height, sha256: a.sha256, protection: { kind: "none", id: null } });
  return { id, ownerId: cloudUuid(a.ownerId), kind: valid.kind, mime: valid.mime, bytes: valid.bytes, width: valid.width, height: valid.height, sha256: valid.sha256 };
}
export function parseProjectReservation(value: unknown): ProjectReservation {
  const a = projection(value); if (!["reserved", "ready"].includes(a.status as string)) return badProjection();
  return { ...parseAsset({ ...a, ownerId: a.owner_id }), projectId: cloudUuid(a.project_id), requestId: cloudUuid(a.request_id), status: a.status as ProjectReservation["status"], reservedUntil: cloudTimestamp(a.reserved_until) };
}
export function parseCloudProjectView(value: unknown): CloudProjectView {
  const v = projection(value), project = parseCloudProject(v.project);
  if (!Array.isArray(v.members) || v.members.length < 1 || v.members.length > 4 || !Array.isArray(v.assets) || v.assets.length > 24) return badProjection();
  const members = v.members.map(item => { const m = projection(item); const parsed = parseCloudMember({ project_id: project.id, user_id: m.userId, status: m.status }); return { userId: parsed.userId, status: parsed.status }; });
  const assets = v.assets.map(parseAsset);
  if (new Set(members.map(m => m.userId)).size !== members.length || new Set(assets.map(a => a.id)).size !== assets.length || !members.some(m => m.userId === project.ownerId && m.status === "accepted") || assets.some(a => !members.some(m => m.userId === a.ownerId))) return badProjection();
  return { project, members, assets };
}
export function parseProjectFinalisationStatus(value: unknown): ProjectFinalisationStatus {
  const s = projection(value);
  if (!["not_queued", "queued", "running", "retry", "complete", "failed"].includes(s.status as string) || !["reserved", "ready", "deleted", "expired"].includes(s.assetStatus as string) || ![null, "invalid_image", "deadline", "access_lost", "attempts_exhausted", "provider_retry"].includes(s.failure as null | string) || !Number.isSafeInteger(s.attempts) || (s.attempts as number) < 0 || (s.attempts as number) > 8) return badProjection();
  return { assetId: cloudUuid(s.assetId), status: s.status as ProjectFinalisationStatus["status"], assetStatus: s.assetStatus as ProjectFinalisationStatus["assetStatus"], attempts: s.attempts as number, failure: s.failure as ProjectFinalisationStatus["failure"], reservedUntil: cloudTimestamp(s.reservedUntil) };
}
export function parseProjectFinalisationClaim(value: unknown): ProjectFinalisationClaim {
  const j = projection(value), assetId = cloudUuid(j.assetId), projectId = cloudUuid(j.projectId), ownerId = cloudUuid(j.ownerId);
  const input = validateCloudAsset({ id: assetId, requestId: j.requestId, kind: j.kind, mime: j.mime, bytes: j.bytes, width: j.width, height: j.height, sha256: j.sha256, protection: j.protection });
  const reservedUntil = cloudTimestamp(j.reservedUntil), leaseUntil = cloudTimestamp(j.leaseUntil);
  if (j.bucket !== PROJECT_BUCKET || j.path !== projectAssetPath(projectId, ownerId, assetId) || !Number.isSafeInteger(j.attempts) || (j.attempts as number) < 1 || (j.attempts as number) > 8 || Date.parse(leaseUntil) > Date.parse(reservedUntil)) return badProjection();
  return { ...input, assetId, projectId, ownerId, bucket: PROJECT_BUCKET, path: j.path as string, reservedUntil, leaseToken: cloudUuid(j.leaseToken), leaseUntil, attempts: j.attempts as number };
}
export function parseProjectCleanupClaim(value: unknown): ProjectCleanupClaim {
  const j = projection(value), assetId = cloudUuid(j.asset_id), parts = typeof j.path === "string" ? j.path.split("/") : [];
  if (j.bucket !== PROJECT_BUCKET || parts.length !== 3 || parts[2] !== assetId || projectAssetPath(parts[0], parts[1], parts[2]) !== j.path || j.status !== "running" || !Number.isSafeInteger(j.attempts) || (j.attempts as number) < 1 || (j.attempts as number) > 8 || j.confirmed_absent !== false) return badProjection();
  return { assetId, bucket: PROJECT_BUCKET, path: j.path as string, leaseToken: cloudUuid(j.lease_token), leaseUntil: cloudTimestamp(j.lease_until), attempts: j.attempts as number };
}
export function cloudUuid(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) throw new Error("invalid_request");
  return value;
}
function exact(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error("invalid_request");
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some(key => typeof key !== "string" || !keys.includes(key) || !("value" in Object.getOwnPropertyDescriptor(value, key)!))) throw new Error("invalid_request");
  return value as Record<string, unknown>;
}
export function validateCloudAsset(value: unknown): CloudAssetInput {
  const a = exact(value, ["id", "requestId", "kind", "mime", "bytes", "width", "height", "sha256", "protection"]);
  const p = exact(a.protection, ["kind", "id"]);
  cloudUuid(a.id); cloudUuid(a.requestId);
  if (a.kind === "reference" && p.kind !== "none") throw new Error("invalid_request");
  if (p.kind === "none" ? p.id !== null : p.kind !== "challenge" || !cloudUuid(p.id)) throw new Error("invalid_request");
  if (!["photo", "decoration", "reference"].includes(a.kind as string) || !["image/jpeg", "image/png", "image/webp"].includes(a.mime as string)) throw new Error("invalid_request");
  for (const key of ["bytes", "width", "height"]) if (!Number.isSafeInteger(a[key]) || (a[key] as number) < 1) throw new Error("invalid_request");
  const decoration = a.kind === "decoration", edge = decoration ? 2048 : CLOUD_PROJECT_LIMITS.edge;
  if ((a.bytes as number) > (decoration ? 4 * 1024 * 1024 : CLOUD_PROJECT_LIMITS.assetBytes) || (a.width as number) > edge || (a.height as number) > edge || (a.width as number) * (a.height as number) > (decoration ? 4 * 1024 * 1024 : CLOUD_PROJECT_LIMITS.pixels) || (decoration && a.mime !== "image/png") || typeof a.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(a.sha256)) throw new Error("invalid_request");
  return { id: a.id as string, requestId: a.requestId as string, kind: a.kind as CloudAssetInput["kind"], mime: a.mime as CloudAssetInput["mime"], bytes: a.bytes as number, width: a.width as number, height: a.height as number, sha256: a.sha256, protection: { kind: p.kind, id: p.id } as ProjectProtection };
}
export function projectAssetPath(projectId: string, ownerId: string, assetId: string): string {
  return `${cloudUuid(projectId)}/${cloudUuid(ownerId)}/${cloudUuid(assetId)}`;
}
