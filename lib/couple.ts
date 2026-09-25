import { createClient } from "./supabase/client";
import { newRoomCode } from "./room-code";
import { cloudWriteError, requireUuid, uploadImmutable, withUploadIntent, type UploadIdentity } from "./upload-intent";
import { LAYOUTS } from "./layouts";

export interface Couple {
  id: string;
  member_a: string;
  member_b: string | null;
  pair_code: string | null;
}

export interface StripRow {
  id: string;
  owner: string;
  couple_id: string | null;
  storage_path: string;
  layout_id: string | null;
  caption: string | null;
  kept: boolean;
  cloudinary_public_id: string | null;
  cloudinary_url: string | null;
  purged: boolean;
  created_at: string;
}

export interface TimelineStrip extends StripRow {
  url: string | null;
  mine: boolean;
}

const BUCKET = "photobooth-strips";

/** The current user's couple: a completed pair, or a pending one they created. */
export async function getMyCouple(userId: string, signal?: AbortSignal): Promise<Couple | null> {
  const supabase = createClient();
  let query = supabase
    .from("pb_couples")
    .select("*")
    .or(`member_a.eq.${userId},member_b.eq.${userId}`)
    .order("created_at", { ascending: false })
    .limit(1);
  if (signal) query = query.abortSignal(signal);
  const { data, error } = await query.maybeSingle();
  if (error) throw cloudWriteError(error);
  return (data as Couple) ?? null;
}

/** Create a pending couple and return its share code. */
export async function createCouple(userId: string): Promise<Couple> {
  const supabase = createClient();
  const code = newRoomCode();
  const { data, error } = await supabase
    .from("pb_couples")
    .insert({ member_a: userId, pair_code: code })
    .select("*")
    .single();
  if (error) throw error;
  return data as Couple;
}

export async function joinCouple(code: string): Promise<string> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc("pb_join_couple", { code });
  if (error) throw error;
  return data as string;
}

export async function unpair(coupleId: string): Promise<void> {
  const supabase = createClient();
  const { error } = await supabase.from("pb_couples").delete().eq("id", coupleId);
  if (error) throw cloudWriteError(error);
}

/** Upload a strip PNG and record it on the couple's timeline. Returns the strip id. */
export async function saveStrip(
  userId: string,
  coupleId: string | null,
  blob: Blob,
  meta: { layoutId: string; caption: string },
  identity: UploadIdentity = {},
): Promise<string> {
  requireUuid(userId);
  if (coupleId) requireUuid(coupleId);
  if ((!LAYOUTS.some(layout => layout.id === meta.layoutId) && meta.layoutId !== "recap") || meta.caption.length > 2000) {
    throw new Error("The strip layout or caption is not valid.");
  }
  const supabase = createClient();
  const id = identity.id ?? crypto.randomUUID();
  const path = `${userId}/${id}.png`;
  return withUploadIntent(supabase, { requestId: identity.requestId ?? id, sourceId: id, sourceType: "strip", owner: userId, paths: [path] }, async () => {
    const { data, error } = await supabase.from("pb_strips").select("id,owner,couple_id,storage_path,layout_id,caption").eq("id", id).maybeSingle();
    if (error) throw cloudWriteError(error);
    if (!data) return null;
    if (data.owner !== userId || data.storage_path !== path || data.couple_id !== coupleId || data.layout_id !== meta.layoutId || data.caption !== (meta.caption || null)) {
      throw new Error("This save ID belongs to a different strip. Start a new save.");
    }
    return id;
  }, async () => {
    await uploadImmutable(supabase.storage.from(BUCKET), path, blob, "image/png");
    const { error } = await supabase.from("pb_strips").insert({ id, owner: userId, couple_id: coupleId, storage_path: path, layout_id: meta.layoutId, caption: meta.caption || null });
    if (error) throw cloudWriteError(error);
    return id;
  });
}

/** Couple timeline, newest first, with short-lived signed image URLs. */
export async function listStrips(userId: string): Promise<TimelineStrip[]> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("pb_strips")
    .select("*")
    .eq("purged", false)
    .order("created_at", { ascending: false });
  if (error) throw error;
  const rows = (data as StripRow[]) ?? [];
  return Promise.all(
    rows.map(async (row) => {
      const signed = await supabase.storage
        .from(BUCKET)
        .createSignedUrl(row.storage_path, 3600);
      if (signed.error) throw cloudWriteError(signed.error);
      return { ...row, url: signed.data?.signedUrl ?? null, mine: row.owner === userId };
    }),
  );
}

/** Pending operations must not be displayed as completed archives. */
export async function setStripKept(
  id: string,
  kept: boolean,
  requestId = crypto.randomUUID(),
): Promise<{ kept: boolean; pushed: boolean; pending: boolean; jobId?: string }> {
  const res = await fetch("/api/keep", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, kept, requestId }),
  });
  if (!res.ok) throw new Error("The archive change could not be confirmed. Please refresh and try again.");
  const data = await res.json() as { kept?: boolean; pushed?: boolean; pending?: boolean; jobId?: string };
  if (typeof data.kept !== "boolean" || typeof data.pushed !== "boolean" || typeof data.pending !== "boolean") throw new Error("The archive response could not be confirmed.");
  return { kept: data.kept, pushed: data.pushed, pending: data.pending, jobId: data.jobId };
}

export async function deleteStrip(strip: StripRow, requestId = crypto.randomUUID()): Promise<{ pending: boolean }> {
  requireUuid(strip.id);
  const response = await fetch(`/api/media/strips/${strip.id}`, {
    method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId }),
  });
  if (!response.ok) throw new Error("Deletion could not be confirmed. Please refresh and try again.");
  if (response.status !== 200 && response.status !== 202) throw new Error("The deletion response could not be confirmed.");
  const result = await response.json() as { pending?: boolean; deleted?: boolean };
  if (result.pending !== (response.status === 202) || (response.status === 200 && result.deleted !== true)) throw new Error("The deletion response could not be confirmed.");
  return { pending: response.status === 202 };
}
