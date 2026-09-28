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
    <h3 id="account-recovery-heading" tabIndex={-1} className="text-lg font-semibold outline-none">Unfinished uploads</h3>
    <p className="mt-2 max-w-2xl text-sm leading-relaxed text-foreground/70">Some of these may have finished. Check the project before trying again.</p>
    {error && <div className="mt-3"><p role="alert" className="text-sm">Couldn&apos;t load unfinished uploads.</p><button className={`${cloudControl} mt-2 border border-border`} disabled={disabled} onClick={() => void runAction(async () => { const items = await uploads.list(); if (mounted.current) { setRecords(items.filter(record => record.state !== "ready")); setError(false); } })}>Try again</button></div>}
    {notice && <p role="status" className="mt-3 text-sm">Removed from the list. Nothing was deleted from the cloud.</p>}
    <ul className="mt-4" aria-label="Unfinished uploads">{records.slice(0, limit).map((record, index) => <li key={record.id} className="border-t border-border py-4">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="font-medium">{record.asset.kind === "photo" ? "Photo" : "Decoration"} upload {index + 1}</p><p className="mt-1 text-sm text-foreground/70">{new Date(record.createdAt).toLocaleDateString("en-AU")} · {cloudSize(record.asset.bytes)} · {record.state === "prepared" ? "Not started" : record.state === "failed" ? "Didn't finish" : "Waiting for confirmation"}</p></div><div className="flex flex-wrap gap-2"><button className={`${cloudControl} border border-border`} disabled={disabled} onClick={() => openProject(record.projectId)}>Open project</button><button id={`account-dismiss-${record.id}`} className={`${cloudControl} underline underline-offset-4`} disabled={disabled} onClick={() => { setNotice(false); setDismissing(record.id); setFocusTarget(`account-confirm-dismiss-${record.id}`); }}>Remove from list…</button></div></div>
      {dismissing === record.id && <div className="mt-3 max-w-2xl rounded-xl bg-muted p-4"><p className="text-sm leading-relaxed">Remove this from the list? Nothing is deleted from the cloud. If you&apos;re not sure it finished, check the project before uploading it again.</p><div className="mt-3 flex flex-wrap gap-2"><button id={`account-confirm-dismiss-${record.id}`} className={`${cloudControl} border border-border`} disabled={disabled} onClick={() => void runAction(async () => { await uploads.forget(record.id); const items = await uploads.list(); if (mounted.current) { setRecords(items.filter(record => record.state !== "ready")); setDismissing(null); setNotice(true); setFocusTarget("account-recovery-heading"); } })}>Remove</button><button className={cloudControl} disabled={disabled} onClick={() => { setDismissing(null); setFocusTarget(`account-dismiss-${record.id}`); }}>Cancel</button></div></div>}
    </li>)}</ul>
    {records.length > limit && <button className={`${cloudControl} mt-3 border border-border`} onClick={() => setLimit(previous => previous + 8)}>Show more</button>}
  </section>;
}
