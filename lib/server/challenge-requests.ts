import { CHALLENGE_LIMITS, challengeHash, challengeListLimit, challengeObject, validateChallengeCreate, validateChallengeSubmission, type ChallengeCreate, type ChallengeSubmission } from "../memories/challenge-contract";
import { cloudUuid } from "../projects/cloud-contract";
import { createChallengeStore, ChallengeServerError, type ChallengeStore } from "./challenge-store";
import { createProjectStore, ProjectServerError, type ProjectStore } from "./project-store";
import { privateJson } from "./cron-auth";
import { requireSameOrigin, RequestValidationError } from "./request-security";

type Operation =
  | { operation: "capabilities" }
  | { operation: "listPartials"; challengeId: string; after?: string; limit: number }
  | { operation: "listUploads"; challengeId: string; after?: string; limit: number }
  | { operation: "partialDetail"; partialId: string; digest: string }
  | { operation: "list"; projectId: string; after?: string; limit: number }
  | { operation: "create"; projectId: string; challenge: ChallengeCreate }
  | { operation: "view"; challengeId: string }
  | { operation: "manage"; challengeId: string; action: Parameters<ChallengeStore["manage"]>[1] }
  | { operation: "submit"; challengeId: string; submission: ChallengeSubmission }
  | { operation: "proposePartial"; challengeId: string; partialId: string; contributors: string[] }
  | { operation: "partial"; partialId: string }
  | { operation: "consentPartial"; partialId: string; digest: string; consent: boolean }
  | { operation: "commitPartial"; partialId: string; digest: string };

export interface ChallengeRequestPorts {
  project(token: string, env: Record<string, string | undefined>): Promise<Pick<ProjectStore, "rate">>;
  challenge(token: string, env: Record<string, string | undefined>): Promise<ChallengeStore>;
}
const production: ChallengeRequestPorts = { project: createProjectStore, challenge: createChallengeStore };
const invalid = (): never => { throw new RequestValidationError(400, "Invalid challenge request"); };

function operation(value: unknown): Operation {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
    const op = (value as Record<string, unknown>).operation;
    const body = (...keys: string[]) => challengeObject(value, ["operation", ...keys]);
    if (op === "capabilities") { body(); return { operation: op }; }
    if (op === "listPartials" || op === "listUploads") {
      const raw = value as Record<string, unknown>, b = body("challengeId", ...(Object.hasOwn(raw, "after") ? ["after"] : []), ...(Object.hasOwn(raw, "limit") ? ["limit"] : []));
      return { operation: op, challengeId: cloudUuid(b.challengeId), after: Object.hasOwn(b, "after") ? cloudUuid(b.after) : undefined, limit: challengeListLimit(b.limit) };
    }
    if (op === "partialDetail") { const b = body("partialId", "digest"); return { operation: op, partialId: cloudUuid(b.partialId), digest: challengeHash(b.digest) }; }
    if (op === "list") {
      const raw = value as Record<string, unknown>, b = body("projectId", ...(Object.hasOwn(raw, "after") ? ["after"] : []), ...(Object.hasOwn(raw, "limit") ? ["limit"] : []));
      return { operation: op, projectId: cloudUuid(b.projectId), after: Object.hasOwn(b, "after") ? cloudUuid(b.after) : undefined, limit: challengeListLimit(b.limit) };
    }
    if (op === "create") { const b = body("projectId", "challenge"); return { operation: op, projectId: cloudUuid(b.projectId), challenge: validateChallengeCreate(b.challenge) }; }
    if (op === "view") { const b = body("challengeId"); return { operation: op, challengeId: cloudUuid(b.challengeId) }; }
    if (op === "manage") {
      const b = body("challengeId", "action");
      if (!["accept", "decline", "open", "cancel", "withdraw"].includes(b.action as string)) return invalid();
      return { operation: op, challengeId: cloudUuid(b.challengeId), action: b.action as Parameters<ChallengeStore["manage"]>[1] };
    }
    if (op === "submit") { const b = body("challengeId", "submission"); return { operation: op, challengeId: cloudUuid(b.challengeId), submission: validateChallengeSubmission(b.submission) }; }
    if (op === "proposePartial") {
      const b = body("challengeId", "partialId", "contributors");
      if (!Array.isArray(b.contributors) || b.contributors.length < 1 || b.contributors.length > CHALLENGE_LIMITS.members) return invalid();
      const contributors = b.contributors.map(cloudUuid);
      if (new Set(contributors).size !== contributors.length) return invalid();
      return { operation: op, challengeId: cloudUuid(b.challengeId), partialId: cloudUuid(b.partialId), contributors };
    }
    if (op === "partial") { const b = body("partialId"); return { operation: op, partialId: cloudUuid(b.partialId) }; }
    if (op === "consentPartial") {
      const b = body("partialId", "digest", "consent"); if (typeof b.consent !== "boolean") return invalid();
      return { operation: op, partialId: cloudUuid(b.partialId), digest: challengeHash(b.digest), consent: b.consent };
    }
    if (op === "commitPartial") { const b = body("partialId", "digest"); return { operation: op, partialId: cloudUuid(b.partialId), digest: challengeHash(b.digest) }; }
    return invalid();
  } catch { return invalid(); }
}

async function readBody(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") throw new RequestValidationError(415, "JSON is required");
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (!Number.isSafeInteger(declared) || declared < 0 || declared > CHALLENGE_LIMITS.requestBytes) throw new RequestValidationError(413, "Request is too large");
  if (!request.body) return invalid();
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0, timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { reject(new RequestValidationError(408, "Request timed out")); void reader.cancel().catch(() => {}); }, 5000);
  });
  try {
    while (true) {
      const { value, done } = await Promise.race([reader.read(), expired]);
      if (done) break;
      size += value.byteLength;
      if (size > CHALLENGE_LIMITS.requestBytes || chunks.length >= 4096) { void reader.cancel().catch(() => {}); throw new RequestValidationError(413, "Request is too large"); }
      chunks.push(value);
    }
  } finally { clearTimeout(timer); reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { return invalid(); }
}

const publicErrors: Readonly<Record<string, readonly number[]>> = {
  access_denied: [401, 403], invalid_request: [400], conflict: [409], expired: [410], not_ready: [409],
  capacity: [409], update_required: [409], rate_limited: [429], unavailable: [503],
};

export function createChallengeHandler(ports: ChallengeRequestPorts = production, getEnv: () => Record<string, string | undefined> = () => process.env) {
  return async (request: Request): Promise<Response> => {
    try {
      const env = getEnv();
      if (env.PB_CLOUD_PROJECTS_ENABLED !== "true" || env.PB_CHALLENGES_ENABLED !== "true") return privateJson({ enabled: false, error: "unavailable" }, 503);
      if (request.method !== "POST") return privateJson({ error: "method_not_allowed" }, 405);
      const url = new URL(request.url), local = env.NODE_ENV === "development" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      if (url.protocol !== "https:" && !local) return privateJson({ error: "unavailable" }, 503);
      if (url.search) return invalid();
      requireSameOrigin(request, env);
      const token = /^Bearer ([^\s,]+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
      if (!token || token.length > 16384) return privateJson({ error: "access_denied" }, 401);
      const input = operation(await readBody(request));
      const project = await ports.project(token, env);
      await project.rate(["capabilities", "list", "view", "partial", "listPartials", "partialDetail", "listUploads"].includes(input.operation) ? "read" : "write");
      const store = await ports.challenge(token, env);
      switch (input.operation) {
        case "listUploads": return privateJson(await store.listUploads(input.challengeId, input.after, input.limit));
        case "listPartials": return privateJson(await store.listPartials(input.challengeId, input.after, input.limit));
        case "partialDetail": return privateJson(await store.partialDetail(input.partialId, input.digest));
        case "capabilities": return privateJson({ enabled: true, version: CHALLENGE_LIMITS.version, limits: CHALLENGE_LIMITS, storyVersion: store.storyVersion ?? 0 });
        case "list": return privateJson(await store.list(input.projectId, input.after, input.limit));
        case "create": return privateJson(await store.create(input.projectId, input.challenge), 201);
        case "view": return privateJson(await store.view(input.challengeId));
        case "manage": return privateJson(await store.manage(input.challengeId, input.action));
        case "submit": return privateJson(await store.submit(input.challengeId, input.submission));
        case "proposePartial": return privateJson(await store.proposePartial(input.challengeId, input.partialId, input.contributors), 201);
        case "partial": return privateJson(await store.partial(input.partialId));
        case "consentPartial": return privateJson(await store.consentPartial(input.partialId, input.digest, input.consent));
        case "commitPartial": return privateJson(await store.commitPartial(input.partialId, input.digest));
      }
    } catch (error) {
      if (error instanceof RequestValidationError) return privateJson({ error: error.status === 403 ? "origin_denied" : error.status === 503 ? "unavailable" : "invalid_request" }, error.status);
      if ((error instanceof ChallengeServerError || error instanceof ProjectServerError) && Object.hasOwn(publicErrors, error.code) && publicErrors[error.code].includes(error.status)) {
        const response = privateJson({ error: error.code }, error.status);
        if (error.status === 429) {
          const retry = error instanceof ProjectServerError ? error.retryAfterSeconds : undefined;
          response.headers.set("Retry-After", String(Number.isSafeInteger(retry) && retry! >= 1 && retry! <= 60 ? retry : 60));
        }
        return response;
      }
      return privateJson({ error: "unavailable" }, 503);
    }
  };
}
