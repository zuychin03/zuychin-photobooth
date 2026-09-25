/* eslint-disable @next/next/no-img-element -- Audience photos use short-lived local Blob URLs. */
"use client";
import { useAppNavigationGuard } from "@/components/AppNavigation";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Download, Flag, Pause, RefreshCw } from "lucide-react";
import { useCapturePreferences } from "@/hooks/useCapturePreferences";
import { Dropdown } from "@/components/Dropdown";
import type { EventAudienceClient, EventAudienceReport } from "@/lib/events/audience-client";
import { createEventAudienceLifecycle, type EventAudienceLifecycle, type EventAudienceState } from "@/lib/events/audience-lifecycle";
import { eventAudienceError } from "@/lib/events/audience-fragment";
import { EventClientError } from "@/lib/events/client";
import type { EventAudienceEntry, EventAudienceSession, EventReportReason } from "@/lib/events/publication-contract";
import { eventControl, eventInput } from "./EventHostControls";

const empty: EventAudienceState = { phase: "loading", page: null, images: [], error: null, freshnessUntil: 0, hasPrevious: false, mediaBusy: false };
export function EventAudienceWorkspace({ client, session, onExit }: { client: EventAudienceClient; session: EventAudienceSession; onExit(): void }) {
  const [state, setState] = useState(empty), [busy, setBusy] = useState(false), [notice, setNotice] = useState<string | null>(null), [selected, setSelected] = useState<string | null>(null), [reason, setReason] = useState<EventReportReason>("privacy"), [detail, setDetail] = useState(""), [pending, setPending] = useState<EventAudienceReport | null>(null);
  const lifecycle = useRef<EventAudienceLifecycle | null>(null), alive = useRef(false), action = useRef<AbortController | null>(null), running = useRef(false), downloadUrl = useRef<string | null>(null), revokeTimer = useRef<ReturnType<typeof setTimeout> | null>(null), reportInput = useRef<HTMLTextAreaElement>(null), reportButtons = useRef(new Map<string, HTMLButtonElement>()), returnReportFocus = useRef<string | null>(null), heading = useRef<HTMLHeadingElement>(null), checkButton = useRef<HTMLButtonElement>(null), downloadButtons = useRef(new Map<string, HTMLButtonElement>()), returnDownloadFocus = useRef<string | null>(null), returnPageFocus = useRef(false);
  useAppNavigationGuard(() => { if (!busy && !selected && !pending) return true; setNotice(busy ? "Wait for this request to finish before leaving." : "Send or cancel your report first. Use Leave viewing to discard an unconfirmed report."); return false; });
  const wall = client.destination === "wall";
  const { reducedMotion } = useCapturePreferences();
  const [displayMode, setDisplayMode] = useState(false), [holdPhotos, setHoldPhotos] = useState(false);
  const displayExit = useRef<HTMLButtonElement>(null), restoreDisplayFocus = useRef(false);
  const leaveDisplay = () => { restoreDisplayFocus.current = true; setDisplayMode(false); };
  useLayoutEffect(() => {
    if (displayMode) displayExit.current?.focus();
    else if (restoreDisplayFocus.current) { restoreDisplayFocus.current = false; heading.current?.focus(); }
  }, [displayMode]);
  useEffect(() => {
    if (!displayMode) return;
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); restoreDisplayFocus.current = true; setDisplayMode(false); } };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [displayMode]);
  useEffect(() => {
    alive.current = true; const controller = createEventAudienceLifecycle(client, next => { if (alive.current) setState(next); }); lifecycle.current = controller;
    const releaseDownload = () => { if (downloadUrl.current) URL.revokeObjectURL(downloadUrl.current); downloadUrl.current = null; if (revokeTimer.current) clearTimeout(revokeTimer.current); };
    const visibility = () => { if (document.hidden || !navigator.onLine) { action.current?.abort(); releaseDownload(); setSelected(null); setPending(null); setDetail(""); setNotice(null); controller.pause(document.hidden ? "hidden" : "offline"); } else controller.start(); };
    document.addEventListener("visibilitychange", visibility); window.addEventListener("offline", visibility); window.addEventListener("online", visibility); visibility();
    return () => { alive.current = false; action.current?.abort(); controller.close(); releaseDownload(); lifecycle.current = null; document.removeEventListener("visibilitychange", visibility); window.removeEventListener("offline", visibility); window.removeEventListener("online", visibility); };
  }, [client]);
  useEffect(() => { lifecycle.current?.setRotationEnabled(!reducedMotion && !holdPhotos); }, [client, reducedMotion, holdPhotos]);
  useEffect(() => { if (selected) reportInput.current?.focus(); }, [selected]);
  useEffect(() => {
    if (!selected && !busy && returnReportFocus.current && !document.hidden) {
      const target = reportButtons.current.get(returnReportFocus.current); returnReportFocus.current = null;
      if (target?.isConnected && !target.disabled) target.focus(); else heading.current?.focus();
    }
    if (!busy && returnDownloadFocus.current && !document.hidden) {
      const target = downloadButtons.current.get(returnDownloadFocus.current); returnDownloadFocus.current = null;
      if (target?.isConnected && !target.disabled) target.focus(); else heading.current?.focus();
    }
  }, [selected, busy]);
  useEffect(() => { if (returnPageFocus.current && state.phase !== "loading" && !document.hidden) { returnPageFocus.current = false; heading.current?.focus(); } }, [state.page, state.phase]);
  const closeReport = (submissionId: string) => { returnReportFocus.current = submissionId; setPending(null); setSelected(null); setDetail(""); };
  const run = async (task: (signal: AbortSignal) => Promise<void>) => {
    if (running.current || document.hidden || !navigator.onLine) return; running.current = true; setBusy(true); setNotice(null); const abort = new AbortController(); action.current = abort;
    try { await task(abort.signal); }
    catch (failure) { if (alive.current && !abort.signal.aborted) { lifecycle.current?.pause(failure instanceof EventClientError ? failure.code : "unavailable"); setNotice(eventAudienceError(failure)); } }
    finally { running.current = false; if (alive.current) setBusy(false); }
  };
  const download = (entry: EventAudienceEntry) => void run(async signal => {
    if (lifecycle.current?.getState().mediaBusy) return;
    const blob = await client.download(entry, "image", signal); client.assertActive(signal); if (!alive.current || document.hidden || !navigator.onLine) return;
    if (downloadUrl.current) URL.revokeObjectURL(downloadUrl.current); if (revokeTimer.current) clearTimeout(revokeTimer.current);
    const url = URL.createObjectURL(blob); downloadUrl.current = url; const link = document.createElement("a"); link.href = url; link.download = `event-photo-${entry.submissionId}.jpg`; document.body.append(link); link.click(); link.remove(); returnDownloadFocus.current = entry.submissionId;
    revokeTimer.current = setTimeout(() => { if (downloadUrl.current === url) { URL.revokeObjectURL(url); downloadUrl.current = null; } }, 1000); setNotice("Download requested. A saved copy remains on your device even if event access later ends.");
  });
  const report = () => {
    if (!selected || running.current) return;
    const request = pending ?? { requestId: crypto.randomUUID(), submissionId: selected, reason, detail: detail.replace(/[\r\n\t]/g, " ") }; setPending(request);
    void run(async signal => { await client.report(request, signal); client.assertActive(signal); if (!alive.current || document.hidden) return; closeReport(request.submissionId); setNotice("Your report has been sent to the host. Reporting does not automatically remove the photo."); });
  };
  const ready = state.phase === "ready" && state.page !== null, visibleEntries = ready ? state.page!.entries : [];
  return <main className={`mx-auto min-h-dvh px-5 py-7 sm:px-8 ${wall ? "max-w-screen-2xl" : "max-w-6xl"}`}>
    {displayMode ? <header className="mb-5 flex flex-wrap items-center justify-between gap-3"><div className="min-w-0"><h1 className="break-words font-display text-2xl">{session.eventTitle}</h1><p role="status" className="mt-1 text-sm text-foreground/65">{ready ? "Live wall · permissions checked every five seconds" : "Display paused while permissions are checked"}</p></div><button ref={displayExit} className={`${eventControl} border border-border`} onClick={leaveDisplay}>Exit display <span className="text-foreground/60">Esc</span></button></header> : <header className="flex flex-wrap items-start justify-between gap-5 border-b border-border pb-6"><div className="min-w-0"><p className="break-words font-display text-3xl sm:text-4xl">{session.eventTitle}</p><h1 ref={heading} tabIndex={-1} className="mt-2 text-lg font-semibold">{wall ? "Live event wall" : "Event gallery"}</h1><p className="mt-3 max-w-2xl text-sm leading-relaxed text-foreground/75">{wall ? "Wall-approved photos rotate in groups of three. Viewing pauses when this page is hidden." : "Only gallery-approved photos appear here. Choose a photo to download its finished image."} Permissions are checked every five seconds; photos disappear if checks become stale.</p></div><button className={`${eventControl} border border-border`} onClick={onExit}><ArrowLeft size={17} aria-hidden />Leave viewing</button></header>}
    {!displayMode && <div className="flex flex-wrap items-center gap-2 py-5"><button ref={checkButton} className={`${eventControl} border border-border`} onClick={() => lifecycle.current?.retry()}><RefreshCw size={17} aria-hidden />Check again</button>{ready && <button className={eventControl} onClick={() => { action.current?.abort(); lifecycle.current?.pause("paused"); checkButton.current?.focus(); }}><Pause size={17} aria-hidden />Pause viewing</button>}{state.hasPrevious && <button className={eventControl} disabled={!ready} onClick={() => { returnPageFocus.current = true; lifecycle.current?.first(); }}>First photos</button>}{state.page?.nextCursor && <button className={eventControl} disabled={!ready} onClick={() => { returnPageFocus.current = true; lifecycle.current?.next(); }}>Next photos<ArrowRight size={17} aria-hidden /></button>}{wall && <><button className={`${eventControl} border border-border`} disabled={!ready || busy || Boolean(selected) || Boolean(pending)} onClick={() => setDisplayMode(true)}>Start display</button><label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={reducedMotion || holdPhotos} disabled={reducedMotion} onChange={event => setHoldPhotos(event.target.checked)} />Keep current photos still</label>{reducedMotion && <p className="text-sm text-foreground/65">Reduced motion is active. Permissions still refresh automatically.</p>}</>}</div>}
    {state.phase === "loading" && <p role="status" className="py-10">Checking approved photos…</p>}
    {state.error && <p role="status" className="max-w-xl rounded-xl bg-muted p-5 text-sm leading-relaxed">{eventAudienceError(new EventClientError(state.error))}</p>}
    {notice && <p role="status" className="my-4 max-w-2xl text-sm leading-relaxed">{notice}</p>}
    {ready && state.mediaBusy && !wall && <p role="status" className="mb-4 text-sm text-foreground/75">Preparing photo previews. Original downloads become available when this step finishes.</p>}
    {ready && !visibleEntries.length && <section className="max-w-xl py-12"><h2 className="font-display text-2xl">No photos to show yet</h2><p className="mt-3 leading-relaxed text-foreground/75">Photos appear after everyone agrees and the host approves. This page checks automatically.</p></section>}
    {ready && <ul className={`grid gap-x-5 gap-y-8 ${wall ? "sm:grid-cols-3" : "grid-cols-2 md:grid-cols-3 lg:grid-cols-4"}`}>{visibleEntries.map((entry, index) => { const image = state.images.find(item => item.submissionId === entry.submissionId && item.revision === entry.revision); return <li key={entry.submissionId} className="min-w-0"><div className={`flex items-center justify-center overflow-hidden rounded-xl bg-muted ${wall ? displayMode ? "h-[max(16rem,calc(75dvh-var(--app-nav-height,0px)))]" : "h-[55dvh] min-h-64" : "aspect-[3/4]"}`}>{image ? <img src={image.url} alt={`Approved event photo ${index + 1}`} className="h-full w-full object-contain" draggable={false} /> : <p className="px-4 text-center text-sm text-foreground/70">Checking photo…</p>}</div>{!displayMode && <div className="mt-2 flex flex-wrap gap-1">{!wall && <button ref={node => { if (node) downloadButtons.current.set(entry.submissionId, node); else downloadButtons.current.delete(entry.submissionId); }} aria-label={`Download photo ${index + 1}`} className={eventControl} disabled={busy || state.mediaBusy || !image} onClick={() => download(entry)}><Download size={17} aria-hidden />Download</button>}<button ref={node => { if (node) reportButtons.current.set(entry.submissionId, node); else reportButtons.current.delete(entry.submissionId); }} aria-label={`Report photo ${index + 1}`} className={eventControl} disabled={busy || Boolean(pending)} onClick={() => { setSelected(entry.submissionId); setReason("privacy"); setDetail(""); setNotice(null); }}><Flag size={17} aria-hidden />Report</button></div>}</li>; })}</ul>}
    {selected && ready && <section className="mt-8 max-w-xl border-t border-border pt-6" aria-labelledby="audience-report-title"><h2 id="audience-report-title" className="font-display text-2xl">Report this photo</h2><p className="mt-2 text-sm leading-relaxed">The host can review this report. Do not include contact details or sensitive personal information.</p><div className="mt-4"><Dropdown label="Reason" showLabel value={reason} options={[{ value: "privacy", label: "Privacy concern" }, { value: "inappropriate", label: "Inappropriate content" }, { value: "other", label: "Other concern" }]} onChange={value => setReason(value as EventReportReason)} disabled={busy || Boolean(pending)} /></div><label className="mt-4 block text-sm font-semibold" htmlFor="audience-report-detail">Details, optional</label><textarea id="audience-report-detail" ref={reportInput} className={`${eventInput} mt-2 min-h-28`} maxLength={500} value={detail} disabled={busy || Boolean(pending)} onChange={event => setDetail(event.target.value)} /><p className="mt-1 text-sm text-foreground/65">{[...detail].length}/500</p>{pending && <p className="mt-3 text-sm">Retry here if confirmation is missing. Reloading clears this draft.</p>}<div className="mt-4 flex flex-wrap gap-2"><button className={`${eventControl} bg-accent text-accent-foreground`} disabled={busy} onClick={report}>{busy ? "Sending…" : pending ? "Retry exact report" : "Send report"}</button><button className={eventControl} disabled={busy} onClick={() => closeReport(selected)}>Close report</button></div></section>}
    {busy && <button className={`${eventControl} mt-5 border border-border`} onClick={() => action.current?.abort()}>Cancel action</button>}
    {!displayMode && <p className="mt-10 border-t border-border pt-5 text-sm leading-relaxed text-foreground/65">Links can be forwarded. Downloads cannot be recalled.</p>}
  </main>;
}
