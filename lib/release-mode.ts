import { isValidRoomCode } from "./room-code";

export type ReleaseEnvironment = Record<string, string | undefined>;

export function isLocalRelease(env: ReleaseEnvironment = process.env): boolean {
  if (env.PB_RELEASE_MODE === "full") return false;
  return env.PB_RELEASE_MODE === "local" || env.NODE_ENV === "production";
}

const onlinePages: ReadonlyArray<readonly [string, string]> = [
  ["/relay", "Photo relays"],
  ["/events", "Events"], ["/e", "Events"], ["/challenges", "Photo challenges"],
  ["/projects/cloud", "Cloud projects"], ["/memories", "Memories"],
  ["/timeline", "Shared Vault"], ["/login", "Accounts"], ["/auth", "Accounts"],
];

export function incomingFeature(pathname: string, search?: Pick<URLSearchParams, "getAll">): string | null {
  if (pathname === "/room" || pathname.startsWith("/room/")) {
    const code = /^\/room\/([^/]+)\/?$/.exec(pathname)?.[1];
    if (!code || !isValidRoomCode(code.toUpperCase()) || search?.getAll("v").includes("2")) return "Live rooms";
    return null;
  }
  return onlinePages.find(([path]) => pathname === path || pathname.startsWith(`${path}/`))?.[1] ?? null;
}

const maintenancePaths = new Set([
  "/api/media/maintenance", "/api/retention", "/api/projects/maintenance", "/api/events/maintenance",
]);

export function localReleaseApiAllowed(pathname: string, method: string): boolean {
  const path = pathname.replace(/\/$/, "");
  if (maintenancePaths.has(path)) return method === "GET";
  // Existing personal receipts retain their own capability checks and withdrawal flow.
  if (/^\/api\/events\/[^/]+\/receipts\/[^/]+$/.test(path)) return method === "GET" || method === "POST";
  return false;
}

export function localReleaseKioskAllowed(operation: string): boolean {
  return ["session", "context", "status", "finalise", "reset", "unlock", "operator", "exit"].includes(operation);
}
