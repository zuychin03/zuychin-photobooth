"use client";

import { useId, useLayoutEffect, useRef, useState } from "react";
import { ArrowRight, Copy, Download, Image as ImageIcon, Pencil, RotateCcw, Trash2 } from "lucide-react";
import type { ProjectScope } from "@/lib/projects/model";
import type { LoadedProject, ProjectListItem } from "@/lib/projects/storage";
import { downloadProjectBlob, projectDownloadName } from "@/lib/projects/download";

export interface LibraryProject extends ProjectListItem { scope: ProjectScope; key: string }
export type LibraryAction = "resume" | "export" | "rename" | "duplicate" | "delete" | "recover";
const control = "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-3 text-sm font-medium transition hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-wait disabled:opacity-50";

export function ProjectLibraryRow({ item, thumbnail, busy, onAction, onRecovery }: {
  item: LibraryProject; thumbnail?: string; busy: boolean;
  onAction: (item: LibraryProject, action: LibraryAction, name?: string) => Promise<void>;
  onRecovery: (item: LibraryProject) => Promise<LoadedProject>;
}) {
  const inputId = useId();
  const [editing, setEditing] = useState(false), [name, setName] = useState(item.name);
  const [confirmDelete, setConfirmDelete] = useState(false), [recovery, setRecovery] = useState<LoadedProject | null>(null);
  const [recoveryOpen, setRecoveryOpen] = useState(false), [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [reading, setReading] = useState(false), [confirmRecovery, setConfirmRecovery] = useState(false);
  const row = useRef<HTMLLIElement>(null), focusTarget = useRef<string | null>(null);
  const disabled = busy || reading;
  useLayoutEffect(() => {
    if (disabled || !focusTarget.current) return;
    row.current?.querySelector<HTMLElement>(`[data-row-focus="${focusTarget.current}"]`)?.focus({ preventScroll: true });
    focusTarget.current = null;
  });
  const run = async (action: LibraryAction, nextName?: string) => {
    try { await onAction(item, action, nextName); setEditing(false); setConfirmDelete(false); setConfirmRecovery(false); setRecovery(null); setRecoveryOpen(false); }
    catch { /* The parent keeps the operation error visible without discarding the input. */ }
  };
  const openRecovery = async () => {
    if (recoveryOpen) { setRecoveryOpen(false); return; }
    setReading(true); setRecoveryError(null);
    try { setRecovery(await onRecovery(item)); setRecoveryOpen(true); }
    catch (error) { setRecoveryError(error instanceof Error ? error.message : "Recovery files could not be opened"); }
    finally { focusTarget.current = "recovery"; setReading(false); }
  };
  const originalFiles = recovery ? new Map([...recovery.media, ...(recovery.checkpoint?.media ?? [])]) : new Map<string, Blob>();
  const date = item.updatedAt ? new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric" }).format(new Date(item.updatedAt)) : null;

  return <li ref={row} className="border-b border-border py-5 first:pt-0 last:border-0">
    <div className="flex items-start gap-4 sm:gap-5">
      <div className="flex h-24 w-20 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-muted sm:h-28 sm:w-24">
        {thumbnail ? /* Local, downsampled Blob URLs do not use the image optimisation server. */
          // eslint-disable-next-line @next/next/no-img-element
          <img src={thumbnail} width={160} height={160} alt="" className="h-full w-full object-cover" /> : <ImageIcon size={26} className="text-foreground/45" aria-hidden />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="min-w-0">
            <h2 className="break-words text-lg font-semibold">{item.name}</h2>
            <p className="mt-1 text-sm text-foreground/65">{item.scope.kind === "device" ? "On this device" : "Account draft on this device"}{date ? ` · Edited ${date}` : ""}</p>
            {item.readOnly && <p className="mt-2 max-w-xl text-sm text-foreground/75">This draft needs a newer app or recovery. Your stored files are still available.</p>}
          </div>
          {!item.readOnly && <button type="button" disabled={disabled} onClick={() => void run("resume")} className={`${control} bg-accent text-accent-foreground hover:bg-accent/90`} aria-label={`Continue ${item.name}`}>Continue <ArrowRight size={16} aria-hidden /></button>}
        </div>
        {!editing && !confirmDelete && <div className="mt-2 flex flex-wrap items-center gap-x-1">
          {!item.readOnly && <>
            <button type="button" className={control} disabled={disabled} onClick={() => void run("export")} aria-label={`Export ${item.name}`}><Download size={16} aria-hidden /> Export</button>
            <button data-row-focus="rename" type="button" className={control} disabled={disabled} onClick={() => { setName(item.name); setEditing(true); }} aria-label={`Rename ${item.name}`}><Pencil size={15} aria-hidden /> Rename</button>
            <button type="button" className={control} disabled={disabled} onClick={() => void run("duplicate")} aria-label={`Duplicate ${item.name}`}><Copy size={15} aria-hidden /> Duplicate</button>
            <button data-row-focus="delete" type="button" className={control} disabled={disabled} onClick={() => { focusTarget.current = "keep"; setConfirmDelete(true); }} aria-label={`Delete ${item.name}`}><Trash2 size={15} aria-hidden /> Delete</button>
          </>}
          <button data-row-focus="recovery" type="button" className={control} disabled={disabled} onClick={() => void openRecovery()} aria-expanded={recoveryOpen}>{reading ? "Opening files…" : recoveryOpen ? "Hide recovery files" : "Recovery files"}</button>
        </div>}
        {editing && <form className="mt-4 flex flex-wrap items-end gap-2" onSubmit={event => { event.preventDefault(); void run("rename", name.trim()); }}>
          <div className="min-w-0 flex-1 basis-44"><label htmlFor={inputId} className="mb-1 block text-sm font-medium">Project name</label><input id={inputId} value={name} onChange={event => setName(event.target.value)} maxLength={100} required autoFocus className="min-h-11 w-full rounded-xl border border-border bg-card px-3 outline-ring" /></div>
          <button className={`${control} bg-accent text-accent-foreground hover:bg-accent/90`} disabled={disabled || !name.trim()}>Save name</button>
          <button type="button" className={control} disabled={disabled} onClick={() => { focusTarget.current = "rename"; setEditing(false); }}>Cancel</button>
        </form>}
        {confirmDelete && <div className="mt-4" role="group" aria-label={`Confirm deletion of ${item.name}`}>
          <p className="max-w-xl text-sm">Delete this project and its originals from this browser? This cannot be undone. Export a backup first if you want to keep it.</p>
          <div className="mt-2 flex flex-wrap gap-2"><button type="button" className={`${control} bg-foreground text-background hover:bg-foreground/90`} disabled={disabled} onClick={() => void run("delete")}>Delete from this device</button><button data-row-focus="keep" type="button" className={control} disabled={disabled} onClick={() => { focusTarget.current = "delete"; setConfirmDelete(false); }}>Keep project</button></div>
        </div>}
        {recoveryError && <p role="alert" className="mt-3 text-sm text-foreground">{recoveryError}</p>}
      </div>
    </div>
    {recoveryOpen && recovery && <section className="mt-5 border-t border-border pt-4 sm:ml-29" aria-label={`Recovery files for ${item.name}`}>
      <p className="max-w-2xl text-sm text-foreground/75">Keep these recovery files together. They include private account or camera details; use regular Export for sharing.</p>
      <div className="mt-2 flex flex-wrap gap-1">
        <button type="button" className={control} onClick={() => downloadProjectBlob(new Blob([recovery.kind === "current" ? JSON.stringify(recovery.project) : recovery.rawJson], { type: "application/json" }), projectDownloadName(item.name, "json"))}><Download size={15} aria-hidden /> Manifest</button>
        {recovery.checkpoint && <button type="button" className={control} onClick={() => downloadProjectBlob(new Blob([recovery.checkpoint!.rawJson], { type: "application/json" }), projectDownloadName(`${item.name}-previous`, "json"))}><Download size={15} aria-hidden /> Previous manifest</button>}
        {Array.from(originalFiles, ([id, blob], index) => <button type="button" key={id} className={control} onClick={() => downloadProjectBlob(blob, projectDownloadName(id, blob.type === "image/png" ? "png" : blob.type === "image/webp" ? "webp" : blob.type === "image/jpeg" ? "jpg" : "bin"))}><Download size={15} aria-hidden /> Original {index + 1}</button>)}
      </div>
      {recovery.checkpoint && recovery.kind !== "unsupported" && <div className="mt-3">
        {confirmRecovery ? <><p className="text-sm">Restore the previous saved settings? The current manifest will become the recovery checkpoint.</p><div className="mt-2 flex flex-wrap gap-2"><button type="button" className={`${control} bg-muted`} disabled={disabled} onClick={() => void run("recover")}><RotateCcw size={15} aria-hidden /> Restore previous save</button><button data-row-focus="cancelRecovery" type="button" className={control} disabled={disabled} onClick={() => { focusTarget.current = "recover"; setConfirmRecovery(false); }}>Cancel</button></div></> : <button data-row-focus="recover" type="button" className={control} disabled={disabled} onClick={() => { focusTarget.current = "cancelRecovery"; setConfirmRecovery(true); }}><RotateCcw size={15} aria-hidden /> Recover previous save</button>}
      </div>}
    </section>}
  </li>;
}
