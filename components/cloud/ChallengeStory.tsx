"use client";

import { useId } from "react";
import { BookOpen } from "lucide-react";
import { Dropdown } from "@/components/Dropdown";
import { RELAXED_POSE, STORY_CATEGORIES, STORY_DECKS } from "@/lib/stories/catalogue";
import { createStoryPlan, relaxStoryStep, type StoryPlan } from "@/lib/stories/model";
import type { ChallengeAssignment } from "@/lib/memories/challenge-contract";
import { challengeStoryPose, type StoryMember } from "./challenge-story-review";

export function ChallengeStoryReview({ plan, members, assignments, disabled = false, frozen = false, supported = true, title, className = "panel-muted mt-5 p-4 sm:p-5", onChange }: { plan: StoryPlan | null; members: readonly StoryMember[]; assignments: readonly ChallengeAssignment[]; disabled?: boolean; frozen?: boolean; supported?: boolean; title?: string; className?: string; onChange?(plan: StoryPlan | null): void }) {
  const id = useId(), deck = STORY_DECKS.find(item => item.id === plan?.deckId);
  return <section aria-labelledby={id} className={className}>
    <div className="flex min-w-0 items-center gap-3"><span className="glyph bg-[#f43f5e]"><BookOpen size={18} strokeWidth={2.25} aria-hidden /></span><h4 id={id} className="font-display text-xl leading-tight">{title ?? (frozen ? "Photo story" : "Photo story (optional)")}</h4></div>
    {onChange && !frozen && <div className="mt-4 max-w-xl"><Dropdown label="Photo story" showLabel disabled={disabled || !supported} value={plan?.deckId ?? "none"} options={[{ value: "none", label: "Free poses" }, ...STORY_DECKS.map(item => ({ value: item.id, label: `${STORY_CATEGORIES[item.category]} · ${item.title}` }))]} onChange={value => onChange(value === "none" ? null : plan?.deckId === value ? plan : createStoryPlan(value))} /></div>}
    {!supported && <p className="mt-3 text-sm text-muted-foreground">Stories aren&apos;t available on this server yet. You can still use free poses.</p>}
    {!supported && plan && onChange && !frozen && <button type="button" className="btn btn-tinted mt-3 min-h-10 text-sm" disabled={disabled} onClick={() => onChange(null)}>Use free poses</button>}
    {!plan ? <p className="mt-3 text-sm text-muted-foreground">Everyone picks their own poses.</p> : <>
      <h5 className="mt-4 font-display text-lg">{deck!.title}</h5><p className="mt-1 max-w-2xl text-sm text-muted-foreground">{deck!.description} Each person only takes the poses for their role.</p>
      <ol className="mt-3 divide-y divide-border">{[0, 1, 2, 3].map(index => {
        const pose = challengeStoryPose(plan, index, members), roles = members.filter(member => assignments.some(assignment => assignment.userId === member.userId && assignment.sourceIndex === index)).map(member => member.role).sort();
        return <li key={index} className="py-4"><p className="text-sm font-bold">Pose {pose.number} · {roles.length ? `Role${roles.length > 1 ? "s" : ""} ${roles.join(", ")}` : "Choose a four-pose layout"}</p><p className="mt-1 max-w-2xl">{pose.prompt}</p>{!pose.relaxed && <p className="mt-1 text-sm text-muted-foreground">Relaxed version: {RELAXED_POSE}</p>}{onChange && !frozen && <button type="button" className="btn btn-tinted mt-2 min-h-10 text-sm" disabled={disabled || !supported} onClick={() => onChange(relaxStoryStep(plan, index, !pose.relaxed))}>{pose.relaxed ? `Use original pose ${pose.number}` : `Use relaxed pose ${pose.number}`}</button>}</li>;
      })}</ol>
      <p className="mt-2 text-sm text-muted-foreground">If a prompt mentions someone else, do your own version. All poses can be done seated, with no touching or sound.</p>
    </>}
  </section>;
}

export function ChallengeStoryPose({ plan, members, sourceIndex }: { plan: StoryPlan; members: readonly StoryMember[]; sourceIndex: number }) {
  const pose = challengeStoryPose(plan, sourceIndex, members);
  return <div className="mt-3 max-w-2xl rounded-2xl bg-accent/8 p-4"><p className="text-sm font-bold text-accent">{pose.title} · story pose {pose.number} of 4</p><p className="mt-1">{pose.prompt}</p>{!pose.relaxed && <p className="mt-1 text-sm text-muted-foreground">Relaxed version: {RELAXED_POSE}</p>}</div>;
}
