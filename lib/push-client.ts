import { createClient } from "./supabase/client";

// Browser side of web push: permission, PushManager subscription, and the
// pb_push_subscriptions row (written directly under RLS, like strips/relays).

export type PushState = "unsupported" | "denied" | "subscribed" | "unsubscribed";

export function pushConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY &&
      process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
}

function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

function applicationServerKey(): Uint8Array<ArrayBuffer> {
  const base64 = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!;
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = window.atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  const key = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) key[i] = raw.charCodeAt(i);
  return key;
}

export async function getPushState(): Promise<PushState> {
  if (!pushSupported() || !pushConfigured()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  const registration = await navigator.serviceWorker.getRegistration();
  const sub = await registration?.pushManager.getSubscription();
  return sub ? "subscribed" : "unsubscribed";
}

/** Ask permission, subscribe this browser, and record the subscription. */
export async function enablePush(userId: string): Promise<PushState> {
  if (!pushSupported() || !pushConfigured()) return "unsupported";
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return "denied";

  const registration = await navigator.serviceWorker.ready;
  const sub = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: applicationServerKey(),
  });
  const json = sub.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    throw new Error("subscription missing keys");
  }

  const supabase = createClient();
  const { error } = await supabase.from("pb_push_subscriptions").upsert(
    {
      owner: userId,
      endpoint: json.endpoint,
      p256dh: json.keys.p256dh,
      auth: json.keys.auth,
    },
    { onConflict: "endpoint" },
  );
  if (error) throw error;
  return "subscribed";
}

/** Fire-and-forget partner notification about something you just did.
 *  The server validates the object and resolves the recipient. */
export function notifyPartner(type: "relay" | "strip", id: string): void {
  fetch("/api/push/notify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, id }),
  }).catch(() => {});
}

/** Unsubscribe this browser and drop its row. */
export async function disablePush(): Promise<PushState> {
  const registration = await navigator.serviceWorker.getRegistration();
  const sub = await registration?.pushManager.getSubscription();
  if (!sub) return "unsubscribed";
  const endpoint = sub.endpoint;
  await sub.unsubscribe();
  const supabase = createClient();
  await supabase.from("pb_push_subscriptions").delete().eq("endpoint", endpoint);
  return "unsubscribed";
}
