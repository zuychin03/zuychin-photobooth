"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Download, LoaderCircle, Sparkles } from "lucide-react";
import type { MemoryActivity } from "@/lib/memories/activity-contract";
import { assertMemorySource, renderAnnualMemoryRecap, type MemoryMediaClients } from "@/lib/memories/memory-media";
import { memoryDate, memoryError } from "@/lib/memories/memory-editor";

export function MemoryRecap({ items, year, timeZone, clients, disabled, onBusy, onClear }: { items: MemoryActivity[]; year: number; timeZone: string; clients: MemoryMediaClients; disabled: boolean; onBusy(value: boolean): void; onClear(): void }) {
  const id = useId(), active = useRef(true), work = useRef<AbortController | null>(null), url = useRef<string | null>(null);
  const resultHeading = useRef<HTMLHeadingElement>(null), errorMessage = useRef<HTMLParagraphElement>(null);
  const [title, setTitle] = useState(`${year} · A year in photos`), [result, setResult] = useState<{ blob: Blob; width: number; height: number; src: string } | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const clear = () => { if (url.current) URL.revokeObjectURL(url.current); url.current = null; setResult(null); };
  useEffect(() => { active.current = true; return () => { active.current = false; work.current?.abort(); if (url.current) URL.revokeObjectURL(url.current); onBusy(false); }; }, [onBusy]);
  useEffect(() => { if (result) resultHeading.current?.focus(); }, [result]);
  useEffect(() => { if (error) errorMessage.current?.focus(); }, [error]);
  const run = async (operation: (signal: AbortSignal) => Promise<void>) => {
    if (work.current || disabled) return;
    const controller = new AbortController(); work.current = controller; setBusy(true); onBusy(true); setError(null);
    try { await operation(controller.signal); }
    catch (failure) { if (active.current) { clear(); setError(memoryError(failure)); } }
    finally { if (work.current === controller) work.current = null; if (active.current) { setBusy(false); onBusy(false); } }
  };
  const build = () => run(async signal => {
    clear();
    const next = await renderAnnualMemoryRecap(items, title.trim(), items.map(item => `${memoryDate(item, timeZone)}${item.annotation?.occasion ? ` · ${item.annotation.occasion}` : ""}`.slice(0, 100)), clients, signal);
    if (signal.aborted || !active.current) return;
    const src = URL.createObjectURL(next.blob); url.current = src; setResult({ ...next, src });
  });
  const download = () => run(async signal => {
    if (!result) return;
    for (const item of items) await assertMemorySource(item, clients, signal);
    if (signal.aborted || !active.current) return;
    const link = document.createElement("a"); link.href = result.src; link.download = `zuychin-${year}-recap.png`; document.body.append(link); link.click(); link.remove();
  });
  return <section aria-labelledby={`${id}-title`} className="panel p-4 sm:p-6"><div className="flex min-w-0 items-center gap-3"><span className="glyph bg-[#10b981]"><Sparkles size={18} strokeWidth={2.25} aria-hidden /></span><h2 id={`${id}-title`} className="font-display text-xl leading-tight">Yearly recap</h2></div><div className="mt-4"><p className="text-sm font-bold tabular-nums" role="status">{items.length} of 12 photos selected</p><div className="mt-2 h-2 overflow-hidden rounded-full bg-muted" aria-hidden><div className="h-full rounded-full bg-[#10b981] transition-[width] duration-500 ease-[var(--spring-soft)] motion-reduce:transition-none" style={{ width: `${items.length / 12 * 100}%` }} /></div></div>{items.length > 0 && <><ol className="mt-4 flex flex-wrap gap-1.5 text-sm">{items.map((item, index) => <li key={item.id} className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-muted px-3 py-1 [overflow-wrap:anywhere]"><span className="font-bold tabular-nums text-muted-foreground">{index + 1}.</span> {item.annotation?.occasion || memoryDate(item, timeZone)}</li>)}</ol><label htmlFor={`${id}-name`} className="mt-4 block text-sm font-bold">Recap title<input id={`${id}-name`} className="field mt-1.5 font-medium" value={title} maxLength={120} disabled={disabled || busy} onChange={event => { clear(); setTitle(event.target.value); }} /></label><div className="mt-4 flex flex-wrap gap-2"><button className="btn btn-primary" disabled={disabled || busy || !title.trim()} onClick={() => void build()}><Sparkles size={17} aria-hidden /> Make recap</button><button className="btn btn-quiet" disabled={disabled || busy} onClick={onClear}>Clear selection</button>{busy && <button className="btn btn-plain" onClick={() => work.current?.abort()}>Cancel</button>}</div></>}{busy && <p className="mt-4 flex items-center gap-2 text-sm font-bold" role="status"><LoaderCircle size={16} aria-hidden className="animate-spin text-accent motion-reduce:animate-none" />Making your recap…</p>}{error && <p ref={errorMessage} tabIndex={-1} className="notice mt-4 border border-destructive/25 bg-destructive/8 font-bold text-destructive outline-none" role="alert">{error}</p>}{result && <div className="mt-5"><h3 ref={resultHeading} tabIndex={-1} className="mb-3 font-bold outline-none">Recap preview</h3><div className="panel-muted overflow-hidden p-3">
{/* eslint-disable-next-line @next/next/no-img-element */}
<img src={result.src} alt={`Preview of ${title}`} width={result.width} height={result.height} className="mx-auto max-h-[32rem] w-auto max-w-full rounded-xl object-contain" /></div><p className="mt-2 text-sm text-muted-foreground">{result.width} × {result.height} pixels · PNG · {(result.blob.size / 1024 / 1024).toFixed(1)} MB</p><button className="btn btn-primary mt-3" disabled={busy || disabled} onClick={() => void download()}><Download size={17} aria-hidden /> Download recap</button></div>}</section>;
}
