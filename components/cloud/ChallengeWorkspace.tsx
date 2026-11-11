"use client";
import { useAppNavigationGuard } from "@/components/AppNavigation";
import { challengeDraftMessage, type ChallengeDraft, type ChallengeDraftJournal } from "@/lib/memories/challenge-drafts";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Clock, LoaderCircle, Plus, RefreshCw } from "lucide-react";
import type { CloudProjectView } from "@/lib/projects/cloud-contract";
import type { CloudProjectClient } from "@/lib/projects/cloud-client";
import type { CloudUploadManager } from "@/lib/projects/cloud-upload";
import type { ChallengeClient } from "@/lib/memories/challenge-client";
import type { ChallengeList, ChallengeResult } from "@/lib/memories/challenge-contract";
import { challengeError } from "@/lib/memories/challenge-ui";
import { challengePath } from "@/lib/memories/challenge-entry";
import { ChallengeCreate } from "./ChallengeCreate";
import { ChallengeDetail } from "./ChallengeDetail";

export function ChallengeWorkspace({ project, client, challenges, uploads, drafts, onBack }: { project: CloudProjectView; client: CloudProjectClient; challenges: ChallengeClient; uploads: CloudUploadManager; drafts?: ChallengeDraftJournal; onBack(): void }) {
  const [list, setList] = useState<ChallengeList | null>(null), [selected, setSelected] = useState<ChallengeResult | null>(null), [creating, setCreating] = useState(false);
  const [creationDraft, setCreationDraft] = useState<Extract<ChallengeDraft, { kind: "create" }> | null>(null), [savedCreation, setSavedCreation] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [storySupported, setStorySupported] = useState(false);
  const running = useRef(false), controller = useRef<AbortController | null>(null), live = useRef(false), heading = useRef<HTMLHeadingElement>(null);
  useAppNavigationGuard(() => {
    if (!busy && !running.current) return true;
    setError("Wait for this to finish before you leave."); return false;
  }, !selected && !creating);
  useEffect(() => {
    live.current = true; heading.current?.focus(); const abort = new AbortController(); controller.current = abort; running.current = true;
    void challenges.list(project.project.id, undefined, undefined, abort.signal).then(setList).catch(failure => { if (!abort.signal.aborted) setError(challengeError(failure)); }).finally(() => { running.current = false; });
    void challenges.capabilities(abort.signal).then(value => { if (!abort.signal.aborted) setStorySupported(value.storyVersion === 1); }).catch(() => { if (!abort.signal.aborted) setStorySupported(false); });
    if (drafts) void drafts.list().then(items => { if (!abort.signal.aborted) setSavedCreation(items.some(item => !("readOnly" in item) && item.kind === "create" && item.projectId === project.project.id)); }).catch(failure => { if (!abort.signal.aborted) setError(challengeDraftMessage(failure)); });
    return () => { live.current = false; controller.current?.abort(); };
  }, [challenges, drafts, project.project.id]);
  const run = async (work: (signal: AbortSignal) => Promise<void>) => {
    if (running.current) return; running.current = true; const abort = new AbortController(); controller.current = abort; setBusy(true); setError(null);
    try { await work(abort.signal); } catch (failure) {
      if (live.current && !abort.signal.aborted) {
        const code = failure && typeof failure === "object" && "code" in failure ? failure.code : "";
        setError(creating && ["unavailable", "timeout", "network_error"].includes(String(code)) ? "No reply from the server. Try again, or go back to check whether the challenge was created." : challengeError(failure));
      }
    }
    finally { running.current = false; if (live.current) setBusy(false); }
  };
  const beginCreation = () => run(async signal => {
    if (!drafts) throw new Error("Local challenge recovery unavailable");
    const entries = await drafts.list(); client.assertActive(signal);
    const existing = entries.find(item => !("readOnly" in item) && item.kind === "create" && item.projectId === project.project.id);
    const record = existing && !("readOnly" in existing) ? existing : await drafts.saveDraft({ kind: "create", id: crypto.randomUUID(), projectId: project.project.id, challengeId: null, form: { selected: [client.ownerId], layoutId: "duo-alternate", policy: "all_submitted", expiresAt: new Date(Date.now() + 7 * 86400000).toISOString() } }, null);
    client.assertActive(signal); if (record.kind !== "create") return; setCreationDraft(record); setSavedCreation(true); setCreating(true);
  });
  if (selected && !("unsupported" in selected)) return <ChallengeDetail drafts={drafts} key={selected.id} initialView={selected} project={project} client={client} challenges={challenges} uploads={uploads} onBack={() => { setSelected(null); void run(async signal => setList(await challenges.list(project.project.id, undefined, undefined, signal))); }} />;
  return <section className="flex flex-col gap-5" aria-labelledby="challenge-list-heading">
    <header className="flex flex-col gap-3">
      <div><button className="btn btn-plain -ml-3.5 max-w-full text-sm" disabled={busy} onClick={onBack}><ArrowLeft size={16} aria-hidden /> <span className="min-w-0 truncate">{project.project.title}</span></button></div>
      <div className="flex flex-wrap items-end justify-between gap-3"><h2 ref={heading} tabIndex={-1} id="challenge-list-heading" className="font-display text-3xl outline-none sm:text-4xl">Photo challenges</h2><div className="flex flex-wrap gap-2"><button className="btn btn-quiet" disabled={busy || creating} onClick={() => void run(async signal => { setSelected(null); setList(await challenges.list(project.project.id, undefined, undefined, signal)); })}><RefreshCw size={16} aria-hidden /> Refresh</button>{!(creating && creationDraft && drafts) && list && project.project.ownerId === client.ownerId && <button className="btn btn-primary" disabled={busy || !drafts} onClick={() => void beginCreation()}><Plus size={17} aria-hidden />{savedCreation ? "Continue new challenge" : "New photo challenge"}</button>}</div></div>
    </header>
    {error && <p role="alert" className="notice border border-destructive/25 bg-destructive/8">{error}</p>}
    {busy && <p role="status" className="flex items-center gap-2 text-sm font-bold"><LoaderCircle size={16} aria-hidden className="animate-spin motion-reduce:animate-none" /> Waiting for confirmation…</p>}
    {selected && "unsupported" in selected && <p role="status" className="notice">This older challenge can&apos;t be opened here.</p>}
    {creating && creationDraft && drafts ? <ChallengeCreate key={`${creationDraft.id}:${creationDraft.revision}`} initialDraft={creationDraft} journal={drafts} project={project} ownerId={client.ownerId} busy={busy} storySupported={storySupported} onCancel={() => { setCreating(false); void run(async signal => setList(await challenges.list(project.project.id, undefined, undefined, signal))); }} onCreate={(input, record) => run(async signal => {
      const current = await client.view(project.project.id, signal);
      if (current.project.ownerId !== client.ownerId || current.project.status !== "active") throw { code: "access_denied" };
      let result;
      try { result = await challenges.create(project.project.id, input, signal); }
      catch (failure) {
        if (failure && typeof failure === "object" && "status" in failure && Number(failure.status) >= 400 && "code" in failure && ["invalid_request", "capacity"].includes(String(failure.code))) { const editable = await drafts.rejectedRequest(record.id, record.revision); client.assertActive(signal); if (editable.kind === "create") setCreationDraft(editable); }
        throw failure;
      }
      client.assertActive(signal);
      await drafts.forget(record.id, record.revision); client.assertActive(signal);
      if (!signal.aborted) { setSavedCreation(false); setCreating(false); setCreationDraft(null); setSelected(result); }
    })} /> : <>
      {!list && !error && <p role="status" className="panel flex min-h-40 items-center justify-center gap-2 text-sm text-muted-foreground"><LoaderCircle size={18} aria-hidden className="animate-spin motion-reduce:animate-none" /> Loading your challenges…</p>}
      {list && <div className="panel overflow-hidden">
        {list.challenges.length > 0 && <ul className="divide-y divide-border" aria-label="Your photo challenges">{list.challenges.map((challenge, index) => <li key={challenge.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-5"><div className="min-w-0"><h3 className="font-bold">Challenge {index + 1}</h3><p className="mt-0.5 text-sm text-muted-foreground"><span className="capitalize">{challenge.status} · {challenge.membership}</span> · Deadline {new Date(challenge.expiresAt).toLocaleString("en-AU")}</p></div><div className="flex flex-wrap items-center gap-1.5"><button className="btn btn-tinted min-h-10 text-sm" disabled={busy} aria-label={`Open challenge ${index + 1}`} onClick={() => void run(async signal => setSelected(await challenges.view(challenge.id, signal)))}>Open</button><Link href={challengePath(challenge.id)} prefetch={false} className="btn btn-plain min-h-10 text-sm" aria-label={`Open direct link for challenge ${index + 1}`}>Direct link</Link></div></li>)}</ul>}
        {list.challenges.length === 0 && <div className="flex flex-col items-center gap-3 px-6 py-12 text-center"><span className="glyph size-14 rounded-2xl bg-[#f59e0b]"><Clock size={26} aria-hidden /></span><h3 className="font-display text-2xl">No challenges yet.</h3><p className="max-w-sm text-sm text-muted-foreground">The project owner can start one for two to four people.</p></div>}
        {list.nextCursor && <div className="border-t border-border p-3 text-center"><button className="btn btn-quiet text-sm" disabled={busy} onClick={() => void run(async signal => { const next = await challenges.list(project.project.id, list.nextCursor!, undefined, signal); setList({ ...next, challenges: [...list.challenges, ...next.challenges.filter(item => !list.challenges.some(prior => prior.id === item.id))] }); })}>Show more</button></div>}
      </div>}
    </>}
  </section>;
}
