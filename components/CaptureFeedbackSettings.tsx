"use client";
import { useState } from "react";
import { useCapturePreferences } from "@/hooks/useCapturePreferences";
import { saveCapturePreferences, type CapturePreferences } from "@/lib/capture-preferences";
import { Dropdown } from "./Dropdown";
import { HelpTooltip } from "./HelpTooltip";
export function CaptureFeedbackSettings({ disabled = false }: { disabled?: boolean }) {
  const { value, reducedMotion } = useCapturePreferences(), [saved, setSaved] = useState<boolean | null>(null);
  const change = (patch: Partial<CapturePreferences>) => setSaved(saveCapturePreferences({ sound: value.sound, flash: value.flash, motion: value.motion, ...patch }));
  return <fieldset disabled={disabled} className="space-y-2 text-sm disabled:opacity-60"><legend className="mb-2 font-semibold">Sound and flash <HelpTooltip label="About sound and flash">Both start off, and your choice is saved in this browser. Some shared features, like challenges and events, always stay quiet with no flash.</HelpTooltip></legend>
    <div className="flex flex-wrap gap-x-5"><label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={value.sound} onChange={event => change({ sound: event.target.checked })} className="h-4 w-4 accent-accent" /> Countdown and shutter sound</label><label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={value.flash} disabled={disabled} onChange={event => change({ flash: event.target.checked })} className="h-4 w-4 accent-accent" /> Screen flash</label></div>
    <Dropdown label="Motion" showLabel disabled={disabled} value={value.motion} onChange={motion => change({ motion: motion as CapturePreferences["motion"] })} options={[{ value: "system", label: "Match my device settings" }, { value: "reduce", label: "Reduce motion and turn off flash" }]} />
    {reducedMotion && <p className="text-xs leading-relaxed text-muted-foreground">Reduced motion is on, so the screen flash is off.</p>}
    {saved !== null && <p role="status" className="text-xs text-muted-foreground">{saved ? "Saved in this browser." : "This browser can't save settings, so they'll reset next time."}</p>}
  </fieldset>;
}
