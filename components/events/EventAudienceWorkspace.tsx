/* eslint-disable @next/next/no-img-element -- Audience photos use short-lived local Blob URLs. */
"use client";
import { useAppNavigationGuard } from "@/components/AppNavigation";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Download, Flag, ImageOff, Images, LoaderCircle, Maximize2, Pause, Presentation, RefreshCw } from "lucide-react";
import { useCapturePreferences } from "@/hooks/useCapturePreferences";
import { Dropdown } from "@/components/Dropdown";
import type { EventAudienceClient, EventAudienceReport } from "@/lib/events/audience-client";
import { createEventAudienceLifecycle, type EventAudienceLifecycle, type EventAudienceState } from "@/lib/events/audience-lifecycle";
import { eventAudienceError } from "@/lib/events/audience-fragment";
import { EventClientError } from "@/lib/events/client";
import type { EventAudienceEntry, EventAudienceSession, EventReportReason } from "@/lib/events/publication-contract";
import { EventPanelHead } from "./EventHostControls";

const empty: EventAudienceState = { phase: "loading", page: null, images: [], error: null, freshnessUntil: 0, hasPrevious: false, mediaBusy: false };
export function EventAudienceWorkspace({ client, session, onExit }: { client: EventAudienceClient; session: EventAudienceSession; onExit(): void }) {
  const [state, setState] = useState(empty), [busy, setBusy] = useState(false), [notice, setNotice] = useState<string | null>(null), [selected, setSelected] = useState<string | null>(null), [reason, setReason] = useState<EventReportReason>("privacy"), [detail, setDetail] = useState(""), [pending, setPending] = useState<EventAudienceReport | null>(null);
  const lifecycle = useRef<EventAudienceLifecycle | null>(null), alive = useRef(false), action = useRef<AbortController | null>(null), running = useRef(false), downloadUrl = useRef<string | null>(null), revokeTimer = useRef<ReturnType<typeof setTimeout> | null>(null), reportInput = useRef<HTMLTextAreaElement>(null), reportButtons = useRef(new Map<string, HTMLButtonElement>()), returnReportFocus = useRef<string | null>(null), heading = useRef<HTMLHeadingElement>(null), checkButton = useRef<HTMLButtonElement>(null), downloadButtons = useRef(new Map<string, HTMLButtonElement>()), returnDownloadFocus = useRef<string | null>(null), returnPageFocus = useRef(false);
  useAppNavigationGuard(() => { if (!busy && !selected && !pending) return true; setNotice(busy ? "Wait for this to finish before you leave." : "Send or cancel your report first."); return false; });
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
    revokeTimer.current = setTimeout(() => { if (downloadUrl.current === url) { URL.revokeObjectURL(url); downloadUrl.current = null; } }, 1000); setNotice("Downloading now. Check your downloads folder.");
  });
  const report = () => {
    if (!selected || running.current) return;
    const request = pending ?? { requestId: crypto.randomUUID(), submissionId: selected, reason, detail: detail.replace(/[\r\n\t]/g, " ") }; setPending(request);
    void run(async signal => { await client.report(request, signal); client.assertActive(signal); if (!alive.current || document.hidden) return; closeReport(request.submissionId); setNotice("Report sent to the host."); });
  };
  const ready = state.phase === "ready" && state.page !== null, visibleEntries = ready ? state.page!.entries : [];
  const tool = "btn btn-plain min-h-10 px-3.5 text-sm";
  const overlay = "btn btn-glass min-h-11 px-3 text-sm md:min-h-10";
  return <main className={`mx-auto flex min-h-dvh w-full flex-1 flex-col gap-5 px-4 pt-4 pb-10 sm:px-8 sm:pt-6 ${wall ? "max-w-screen-2xl" : "max-w-6xl"} ${displayMode ? "booth-mode" : ""}`}>
    {displayMode ? <header className="glass flex items-center justify-between gap-3 rounded-full py-1.5 pr-1.5 pl-5"><div className="flex min-w-0 items-center gap-3"><h1 className="truncate font-display text-xl">{session.eventTitle}</h1><p role="status" className="flex shrink-0 items-center gap-1.5 text-sm font-bold text-muted-foreground"><span aria-hidden className={`size-2 rounded-full ${ready ? "bg-success motion-safe:animate-pulse" : "bg-warning"}`} />{ready ? "Live wall" : "Paused while checking…"}</p></div><button ref={displayExit} className="btn btn-plain min-h-10 shrink-0 text-sm" onClick={leaveDisplay}>Exit display <kbd className="rounded-md bg-muted px-1.5 py-0.5 font-sans text-xs text-muted-foreground">Esc</kbd></button></header> : <header className="page-head flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between"><div className="min-w-0"><p className="break-words font-display text-[2.125rem] leading-[1.12] sm:text-5xl">{session.eventTitle}</p><h1 ref={heading} tabIndex={-1} className="mt-2 flex items-center gap-2 text-base font-bold text-muted-foreground outline-none">{wall ? <Presentation size={17} aria-hidden /> : <Images size={17} aria-hidden />}{wall ? "Live event wall" : "Event gallery"}</h1></div><button className="btn btn-quiet shrink-0 self-start sm:self-auto" onClick={onExit}><ArrowLeft size={17} aria-hidden />Leave</button></header>}
    {!displayMode && <div className="glass flex flex-wrap items-center gap-1 self-start rounded-[1.625rem] p-1.5"><button ref={checkButton} className={tool} onClick={() => lifecycle.current?.retry()}><RefreshCw size={16} aria-hidden />Refresh</button>{ready && <button className={tool} onClick={() => { action.current?.abort(); lifecycle.current?.pause("paused"); checkButton.current?.focus(); }}><Pause size={16} aria-hidden />Pause</button>}{state.hasPrevious && <button className={tool} disabled={!ready} onClick={() => { returnPageFocus.current = true; lifecycle.current?.first(); }}>First photos</button>}{state.page?.nextCursor && <button className={tool} disabled={!ready} onClick={() => { returnPageFocus.current = true; lifecycle.current?.next(); }}>Next photos<ArrowRight size={16} aria-hidden /></button>}{wall && <><button className="btn btn-primary min-h-10 px-4 text-sm" disabled={!ready || busy || Boolean(selected) || Boolean(pending)} onClick={() => setDisplayMode(true)}><Maximize2 size={16} aria-hidden /> Start wall display</button><label className="flex min-h-10 cursor-pointer items-center gap-2 px-3 text-sm font-bold"><input type="checkbox" className="size-4 accent-accent" checked={reducedMotion || holdPhotos} disabled={reducedMotion} onChange={event => setHoldPhotos(event.target.checked)} />Stop rotating</label></>}</div>}
    {!displayMode && wall && reducedMotion && <p className="-mt-2 text-sm text-muted-foreground">Reduced motion is on, so photos don&apos;t rotate.</p>}
    {state.phase === "loading" && <p role="status" className="flex items-center gap-2 py-10 text-sm text-muted-foreground"><LoaderCircle size={18} className="animate-spin motion-reduce:animate-none" aria-hidden /> Loading photos…</p>}
    {state.error && <p role="status" className="notice max-w-xl">{eventAudienceError(new EventClientError(state.error))}</p>}
    {notice && <p role="status" className="notice max-w-2xl">{notice}</p>}
    {ready && state.mediaBusy && !wall && <p role="status" className="text-sm text-muted-foreground">Loading photos. You can download them once they&apos;re ready.</p>}
    {ready && !visibleEntries.length && <section className="panel flex min-h-64 flex-col items-center justify-center gap-3 px-6 py-12 text-center"><span className="glyph size-14 rounded-2xl bg-[#10b981]"><ImageOff size={26} aria-hidden /></span><h2 className="font-display text-2xl">No photos to show yet</h2><p className="text-sm text-muted-foreground">Photos show up here once the host approves them.</p></section>}
    {ready && <ul className={`grid ${wall ? "gap-4 sm:grid-cols-3 lg:gap-6" : "grid-cols-2 gap-3 sm:gap-4 md:grid-cols-3 lg:grid-cols-4"}`}>{visibleEntries.map((entry, index) => { const image = state.images.find(item => item.submissionId === entry.submissionId && item.revision === entry.revision); return <li key={entry.submissionId} className="relative min-w-0"><div className={`flex items-center justify-center overflow-hidden bg-muted ${wall ? displayMode ? "h-[max(16rem,calc(75dvh-var(--app-nav-height,0px)))] rounded-[1.75rem]" : "h-[55dvh] min-h-64 rounded-[1.5rem]" : "aspect-[3/4] rounded-2xl"}`}>{image ? <img src={image.url} alt={`Approved event photo ${index + 1}`} className="h-full w-full object-contain" draggable={false} /> : <p className="px-4 text-center text-sm text-muted-foreground">Loading…</p>}</div>{!displayMode && <div className="absolute inset-x-2 bottom-2 flex flex-wrap justify-end gap-1.5">{!wall && <button ref={node => { if (node) downloadButtons.current.set(entry.submissionId, node); else downloadButtons.current.delete(entry.submissionId); }} aria-label={`Download photo ${index + 1}`} className={overlay} disabled={busy || state.mediaBusy || !image} onClick={() => download(entry)}><Download size={16} aria-hidden /><span className="max-md:sr-only">Download</span></button>}<button ref={node => { if (node) reportButtons.current.set(entry.submissionId, node); else reportButtons.current.delete(entry.submissionId); }} aria-label={`Report photo ${index + 1}`} className={overlay} disabled={busy || Boolean(pending)} onClick={() => { setSelected(entry.submissionId); setReason("privacy"); setDetail(""); setNotice(null); }}><Flag size={16} aria-hidden /><span className="max-md:sr-only">Report</span></button></div>}</li>; })}</ul>}
    {selected && ready && <section className="panel max-w-xl p-4 sm:p-6" aria-labelledby="audience-report-title"><EventPanelHead id="audience-report-title" icon={Flag} tone="slate">Report this photo</EventPanelHead><p className="mt-3 text-sm">The host will see this. Don&apos;t include contact details or anything sensitive.</p><div className="mt-4"><Dropdown label="Reason" showLabel value={reason} options={[{ value: "privacy", label: "Privacy" }, { value: "inappropriate", label: "Inappropriate content" }, { value: "other", label: "Something else" }]} onChange={value => setReason(value as EventReportReason)} disabled={busy || Boolean(pending)} /></div><label className="mt-4 block text-sm font-bold" htmlFor="audience-report-detail">Details (optional)</label><textarea id="audience-report-detail" ref={reportInput} className="field mt-1.5 min-h-28 py-2.5" maxLength={500} value={detail} disabled={busy || Boolean(pending)} onChange={event => setDetail(event.target.value)} /><p className="mt-1 text-right text-xs text-muted-foreground tabular-nums">{[...detail].length}/500</p>{pending && <p className="notice mt-3">Sending hasn&apos;t been confirmed. Try again.</p>}<div className="mt-4 flex flex-wrap gap-2"><button className="btn btn-primary" disabled={busy} onClick={report}>{busy ? "Sending…" : pending ? "Try again" : "Send report"}</button><button className="btn btn-quiet" disabled={busy} onClick={() => closeReport(selected)}>Cancel</button></div></section>}
    {busy && <button className="btn btn-quiet self-start" onClick={() => action.current?.abort()}>Cancel</button>}
  </main>;
}
