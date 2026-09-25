import { EVENT_MISSIONS, type EventMissionSettings } from "./guestbook-contract";
export function prepareEventMissionEdit(current: EventMissionSettings, missionIds: readonly string[], endsAt: string, window: { startsAt: string; closesAt: string }) {
  const stamp = Date.parse(endsAt);
  if (current.locked || !Number.isFinite(stamp) || stamp <= Date.parse(window.startsAt) || stamp > Date.parse(window.closesAt) || missionIds.length > 6 || new Set(missionIds).size !== missionIds.length || missionIds.some(id => !EVENT_MISSIONS.some(m => m.id === id))) throw new Error("invalid_mission_settings");
  return Object.freeze({ expectedRevision: current.revision, missionIds: [...missionIds], endsAt: new Date(stamp).toISOString() });
}
