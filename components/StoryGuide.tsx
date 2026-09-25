"use client";

import { HelpTooltip } from "@/components/HelpTooltip";

import { useId, useState } from "react";
import { BookOpen, ChevronLeft, ChevronRight } from "lucide-react";
import { Dropdown } from "./Dropdown";
import { STORY_CATEGORIES, STORY_DECKS } from "@/lib/stories/catalogue";
import { createStoryPlan, relaxStoryStep, storyStep, type StoryPlan } from "@/lib/stories/model";

interface Props {
  plan: StoryPlan | null;
  members: readonly { id: string; name: string }[];
  activeStep?: number;
  disabled?: boolean;
  editable?: boolean;
  onChange(plan: StoryPlan | null): void;
}
export function StoryGuide({ plan, members, activeStep, disabled = false, editable = true, onChange }: Props) {
  const id = useId(), [preview, setPreview] = useState(0);
  const step = activeStep ?? preview;
  const guidance = plan ? storyStep(plan, step, members.map(member => member.id)) : null;
  const deck = STORY_DECKS.find(item => item.id === plan?.deckId);
  const button = "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-40";
  return <section aria-labelledby={id} className="space-y-4 rounded-xl border border-border p-4">
    <h3 id={id} className="flex items-center gap-2 text-sm font-semibold"><BookOpen size={17} aria-hidden />A four-cut story</h3>
    {editable && <Dropdown label="Photo story" value={plan?.deckId ?? "none"} disabled={disabled} options={[{ value: "none", label: "Free poses" }, ...STORY_DECKS.map(item => ({ value: item.id, label: `${STORY_CATEGORIES[item.category]} · ${item.title}` }))]} onChange={value => { setPreview(0); onChange(value === "none" ? null : createStoryPlan(value)); }} />}
    {!plan ? <p className="text-sm leading-relaxed text-muted-foreground">Choose four pose prompts, each with a comfortable alternative.</p> : <>
      <div className="flex items-center gap-2"><p className="font-display text-xl">{guidance!.title}</p><HelpTooltip label="About this story">{deck!.description}</HelpTooltip></div>
      <div className="flex items-center justify-between gap-3">
        <button type="button" className={button} aria-label="Preview previous pose" disabled={activeStep !== undefined || step === 0} onClick={() => setPreview(value => value - 1)}><ChevronLeft size={18} aria-hidden /></button>
        <span className="text-sm tabular-nums">Photo {step + 1} / 4</span>
        <button type="button" className={button} aria-label="Preview next pose" disabled={activeStep !== undefined || step === 3} onClick={() => setPreview(value => value + 1)}><ChevronRight size={18} aria-hidden /></button>
      </div>
      <p aria-live="polite" className="min-h-16 text-base leading-relaxed">{guidance!.prompt}</p>
      {members.length > 1 && <p className="text-xs leading-relaxed text-muted-foreground">Pose director: {members.find(member => member.id === guidance!.directorId)?.name}. The host still starts the camera.</p>}
      {editable && <button type="button" className={`${button} w-full border border-border`} disabled={disabled || activeStep !== undefined} onClick={() => onChange(relaxStoryStep(plan, step, !guidance!.relaxed))}>{guidance!.relaxed ? "Restore the suggested pose" : "Use a relaxed pose instead"}</button>}
      <p className="text-xs leading-relaxed text-muted-foreground">No standing, touching or sound required.</p>
    </>}
  </section>;
}
