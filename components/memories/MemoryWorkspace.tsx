"use client";

import { useAppNavigationGuard } from "@/components/AppNavigation";

import { useEffect, useId, useRef, useState } from "react";
import { ChartColumn, ChevronDown, Copy, Eye, ImageIcon, Images, ListChecks, LoaderCircle, Mic, RefreshCw, Search, Tag, X } from "lucide-react";
import { Dropdown } from "@/components/Dropdown";
import type { MemoryRuntime } from "@/lib/memories/memory-runtime";
import type { ActivitySummary, MemoryActivity, MemoryChapter } from "@/lib/memories/activity-contract";
import { validateMemoryBrowse, type MemoryBrowse, type MemoryBrowsePage } from "@/lib/memories/activity-browse";
import { memoryAvailability, memoryDate, memoryError, memoryProvenance, memorySelectable } from "@/lib/memories/memory-editor";
import { prepareMemoryThumbnail } from "@/lib/memories/memory-media";
import { MemoryChapters, MemoryLabelEditor } from "./MemoryLabels";
import { MemoryRecap } from "./MemoryRecap";
import { VoiceMemoryEntry } from "./VoiceMemoryEntry";
import { duplicateMemoryImage, MemoryImageCopyError } from "@/lib/memories/duplicate-image";

const action = "btn btn-quiet min-h-10 px-3.5 text-[0.8125rem]";
const initialQuery = (): MemoryBrowse => ({ year: Number(new Intl.DateTimeFormat("en", { timeZone: "Australia/Sydney", year: "numeric" }).format(new Date())), timeZone: "Australia/Sydney", chapterId: null, after: null, limit: 20 });

export function MemoryWorkspace({ runtime, voiceEnabled = false }: { runtime: MemoryRuntime; voiceEnabled?: boolean }) {
  const id = useId(), active = useRef(true), work = useRef<AbortController | null>(null), heading = useRef<HTMLHeadingElement>(null), previewUrl = useRef<string | null>(null);
  const previewWork = useRef<AbortController | null>(null), previewGeneration = useRef(0);
  const [query, setQuery] = useState(initialQuery), [year, setYear] = useState(() => String(initialQuery().year)), [zone, setZone] = useState("Australia/Sydney"), [chapter, setChapter] = useState("");
  const [page, setPage] = useState<MemoryBrowsePage | null>(null), [chapters, setChapters] = useState<MemoryChapter[]>([]), [summary, setSummary] = useState<ActivitySummary | null>(null);
  const [busy, setBusy] = useState(true), [mediaBusy, setMediaBusy] = useState(false), [stale, setStale] = useState(false), [lost, setLost] = useState(false), [error, setError] = useState<string | null>(null), [note, setNote] = useState<string | null>(null);
  const [editorId, setEditorId] = useState<string | null>(null), [selected, setSelected] = useState<MemoryActivity[]>([]), [preview, setPreview] = useState<{ id: string; src: string; width: number; height: number } | null>(null), [generation, setGeneration] = useState(0);
  const [voiceId, setVoiceId] = useState<string | null>(null);
  const disabled = busy || mediaBusy || voiceId !== null, editor = page?.items.find(item => item.id === editorId);
  useAppNavigationGuard(() => {
    if (busy || mediaBusy || editorId !== null) { setNote("Save or cancel your changes before you leave."); return false; }
    return true;
  });
  const clearPreview = () => { previewGeneration.current++; previewWork.current?.abort(); previewWork.current = null; if (previewUrl.current) URL.revokeObjectURL(previewUrl.current); previewUrl.current = null; setPreview(null); };
  const clearMedia = () => { clearPreview(); setSelected([]); setGeneration(value => value + 1); };
  const failed = (failure: unknown, mutation = false) => {
    setError(failure instanceof MemoryImageCopyError ? failure.message : memoryError(failure));
    const code = failure && typeof failure === "object" && "code" in failure ? String(failure.code) : "";
    if (code === "access_denied" || code === "account_changed") { clearMedia(); setVoiceId(null); setPage(null); setChapters([]); setSummary(null); setEditorId(null); setLost(true); setStale(true); }
    else if (mutation) setStale(true);
  };
  const run = async (operation: (signal: AbortSignal) => Promise<void>, mutation = false) => {
    if (work.current || mediaBusy || voiceId !== null || !active.current) return false;
    const controller = new AbortController(); work.current = controller; setBusy(true); setError(null); setNote(null);
    try { await operation(controller.signal); runtime.activity.assertActive(controller.signal); return true; }
    catch (failure) { if (active.current && !controller.signal.aborted) failed(failure, mutation); return false; }
    finally { if (work.current === controller) work.current = null; if (active.current) setBusy(false); }
  };
  const load = async (next: MemoryBrowse, signal: AbortSignal) => {
    const [nextPage, nextChapters, nextSummary] = await Promise.all([runtime.activity.browse(next, signal), runtime.activity.chapters(signal), runtime.activity.summary(next.year, signal)]);
    runtime.activity.assertActive(signal); if (!active.current) return;
    setPage(nextPage); setChapters(nextChapters); setSummary(nextSummary); setQuery(next); setStale(false); setLost(false); setEditorId(null); setGeneration(value => value + 1);
  };
  useEffect(() => {
    active.current = true; const controller = new AbortController(); work.current = controller;
    void load(initialQuery(), controller.signal).catch(failure => { if (active.current && !controller.signal.aborted) failed(failure); }).finally(() => { if (work.current === controller) { work.current = null; if (active.current) setBusy(false); } });
    const hide = () => { if (document.visibilityState === "hidden") clearMedia(); };
    document.addEventListener("visibilitychange", hide);
    return () => { active.current = false; work.current?.abort(); if (previewUrl.current) URL.revokeObjectURL(previewUrl.current); document.removeEventListener("visibilitychange", hide); };
    // The account runtime owns this workspace's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime]);
  useEffect(() => { if (lost || error) heading.current?.focus(); }, [lost, error]);
  const refresh = () => run(async signal => { clearMedia(); await load({ ...query, after: null }, signal); heading.current?.focus(); });
  const filter = () => {
    let next: MemoryBrowse;
    try { next = validateMemoryBrowse({ year: Number(year), timeZone: zone.trim(), chapterId: chapter || null, after: null, limit: 20 }); }
    catch { setError("Enter a year between 1970 and 2198, and a timezone like Australia/Sydney."); return; }
    void run(async signal => { clearMedia(); setPage(null); setSummary(null); await load(next, signal); heading.current?.focus(); });
  };
  const mutate = (operation: (signal: AbortSignal) => Promise<unknown>, message: string) => run(async signal => { clearMedia(); await operation(signal); await load({ ...query, after: null }, signal); setNote(message); heading.current?.focus(); }, true);
  const showPreview = (item: MemoryActivity) => run(async signal => {
    clearPreview(); const generation = previewGeneration.current, controller = work.current; previewWork.current = controller;
    try {
      const image = await prepareMemoryThumbnail(item, runtime, signal); runtime.activity.assertActive(signal);
      if (!active.current || generation !== previewGeneration.current || document.visibilityState !== "visible") return;
      const src = URL.createObjectURL(image.blob); previewUrl.current = src; setPreview({ id: item.id, src, width: image.width, height: image.height });
    } finally { if (previewWork.current === controller) previewWork.current = null; }
  });
  const total = summary?.months.reduce((sum, month) => sum + month.total, 0) ?? 0;
  const peak = Math.max(1, ...(summary?.months.map(month => month.total) ?? []));
  const duplicateImage = (item: MemoryActivity) => run(async signal => {
    await duplicateMemoryImage(item, runtime.retained, signal);
    runtime.activity.assertActive(signal);
    setNote("A copy was saved to My projects as a single image.");
    heading.current?.focus();
  });
  return <div className="flex flex-col gap-5">
    <form onSubmit={event => { event.preventDefault(); filter(); }} className="panel grid items-end gap-3 p-4 sm:grid-cols-[7rem_minmax(0,1fr)_minmax(0,1fr)_auto] sm:p-5"><label htmlFor={`${id}-year`} className="text-sm font-bold">Year<input id={`${id}-year`} className="field mt-1.5 font-medium tabular-nums" type="number" min={1970} max={2198} value={year} disabled={disabled} onChange={event => setYear(event.target.value)} required /></label><label htmlFor={`${id}-zone`} className="min-w-0 text-sm font-bold">Timezone<input id={`${id}-zone`} className="field mt-1.5 font-medium" value={zone} disabled={disabled} onChange={event => setZone(event.target.value)} maxLength={100} autoCapitalize="none" spellCheck={false} required /></label><Dropdown label="Chapter" showLabel value={chapter} options={[{ value: "", label: "All memories" }, ...chapters.map(value => ({ value: value.id, label: value.title }))]} disabled={disabled} onChange={setChapter} /><button className="btn btn-primary" disabled={disabled}><Search size={17} aria-hidden /> Show</button></form>
    <section className="panel p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex min-w-0 items-center gap-3"><span className="glyph bg-[#f43f5e]"><Images size={18} strokeWidth={2.25} aria-hidden /></span><div className="min-w-0"><h2 ref={heading} tabIndex={-1} className="font-display text-xl leading-tight outline-none">{lost ? "Can't show your memories" : `${query.year} in ${query.timeZone}`}</h2><p className="mt-0.5 text-sm text-muted-foreground">Dates are when photos were saved.</p></div></div><div className="flex flex-wrap items-center gap-1.5">{page && !lost && selected.length > 0 && <a href={`#${id}-recap`} className="btn btn-tinted min-h-10 text-sm"><ListChecks size={16} aria-hidden /> Review {selected.length} selected photos</a>}<button disabled={disabled} className="btn btn-plain min-h-10 text-sm" onClick={() => void refresh()}><RefreshCw size={15} aria-hidden /> Refresh</button></div></div>
      {busy && <p role="status" className="mt-4 flex items-center gap-2 text-sm font-bold"><LoaderCircle size={16} aria-hidden className="animate-spin text-accent motion-reduce:animate-none" /> Loading memories…</p>}
      {error && <p role="alert" className="notice mt-4 border border-destructive/25 bg-destructive/8 font-bold text-destructive">{error}</p>}{note && <p role="status" className="notice mt-4">{note}</p>}{stale && !lost && <p className="mt-3 text-sm font-bold text-warning">Refresh before making more changes.</p>}
      {page && !lost && <>{!page.items.length ? <div className="mt-4 flex min-h-48 flex-col items-center justify-center rounded-2xl bg-muted/50 px-6 py-10 text-center"><h3 className="font-display text-xl">Nothing here yet</h3><p className="mt-2 text-sm text-muted-foreground">Try another year or chapter.</p></div> : <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{page.items.map(item => { const previewing = preview?.id === item.id, wide = voiceId === item.id || editor?.id === item.id; return <li key={item.id} className={`panel-muted flex min-w-0 flex-col p-2.5 ${wide ? "sm:col-span-2 lg:col-span-3" : ""}`}><div className={`flex flex-col gap-3 ${wide ? "sm:flex-row sm:items-start" : ""}`}><div className={`relative flex shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-card text-muted-foreground shadow-[inset_0_0_0_1px_var(--panel-stroke)] ${previewing ? "p-2" : "aspect-[4/3]"} ${wide ? "sm:w-56" : ""}`}>{previewing && preview ? <>
{/* eslint-disable-next-line @next/next/no-img-element */}
<img src={preview.src} alt={`Photo for the memory saved ${memoryDate(item, query.timeZone)}`} width={preview.width} height={preview.height} className="max-h-80 w-auto max-w-full rounded-xl object-contain" /><button className="glass absolute top-2 right-2 flex size-11 items-center justify-center rounded-full text-foreground disabled:opacity-50" disabled={disabled} onClick={clearPreview}><X size={17} aria-hidden /><span className="sr-only">Close</span></button></> : <ImageIcon aria-hidden size={28} />}</div><div className="min-w-0 flex-1 px-1.5 pb-1"><p className="text-xs font-bold text-muted-foreground">{memoryProvenance(item)} {memoryDate(item, query.timeZone)}{!item.mine ? " · Shared with you" : ""}</p><h3 className="mt-1 break-words text-base font-bold">{item.annotation?.occasion ?? memoryAvailability[item.availability]}</h3>{item.annotation?.chapterId && <p className="mt-1.5 inline-flex max-w-full items-center gap-1.5 rounded-full bg-accent/12 px-2.5 py-0.5 text-xs font-bold text-accent [overflow-wrap:anywhere]"><Tag size={12} className="shrink-0" aria-hidden />{chapters.find(value => value.id === item.annotation?.chapterId)?.title ?? "Your chapter"}</p>}{(item.annotation?.occasion || item.availability === "access_lost" || !memorySelectable(item)) && <p className="mt-1.5 text-sm text-muted-foreground">{item.annotation?.occasion ? `${memoryAvailability[item.availability]}. ` : ""}{item.availability === "access_lost" ? "Only your labels are left." : !memorySelectable(item) ? "Can't be added to a recap." : ""}</p>}<div className="mt-3 flex flex-wrap items-center gap-1.5">{memorySelectable(item) && <><button className={action} disabled={disabled || stale} onClick={() => void showPreview(item)}><Eye size={15} aria-hidden />View photo<span className="sr-only"> saved {memoryDate(item, query.timeZone)}</span></button>{voiceEnabled && <button id={`${id}-voice-${item.id}`} className={action} disabled={disabled || stale} onClick={() => { clearPreview(); setEditorId(null); setVoiceId(item.id); }}><Mic size={15} aria-hidden />Voice or text note<span className="sr-only"> for {memoryDate(item, query.timeZone)}</span></button>}<label className={`${action} cursor-pointer has-[:checked]:bg-accent/15 has-[:checked]:text-accent has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50`}><input type="checkbox" className="size-4 accent-accent" checked={selected.some(value => value.id === item.id)} disabled={disabled || stale || selected.length >= 12 && !selected.some(value => value.id === item.id)} onChange={event => { clearPreview(); setSelected(previous => event.target.checked ? [...previous, item] : previous.filter(value => value.id !== item.id)); }} />Add to recap<span className="sr-only"> saved {memoryDate(item, query.timeZone)}</span></label></>}{item.mine && <button className={action} disabled={disabled || stale} onClick={() => setEditorId(item.id)}><Tag size={15} aria-hidden />Edit labels<span className="sr-only"> for {memoryDate(item, query.timeZone)}</span></button>}</div>{previewing && item.source?.kind === "strip" && <div className="mt-3"><p className="text-sm text-muted-foreground">Copy this strip into a new project as a single image. You won&apos;t be able to edit its photos or text separately.</p><div className="mt-2 flex flex-wrap gap-1.5"><button className="btn btn-tinted min-h-10 text-sm" disabled={disabled || stale} onClick={() => void duplicateImage(item)}><Copy size={15} aria-hidden /> Copy to My projects</button><a className="btn btn-plain min-h-10 text-sm" href="/projects">My projects</a></div></div>}</div></div>{voiceId === item.id && <VoiceMemoryEntry key={`${runtime.activity.ownerId}:${item.id}`} ownerId={runtime.activity.ownerId} activityId={item.id} onClose={() => { setVoiceId(null); requestAnimationFrame(() => document.getElementById(`${id}-voice-${item.id}`)?.focus()); }} />}{editor?.id === item.id && <MemoryLabelEditor key={`${item.id}-${item.annotation?.revision}`} item={item} chapters={chapters} busy={disabled} stale={stale} onCancel={() => setEditorId(null)} onSave={(chapterId, occasion) => { void mutate(signal => runtime.activity.annotate({ id: item.id, expectedRevision: item.annotation!.revision, chapterId, occasion }, signal), "Labels saved."); }} />}</li>; })}</ul>}<div className="mt-4 flex flex-wrap gap-2 empty:hidden">{query.after && <button disabled={disabled} className="btn btn-quiet min-h-10 text-sm" onClick={() => void refresh()}>Back to newest</button>}{page.nextCursor && <button disabled={disabled || stale} className="btn btn-quiet min-h-10 text-sm" onClick={() => void run(async signal => { clearPreview(); await load({ ...query, after: page.nextCursor }, signal); heading.current?.focus(); })}>Show older</button>}</div></>}
    </section>
    {page && !lost && <>
      <div className="grid gap-5 lg:grid-cols-2">
        <div id={`${id}-recap`} tabIndex={-1} className="tile-stack scroll-mt-5 rounded-[var(--radius-panel)] outline-none"><MemoryRecap key={`${query.year}-${query.timeZone}-${query.chapterId}-${generation}-${selected.map(value => value.id).join()}`} items={selected} year={query.year} timeZone={query.timeZone} clients={runtime} disabled={busy || stale || voiceId !== null} onBusy={setMediaBusy} onClear={clearMedia} /></div>
        <MemoryChapters key={generation} chapters={chapters} busy={disabled} stale={stale} onSave={(chapterId, revision, title) => mutate(signal => runtime.activity.putChapter({ id: chapterId, expectedRevision: revision, title }, signal), "Chapter saved.")} onDelete={value => run(async signal => { clearMedia(); await runtime.activity.deleteChapter(value.id, value.revision, signal); const next = { ...query, after: null, chapterId: query.chapterId === value.id ? null : query.chapterId }; if (chapter === value.id) setChapter(""); await load(next, signal); setNote("Chapter deleted."); heading.current?.focus(); }, true)} />
      </div>
      {summary && <details className="group panel p-4 sm:p-6"><summary className="flex min-h-9 cursor-pointer list-none items-center gap-3 rounded-xl focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring [&::-webkit-details-marker]:hidden"><span className="glyph bg-[#0ea5e9]"><ChartColumn size={18} strokeWidth={2.25} aria-hidden /></span><span className="flex-1 font-display text-xl leading-tight">{summary.year} totals (UTC)</span><ChevronDown size={18} aria-hidden className="text-muted-foreground transition-transform duration-300 ease-[var(--spring-soft)] group-open:rotate-180 motion-reduce:transition-none" /></summary><p className="mt-4 text-sm text-muted-foreground">{total} records this year, including ones whose photos have expired. Counted in UTC and not filtered by chapter.</p><dl className="mt-5 grid grid-cols-6 gap-x-2 gap-y-5 sm:grid-cols-12">{summary.months.map(month => <div key={month.month} className="flex flex-col items-center gap-1.5"><dt className="order-last text-xs font-bold text-muted-foreground">{new Intl.DateTimeFormat("en-AU", { month: "short", timeZone: "UTC" }).format(new Date(Date.UTC(summary.year, month.month - 1, 1)))}</dt><dd className="flex w-full flex-col items-center gap-1.5"><span className="flex h-20 w-full items-end justify-center" aria-hidden><span className={`w-full max-w-7 rounded-t-lg rounded-b-sm ${month.total ? "bg-[#0ea5e9]" : "bg-muted"}`} style={{ height: `${Math.max(4, month.total / peak * 100)}%` }} /></span><span className="text-sm font-bold tabular-nums">{month.total}</span></dd></div>)}</dl>{summary.outsideCalendar > 0 && <p className="mt-4 text-sm">{summary.outsideCalendar} records have dates outside the supported range.</p>}</details>}
    </>}
  </div>;
}
