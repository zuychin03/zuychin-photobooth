"use client";
import { useAppNavigationGuard } from "@/components/AppNavigation";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, LoaderCircle, LockKeyhole, RefreshCw } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useCloudRuntime } from "@/hooks/useCloudRuntime";
import { challengeSignInPath, loadChallengeEntry, type ChallengeEntryState } from "@/lib/memories/challenge-entry";
import { challengeError } from "@/lib/memories/challenge-ui";
import type { AccountCloudRuntime } from "@/lib/projects/cloud-runtime";
import { ChallengeDetail } from "./ChallengeDetail";
import { cloudControl } from "./CloudControls";

function EntryContent({ challengeId, runtime }: { challengeId: string; runtime: AccountCloudRuntime }) {
  const router = useRouter();
  const [entry, setEntry] = useState<ChallengeEntryState | null>(null), [busy, setBusy] = useState(true), [error, setError] = useState<string | null>(null), [declining, setDeclining] = useState(false), [now, setNow] = useState(() => Date.now());
  const live = useRef(false), running = useRef(false), controller = useRef<AbortController | null>(null), heading = useRef<HTMLHeadingElement>(null), declineButton = useRef<HTMLButtonElement>(null);
  useAppNavigationGuard(() => {
    if (!busy && !running.current) return true;
    setError("Wait for this to finish, or choose Stop waiting."); return false;
  }, entry?.kind !== "ready");
  useEffect(() => {
    live.current = true; running.current = true;
    const timer = setInterval(() => setNow(Date.now()), 30000);
    const abort = new AbortController(); controller.current = abort;
    void loadChallengeEntry(challengeId, runtime, abort.signal).then(value => {
      if (!abort.signal.aborted) setEntry(value);
    }).catch(failure => { if (!abort.signal.aborted) setError(entryError(failure)); }).finally(() => {
      if (controller.current === abort) running.current = false;
      if (live.current && !abort.signal.aborted) setBusy(false);
    });
    return () => { live.current = false; clearInterval(timer); abort.abort(); controller.current?.abort(); };
  }, [challengeId, runtime]);
  useEffect(() => { if (!busy) { if (declining) declineButton.current?.focus(); else heading.current?.focus(); } }, [busy, declining]);
  const run = async (action?: "accept" | "decline") => {
    if (running.current) return;
    running.current = true; const abort = new AbortController(); controller.current = abort;
    setBusy(true); setError(null);
    try {
      if (action) await runtime.challenges.manage(challengeId, action, abort.signal);
      const next = await loadChallengeEntry(challengeId, runtime, abort.signal);
      runtime.client.assertActive(abort.signal); runtime.challenges.assertActive(abort.signal);
      if (live.current) { setEntry(next); setDeclining(false); }
    } catch (failure) {
      if (live.current && !abort.signal.aborted) { setEntry(null); setDeclining(false); setError(entryError(failure)); }
    } finally { if (controller.current === abort) { running.current = false; if (live.current) setBusy(false); } }
  };
  if (entry?.kind === "ready") return <ChallengeDetail drafts={runtime.drafts} key={entry.view.id} initialView={entry.view} project={entry.project} client={runtime.client} challenges={runtime.challenges} uploads={runtime.uploads} onBack={() => router.push("/projects/cloud")} />;
  const invite = entry?.kind === "invitation" ? entry.view : null, mine = invite?.members.find(person => person.userId === runtime.client.ownerId);
  const canRespond = mine?.status === "invited" && invite?.status === "draft" && Date.parse(invite.expiresAt) > now;
  return <section className="mt-8 border-t border-border py-7" aria-labelledby="challenge-entry-heading">
    <div className="flex flex-wrap items-start justify-between gap-3"><h2 ref={heading} id="challenge-entry-heading" tabIndex={-1} className="font-display text-2xl outline-none">{invite ? "Your challenge invitation" : entry?.kind === "unsupported" ? "This challenge can't be opened" : "Open your challenge"}</h2><button className={cloudControl} disabled={busy} onClick={() => void run()}><RefreshCw size={16} aria-hidden /> Refresh</button></div>
    {busy && <div className="mt-5 flex flex-wrap items-center gap-3"><p role="status" className="flex items-center gap-2 text-sm"><LoaderCircle size={18} aria-hidden className="animate-spin motion-reduce:animate-none" /> Checking your challenge…</p><button className={`${cloudControl} border border-border`} onClick={() => { controller.current?.abort(); running.current = false; setBusy(false); setEntry(null); setDeclining(false); setError("Stopped waiting. Your response might have gone through, so refresh before answering again."); }}>Stop waiting</button></div>}
    {error && <p role="alert" className="mt-5 max-w-2xl rounded-xl bg-muted p-4 leading-relaxed">{error}</p>}
    {entry?.kind === "unsupported" && <p className="mt-4 max-w-xl leading-relaxed text-foreground/70">This challenge uses a layout this version of the app can&apos;t show.</p>}
    {invite && <>
      <p className="mt-4 max-w-2xl leading-relaxed">{invite.policy === "all_submitted" ? "Photos stay hidden until everyone has added theirs." : "Photos show up for everyone as soon as they're added."}</p>
      <p className="mt-3 max-w-2xl text-sm leading-relaxed text-foreground/70">Accepting also adds you to the shared project. Nothing is uploaded yet.</p>
      <p className="mt-3 text-sm text-foreground/70">Deadline: {new Date(invite.expiresAt).toLocaleString("en-AU")} ({Intl.DateTimeFormat().resolvedOptions().timeZone}).</p>
      <ul className="mt-5 max-w-2xl divide-y divide-border" aria-label="People in this challenge">{invite.members.map(person => <li key={person.userId} className="py-3"><p className="text-sm font-medium">Role {person.role}{person.userId === runtime.client.ownerId ? " · You" : ""} · {new Set(invite.assignments.filter(item => item.userId === person.userId).map(item => item.sourceIndex)).size} photos</p><p className="mt-1 break-all text-sm text-foreground/70">{person.userId}</p></li>)}</ul>
      <figure className="mt-6 w-full max-w-56"><div className="relative overflow-hidden bg-muted" style={{ aspectRatio: `${invite.design.canvas.width}/${invite.design.canvas.height}` }}>{invite.design.slots.map(slot => <div key={slot.id} className="absolute flex items-center justify-center border border-border bg-accent/20 text-xs font-semibold" style={{ left: `${slot.x * 100}%`, top: `${slot.y * 100}%`, width: `${slot.width * 100}%`, height: `${slot.height * 100}%` }}>{[slot.role, ...(slot.companions ?? []).map(person => person.role)].join(" + ")} · {slot.sourceIndex + 1}</div>)}</div><figcaption className="mt-2 text-sm text-foreground/70">Letters are people. Numbers are photos.</figcaption></figure>
      {canRespond ? <div className="mt-6 flex flex-wrap gap-3"><button className={`${cloudControl} bg-accent text-accent-foreground`} disabled={busy || declining} onClick={() => void run("accept")}>Accept</button><button className={`${cloudControl} border border-border`} disabled={busy || declining} onClick={() => setDeclining(true)}>Decline…</button></div> : <p className="mt-6 text-sm leading-relaxed">{mine?.status === "declined" ? "You declined this challenge." : "This invitation has closed."}</p>}
      {declining && <div className="mt-5 max-w-xl rounded-xl bg-muted p-5"><h3 className="font-semibold">Decline this challenge?</h3><p className="mt-2 text-sm leading-relaxed">You can&apos;t change this later.</p><div className="mt-4 flex flex-wrap gap-3"><button ref={declineButton} className={`${cloudControl} border border-border`} disabled={busy} onClick={() => void run("decline")}>Decline</button><button className={cloudControl} disabled={busy} onClick={() => setDeclining(false)}>Cancel</button></div></div>}
    </>}
  </section>;
}
function entryError(error: unknown) {
  const code = error && typeof error === "object" && "code" in error ? error.code : null;
  return code === "unavailable" ? "Photo challenges aren't available right now. If you just responded, refresh before trying again." : challengeError(error);
}
function AccountChallengeEntry({ ownerId, challengeId }: { ownerId: string; challengeId: string }) {
  const { runtime, error } = useCloudRuntime(ownerId);
  if (error) return <p role="alert" className="mt-8 max-w-xl rounded-xl bg-muted p-4 leading-relaxed">Couldn&apos;t open your account on this device. Refresh the page to try again.</p>;
  if (!runtime) return <p role="status" className="mt-8 flex items-center gap-2"><LoaderCircle size={18} aria-hidden className="animate-spin motion-reduce:animate-none" /> Opening your account…</p>;
  return <EntryContent key={challengeId} challengeId={challengeId} runtime={runtime} />;
}
export function ChallengeEntry({ challengeId, available }: { challengeId: string; available: boolean }) {
  const { user, enabled, loading } = useAuth();
  return <main className="mx-auto min-h-dvh w-full max-w-5xl px-5 py-6 sm:px-8 sm:py-8">
    <nav aria-label="Challenge navigation"><Link href="/projects/cloud" className={`${cloudControl} -ml-4 hover:bg-muted`}><ArrowLeft size={17} aria-hidden /> Cloud projects</Link></nav>
    <header className="mt-8"><h1 className="font-display text-4xl font-semibold sm:text-5xl">Your photo challenge</h1><p className="mt-3 max-w-xl leading-relaxed text-foreground/70">Make a strip together, one photo at a time.</p></header>
    {!available || !enabled ? <section className="mt-8 border-t border-border py-8"><h2 className="font-display text-2xl">Photo challenges aren&apos;t available here</h2><p className="mt-3 max-w-xl leading-relaxed text-foreground/70">Keep this link and try again later.</p><Link href="/projects" className={`${cloudControl} mt-5 border border-border`}>Open my projects</Link></section> : loading ? <p role="status" className="mt-8 flex items-center gap-2"><LoaderCircle size={18} aria-hidden className="animate-spin motion-reduce:animate-none" /> Checking your account…</p> : user ? <AccountChallengeEntry key={`${user.id}:${challengeId}`} ownerId={user.id} challengeId={challengeId} /> : <section className="mt-8 border-t border-border py-8"><LockKeyhole size={26} aria-hidden className="text-foreground/60" /><h2 className="mt-4 font-display text-2xl">Sign in to see this challenge</h2><p className="mt-3 max-w-xl leading-relaxed text-foreground/70">Use the account that was invited.</p><Link href={challengeSignInPath(challengeId)} className={`${cloudControl} mt-5 bg-accent text-accent-foreground`}>Sign in</Link></section>}
  </main>;
}
