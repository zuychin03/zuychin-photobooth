"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createEventAudienceRuntime, type EventAudienceRuntime } from "@/lib/events/audience-runtime";
import { eventAudienceError, takeEventAudienceFragment } from "@/lib/events/audience-fragment";
import type { EventAudienceClientOptions } from "@/lib/events/audience-client";
import type { EventAudienceSession, EventDestination } from "@/lib/events/publication-contract";
import { EventAudienceWorkspace } from "./EventAudienceWorkspace";
import { Eye, Images, LoaderCircle, Presentation, Unlink } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { EventGlyph } from "./EventHostControls";

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
  const icon = destination === "wall" ? Presentation : Images;
  return <main className="mx-auto flex min-h-dvh w-full max-w-3xl flex-1 flex-col gap-6 px-4 pt-4 pb-10 sm:px-8 sm:pt-6"><PageHeader title={destination === "gallery" ? "The event gallery" : "The event wall"} meta={<span className="flex items-center gap-2"><Eye size={15} className="shrink-0" aria-hidden />This link is for viewing only.</span>} />
    <div className="page-body flex max-w-xl flex-col gap-5">
    {error && <p role="alert" className="notice border border-destructive/25 bg-destructive/8">{error}</p>}
    {status === "checking" && <p role="status" className="panel flex min-h-40 items-center justify-center gap-2 text-sm text-muted-foreground"><LoaderCircle size={18} className="animate-spin motion-reduce:animate-none" aria-hidden /> Checking your link…</p>}
    {status === "unavailable" && <section className="panel flex flex-col items-start gap-3 p-5 sm:p-7"><EventGlyph icon={Unlink} tone="slate" /><h2 className="font-display text-2xl">Can&apos;t open this link</h2><p className="text-sm text-muted-foreground">Check your connection and try again, or ask the host.</p><button className="btn btn-quiet mt-1" disabled={!available || busy} onClick={() => { setStatus("checking"); setError(null); setAttempt(value => value + 1); }}>Try again</button></section>}
    {status === "ready" && <section className="panel flex flex-col items-start gap-4 p-5 sm:p-7"><EventGlyph icon={icon} tone="green" />{existing && <div className="flex flex-col items-start gap-3"><p className="text-sm">This browser already has {destination === "wall" ? "wall" : "gallery"} access to <strong>{existing.eventTitle}</strong>.</p><button className={`btn ${hasToken ? "btn-quiet" : "btn-primary"}`} disabled={busy} onClick={() => void enter(false)}>{busy ? "Opening…" : "Continue"}</button></div>}{hasToken && <div className="flex flex-col items-start gap-3"><p className="text-sm">This browser will remember the link. Anyone you forward it to can see the photos too.</p><button className="btn btn-primary" disabled={busy} onClick={() => void enter(true)}>{busy ? "Opening…" : existing ? "Use this new link" : "View photos"}</button></div>}{!existing && !hasToken && <p className="text-sm">Open the {destination === "wall" ? "wall" : "gallery"} link from the host to view photos.</p>}</section>}
    </div>
  </main>;
}
