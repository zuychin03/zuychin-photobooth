import { createClient } from "./supabase/client";
import { canvasToJpeg, blobToCanvas } from "./capture";
import type { ShotStore } from "./session";

const BUCKET = "photobooth-strips";

export interface Relay {
  id: string;
  couple_id: string;
  initiator: string;
  partner: string | null;
  layout_id: string;
  filter_id: string;
  scene_id: string | null;
  shots: number;
  a_done: boolean;
  b_done: boolean;
  status: "pending" | "complete";
  created_at: string;
}

export interface RelayMeta {
  layoutId: string;
  filterId: string;
  sceneId: string | null;
  shots: number;
}

function framePath(uid: string, relayId: string, role: "A" | "B", shot: number): string {
  return `${uid}/relay-${relayId}/${role}-${shot}.jpg`;
}

async function uploadFrames(
  uid: string,
  relayId: string,
  role: "A" | "B",
  frames: HTMLCanvasElement[],
): Promise<void> {
  const supabase = createClient();
  for (let i = 0; i < frames.length; i++) {
    const blob = await canvasToJpeg(frames[i]);
    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(framePath(uid, relayId, role, i), blob, {
        contentType: "image/jpeg",
        upsert: true,
      });
    if (error) throw error;
  }
}

/** Initiator (role A) starts a relay and uploads their half. */
export async function createRelay(
  userId: string,
  coupleId: string,
  meta: RelayMeta,
  frames: HTMLCanvasElement[],
): Promise<string> {
  const supabase = createClient();
  const id = crypto.randomUUID();
  await uploadFrames(userId, id, "A", frames);
  const { error } = await supabase.from("pb_relays").insert({
    id,
    couple_id: coupleId,
    initiator: userId,
    layout_id: meta.layoutId,
    filter_id: meta.filterId,
    scene_id: meta.sceneId,
    shots: meta.shots,
    a_done: true,
  });
  if (error) throw error;
  return id;
}

/** Partner (role B) finishes a relay and uploads their half. */
export async function completeRelay(
  userId: string,
  relay: Relay,
  frames: HTMLCanvasElement[],
): Promise<void> {
  const supabase = createClient();
  await uploadFrames(userId, relay.id, "B", frames);
  const { error } = await supabase
    .from("pb_relays")
    .update({ partner: userId, b_done: true, status: "complete" })
    .eq("id", relay.id);
  if (error) throw error;
}

export async function getRelay(id: string): Promise<Relay | null> {
  const supabase = createClient();
  const { data } = await supabase.from("pb_relays").select("*").eq("id", id).maybeSingle();
  return (data as Relay) ?? null;
}

export async function listRelays(): Promise<Relay[]> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("pb_relays")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data as Relay[]) ?? [];
}

export async function deleteRelay(id: string): Promise<void> {
  const supabase = createClient();
  await supabase.from("pb_relays").delete().eq("id", id);
}

/** Whose turn: the partner completes when A is done and B is not. */
export function relayIsMyTurn(relay: Relay, userId: string): boolean {
  return relay.status === "pending" && relay.a_done && !relay.b_done && relay.initiator !== userId;
}

/** Hydrate a ShotStore from both halves (paths are deterministic). */
export async function loadRelayShots(relay: Relay): Promise<ShotStore> {
  const supabase = createClient();
  const fetchRole = async (uid: string | null, role: "A" | "B") => {
    const out: (HTMLCanvasElement | null)[] = [];
    if (!uid) return out;
    for (let i = 0; i < relay.shots; i++) {
      const signed = await supabase.storage
        .from(BUCKET)
        .createSignedUrl(framePath(uid, relay.id, role, i), 3600);
      if (!signed.data?.signedUrl) {
        out.push(null);
        continue;
      }
      const blob = await (await fetch(signed.data.signedUrl)).blob();
      out.push(await blobToCanvas(blob));
    }
    return out;
  };
  const [A, B] = await Promise.all([
    fetchRole(relay.initiator, "A"),
    fetchRole(relay.partner, "B"),
  ]);
  return { A, B, C: [], D: [] };
}
