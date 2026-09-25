"use client";
import { useEffect, useRef, useState } from "react";
import { challengeDraftMessage, type ChallengeDraftEntry, type ChallengeDraftJournal } from "@/lib/memories/challenge-drafts";
import { cloudControl } from "./CloudControls";

export function ChallengeDraftRecovery({ journal, disabled, runAction, openProject }: {
  journal: ChallengeDraftJournal; disabled: boolean; runAction(work: (signal: AbortSignal) => Promise<void>): Promise<void>; openProject(id: string): void;
}) {
  const [items, setItems] = useState<ChallengeDraftEntry[]>([]), [error, setError] = useState<string | null>(null), [confirm, setConfirm] = useState<string | null>(null), [notice, setNotice] = useState(false);
  const live = useRef(false), heading = useRef<HTMLHeadingElement>(null), confirmation = useRef<HTMLButtonElement>(null);
  useEffect(() => { live.current = true; void journal.list().then(next => { if (live.current) setItems(next); }).catch(error => { if (live.current) setError(challengeDraftMessage(error)); }); return () => { live.current = false; }; }, [journal]);
  useEffect(() => { if (confirm) confirmation.current?.focus(); }, [confirm]);
  if (!items.length && !error && !notice) return null;
  return <section className="mt-8 border-t border-border pt-6" aria-labelledby="challenge-draft-recovery-heading">
    <h3 id="challenge-draft-recovery-heading" tabIndex={-1} ref={heading} className="text-lg font-semibold outline-none">Challenge drafts on this device</h3>
    <p className="mt-2 max-w-2xl text-sm leading-relaxed text-foreground/70">These account drafts stay local. Unconfirmed requests may already exist online. Reopen the project before retrying; nothing sends automatically.</p>
    {notice && <p role="status" className="mt-3 text-sm">Local draft dismissed. No challenge, proposal, consent or original was changed online.</p>}
    {error && <div className="mt-3"><p role="alert" className="text-sm">{error}</p><button className={cloudControl} disabled={disabled} onClick={() => void runAction(async () => { const next = await journal.list(); if (live.current) { setItems(next); setError(null); } })}>Retry reading drafts</button></div>}
    <ul className="mt-4 divide-y divide-border">{items.map((item, index) => <li className="py-4" key={item.id}>{"readOnly" in item ? <p className="text-sm">Draft {index + 1} requires recovery or a newer app. Its data has been kept.</p> : <>
      <p className="font-medium">{item.kind === "create" ? "Challenge creation" : "Partial proposal"} · {item.state === "pending" ? "Confirmation pending" : "Draft"}</p>
      <p className="mt-1 text-sm text-foreground/70">Saved {new Date(item.updatedAt).toLocaleString("en-AU")}</p>
      <div className="mt-3 flex flex-wrap gap-2"><button className={`${cloudControl} border border-border`} disabled={disabled} onClick={() => openProject(item.projectId)}>Open project recovery</button><button className={`${cloudControl} underline underline-offset-4`} disabled={disabled} onClick={() => { setNotice(false); setConfirm(item.id); }}>Dismiss local draft…</button></div>
      {confirm === item.id && <div className="mt-3 max-w-2xl rounded-xl bg-muted p-4"><p className="text-sm leading-relaxed">Discard this device&apos;s saved choices and retry identity? An unconfirmed request may already have reached the server. This does not cancel a challenge, withdraw consent, delete an original or free cloud space. Check online before creating another.</p><div className="mt-3 flex flex-wrap gap-2"><button ref={confirmation} className={`${cloudControl} border border-border`} disabled={disabled} onClick={() => void runAction(async () => { await journal.forget(item.id, item.revision); const next = await journal.list(); if (live.current) { setItems(next); setConfirm(null); setNotice(true); heading.current?.focus(); } })}>Dismiss this local draft</button><button className={cloudControl} disabled={disabled} onClick={() => { setConfirm(null); heading.current?.focus(); }}>Keep saved draft</button></div></div>}
    </>}</li>)}</ul>
  </section>;
}
