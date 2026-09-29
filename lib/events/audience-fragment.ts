export function takeEventAudienceFragment(location: Pick<Location, "hash" | "search" | "pathname">, replace: (path: string) => void): string | null {
  const { hash, search, pathname } = location;
  replace(pathname);
  if (search || hash.length > 80) return null;
  const parts = new URLSearchParams(hash.slice(1)), token = parts.get("token");
  return [...parts.keys()].length === 1 && parts.has("token") && token && /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(token) ? token : null;
}

export function eventAudienceError(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  return ({
    access_denied: "This link doesn't work any more. Ask the host for a new one.",
    identity_changed: "Something changed in this browser. Open the event link again.",
    expired: "This link or event has expired.",
    rate_limited: "Too many requests. Wait a minute, then refresh.",
    unavailable: "Event photos aren't available here. Ask the host for help.",
    stale: "Photos are hidden until the page refreshes. Tap Refresh.",
    offline: "You're offline. Photos will show again when you reconnect.",
    hidden: "Paused while this page is hidden.",
    paused: "Paused. Tap Refresh to show the photos again.",
    capacity: "You can't send more reports. Contact the host directly.",
    conflict: "This report changed. Cancel it and start again.",
  } as Record<string, string>)[code] ?? "Couldn't load the photos. Check your connection, then refresh.";
}
