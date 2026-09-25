"use client";
import { HelpTooltip } from "@/components/HelpTooltip";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { EventExportClient } from "@/lib/events/export-client";
import type { EventExportPage, EventExportRetired, EventExportSummary } from "@/lib/events/export-contract";
import { confirmEventExportSaved, prepareEventExportBatch, recheckEventExportBatch, type PreparedEventExportBatch } from "@/lib/events/export-coordinator";
import { EventHostConfirm, eventControl, eventError } from "./EventHostControls";

export function EventExportPanel({ client, eventId, disabled = false, onBusyChange, onDirtyChange }: { client: EventExportClient; eventId: string; disabled?: boolean; onBusyChange?(busy: boolean): void; onDirtyChange?(dirty: boolean): void }) {
  const [snapshots, setSnapshots] = useState<EventExportSummary[]>([]), [retired, setRetired] = useState<EventExportRetired[]>([]), [page, setPage] = useState<EventExportPage | null>(null), [after, setAfter] = useState(-1);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null), [batch, setBatch] = useState<PreparedEventExportBatch | null>(null), [forget, setForget] = useState<EventExportSummary | null>(null);
  const [pending, setPending] = useState<{ exportId: string; generation: number; afterSubmissionId?: string } | null>(null), [discardRetry, setDiscardRetry] = useState(false);
  const [listStatus, setListStatus] = useState<"waiting" | "loading" | "ready" | "failed">("waiting");
  const initialListStarted = useRef(false);
  const active = useRef<AbortController | null>(null), mounted = useRef(false), downloadUrl = useRef<string | null>(null), heading = useRef<HTMLHeadingElement>(null);
  const disabledRef = useRef(disabled), callbacks = useRef({ onBusyChange, onDirtyChange });
  useLayoutEffect(() => { disabledRef.current = disabled; callbacks.current = { onBusyChange, onDirtyChange }; }, [disabled, onBusyChange, onDirtyChange]);
  const clearUrl = useCallback(() => { if (downloadUrl.current) URL.revokeObjectURL(downloadUrl.current); downloadUrl.current = null; }, []);
  const run = useCallback(async (work: (signal: AbortSignal, check: () => void) => Promise<void>) => {
    if (active.current || disabledRef.current) return;
    const controller = new AbortController(); active.current = controller; setBusy(true); setError(null); setNotice(null);
    const check = () => { client.assertActive(controller.signal); if (!mounted.current) throw new Error("Unmounted"); };
    try { await work(controller.signal, check); check(); }
    catch (failure) {
      if (mounted.current) { clearUrl(); setBatch(null); setNotice(null); const code = failure && typeof failure === "object" && "code" in failure ? String(failure.code) : ""; setError(code === "cancelled" ? "Export stopped. Its server progress remains available for an explicit retry." : code === "busy" ? "The previous download is still releasing resources. Wait briefly, then retry." : eventError(failure)); if (["identity_changed", "access_denied", "expired"].includes(code)) { setPage(null); setSnapshots([]); setRetired([]); } }
    } finally { if (active.current === controller) active.current = null; if (mounted.current) setBusy(false); }
  }, [client, clearUrl]);
  const refresh = useCallback(() => run(async (signal, check) => {
    initialListStarted.current = true; setListStatus("loading");
    try { const result = await client.list(eventId, signal); check(); setSnapshots(result.exports); setRetired(result.retired); setListStatus("ready"); }
    catch (failure) { if (mounted.current) setListStatus("failed"); throw failure; }
  }), [client, eventId, run]);
  useEffect(() => { mounted.current = true; initialListStarted.current = false; return () => { mounted.current = false; active.current?.abort(); clearUrl(); callbacks.current.onBusyChange?.(false); callbacks.current.onDirtyChange?.(false); }; }, [refresh, clearUrl]);
  useEffect(() => {
    if (disabled || initialListStarted.current) return;
    const timer = setTimeout(() => { if (!initialListStarted.current) void refresh(); }, 0);
    return () => clearTimeout(timer);
  }, [disabled, refresh]);
  useEffect(() => { callbacks.current.onBusyChange?.(busy); }, [busy]);
  useEffect(() => { callbacks.current.onDirtyChange?.(!!pending || !!batch); }, [pending, batch]);
  useEffect(() => { if (disabled) { active.current?.abort(); clearUrl(); } }, [disabled, clearUrl]);
  useEffect(() => {
    if (!batch) return;
    const until = Math.min(Date.parse(batch.summary.expiresAt), ...batch.included.map(entry => Date.parse(entry.expiresAt)));
    const timer = setTimeout(() => { clearUrl(); setBatch(null); setNotice("This export reached its retention deadline. Check the event again."); }, Math.min(2147483647, Math.max(0, until - Date.now())));
    return () => clearTimeout(timer);
  }, [batch, clearUrl]);
  const open = (snapshot: EventExportSummary, cursor = -1) => void run(async (signal, check) => { clearUrl(); setBatch(null); const result = await client.page(eventId, snapshot.exportId, snapshot.generation, cursor, 10, signal); check(); setPage(result); setAfter(cursor); setNotice(null); });
  const create = (ticket?: EventExportRetired, afterSubmissionId?: string) => {
    if (busy || disabled) return;
    const request = pending ?? { exportId: ticket?.exportId ?? crypto.randomUUID(), generation: ticket?.generation ?? 0, ...(afterSubmissionId ? { afterSubmissionId } : {}) }; setPending(request);
    void run(async (signal, check) => {
      const snapshot = await client.create(eventId, request.exportId, request.afterSubmissionId, request.generation, signal); check(); setPending(null);
      const result = await client.page(eventId, snapshot.exportId, snapshot.generation, -1, 10, signal); check(); clearUrl(); setBatch(null); setPage(result); setAfter(-1);
      const list = await client.list(eventId, signal); check(); setSnapshots(list.exports); setRetired(list.retired); setListStatus("ready");
    });
  };
  const prepare = () => { if (!page) return; void run(async (signal, check) => {
    clearUrl(); setBatch(null); setNotice("Preparing the batch…");
    const result = await prepareEventExportBatch(client, eventId, page.summary.exportId, page.summary.generation, after, { signal, onProgress: (complete, total) => { if (mounted.current) setNotice(`Checked ${complete} of ${total} photos.`); } }); check();
    setBatch(result); setNotice(`${result.included.length} ${result.included.length === 1 ? "photo" : "photos"} prepared. ${result.failures.length ? `${result.failures.length} unavailable or failed ${result.failures.length === 1 ? "item is" : "items are"} listed in the ZIP report.` : "All photos in this batch are included."}`);
    const latest = await client.page(eventId, page.summary.exportId, page.summary.generation, after, 10, signal); check(); setPage(latest);
  }); };
  const download = () => { if (!batch) return; void run(async (signal, check) => {
    await recheckEventExportBatch(client, batch, signal); check(); clearUrl(); const url = URL.createObjectURL(batch.blob); downloadUrl.current = url;
    const link = document.createElement("a"); link.href = url; link.download = batch.filename; document.body.append(link); link.click(); link.remove();
    setNotice("Download requested. Open the ZIP on your device before marking the photos saved.");
  }); };
  const confirmSaved = () => { if (!batch) return; void run(async (signal, check) => { const summary = await confirmEventExportSaved(client, batch, signal); check(); setBatch({ ...batch, summary }); const latest = await client.page(eventId, summary.exportId, summary.generation, after, 10, signal); check(); setPage(latest); setNotice("You confirmed these photos were saved. Event retention is unchanged."); }); };
  return <section className="border-t border-border py-6" aria-labelledby="event-export-title">
    <div inert={forget || discardRetry ? true : undefined}>
      <header className="flex flex-wrap items-center justify-between gap-3"><h3 id="event-export-title" ref={heading} tabIndex={-1} className="font-display text-xl outline-none">Download event photos <HelpTooltip label="About export snapshots">A snapshot fixes the photo list so you can resume later. Each ZIP includes up to 10 photos, a contents list and any failures. New contributions need a new snapshot.</HelpTooltip></h3><button type="button" className={`${eventControl} border border-border`} disabled={busy || disabled} onClick={() => void refresh()}>Refresh export progress</button></header>
      <p className="mt-3 max-w-2xl text-sm leading-relaxed text-foreground/70">Download photos in ZIP batches before they expire.</p>
      {error && <p role="alert" className="mt-4 text-sm leading-relaxed">{error}</p>}{notice && <p role="status" className="mt-4 text-sm leading-relaxed">{notice}</p>}
      {busy && <button type="button" className={`${eventControl} mt-3 border border-border`} onClick={() => active.current?.abort()}>Cancel export action</button>}
      <div className="my-4 flex flex-wrap gap-2"><button type="button" className={`${eventControl} bg-accent text-accent-foreground`} disabled={busy || disabled || snapshots.length + retired.length >= 8 && !pending} onClick={() => create()}>{pending ? "Retry exact snapshot" : "Capture export snapshot"}</button></div>
      {pending && <div className="mb-4 text-sm leading-relaxed"><p>Retry here, or refresh snapshots after reloading. This one may already exist.</p><button type="button" className={eventControl} disabled={busy || disabled} onClick={() => setDiscardRetry(true)}>Discard local retry request</button></div>}
      {snapshots.length + retired.length >= 8 && <p className="mb-4 text-sm leading-relaxed">All eight export slots are allocated. Forget an obsolete snapshot, then explicitly reuse its slot. Photos are not deleted.</p>}
      <ul className="divide-y divide-border">{snapshots.map(snapshot => <li key={snapshot.exportId} className="flex flex-wrap items-center justify-between gap-3 py-3"><div><p className="text-sm font-semibold">Snapshot {new Date(snapshot.createdAt).toLocaleString("en-AU")}</p><p className="mt-1 text-sm text-foreground/70">{snapshot.total} items · {snapshot.exportId.slice(0, 8)} · version {snapshot.generation + 1}</p></div><div className="flex flex-wrap gap-2"><button type="button" className={`${eventControl} border border-border`} disabled={busy || disabled} onClick={() => open(snapshot)}>Open snapshot</button><button type="button" className={eventControl} disabled={busy || disabled || !!pending} onClick={() => setForget(page?.summary.exportId === snapshot.exportId ? page.summary : snapshot)}>Forget snapshot</button></div></li>)}</ul>
      {listStatus === "waiting" && <p role="status" className="py-3 text-sm">Waiting to check export snapshots.</p>}
      {listStatus === "loading" && <p role="status" className="py-3 text-sm">Checking export snapshots…</p>}
      {listStatus === "ready" && !snapshots.length && !busy && !error && <p className="py-3 text-sm">No export snapshots are available. Capture one to begin.</p>}
      {retired.map(ticket => <button key={ticket.exportId} className={`${eventControl} my-2 border border-border`} disabled={busy || disabled || !!pending} onClick={() => create(ticket)}>Reuse slot {ticket.exportId.slice(0, 8)}</button>)}
      {page && <div className="mt-6 border-t border-border pt-5"><h4 className="font-semibold">Items {page.entries.length ? `${after + 2}–${after + 1 + page.entries.length}` : "0"} of {page.summary.total}</h4><ul className="mt-3 divide-y divide-border">{page.entries.map(entry => <li key={entry.submissionId} className="flex flex-wrap justify-between gap-2 py-2 text-sm"><span>Photo {entry.index + 1} · {entry.submissionId.slice(0, 8)}</span><span>{entry.media ? entry.progress.status.replaceAll("_", " ") : "Unavailable in this snapshot"}</span></li>)}</ul>
        <div className="mt-4 flex flex-wrap gap-2"><button type="button" className={`${eventControl} bg-accent text-accent-foreground`} disabled={busy || disabled} onClick={prepare}>{batch ? "Prepare this batch again" : "Prepare ZIP batch"}</button>{after >= 0 && <button type="button" className={eventControl} disabled={busy || disabled} onClick={() => open(page.summary, Math.max(-1, after - 10))}>Previous batch</button>}{page.nextCursor !== null && <button type="button" className={eventControl} disabled={busy || disabled} onClick={() => open(page.summary, page.nextCursor!)}>Next batch</button>}</div>
        {page.summary.nextSubmissionCursor && <p className="mt-3 text-sm leading-relaxed">More submissions exist beyond this snapshot. {retired.length ? <button type="button" className="min-h-11 font-semibold underline underline-offset-4" disabled={busy || disabled || !!pending} onClick={() => create(retired[0], page.summary.nextSubmissionCursor!)}>Use a retired slot for the continuation</button> : <button type="button" className="min-h-11 font-semibold underline underline-offset-4" disabled={busy || disabled || !!pending || snapshots.length >= 8} onClick={() => create(undefined, page.summary.nextSubmissionCursor!)}>Capture continuation snapshot</button>}</p>}
        {batch && <div className="mt-4 flex flex-wrap items-center gap-2"><button type="button" className={`${eventControl} border border-border`} disabled={busy || disabled} onClick={download}>Download ZIP ({batch.blob.size < 1000000 ? `${Math.max(1, Math.round(batch.blob.size / 1000))} KB` : `${(batch.blob.size / 1000000).toFixed(1)} MB`})</button><button type="button" className={eventControl} disabled={busy || disabled || !batch.included.length} onClick={confirmSaved}>I checked the saved ZIP</button><button type="button" className={eventControl} disabled={busy || disabled} onClick={() => { clearUrl(); setBatch(null); setNotice("Prepared ZIP released from this page. Server progress is unchanged; prepare the batch again if you need another copy."); }}>Release prepared ZIP</button></div>}
        <p className="mt-3 text-sm leading-relaxed text-foreground/70">Check your downloads before marking a ZIP saved. These photos have no collected captions.</p>
      </div>}
    </div>
    {forget && <EventHostConfirm title="Forget this export snapshot?" action="Forget snapshot metadata" busy={busy} onKeep={() => setForget(null)} onConfirm={() => void run(async (signal, check) => { await client.retire(eventId, forget.exportId, forget.generation, forget.revision, signal); check(); clearUrl(); setBatch(null); setPage(null); setForget(null); setPending(null); const list = await client.list(eventId, signal); check(); setSnapshots(list.exports); setRetired(list.retired); setNotice("Snapshot metadata forgotten. Its slot can be reused; event photos are unchanged."); requestAnimationFrame(() => heading.current?.focus()); })}><p>This removes its manifest and recovery progress, including unfinished batches. Event photos and existing downloaded ZIPs remain unchanged. An old interrupted request cannot recreate this retired snapshot.</p></EventHostConfirm>}
    {discardRetry && <EventHostConfirm title="Discard the local retry request?" action="Discard local retry" busy={busy} onKeep={() => setDiscardRetry(false)} onConfirm={() => { setPending(null); setDiscardRetry(false); setNotice("Local retry request discarded. Refresh snapshots before creating another; an earlier request may already have succeeded."); }}><p>This removes only this page’s retry request. It does not remove a server snapshot or any event photo.</p></EventHostConfirm>}
  </section>;
}
