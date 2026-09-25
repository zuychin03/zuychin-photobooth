import { RoomApiError, validateRoomState } from "./signaling-v2";
import { UUID_PATTERN } from "./protocol";
import type { RoomState } from "../server/room-contract";

export type V2RoomTarget = { kind: "create" } | { kind: "join"; code: string } | { kind: "resume"; code: string; roomId: string } | { kind: "invalid" };
export const isV2RoomCode = (code: string): boolean => /^[A-Z2-9]{6}$/.test(code);
type MappingStorage = Pick<Storage, "getItem" | "setItem">;
interface RememberedRoom { code: string; roomId: string }
function mappingKey(scope: string): string {
  if (scope !== "device" && !(scope.startsWith("account:") && UUID_PATTERN.test(scope.slice(8)))) throw new Error("invalid_scope");
  return `pb-room-v2-lookup:${scope}`;
}
function roomMappings(scope: string, storage: MappingStorage): RememberedRoom[] {
  const raw = storage.getItem(mappingKey(scope));
  if (!raw || raw.length > 4096) return [];
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value) || value.length > 8 || value.some(item => !item || typeof item !== "object" || Object.keys(item).length !== 2 || typeof item.code !== "string" || typeof item.roomId !== "string" || !isV2RoomCode(item.code) || !UUID_PATTERN.test(item.roomId))) return [];
  return value;
}
export function rememberedRoomId(scope: string, code: string, storage?: MappingStorage): string | null {
  try { return roomMappings(scope, storage ?? globalThis.localStorage).find(item => item.code === code)?.roomId ?? null; } catch { return null; }
}
export function rememberRoom(scope: string, room: Pick<RoomState, "code" | "roomId">, storage?: MappingStorage): void {
  try {
    if (!isV2RoomCode(room.code) || !UUID_PATTERN.test(room.roomId)) return;
    const target = storage ?? globalThis.localStorage;
    const previous = roomMappings(scope, target).filter(item => item.code !== room.code && item.roomId !== room.roomId);
    target.setItem(mappingKey(scope), JSON.stringify([{ code: room.code, roomId: room.roomId }, ...previous].slice(0, 8)));
  } catch { /* A public lookup hint is optional; room authority stays in HttpOnly cookies. */ }
}
export function forgetRememberedRoom(scope: string, code: string, roomId: string, storage?: MappingStorage): void {
  try {
    const target = storage ?? globalThis.localStorage;
    target.setItem(mappingKey(scope), JSON.stringify(roomMappings(scope, target).filter(item => item.code !== code || item.roomId !== roomId)));
  } catch { /* A failed hint cleanup cannot grant room access. */ }
}
export function roomEntryRoute(code: string, search: Pick<URLSearchParams, "get" | "getAll">): V2RoomTarget | { kind: "legacy" } {
  if (search.get("v") !== "2") return { kind: "legacy" };
  if (search.getAll("v").length !== 1 || search.getAll("id").length > 1) return { kind: "invalid" };
  const id = search.get("id");
  if (code === "new" && id === null) return { kind: "create" };
  const normalised = code.toUpperCase();
  if (!isV2RoomCode(normalised)) return { kind: "invalid" };
  if (id === null) return { kind: "join", code: normalised };
  return UUID_PATTERN.test(id) ? { kind: "resume", code: normalised, roomId: id } : { kind: "invalid" };
}
export function roomV2Url(code: string, roomId?: string): string {
  if (!isV2RoomCode(code) || (roomId !== undefined && !UUID_PATTERN.test(roomId))) throw new RoomApiError("invalid_request", 400);
  return `/room/${code}?v=2${roomId ? `&id=${roomId}` : ""}`;
}
export function roomDisplayName(value: string): string {
  const name = value.trim();
  if (!name || name.length > 40 || /[\u0000-\u001f\u007f]/.test(name)) throw new RoomApiError("invalid_name", 400);
  return name;
}
async function responseData(response: Response): Promise<Record<string, unknown>> {
  if (!response.body) throw new RoomApiError("invalid_response", 503);
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.length;
      if (length > 64 * 1024) { await reader.cancel(); throw new RoomApiError("invalid_response", 503); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new RoomApiError("invalid_response", 503); }
}
export function createRoomEntryApi(options: { fetch?: typeof fetch; signal?: AbortSignal } = {}) {
  const request = options.fetch ?? fetch;
  async function call(path: string, body?: Record<string, string>) {
    const timeout = AbortSignal.timeout(10000), signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
    signal.throwIfAborted();
    const response = await request(path, { method: body ? "POST" : "GET", credentials: "same-origin", cache: "no-store", redirect: "error", signal, ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
    const value = await responseData(response); signal.throwIfAborted();
    if (!response.ok) {
      throw new RoomApiError(typeof value.error === "string" && /^[a-z_]{1,40}$/.test(value.error) ? value.error : "unavailable", response.status, typeof value.retryAfterMs === "number" && Number.isFinite(value.retryAfterMs) ? Math.min(60000, Math.max(0, value.retryAfterMs)) : 0);
    }
    return value;
  }
  return {
    async capabilities(): Promise<void> {
      const value = await call("/api/rooms/capabilities");
      if (value.enabled !== true || value.protocol !== 2) throw new RoomApiError("unavailable", 503);
    },
    async enter(target: { kind: "create" } | { kind: "join"; code: string }, displayName: string): Promise<RoomState> {
      const name = roomDisplayName(displayName);
      if (target.kind === "join" && !isV2RoomCode(target.code)) throw new RoomApiError("invalid_request", 400);
      const state = validateRoomState(await call(target.kind === "create" ? "/api/rooms" : "/api/rooms/join", target.kind === "create" ? { displayName: name } : { displayName: name, code: target.code }));
      if (target.kind === "join" && state.code !== target.code) throw new RoomApiError("invalid_response", 503);
      return state;
    },
  };
}
export function roomEntryError(error: unknown, resuming = false): string {
  if (error instanceof RoomApiError) {
    if (error.code === "invalid_name") return "Enter a display name of 1–40 characters, without line breaks.";
    if (error.code === "rate_limited") return "Too many room requests. Wait a minute, then try again.";
    if (error.code === "room_full") return "This room is full. Ask the host to make space, or start another room.";
    if (error.code === "access_denied") return resuming ? "This browser no longer has access to that room. You can ask to join again." : "We could not join that room. Check the code with the host; the room may have closed.";
    if (["state_conflict", "not_ready"].includes(error.code)) return "This room is not accepting new guests right now. Check with the host before trying again.";
    if (error.code === "unavailable") return "Live rooms are unavailable here right now. You can still use the solo booth or your saved projects.";
  }
  return "The room request could not be confirmed. Check your connection and try again.";
}
