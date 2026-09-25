"use client";
import { useState } from "react";
import { useCapturePreferences } from "@/hooks/useCapturePreferences";
import { saveCapturePreferences, type CapturePreferences } from "@/lib/capture-preferences";
import { Dropdown } from "./Dropdown";
import { HelpTooltip } from "./HelpTooltip";
export function CaptureFeedbackSettings({ disabled = false }: { disabled?: boolean }) {
  const { value, reducedMotion } = useCapturePreferences(), [saved, setSaved] = useState<boolean | null>(null);
  const change = (patch: Partial<CapturePreferences>) => setSaved(saveCapturePreferences({ sound: value.sound, flash: value.flash, motion: value.motion, ...patch }));
  return <fieldset disabled={disabled} className="space-y-2 text-sm disabled:opacity-60"><legend className="mb-2 font-semibold">Capture feedback <HelpTooltip label="About capture feedback">Sound and flash start off. These settings apply to this browser&apos;s booth, relay and legacy rooms. Other shared rooms, challenges and events stay silent and flash-free.</HelpTooltip></legend>
    <div className="flex flex-wrap gap-x-5"><label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={value.sound} onChange={event => change({ sound: event.target.checked })} className="h-4 w-4 accent-accent" /> Countdown and shutter sound</label><label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={value.flash} disabled={disabled} onChange={event => change({ flash: event.target.checked })} className="h-4 w-4 accent-accent" /> Screen flash</label></div>
    <Dropdown label="Capture motion" showLabel disabled={disabled} value={value.motion} onChange={motion => change({ motion: motion as CapturePreferences["motion"] })} options={[{ value: "system", label: "Follow device preference" }, { value: "reduce", label: "Reduce motion and disable flash" }]} />
    {reducedMotion && <p className="text-xs leading-relaxed text-muted-foreground">Reduced motion is on. Screen flash is disabled.</p>}
    {saved !== null && <p role="status" className="text-xs text-muted-foreground">{saved ? "Capture preferences saved on this browser." : "Preferences apply for this visit. Browser storage is unavailable."}</p>}
  </fieldset>;
}
