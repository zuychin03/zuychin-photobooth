"use client";

import { useId, useLayoutEffect, useRef, useState } from "react";
import { ArrowRight, Copy, Download, Image as ImageIcon, Pencil, RotateCcw, Trash2 } from "lucide-react";
import type { ProjectScope } from "@/lib/projects/model";
import type { LoadedProject, ProjectListItem } from "@/lib/projects/storage";
import { downloadProjectBlob, projectDownloadName } from "@/lib/projects/download";

export interface LibraryProject extends ProjectListItem { scope: ProjectScope; key: string }
export type LibraryAction = "resume" | "export" | "rename" | "duplicate" | "delete" | "recover";
const control = "btn btn-quiet min-h-10 px-3.5 text-[0.8125rem] disabled:cursor-wait";
const primary = "btn btn-primary min-h-10 px-4 text-sm disabled:cursor-wait";

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
    catch (error) { setRecoveryError(error instanceof Error ? error.message : "Couldn't open the recovery files."); }
    finally { focusTarget.current = "recovery"; setReading(false); }
  };
  const originalFiles = recovery ? new Map([...recovery.media, ...(recovery.checkpoint?.media ?? [])]) : new Map<string, Blob>();
  const date = item.updatedAt ? new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric" }).format(new Date(item.updatedAt)) : null;

  return <li ref={row} className="px-4 py-4 sm:px-5">
    <div className="flex items-start gap-4 sm:gap-5">
      <div className="flex h-24 w-[4.5rem] shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-muted shadow-[inset_0_0_0_1px_var(--panel-stroke)] sm:h-28 sm:w-[5.25rem]">
        {thumbnail ? /* Local, downsampled Blob URLs do not use the image optimisation server. */
          // eslint-disable-next-line @next/next/no-img-element
          <img src={thumbnail} width={160} height={160} alt="" className="h-full w-full object-cover" /> : <ImageIcon size={26} className="text-foreground/45" aria-hidden />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="min-w-0">
            <h3 className="break-words text-lg font-bold">{item.name}</h3>
            <p className="mt-0.5 text-sm text-muted-foreground">{item.scope.kind === "device" ? "On this device" : "Account draft on this device"}{date ? ` · Edited ${date}` : ""}</p>
            {item.readOnly && <p className="mt-2 max-w-xl text-sm text-muted-foreground">This project can&apos;t be opened in this version of the app. Its files are still here under Recovery files.</p>}
          </div>
          {!item.readOnly && <button type="button" disabled={disabled} onClick={() => void run("resume")} className={primary} aria-label={`Continue ${item.name}`}>Continue <ArrowRight size={16} aria-hidden /></button>}
        </div>
        {!editing && !confirmDelete && <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {!item.readOnly && <>
            <button type="button" className={control} disabled={disabled} onClick={() => void run("export")} aria-label={`Export ${item.name}`}><Download size={15} aria-hidden /><span className="max-sm:sr-only">Export</span></button>
            <button data-row-focus="rename" type="button" className={control} disabled={disabled} onClick={() => { setName(item.name); setEditing(true); }} aria-label={`Rename ${item.name}`}><Pencil size={15} aria-hidden /><span className="max-sm:sr-only">Rename</span></button>
            <button type="button" className={control} disabled={disabled} onClick={() => void run("duplicate")} aria-label={`Duplicate ${item.name}`}><Copy size={15} aria-hidden /><span className="max-sm:sr-only">Duplicate</span></button>
            <button data-row-focus="delete" type="button" className={control} disabled={disabled} onClick={() => { focusTarget.current = "keep"; setConfirmDelete(true); }} aria-label={`Delete ${item.name}`}><Trash2 size={15} aria-hidden /><span className="max-sm:sr-only">Delete</span></button>
          </>}
          <button data-row-focus="recovery" type="button" className={control} disabled={disabled} onClick={() => void openRecovery()} aria-expanded={recoveryOpen}>{reading ? "Opening files…" : recoveryOpen ? "Hide recovery files" : "Recovery files"}</button>
        </div>}
        {editing && <form className="mt-4 flex flex-wrap items-end gap-2" onSubmit={event => { event.preventDefault(); void run("rename", name.trim()); }}>
          <div className="min-w-0 flex-1 basis-44"><label htmlFor={inputId} className="mb-1 block text-sm font-medium">Project name</label><input id={inputId} value={name} onChange={event => setName(event.target.value)} maxLength={100} required autoFocus className="field" /></div>
          <button className={primary} disabled={disabled || !name.trim()}>Save name</button>
          <button type="button" className={control} disabled={disabled} onClick={() => { focusTarget.current = "rename"; setEditing(false); }}>Cancel</button>
        </form>}
        {confirmDelete && <div className="notice mt-4" role="group" aria-label={`Confirm deletion of ${item.name}`}>
          <p className="max-w-xl">Delete this project and its photos from this browser? You can&apos;t undo this.</p>
          <div className="mt-2 flex flex-wrap gap-2"><button type="button" className="btn btn-danger min-h-10 px-4 text-sm" disabled={disabled} onClick={() => void run("delete")}>Delete from this device</button><button data-row-focus="keep" type="button" className={control} disabled={disabled} onClick={() => { focusTarget.current = "delete"; setConfirmDelete(false); }}>Keep project</button></div>
        </div>}
        {recoveryError && <p role="alert" className="mt-3 text-sm font-bold text-destructive">{recoveryError}</p>}
      </div>
    </div>
    {recoveryOpen && recovery && <section className="panel-muted mt-4 p-4 sm:ml-[6.5rem]" aria-label={`Recovery files for ${item.name}`}>
      <p className="max-w-2xl text-sm text-muted-foreground">Raw files for this project. They can include private details, so use Export to share it.</p>
      <div className="mt-2 flex flex-wrap gap-1">
        <button type="button" className={control} onClick={() => downloadProjectBlob(new Blob([recovery.kind === "current" ? JSON.stringify(recovery.project) : recovery.rawJson], { type: "application/json" }), projectDownloadName(item.name, "json"))}><Download size={15} aria-hidden /> Project data</button>
        {recovery.checkpoint && <button type="button" className={control} onClick={() => downloadProjectBlob(new Blob([recovery.checkpoint!.rawJson], { type: "application/json" }), projectDownloadName(`${item.name}-previous`, "json"))}><Download size={15} aria-hidden /> Previous project data</button>}
        {Array.from(originalFiles, ([id, blob], index) => <button type="button" key={id} className={control} onClick={() => downloadProjectBlob(blob, projectDownloadName(id, blob.type === "image/png" ? "png" : blob.type === "image/webp" ? "webp" : blob.type === "image/jpeg" ? "jpg" : "bin"))}><Download size={15} aria-hidden /> Photo {index + 1}</button>)}
      </div>
      {recovery.checkpoint && recovery.kind !== "unsupported" && <div className="mt-3">
        {confirmRecovery ? <><p className="text-sm">Go back to the previous save? The current data will be kept as a backup.</p><div className="mt-2 flex flex-wrap gap-2"><button type="button" className={primary} disabled={disabled} onClick={() => void run("recover")}><RotateCcw size={15} aria-hidden /> Yes, restore it</button><button data-row-focus="cancelRecovery" type="button" className={control} disabled={disabled} onClick={() => { focusTarget.current = "recover"; setConfirmRecovery(false); }}>Cancel</button></div></> : <button data-row-focus="recover" type="button" className={control} disabled={disabled} onClick={() => { focusTarget.current = "cancelRecovery"; setConfirmRecovery(true); }}><RotateCcw size={15} aria-hidden /> Restore previous save</button>}
      </div>}
    </section>}
  </li>;
}
