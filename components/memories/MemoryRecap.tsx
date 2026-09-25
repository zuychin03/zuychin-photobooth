"use client";

import { useEffect, useId, useRef, useState } from "react";
import { cloudControl, cloudInput } from "@/components/cloud/CloudControls";
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
  return <section aria-labelledby={`${id}-title`} className="mt-8 border-t border-border py-7"><h2 id={`${id}-title`} className="font-display text-2xl font-semibold">Your year, gathered together</h2><p className="mt-2 max-w-2xl text-sm leading-relaxed text-foreground/75">Choose up to 12 available photos across the pages of this year. Your recap uses their saved or verified dates. Expired photos cannot be recovered.</p><p className="mt-4 text-sm font-medium" role="status">{items.length} of 12 photos selected</p>{items.length > 0 && <><label htmlFor={`${id}-name`} className="mt-4 block max-w-xl text-sm font-medium">Recap title<input id={`${id}-name`} className={`${cloudInput} mt-2`} value={title} maxLength={120} disabled={disabled || busy} onChange={event => { clear(); setTitle(event.target.value); }} /></label><ol className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-sm">{items.map((item, index) => <li key={item.id}>{index + 1}. {item.annotation?.occasion || memoryDate(item, timeZone)}</li>)}</ol><div className="mt-5 flex flex-wrap gap-2"><button className={`${cloudControl} bg-accent text-accent-foreground`} disabled={disabled || busy || !title.trim()} onClick={() => void build()}>Build recap</button><button className={`${cloudControl} border border-border`} disabled={disabled || busy} onClick={onClear}>Clear selection</button>{busy && <button className={`${cloudControl} border border-border`} onClick={() => work.current?.abort()}>Cancel image processing</button>}</div></>}{busy && <p className="mt-4 text-sm" role="status">Checking photo access and processing one image at a time…</p>}{error && <p ref={errorMessage} tabIndex={-1} className="mt-4 text-sm outline-none" role="alert">{error}</p>}{result && <div className="mt-6"><h3 ref={resultHeading} tabIndex={-1} className="mb-4 font-display text-xl outline-none">Recap preview</h3><div className="max-w-2xl overflow-hidden rounded-2xl border border-border bg-muted p-3">
{/* eslint-disable-next-line @next/next/no-img-element */}
<img src={result.src} alt={`Preview of ${title}`} width={result.width} height={result.height} className="mx-auto max-h-[32rem] w-auto max-w-full object-contain" /></div><p className="mt-3 text-sm text-foreground/75">{result.width} × {result.height} pixels · PNG · {(result.blob.size / 1024 / 1024).toFixed(1)} MB. Download keeps this recap on your device.</p><button className={`${cloudControl} mt-4 bg-accent text-accent-foreground`} disabled={busy || disabled} onClick={() => void download()}>Download recap</button></div>}</section>;
}
