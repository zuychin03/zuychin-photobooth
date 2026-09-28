"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Dropdown } from "@/components/Dropdown";
import type { CloudProjectClient } from "@/lib/projects/cloud-client";
import type { CloudProjectView } from "@/lib/projects/cloud-contract";
import type { CloudDesignSaveCoordinator } from "@/lib/projects/cloud-design-save";
import type { CloudDesignSaveEntry, CloudDesignSaveRecord } from "@/lib/projects/cloud-design-journal";
import { openProjectRepository, type ProjectListItem } from "@/lib/projects/storage";
import { cloudControl, cloudError, cloudSize } from "./CloudControls";

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
  return <section aria-labelledby={`${id}-title`} aria-busy={busy} className="border-b border-border py-6">
    <h3 ref={heading} tabIndex={-1} id={`${id}-title`} className="font-display text-2xl outline-none">Save a design to the cloud</h3>
    <p className="mt-2 max-w-2xl text-sm leading-relaxed text-foreground/70">Save your edits first. Cloud saves include everything in the project, like captions, edit history and old takes. {view.project.kind === "personal" ? "Only you can see it." : "Project members can see the uploaded photos."}</p>
    {error && <p role="alert" className="mt-4 max-w-2xl rounded-xl bg-muted p-4 text-sm leading-relaxed">{error}</p>}
    {notice && <p role="status" className="mt-4 max-w-2xl text-sm leading-relaxed">{notice}</p>}
    {readOnly && <p className="mt-4 text-sm">Some unfinished saves need a newer version of the app, so new saves are paused.</p>}
    {!pending.length && !readOnly && <div className="mt-5 space-y-4">
      <button className={`${cloudControl} border border-border`} disabled={locked} onClick={() => void inspect()}>{loaded ? "Refresh list" : "Choose a project to save"}</button>
      {loaded && (items.some(item => !item.readOnly) ? <div className="flex flex-wrap items-end gap-3"><div className="w-full max-w-md"><Dropdown label="Project" showLabel value={selected} onChange={setSelected} disabled={locked} options={[{ value: "", label: "Choose a project" }, ...items.filter(item => !item.readOnly).map(item => ({ value: item.id, label: items.filter(other => other.name === item.name).length > 1 && item.updatedAt ? `${item.name} · ${new Date(item.updatedAt).toLocaleString("en-AU")}` : item.name }))]} /></div><button className={`${cloudControl} border border-border`} disabled={locked || !selected} onClick={() => void prepare()}>Prepare to save</button></div> : <p className="text-sm text-foreground/70">You don&apos;t have any projects on this device for this account yet.</p>)}
    </div>}
    {pending.length > 0 && <ul className="mt-5 divide-y divide-border" aria-label="Unfinished saves">{pending.map(record => <li key={record.id} className="py-4"><h4 className="break-words font-medium">{record.project.name}</h4><p className="mt-2 text-sm text-foreground/70">{record.project.media.length} {record.project.media.length === 1 ? "photo" : "photos"} · {cloudSize(record.project.media.reduce((sum, media) => sum + media.bytes, 0))} · {record.phase === "saving" ? "Waiting for confirmation" : record.phase === "uploading" ? "Uploading photos" : record.phase === "preparing" ? "Not ready yet" : "Ready to save"}</p><div className="mt-3 flex flex-wrap gap-2"><button className={`${cloudControl} bg-accent text-accent-foreground`} disabled={locked} onClick={() => void send(record)}>{record.phase === "prepared" ? "Save to cloud" : "Continue saving"}</button><button className={`${cloudControl} underline underline-offset-4`} disabled={locked} id={`${id}-dismiss-${record.id}`} onClick={() => { confirmationOpen.current = true; setDismiss(record.id); onBusy(true); }}>Dismiss…</button></div>{dismiss === record.id && <div role="group" aria-label="Dismiss unfinished save" aria-describedby={`${id}-dismiss-description-${record.id}`} onKeyDown={event => { if (event.key === "Escape" && !disabled && !busy) { event.preventDefault(); confirmationOpen.current = false; setDismiss(null); onBusy(false); requestAnimationFrame(() => document.getElementById(`${id}-dismiss-${record.id}`)?.focus()); } }} className="mt-4 rounded-xl bg-muted p-4"><p id={`${id}-dismiss-description-${record.id}`} className="max-w-2xl text-sm leading-relaxed">Dismiss this unfinished save? Anything already uploaded stays online. Check the cloud design before saving again.</p><div className="mt-3 flex flex-wrap gap-2"><button className={`${cloudControl} border border-border`} disabled={disabled || busy} onClick={() => void run(async () => { await designs.forget(record.id, record.revision); if (live.current) { confirmationOpen.current = false; setDismiss(null); setNotice("Dismissed."); } })}>Dismiss</button><button ref={keepRequest} aria-describedby={`${id}-dismiss-description-${record.id}`} className={cloudControl} disabled={disabled || busy} onClick={() => { confirmationOpen.current = false; setDismiss(null); onBusy(false); requestAnimationFrame(() => document.getElementById(`${id}-dismiss-${record.id}`)?.focus()); }}>Keep it</button></div></div>}</li>)}</ul>}
    {busy ? <div className="mt-4 flex flex-wrap items-center gap-2"><p role="status" className="text-sm">Working on your save…</p><button className={cloudControl} onClick={() => controller.current?.abort()}>Stop waiting</button></div> : <button className={`${cloudControl} mt-3 underline underline-offset-4`} disabled={locked} onClick={() => void run(async () => { const next = await designs.list(); if (live.current) setRecords(next); })}>Refresh</button>}
  </section>;
}
