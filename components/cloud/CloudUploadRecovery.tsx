"use client";

import { useEffect, useRef, useState } from "react";
import type { CloudUploadManager, CloudUploadRecord } from "@/lib/projects/cloud-upload";
import { cloudControl, cloudSize } from "./CloudControls";

interface Props {
  uploads: CloudUploadManager; disabled: boolean;
  openProject(id: string): void;
  runAction(work: (signal: AbortSignal) => Promise<void>): Promise<void>;
}

export function CloudUploadRecovery({ uploads, disabled, openProject, runAction }: Props) {
  const [records, setRecords] = useState<CloudUploadRecord[]>([]), [error, setError] = useState(false);
  const [limit, setLimit] = useState(8), [dismissing, setDismissing] = useState<string | null>(null);
  const [notice, setNotice] = useState(false), [focusTarget, setFocusTarget] = useState<string | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    void uploads.list().then(items => { if (mounted.current) setRecords(items.filter(record => record.state !== "ready")); }).catch(() => { if (mounted.current) setError(true); });
    return () => { mounted.current = false; };
  }, [uploads]);
  useEffect(() => { if (focusTarget && !disabled) document.getElementById(focusTarget)?.focus(); }, [focusTarget, disabled]);
  if (!records.length && !error && !notice) return null;
  return <section className="mt-8 border-t border-border pt-6" aria-labelledby="account-recovery-heading">
    <h3 id="account-recovery-heading" tabIndex={-1} className="text-lg font-semibold outline-none">Upload tracking on this device</h3>
    <p className="mt-2 max-w-2xl text-sm leading-relaxed text-foreground/70">Unfinished uploads, including inaccessible projects. Check the project before retrying; pending files may already be uploaded.</p>
    {error && <div className="mt-3"><p role="alert" className="text-sm">Upload tracking could not be read. Your original files are unchanged.</p><button className={`${cloudControl} mt-2 border border-border`} disabled={disabled} onClick={() => void runAction(async () => { const items = await uploads.list(); if (mounted.current) { setRecords(items.filter(record => record.state !== "ready")); setError(false); } })}>Retry reading tracking</button></div>}
    {notice && <p role="status" className="mt-3 text-sm">Local tracking dismissed. No cloud original was deleted and no reserved space was released.</p>}
    <ul className="mt-4" aria-label="Account upload tracking">{records.slice(0, limit).map((record, index) => <li key={record.id} className="border-t border-border py-4">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="font-medium">{record.asset.kind === "photo" ? "Photo" : "Decoration"} upload {index + 1}</p><p className="mt-1 text-sm text-foreground/70">{new Date(record.createdAt).toLocaleDateString("en-AU")} · {cloudSize(record.asset.bytes)} · {record.state === "prepared" ? "Prepared locally" : record.state === "failed" ? "Could not finish" : "Cloud confirmation pending"}</p></div><div className="flex flex-wrap gap-2"><button className={`${cloudControl} border border-border`} disabled={disabled} onClick={() => openProject(record.projectId)}>Open project recovery</button><button id={`account-dismiss-${record.id}`} className={`${cloudControl} underline underline-offset-4`} disabled={disabled} onClick={() => { setNotice(false); setDismissing(record.id); setFocusTarget(`account-confirm-dismiss-${record.id}`); }}>Dismiss tracking…</button></div></div>
      {dismissing === record.id && <div className="mt-3 max-w-2xl rounded-xl bg-muted p-4"><p className="text-sm leading-relaxed">Dismiss this local record? This removes its retry information from this browser. It does not cancel a server operation, delete an original or release cloud space. Keep your original file and avoid a duplicate upload if its result is uncertain.</p><div className="mt-3 flex flex-wrap gap-2"><button id={`account-confirm-dismiss-${record.id}`} className={`${cloudControl} border border-border`} disabled={disabled} onClick={() => void runAction(async () => { await uploads.forget(record.id); const items = await uploads.list(); if (mounted.current) { setRecords(items.filter(record => record.state !== "ready")); setDismissing(null); setNotice(true); setFocusTarget("account-recovery-heading"); } })}>Dismiss local tracking</button><button className={cloudControl} disabled={disabled} onClick={() => { setDismissing(null); setFocusTarget(`account-dismiss-${record.id}`); }}>Keep tracking</button></div></div>}
    </li>)}</ul>
    {records.length > limit && <button className={`${cloudControl} mt-3 border border-border`} onClick={() => setLimit(previous => previous + 8)}>Show more upload records</button>}
  </section>;
}
