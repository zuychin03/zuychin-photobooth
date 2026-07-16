import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { hasPush, sendPushToUsers, type PushPayload } from "@/lib/push";

// Notify the partner about an event the signed-in user just caused. The
// session client's RLS proves the caller can see the object, and the caller
// must be its author, so a user can only ever trigger the preset messages
// about their own actions — never arbitrary content.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const { type, id } = await request.json().catch(() => ({}));
  if ((type !== "relay" && type !== "strip") || typeof id !== "string") {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  if (!hasPush()) return NextResponse.json({ skipped: "push not configured" });

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let coupleId: string | null = null;
  let payload: PushPayload | null = null;

  if (type === "relay") {
    const { data: relay } = await supabase
      .from("pb_relays")
      .select("id, couple_id, initiator, status")
      .eq("id", id)
      .maybeSingle();
    if (!relay || relay.initiator !== user.id) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    coupleId = relay.couple_id;
    payload = {
      title: "Your turn in the booth",
      body: "Your partner shot their half of a relay strip. Finish yours!",
      url: `/relay/${relay.id}`,
    };
  } else {
    const { data: strip } = await supabase
      .from("pb_strips")
      .select("id, owner, couple_id")
      .eq("id", id)
      .maybeSingle();
    if (!strip || strip.owner !== user.id || !strip.couple_id) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    coupleId = strip.couple_id;
    payload = {
      title: "New strip in your vault",
      body: "Your partner saved a strip to the Shared Vault.",
      url: "/timeline",
    };
  }

  const { data: couple } = await supabase
    .from("pb_couples")
    .select("member_a, member_b")
    .eq("id", coupleId)
    .maybeSingle();
  const partner = [couple?.member_a, couple?.member_b].find(
    (m) => m && m !== user.id,
  );
  if (!partner) return NextResponse.json({ sent: 0 });

  const sent = await sendPushToUsers([partner], payload);
  return NextResponse.json({ sent });
}
