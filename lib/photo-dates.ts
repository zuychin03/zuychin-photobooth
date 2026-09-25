import { createClient } from "./supabase/client";

export type Cadence = "once" | "weekly" | "monthly" | "yearly";

export const CADENCES: { id: Cadence; label: string }[] = [
  { id: "once", label: "One time" },
  { id: "weekly", label: "Every week" },
  { id: "monthly", label: "Every month" },
  { id: "yearly", label: "Every year" },
];

export interface PhotoDate {
  id: string;
  couple_id: string;
  created_by: string;
  title: string;
  scheduled_at: string;
  cadence: Cadence;
  active: boolean;
  last_sent_at: string | null;
  created_at: string;
}

/** Advance a due date to its next future occurrence (undefined for one-offs). */
export function nextOccurrence(
  scheduledAt: string,
  cadence: Cadence,
  now = new Date(),
): string | null {
  if (cadence === "once") return null;
  const d = new Date(scheduledAt);
  let guard = 0;
  while (d <= now && guard++ < 5000) {
    if (cadence === "weekly") d.setDate(d.getDate() + 7);
    else if (cadence === "monthly") d.setMonth(d.getMonth() + 1);
    else if (cadence === "yearly") d.setFullYear(d.getFullYear() + 1);
  }
  return d.toISOString();
}

export async function createPhotoDate(
  userId: string,
  coupleId: string,
  data: { title: string; scheduledAt: string; cadence: Cadence },
  options: { id?: string; signal?: AbortSignal; client?: ReturnType<typeof createClient> } = {},
): Promise<void> {
  const supabase = options.client ?? createClient(), id = options.id ?? crypto.randomUUID();
  const desired = {
    id,
    couple_id: coupleId,
    created_by: userId,
    title: data.title,
    scheduled_at: data.scheduledAt,
    cadence: data.cadence,
  };
  const existing = async () => {
    let query = supabase.from("pb_photo_dates").select("id,couple_id,created_by,title,scheduled_at,cadence").eq("id", id);
    if (options.signal) query = query.abortSignal(options.signal);
    const { data: found, error } = await query.maybeSingle();
    if (error) throw error;
    if (options.signal?.aborted) throw new Error("The reminder action was cancelled.");
    if (found && (found.couple_id !== coupleId || found.created_by !== userId || found.title !== data.title || Date.parse(found.scheduled_at) !== Date.parse(data.scheduledAt) || found.cadence !== data.cadence)) throw new Error("This reminder changed. Refresh before trying again.");
    return Boolean(found);
  };
  if (await existing()) return;
  let query = supabase.from("pb_photo_dates").insert(desired);
  if (options.signal) query = query.abortSignal(options.signal);
  const { error } = await query;
  if (error && !(error.code === "23505" && await existing())) throw error;
  if (options.signal?.aborted) throw new Error("The reminder action was cancelled. Refresh to check its status.");
}

export async function listPhotoDates(): Promise<PhotoDate[]> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("pb_photo_dates")
    .select("*")
    .eq("active", true)
    .order("scheduled_at", { ascending: true });
  if (error) throw error;
  return (data as PhotoDate[]) ?? [];
}

export async function deletePhotoDate(id: string, options: { signal?: AbortSignal; client?: ReturnType<typeof createClient> } = {}): Promise<void> {
  const supabase = options.client ?? createClient();
  let query = supabase.from("pb_photo_dates").delete().eq("id", id);
  if (options.signal) query = query.abortSignal(options.signal);
  const { error } = await query;
  if (error) throw error;
  if (options.signal?.aborted) throw new Error("The reminder action was cancelled. Refresh to check its status.");
}
