import webpush from "web-push";
import { createAdminClient } from "./supabase/admin";

// Server-side web push. Sends run as the service role so they work from cron
// routes and on behalf of whichever partner triggered the event.

export interface PushPayload {
  title: string;
  body: string;
  /** Same-origin path the notification opens, e.g. "/relay/<id>". */
  url?: string;
}

export function hasPush(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY &&
      process.env.VAPID_PRIVATE_KEY &&
      process.env.SUPABASE_SERVICE_ROLE_KEY,
  );
}

let configured = false;
function ensureConfigured(): void {
  if (configured) return;
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT ?? "mailto:admin@example.com",
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!,
    process.env.VAPID_PRIVATE_KEY!,
  );
  configured = true;
}

interface SubscriptionRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** Send a notification to every subscribed browser of the given users.
 *  Expired subscriptions (404/410 from the push service) are pruned.
 *  Returns the number of successful sends. */
export async function sendPushToUsers(
  userIds: string[],
  payload: PushPayload,
): Promise<number> {
  const targets = userIds.filter(Boolean);
  if (!hasPush() || targets.length === 0) return 0;
  ensureConfigured();

  const supabase = createAdminClient();
  const { data } = await supabase
    .from("pb_push_subscriptions")
    .select("id, endpoint, p256dh, auth")
    .in("owner", targets);

  let sent = 0;
  const stale: string[] = [];
  for (const sub of (data as SubscriptionRow[]) ?? []) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify(payload),
      );
      sent++;
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) stale.push(sub.id);
    }
  }
  if (stale.length > 0) {
    await supabase.from("pb_push_subscriptions").delete().in("id", stale);
  }
  return sent;
}
