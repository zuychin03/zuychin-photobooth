import { NextResponse, type NextRequest } from "next/server";
import { Resend } from "resend";
import { createAdminClient } from "@/lib/supabase/admin";
import { Cadence, nextOccurrence } from "@/lib/photo-dates";
import { hasPush, sendPushToUsers } from "@/lib/push";

// Called on a schedule (cron-job.org, Vercel Cron, etc.). Guarded by
// CRON_SECRET so only the scheduler can trigger sends.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface DueDate {
  id: string;
  couple_id: string;
  title: string;
  scheduled_at: string;
  cadence: Cadence;
}

function reminderHtml(title: string, origin: string): string {
  return `
    <div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:24px">
      <p style="font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:#e11d48;margin:0 0 8px">
        Zuychin Photobooth
      </p>
      <h1 style="font-size:22px;margin:0 0 12px">It's time for your photo date</h1>
      <p style="font-size:15px;color:#44403c;margin:0 0 20px">${title}</p>
      <a href="${origin}" style="display:inline-block;background:#e11d48;color:#fff;
        text-decoration:none;font-weight:600;padding:12px 20px;border-radius:12px">
        Open the booth
      </a>
    </div>`;
}

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get("authorization");
  const provided = auth?.replace("Bearer ", "") ?? request.nextUrl.searchParams.get("secret");
  if (secret && provided !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const emailEnabled = Boolean(process.env.RESEND_API_KEY);
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY || (!emailEnabled && !hasPush())) {
    return NextResponse.json({ skipped: "no reminder channel configured" });
  }

  const supabase = createAdminClient();
  const resend = emailEnabled ? new Resend(process.env.RESEND_API_KEY) : null;
  const from = process.env.REMINDER_FROM ?? "Zuychin Photobooth <onboarding@resend.dev>";
  const origin = request.nextUrl.origin;
  const nowIso = new Date().toISOString();

  const { data: due } = await supabase
    .from("pb_photo_dates")
    .select("id, couple_id, title, scheduled_at, cadence")
    .eq("active", true)
    .lte("scheduled_at", nowIso);

  let sent = 0;
  for (const d of (due as DueDate[]) ?? []) {
    const { data: couple } = await supabase
      .from("pb_couples")
      .select("member_a, member_b")
      .eq("id", d.couple_id)
      .maybeSingle();
    if (!couple) continue;

    const ids = [couple.member_a, couple.member_b].filter(Boolean);
    let delivered = false;

    if (resend) {
      const { data: profiles } = await supabase
        .from("profiles")
        .select("email")
        .in("id", ids);
      const to = (profiles ?? []).map((p) => p.email).filter(Boolean);
      if (to.length > 0) {
        try {
          await resend.emails.send({
            from,
            to,
            subject: `Photo date: ${d.title}`,
            html: reminderHtml(d.title, origin),
          });
          delivered = true;
        } catch {
          continue; // leave it due; next run retries (before any push, to avoid double-pushing)
        }
      }
    }

    const pushed = await sendPushToUsers(ids, {
      title: "It's time for your photo date",
      body: d.title,
      url: "/timeline",
    });
    if (pushed > 0) delivered = true;

    if (!delivered) continue; // reached nobody on any channel; retry next run
    sent++;

    const next = nextOccurrence(d.scheduled_at, d.cadence);
    await supabase
      .from("pb_photo_dates")
      .update(
        next
          ? { scheduled_at: next, last_sent_at: nowIso }
          : { active: false, last_sent_at: nowIso },
      )
      .eq("id", d.id);
  }

  return NextResponse.json({ processed: due?.length ?? 0, sent });
}
