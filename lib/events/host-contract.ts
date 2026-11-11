import type { EventCreateInput, EventStatus } from "./contract";
import { storedStrip, validateStripOptions, type StripOptions } from "../strip-style";

export const EVENT_HOST_LIMITS = Object.freeze({ version: 1, listLimit: 25, settingsReceipts: 64, captionCharacters: 160 });
export interface EventHostSummary {
  eventId: string; title: string; timezone: string; startsAt: string; closesAt: string; expiresAt: string;
  status: EventStatus; role: "owner" | "moderator"; membership: "active" | "invited";
}
export interface EventHostList { version: 1; events: EventHostSummary[]; nextCursor: string | null }
export const EVENT_FRAME_IDS = ["film", "noir", "rose", "butter", "sage", "sky", "lavender"] as const;
/** Look version 2 adds the V3 frames and a strip style. */
export const EVENT_FRAME_IDS_V2 = [...EVENT_FRAME_IDS, "cherry", "midnight", "kraft", "peach", "lilac", "seaglass"] as const;
export const EVENT_FILTER_IDS = ["none", "bw", "sepia", "film", "cool", "glow"] as const;
export const EVENT_SCENE_IDS = ["celebration-garden-v2", "birthday-confetti-v2", "midnight-disco-v2", "graduation-atelier-v2", "winter-celebration-v2", "summer-festival-v2"] as const;
export interface EventLook {
  version: 1 | 2; frameId: typeof EVENT_FRAME_IDS_V2[number]; filterId: typeof EVENT_FILTER_IDS[number];
  sceneId: typeof EVENT_SCENE_IDS[number] | null; caption: string; showDate: boolean; strip?: StripOptions;
}
/** The lowest look version that can hold this look, so older hosts keep reading plain looks. */
export function eventLookVersion(look: Pick<EventLook, "frameId" | "strip">): 1 | 2 {
  return (EVENT_FRAME_IDS as readonly string[]).includes(look.frameId) && !storedStrip(look.strip) ? 1 : 2;
}
export const DEFAULT_EVENT_LOOK: Readonly<EventLook> = Object.freeze({ version: 1, frameId: "film", filterId: "none", sceneId: null, caption: "", showDate: false });
export interface EventSettingsInput { event: EventCreateInput; look: EventLook }
export interface EventSettings extends EventSettingsInput { version: 1; eventId: string; revision: number; locked: boolean }
export interface EventGuestContext { version: 1; eventId: string; title: string; timezone: string; startsAt: string; closesAt: string; expiresAt: string; status: EventStatus; look: EventLook; capacityAvailable: boolean; canReserve: boolean; serviceAvailable?: boolean }

export function validateEventLook(value: unknown): EventLook {
  const invalid = (): never => { throw new Error("Invalid event look"); };
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalid();
  const b = value as Record<string, unknown>, keys = ["version", "frameId", "filterId", "sceneId", "caption", "showDate", ...(b.version === 2 && Object.hasOwn(b, "strip") ? ["strip"] : [])];
  if (Reflect.ownKeys(b).length !== keys.length || keys.some(key => !Object.hasOwn(b, key) || !("value" in Object.getOwnPropertyDescriptor(b, key)!))) return invalid();
  let strip: StripOptions | undefined;
  if (Object.hasOwn(b, "strip")) try { strip = validateStripOptions(b.strip); } catch { return invalid(); }
  if ((b.version !== 1 && b.version !== 2) || !(b.version === 2 ? EVENT_FRAME_IDS_V2 : EVENT_FRAME_IDS).includes(b.frameId as typeof EVENT_FRAME_IDS[number]) || !EVENT_FILTER_IDS.includes(b.filterId as EventLook["filterId"]) || b.sceneId !== null && !EVENT_SCENE_IDS.includes(b.sceneId as Exclude<EventLook["sceneId"], null>) || typeof b.caption !== "string" || b.caption.length > 320 || [...b.caption].length > EVENT_HOST_LIMITS.captionCharacters || /[\u0000-\u001f\u007f-\u009f]/.test(b.caption) || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(b.caption) || typeof b.showDate !== "boolean") return invalid();
  return { version: b.version, frameId: b.frameId as EventLook["frameId"], filterId: b.filterId as EventLook["filterId"], sceneId: b.sceneId as EventLook["sceneId"], caption: b.caption, showDate: b.showDate, ...(strip ? { strip } : {}) };
}
