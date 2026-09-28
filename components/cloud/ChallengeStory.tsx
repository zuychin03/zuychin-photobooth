"use client";

import { useId } from "react";
import { Dropdown } from "@/components/Dropdown";
import { RELAXED_POSE, STORY_CATEGORIES, STORY_DECKS } from "@/lib/stories/catalogue";
import { createStoryPlan, relaxStoryStep, type StoryPlan } from "@/lib/stories/model";
import type { ChallengeAssignment } from "@/lib/memories/challenge-contract";
import { challengeStoryPose, type StoryMember } from "./challenge-story-review";
import { cloudControl } from "./CloudControls";

export function ChallengeStoryReview({ plan, members, assignments, disabled = false, frozen = false, supported = true, title, onChange }: { plan: StoryPlan | null; members: readonly StoryMember[]; assignments: readonly ChallengeAssignment[]; disabled?: boolean; frozen?: boolean; supported?: boolean; title?: string; onChange?(plan: StoryPlan | null): void }) {
  const id = useId(), deck = STORY_DECKS.find(item => item.id === plan?.deckId);
  return <section aria-labelledby={id} className="mt-6 border-t border-border pt-6">
    <h4 id={id} className="text-base font-semibold">{title ?? (frozen ? "Photo story" : "Photo story (optional)")}</h4>
    {onChange && !frozen && <div className="mt-3 max-w-xl"><Dropdown label="Photo story" showLabel disabled={disabled || !supported} value={plan?.deckId ?? "none"} options={[{ value: "none", label: "Free poses" }, ...STORY_DECKS.map(item => ({ value: item.id, label: `${STORY_CATEGORIES[item.category]} · ${item.title}` }))]} onChange={value => onChange(value === "none" ? null : plan?.deckId === value ? plan : createStoryPlan(value))} /></div>}
    {!supported && <p className="mt-3 text-sm leading-relaxed text-foreground/70">Stories aren&apos;t available on this server yet. You can still use free poses.</p>}
    {!supported && plan && onChange && !frozen && <button type="button" className={`${cloudControl} mt-3 border border-border`} disabled={disabled} onClick={() => onChange(null)}>Use free poses</button>}
    {!plan ? <p className="mt-3 text-sm text-foreground/70">Everyone picks their own poses.</p> : <>
      <h5 className="mt-4 font-display text-xl">{deck!.title}</h5><p className="mt-2 max-w-2xl text-sm leading-relaxed text-foreground/70">{deck!.description} Each person only takes the poses for their role.</p>
      <ol className="mt-4 divide-y divide-border">{[0, 1, 2, 3].map(index => {
        const pose = challengeStoryPose(plan, index, members), roles = members.filter(member => assignments.some(assignment => assignment.userId === member.userId && assignment.sourceIndex === index)).map(member => member.role).sort();
        return <li key={index} className="py-4"><p className="text-sm font-semibold">Pose {pose.number} · {roles.length ? `Role${roles.length > 1 ? "s" : ""} ${roles.join(", ")}` : "Choose a four-pose layout"}</p><p className="mt-2 max-w-2xl text-sm leading-relaxed">{pose.prompt}</p>{!pose.relaxed && <p className="mt-2 text-sm leading-relaxed text-foreground/70">Relaxed version: {RELAXED_POSE}</p>}{onChange && !frozen && <button type="button" className={`${cloudControl} mt-2 border border-border`} disabled={disabled || !supported} onClick={() => onChange(relaxStoryStep(plan, index, !pose.relaxed))}>{pose.relaxed ? `Use original pose ${pose.number}` : `Use relaxed pose ${pose.number}`}</button>}</li>;
      })}</ol>
      <p className="mt-3 text-sm leading-relaxed text-foreground/70">If a prompt mentions someone else, do your own version. All poses can be done seated, with no touching or sound.</p>
    </>}
  </section>;
}

export function ChallengeStoryPose({ plan, members, sourceIndex }: { plan: StoryPlan; members: readonly StoryMember[]; sourceIndex: number }) {
  const pose = challengeStoryPose(plan, sourceIndex, members);
  return <div className="mt-3 max-w-2xl border-l-2 border-accent pl-4"><p className="text-sm font-semibold">{pose.title} · story pose {pose.number} of 4</p><p className="mt-2 text-sm leading-relaxed">{pose.prompt}</p>{!pose.relaxed && <p className="mt-2 text-sm leading-relaxed text-foreground/70">Relaxed version: {RELAXED_POSE}</p>}</div>;
}
