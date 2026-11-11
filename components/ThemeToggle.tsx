"use client";

import { useEffect } from "react";
import { Moon, Sun } from "lucide-react";
import { currentTheme, setTheme, syncChromeColor, useTheme } from "@/lib/theme";

// Both icons render and CSS picks one, so the server markup is already right before hydration.
export function ThemeToggle({ className }: { className: string }) {
  const theme = useTheme();
  useEffect(syncChromeColor, []);
  return <button type="button" aria-label="Dark mode" aria-pressed={theme === null ? undefined : theme === "dark"} title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"} onClick={() => setTheme(currentTheme() === "dark" ? "light" : "dark")} className={`theme-toggle ${className}`}>
    <Sun size={20} strokeWidth={2.25} aria-hidden className="dark:hidden" />
    <Moon size={19} strokeWidth={2.25} aria-hidden className="hidden dark:block" />
  </button>;
}
