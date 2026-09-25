import type { EventCreateInput, EventStatus } from "./contract";

export const EVENT_HOST_LIMITS = Object.freeze({ version: 1, listLimit: 25, settingsReceipts: 64, captionCharacters: 160 });
export interface EventHostSummary {
  eventId: string; title: string; timezone: string; startsAt: string; closesAt: string; expiresAt: string;
  status: EventStatus; role: "owner" | "moderator"; membership: "active" | "invited";
}
export interface EventHostList { version: 1; events: EventHostSummary[]; nextCursor: string | null }
export const EVENT_FRAME_IDS = ["film", "noir", "rose", "butter", "sage", "sky", "lavender"] as const;
export const EVENT_FILTER_IDS = ["none", "bw", "sepia", "film", "cool", "glow"] as const;
export const EVENT_SCENE_IDS = ["celebration-garden-v2", "birthday-confetti-v2", "midnight-disco-v2", "graduation-atelier-v2", "winter-celebration-v2", "summer-festival-v2"] as const;
export interface EventLook {
  version: 1; frameId: typeof EVENT_FRAME_IDS[number]; filterId: typeof EVENT_FILTER_IDS[number];
  sceneId: typeof EVENT_SCENE_IDS[number] | null; caption: string; showDate: boolean;
}
export const DEFAULT_EVENT_LOOK: Readonly<EventLook> = Object.freeze({ version: 1, frameId: "film", filterId: "none", sceneId: null, caption: "", showDate: false });
export interface EventSettingsInput { event: EventCreateInput; look: EventLook }
export interface EventSettings extends EventSettingsInput { version: 1; eventId: string; revision: number; locked: boolean }
export interface EventGuestContext { version: 1; eventId: string; title: string; timezone: string; startsAt: string; closesAt: string; expiresAt: string; status: EventStatus; look: EventLook; capacityAvailable: boolean; canReserve: boolean; serviceAvailable?: boolean }

export function validateEventLook(value: unknown): EventLook {
  const invalid = (): never => { throw new Error("Invalid event look"); };
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalid();
  const b = value as Record<string, unknown>, keys = ["version", "frameId", "filterId", "sceneId", "caption", "showDate"];
  if (Reflect.ownKeys(b).length !== keys.length || keys.some(key => !Object.hasOwn(b, key) || !("value" in Object.getOwnPropertyDescriptor(b, key)!))) return invalid();
  if (b.version !== 1 || !EVENT_FRAME_IDS.includes(b.frameId as EventLook["frameId"]) || !EVENT_FILTER_IDS.includes(b.filterId as EventLook["filterId"]) || b.sceneId !== null && !EVENT_SCENE_IDS.includes(b.sceneId as Exclude<EventLook["sceneId"], null>) || typeof b.caption !== "string" || b.caption.length > 320 || [...b.caption].length > EVENT_HOST_LIMITS.captionCharacters || /[\u0000-\u001f\u007f-\u009f]/.test(b.caption) || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(b.caption) || typeof b.showDate !== "boolean") return invalid();
  return { version: 1, frameId: b.frameId as EventLook["frameId"], filterId: b.filterId as EventLook["filterId"], sceneId: b.sceneId as EventLook["sceneId"], caption: b.caption, showDate: b.showDate };
}
