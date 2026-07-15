import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { destroyStrip, hasCloudinary, uploadStrip } from "@/lib/cloudinary";

// Toggle a strip's "kept" state. Keeping pushes the PNG to Cloudinary so it
// keeps a permanent home past the weekly purge; releasing removes it.
// Runs on photobooth's own domain, so the user's session cookie authenticates it.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BUCKET = "photobooth-strips";

export async function POST(request: Request) {
  const { id, kept } = await request.json().catch(() => ({}));
  if (typeof id !== "string" || typeof kept !== "boolean") {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // RLS restricts this to the owner; only they may change keep state.
  const { data: strip } = await supabase
    .from("pb_strips")
    .select("id, owner, storage_path, cloudinary_public_id")
    .eq("id", id)
    .maybeSingle();
  if (!strip || strip.owner !== user.id) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  if (!kept) {
    if (strip.cloudinary_public_id && hasCloudinary()) {
      await destroyStrip(strip.cloudinary_public_id);
    }
    await supabase
      .from("pb_strips")
      .update({ kept: false, cloudinary_public_id: null, cloudinary_url: null })
      .eq("id", id);
    return NextResponse.json({ kept: false });
  }

  // Keeping: mark it now so the Supabase copy is exempt from the purge even if
  // Cloudinary is not configured on this deployment.
  if (!hasCloudinary()) {
    await supabase.from("pb_strips").update({ kept: true }).eq("id", id);
    return NextResponse.json({ kept: true, pushed: false });
  }

  const dl = await supabase.storage.from(BUCKET).download(strip.storage_path);
  if (dl.error || !dl.data) {
    return NextResponse.json({ error: "strip file missing" }, { status: 409 });
  }
  const bytes = Buffer.from(await dl.data.arrayBuffer());
  const { publicId, url } = await uploadStrip(bytes, user.id, id);

  const { error: upErr } = await supabase
    .from("pb_strips")
    .update({ kept: true, cloudinary_public_id: publicId, cloudinary_url: url })
    .eq("id", id);
  // If the columns are missing (schema not fully applied) the archive is
  // orphaned in Cloudinary and companion views never see it, so fail loudly.
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });
  return NextResponse.json({ kept: true, pushed: true });
}
