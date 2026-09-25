export interface CapturePreferences { sound: boolean; flash: boolean; motion: "system" | "reduce" }
export const CAPTURE_PREFERENCES_KEY = "pb-capture-preferences-v1";
export const DEFAULT_CAPTURE_PREFERENCES: CapturePreferences = { sound: false, flash: false, motion: "system" };
export const CAPTURE_PREFERENCES_EVENT = "pb-capture-preferences-changed";
let sessionValue: string | null = null;
export function parseCapturePreferences(raw: string | null): CapturePreferences {
  try { const value = JSON.parse(raw ?? "null"); if (value?.version === 1 && typeof value.sound === "boolean" && typeof value.flash === "boolean" && ["system", "reduce"].includes(value.motion)) return { sound: value.sound, flash: value.flash, motion: value.motion }; } catch {}
  return { ...DEFAULT_CAPTURE_PREFERENCES };
}
export function resolveCapturePreferences(value: CapturePreferences, systemReduced: boolean) {
  const reducedMotion = value.motion === "reduce" || systemReduced;
  return { sound: value.sound, flash: value.flash && !reducedMotion, reducedMotion };
}
export function capturePreferencesSnapshot(): string {
  if (typeof window === "undefined") return "";
  let raw = sessionValue;
  if (raw === null) try { raw = localStorage.getItem(CAPTURE_PREFERENCES_KEY); } catch {}
  return JSON.stringify({ ...parseCapturePreferences(raw), systemReduced: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false });
}
export function currentCapturePreferences() {
  const raw = capturePreferencesSnapshot();
  const value = raw ? JSON.parse(raw) : { ...DEFAULT_CAPTURE_PREFERENCES, systemReduced: true };
  return resolveCapturePreferences(value, value.systemReduced);
}
export function saveCapturePreferences(value: CapturePreferences): boolean {
  sessionValue = JSON.stringify({ version: 1, ...value }); let saved = false;
  try { localStorage.setItem(CAPTURE_PREFERENCES_KEY, sessionValue); saved = true; } catch {}
  window.dispatchEvent(new Event(CAPTURE_PREFERENCES_EVENT)); return saved;
}
export function subscribeCapturePreferences(listener: () => void) {
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  const storage = (event: StorageEvent) => { if (event.key === CAPTURE_PREFERENCES_KEY || event.key === null) { sessionValue = null; listener(); } };
  window.addEventListener("storage", storage); window.addEventListener(CAPTURE_PREFERENCES_EVENT, listener); media.addEventListener("change", listener);
  return () => { window.removeEventListener("storage", storage); window.removeEventListener(CAPTURE_PREFERENCES_EVENT, listener); media.removeEventListener("change", listener); };
}
