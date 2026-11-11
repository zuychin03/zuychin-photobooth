"use client";
import { useAppNavigationGuard } from "@/components/AppNavigation";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { BookHeart, Check, Copy, Download, Hourglass, ImageOff, Lock, Receipt, RefreshCw, Undo2 } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { EventGlyph } from "./EventHostControls";
import { createEventGuestClient, type EventGuestClient } from "@/lib/events/client";
import { eventGuestError, takeEventFragment } from "@/lib/events/guest-runtime";
import type { EventReceipt } from "@/lib/events/contract";
import { downloadProjectBlob } from "@/lib/projects/download";
import { EventGuestbookPanel } from "./EventGuestbookPanel";
import type { EventGuestEntryOptions } from "./EventGuestEntry";

export function EventGuestReceipt({ submissionId, available, options, initialEventId, initialToken }: { submissionId: string; available: boolean; options?: EventGuestEntryOptions; initialEventId?: string; initialToken?: string }) {
  const [receipt, setReceipt] = useState<EventReceipt | null>(null), [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false), [ready, setReady] = useState(false), [notice, setNotice] = useState<string | null>(null), [eventScope, setEventScope] = useState<string | null>(null), [hasToken, setHasToken] = useState(false);
  const [guestbookClient, setGuestbookClient] = useState<EventGuestClient | null>(null);
  const [guestbookAvailable, setGuestbookAvailable] = useState(false), [guestbookOpen, setGuestbookOpen] = useState(false);
  const guestbookInvoker = useRef<HTMLElement | null>(null);
  const captured = useRef<{ token: string | null; eventId: string | null } | null>(null), client = useRef<EventGuestClient | null>(null), live = useRef(false), controller = useRef<AbortController | null>(null), running = useRef(false);
  useEffect(() => {
    if (!captured.current) captured.current = initialEventId ? { eventId: initialEventId, token: initialToken ?? null } : takeEventFragment("receipt", location, path => history.replaceState(history.state, "", path));
    live.current = true; const abort = new AbortController(); controller.current = abort; const hidden = () => { if (document.hidden) controller.current?.abort(); }; document.addEventListener("visibilitychange", hidden);
    void Promise.resolve().then(async () => { if (abort.signal.aborted) return; setEventScope(captured.current?.eventId ?? null); setHasToken(!!captured.current?.token); if (!available || !captured.current?.eventId) { setError(!available ? "Event receipts aren't available here." : "This receipt link is incomplete. Open the full link again."); return; } const handle = createEventGuestClient({ ...options, appOrigin: options?.appOrigin ?? location.origin, eventId: captured.current.eventId, storageOrigin: options?.storageOrigin ?? process.env.NEXT_PUBLIC_SUPABASE_URL, identity: () => null }); client.current = handle; const caps = await handle.capabilities(abort.signal); if (!abort.signal.aborted) { setReady(true); setGuestbookAvailable(caps.guestbookVersion === 1); } }).catch(e => { if (!abort.signal.aborted) setError(eventGuestError(e)); });
    return () => { document.removeEventListener("visibilitychange", hidden); live.current = false; abort.abort(); controller.current?.abort(); client.current?.close(); client.current = null; };
  }, [available, initialEventId, initialToken, options]);
  const run = async (job: (c: EventGuestClient, signal: AbortSignal) => Promise<void>) => { if (running.current || !client.current) return; running.current = true; setBusy(true); setError(null); setNotice(null); const abort = new AbortController(); controller.current = abort; try { await job(client.current, abort.signal); } catch (e) { if (!abort.signal.aborted && live.current) { setReceipt(null); setError(eventGuestError(e)); } } finally { running.current = false; if (live.current) setBusy(false); } };
  useAppNavigationGuard(() => { if (!busy) return true; setNotice("Wait for this to finish before you leave."); return false; });
  const open = () => run(async (c, signal) => { const value = captured.current?.token ? await c.exchangeReceipt(submissionId, captured.current.token, signal) : await c.readReceipt(submissionId, signal); if (live.current) setReceipt(value); });
  const done = receipt?.state === "ready", gone = receipt && ["failed", "expired", "deleted"].includes(receipt.state);
  return <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-1 flex-col gap-6 px-4 pt-4 pb-10 sm:px-8 sm:pt-6"><div inert={guestbookOpen} className="flex flex-col gap-6"><PageHeader title="Your event photo" meta={<span className="flex items-center gap-2"><Lock size={15} className="shrink-0" aria-hidden />Only share this link with people you trust.</span>} />
    <div className="page-body flex flex-col gap-5">
    {error && <p role="alert" className="notice border border-destructive/25 bg-destructive/8">{error}</p>}{notice && <p role="status" className="notice">{notice}</p>}
    {!receipt && <section className="panel flex flex-col items-start gap-4 p-5 sm:p-7"><EventGlyph icon={Receipt} tone="green" /><p className="text-sm">This browser can only keep one receipt open. Save any other receipt links first.</p><button className="btn btn-primary" disabled={!ready || busy} onClick={() => void open()}>{busy ? "Checking…" : "Open receipt"}</button></section>}
    {receipt && <section className="panel p-5 sm:p-7"><div className="flex items-center gap-3"><EventGlyph icon={done ? Check : gone ? ImageOff : Hourglass} tone={done ? "green" : gone ? "slate" : "amber"} /><h2 className="font-display text-2xl leading-tight">{receipt.state === "ready" ? "Your photo is ready" : receipt.state === "failed" ? "Couldn't check your photo" : receipt.state === "expired" ? "This photo has expired" : receipt.state === "deleted" ? "This photo was removed" : receipt.state === "reserved" ? "Waiting for upload" : receipt.state === "uploading" ? "Upload not finished" : "Checking your photo"}</h2></div><p className="mt-3 text-sm">{receipt.state === "ready" ? "Download a copy before it expires." : ["reserved", "uploading"].includes(receipt.state) ? "Go back to the browser you used at the event to try again." : receipt.state === "finalising" ? "Refresh to check again." : "This photo can't be recovered from here."}</p>
      <dl className="panel-muted mt-4 grid gap-x-6 gap-y-3 p-4 text-sm sm:grid-cols-2">{([["Upload by", new Date(receipt.logicalExpiresAt).toLocaleString("en-AU")], ["Available until", new Date(receipt.eventExpiresAt).toLocaleString("en-AU")], ["Gallery", receipt.gallery.replaceAll("_", " ")], ["Wall", receipt.wall.replaceAll("_", " ")]] as const).map(([term, value]) => <div key={term}><dt className="text-xs font-bold text-muted-foreground">{term}</dt><dd className="mt-0.5 font-bold">{value}</dd></div>)}</dl>
      <div className="mt-5 flex flex-wrap gap-2">{receipt.state === "ready" && <button className="btn btn-primary" disabled={busy} onClick={() => void run(async (c, signal) => { const result = await c.download(submissionId, signal); c.assertActive(signal); if (live.current) downloadProjectBlob(result.blob, "my-event-photo.jpg"); })}><Download size={17} aria-hidden /> Download photo</button>}<button className="btn btn-quiet" disabled={busy} onClick={() => void open()}><RefreshCw size={16} aria-hidden /> Refresh</button>{eventScope && <Link href={`/events/${eventScope}/join`} className="btn btn-plain">Back to the event</Link>}</div></section>}
    {(guestbookAvailable && receipt && !["deleted", "expired", "failed"].includes(receipt.state) || ready && hasToken) && <div className="flex flex-wrap gap-2">
    {guestbookAvailable && receipt && !["deleted", "expired", "failed"].includes(receipt.state) && <button className="btn btn-quiet min-h-10 text-sm" disabled={busy} onClick={() => { guestbookInvoker.current = document.activeElement as HTMLElement; setGuestbookClient(client.current); setGuestbookOpen(true); }}><BookHeart size={15} aria-hidden /> View guestbook message</button>}
    {ready && hasToken && <button className="btn btn-quiet min-h-10 text-sm" disabled={busy} onClick={() => { const link = `${location.origin}/receipt/${submissionId}?event=${captured.current!.eventId}#token=${captured.current!.token}`; void navigator.clipboard.writeText(link).then(() => { if (live.current) setNotice("Receipt link copied."); }, () => { if (live.current) setError("Couldn't copy the link. Keep the link you opened."); }); }}><Copy size={15} aria-hidden /> Copy receipt link</button>}
    </div>}
    <p className="flex items-start gap-2 text-sm text-muted-foreground"><Undo2 size={15} className="mt-0.5 shrink-0" aria-hidden />To withdraw the photo, use the browser you sent it from.</p>
    </div>
    </div>{guestbookOpen && guestbookClient && <EventGuestbookPanel client={guestbookClient} submissionId={submissionId} receiptOnly onClose={() => { setGuestbookOpen(false); requestAnimationFrame(() => guestbookInvoker.current?.focus()); }} onInvalid={e => { const code = e && typeof e === "object" && "code" in e ? e.code : null; if (code !== "access_denied" && code !== "identity_changed") return false; setGuestbookOpen(false); setReceipt(null); setError(eventGuestError(e)); return true; }} />}
  </main>;
}
