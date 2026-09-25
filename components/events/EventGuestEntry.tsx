"use client";
import { useAppNavigationGuard } from "@/components/AppNavigation";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { cloudControl } from "@/components/cloud/CloudControls";
import { createEventGuestRuntime, eventGuestEntryReady, eventGuestError, takeEventFragment, type EventGuestRuntime, type EventGuestRuntimeOptions, type EventGuestSession } from "@/lib/events/guest-runtime";
import { clearEventGuestJournal } from "@/lib/events/guest-journal";
import { EventGuestWorkspace, type EventGuestCameraFixture } from "./EventGuestWorkspace";

export type EventGuestEntryOptions = Omit<EventGuestRuntimeOptions, "appOrigin" | "eventId"> & { appOrigin?: string; initialInvite?: string };
export function EventGuestEntry({ eventId, available, options, fixture = false, fixturePhoto, fixtureCamera }: { eventId: string; available: boolean; options?: EventGuestEntryOptions; fixture?: boolean; fixturePhoto?(): Promise<Blob>; fixtureCamera?: EventGuestCameraFixture }) {
  const [status, setStatus] = useState<"loading" | "ready" | "unavailable" | "finished">("loading"), [existing, setExisting] = useState<Awaited<ReturnType<EventGuestRuntime["inspect"]>>["existing"]>(null), [session, setSession] = useState<EventGuestSession | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [hasInvite, setHasInvite] = useState(false), [attempt, setAttempt] = useState(0), [agreed, setAgreed] = useState(false);
  const captured = useRef<{ token: string | null } | null>(null), nonce = useRef<string | null>(null), runtime = useRef<EventGuestRuntime | null>(null), active = useRef(false), controller = useRef<AbortController | null>(null), running = useRef(false);
  useEffect(() => {
    if (!captured.current) captured.current = options?.initialInvite ? { token: options.initialInvite } : takeEventFragment("invite", location, path => history.replaceState(history.state, "", path));
    const invite = captured.current.token; active.current = true; const abort = new AbortController(); controller.current = abort;
    void Promise.resolve().then(async () => { if (abort.signal.aborted) return; setHasInvite(!!invite); if (!available) { setStatus("unavailable"); return; } const handle = createEventGuestRuntime({ ...options, eventId, appOrigin: options?.appOrigin ?? location.origin, storageOrigin: options?.storageOrigin ?? process.env.NEXT_PUBLIC_SUPABASE_URL }); runtime.current = handle; const result = await handle.inspect(abort.signal); if (abort.signal.aborted) return; if (!eventGuestEntryReady(result.capabilities, !!result.existing)) { setStatus("unavailable"); return; } setExisting(result.existing); setStatus("ready"); }).catch(e => { if (!abort.signal.aborted) { setError(eventGuestError(e)); setStatus("unavailable"); } });
    return () => { active.current = false; abort.abort(); controller.current?.abort(); runtime.current?.close(); runtime.current = null; };
  }, [eventId, available, options, attempt]);
  useAppNavigationGuard(() => { if (!busy) return true; setError("Wait for joining to finish before leaving."); return false; });
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
  const invalidated = useCallback(() => { controller.current?.abort(); runtime.current?.close(); runtime.current = null; captured.current = { token: null }; nonce.current = null; setSession(null); setExisting(null); setHasInvite(false); setAgreed(false); setError("This guest access changed or is no longer available. The previous private photos and links have been hidden. Check the current session before continuing."); setStatus("loading"); setAttempt(value => value + 1); }, []);
  const finish = async () => { if (!session) return; await clearEventGuestJournal(eventId, session.journal.guestId, { databaseName: options?.databaseName, indexedDB: options?.indexedDB }); runtime.current?.close(); captured.current = { token: null }; nonce.current = null; setSession(null); setExisting(null); setStatus("finished"); };
  return <main className="mx-auto min-h-dvh max-w-5xl px-5 py-6 sm:px-8 sm:py-8">
    {session ? <EventGuestWorkspace key={`${session.client.eventId}:${session.journal.guestId}`} session={session} onFinish={finish} onInvalid={invalidated} fixture={fixture} fixturePhoto={fixturePhoto} fixtureCamera={fixtureCamera} /> : <section className="mt-8 max-w-xl"><h1 className="font-display text-4xl font-semibold sm:text-5xl">A photo for the occasion</h1><p className="mt-4 leading-relaxed text-foreground/75">No account needed. Review your photo and sharing choices before uploading.</p>
      {error && <p role="alert" className="mt-5 rounded-xl bg-muted p-4 text-sm leading-relaxed">{error}</p>}
      {status === "loading" && <p role="status" className="mt-7">Checking this event connection…</p>}
      {status === "unavailable" && <div className="mt-7 border-t border-border pt-6"><h2 className="font-display text-2xl">Event contributions are unavailable here</h2><p className="mt-3 text-sm leading-relaxed">Your invitation has not been submitted by this page. You can still use the solo photobooth.</p><div className="mt-4 flex flex-wrap gap-2"><button className={`${cloudControl} border border-border`} disabled={busy || !available} onClick={() => { setError(null); setStatus("loading"); setAttempt(value => value + 1); }}>Check again</button><Link href="/booth" className={`${cloudControl} bg-accent text-accent-foreground`}>Open solo photobooth</Link></div></div>}
      {status === "ready" && (existing ? <div className="mt-7 border-t border-border pt-6"><h2 className="font-display text-2xl">Continue your guest session</h2><p className="mt-3 text-sm leading-relaxed">You have already joined this event. Continue to your photos.</p><button className={`${cloudControl} mt-5 bg-accent text-accent-foreground`} disabled={busy} onClick={() => void enter(true)}>{busy ? "Opening…" : "Continue this guest session"}</button></div> : hasInvite ? <form className="mt-7 space-y-5 border-t border-border pt-6" onSubmit={event => { event.preventDefault(); void enter(false); }}><p className="text-sm leading-relaxed">Joining saves your private access in this browser. The camera starts only when you choose it.</p><label className="flex min-h-11 cursor-pointer items-start gap-3 text-sm leading-relaxed"><input type="checkbox" className="mt-1 size-5 shrink-0 accent-accent" checked={agreed} disabled={busy} onChange={event => setAgreed(event.target.checked)} /><span>I want to join this event on this browser.</span></label><button className={`${cloudControl} bg-accent text-accent-foreground`} disabled={busy || !agreed}>{busy ? "Joining…" : "Join the event"}</button></form> : <p className="mt-7 text-sm leading-relaxed">Open the host&apos;s private invitation link to join. No invitation token was found in this page.</p>)}
      {status === "finished" && <div className="mt-7 border-t border-border pt-6"><h2 className="font-display text-2xl">Local guest data cleared</h2><p className="mt-3 text-sm leading-relaxed">This page no longer holds your photo queue or private receipt links. Event submissions and the browser&apos;s event cookie are unchanged. This is not a shared-device kiosk reset.</p><Link href="/" className={`${cloudControl} mt-5 border border-border`}>Back to photobooth</Link></div>}
    </section>}
  </main>;
}
