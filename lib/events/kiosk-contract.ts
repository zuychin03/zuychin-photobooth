import type { EventConsent, EventReceipt } from "./contract";

export const EVENT_KIOSK_LIMITS = Object.freeze({ version: 1, activeDevices: 2, retainedDevices: 8, queueItems: 8, queueBytes: 16_000_000, imageBytes: 2_000_000, idleSeconds: 120, unlockSeconds: 60, pinAttempts: 5, pinWindowSeconds: 900, localSeconds: 86400 });
export interface EventKioskSession { version: 1; eventId: string; deviceId: string; generation: number; guestId: string | null; expiresAt: string; enabled: boolean }
export interface EventKioskApproval { sha256: string; bytes: number; width: number; height: number; mime: "image/jpeg"; consent: EventConsent; missionId: string | null }
export interface EventKioskReservation extends EventReceipt { deviceId: string; guestId: string; generation: number; stagingPath: string; stagingHeldBytes: number; derivativeHeldBytes: number }
export interface EventKioskUnlock { allowed: boolean; retryAfterSeconds: number; unlockedUntil: string | null }
export const kioskUuid = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
export function kioskObject(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_kiosk_data"); return value as Record<string, unknown>; }
export function kioskInstant(value: unknown): value is string { return typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value)); }
export function parseKioskApproval(value: unknown): EventKioskApproval {
  const b = kioskObject(value), c = kioskObject(b.consent);
  if (Object.keys(b).sort().join() !== ["sha256", "bytes", "width", "height", "mime", "consent", "missionId"].sort().join() || typeof b.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(b.sha256) || !Number.isSafeInteger(b.bytes) || Number(b.bytes) < 1 || Number(b.bytes) > EVENT_KIOSK_LIMITS.imageBytes || !Number.isSafeInteger(b.width) || !Number.isSafeInteger(b.height) || Number(b.width) < 1 || Number(b.height) < 1 || Number(b.width) > 4096 || Number(b.height) > 4096 || Number(b.width) * Number(b.height) > 12_000_000 || b.mime !== "image/jpeg" || Object.keys(c).sort().join() !== "gallery,submission,wall" || c.submission !== true || typeof c.gallery !== "boolean" || typeof c.wall !== "boolean" || b.missionId !== null && (typeof b.missionId !== "string" || !/^[a-z0-9-]{1,64}$/.test(b.missionId))) throw new Error("invalid_kiosk_data");
  return { sha256: b.sha256, bytes: Number(b.bytes), width: Number(b.width), height: Number(b.height), mime: "image/jpeg", consent: { submission: true, gallery: c.gallery, wall: c.wall }, missionId: b.missionId as string | null };
}
export function parseKioskSession(value: unknown, eventId: string): EventKioskSession {
  const b = kioskObject(value);
  if (b.version !== 1 || b.eventId !== eventId || !kioskUuid(eventId) || !kioskUuid(b.deviceId) || !Number.isSafeInteger(b.generation) || Number(b.generation) < 0 || Number(b.generation) > 10000 || b.guestId !== null && !kioskUuid(b.guestId) || !kioskInstant(b.expiresAt) || typeof b.enabled !== "boolean") throw new Error("invalid_kiosk_data");
  return { version: 1, eventId, deviceId: b.deviceId, generation: Number(b.generation), guestId: b.guestId as string | null, expiresAt: b.expiresAt, enabled: b.enabled };
}
export function parseKioskUnlock(value: unknown): EventKioskUnlock {
  const b = kioskObject(value);
  if (typeof b.allowed !== "boolean" || !Number.isSafeInteger(b.retryAfterSeconds) || Number(b.retryAfterSeconds) < 0 || Number(b.retryAfterSeconds) > 900 || b.unlockedUntil !== null && !kioskInstant(b.unlockedUntil) || b.allowed !== (b.unlockedUntil !== null) || b.allowed && b.retryAfterSeconds !== 0) throw new Error("invalid_kiosk_data");
  return { allowed: b.allowed, retryAfterSeconds: Number(b.retryAfterSeconds), unlockedUntil: b.unlockedUntil as string | null };
}
