import { createHash, createHmac, randomBytes, randomInt, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { ROOM_LIMITS, type RoomAction } from "./room-contract";
import { createRoomStore, RoomServerError, type RoomStore } from "./room-store";
import { canonicalPublicOrigin, privateJson } from "./cron-auth";
import { requireSameOrigin, RequestValidationError } from "./request-security";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const ACTIONS: readonly RoomAction[] = ["state", "admit", "remove", "lock", "end", "signal", "poll", "prepare", "ack", "commit", "abort", "capture"];
const digest = (token: string) => createHash("sha256").update(token).digest("hex");
const invalid = (): never => { throw new RoomServerError("invalid_request", 400); };
const integer = (value: unknown, min: number, max: number) => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
const uuid = (value: unknown) => typeof value === "string" && UUID.test(value);
const shape = (value: Record<string, unknown>, required: string[], optional: string[] = []) => required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const name = (value: unknown) => typeof value === "string" && value.trim() === value && value.length >= 1 && value.length <= 40 && !/[\u0000-\u001f\u007f]/.test(value);

export function validateRoomBody(action: RoomAction | "create" | "join", body: Record<string, unknown>): void {
  if (action === "create" || action === "join") {
    if (!shape(body, action === "create" ? ["displayName"] : ["displayName", "code"]) || !name(body.displayName) || (action === "join" && (typeof body.code !== "string" || !/^[A-Z2-9]{6}$/.test(body.code)))) invalid();
  } else if (action === "state") {
    if (!shape(body, [], ["renewConnection"]) || (body.renewConnection !== undefined && typeof body.renewConnection !== "boolean")) invalid();
  } else if (action === "admit" || action === "remove") {
    if (!shape(body, ["memberId"]) || !uuid(body.memberId)) invalid();
  } else if (action === "lock") {
    if (!shape(body, ["locked"]) || typeof body.locked !== "boolean") invalid();
  } else if (action === "end") {
    if (!shape(body, [])) invalid();
  } else if (action === "signal") {
    if (!shape(body, ["messageId", "toMemberId", "connectionEpoch", "kind", "payload"]) || !uuid(body.messageId) || !uuid(body.toMemberId) || !uuid(body.connectionEpoch)
      || !["sdp", "ice"].includes(body.kind as string) || typeof body.payload !== "string" || new TextEncoder().encode(body.payload).length < 1
      || new TextEncoder().encode(body.payload).length > (body.kind === "sdp" ? ROOM_LIMITS.sdpBytes : ROOM_LIMITS.iceBytes)) invalid();
  } else if (action === "poll") {
    if (!shape(body, ["cursor"], ["limit"]) || !integer(body.cursor, 0, Number.MAX_SAFE_INTEGER) || (body.limit !== undefined && !integer(body.limit, 1, ROOM_LIMITS.signalPage))) invalid();
  } else if (action === "prepare") {
    const profile = body.profile;
    if (!shape(body, ["captureId", "rosterRevision", "recipeHash", "shotIds", "fireAt", "intervalMs", "profile"]) || !uuid(body.captureId) || !integer(body.rosterRevision, 1, Number.MAX_SAFE_INTEGER)
      || typeof body.recipeHash !== "string" || !HASH.test(body.recipeHash) || !Array.isArray(body.shotIds) || body.shotIds.length < 1 || body.shotIds.length > 4
      || new Set(body.shotIds).size !== body.shotIds.length || !body.shotIds.every(id => typeof id === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(id))
      || !integer(body.fireAt, 1, Number.MAX_SAFE_INTEGER) || !integer(body.intervalMs, 1000, 30000)
      || !profile || typeof profile !== "object" || Array.isArray(profile)) invalid();
    const p = profile as Record<string, unknown>;
    if (!shape(p, ["maxPhotoBytes", "maxPhotoPixels", "shotsPerMember"]) || !integer(p.maxPhotoBytes, 1, 10 * 1024 * 1024) || !integer(p.maxPhotoPixels, 1, 12 * 1024 * 1024) || p.shotsPerMember !== (body.shotIds as unknown[]).length) invalid();
  } else if (action === "capture") {
    if (!shape(body, ["captureId"], ["peerId"]) || !uuid(body.captureId) || (body.peerId !== undefined && !uuid(body.peerId))) invalid();
  } else if (action === "ack") {
    if (!shape(body, ["captureId", "rosterRevision", "recipeHash"]) || !uuid(body.captureId) || !integer(body.rosterRevision, 1, Number.MAX_SAFE_INTEGER) || typeof body.recipeHash !== "string" || !HASH.test(body.recipeHash)) invalid();
  } else if (!shape(body, ["captureId"]) || !uuid(body.captureId)) invalid();
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") invalid();
  const size = Number(request.headers.get("content-length") ?? 0);
  if (!integer(size, 0, ROOM_LIMITS.bodyBytes) || !request.body) invalid();
  const reader = request.body!.getReader(), chunks: Uint8Array[] = [];
  let total = 0, expired = false;
  const timer = setTimeout(() => { expired = true; void reader.cancel().catch(() => {}); }, 5000);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (expired) invalid();
      if (done) break;
      total += value.length;
      if (total > ROOM_LIMITS.bodyBytes) { await reader.cancel(); invalid(); }
      chunks.push(value);
    }
    const data = new Uint8Array(total); let at = 0;
    for (const chunk of chunks) { data.set(chunk, at); at += chunk.length; }
    try {
      const body: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
      if (!body || typeof body !== "object" || Array.isArray(body)) invalid();
      return body as Record<string, unknown>;
    } catch { return invalid(); }
  } finally { clearTimeout(timer); reader.releaseLock(); }
}

function secureRequest(request: Request, env: Record<string, string | undefined>) {
  const url = new URL(request.url);
  const local = env.NODE_ENV === "development" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !local) throw new RoomServerError("unavailable", 503);
  return !local;
}
function enabled(env: Record<string, string | undefined>) {
  if (env.PB_ROOM_V2_ENABLED !== "true" || !env.PB_ROOM_RATE_SECRET || env.PB_ROOM_RATE_SECRET.length < 32) throw new RoomServerError("unavailable", 503);
  if (env.NODE_ENV !== "development" && (!canonicalPublicOrigin(env.PB_PUBLIC_ORIGIN) || !/^[a-z][a-z0-9-]{0,63}$/.test(env.PB_ROOM_TRUSTED_IP_HEADER ?? ""))) throw new RoomServerError("unavailable", 503);
}
function rateHash(request: Request, env: Record<string, string | undefined>): string {
  const header = env.PB_ROOM_TRUSTED_IP_HEADER;
  const ip = header && /^[a-z][a-z0-9-]{0,63}$/.test(header) ? request.headers.get(header)?.trim() : env.NODE_ENV === "development" ? "127.0.0.1" : null;
  if (!ip || !isIP(ip)) throw new RoomServerError("unavailable", 503);
  return createHmac("sha256", env.PB_ROOM_RATE_SECRET!).update(ip).digest("hex");
}
function cookieName(id: string, secure: boolean) { return `${secure ? "__Secure-" : ""}pb-room-${id}`; }
function readToken(request: Request, id: string, secure: boolean): string {
  const entries = (request.headers.get("cookie") ?? "").split(";").map(value => value.trim().split("="));
  const matches = entries.filter(([name]) => name === cookieName(id, secure));
  if (matches.length !== 1 || !/^[a-zA-Z0-9_-]{43}$/.test(matches[0][1] ?? "")) throw new RoomServerError("access_denied", 403);
  return matches[0][1];
}
function setToken(response: Response, id: string, token: string, secure: boolean, seconds: number) {
  response.headers.append("Set-Cookie", `${cookieName(id, secure)}=${token}; Path=/api/rooms/${id}; Max-Age=${seconds}; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`);
}

type Operation = "capabilities" | "create" | "join" | RoomAction;
export function createRoomHandler(operation: Operation, makeStore: (env: Record<string, string | undefined>) => RoomStore = createRoomStore, getEnv: () => Record<string, string | undefined> = () => process.env) {
  return async (request: Request, roomId?: string): Promise<Response> => {
    try {
      const env = getEnv(); enabled(env);
      const secure = secureRequest(request, env);
      if (new URL(request.url).search) invalid();
      if (operation === "capabilities") {
        rateHash(request, env);
        const store = makeStore(env); await store.ready();
        return privateJson({ enabled: true, protocol: 2, limits: ROOM_LIMITS });
      }
      try { requireSameOrigin(request, env); } catch (error) {
        if (error instanceof RequestValidationError && error.status === 403) throw new RoomServerError("origin_denied", 403);
        throw new RoomServerError("unavailable", 503);
      }
      const body = await readBody(request); validateRoomBody(operation, body);
      if (operation !== "create" && operation !== "join" && (!roomId || !UUID.test(roomId))) invalid();
      const token = operation === "create" || operation === "join" ? randomBytes(32).toString("base64url") : readToken(request, roomId!, secure);
      const nextToken = createHash("sha256").update(`room-member:${roomId}:${token}`).digest("base64url");
      const hash = rateHash(request, env), store = makeStore(env);
      await store.ready(); await store.rate(hash, operation === "create" || operation === "join" ? operation : "call");
      let result: Record<string, unknown>;
      if (operation === "create") {
        const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        const code = Array.from({ length: 6 }, () => alphabet[randomInt(alphabet.length)]).join("");
        result = await store.create({ roomId: randomUUID(), memberId: randomUUID(), code, hash: digest(token), name: body.displayName as string, rateHash: hash });
      } else if (operation === "join") {
        result = await store.join({ code: body.code as string, memberId: randomUUID(), hash: digest(token), name: body.displayName as string, rateHash: hash });
      } else result = await store.call(roomId!, digest(token), operation, body, digest(nextToken));
      const { exchanged, ...publicResult } = result;
      const response = privateJson(publicResult, operation === "create" || operation === "join" ? 201 : 200);
      if (operation === "create" || operation === "join") {
        if (!uuid(result.roomId)) throw new RoomServerError("unavailable", 503);
        setToken(response, result.roomId as string, token, secure, operation === "join" ? ROOM_LIMITS.admissionSeconds : ROOM_LIMITS.roomSeconds);
      } else if (operation === "state" && exchanged === true) setToken(response, roomId!, nextToken, secure, ROOM_LIMITS.roomSeconds);
      else if (operation === "end") setToken(response, roomId!, "", secure, 0);
      return response;
    } catch (error) {
      const failure = error instanceof RoomServerError ? error : new RoomServerError("unavailable", 503);
      const response = privateJson({ error: failure.code, ...(operation === "capabilities" ? { enabled: false, protocol: 2 } : {}), ...(failure.code === "rate_limited" ? { retryAfterMs: 60000 } : {}) }, failure.status);
      if (failure.code === "rate_limited") response.headers.set("Retry-After", "60");
      return response;
    }
  };
}

export function isRoomAction(value: string): value is RoomAction { return ACTIONS.includes(value as RoomAction); }
