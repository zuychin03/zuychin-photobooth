import { createClient } from "./supabase/client";
import { canvasToJpeg, blobToCanvas } from "./capture";
import type { ShotStore } from "./session";
import { LAYOUTS } from "./layouts";
import { FILTERS } from "./filters";
import { SCENES } from "./scenes";
import { cloudWriteError, readBoundedImage, relayUploadRequestId, requireUuid, uploadImmutable, withUploadIntent, type UploadIdentity } from "./upload-intent";

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

export interface RelayMeta { layoutId: string; filterId: string; sceneId: string | null; shots: number }

export function validateRelayMeta(meta: RelayMeta, frameCount = meta.shots): void {
  const layout = LAYOUTS.find(value => value.id === meta.layoutId && value.mode === "duo");
  if (!layout || layout.shots !== meta.shots || !Number.isInteger(meta.shots) || meta.shots < 1 || meta.shots > 4
    || frameCount !== meta.shots || !FILTERS.some(filter => filter.id === meta.filterId)
    || (meta.sceneId !== null && !SCENES.some(scene => scene.id === meta.sceneId))) {
    throw new Error("The relay layout, frame count or look is not valid.");
  }
}

function framePath(uid: string, relayId: string, role: "A" | "B", shot: number): string {
  return `${uid}/relay-${relayId}/${role}-${shot}.jpg`;
}

async function uploadFrames(supabase: ReturnType<typeof createClient>, paths: string[], frames: HTMLCanvasElement[]): Promise<void> {
  for (let i = 0; i < frames.length; i++) {
    if (frames[i].width < 1 || frames[i].height < 1 || frames[i].width * frames[i].height > 24_000_000) throw new Error("A relay photo exceeds the supported dimensions.");
    const blob = await canvasToJpeg(frames[i]);
    await uploadImmutable(supabase.storage.from(BUCKET), paths[i], blob, "image/jpeg");
  }
}

/** Register cleanup before uploading either participant's frames. */
export async function createRelay(
  userId: string, coupleId: string, meta: RelayMeta, frames: HTMLCanvasElement[], identity: UploadIdentity = {},
): Promise<string> {
  requireUuid(userId);
  requireUuid(coupleId);
  validateRelayMeta(meta, frames.length);
  const supabase = createClient();
  const id = identity.id ?? crypto.randomUUID();
  const paths = frames.map((_, shot) => framePath(userId, id, "A", shot));
  return withUploadIntent(supabase, { requestId: identity.requestId ?? id, sourceId: id, sourceType: "relay", owner: userId, paths }, async () => {
    const { data, error } = await supabase.from("pb_relays").select("*").eq("id", id).maybeSingle();
    if (error) throw cloudWriteError(error);
    if (!data) return null;
    if (data.initiator !== userId || data.couple_id !== coupleId || data.layout_id !== meta.layoutId || data.filter_id !== meta.filterId || data.scene_id !== meta.sceneId || data.shots !== meta.shots || !data.a_done) {
      throw new Error("This save ID belongs to a different relay. Start a new relay save.");
    }
    return id;
  }, async () => {
    await uploadFrames(supabase, paths, frames);
    const { error } = await supabase.from("pb_relays").insert({
      id, couple_id: coupleId, initiator: userId, layout_id: meta.layoutId, filter_id: meta.filterId,
      scene_id: meta.sceneId, shots: meta.shots, a_done: true,
    });
    if (error) throw cloudWriteError(error);
    return id;
  });
}

export async function completeRelay(userId: string, relay: Relay, frames: HTMLCanvasElement[], requestId?: string): Promise<void> {
  requireUuid(userId);
  requireUuid(relay.id);
  validateRelayMeta({ layoutId: relay.layout_id, filterId: relay.filter_id, sceneId: relay.scene_id, shots: relay.shots }, frames.length);
  if (relay.initiator === userId || !relay.a_done) throw new Error("This relay is not ready for your half.");
  const supabase = createClient();
  const paths = frames.map((_, shot) => framePath(userId, relay.id, "B", shot));
  await withUploadIntent(supabase, { requestId: requestId ?? await relayUploadRequestId(relay.id, userId), sourceId: relay.id, sourceType: "relay", owner: userId, paths }, async () => {
    const { data, error } = await supabase.from("pb_relays").select("*").eq("id", relay.id).maybeSingle();
    if (error) throw cloudWriteError(error);
    if (!data) throw new Error("This relay is no longer available.");
    if (data.couple_id !== relay.couple_id || data.initiator !== relay.initiator || data.shots !== relay.shots || data.layout_id !== relay.layout_id || data.filter_id !== relay.filter_id || data.scene_id !== relay.scene_id) {
      throw new Error("This relay has changed. Reload it before trying again.");
    }
    if (data.b_done && data.partner === userId && data.status === "complete") return true;
    if (data.status !== "pending" || data.b_done) throw new Error("This relay has already been completed.");
    return null;
  }, async () => {
    await uploadFrames(supabase, paths, frames);
    const { data, error } = await supabase.from("pb_relays")
      .update({ partner: userId, b_done: true, status: "complete" }).eq("id", relay.id).eq("status", "pending").eq("b_done", false).select("id");
    if (error) throw cloudWriteError(error);
    if (data?.length !== 1) throw new Error("This relay changed before the save completed. Reload it to check its status.");
    return true;
  });
}

export async function getRelay(id: string): Promise<Relay | null> {
  requireUuid(id);
  const supabase = createClient();
  const { data, error } = await supabase.from("pb_relays").select("*").eq("id", id).maybeSingle();
  if (error) throw cloudWriteError(error);
  return (data as Relay) ?? null;
}

export async function listRelays(): Promise<Relay[]> {
  const supabase = createClient();
  const { data, error } = await supabase.from("pb_relays").select("*").order("created_at", { ascending: false });
  if (error) throw cloudWriteError(error);
  return (data as Relay[]) ?? [];
}

export async function deleteRelay(id: string): Promise<{ pending: true }> {
  requireUuid(id);
  const supabase = createClient();
  const capabilities = await supabase.rpc("pb_lifecycle_capabilities");
  if (capabilities.error) throw cloudWriteError(capabilities.error);
  if (capabilities.data?.version !== 1 || capabilities.data?.ready !== true) throw new Error("Relay cleanup is unavailable until this deployment's storage setup is complete.");
  const { data, error } = await supabase.from("pb_relays").delete().eq("id", id).select("id");
  if (error) throw cloudWriteError(error);
  if (data?.length !== 1) throw new Error("Relay cancellation could not be confirmed. Reload to check its status.");
  return { pending: true };
}

export function relayIsMyTurn(relay: Relay, userId: string): boolean {
  return relay.status === "pending" && relay.a_done && !relay.b_done && relay.initiator !== userId;
}

export async function loadRelayShots(relay: Relay): Promise<ShotStore> {
  requireUuid(relay.id);
  requireUuid(relay.initiator);
  if (relay.partner) requireUuid(relay.partner);
  validateRelayMeta({ layoutId: relay.layout_id, filterId: relay.filter_id, sceneId: relay.scene_id, shots: relay.shots });
  const supabase = createClient();
  const fetchRole = async (uid: string | null, role: "A" | "B") => {
    const out: (HTMLCanvasElement | null)[] = [];
    if (!uid) return out;
    for (let i = 0; i < relay.shots; i++) {
      const signed = await supabase.storage.from(BUCKET).createSignedUrl(framePath(uid, relay.id, role, i), 3600);
      if (signed.error || !signed.data?.signedUrl) throw new Error("A relay photo could not be opened. Please try again.");
      const response = await fetch(signed.data.signedUrl, { signal: AbortSignal.timeout(20_000) });
      const blob = await readBoundedImage(response);
      out.push(await blobToCanvas(blob));
    }
    return out;
  };
  const [A, B] = await Promise.all([fetchRole(relay.initiator, "A"), fetchRole(relay.partner, "B")]);
  return { A, B, C: [], D: [] };
}
