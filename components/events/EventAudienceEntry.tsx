"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createEventAudienceRuntime, type EventAudienceRuntime } from "@/lib/events/audience-runtime";
import { eventAudienceError, takeEventAudienceFragment } from "@/lib/events/audience-fragment";
import type { EventAudienceClientOptions } from "@/lib/events/audience-client";
import type { EventAudienceSession, EventDestination } from "@/lib/events/publication-contract";
import { EventAudienceWorkspace } from "./EventAudienceWorkspace";
import { eventControl } from "./EventHostControls";

export type EventAudienceEntryOptions = Omit<EventAudienceClientOptions, "eventId" | "destination" | "appOrigin" | "storageOrigin"> & { appOrigin?: string; storageOrigin?: string; initialToken?: string };
export function EventAudienceEntry({ eventId, destination, available, options }: { eventId: string; destination: EventDestination; available: boolean; options?: EventAudienceEntryOptions }) {
  const [status, setStatus] = useState<"checking" | "ready" | "unavailable">("checking"), [existing, setExisting] = useState<EventAudienceSession | null>(null), [opened, setOpened] = useState<Awaited<ReturnType<EventAudienceRuntime["resume"]>> | null>(null), [hasToken, setHasToken] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [attempt, setAttempt] = useState(0);
  const captured = useRef<{ token: string | null } | null>(null), runtime = useRef<EventAudienceRuntime | null>(null), alive = useRef(false), active = useRef<AbortController | null>(null), running = useRef(false);
  useLayoutEffect(() => { if (!captured.current) { const token = takeEventAudienceFragment(location, path => history.replaceState(history.state, "", path)); captured.current = { token: options?.initialToken ?? token }; setHasToken(Boolean(captured.current.token)); } }, [options]);
  useEffect(() => {
    alive.current = true; const abort = new AbortController(); active.current = abort;
    void Promise.resolve().then(async () => { if (abort.signal.aborted) return; if (!available) { setStatus("unavailable"); return; } const handle = createEventAudienceRuntime({ ...options, appOrigin: options?.appOrigin ?? location.origin, storageOrigin: options?.storageOrigin ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", eventId, destination }); runtime.current = handle; const session = await handle.inspect(abort.signal); if (abort.signal.aborted) return; setExisting(session); setStatus("ready"); }).catch(failure => { if (!abort.signal.aborted) { setError(eventAudienceError(failure)); setStatus("unavailable"); } });
    return () => { alive.current = false; abort.abort(); active.current?.abort(); runtime.current?.close(); runtime.current = null; };
  }, [available, destination, eventId, options, attempt]);
  const enter = async (useLink: boolean) => {
    if (running.current || !runtime.current) return; running.current = true; setBusy(true); setError(null); const abort = new AbortController(); active.current = abort;
    try { const result = useLink && captured.current?.token ? await runtime.current.exchange(captured.current.token, abort.signal) : existing ? await runtime.current.resume(existing, abort.signal) : null; if (!result || abort.signal.aborted || !alive.current) return; captured.current = { token: null }; setHasToken(false); setOpened(result); }
    catch (failure) { if (alive.current && !abort.signal.aborted) setError(eventAudienceError(failure)); }
    finally { running.current = false; if (alive.current) setBusy(false); }
  };
  if (opened) return <EventAudienceWorkspace client={opened.client} session={opened.session} onExit={() => { active.current?.abort(); runtime.current?.close(); setOpened(null); setExisting(null); setStatus("checking"); setAttempt(value => value + 1); }} />;
  return <main className="mx-auto min-h-dvh max-w-3xl px-5 py-7 sm:px-8 sm:py-10"><section className="max-w-xl py-10"><h1 className="font-display text-4xl font-semibold sm:text-5xl">{destination === "gallery" ? "The event gallery" : "The event wall"}</h1><p className="mt-5 leading-relaxed text-foreground/75">{destination === "gallery" ? "View photos their contributors and host have approved for this gallery." : "Show only photos approved for the event wall, three at a time."} This link is for viewing only.</p>
    {error && <p role="alert" className="mt-6 rounded-xl bg-muted p-4 text-sm leading-relaxed">{error}</p>}
    {status === "checking" && <p role="status" className="mt-7">Checking viewing access…</p>}
    {status === "unavailable" && <div className="mt-7 border-t border-border pt-6"><h2 className="font-display text-2xl">Viewing is unavailable</h2><p className="mt-3 text-sm leading-relaxed">The link has not been exchanged here. Ask the host to check the event, or retry when the connection is ready.</p><button className={`${eventControl} mt-4 border border-border`} disabled={!available || busy} onClick={() => { setStatus("checking"); setError(null); setAttempt(value => value + 1); }}>Check again</button></div>}
    {status === "ready" && <div className="mt-7 space-y-4 border-t border-border pt-6">{existing && <><p className="text-sm leading-relaxed">This browser already has {destination === "wall" ? "wall" : "gallery"} access to {existing.eventTitle}.</p><button className={`${eventControl} border border-border`} disabled={busy} onClick={() => void enter(false)}>{busy ? "Opening…" : "Continue viewing"}</button></>}{hasToken && <><p className="text-sm leading-relaxed">This browser will keep viewing access. Forwarding the link shares that access. Photos hide when permission checks stop.</p><button className={`${eventControl} bg-accent text-accent-foreground`} disabled={busy} onClick={() => void enter(true)}>{busy ? "Opening…" : existing ? "Use this new viewing link" : "Open event photos"}</button></>}{!existing && !hasToken && <p className="text-sm leading-relaxed">Open the host&apos;s {destination === "wall" ? "wall" : "gallery"} link to view photos. No valid viewing token was found.</p>}</div>}
  </section></main>;
}
