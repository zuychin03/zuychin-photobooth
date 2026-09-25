import { createClient } from "@supabase/supabase-js";
import type { RoomAction, RoomErrorCode } from "./room-contract";
import { supabaseServiceOrigin } from "./cron-auth";

export class RoomServerError extends Error {
  constructor(readonly code: RoomErrorCode, readonly status: number) { super(code); }
}
export interface RoomStore {
  ready(): Promise<void>;
  rate(rateHash: string, action: "create" | "join" | "call"): Promise<void>;
  create(input: { roomId: string; memberId: string; code: string; hash: string; name: string; rateHash: string }): Promise<Record<string, unknown>>;
  join(input: { code: string; memberId: string; hash: string; name: string; rateHash: string }): Promise<Record<string, unknown>>;
  call(roomId: string, hash: string, action: RoomAction, body: Record<string, unknown>, nextHash: string): Promise<Record<string, unknown>>;
}

export function createRoomStore(env: Record<string, string | undefined> = process.env): RoomStore {
  const url = supabaseServiceOrigin(env.NEXT_PUBLIC_SUPABASE_URL), key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key?.trim()) throw new RoomServerError("unavailable", 503);
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: (input, init) => fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000) }) } });
  const rpc = async (name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    const { data, error } = await client.rpc(name, args);
    if (error) {
      const code = error.message;
      if (code === "PB_ROOM_DENIED") throw new RoomServerError("access_denied", 403);
      if (code === "PB_ROOM_RATE_LIMIT") throw new RoomServerError("rate_limited", 429);
      if (code === "PB_ROOM_CAPACITY") throw new RoomServerError("room_full", 409);
      if (code === "PB_ROOM_CONFLICT") throw new RoomServerError("state_conflict", 409);
      if (code === "PB_ROOM_NOT_READY") throw new RoomServerError("not_ready", 409);
      if (code === "PB_ROOM_INVALID" || error.code?.startsWith("22")) throw new RoomServerError("invalid_request", 400);
      throw new RoomServerError("unavailable", 503);
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new RoomServerError("unavailable", 503);
    return data;
  };
  return {
    async ready() {
      const data = await rpc("pb_room_capabilities");
      if (data.version !== 1 || data.protocol !== 2 || data.ready !== true || data.maxMembers !== 4 || data.totalPhotoBytes !== 50331648 || data.totalPhotoPixels !== 37748736) throw new RoomServerError("unavailable", 503);
    },
    async rate(rateHash, action) { await rpc("pb_room_check_rate", { p_rate_hash: rateHash, p_action: action }); },
    create: input => rpc("pb_room_create", { p_room_id: input.roomId, p_member_id: input.memberId, p_code: input.code, p_hash: input.hash, p_name: input.name, p_rate_hash: input.rateHash }),
    join: input => rpc("pb_room_join", { p_code: input.code, p_member_id: input.memberId, p_hash: input.hash, p_name: input.name, p_rate_hash: input.rateHash }),
    call: (roomId, hash, action, body, nextHash) => rpc("pb_room_call", { p_room_id: roomId, p_hash: hash, p_action: action, p_body: body, p_next_hash: nextHash }),
  };
}
