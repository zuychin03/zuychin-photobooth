import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { RETENTION_DAYS, retentionCutoffIso } from "@/lib/retention";

// Called on a schedule (same CRON_SECRET as the reminder route). Purges strips
// older than the retention window unless they are kept or a weekly recap.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BUCKET = "photobooth-strips";

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get("authorization");
  const provided = auth?.replace("Bearer ", "") ?? request.nextUrl.searchParams.get("secret");
  if (secret && provided !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ skipped: "service role not configured" });
  }

  const supabase = createAdminClient();
  const cutoff = retentionCutoffIso();

  // 1. Expired and not kept: drop the Storage object and the row. Recaps are the
  // week's keepsake; skip them. (Filtered in JS, not SQL, so a NULL layout_id
  // does not slip through a `<> 'recap'` compare.)
  const { data: expirable, error } = await supabase
    .from("pb_strips")
    .select("id, storage_path, layout_id")
    .eq("kept", false)
    .lt("created_at", cutoff);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const drop = (expirable ?? []).filter((r) => r.layout_id !== "recap");
  await removePaths(supabase, drop.map((r) => r.storage_path));
  if (drop.length > 0) {
    await supabase.from("pb_strips").delete().in("id", drop.map((r) => r.id));
  }

  // 2. Expired but kept and pushed to Cloudinary: drop only the Storage object;
  // keep the row (now served from Gallery/Cloudinary) and mark it purged.
  const { data: archivable } = await supabase
    .from("pb_strips")
    .select("id, storage_path")
    .eq("kept", true)
    .eq("purged", false)
    .not("cloudinary_public_id", "is", null)
    .lt("created_at", cutoff);

  const archive = archivable ?? [];
  await removePaths(supabase, archive.map((r) => r.storage_path));
  if (archive.length > 0) {
    await supabase.from("pb_strips").update({ purged: true }).in("id", archive.map((r) => r.id));
  }

  return NextResponse.json({
    purged: drop.length,
    archived: archive.length,
    retentionDays: RETENTION_DAYS,
  });
}

type Client = ReturnType<typeof createAdminClient>;

async function removePaths(supabase: Client, paths: string[]): Promise<void> {
  for (let i = 0; i < paths.length; i += 500) {
    await supabase.storage.from(BUCKET).remove(paths.slice(i, i + 500));
  }
}
