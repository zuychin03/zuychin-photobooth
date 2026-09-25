import { STORY_DECKS } from "../stories/catalogue";
import { eventClientInstant, eventClientObject, eventClientUuid } from "./client";
export const EVENT_GUESTBOOK_LIMITS = Object.freeze({ version: 1, messageCharacters: 500, signatureCharacters: 80, textBytes: 4096, receipts: 32, missions: 6, pageItems: 25 });
export interface EventMission { id: string; version: 1; label: string }
export const EVENT_MISSIONS: readonly EventMission[] = Object.freeze([...[0, 1, 2, 3].map(step => ({ deck: "same-energy", step })), ...[0, 1].map(step => ({ deck: "album-cover", step }))].map(({ deck, step }) => Object.freeze({ id: `${deck}-${step + 1}`, version: 1 as const, label: STORY_DECKS.find(item => item.id === deck)!.steps[step] })));
export interface EventMissionSettings { version: 1; eventId: string; revision: number; missionIds: string[]; endsAt: string; locked: boolean }
export interface EventGuestbookNote { version: 1; eventId: string; submissionId: string; revision: number; message: string; signature: string; withdrawn: boolean; mission: EventMission | null; missionCompleted: boolean }
export interface EventExportGuestbook { submissionId: string; revision: number | null; status: "available" | "not_collected" | "unavailable"; note: EventGuestbookNote | null }
export function parseEventExportGuestbook(value: unknown, eventId: string): EventExportGuestbook {
  const b = eventClientObject(value, ["submissionId", "revision", "status", "note"]), submissionId = eventClientUuid(b.submissionId);
  if (b.revision !== null && (!Number.isInteger(b.revision) || Number(b.revision) < 0 || Number(b.revision) > 1000000) || !["available", "not_collected", "unavailable"].includes(String(b.status)) || (b.status === "not_collected") !== (b.revision === null) || (b.status === "available") !== (b.note !== null)) throw new Error("invalid_export_guestbook");
  const note = b.note === null ? null : parseEventGuestbookNote(b.note, eventId, submissionId);
  if (note && (note.withdrawn || note.revision !== b.revision)) throw new Error("invalid_export_guestbook");
  return { submissionId, revision: b.revision as number | null, status: b.status as EventExportGuestbook["status"], note };
}
export function validateGuestbookText(message: unknown, signature: unknown) {
  if (typeof message !== "string" || typeof signature !== "string" || [...message].length > 500 || [...signature].length > 80 || /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\ud800-\udfff]/u.test(message) || /[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(signature) || new TextEncoder().encode(message + signature).length > 4096) throw new Error("invalid_guestbook_text");
  return { message, signature };
}
export function parseEventMission(value: unknown): EventMission | null {
  if (value === null) return null;
  const b = eventClientObject(value, ["id", "version", "label"]), known = EVENT_MISSIONS.find(m => m.id === b.id);
  if (!known || b.version !== known.version || b.label !== known.label) throw new Error("invalid_mission"); return { ...known };
}
export function parseEventMissions(value: unknown, eventId: string): EventMissionSettings {
  const b = eventClientObject(value, ["version", "eventId", "revision", "missionIds", "endsAt", "locked"]);
  if (b.version !== 1 || b.eventId !== eventId || !Number.isInteger(b.revision) || Number(b.revision) < 0 || Number(b.revision) > 1000000 || typeof b.locked !== "boolean" || !Array.isArray(b.missionIds) || b.missionIds.length > 6 || new Set(b.missionIds).size !== b.missionIds.length || b.missionIds.some(id => !EVENT_MISSIONS.some(m => m.id === id))) throw new Error("invalid_missions");
  return { version: 1, eventId: eventClientUuid(eventId), revision: Number(b.revision), missionIds: b.missionIds as string[], endsAt: eventClientInstant(b.endsAt), locked: b.locked };
}
export function parseEventGuestbookNote(value: unknown, eventId: string, submissionId?: string): EventGuestbookNote {
  const b = eventClientObject(value, ["version", "eventId", "submissionId", "revision", "message", "signature", "withdrawn", "mission", "missionCompleted"]);
  if (b.version !== 1 || b.eventId !== eventId || submissionId && b.submissionId !== submissionId || !Number.isInteger(b.revision) || Number(b.revision) < 0 || Number(b.revision) > 1000000 || typeof b.withdrawn !== "boolean" || typeof b.missionCompleted !== "boolean" || b.withdrawn && (b.message !== "" || b.signature !== "")) throw new Error("invalid_guestbook");
  const text = validateGuestbookText(b.message, b.signature), mission = parseEventMission(b.mission);
  if (!mission && b.missionCompleted) throw new Error("invalid_guestbook");
  return { version: 1, eventId: eventClientUuid(eventId), submissionId: eventClientUuid(b.submissionId), revision: Number(b.revision), ...text, withdrawn: b.withdrawn, mission, missionCompleted: b.missionCompleted };
}
