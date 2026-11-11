"use client";

import { useEffect, useId, useRef, useState } from "react";
import { CloudUpload, LoaderCircle, RefreshCw } from "lucide-react";
import { Dropdown } from "@/components/Dropdown";
import type { CloudProjectClient } from "@/lib/projects/cloud-client";
import type { CloudProjectView } from "@/lib/projects/cloud-contract";
import type { CloudDesignSaveCoordinator } from "@/lib/projects/cloud-design-save";
import type { CloudDesignSaveEntry, CloudDesignSaveRecord } from "@/lib/projects/cloud-design-journal";
import { openProjectRepository, type ProjectListItem } from "@/lib/projects/storage";
import { cloudError, cloudSize } from "./CloudControls";

interface Props {
  client: CloudProjectClient; designs: CloudDesignSaveCoordinator; view: CloudProjectView;
  disabled: boolean; onBusy(busy: boolean): void;
  openRepository?: typeof openProjectRepository;
}
export function CloudDesignSavePanel({ client, designs, view, disabled, onBusy, openRepository = openProjectRepository }: Props) {
  const id = useId(), heading = useRef<HTMLHeadingElement>(null), live = useRef(false), running = useRef(false);
  const controller = useRef<AbortController | null>(null), busyCallback = useRef(onBusy);
  const confirmationOpen = useRef(false), keepRequest = useRef<HTMLButtonElement>(null);
  const [items, setItems] = useState<ProjectListItem[]>([]), [selected, setSelected] = useState("");
  const [records, setRecords] = useState<CloudDesignSaveEntry[]>([]), [busy, setBusy] = useState(false), [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null), [dismiss, setDismiss] = useState<string | null>(null);
  const projectId = view.project.id, locked = disabled || busy || dismiss !== null;
  useEffect(() => { if (dismiss) keepRequest.current?.focus(); }, [dismiss]);
  useEffect(() => { busyCallback.current = onBusy; }, [onBusy]);
  useEffect(() => {
    live.current = true;
    void designs.list().then(next => { if (live.current) setRecords(next); }).catch(() => { if (live.current) setError("Couldn't load unfinished saves. Refresh before saving again."); });
    return () => { live.current = false; controller.current?.abort(); if (running.current || confirmationOpen.current) busyCallback.current(false); };
  }, [designs, projectId]);
  const pending = records.filter((record): record is CloudDesignSaveRecord => !("readOnly" in record) && record.cloudProjectId === projectId && record.phase !== "complete");
  const readOnly = records.some(record => "readOnly" in record);
  const run = async (work: (signal: AbortSignal) => Promise<void>) => {
    if (running.current || disabled) return;
    const abort = new AbortController(); controller.current = abort; running.current = true;
    setBusy(true); onBusy(true); setError(null); setNotice(null);
    try { await work(abort.signal); client.assertActive(abort.signal); }
    catch (failure) {
      if (live.current) {
        const code = failure && typeof failure === "object" && "code" in failure ? String(failure.code) : "";
        const messages: Record<string, string> = {
          pending: "Finish or dismiss the unfinished save first.",
          conflict: "The cloud design has changed since this copy. Open the latest cloud design as a new copy instead.",
          upload_failed: "One of the photos couldn't be checked. Check the upload, then continue.",
          file_mismatch: "One of the photos is missing or has changed. Put the original photo back, then try again.",
          access_changed: "Someone's access or a photo has changed. Check access, then try again.",
          capacity: "This project has reached its save limit of 100 versions.",
          readonly: "An unfinished save needs a newer version of the app.",
          update_required: "Saving designs to the cloud isn't available on this server yet.",
        };
        setError(abort.signal.aborted ? "Stopped waiting. The save might still finish, so check it below before trying again." : messages[code] ?? cloudError(failure));
      }
    } finally {
      if (live.current) {
        try { const next = await designs.list(); if (live.current) setRecords(next); } catch { /* Preserve the last visible recovery record. */ }
        if (live.current) { setBusy(false); onBusy(confirmationOpen.current); if (!confirmationOpen.current) heading.current?.focus(); }
      }
      running.current = false;
    }
  };
  const inspect = () => run(async signal => {
    const repository = await openRepository({ kind: "account", ownerId: client.ownerId });
    try { const next = await repository.list(); client.assertActive(signal); if (live.current) { setItems(next); setLoaded(true); setSelected(""); } }
    finally { repository.close(); }
  });
  const prepare = () => run(async signal => {
    if (!selected) return;
    await client.designCapabilities(signal);
    const head = await client.designHead(projectId, signal), entries = await designs.list(); client.assertActive(signal);
    if (entries.some(record => "readOnly" in record || record.cloudProjectId === projectId && record.phase !== "complete")) throw { code: "pending" };
    const prior = entries.find((record): record is CloudDesignSaveRecord => !("readOnly" in record) && record.cloudProjectId === projectId && record.localProjectId === selected);
    if (head && (!prior?.receipt || prior.receipt.requestId !== head.requestId || prior.receipt.contentHash !== head.contentHash)) throw { code: "conflict" };
    const repository = await openRepository({ kind: "account", ownerId: client.ownerId });
    try {
      const saved = await repository.load(selected); client.assertActive(signal);
      if (!saved || saved.kind !== "current") throw { code: "readonly" };
      const participants = saved.project.participants.map(person => prior?.participants.find(old => old.participantId === person.id) ?? { participantId: person.id, ownerId: client.ownerId });
      await designs.prepare({ projectId, project: saved.project, expectedRevision: head?.revision ?? null, participants }, signal);
      if (live.current) setNotice("Ready to save. Check it below, then save it to the cloud.");
    } finally { repository.close(); }
  });
  const send = (record: CloudDesignSaveRecord) => run(async signal => {
    const result = await designs.run(record.id, signal);
    if (live.current) setNotice(result.kind === "complete" ? `Saved as version ${result.receipt.revision + 1}.` : "A photo is still being checked. Continue this save shortly, and don't start a new one.");
  });
  return <section aria-labelledby={`${id}-title`} aria-busy={busy} className="panel p-4 sm:p-6">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-3"><span className="glyph bg-[#0ea5e9]"><CloudUpload size={18} strokeWidth={2.25} aria-hidden /></span><h3 ref={heading} tabIndex={-1} id={`${id}-title`} className="font-display text-xl leading-tight outline-none">Save a design to the cloud</h3></div>
      {!busy && <button className="btn btn-plain min-h-10 text-sm" disabled={locked} onClick={() => void run(async () => { const next = await designs.list(); if (live.current) setRecords(next); })}><RefreshCw size={15} aria-hidden /> Refresh</button>}
    </div>
    <p className="mt-3 text-sm text-muted-foreground">Save your edits first. Cloud saves include everything in the project, like captions, edit history and old takes. {view.project.kind === "personal" ? "Only you can see it." : "Project members can see the uploaded photos."}</p>
    {error && <p role="alert" className="notice mt-4 border border-destructive/25 bg-destructive/8 font-bold text-destructive">{error}</p>}
    {notice && <p role="status" className="notice mt-4">{notice}</p>}
    {readOnly && <p className="notice mt-4">Some unfinished saves need a newer version of the app, so new saves are paused.</p>}
    {!pending.length && !readOnly && <div className="mt-4 space-y-3">
      <button className="btn btn-quiet min-h-10 text-sm" disabled={locked} onClick={() => void inspect()}>{loaded ? "Refresh list" : "Choose a project to save"}</button>
      {loaded && (items.some(item => !item.readOnly) ? <div className="flex flex-wrap items-end gap-2"><div className="w-full max-w-md"><Dropdown label="Project" showLabel value={selected} onChange={setSelected} disabled={locked} options={[{ value: "", label: "Choose a project" }, ...items.filter(item => !item.readOnly).map(item => ({ value: item.id, label: items.filter(other => other.name === item.name).length > 1 && item.updatedAt ? `${item.name} · ${new Date(item.updatedAt).toLocaleString("en-AU")}` : item.name }))]} /></div><button className="btn btn-tinted" disabled={locked || !selected} onClick={() => void prepare()}>Prepare to save</button></div> : <p className="text-sm text-muted-foreground">You don&apos;t have any projects on this device for this account yet.</p>)}
    </div>}
    {pending.length > 0 && <ul className="mt-3 divide-y divide-border" aria-label="Unfinished saves">{pending.map(record => <li key={record.id} className="py-3.5"><h4 className="break-words font-bold">{record.project.name}</h4><p className="mt-0.5 text-sm text-muted-foreground">{record.project.media.length} {record.project.media.length === 1 ? "photo" : "photos"} · {cloudSize(record.project.media.reduce((sum, media) => sum + media.bytes, 0))} · {record.phase === "saving" ? "Waiting for confirmation" : record.phase === "uploading" ? "Uploading photos" : record.phase === "preparing" ? "Not ready yet" : "Ready to save"}</p><div className="mt-3 flex flex-wrap gap-2"><button className="btn btn-primary min-h-10 text-sm" disabled={locked} onClick={() => void send(record)}>{record.phase === "prepared" ? "Save to cloud" : "Continue saving"}</button><button className="btn btn-plain min-h-10 text-sm" disabled={locked} id={`${id}-dismiss-${record.id}`} onClick={() => { confirmationOpen.current = true; setDismiss(record.id); onBusy(true); }}>Dismiss…</button></div>{dismiss === record.id && <div role="group" aria-label="Dismiss unfinished save" aria-describedby={`${id}-dismiss-description-${record.id}`} onKeyDown={event => { if (event.key === "Escape" && !disabled && !busy) { event.preventDefault(); confirmationOpen.current = false; setDismiss(null); onBusy(false); requestAnimationFrame(() => document.getElementById(`${id}-dismiss-${record.id}`)?.focus()); } }} className="notice mt-3"><p id={`${id}-dismiss-description-${record.id}`}>Dismiss this unfinished save? Anything already uploaded stays online. Check the cloud design before saving again.</p><div className="mt-3 flex flex-wrap gap-2"><button className="btn btn-danger min-h-10 text-sm" disabled={disabled || busy} onClick={() => void run(async () => { await designs.forget(record.id, record.revision); if (live.current) { confirmationOpen.current = false; setDismiss(null); setNotice("Dismissed."); } })}>Dismiss</button><button ref={keepRequest} aria-describedby={`${id}-dismiss-description-${record.id}`} className="btn btn-quiet min-h-10 text-sm" disabled={disabled || busy} onClick={() => { confirmationOpen.current = false; setDismiss(null); onBusy(false); requestAnimationFrame(() => document.getElementById(`${id}-dismiss-${record.id}`)?.focus()); }}>Keep it</button></div></div>}</li>)}</ul>}
    {busy && <div className="mt-4 flex flex-wrap items-center gap-2"><p role="status" className="flex items-center gap-2 text-sm font-bold"><LoaderCircle size={16} aria-hidden className="animate-spin text-accent motion-reduce:animate-none" />Working on your save…</p><button className="btn btn-plain min-h-10 text-sm" onClick={() => controller.current?.abort()}>Stop waiting</button></div>}
  </section>;
}
