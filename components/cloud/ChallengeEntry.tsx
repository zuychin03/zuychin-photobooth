"use client";
import { useAppNavigationGuard } from "@/components/AppNavigation";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Clock, CloudOff, LoaderCircle, LockKeyhole, Mail, RefreshCw } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Section } from "@/components/ui/Section";
import { useAuth } from "@/lib/auth";
import { useCloudRuntime } from "@/hooks/useCloudRuntime";
import { challengeSignInPath, loadChallengeEntry, type ChallengeEntryState } from "@/lib/memories/challenge-entry";
import { challengeError } from "@/lib/memories/challenge-ui";
import type { AccountCloudRuntime } from "@/lib/projects/cloud-runtime";
import { ChallengeDetail } from "./ChallengeDetail";

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
  return <section className="panel p-4 sm:p-6" aria-labelledby="challenge-entry-heading">
    <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex min-w-0 items-center gap-3"><span className="glyph bg-[#8b5cf6]"><Mail size={18} strokeWidth={2.25} aria-hidden /></span><h2 ref={heading} id="challenge-entry-heading" tabIndex={-1} className="font-display text-xl leading-tight outline-none">{invite ? "Your challenge invitation" : entry?.kind === "unsupported" ? "This challenge can't be opened" : "Open your challenge"}</h2></div><button className="btn btn-quiet min-h-10 text-sm" disabled={busy} onClick={() => void run()}><RefreshCw size={15} aria-hidden /> Refresh</button></div>
    {busy && <div className="mt-4 flex flex-wrap items-center gap-3"><p role="status" className="flex items-center gap-2 text-sm font-bold"><LoaderCircle size={18} aria-hidden className="animate-spin motion-reduce:animate-none" /> Checking your challenge…</p><button className="btn btn-quiet min-h-10 text-sm" onClick={() => { controller.current?.abort(); running.current = false; setBusy(false); setEntry(null); setDeclining(false); setError("Stopped waiting. Your response might have gone through, so refresh before answering again."); }}>Stop waiting</button></div>}
    {error && <p role="alert" className="notice mt-4 max-w-2xl border border-destructive/25 bg-destructive/8">{error}</p>}
    {entry?.kind === "unsupported" && <p className="mt-3 max-w-xl text-muted-foreground">This challenge uses a layout this version of the app can&apos;t show.</p>}
    {invite && <div className="mt-5 grid items-start gap-6 md:grid-cols-[minmax(0,1fr)_13rem]">
      <div className="min-w-0">
        <p className="max-w-2xl font-bold">{invite.policy === "all_submitted" ? "Photos stay hidden until everyone has added theirs." : "Photos show up for everyone as soon as they're added."}</p>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">Accepting also adds you to the shared project. Nothing is uploaded yet.</p>
        <p className="mt-3 flex items-start gap-2 text-sm text-muted-foreground"><Clock size={15} aria-hidden className="mt-0.5 shrink-0" />Deadline: {new Date(invite.expiresAt).toLocaleString("en-AU")} ({Intl.DateTimeFormat().resolvedOptions().timeZone}).</p>
        <ul className="mt-4 max-w-2xl divide-y divide-border border-y border-border" aria-label="People in this challenge">{invite.members.map(person => <li key={person.userId} className="py-3"><p className="text-sm font-bold">Role {person.role}{person.userId === runtime.client.ownerId ? " · You" : ""} · {new Set(invite.assignments.filter(item => item.userId === person.userId).map(item => item.sourceIndex)).size} photos</p><p className="mt-1 break-all font-mono text-xs text-muted-foreground">{person.userId}</p></li>)}</ul>
      </div>
      <figure className="w-full max-w-52 justify-self-center md:max-w-none"><div className="relative overflow-hidden rounded-xl bg-muted" style={{ aspectRatio: `${invite.design.canvas.width}/${invite.design.canvas.height}` }}>{invite.design.slots.map(slot => <div key={slot.id} className="absolute flex items-center justify-center border border-border bg-accent/20 text-xs font-bold" style={{ left: `${slot.x * 100}%`, top: `${slot.y * 100}%`, width: `${slot.width * 100}%`, height: `${slot.height * 100}%` }}>{[slot.role, ...(slot.companions ?? []).map(person => person.role)].join(" + ")} · {slot.sourceIndex + 1}</div>)}</div><figcaption className="mt-2 text-center text-xs text-muted-foreground">Letters are people. Numbers are photos.</figcaption></figure>
      <div className="md:col-span-2">
        {canRespond ? <div className="flex flex-wrap gap-2"><button className="btn btn-primary" disabled={busy || declining} onClick={() => void run("accept")}>Accept</button><button className="btn btn-quiet" disabled={busy || declining} onClick={() => setDeclining(true)}>Decline…</button></div> : <p className="text-sm font-bold">{mine?.status === "declined" ? "You declined this challenge." : "This invitation has closed."}</p>}
        {declining && <div className="notice mt-4 max-w-xl p-5"><h3 className="font-bold">Decline this challenge?</h3><p className="mt-1">You can&apos;t change this later.</p><div className="mt-4 flex flex-wrap gap-2"><button ref={declineButton} className="btn btn-danger min-h-10 text-sm" disabled={busy} onClick={() => void run("decline")}>Decline</button><button className="btn btn-plain min-h-10 text-sm" disabled={busy} onClick={() => setDeclining(false)}>Cancel</button></div></div>}
      </div>
    </div>}
  </section>;
}
function entryError(error: unknown) {
  const code = error && typeof error === "object" && "code" in error ? error.code : null;
  return code === "unavailable" ? "Photo challenges aren't available right now. If you just responded, refresh before trying again." : challengeError(error);
}
function AccountChallengeEntry({ ownerId, challengeId }: { ownerId: string; challengeId: string }) {
  const { runtime, error } = useCloudRuntime(ownerId);
  if (error) return <p role="alert" className="notice max-w-xl border border-destructive/25 bg-destructive/8">Couldn&apos;t open your account on this device. Refresh the page to try again.</p>;
  if (!runtime) return <p role="status" className="panel flex min-h-40 items-center justify-center gap-2 text-sm text-muted-foreground"><LoaderCircle size={18} aria-hidden className="animate-spin motion-reduce:animate-none" /> Opening your account…</p>;
  return <EntryContent key={challengeId} challengeId={challengeId} runtime={runtime} />;
}
export function ChallengeEntry({ challengeId, available }: { challengeId: string; available: boolean }) {
  const { user, enabled, loading } = useAuth();
  return <main className="mx-auto flex min-h-dvh w-full max-w-5xl flex-1 flex-col gap-6 px-4 pt-4 pb-10 sm:px-8 sm:pt-6">
    <PageHeader title="Your photo challenge" leading={<nav aria-label="Challenge navigation"><Link href="/projects/cloud" className="btn btn-plain -ml-3.5 text-sm"><ArrowLeft size={17} aria-hidden /> Cloud projects</Link></nav>} />
    <div className="page-body flex flex-col gap-5">
      {!available || !enabled ? <Section id="challenge-unavailable-title" title="Photo challenges aren't available here" icon={CloudOff} tone="slate" bodyClassName="mt-3"><p className="text-muted-foreground">Keep this link and try again later.</p><Link href="/projects" className="btn btn-quiet mt-4">Open my projects</Link></Section> : loading ? <p role="status" className="panel flex min-h-40 items-center justify-center gap-2 text-sm text-muted-foreground"><LoaderCircle size={18} aria-hidden className="animate-spin motion-reduce:animate-none" /> Checking your account…</p> : user ? <AccountChallengeEntry key={`${user.id}:${challengeId}`} ownerId={user.id} challengeId={challengeId} /> : <Section id="challenge-sign-in-title" title="Sign in to see this challenge" icon={LockKeyhole} tone="violet" bodyClassName="mt-3"><p className="text-muted-foreground">Use the account that was invited.</p><Link href={challengeSignInPath(challengeId)} className="btn btn-primary mt-4">Sign in</Link></Section>}
    </div>
  </main>;
}
