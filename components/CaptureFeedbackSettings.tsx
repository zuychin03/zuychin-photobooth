"use client";
import { useState } from "react";
import { useCapturePreferences } from "@/hooks/useCapturePreferences";
import { saveCapturePreferences, type CapturePreferences } from "@/lib/capture-preferences";
import { HelpTooltip } from "./HelpTooltip";

export const settingRow = "flex min-h-12 cursor-pointer items-center justify-between gap-4 py-2 text-[0.9375rem]";
// Paired with a preceding `peer sr-only` checkbox so the native control keeps its semantics.
export const switchTrack = "relative h-[1.875rem] w-[3.125rem] shrink-0 rounded-full bg-[color-mix(in_srgb,var(--muted-foreground)_34%,transparent)] transition-colors duration-200 after:absolute after:top-0.5 after:left-0.5 after:size-[1.625rem] after:rounded-full after:bg-white after:shadow-[0_2px_6px_rgb(0_0_0/0.28)] after:transition-transform after:duration-500 after:ease-[var(--spring-bounce)] peer-checked:bg-accent peer-checked:after:translate-x-5 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring peer-disabled:opacity-50 motion-reduce:after:transition-none";

export function CaptureFeedbackSettings({ disabled = false, className = "" }: { disabled?: boolean; className?: string }) {
  const { value, reducedMotion } = useCapturePreferences(), [saved, setSaved] = useState<boolean | null>(null);
  const change = (patch: Partial<CapturePreferences>) => setSaved(saveCapturePreferences({ sound: value.sound, flash: value.flash, motion: value.motion, ...patch }));
  return <fieldset disabled={disabled} className={`text-sm disabled:opacity-60 ${className}`}>
    <legend className="float-left flex w-full items-center gap-1.5 pb-1 font-display text-[1.0625rem]">Sound and flash <HelpTooltip label="About sound and flash">Both are off by default. Challenges and events never use them.</HelpTooltip></legend>
    <div className="clear-both divide-y divide-border">
      <label className={settingRow}><span>Countdown and shutter sound</span><input type="checkbox" checked={value.sound} onChange={event => change({ sound: event.target.checked })} className="peer sr-only" /><span aria-hidden className={switchTrack} /></label>
      <label className={settingRow}><span>Screen flash</span><input type="checkbox" checked={value.flash} disabled={disabled} onChange={event => change({ flash: event.target.checked })} className="peer sr-only" /><span aria-hidden className={switchTrack} /></label>
      <label className={settingRow}><span>Reduce motion</span><input type="checkbox" checked={value.motion === "reduce"} onChange={event => change({ motion: event.target.checked ? "reduce" : "system" })} className="peer sr-only" /><span aria-hidden className={switchTrack} /></label>
    </div>
    {reducedMotion && <p className="pb-3 text-xs leading-relaxed text-muted-foreground">Reduced motion is on, so the screen flash is off.</p>}
    {saved !== null && <p role="status" className="pb-3 text-xs text-muted-foreground">{saved ? "Saved in this browser." : "This browser can't save settings. They'll reset next time."}</p>}
  </fieldset>;
}
