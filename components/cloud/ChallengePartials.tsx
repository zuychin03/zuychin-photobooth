"use client";
import { useAppNavigationGuard } from "@/components/AppNavigation";
import { challengeDraftMessage, type ChallengeDraft, type ChallengeDraftJournal } from "@/lib/memories/challenge-drafts";

import { EventPostcardComposer } from "@/components/events/EventPostcardComposer";
import { useEffect, useRef, useState } from "react";
import { ArrowDownToLine, RefreshCw } from "lucide-react";
import type { ChallengeClient } from "@/lib/memories/challenge-client";
import type { ChallengeView, PartialDetail, PartialList } from "@/lib/memories/challenge-contract";
import type { CloudProjectClient } from "@/lib/projects/cloud-client";
import { renderPartialChallengePng, type ChallengePng } from "@/lib/memories/challenge-render";
import { challengeError } from "@/lib/memories/challenge-ui";
import { downloadProjectBlob } from "@/lib/projects/download";
import { createChallengeDraftWriter } from "@/lib/memories/challenge-draft-writer";
import { cloudControl } from "./CloudControls";

interface Props {
  drafts?: ChallengeDraftJournal; view: ChallengeView; challenges: ChallengeClient; projects: CloudProjectClient; busy: boolean;
  onPostcardBusyChange?(busy: boolean): void; sourceAccessToken?(): Promise<string | null>;
  run(work: (signal: AbortSignal) => Promise<void>): Promise<void>;
  clearPreview(): void; showPreview(result: ChallengePng): void;
  onNotice(message: string): void; onFocus(id: string): void;
}
interface Loaded { view: ChallengeView; list: PartialList; detail: PartialDetail | null }

export function ChallengePartials({ view, challenges, projects, drafts, busy: externalBusy, onPostcardBusyChange, sourceAccessToken, run, clearPreview, showPreview, onNotice, onFocus }: Props) {
  const [postcardBusy, setPostcardBusy] = useState(false);
  const busy = externalBusy || postcardBusy;
  const [loaded, setLoaded] = useState<Loaded | null>(null), [failure, setFailure] = useState<string | null>(null);
  const [creating, setCreating] = useState(false), [selected, setSelected] = useState<string[]>([]);
  const [frozen, setFrozen] = useState<{ id: string; contributors: string[] } | null>(null), [rejecting, setRejecting] = useState<string | null>(null);
  const [draftRecord, setDraftRecord] = useState<Extract<ChallengeDraft, { kind: "partial" }> | null>(null), [savingDraft, setSavingDraft] = useState(false), [draftFailure, setDraftFailure] = useState<string | null>(null), [hasDraft, setHasDraft] = useState(false);
  const draftWriter = useRef<ReturnType<typeof createChallengeDraftWriter> | null>(null);
  const live = useRef(false), initialRequest = useRef<AbortController | null>(null);
  useAppNavigationGuard(() => {
    if (!savingDraft && !draftFailure) return true;
    setFailure("Retry saving your proposal choices, or leave without the latest changes before navigating away."); return false;
  }, creating);
  const current = loaded?.view === view ? loaded : null, detail = current?.detail;
  const eligible = view.members.filter(member => member.status === "accepted" && member.submitted);
  const chosen = frozen?.contributors ?? selected.filter(id => eligible.some(member => member.userId === id));
  const locked = busy || !current;
  useEffect(() => {
    live.current = true; const abort = new AbortController(); initialRequest.current = abort;
    void challenges.listPartials(view.id, undefined, 20, abort.signal).then(list => {
      if (!abort.signal.aborted) { setLoaded({ view, list, detail: null }); setFailure(null); setCreating(false); setDraftRecord(null); setFrozen(null); }
    }).catch(error => { if (!abort.signal.aborted) setFailure(challengeError(error)); });
    if (drafts) void drafts.list().then(items => { if (!abort.signal.aborted) setHasDraft(items.some(item => !("readOnly" in item) && item.kind === "partial" && item.projectId === view.projectId && item.challengeId === view.id)); }).catch(error => { if (!abort.signal.aborted) setDraftFailure(challengeDraftMessage(error)); });
    return () => { live.current = false; abort.abort(); draftWriter.current?.close(); draftWriter.current = null; };
  }, [challenges, drafts, view]);
  const check = (signal: AbortSignal) => { projects.assertActive(signal); challenges.assertActive(signal); if (!live.current) throw { code: "cancelled" }; };
  const reload = async (signal: AbortSignal, selectedDetail?: { id: string; digest: string }) => {
    const list = await challenges.listPartials(view.id, undefined, 20, signal);
    const next = selectedDetail ? await challenges.partialDetail(selectedDetail.id, selectedDetail.digest, signal) : null;
    check(signal); setLoaded({ view, list, detail: next }); setFailure(null); setRejecting(null);
  };
  const act = (work: (signal: AbortSignal) => Promise<void>) => run(async signal => {
    initialRequest.current?.abort(); clearPreview(); setFailure(null);
    try { await work(signal); }
    catch (error) { if (live.current) setFailure(signal.aborted ? "Stopped waiting. Refresh proposals before retrying; the action may have reached the server." : challengeError(error)); }
  });
  const open = (id: string, digest: string) => act(async signal => {
    const next = await challenges.partialDetail(id, digest, signal); check(signal);
    setLoaded(previous => previous && { ...previous, detail: next }); setCreating(false); setRejecting(null); onFocus("partial-review-heading");
  });
  const adoptDraft = (record: ChallengeDraft) => {
    if (record.kind !== "partial" || !drafts) throw new Error("Invalid saved proposal");
    draftWriter.current?.close();
    const writer = createChallengeDraftWriter(record, drafts, state => {
      if (live.current) { setDraftRecord(state.draft as typeof record); setSavingDraft(state.saving); setDraftFailure(state.error ? challengeDraftMessage(state.error) : null); }
    });
    draftWriter.current = writer; setDraftRecord(record); setSelected(record.form.contributors); setFrozen(record.request); setHasDraft(true);
  };
  const beginProposal = () => act(async signal => {
    if (!drafts) throw new Error("Local proposal recovery unavailable");
    const entries = await drafts.list(); check(signal);
    const existing = entries.find(item => !("readOnly" in item) && item.kind === "partial" && item.projectId === view.projectId && item.challengeId === view.id);
    const record = existing && !("readOnly" in existing) ? existing : await drafts.saveDraft({ kind: "partial", id: crypto.randomUUID(), projectId: view.projectId, challengeId: view.id, form: { contributors: [] } }, null);
    check(signal); adoptDraft(record); setCreating(true); setRejecting(null); onFocus("partial-create-heading");
  });
  const chooseContributors = (contributors: string[]) => {
    setSelected(contributors);
    if (draftRecord) draftWriter.current?.schedule({ kind: "partial", id: draftRecord.id, projectId: view.projectId, challengeId: view.id, form: { contributors } });
  };
  const backToProposals = () => act(async signal => {
    if (draftRecord?.state === "draft") await draftWriter.current?.flush();
    check(signal); setCreating(false); onFocus("partials-heading");
  });
  const propose = () => act(async signal => {
    if (!drafts || !draftRecord || !draftWriter.current) throw new Error("Local proposal recovery unavailable");
    let saved: ChallengeDraft = draftRecord;
    if (saved.state !== "pending") { draftWriter.current.schedule({ kind: "partial", id: saved.id, projectId: view.projectId, challengeId: view.id, form: { contributors: chosen } }); saved = await draftWriter.current.flush(); saved = await drafts.freezeRequest(saved.id, saved.revision); }
    check(signal); if (saved.kind !== "partial" || !saved.request) throw new Error("Invalid saved proposal");
    setDraftRecord(saved); setFrozen(saved.request);
    const latest = await challenges.view(view.id, signal); check(signal);
    if ("unsupported" in latest || latest.projectId !== view.projectId || !latest.members.some(member => member.userId === projects.ownerId && member.status === "accepted")) throw { code: "access_denied" };
    let next;
    try { next = await challenges.proposePartial(view.id, saved.request.id, saved.request.contributors, signal); }
    catch (error) {
      if (error && typeof error === "object" && "status" in error && Number(error.status) >= 400 && "code" in error && ["invalid_request", "capacity"].includes(String(error.code))) { const editable = await drafts.rejectedRequest(saved.id, saved.revision); check(signal); adoptDraft(editable); }
      throw error;
    }
    check(signal); await drafts.forget(saved.id, saved.revision); check(signal);
    draftWriter.current.close(); draftWriter.current = null; setDraftRecord(null); setHasDraft(false); setFrozen(null); setSelected([]); setCreating(false);
    await reload(signal, next); onFocus("partial-review-heading");
    onNotice("Proposal created. Each included person must give their own consent, including you if you are included.");
  });  const consent = (value: boolean) => act(async signal => {
    if (!detail || "unsupported" in detail) return;
    const next = await challenges.consentPartial(detail.id, detail.digest, value, signal); await reload(signal, next);
    onFocus("partial-review-heading"); onNotice(value ? "Your consent is recorded for this exact proposal. Reveal it when everyone included has agreed." : "This proposal is declined. Future access is blocked; copies already downloaded cannot be recalled.");
  });
  const commit = () => act(async signal => {
    if (!detail || "unsupported" in detail) return;
    const next = await challenges.commitPartial(detail.id, detail.digest, signal); await reload(signal, next);
    onFocus("partial-review-heading"); onNotice("Partial result revealed to its included contributors.");
  });
  const render = (download: boolean) => act(async signal => {
    if (!detail || "unsupported" in detail) return;
    const result = await renderPartialChallengePng({ challenges, projects, partialId: detail.id, digest: detail.digest, signal }); check(signal);
    if (download) { downloadProjectBlob(result.blob, `partial-${detail.id}.png`); onNotice(["Partial PNG prepared. Check your browser's downloads.", ...result.warnings].join(" ")); onFocus("partial-review-heading"); }
    else { showPreview(result); onNotice(result.warnings.join(" ")); }
  });
  const reviewed = detail && !("unsupported" in detail) ? detail : null;
  const ready = reviewed?.status === "pending" && !reviewed.accessLost && reviewed.contributors.every(person => person.consent === true && person.status === "available");
  return <section className="border-t border-border py-7" aria-labelledby="partials-heading">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 id="partials-heading" tabIndex={-1} className="font-display text-2xl outline-none">Make a partial result</h3><p className="mt-2 max-w-2xl text-sm leading-relaxed text-foreground/70">Keep the contributions that are ready, with everyone included agreeing first. The remaining spaces stay blank. Personal captions are left out.</p></div><button className={cloudControl} disabled={busy} onClick={() => void act(async signal => { await reload(signal); onFocus("partials-heading"); })}><RefreshCw size={16} aria-hidden /> Refresh proposals</button></div>
    {failure && <p role="alert" className="mt-4 rounded-xl bg-muted p-4 text-sm">{failure}</p>}
    {!current && !failure && <p role="status" className="mt-4 text-sm">Loading your proposals…</p>}
    {current && <>
      {current.list.partials.length === 0 ? <p className="mt-5 text-sm text-foreground/70">No proposals yet. Only the proposer and included contributors can find a proposal.</p> : <ul className="mt-5 divide-y divide-border" aria-label="Partial result proposals">{current.list.partials.map(item => <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 py-4"><div className="min-w-0">{"unsupported" in item ? <p className="text-sm">This older proposal cannot be opened here.</p> : <><p className="text-sm font-medium">Roles {item.contributors.map(person => person.role).join(" + ")} · {item.accessLost ? "Access lost" : item.status === "revealed" ? "Revealed" : item.status === "rejected" ? "Declined" : "Waiting for consent"}</p><p className="mt-1 text-sm text-foreground/70">{item.actorIncluded ? item.actorConsent === true ? "You agreed" : item.actorConsent === false ? "You declined" : "Your consent is needed" : "You proposed this; you are not included"} · {new Date(item.createdAt).toLocaleString("en-AU")}</p></>}</div>{!("unsupported" in item) && <button className={`${cloudControl} border border-border`} disabled={busy} onClick={() => void open(item.id, item.digest)} aria-label={`Review proposal for roles ${item.contributors.map(person => person.role).join(" and ")} created ${new Date(item.createdAt).toLocaleString("en-AU")}`}>Review proposal</button>}</li>)}</ul>}
      {current.list.nextCursor && <p className="mt-3 text-sm text-foreground/70">Only the first 20 proposals are shown. This challenge has reached the supported proposal limit.</p>}
      {!creating && <div className="mt-5"><button className={`${cloudControl} border border-border`} disabled={busy || !drafts || !hasDraft && (!eligible.length || current.list.partials.length >= 20)} onClick={() => void beginProposal()}>{hasDraft ? "Resume saved proposal" : "Choose contributors"}</button>{!eligible.length && <p className="mt-2 text-sm text-foreground/70">At least one accepted contributor must submit their photos first.</p>}</div>}
    </>}
    {creating && <div className="mt-6 max-w-2xl"><h4 id="partial-create-heading" tabIndex={-1} className="text-lg font-semibold outline-none">Who should be included?</h4><p className="mt-2 text-sm leading-relaxed text-foreground/70">Only included people can see or download this partial result. Proposing it does not give consent on anyone&apos;s behalf.</p><fieldset disabled={locked || Boolean(frozen)} className="mt-3"><legend className="sr-only">Included contributors</legend>{view.members.filter(member => eligible.includes(member) || frozen?.contributors.includes(member.userId)).map(member => <label key={member.userId} className="flex min-h-14 items-center gap-3 border-b border-border py-3"><input type="checkbox" className="h-5 w-5 shrink-0 accent-accent" checked={chosen.includes(member.userId)} onChange={event => chooseContributors(event.target.checked ? [...selected, member.userId] : selected.filter(id => id !== member.userId))} /><span className="min-w-0 text-sm"><span className="block font-medium">Role {member.role}{member.userId === projects.ownerId ? " · You" : ""}</span><span className="break-all text-foreground/70">{member.userId}</span></span></label>)}</fieldset>
      {chosen.length > 0 && !chosen.includes(projects.ownerId) && <p className="mt-3 text-sm leading-relaxed">You are not included. You can follow this proposal&apos;s consent status, but you will not receive its photos or result.</p>}
      {frozen && <p role="status" className="mt-3 text-sm leading-relaxed">This exact proposal is saved on this device for your account. Refresh proposals before retrying. After a reload, resume it here. Retrying uses the same identity and contributors; it never grants consent automatically.</p>}
      <p role="status" className="mt-3 text-sm text-foreground/70">{savingDraft ? "Saving proposal choices…" : draftFailure ? "Latest choices are not confirmed saved." : "Proposal draft saved on this device."}</p>{draftFailure && <p role="alert" className="mt-3 text-sm">{draftFailure}</p>}<div className="mt-4 flex flex-wrap gap-3"><button className={`${cloudControl} bg-accent text-accent-foreground`} disabled={locked || !chosen.length} onClick={() => void propose()}>{frozen ? "Retry this proposal" : "Propose partial result"}</button><button className={cloudControl} disabled={busy} onClick={() => void backToProposals()}>Back to proposals</button>{draftFailure && <button className={`${cloudControl} underline underline-offset-4`} disabled={busy || savingDraft} onClick={() => { draftWriter.current?.close(); draftWriter.current = null; setCreating(false); setFailure(null); onFocus("partials-heading"); }}>Leave without latest choices</button>}</div>
    </div>}
    {reviewed && !creating && <div className="mt-7 border-t border-border pt-6" aria-labelledby="partial-review-heading"><h4 id="partial-review-heading" tabIndex={-1} className="text-lg font-semibold outline-none">Review this partial result</h4><p className="mt-2 max-w-2xl text-sm leading-relaxed text-foreground/70">Agreeing permits the people below to see and download each other&apos;s submitted originals and this partial layout, once everyone agrees and the proposal is revealed. The layout keeps its original spacing, with blank areas for excluded contributors. Personal captions are omitted.</p>
      <ul className="mt-4 divide-y divide-border" aria-label="Partial result consent">{reviewed.contributors.map(person => <li key={person.userId} className="py-3"><p className="text-sm font-medium">Role {person.role}{person.userId === projects.ownerId ? " · You" : ""} · {person.status === "access_lost" ? "No longer available" : person.consent === true ? "Agreed" : person.consent === false ? "Declined" : "Awaiting consent"}</p><p className="mt-1 break-all text-xs text-foreground/70">{person.userId}</p></li>)}</ul>
      {reviewed.accessLost && <p className="mt-4 text-sm leading-relaxed">An included contributor, original or consent is no longer available. This result cannot be prepared.</p>}
      {!reviewed.actorIncluded && <p className="mt-4 text-sm leading-relaxed">You proposed this result but are not included. You cannot consent for others, preview it or download it.</p>}
      {reviewed.status === "rejected" && <p className="mt-4 text-sm leading-relaxed">This proposal was declined and cannot be reopened. A new proposal would need fresh consent from everyone included.</p>}
      <div className="mt-4 flex flex-wrap gap-3">
        {reviewed.actorIncluded && reviewed.status === "pending" && !reviewed.accessLost && reviewed.actorConsent !== true && <button className={`${cloudControl} bg-accent text-accent-foreground`} disabled={locked} onClick={() => void consent(true)}>Agree to this partial result</button>}
        {reviewed.actorIncluded && reviewed.status !== "rejected" && <button className={`${cloudControl} border border-border`} disabled={locked} onClick={() => { clearPreview(); setRejecting(reviewed.id); onFocus("partial-decline-action"); }}>{reviewed.actorConsent === true ? "Withdraw my consent…" : "Decline this proposal…"}</button>}
        {ready && <button className={`${cloudControl} bg-accent text-accent-foreground`} disabled={locked} onClick={() => void commit()}>Reveal agreed partial result</button>}
        {reviewed.result && <><button className={`${cloudControl} bg-accent text-accent-foreground`} disabled={locked} onClick={() => void render(false)}>Preview partial result</button><button className={`${cloudControl} border border-border`} disabled={locked} onClick={() => void render(true)}><ArrowDownToLine size={16} aria-hidden /> Download partial PNG</button></>}
      </div>
      {reviewed.result && reviewed.status === "revealed" && reviewed.actorIncluded && reviewed.actorConsent === true && !reviewed.accessLost && <EventPostcardComposer source={{ kind: "partial", id: reviewed.id }} design={reviewed.result.design} sourceAccessToken={sourceAccessToken} disabled={externalBusy || Boolean(rejecting)} onBusyChange={value => { setPostcardBusy(value); onPostcardBusyChange?.(value); }} assertSourceActive={signal => { projects.assertActive(signal); challenges.assertActive(signal); if (!live.current) throw { code: "access_lost" }; }} render={async (signal, frozenDesign) => {
        check(signal);
        if (JSON.stringify(frozenDesign) !== JSON.stringify(reviewed.result!.design)) throw new Error("The saved postcard layout does not match this partial result.");
        const result = await renderPartialChallengePng({ challenges, projects, partialId: reviewed.id, digest: reviewed.digest, signal });
        check(signal);
        if (result.recipeHash !== reviewed.result!.recipeHash) throw new Error("The partial result changed. Check access before trying again.");
        return result.blob;
      }} />}
      {rejecting === reviewed.id && <div className="mt-5 max-w-2xl rounded-xl bg-muted p-5"><p className="font-medium">Decline this exact proposal?</p><p className="mt-2 text-sm leading-relaxed">This blocks future access to this partial result and cannot be undone. It does not withdraw your original challenge contribution. Copies already downloaded remain.</p><div className="mt-4 flex flex-wrap gap-3"><button id="partial-decline-action" className={`${cloudControl} border border-border`} disabled={locked} onClick={() => void consent(false)}>Confirm decline</button><button className={cloudControl} disabled={busy} onClick={() => { setRejecting(null); onFocus("partial-review-heading"); }}>Keep current consent</button></div></div>}
      <details className="mt-4 text-sm text-foreground/70"><summary className="cursor-pointer py-2">Proposal reference</summary><p className="break-all py-2">{reviewed.id}</p></details>
    </div>}
  </section>;
}
