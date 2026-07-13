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
): Promise<void> {
  const supabase = createClient();
  const { error } = await supabase.from("pb_photo_dates").insert({
    couple_id: coupleId,
    created_by: userId,
    title: data.title,
    scheduled_at: data.scheduledAt,
    cadence: data.cadence,
  });
  if (error) throw error;
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

export async function deletePhotoDate(id: string): Promise<void> {
  const supabase = createClient();
  await supabase.from("pb_photo_dates").delete().eq("id", id);
}
