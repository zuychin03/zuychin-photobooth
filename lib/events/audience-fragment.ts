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
    access_denied: "This viewing link is no longer available. Ask the host for a current link.",
    identity_changed: "The viewing session changed in this browser. Reopen the event to continue.",
    expired: "This viewing link or event has expired. Its photos are no longer shown.",
    rate_limited: "Viewing is temporarily paused. Wait a minute, then check again.",
    unavailable: "Event viewing is unavailable here. Ask the host to check the event connection.",
    stale: "Photos were hidden because their permission check is out of date. Check again to continue.",
    offline: "You are offline. Photos are hidden until this page can check their permissions again.",
    hidden: "Viewing is paused while this page is hidden.",
    paused: "Viewing is paused and photos are hidden. Check again to resume with fresh permission checks.",
    capacity: "The report limit has been reached. Please contact the host directly.",
    conflict: "That report differs from the earlier request. Keep the original report or start a new one.",
  } as Record<string, string>)[code] ?? "Photos are hidden because the latest check did not finish. Check again when the connection is ready.";
}
