"use client";
import { useAppNavigationGuard } from "@/components/AppNavigation";

import { useEffect, useRef, useState } from "react";
import { Dropdown } from "@/components/Dropdown";
import type { CloudProjectView } from "@/lib/projects/cloud-contract";
import { deriveChallengeAssignments, type ChallengeCreate as Creation } from "@/lib/memories/challenge-contract";
import { challengeDraftMessage, type ChallengeDraft, type ChallengeDraftJournal, type ChallengeCreationForm } from "@/lib/memories/challenge-drafts";
import { createChallengeDraftWriter } from "@/lib/memories/challenge-draft-writer";
import { challengeDesign, challengeLayouts } from "@/lib/memories/challenge-ui";
import { cloudControl } from "./CloudControls";
import { ChallengeStoryReview } from "./ChallengeStory";
import { challengeHasFourPoses, challengeStoryForReview } from "./challenge-story-review";

export function ChallengeCreate({ project, ownerId, busy, journal, initialDraft, onCreate, onCancel, storySupported = false }: { project: CloudProjectView; ownerId: string; busy: boolean; journal: ChallengeDraftJournal; initialDraft: Extract<ChallengeDraft, { kind: "create" }>; onCreate(input: Creation, record: ChallengeDraft): Promise<void>; onCancel(): void; storySupported?: boolean }) {
  const [draft, setDraft] = useState(initialDraft), [form, setForm] = useState(initialDraft.form);
  const [saving, setSaving] = useState(false), [localBusy, setLocalBusy] = useState(false), [failure, setFailure] = useState<string | null>(null);
  const writer = useRef<ReturnType<typeof createChallengeDraftWriter> | null>(null), live = useRef(false), heading = useRef<HTMLHeadingElement>(null);
  const [navigationNotice, setNavigationNotice] = useState<string | null>(null);
  useAppNavigationGuard(() => {
    if (!busy && !localBusy && !saving && !failure) return true;
    setNavigationNotice("Finish saving your challenge draft or use Back to challenges before leaving."); return false;
  });
  useEffect(() => {
    live.current = true; heading.current?.focus();
    const current = createChallengeDraftWriter(initialDraft, journal, state => { if (live.current) { setDraft(state.draft as typeof initialDraft); setSaving(state.saving); setFailure(state.error ? challengeDraftMessage(state.error) : null); } }); writer.current = current;
    return () => { live.current = false; current.close(); if (writer.current === current) writer.current = null; };
  }, [initialDraft, journal]);
  const { selected, layoutId: layout, policy, expiresAt: deadline } = form;
  const layouts = challengeLayouts(selected.length), layoutId = layouts.some(item => item.id === layout) ? layout : layouts[0]?.id;
  const shape = layoutId && selected.length >= 2 ? challengeDesign(layoutId, selected) : null;
  const frozen = draft.state === "pending" ? draft.request : null, locked = busy || localBusy || Boolean(frozen);
  const story = challengeStoryForReview(form.story, frozen), reviewShape = frozen ?? shape;
  const storyBlocked = Boolean(story) && !storySupported;
  const layoutSupportsStory = (id: string, people = selected) => { const candidate = challengeDesign(id, people); return challengeHasFourPoses(deriveChallengeAssignments(candidate.design, candidate.members)); };
  const change = (patch: Partial<ChallengeCreationForm>) => {
    const next = { ...form, ...patch }, available = challengeLayouts(next.selected.length);
    if (available.length && !available.some(item => item.id === next.layoutId)) next.layoutId = available[0].id;
    if (next.story && available.length && !layoutSupportsStory(next.layoutId, next.selected)) next.layoutId = available.find(item => layoutSupportsStory(item.id, next.selected))?.id ?? next.layoutId;
    setForm(next); writer.current?.schedule({ id: draft.id, projectId: draft.projectId, kind: "create", challengeId: null, form: next });
  };
  const send = async () => {
    if (busy || localBusy || !shape || !writer.current || storyBlocked) return;
    setLocalBusy(true); setFailure(null);
    try {
      let current: ChallengeDraft = draft;
      if (current.state !== "pending") { current = await writer.current.flush(); current = await journal.freezeRequest(current.id, current.revision); }
      if (!live.current || current.kind !== "create" || !current.request) return;
      setDraft(current); await onCreate(current.request, current);
    } catch (error) { if (live.current) setFailure(challengeDraftMessage(error)); }
    finally { if (live.current) setLocalBusy(false); }
  };
  const back = async () => { setLocalBusy(true); try { if (draft.state === "draft") await writer.current?.flush(); if (live.current) onCancel(); } catch (error) { if (live.current) setFailure(challengeDraftMessage(error)); } finally { if (live.current) setLocalBusy(false); } };
  const [windowChoice, setWindowChoice] = useState("saved");
  return <section aria-labelledby="challenge-create-heading" className="py-6">
    {navigationNotice && <p role="alert" className="mb-4 text-sm">{navigationNotice}</p>}
    <h3 ref={heading} tabIndex={-1} id="challenge-create-heading" className="font-display text-2xl outline-none">Make a photo challenge</h3>
    <p className="mt-3 max-w-2xl text-sm leading-relaxed text-foreground/70">Choose the people and layout. Both stay fixed, and everyone must accept before uploading.</p>
    <fieldset disabled={locked} className="mt-6"><legend className="font-medium">Who is taking part?</legend><div className="mt-2 divide-y divide-border">{project.members.filter(member => member.status !== "revoked" || selected.includes(member.userId)).map(member => <label key={member.userId} className="flex min-h-14 items-center gap-3 py-3"><input type="checkbox" className="h-5 w-5 shrink-0 accent-accent" checked={selected.includes(member.userId)} disabled={locked || member.userId === ownerId || !selected.includes(member.userId) && selected.length >= 4} onChange={event => change({ selected: event.target.checked ? [...selected, member.userId] : selected.filter(id => id !== member.userId) })} /><span className="min-w-0 text-sm"><span className="block font-medium">{member.userId === ownerId ? "You · role A" : selected.includes(member.userId) ? `Role ${"ABCD"[selected.indexOf(member.userId)]}` : "Project member"}</span><span className="break-all text-foreground/70">{member.userId} · {member.status === "invited" ? "Project invitation pending" : member.status === "revoked" ? "No longer in this project" : "Joined"}</span></span></label>)}</div></fieldset>
    {selected.length < 2 && <p className="mt-3 text-sm text-foreground/70">Choose at least one other person. Invite them to the project first if they are missing here.</p>}
    {shape && <div className="mt-6 grid gap-6 sm:grid-cols-2"><div><Dropdown label="Challenge layout" showLabel disabled={locked} value={layoutId!} onChange={layoutId => change({ layoutId })} options={layouts.map(item => ({ value: item.id, label: item.name, disabled: Boolean(form.story) && !layoutSupportsStory(item.id) }))} /><p className="mt-3 text-sm text-foreground/70">{shape.members.map(member => `Role ${member.role}: ${new Set(shape.design.slots.flatMap(slot => [slot, ...(slot.companions ?? [])]).filter(slot => slot.role === member.role).map(slot => slot.sourceIndex)).size} photos`).join(" · ")}</p></div><div><Dropdown label="Reveal photos" showLabel disabled={locked} value={policy} onChange={value => change({ policy: value as Creation["policy"] })} options={[{ value: "all_submitted", label: "When everyone has submitted" }, { value: "immediate", label: "After each person's submission" }]} /><p className="mt-3 text-sm leading-relaxed text-foreground/70">{policy === "all_submitted" ? "Other people's contributions stay concealed until everyone submits." : "Submitted originals are visible to accepted contributors immediately. The complete strip is ready when everyone submits."}</p></div><div><Dropdown label="Contribution window" showLabel disabled={locked} value={windowChoice} onChange={value => { setWindowChoice(value); if (value !== "saved") change({ expiresAt: new Date(Date.now() + Number(value) * 86400000).toISOString() }); }} options={[{ value: "saved", label: "Keep saved deadline" }, { value: "1", label: "1 day" }, { value: "7", label: "7 days" }, { value: "30", label: "30 days" }]} /></div></div>}
    {shape && <p className="mt-4 text-sm text-foreground/70">Deadline: {new Date(deadline).toLocaleString("en-AU")} ({Intl.DateTimeFormat().resolvedOptions().timeZone}). Choosing a new window starts it from now; a saved request keeps its exact deadline.</p>}
    {reviewShape && <ChallengeStoryReview plan={story} members={reviewShape.members} assignments={deriveChallengeAssignments(reviewShape.design, reviewShape.members)} disabled={locked} frozen={Boolean(frozen)} supported={storySupported} onChange={plan => change({ story: plan })} />}
    {story && <p className="mt-3 text-sm leading-relaxed text-foreground/70">A guided story uses a compatible four-pose layout.</p>}
    {frozen && <p role="status" className="mt-5 max-w-2xl rounded-xl bg-muted p-4 text-sm leading-relaxed">This exact request is saved on this device for your account. Deadline: {new Date(frozen.expiresAt).toLocaleString("en-AU")}. Retry uses the same request. After reloading, reopen this saved request and check current access before explicitly retrying. No invitation is sent automatically.</p>}
    <p role="status" className="mt-4 text-sm text-foreground/70">{saving ? "Saving your draft on this device…" : failure ? "Latest changes are not confirmed saved." : "Draft saved on this device for your account."}</p>
    {failure && <p role="alert" className="mt-3 text-sm">{failure}</p>}
    <div className="mt-7 flex flex-wrap gap-3"><button className={`${cloudControl} bg-accent text-accent-foreground`} disabled={busy || localBusy || !shape || storyBlocked} onClick={() => void send()}>{frozen ? "Retry this saved creation" : "Create and invite"}</button><button className={cloudControl} disabled={busy || localBusy} onClick={() => void back()}>Back to challenges</button>{failure && <button className={`${cloudControl} underline underline-offset-4`} disabled={busy || localBusy} onClick={onCancel}>Leave without latest changes</button>}</div>
  </section>;
}
