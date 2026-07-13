import { createClient } from "./supabase/client";
import { newRoomCode } from "./room-code";

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
  created_at: string;
}

export interface TimelineStrip extends StripRow {
  url: string | null;
  mine: boolean;
}

const BUCKET = "photobooth-strips";

/** The current user's couple: a completed pair, or a pending one they created. */
export async function getMyCouple(userId: string): Promise<Couple | null> {
  const supabase = createClient();
  const { data } = await supabase
    .from("pb_couples")
    .select("*")
    .or(`member_a.eq.${userId},member_b.eq.${userId}`)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
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
  await supabase.from("pb_couples").delete().eq("id", coupleId);
}

/** Upload a strip PNG and record it on the couple's timeline. */
export async function saveStrip(
  userId: string,
  coupleId: string | null,
  blob: Blob,
  meta: { layoutId: string; caption: string },
): Promise<void> {
  const supabase = createClient();
  const id = crypto.randomUUID();
  const path = `${userId}/${id}.png`;
  const up = await supabase.storage.from(BUCKET).upload(path, blob, {
    contentType: "image/png",
    upsert: false,
  });
  if (up.error) throw up.error;
  const { error } = await supabase.from("pb_strips").insert({
    id,
    owner: userId,
    couple_id: coupleId,
    storage_path: path,
    layout_id: meta.layoutId,
    caption: meta.caption || null,
  });
  if (error) throw error;
}

/** Couple timeline, newest first, with short-lived signed image URLs. */
export async function listStrips(userId: string): Promise<TimelineStrip[]> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("pb_strips")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw error;
  const rows = (data as StripRow[]) ?? [];
  return Promise.all(
    rows.map(async (row) => {
      const signed = await supabase.storage
        .from(BUCKET)
        .createSignedUrl(row.storage_path, 3600);
      return { ...row, url: signed.data?.signedUrl ?? null, mine: row.owner === userId };
    }),
  );
}

export async function deleteStrip(strip: StripRow): Promise<void> {
  const supabase = createClient();
  await supabase.storage.from(BUCKET).remove([strip.storage_path]);
  await supabase.from("pb_strips").delete().eq("id", strip.id);
}
