import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { weeklyResetCutoffIso } from "@/lib/retention";
import { hasCloudinary, uploadStrip } from "@/lib/cloudinary";

// Called on a schedule (same CRON_SECRET as the reminder route). Clears the
// shared vault at the ISO-week boundary: strips from an earlier week are
// removed, but kept strips and weekly recaps are first archived to
// Cloudinary so they survive. Run it at least once after each week
// rollover (e.g. daily) for the vault to empty on the new week.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BUCKET = "photobooth-strips";

interface Row {
  id: string;
  owner: string;
  storage_path: string;
  layout_id: string | null;
  kept: boolean;
  cloudinary_public_id: string | null;
}

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
  const cutoff = weeklyResetCutoffIso();

  // Everything from an earlier ISO week that still has a Storage object.
  const { data, error } = await supabase
    .from("pb_strips")
    .select("id, owner, storage_path, layout_id, kept, cloudinary_public_id")
    .eq("purged", false)
    .lt("created_at", cutoff);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = (data ?? []) as Row[];
  // Kept strips and recaps are the week's keepsakes: archive, don't delete.
  const keep = rows.filter((r) => r.kept || r.layout_id === "recap");
  const drop = rows.filter((r) => !(r.kept || r.layout_id === "recap"));

  // 1. Non-kept, non-recap: drop the Storage object and the row.
  await removePaths(supabase, drop.map((r) => r.storage_path));
  if (drop.length > 0) {
    await supabase.from("pb_strips").delete().in("id", drop.map((r) => r.id));
  }

  // 2. Keepsakes: ensure a Cloudinary copy exists (companion views read those),
  // then drop only the Storage object and mark the row purged. A keepsake we
  // cannot archive (Cloudinary not configured) is left intact rather than lost.
  let archived = 0;
  let skipped = 0;
  const purge: string[] = [];
  const purgeIds: string[] = [];

  for (const r of keep) {
    let publicId = r.cloudinary_public_id;
    if (!publicId) {
      if (!hasCloudinary()) {
        skipped++;
        continue;
      }
      const dl = await supabase.storage.from(BUCKET).download(r.storage_path);
      if (dl.error || !dl.data) {
        skipped++;
        continue;
      }
      const bytes = Buffer.from(await dl.data.arrayBuffer());
      const up = await uploadStrip(bytes, r.owner, r.id);
      publicId = up.publicId;
      await supabase
        .from("pb_strips")
        .update({ kept: true, cloudinary_public_id: up.publicId, cloudinary_url: up.url })
        .eq("id", r.id);
    }
    purge.push(r.storage_path);
    purgeIds.push(r.id);
    archived++;
  }

  await removePaths(supabase, purge);
  if (purgeIds.length > 0) {
    await supabase.from("pb_strips").update({ purged: true }).in("id", purgeIds);
  }

  return NextResponse.json({
    cleared: drop.length,
    archived,
    skipped,
    weekStart: cutoff,
  });
}

type Client = ReturnType<typeof createAdminClient>;

async function removePaths(supabase: Client, paths: string[]): Promise<void> {
  for (let i = 0; i < paths.length; i += 500) {
    await supabase.storage.from(BUCKET).remove(paths.slice(i, i + 500));
  }
}
