"use client";
import { useRecoveryRelease } from "@/components/ReleaseMode";
import { useAppNavigationGuard } from "@/components/AppNavigation";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { cloudControl } from "@/components/cloud/CloudControls";
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
  return <main className="mx-auto min-h-dvh max-w-5xl px-5 py-6 sm:px-8 sm:py-8">
    {session ? <EventGuestWorkspace key={`${session.client.eventId}:${session.journal.guestId}`} session={session} onFinish={finish} onInvalid={invalidated} fixture={fixture} fixturePhoto={fixturePhoto} fixtureCamera={fixtureCamera} /> : <section className="mt-8 max-w-xl"><h1 className="font-display text-4xl font-semibold sm:text-5xl">A photo for the occasion</h1><p className="mt-4 leading-relaxed text-foreground/75">No account needed. You&apos;ll see your photo before anything is uploaded.</p>
      {error && <p role="alert" className="mt-5 rounded-xl bg-muted p-4 text-sm leading-relaxed">{error}</p>}
      {status === "loading" && <p role="status" className="mt-7">Checking the event…</p>}
      {status === "unavailable" && <div className="mt-7 border-t border-border pt-6"><h2 className="font-display text-2xl">This event isn&apos;t taking photos right now</h2><p className="mt-3 text-sm leading-relaxed">You can still use the solo booth.</p><div className="mt-4 flex flex-wrap gap-2"><button className={`${cloudControl} border border-border`} disabled={busy || !available} onClick={() => { setError(null); setStatus("loading"); setAttempt(value => value + 1); }}>Try again</button><Link href="/booth" className={`${cloudControl} bg-accent text-accent-foreground`}>Open solo booth</Link></div></div>}
      {status === "ready" && (existing ? <div className="mt-7 border-t border-border pt-6"><h2 className="font-display text-2xl">Welcome back</h2><p className="mt-3 text-sm leading-relaxed">You&apos;ve already joined this event.</p><button className={`${cloudControl} mt-5 bg-accent text-accent-foreground`} disabled={busy} onClick={() => void enter(true)}>{busy ? "Opening…" : "Continue"}</button></div> : hasInvite ? <form className="mt-7 space-y-5 border-t border-border pt-6" onSubmit={event => { event.preventDefault(); void enter(false); }}><p className="text-sm leading-relaxed">Your access is saved in this browser. The camera only starts when you turn it on.</p><label className="flex min-h-11 cursor-pointer items-start gap-3 text-sm leading-relaxed"><input type="checkbox" className="mt-1 size-5 shrink-0 accent-accent" checked={agreed} disabled={busy} onChange={event => setAgreed(event.target.checked)} /><span>I want to join this event on this browser.</span></label><button className={`${cloudControl} bg-accent text-accent-foreground`} disabled={recovery || busy || !agreed}>{busy ? "Joining…" : "Join the event"}</button></form> : <p className="mt-7 text-sm leading-relaxed">Open the invitation link from your host to join.</p>)}
      {status === "finished" && <div className="mt-7 border-t border-border pt-6"><h2 className="font-display text-2xl">All done on this device</h2><p className="mt-3 text-sm leading-relaxed">Local photos and receipt links were cleared. Photos sent to the event stay there. Event access is still active in this browser.</p><Link href="/" className={`${cloudControl} mt-5 border border-border`}>Back to home</Link></div>}
    </section>}
  </main>;
}
