"use client";
import { useEffect, useRef, useState } from "react";
import { History } from "lucide-react";
import { challengeDraftMessage, type ChallengeDraftEntry, type ChallengeDraftJournal } from "@/lib/memories/challenge-drafts";

export function ChallengeDraftRecovery({ journal, disabled, runAction, openProject }: {
  journal: ChallengeDraftJournal; disabled: boolean; runAction(work: (signal: AbortSignal) => Promise<void>): Promise<void>; openProject(id: string): void;
}) {
  const [items, setItems] = useState<ChallengeDraftEntry[]>([]), [error, setError] = useState<string | null>(null), [confirm, setConfirm] = useState<string | null>(null), [notice, setNotice] = useState(false);
  const live = useRef(false), heading = useRef<HTMLHeadingElement>(null), confirmation = useRef<HTMLButtonElement>(null);
  useEffect(() => { live.current = true; void journal.list().then(next => { if (live.current) setItems(next); }).catch(error => { if (live.current) setError(challengeDraftMessage(error)); }); return () => { live.current = false; }; }, [journal]);
  useEffect(() => { if (confirm) confirmation.current?.focus(); }, [confirm]);
  if (!items.length && !error && !notice) return null;
  return <section className="panel p-4 sm:p-6" aria-labelledby="challenge-draft-recovery-heading">
    <div className="flex min-w-0 items-center gap-3"><span className="glyph bg-[#64748b]"><History size={18} strokeWidth={2.25} aria-hidden /></span><h3 id="challenge-draft-recovery-heading" tabIndex={-1} ref={heading} className="font-display text-xl leading-tight outline-none">Unfinished challenges</h3></div>
    <p className="mt-3 max-w-2xl text-sm text-muted-foreground">Some of these may have already gone through. Open the project to check before trying again.</p>
    {notice && <p role="status" className="mt-3 text-sm font-bold">Dismissed.</p>}
    {error && <div className="notice mt-3 border border-destructive/25 bg-destructive/8"><p role="alert">{error}</p><button className="btn btn-quiet mt-2 min-h-10 text-sm" disabled={disabled} onClick={() => void runAction(async () => { const next = await journal.list(); if (live.current) { setItems(next); setError(null); } })}>Try again</button></div>}
    <ul className="mt-3 divide-y divide-border">{items.map((item, index) => <li className="py-4" key={item.id}>{"readOnly" in item ? <p className="text-sm">Draft {index + 1} needs a newer version of the app.</p> : <>
      <div className="flex flex-wrap items-center justify-between gap-3"><div className="min-w-0"><p className="font-bold">{item.kind === "create" ? "New challenge" : "Partial result proposal"} · {item.state === "pending" ? "Waiting for confirmation" : "Draft"}</p>
      <p className="mt-0.5 text-sm text-muted-foreground">Saved {new Date(item.updatedAt).toLocaleString("en-AU")}</p></div>
      <div className="flex flex-wrap gap-1.5"><button className="btn btn-quiet min-h-10 text-sm" disabled={disabled} onClick={() => openProject(item.projectId)}>Open project</button><button className="btn btn-plain min-h-10 text-sm" disabled={disabled} onClick={() => { setNotice(false); setConfirm(item.id); }}>Dismiss…</button></div></div>
      {confirm === item.id && <div className="notice mt-3 max-w-2xl"><p>Dismiss this draft? If it already went through, it stays online. Check the project before starting another.</p><div className="mt-3 flex flex-wrap gap-2"><button ref={confirmation} className="btn btn-danger min-h-10 text-sm" disabled={disabled} onClick={() => void runAction(async () => { await journal.forget(item.id, item.revision); const next = await journal.list(); if (live.current) { setItems(next); setConfirm(null); setNotice(true); heading.current?.focus(); } })}>Dismiss</button><button className="btn btn-plain min-h-10 text-sm" disabled={disabled} onClick={() => { setConfirm(null); heading.current?.focus(); }}>Keep it</button></div></div>}
    </>}</li>)}</ul>
  </section>;
}
