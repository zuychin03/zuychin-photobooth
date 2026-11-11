"use client";
import { useRecoveryRelease } from "@/components/ReleaseMode";
import { useAppNavigationGuard } from "@/components/AppNavigation";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { CalendarX2, Camera, Check, EyeOff, LoaderCircle, PartyPopper } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { EventGlyph } from "./EventHostControls";
import { createEventGuestRuntime, eventGuestEntryReady, eventGuestError, takeEventFragment, type EventGuestRuntime, type EventGuestRuntimeOptions, type EventGuestSession } from "@/lib/events/guest-runtime";
import { clearEventGuestJournal } from "@/lib/events/guest-journal";
import { EventGuestWorkspace, type EventGuestCameraFixture } from "./EventGuestWorkspace";

export type EventGuestEntryOptions = Omit<EventGuestRuntimeOptions, "appOrigin" | "eventId"> & { appOrigin?: string; initialInvite?: string };
export function EventGuestEntry({ eventId, available, options, fixture = false, fixturePhoto, fixtureCamera }: { eventId: string; available: boolean; options?: EventGuestEntryOptions; fixture?: boolean; fixturePhoto?(): Promise<Blob>; fixtureCamera?: EventGuestCameraFixture }) {
  const recovery = useRecoveryRelease();
  const [status, setStatus] = useState<"loading" | "ready" | "unavailable" | "finished">("loading"), [existing, setExisting] = useState<Awaited<ReturnType<EventGuestRuntime["inspect"]>>["existing"]>(null), [session, setSession] = useState<EventGuestSession | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [hasInvite, setHasInvite] = useState(false), [attempt, setAttempt] = useState(0), [agreed, setAgreed] = useState(false);
  const captured = useRef<{ token: string | null } | null>(null), nonce = useRef<string | null>(null), runtime = useRef<EventGuestRuntime | null>(null), active = useRef(false), controller = useRef<AbortController | null>(null), running = useRef(false);
  useEffect(() => {
    if (!captured.current) captured.current = options?.initialInvite ? { token: options.initialInvite } : takeEventFragment("invite", location, path => history.replaceState(history.state, "", path));
    const invite = captured.current.token; active.current = true; const abort = new AbortController(); controller.current = abort;
    void Promise.resolve().then(async () => { if (abort.signal.aborted) return; setHasInvite(!!invite); if (!available) { setStatus("unavailable"); return; } const handle = createEventGuestRuntime({ ...options, eventId, appOrigin: options?.appOrigin ?? location.origin, storageOrigin: options?.storageOrigin ?? process.env.NEXT_PUBLIC_SUPABASE_URL }); runtime.current = handle; const result = await handle.inspect(abort.signal); if (abort.signal.aborted) return; if (!eventGuestEntryReady(result.capabilities, !!result.existing)) { setStatus("unavailable"); return; } setExisting(result.existing); setStatus("ready"); }).catch(e => { if (!abort.signal.aborted) { setError(eventGuestError(e)); setStatus("unavailable"); } });
    return () => { active.current = false; abort.abort(); controller.current?.abort(); runtime.current?.close(); runtime.current = null; };
  }, [eventId, available, options, attempt]);
  useAppNavigationGuard(() => { if (!busy) return true; setError("Wait until you've joined before leaving."); return false; });
  const enter = async (resume: boolean) => {
    if (running.current || !runtime.current) return; running.current = true; setBusy(true); setError(null); const abort = new AbortController(); controller.current = abort;
    try {
      let next: EventGuestSession;
      if (resume && existing) next = await runtime.current.resume(existing, abort.signal);
      else { if (!captured.current?.token || !agreed) return; nonce.current ??= btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", ""); next = await runtime.current.join(captured.current.token, nonce.current, abort.signal); }
      if (!abort.signal.aborted && active.current) { captured.current = { token: null }; nonce.current = null; setSession(next); }
    } catch (e) { if (!abort.signal.aborted && active.current) setError(eventGuestError(e)); }
    finally { running.current = false; if (active.current) setBusy(false); }
  };
  const invalidated = useCallback(() => { controller.current?.abort(); runtime.current?.close(); runtime.current = null; captured.current = { token: null }; nonce.current = null; setSession(null); setExisting(null); setHasInvite(false); setAgreed(false); setError("Your guest access has changed. Check the event link and try again."); setStatus("loading"); setAttempt(value => value + 1); }, []);
  const finish = async () => { if (!session) return; await clearEventGuestJournal(eventId, session.journal.guestId, { databaseName: options?.databaseName, indexedDB: options?.indexedDB }); runtime.current?.close(); captured.current = { token: null }; nonce.current = null; setSession(null); setExisting(null); setStatus("finished"); };
  const card = "panel flex flex-col items-start gap-3 p-5 sm:p-7";
  return <main className="mx-auto flex min-h-dvh w-full max-w-5xl flex-1 flex-col gap-6 px-4 pt-4 pb-10 sm:px-8 sm:pt-6">
    {session ? <EventGuestWorkspace key={`${session.client.eventId}:${session.journal.guestId}`} session={session} onFinish={finish} onInvalid={invalidated} fixture={fixture} fixturePhoto={fixturePhoto} fixtureCamera={fixtureCamera} /> : <>
      <PageHeader title="A photo for the occasion" meta={<span className="flex items-center gap-2"><EyeOff size={15} className="shrink-0" aria-hidden />You&apos;ll see your photo before anything is uploaded.</span>} />
      <div className="page-body flex max-w-xl flex-col gap-5">
        {error && <p role="alert" className="notice border border-destructive/25 bg-destructive/8">{error}</p>}
        {status === "loading" && <p role="status" className="panel flex min-h-40 items-center justify-center gap-2 text-sm text-muted-foreground"><LoaderCircle size={18} className="animate-spin motion-reduce:animate-none" aria-hidden /> Checking the event…</p>}
        {status === "unavailable" && <section className={card}><EventGlyph icon={CalendarX2} tone="slate" /><h2 className="font-display text-2xl">This event isn&apos;t taking photos right now</h2><div className="mt-2 flex flex-wrap gap-2"><button className="btn btn-quiet" disabled={busy || !available} onClick={() => { setError(null); setStatus("loading"); setAttempt(value => value + 1); }}>Try again</button><Link href="/booth" className="btn btn-primary"><Camera size={17} aria-hidden /> Open solo booth</Link></div></section>}
        {status === "ready" && (existing ? <section className={card}><EventGlyph icon={PartyPopper} tone="violet" /><h2 className="font-display text-2xl">Welcome back</h2><p className="text-sm text-muted-foreground">You&apos;ve already joined this event.</p><button className="btn btn-primary mt-2" disabled={busy} onClick={() => void enter(true)}>{busy ? "Opening…" : "Continue"}</button></section> : hasInvite ? <form className={card} onSubmit={event => { event.preventDefault(); void enter(false); }}><EventGlyph icon={PartyPopper} tone="violet" /><p className="text-sm">Your access is saved in this browser. The camera only starts when you turn it on.</p><label className="panel-muted flex min-h-12 w-full cursor-pointer items-start gap-3 px-4 py-3 text-sm font-bold"><input type="checkbox" className="mt-0.5 size-5 shrink-0 accent-accent" checked={agreed} disabled={busy} onChange={event => setAgreed(event.target.checked)} /><span>I want to join this event on this browser.</span></label><button className="btn btn-partner mt-1" disabled={recovery || busy || !agreed}>{busy ? "Joining…" : "Join the event"}</button></form> : <p className="panel p-5 text-sm sm:p-7">Open the invitation link from your host to join.</p>)}
        {status === "finished" && <section className={card}><EventGlyph icon={Check} tone="green" /><h2 className="font-display text-2xl">All done on this device</h2><p className="text-sm">Local photos and receipt links were cleared. Photos sent to the event stay there. Event access is still active in this browser.</p><Link href="/" className="btn btn-quiet mt-2">Back to home</Link></section>}
      </div>
    </>}
  </main>;
}
