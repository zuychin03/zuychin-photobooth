"use client";

import { useSyncExternalStore } from "react";
import { THEME_STORAGE_KEY as STORAGE_KEY } from "@/lib/theme-boot";

export type ThemeName = "light" | "dark";

const CHANGE_EVENT = "zuychin-theme-change";
const SYSTEM_DARK = "(prefers-color-scheme: dark)";
// Match --background in globals.css and viewport.themeColor in app/layout.tsx.
const CHROME_COLOR: Record<ThemeName, string> = { light: "#f6f1f2", dark: "#100d0f" };

function systemTheme(): ThemeName {
  return matchMedia(SYSTEM_DARK).matches ? "dark" : "light";
}

function chosenTheme(): ThemeName | null {
  const classes = document.documentElement.classList;
  return classes.contains("dark") ? "dark" : classes.contains("light") ? "light" : null;
}

export function currentTheme(): ThemeName {
  return chosenTheme() ?? systemTheme();
}

/** Next renders one theme-color meta per scheme; an explicit choice overrides both. */
export function syncChromeColor() {
  const chosen = chosenTheme();
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    const own: ThemeName = meta.media.includes("dark") ? "dark" : "light";
    meta.content = CHROME_COLOR[chosen ?? own];
  }
}

function applyChoice(choice: ThemeName | null) {
  const classes = document.documentElement.classList;
  classes.remove("light", "dark");
  if (choice) classes.add(choice);
  syncChromeColor();
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** Choosing the system's own theme clears the override, so the app follows the system again. */
export function setTheme(next: ThemeName) {
  const choice = next === systemTheme() ? null : next;
  try {
    if (choice) localStorage.setItem(STORAGE_KEY, choice); else localStorage.removeItem(STORAGE_KEY);
  } catch {}
  const doc = document as Document & { startViewTransition?: (update: () => void) => unknown };
  if (doc.startViewTransition && !matchMedia("(prefers-reduced-motion: reduce)").matches) doc.startViewTransition(() => applyChoice(choice));
  else applyChoice(choice);
}

function subscribe(onChange: () => void) {
  const system = matchMedia(SYSTEM_DARK);
  const storage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return;
    applyChoice(event.newValue === "light" || event.newValue === "dark" ? event.newValue : null);
  };
  system.addEventListener("change", onChange);
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", storage);
  return () => {
    system.removeEventListener("change", onChange);
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", storage);
  };
}

/** Null during server render and hydration. */
export function useTheme(): ThemeName | null {
  return useSyncExternalStore(subscribe, currentTheme, () => null);
}
