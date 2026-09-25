import { validateStoryPlan, type StoryPlan } from "../stories/model";
import { validateTemplateDesign, type TemplateDesign } from "../templates/model";
import { cloudTimestamp, cloudUuid, validateCloudAsset, type CloudProjectAsset } from "../projects/cloud-contract";

export const CHALLENGE_LIMITS = Object.freeze({ version: 2, members: 4, slots: 16, sourcesPerMember: 4, requestBytes: 65536, responseBytes: 98304, proposals: 20, challengesPerProject: 32 });
export const CHALLENGE_DISCOVERY = Object.freeze({ version: 1, maximum: 20 });
export const CHALLENGE_PARTIALS = Object.freeze({ version: 1, maximum: 20 });
export interface PartialContributor { userId: string; role: "A" | "B" | "C" | "D"; consent: boolean | null; status: "available" | "access_lost" }
export interface PartialSummary {
  id: string; challengeId: string; projectId: string; digest: string; status: "pending" | "rejected" | "revealed";
  createdAt: string; revealedAt: string | null; accessLost: boolean; actorIncluded: boolean; actorConsent: boolean | null; contributors: PartialContributor[];
}
export interface PartialLegacySummary { id: string; challengeId: string; projectId: string; unsupported: true; reason: "recipe_unavailable" }
export interface PartialComposition {
  projectionVersion: 1; recipeHash: string; design: TemplateDesign;
  sources: { userId: string; role: "A" | "B" | "C" | "D"; sourceIndex: number; assetId: string }[];
}
export type PartialDetail = ({ version: 1 } & PartialSummary & { result: PartialComposition | null }) | ({ version: 1 } & PartialLegacySummary);
export interface PartialList { version: 1; partials: (PartialSummary | PartialLegacySummary)[]; nextCursor: string | null }
export interface ChallengeUploadList { version: 1; uploads: CloudProjectAsset[]; nextCursor: string | null }
export function parseChallengeUploadList(value: unknown, actorId: string, after?: string, limit = 20): ChallengeUploadList {
  cloudUuid(actorId); if (after !== undefined) cloudUuid(after); challengeListLimit(limit);
  const p = challengeObject(value, ["version", "uploads", "nextCursor"]); if (p.version !== 1) throw new Error("invalid_request");
  const uploads = list(p.uploads, 0, limit).map(value => {
    const a = challengeObject(value, ["id", "ownerId", "kind", "mime", "bytes", "width", "height", "sha256"]);
    if (a.ownerId !== actorId || a.kind !== "photo") throw new Error("invalid_request");
    const checked = validateCloudAsset({ id: a.id, requestId: a.id, kind: a.kind, mime: a.mime, bytes: a.bytes, width: a.width, height: a.height, sha256: a.sha256, protection: { kind: "none", id: null } });
    return { id: checked.id, ownerId: actorId, kind: checked.kind, mime: checked.mime, bytes: checked.bytes, width: checked.width, height: checked.height, sha256: checked.sha256 };
  });
  const nextCursor = p.nextCursor === null ? null : cloudUuid(p.nextCursor);
  if (uploads.some((a, i) => (after !== undefined && a.id <= after) || (i > 0 && a.id <= uploads[i - 1].id)) || (nextCursor !== null && (uploads.length !== limit || uploads.at(-1)?.id !== nextCursor))) throw new Error("invalid_request");
  return { version: 1, uploads, nextCursor };
}
export type ChallengeStatus = "draft" | "open" | "revealed" | "cancelled" | "expired";
export interface ChallengeSummary {
  id: string; projectId: string; status: ChallengeStatus; policy: "immediate" | "all_submitted";
  membership: "invited" | "accepted" | "declined" | "withdrawn";
  createdAt: string; expiresAt: string; unsupported: boolean;
}
export interface ChallengeList { version: 1; challenges: ChallengeSummary[]; nextCursor: string | null }
export interface ChallengeCreate {
  story?: StoryPlan | null;
  id: string; design: TemplateDesign; policy: "immediate" | "all_submitted"; expiresAt: string;
  members: { userId: string; role: "A" | "B" | "C" | "D" }[];
}
export interface ChallengeAssignment { slot: number; userId: string; sourceIndex: number }
export interface PreparedChallengeCreate extends ChallengeCreate { assignments: ChallengeAssignment[] }
export interface ChallengeSubmission { requestId: string; sources: { sourceIndex: number; assetId: string }[] }
export interface ChallengeView {
  story?: StoryPlan | null;
  id: string; projectId: string; status: ChallengeStatus; policy: ChallengeCreate["policy"]; recipeHash: string;
  expiresAt: string; revealedAt: string | null; revealHash: string | null; accessLost: boolean;
  members: { userId: string; role: string; status: "invited" | "accepted" | "declined" | "withdrawn"; submitted: boolean }[];
  design: TemplateDesign;
  assignments: ChallengeAssignment[];
  visibleSources: { userId: string; sourceIndex: number; assetId: string }[];
}
export interface ChallengeUnavailableView { id: string; projectId: string; unsupported: true; reason: "recipe_unavailable" }
export type ChallengeResult = ChallengeView | ChallengeUnavailableView;
export interface PartialUnavailableView { id: string; challengeId: string; unsupported: true; reason: "recipe_unavailable" }
export type PartialResult = PartialReveal | PartialUnavailableView;
export interface PartialReveal { id: string; digest: string; status: "pending" | "rejected" | "revealed"; contributors: string[]; accessLost: boolean }
export function challengeObject(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new Error("invalid_request");
  const own = Reflect.ownKeys(input);
  if (own.length !== keys.length || own.some(key => typeof key !== "string" || !keys.includes(key) || !("value" in Object.getOwnPropertyDescriptor(input, key)!))) throw new Error("invalid_request");
  return input as Record<string, unknown>;
}
function list(value: unknown, min: number, max: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < min || value.length > max || Reflect.ownKeys(value).length !== value.length + 1) throw new Error("invalid_request");
  for (let index = 0; index < value.length; index++) { const descriptor = Object.getOwnPropertyDescriptor(value, index); if (!descriptor || !("value" in descriptor)) throw new Error("invalid_request"); }
  return value;
}
export function challengeHash(value: unknown): string { if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error("invalid_request"); return value; }
export function challengeListLimit(value: unknown = CHALLENGE_DISCOVERY.maximum): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > CHALLENGE_DISCOVERY.maximum) throw new Error("invalid_request");
  return value as number;
}
export function parseChallengeList(value: unknown, projectId: string, after?: string, limit: number = CHALLENGE_DISCOVERY.maximum): ChallengeList {
  cloudUuid(projectId); if (after !== undefined) cloudUuid(after); challengeListLimit(limit);
  const input = challengeObject(value, ["version", "challenges", "nextCursor"]);
  if (input.version !== CHALLENGE_DISCOVERY.version) throw new Error("invalid_request");
  const challenges = list(input.challenges, 0, limit).map(value => {
    const item = challengeObject(value, ["id", "projectId", "status", "policy", "membership", "createdAt", "expiresAt", "unsupported"]);
    if (item.projectId !== projectId || !["draft", "open", "revealed", "cancelled", "expired"].includes(item.status as string) || !["immediate", "all_submitted"].includes(item.policy as string) || !["invited", "accepted", "declined", "withdrawn"].includes(item.membership as string) || typeof item.unsupported !== "boolean") throw new Error("invalid_request");
    return { id: cloudUuid(item.id), projectId, status: item.status as ChallengeStatus, policy: item.policy as ChallengeSummary["policy"], membership: item.membership as ChallengeSummary["membership"], createdAt: cloudTimestamp(item.createdAt), expiresAt: cloudTimestamp(item.expiresAt), unsupported: item.unsupported };
  });
  const nextCursor = input.nextCursor === null ? null : cloudUuid(input.nextCursor);
  if (challenges.some((item, i) => (after !== undefined && item.id <= after) || (i > 0 && item.id <= challenges[i - 1].id)) || (nextCursor !== null && (challenges.length !== limit || challenges.at(-1)?.id !== nextCursor))) throw new Error("invalid_request");
  return { version: 1, challenges, nextCursor };
}
function partialSummary(value: unknown, actorId: string): PartialSummary | PartialLegacySummary {
  cloudUuid(actorId);
  if (value && typeof value === "object" && "unsupported" in value) {
    const p = challengeObject(value, ["id", "challengeId", "projectId", "unsupported", "reason"]);
    if (p.unsupported !== true || p.reason !== "recipe_unavailable") throw new Error("invalid_request");
    return { id: cloudUuid(p.id), challengeId: cloudUuid(p.challengeId), projectId: cloudUuid(p.projectId), unsupported: true, reason: "recipe_unavailable" };
  }
  const p = challengeObject(value, ["id", "challengeId", "projectId", "digest", "status", "createdAt", "revealedAt", "accessLost", "actorIncluded", "actorConsent", "contributors"]);
  if (!["pending", "rejected", "revealed"].includes(p.status as string) || typeof p.accessLost !== "boolean" || typeof p.actorIncluded !== "boolean" || (p.actorConsent !== null && typeof p.actorConsent !== "boolean")) throw new Error("invalid_request");
  const contributors = list(p.contributors, 1, 4).map(value => {
    const c = challengeObject(value, ["userId", "role", "consent", "status"]);
    if (!["A", "B", "C", "D"].includes(c.role as string) || !["available", "access_lost"].includes(c.status as string) || (c.consent !== null && typeof c.consent !== "boolean")) throw new Error("invalid_request");
    return { userId: cloudUuid(c.userId), role: c.role as PartialContributor["role"], consent: c.consent as boolean | null, status: c.status as PartialContributor["status"] };
  });
  const actor = contributors.find(c => c.userId === actorId), revealedAt = p.revealedAt === null ? null : cloudTimestamp(p.revealedAt);
  if (new Set(contributors.map(c => c.userId)).size !== contributors.length || new Set(contributors.map(c => c.role)).size !== contributors.length || p.actorIncluded !== Boolean(actor) || p.actorConsent !== (actor?.consent ?? null) || (p.status === "revealed" && revealedAt === null) || (p.status === "pending" && revealedAt !== null) || (contributors.some(c => c.status === "access_lost") && !p.accessLost)) throw new Error("invalid_request");
  return { id: cloudUuid(p.id), challengeId: cloudUuid(p.challengeId), projectId: cloudUuid(p.projectId), digest: challengeHash(p.digest), status: p.status as PartialSummary["status"], createdAt: cloudTimestamp(p.createdAt), revealedAt, accessLost: p.accessLost, actorIncluded: p.actorIncluded, actorConsent: p.actorConsent as boolean | null, contributors };
}
export function parsePartialList(value: unknown, challengeId: string, actorId: string, after?: string, limit = 20): PartialList {
  cloudUuid(challengeId); if (after !== undefined) cloudUuid(after); challengeListLimit(limit);
  const p = challengeObject(value, ["version", "partials", "nextCursor"]); if (p.version !== 1) throw new Error("invalid_request");
  const partials = list(p.partials, 0, limit).map(value => partialSummary(value, actorId)), nextCursor = p.nextCursor === null ? null : cloudUuid(p.nextCursor);
  if (partials.some((p, i) => p.challengeId !== challengeId || (after !== undefined && p.id <= after) || (i > 0 && p.id <= partials[i - 1].id)) || (nextCursor !== null && (partials.length !== limit || partials.at(-1)?.id !== nextCursor))) throw new Error("invalid_request");
  return { version: 1, partials, nextCursor };
}
export function parsePartialDetail(value: unknown, partialId: string, digest: string, actorId: string): PartialDetail {
  cloudUuid(partialId); challengeHash(digest);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_request");
  const raw = challengeObject(value, "unsupported" in value ? ["version", "id", "challengeId", "projectId", "unsupported", "reason"] : ["version", "id", "challengeId", "projectId", "digest", "status", "createdAt", "revealedAt", "accessLost", "actorIncluded", "actorConsent", "contributors", "result"]);
  const { version, result, ...metadata } = raw;
  if (version !== 1) throw new Error("invalid_request");
  const summary = partialSummary(metadata, actorId); if (summary.id !== partialId) throw new Error("invalid_request");
  if ("unsupported" in summary) { if (Object.hasOwn(raw, "result")) throw new Error("invalid_request"); return { version: 1, ...summary }; }
  if (summary.digest !== digest || !Object.hasOwn(raw, "result")) throw new Error("invalid_request");
  if (result === null) return { version: 1, ...summary, result: null };
  if (summary.status !== "revealed" || summary.accessLost || !summary.actorIncluded || summary.contributors.some(c => c.consent !== true || c.status !== "available")) throw new Error("invalid_request");
  const r = challengeObject(result, ["projectionVersion", "recipeHash", "design", "sources"]); if (r.projectionVersion !== 1) throw new Error("invalid_request");
  const design = validateTemplateDesign(r.design);
  if (design.defaults.caption !== "" || design.layers.some(l => l.kind === "text" && l.personal) || Object.keys(design.requiredSources).length !== summary.contributors.length || summary.contributors.some(c => !design.requiredSources[c.role])) throw new Error("invalid_request");
  for (const decoration of design.decorations) cloudUuid(decoration.id);
  const required = new Set(design.slots.flatMap(slot => [slot, ...(slot.companions ?? [])]).map(source => `${source.role}:${source.sourceIndex}`)), assets = new Set<string>();
  const sources = list(r.sources, 1, 16).map(value => {
    const s = challengeObject(value, ["userId", "role", "sourceIndex", "assetId"]), userId = cloudUuid(s.userId), assetId = cloudUuid(s.assetId), key = `${s.role}:${s.sourceIndex}`;
    if (!summary.contributors.some(c => c.userId === userId && c.role === s.role) || !required.delete(key) || assets.has(assetId)) throw new Error("invalid_request");
    assets.add(assetId); return { userId, role: s.role as PartialContributor["role"], sourceIndex: index(s.sourceIndex, 4), assetId };
  });
  if (required.size) throw new Error("invalid_request");
  return { version: 1, ...summary, result: { projectionVersion: 1, recipeHash: challengeHash(r.recipeHash), design, sources } };
}
const index = (value: unknown, max: number): number => { if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) >= max) throw new Error("invalid_request"); return value as number; };
export function deriveChallengeAssignments(design: TemplateDesign, members: ChallengeCreate["members"]): ChallengeAssignment[] {
  const used = new Set<string>();
  for (const slot of design.slots) for (const source of [slot, ...(slot.companions ?? [])]) used.add(`${source.role}:${source.sourceIndex}`);
  if (Object.keys(design.requiredSources).length !== members.length || members.some(member => !Object.hasOwn(design.requiredSources, member.role))) throw new Error("invalid_request");
  return members.flatMap(member => [...used].filter(key => key.startsWith(`${member.role}:`)).map(key => Number(key.split(":")[1])).sort((a, b) => a - b).map(sourceIndex => ({ userId: member.userId, sourceIndex }))).map((source, slot) => ({ slot, ...source }));
}
export function validateChallengeCreate(value: unknown): ChallengeCreate {
  const input = challengeObject(value, ["id", "design", "policy", "expiresAt", "members", ...(value && typeof value === "object" && Object.hasOwn(value, "story") ? ["story"] : [])]);
  if (!["immediate", "all_submitted"].includes(input.policy as string) || typeof input.expiresAt !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(input.expiresAt) || !Number.isFinite(Date.parse(input.expiresAt))) throw new Error("invalid_request");
  const members = list(input.members, 2, 4).map(value => { const m = challengeObject(value, ["userId", "role"]); if (!["A", "B", "C", "D"].includes(m.role as string)) throw new Error("invalid_request"); return { userId: cloudUuid(m.userId), role: m.role as ChallengeCreate["members"][number]["role"] }; }).sort((a, b) => a.role.localeCompare(b.role));
  if (new Set(members.map(m => m.userId)).size !== members.length || new Set(members.map(m => m.role)).size !== members.length) throw new Error("invalid_request");
  const design = validateTemplateDesign(input.design);
  for (const decoration of design.decorations) cloudUuid(decoration.id);
  const assignments = deriveChallengeAssignments(design, members), story = input.story == null ? null : validateStoryPlan(input.story);
  if (story && JSON.stringify([...new Set(assignments.map(a => a.sourceIndex))].sort()) !== "[0,1,2,3]") throw new Error("invalid_request");
  const checked = { id: cloudUuid(input.id), design, policy: input.policy as ChallengeCreate["policy"], expiresAt: new Date(input.expiresAt).toISOString(), members, ...(story ? { story } : {}) };
  if (new TextEncoder().encode(JSON.stringify(checked)).length > CHALLENGE_LIMITS.requestBytes) throw new Error("invalid_request");
  return checked;
}
export function prepareChallengeCreate(value: unknown): PreparedChallengeCreate {
  const checked = validateChallengeCreate(value); return { ...checked, assignments: deriveChallengeAssignments(checked.design, checked.members) };
}
export function validateChallengeSubmission(value: unknown): ChallengeSubmission {
  const input = challengeObject(value, ["requestId", "sources"]);
  const sources = list(input.sources, 1, 4).map(value => { const s = challengeObject(value, ["sourceIndex", "assetId"]); return { sourceIndex: index(s.sourceIndex, 4), assetId: cloudUuid(s.assetId) }; });
  if (new Set(sources.map(s => s.sourceIndex)).size !== sources.length || new Set(sources.map(s => s.assetId)).size !== sources.length) throw new Error("invalid_request");
  return { requestId: cloudUuid(input.requestId), sources };
}
