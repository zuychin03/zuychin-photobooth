"use client";

import { useAppNavigationGuard } from "@/components/AppNavigation";

import { useEffect, useId, useRef, useState } from "react";
import { ImageIcon, LoaderCircle, RefreshCw } from "lucide-react";
import { Dropdown } from "@/components/Dropdown";
import { cloudControl, cloudInput } from "@/components/cloud/CloudControls";
import type { MemoryRuntime } from "@/lib/memories/memory-runtime";
import type { ActivitySummary, MemoryActivity, MemoryChapter } from "@/lib/memories/activity-contract";
import { validateMemoryBrowse, type MemoryBrowse, type MemoryBrowsePage } from "@/lib/memories/activity-browse";
import { memoryAvailability, memoryDate, memoryError, memoryProvenance, memorySelectable } from "@/lib/memories/memory-editor";
import { prepareMemoryThumbnail } from "@/lib/memories/memory-media";
import { MemoryChapters, MemoryLabelEditor } from "./MemoryLabels";
import { MemoryRecap } from "./MemoryRecap";
import { VoiceMemoryEntry } from "./VoiceMemoryEntry";
import { duplicateMemoryImage, MemoryImageCopyError } from "@/lib/memories/duplicate-image";

const secondary = `${cloudControl} border border-border hover:bg-muted`;
const primary = `${cloudControl} bg-accent text-accent-foreground hover:opacity-90`;
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
    if (busy || mediaBusy || editorId !== null) { setNote("Finish saving or cancel your changes before leaving."); return false; }
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
    catch { setError("Enter a year from 1970 to 2198 and an IANA timezone such as Australia/Sydney."); return; }
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
  const duplicateImage = (item: MemoryActivity) => run(async signal => {
    await duplicateMemoryImage(item, runtime.retained, signal);
    runtime.activity.assertActive(signal);
    setNote("A finished image copy was saved to My projects for this account. Its original photo cells and text remain flattened.");
    heading.current?.focus();
  });
  return <div className="mt-8">
    <form onSubmit={event => { event.preventDefault(); filter(); }} className="grid items-end gap-4 border-y border-border py-6 sm:grid-cols-[7rem_1fr_1fr_auto]"><label htmlFor={`${id}-year`} className="text-sm font-medium">Year<input id={`${id}-year`} className={`${cloudInput} mt-2`} type="number" min={1970} max={2198} value={year} disabled={disabled} onChange={event => setYear(event.target.value)} required /></label><label htmlFor={`${id}-zone`} className="min-w-0 text-sm font-medium">Display timezone<input id={`${id}-zone`} className={`${cloudInput} mt-2`} value={zone} disabled={disabled} onChange={event => setZone(event.target.value)} maxLength={100} autoCapitalize="none" spellCheck={false} required /></label><Dropdown label="Filter by chapter" showLabel value={chapter} options={[{ value: "", label: "All memories" }, ...chapters.map(value => ({ value: value.id, label: value.title }))]} disabled={disabled} onChange={setChapter} /><button className={primary} disabled={disabled}>Show memories</button></form>
    <div className="mt-6 flex flex-wrap items-start justify-between gap-3"><div><h2 ref={heading} tabIndex={-1} className="font-display text-2xl font-semibold outline-none">{lost ? "Check your memory access" : `${query.year} in ${query.timeZone}`}</h2><p className="mt-2 max-w-2xl text-sm leading-relaxed text-foreground/75">Dates show when photos were saved, in your display timezone.</p></div><button disabled={disabled} className={secondary} onClick={() => void refresh()}><RefreshCw size={16} aria-hidden /> Refresh memories</button></div>
    {busy && <p role="status" className="mt-4 flex items-center gap-2 text-sm"><LoaderCircle size={16} aria-hidden className="animate-spin motion-reduce:animate-none" /> Checking your memories…</p>}
    {error && <p role="alert" className="mt-4 max-w-2xl text-sm font-medium">{error}</p>}{note && <p role="status" className="mt-4 text-sm">{note}</p>}{stale && !lost && <p className="mt-3 text-sm">Refresh before making more changes. A request may have arrived even if its confirmation did not.</p>}
    {page && !lost && <>{selected.length > 0 && <a href={`#${id}-recap`} className={`${secondary} mt-5`}>Review {selected.length} selected photos</a>}<p className="mt-5 text-sm text-foreground/70">Newest first. This is a limited history, not a full photo archive.</p>{!page.items.length ? <section className="py-12"><h3 className="font-display text-2xl">Room for a new chapter</h3><p className="mt-3 max-w-xl text-sm text-foreground/75">No memories here yet. Try another year or chapter.</p></section> : <ul className="mt-3 divide-y divide-border">{page.items.map(item => <li key={item.id} className="py-5"><div className="flex items-start gap-3 sm:gap-4"><div className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-muted text-foreground/60"><ImageIcon aria-hidden size={22} /></div><div className="min-w-0 flex-1"><p className="text-sm text-foreground/70">{memoryProvenance(item)} {memoryDate(item, query.timeZone)}{!item.mine ? " · Shared with you" : ""}</p><h3 className="mt-1 break-words text-lg font-medium">{item.annotation?.occasion ?? memoryAvailability[item.availability]}</h3>{item.annotation?.chapterId && <p className="mt-1 break-words text-sm text-accent">{chapters.find(value => value.id === item.annotation?.chapterId)?.title ?? "Your chapter"}</p>}<p className="mt-2 text-sm text-foreground/75">{item.annotation?.occasion ? `${memoryAvailability[item.availability]}. ` : ""}{item.availability === "access_lost" ? "Only your activity record and labels remain." : !memorySelectable(item) ? "This record cannot be added to a photo recap." : "Access is checked again before opening."}</p><div className="mt-3 flex flex-wrap items-center gap-2">{memorySelectable(item) && <><button className={secondary} disabled={disabled || stale} onClick={() => void showPreview(item)}>View photo<span className="sr-only"> saved {memoryDate(item, query.timeZone)}</span></button>{voiceEnabled && <button id={`${id}-voice-${item.id}`} className={secondary} disabled={disabled || stale} onClick={() => { clearPreview(); setEditorId(null); setVoiceId(item.id); }}>Voice or text note<span className="sr-only"> for {memoryDate(item, query.timeZone)}</span></button>}<label className="flex min-h-11 items-center gap-2 px-2 text-sm"><input type="checkbox" className="size-5 accent-accent" checked={selected.some(value => value.id === item.id)} disabled={disabled || stale || selected.length >= 12 && !selected.some(value => value.id === item.id)} onChange={event => { clearPreview(); setSelected(previous => event.target.checked ? [...previous, item] : previous.filter(value => value.id !== item.id)); }} />Add to recap<span className="sr-only"> saved {memoryDate(item, query.timeZone)}</span></label></>}{item.mine && <button className={secondary} disabled={disabled || stale} onClick={() => setEditorId(item.id)}>Edit labels<span className="sr-only"> for {memoryDate(item, query.timeZone)}</span></button>}</div>{preview?.id === item.id && <div className="mt-4"><div className="inline-block max-w-full rounded-xl border border-border bg-muted p-3">
{/* eslint-disable-next-line @next/next/no-img-element */}
<img src={preview.src} alt={`Photo for the memory saved ${memoryDate(item, query.timeZone)}`} width={preview.width} height={preview.height} className="max-h-80 w-auto max-w-full object-contain" /></div><div><button className={`${secondary} mt-2`} disabled={disabled} onClick={clearPreview}>Close photo preview</button></div>{item.source?.kind === "strip" && <div className="mt-4 max-w-xl"><p className="text-sm text-foreground/75">Duplicate this finished image into an account-private local project. The whole image stays intact; its original photo cells and text cannot be edited separately. The camera date is unknown.</p><button className={`${secondary} mt-2`} disabled={disabled || stale} onClick={() => void duplicateImage(item)}>Duplicate as image</button><a className={`${secondary} ml-2 mt-2`} href="/projects">My projects</a></div>}</div>}{voiceId === item.id && <VoiceMemoryEntry key={`${runtime.activity.ownerId}:${item.id}`} ownerId={runtime.activity.ownerId} activityId={item.id} onClose={() => { setVoiceId(null); requestAnimationFrame(() => document.getElementById(`${id}-voice-${item.id}`)?.focus()); }} />}{editor?.id === item.id && <MemoryLabelEditor key={`${item.id}-${item.annotation?.revision}`} item={item} chapters={chapters} busy={disabled} stale={stale} onCancel={() => setEditorId(null)} onSave={(chapterId, occasion) => { void mutate(signal => runtime.activity.annotate({ id: item.id, expectedRevision: item.annotation!.revision, chapterId, occasion }, signal), "Your memory labels were saved."); }} />}</div></div></li>)}</ul>}<div className="mt-5 flex flex-wrap gap-2">{query.after && <button disabled={disabled} className={secondary} onClick={() => void refresh()}>Back to newest</button>}{page.nextCursor && <button disabled={disabled || stale} className={secondary} onClick={() => void run(async signal => { clearPreview(); await load({ ...query, after: page.nextCursor }, signal); heading.current?.focus(); })}>Older memories</button>}</div>
      <div id={`${id}-recap`} tabIndex={-1} className="scroll-mt-5 outline-none"><MemoryRecap key={`${query.year}-${query.timeZone}-${query.chapterId}-${generation}-${selected.map(value => value.id).join()}`} items={selected} year={query.year} timeZone={query.timeZone} clients={runtime} disabled={busy || stale || voiceId !== null} onBusy={setMediaBusy} onClear={clearMedia} /></div>
      <MemoryChapters key={generation} chapters={chapters} busy={disabled} stale={stale} onSave={(chapterId, revision, title) => mutate(signal => runtime.activity.putChapter({ id: chapterId, expectedRevision: revision, title }, signal), "Your chapter was saved.")} onDelete={value => run(async signal => { clearMedia(); await runtime.activity.deleteChapter(value.id, value.revision, signal); const next = { ...query, after: null, chapterId: query.chapterId === value.id ? null : query.chapterId }; if (chapter === value.id) setChapter(""); await load(next, signal); setNote("The empty chapter was deleted."); heading.current?.focus(); }, true)} />
      {summary && <details className="mt-7 border-t border-border py-5"><summary className="min-h-11 cursor-pointer content-center font-medium focus-visible:outline-2 focus-visible:outline-ring">Your {summary.year} activity totals in UTC</summary><p className="mt-3 max-w-2xl text-sm leading-relaxed text-foreground/75">{total} own source records in this UTC calendar year. These totals include records whose photos are no longer available. They do not follow the timezone or chapter filter above.</p><dl className="mt-4 grid grid-cols-3 gap-4 sm:grid-cols-6">{summary.months.map(month => <div key={month.month}><dt className="text-sm text-foreground/70">{new Intl.DateTimeFormat("en-AU", { month: "short", timeZone: "UTC" }).format(new Date(Date.UTC(summary.year, month.month - 1, 1)))}</dt><dd className="mt-1 text-xl tabular-nums">{month.total}</dd></div>)}</dl>{summary.outsideCalendar > 0 && <p className="mt-3 text-sm">{summary.outsideCalendar} own records have dates outside the supported calendar.</p>}</details>}
    </>}
  </div>;
}
