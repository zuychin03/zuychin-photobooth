import { createClient } from "./supabase/client";
import { validPushEndpoint } from "./push-endpoint";

export type PushState = "unsupported" | "denied" | "subscribed" | "unsubscribed" | "unregistered" | "unsupported_subscription";

const errors = {
  unsupported_endpoint: "Notifications from this browser aren't supported here. Use another browser, or turn off this subscription.",
  account_changed: "Your account changed. Reload before changing notifications.",
  check_failed: "Couldn't check notification settings. Try again.",
  save_failed: "Couldn't save notifications for this account. Try again, or turn off this browser subscription.",
  disable_failed: "Couldn't finish turning off notifications. Try again.",
} as const;
class PushClientError extends Error {
  constructor(readonly code: keyof typeof errors) { super(errors[code]); }
}
export function pushErrorMessage(error: unknown): string {
  return error instanceof PushClientError ? error.message : "Couldn't update notifications. Try again.";
}
async function assertOwner(client: ReturnType<typeof createClient>, userId: string) {
  const { data, error } = await client.auth.getUser();
  if (error || !userId || data.user?.id !== userId) throw new PushClientError("account_changed");
}

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

export async function getPushState(userId: string): Promise<PushState> {
  if (!pushSupported() || !pushConfigured()) return "unsupported";
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    const sub = await registration?.pushManager.getSubscription();
    if (!sub) return Notification.permission === "denied" ? "denied" : "unsubscribed";
    const client = createClient(); await assertOwner(client, userId);
    if (!validPushEndpoint(sub.endpoint)) return "unsupported_subscription";
    const { data, error } = await client.from("pb_push_subscriptions").select("owner, endpoint, p256dh, auth").eq("owner", userId).eq("endpoint", sub.endpoint).maybeSingle();
    if (error) throw new PushClientError("check_failed");
    await assertOwner(client, userId);
    const keys = sub.toJSON().keys;
    return data?.owner === userId && data.endpoint === sub.endpoint && keys?.p256dh && keys.auth && data.p256dh === keys.p256dh && data.auth === keys.auth ? "subscribed" : "unregistered";
  } catch (error) { throw error instanceof PushClientError ? error : new PushClientError("check_failed"); }
}

export async function enablePush(userId: string): Promise<PushState> {
  if (!pushSupported() || !pushConfigured()) return "unsupported";
  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return permission === "denied" ? "denied" : "unsubscribed";
    const supabase = createClient(); await assertOwner(supabase, userId);
    const registration = await navigator.serviceWorker.ready;
    const sub = await registration.pushManager.getSubscription() ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: applicationServerKey() });
    if (!validPushEndpoint(sub.endpoint)) throw new PushClientError("unsupported_endpoint");
    const json = sub.toJSON();
    if (json.endpoint !== sub.endpoint || !json.keys?.p256dh || !json.keys.auth) throw new PushClientError("save_failed");
    await assertOwner(supabase, userId);
    const { error } = await supabase.from("pb_push_subscriptions").upsert(
      { owner: userId, endpoint: json.endpoint, p256dh: json.keys.p256dh, auth: json.keys.auth },
      { onConflict: "endpoint" },
    );
    if (error) throw new PushClientError("save_failed");
    const state = await getPushState(userId);
    if (state !== "subscribed") throw new PushClientError("save_failed");
    return state;
  } catch (error) { throw error instanceof PushClientError ? error : new PushClientError("save_failed"); }
}

// The server resolves recipients from the authorised object.
export function notifyPartner(type: "relay" | "strip", id: string): void {
  fetch("/api/push/notify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, id }),
  }).catch(() => {});
}

export async function disablePush(userId: string): Promise<PushState> {
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    const sub = await registration?.pushManager.getSubscription();
    if (!sub) return "unsubscribed";
    const supabase = createClient(); await assertOwner(supabase, userId);
    // Keep the endpoint available for retry until its account row is removed.
    const { error } = await supabase.from("pb_push_subscriptions").delete().eq("owner", userId).eq("endpoint", sub.endpoint);
    if (error) throw new PushClientError("disable_failed");
    await assertOwner(supabase, userId);
    await sub.unsubscribe();
    if (await registration!.pushManager.getSubscription()) throw new PushClientError("disable_failed");
    return "unsubscribed";
  } catch (error) { throw error instanceof PushClientError ? error : new PushClientError("disable_failed"); }
}
