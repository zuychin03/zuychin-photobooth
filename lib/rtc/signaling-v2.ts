import type { RoomAction, RoomCapture, RoomCaptureProposal, RoomSignalInput, RoomSignalPage, RoomState } from "../server/room-contract";
import { ROOM_LIMITS } from "../server/room-contract";
import { UUID_PATTERN } from "./protocol";

export class RoomApiError extends Error {
  constructor(readonly code: string, readonly status: number, readonly retryAfterMs = 0) { super(code); }
}
const validId = (value: unknown) => typeof value === "string" && UUID_PATTERN.test(value);
const finiteInt = (value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RoomApiError("invalid_response", 503);
  return value as Record<string, unknown>;
};
export function validateRoomCapture(value: unknown): RoomCapture {
  const c = object(value), profile = object(c.profile);
  if (!validId(c.captureId) || !finiteInt(c.rosterRevision, 1) || typeof c.recipeHash !== "string" || !/^[a-f0-9]{64}$/.test(c.recipeHash)
    || !Array.isArray(c.shotIds) || !finiteInt(c.shotIds.length, 1, 4) || new Set(c.shotIds).size !== c.shotIds.length || !c.shotIds.every(id => typeof id === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(id))
    || !Array.isArray(c.memberIds) || !finiteInt(c.memberIds.length, 2, 4) || new Set(c.memberIds).size !== c.memberIds.length || !c.memberIds.every(validId)
    || !Array.isArray(c.acks) || new Set(c.acks).size !== c.acks.length || !c.acks.every(id => (c.memberIds as unknown[]).includes(id))
    || !["prepared", "committed", "aborted"].includes(c.state as string) || !finiteInt(c.fireAt, 1) || !finiteInt(c.intervalMs, 1000, 30000)
    || profile.shotsPerMember !== c.shotIds.length || !finiteInt(profile.maxPhotoBytes, 1, 10485760) || !finiteInt(profile.maxPhotoPixels, 1, 12582912)
    || c.memberIds.length * c.shotIds.length * (profile.maxPhotoBytes as number) > ROOM_LIMITS.totalPhotoBytes || c.memberIds.length * c.shotIds.length * (profile.maxPhotoPixels as number) > ROOM_LIMITS.totalPhotoPixels) throw new RoomApiError("invalid_response", 503);
  return structuredClone(c) as unknown as RoomCapture;
}
export function validateRoomState(value: unknown): RoomState {
  const s = object(value);
  if (![s.roomId, s.sessionId, s.hostId, s.selfId, s.connectionEpoch].every(validId) || typeof s.code !== "string" || !/^[A-Z2-9]{6}$/.test(s.code)
    || ![null, "A", "B", "C", "D"].includes(s.selfRole as string | null) || !["open", "ended"].includes(s.status as string) || typeof s.locked !== "boolean"
    || !finiteInt(s.rosterRevision, 1) || !finiteInt(s.expiresAt, 1) || !finiteInt(s.serverNow, 1) || !Array.isArray(s.members) || s.members.length > 12) throw new RoomApiError("invalid_response", 503);
  const ids = new Set<string>(), roles = new Set<string>();
  for (const value of s.members) {
    const m = object(value);
    if (!validId(m.id) || !validId(m.connectionEpoch) || ids.has(m.id as string) || !["pending", "admitted", "removed"].includes(m.status as string)
      || typeof m.displayName !== "string" || m.displayName.length < 1 || m.displayName.length > 40 || ![null, "A", "B", "C", "D"].includes(m.role as string | null)) throw new RoomApiError("invalid_response", 503);
    ids.add(m.id as string);
    if (m.status === "admitted") { if (!m.role || roles.has(m.role as string)) throw new RoomApiError("invalid_response", 503); roles.add(m.role as string); }
  }
  if (!ids.has(s.selfId as string)) throw new RoomApiError("invalid_response", 503);
  if (s.capture !== null) validateRoomCapture(s.capture);
  return structuredClone(s) as unknown as RoomState;
}
export interface RoomApi {
  state(renewConnection?: boolean): Promise<RoomState>;
  signal(input: RoomSignalInput): Promise<{ cursor: number }>;
  poll(cursor: number): Promise<RoomSignalPage>;
  prepare(input: RoomCaptureProposal): Promise<RoomCapture>;
  ack(capture: RoomCapture): Promise<RoomCapture>;
  commit(id: string): Promise<RoomCapture>;
  abort(id: string): Promise<RoomCapture>;
  capture(id: string, peerId?: string): Promise<RoomCapture>;
  control(action: "admit" | "remove" | "lock" | "end", body: Record<string, unknown>): Promise<RoomState | { ended: true }>;
}
export function createRoomApi(roomId: string, options: { fetch?: typeof fetch; signal?: AbortSignal } = {}): RoomApi {
  if (!UUID_PATTERN.test(roomId)) throw new RoomApiError("invalid_request", 400);
  const request = options.fetch ?? fetch;
  const call = async <T,>(action: RoomAction, body: unknown): Promise<T> => {
    const timeout = AbortSignal.timeout(10000), signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
    const response = await request(`/api/rooms/${roomId}/${action}`, { method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
    if (!response.body) throw new RoomApiError("invalid_response", 503);
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 640 * 1024) { await reader.cancel(); throw new RoomApiError("invalid_response", 503); } chunks.push(value); }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    let value: unknown; try { value = JSON.parse(raw); } catch { throw new RoomApiError("invalid_response", 503); }
    if (!response.ok) {
      const data = value as { error?: unknown; retryAfterMs?: unknown };
      throw new RoomApiError(typeof data?.error === "string" && /^[a-z_]{1,40}$/.test(data.error) ? data.error : "unavailable", response.status, typeof data?.retryAfterMs === "number" ? Math.min(60000, Math.max(0, data.retryAfterMs)) : 0);
    }
    if (["state", "admit", "remove", "lock"].includes(action)) validateRoomState(value);
    else if (["prepare", "ack", "commit", "abort", "capture"].includes(action)) validateRoomCapture(value);
    else if (action === "poll") {
      const page = object(value);
      if (!finiteInt(page.cursor) || !finiteInt(page.serverNow, 1) || typeof page.resetRequired !== "boolean" || !Array.isArray(page.signals) || page.signals.length > 16) throw new RoomApiError("invalid_response", 503);
      for (const raw of page.signals) {
        const signal = object(raw);
        if (!finiteInt(signal.id, 1) || ![signal.messageId, signal.fromMemberId, signal.toMemberId, signal.connectionEpoch].every(validId)
          || !["sdp", "ice"].includes(signal.kind as string) || typeof signal.payload !== "string" || new TextEncoder().encode(signal.payload).length > (signal.kind === "sdp" ? ROOM_LIMITS.sdpBytes : ROOM_LIMITS.iceBytes) || !finiteInt(signal.createdAt, 1)) throw new RoomApiError("invalid_response", 503);
      }
    }
    return value as T;
  };
  return {
    state: renewConnection => call("state", renewConnection ? { renewConnection: true } : {}),
    signal: input => call("signal", input), poll: cursor => call("poll", { cursor, limit: ROOM_LIMITS.signalPage }),
    prepare: input => call("prepare", input), ack: capture => call("ack", { captureId: capture.captureId, recipeHash: capture.recipeHash, rosterRevision: capture.rosterRevision }),
    commit: captureId => call("commit", { captureId }), abort: captureId => call("abort", { captureId }), capture: (captureId, peerId) => call("capture", { captureId, ...(peerId ? { peerId } : {}) }),
    control: (action, body) => call(action, body),
  };
}
