"use client";

import { useEffect, useState } from "react";
import { Bell, BellOff, BellRing } from "lucide-react";
import { PushState, disablePush, enablePush, getPushState } from "@/lib/push-client";

// Header bell: enable/disable push notifications for this browser. Hidden
// when the deployment has no VAPID key or the browser can't do push.
export function PushToggle({ userId }: { userId: string }) {
  const [state, setState] = useState<PushState>("unsupported");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getPushState().then(setState).catch(() => {});
  }, []);

  if (state === "unsupported") return null;

  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    try {
      setState(state === "subscribed" ? await disablePush() : await enablePush(userId));
    } catch {
      // permission dialogs and push services can fail arbitrarily; re-read
      setState(await getPushState().catch(() => "unsupported" as PushState));
    } finally {
      setBusy(false);
    }
  };

  const label =
    state === "subscribed"
      ? "Turn off notifications"
      : state === "denied"
        ? "Notifications blocked in browser settings"
        : "Turn on notifications";

  return (
    <button
      onClick={toggle}
      disabled={busy || state === "denied"}
      aria-label={label}
      title={label}
      className={`flex h-11 w-11 items-center justify-center rounded-full bg-muted transition ${
        state === "denied" ? "opacity-40" : ""
      } ${state === "subscribed" ? "text-accent" : ""}`}
    >
      {state === "subscribed" ? (
        <BellRing size={18} />
      ) : state === "denied" ? (
        <BellOff size={18} />
      ) : (
        <Bell size={18} />
      )}
    </button>
  );
}
