"use client";

import { useEffect, useRef, useState } from "react";
import { CloudAlert } from "lucide-react";
import type { CloudUploadManager, CloudUploadRecord } from "@/lib/projects/cloud-upload";
import { cloudSize } from "./CloudControls";

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
  return <section className="panel p-4 sm:p-6" aria-labelledby="account-recovery-heading">
    <div className="flex min-w-0 items-center gap-3"><span className="glyph bg-[#64748b]"><CloudAlert size={18} strokeWidth={2.25} aria-hidden /></span><h3 id="account-recovery-heading" tabIndex={-1} className="font-display text-xl leading-tight outline-none">Unfinished uploads</h3></div>
    <p className="mt-3 text-sm text-muted-foreground">Some of these may have finished. Check the project before trying again.</p>
    {error && <div className="notice mt-3"><p role="alert" className="font-bold text-destructive">Couldn&apos;t load unfinished uploads.</p><button className="btn btn-quiet mt-2 min-h-10 text-sm" disabled={disabled} onClick={() => void runAction(async () => { const items = await uploads.list(); if (mounted.current) { setRecords(items.filter(record => record.state !== "ready")); setError(false); } })}>Try again</button></div>}
    {notice && <p role="status" className="notice mt-3">Removed from the list. Nothing was deleted from the cloud.</p>}
    <ul className="mt-3 divide-y divide-border" aria-label="Unfinished uploads">{records.slice(0, limit).map((record, index) => <li key={record.id} className="py-3.5">
      <div className="flex flex-wrap items-center justify-between gap-3"><div className="min-w-0"><p className="font-bold">{record.asset.kind === "photo" ? "Photo" : "Decoration"} upload {index + 1}</p><p className="mt-0.5 text-sm text-muted-foreground">{new Date(record.createdAt).toLocaleDateString("en-AU")} · {cloudSize(record.asset.bytes)} · {record.state === "prepared" ? "Not started" : record.state === "failed" ? "Didn't finish" : "Waiting for confirmation"}</p></div><div className="flex flex-wrap gap-1.5"><button className="btn btn-quiet min-h-10 text-sm" disabled={disabled} onClick={() => openProject(record.projectId)}>Open project</button><button id={`account-dismiss-${record.id}`} className="btn btn-plain min-h-10 text-sm" disabled={disabled} onClick={() => { setNotice(false); setDismissing(record.id); setFocusTarget(`account-confirm-dismiss-${record.id}`); }}>Remove from list…</button></div></div>
      {dismissing === record.id && <div className="notice mt-3"><p>Remove this from the list? Nothing is deleted from the cloud. If you&apos;re not sure it finished, check the project before uploading it again.</p><div className="mt-3 flex flex-wrap gap-2"><button id={`account-confirm-dismiss-${record.id}`} className="btn btn-danger min-h-10 text-sm" disabled={disabled} onClick={() => void runAction(async () => { await uploads.forget(record.id); const items = await uploads.list(); if (mounted.current) { setRecords(items.filter(record => record.state !== "ready")); setDismissing(null); setNotice(true); setFocusTarget("account-recovery-heading"); } })}>Remove</button><button className="btn btn-quiet min-h-10 text-sm" disabled={disabled} onClick={() => { setDismissing(null); setFocusTarget(`account-dismiss-${record.id}`); }}>Cancel</button></div></div>}
    </li>)}</ul>
    {records.length > limit && <button className="btn btn-quiet mt-2 text-sm" onClick={() => setLimit(previous => previous + 8)}>Show more</button>}
  </section>;
}
