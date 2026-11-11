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
  className?: string;
  onChange(plan: StoryPlan | null): void;
}
export function StoryGuide({ plan, members, activeStep, disabled = false, editable = true, className = "panel-muted p-4 sm:p-5", onChange }: Props) {
  const id = useId(), [preview, setPreview] = useState(0);
  const step = activeStep ?? preview;
  const guidance = plan ? storyStep(plan, step, members.map(member => member.id)) : null;
  const deck = STORY_DECKS.find(item => item.id === plan?.deckId);
  const pager = "btn btn-quiet w-11 shrink-0 px-0";
  return <section aria-labelledby={id} className={`flex flex-col gap-4 ${className}`}>
    <h3 id={id} className="flex items-center gap-2 font-display text-[1.0625rem]"><BookOpen size={18} strokeWidth={2.25} className="text-accent" aria-hidden />A four-cut story</h3>
    {editable && <Dropdown label="Photo story" value={plan?.deckId ?? "none"} disabled={disabled} options={[{ value: "none", label: "Free poses" }, ...STORY_DECKS.map(item => ({ value: item.id, label: `${STORY_CATEGORIES[item.category]} · ${item.title}` }))]} onChange={value => { setPreview(0); onChange(value === "none" ? null : createStoryPlan(value)); }} />}
    {!plan ? <p className="text-sm text-muted-foreground">Pick a story for four pose ideas.</p> : <>
      <div className="flex items-center gap-1.5"><p className="font-display text-xl">{guidance!.title}</p><HelpTooltip label="About this story">{deck!.description}</HelpTooltip></div>
      <div className="flex items-center justify-between gap-3">
        <button type="button" className={pager} aria-label="Previous pose" disabled={activeStep !== undefined || step === 0} onClick={() => setPreview(value => value - 1)}><ChevronLeft size={18} aria-hidden /></button>
        <span className="text-sm font-bold tabular-nums text-muted-foreground">Photo {step + 1} / 4</span>
        <button type="button" className={pager} aria-label="Next pose" disabled={activeStep !== undefined || step === 3} onClick={() => setPreview(value => value + 1)}><ChevronRight size={18} aria-hidden /></button>
      </div>
      <p aria-live="polite" className="min-h-16 text-base leading-relaxed">{guidance!.prompt}</p>
      {members.length > 1 && <p className="text-xs leading-relaxed text-muted-foreground">{members.find(member => member.id === guidance!.directorId)?.name} directs this one.</p>}
      {editable && <button type="button" className="btn btn-quiet min-h-10 w-full text-sm" disabled={disabled || activeStep !== undefined} onClick={() => onChange(relaxStoryStep(plan, step, !guidance!.relaxed))}>{guidance!.relaxed ? "Switch back to the original pose" : "Use the relaxed version"}</button>}
      <p className="text-xs leading-relaxed text-muted-foreground">All poses can be done seated, with no touching or sound.</p>
    </>}
  </section>;
}
