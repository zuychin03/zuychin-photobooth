import { kioskUuid } from "./kiosk-contract";

export const KIOSK_LOCK_COOKIE = "pb-kiosk-lock";
export const KIOSK_LOCK_STORAGE = "pb-kiosk-lock-v1";
export function kioskLock(value: string | null): { eventId: string; deviceId: string; path: string } | null {
  if (value === null) return null;
  const parts = value.split(".");
  if (parts.length !== 2 || !parts.every(kioskUuid)) return { eventId: "", deviceId: "", path: "/kiosk-locked" };
  return { eventId: parts[0], deviceId: parts[1], path: `/e/${parts[0]}/kiosk` };
}
export function kioskCookieValue(cookie: string): string | null {
  const matches = cookie.split(";").map(v => v.trim()).filter(v => v.startsWith(`${KIOSK_LOCK_COOKIE}=`));
  return matches.length === 0 ? null : matches.length === 1 ? matches[0].slice(KIOSK_LOCK_COOKIE.length + 1) : "invalid";
}
export function kioskAllowsPath(path: string, lock: NonNullable<ReturnType<typeof kioskLock>>): boolean {
  return path === lock.path || !!lock.eventId && path === `/api/events/${lock.eventId}/kiosk` || path.startsWith("/_next/") || /^(?:\/favicon[^/]*|\/sw\.js|\/manifest\.webmanifest|\/(?:icons|scenes|materials|stickers|models|mediapipe|fonts)\/[^?]*)$/.test(path);
}
