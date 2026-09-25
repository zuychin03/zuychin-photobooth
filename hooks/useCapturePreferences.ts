"use client";
import { useSyncExternalStore } from "react";
import { capturePreferencesSnapshot, DEFAULT_CAPTURE_PREFERENCES, resolveCapturePreferences, subscribeCapturePreferences, type CapturePreferences } from "@/lib/capture-preferences";
export function useCapturePreferences() {
  const snapshot = useSyncExternalStore(subscribeCapturePreferences, capturePreferencesSnapshot, () => "");
  const value: CapturePreferences & { systemReduced: boolean } = snapshot ? JSON.parse(snapshot) : { ...DEFAULT_CAPTURE_PREFERENCES, systemReduced: true };
  return { value, ...resolveCapturePreferences(value, value.systemReduced) };
}
