"use client";
import { useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { Copy, Download, LayoutTemplate, Palette, Pencil, Plus, Trash2 } from "lucide-react";
import { downloadProjectBlob, projectDownloadName } from "@/lib/projects/download";
import type { TemplateScope } from "@/lib/templates/model";
import type { TemplateListItem } from "@/lib/templates/storage";

export interface ShelfRow extends TemplateListItem { scope: TemplateScope; key: string }
export type Action = "apply" | "new" | "export" | "duplicate" | "rename" | "delete" | "raw";
export type Recovery = { key: string; manifest: Blob; decorations: Map<string, Blob> };
const control = "btn btn-quiet min-h-10 px-3.5 text-[0.8125rem] disabled:cursor-wait";
const primary = "btn btn-primary min-h-10 px-4 text-sm disabled:cursor-wait";

export function TemplateRow({ item, busy, canApply, recovery, act }: { item: ShelfRow; busy: boolean; canApply: boolean; recovery: Recovery | null; act: (row: ShelfRow, action: Action, name?: string) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false), [name, setName] = useState(item.name), [deleting, setDeleting] = useState(false);
  const row = useRef<HTMLLIElement>(null), focusTarget = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (busy || !focusTarget.current) return;
    row.current?.querySelector<HTMLElement>(`[data-template-focus="${focusTarget.current}"]`)?.focus({ preventScroll: true });
    focusTarget.current = null;
  });
  return <li ref={row} className="px-4 py-4 sm:px-5">
    <div className="flex items-start gap-4 sm:gap-5">
      <span className="flex size-14 shrink-0 items-center justify-center rounded-2xl bg-muted text-muted-foreground shadow-[inset_0_0_0_1px_var(--panel-stroke)] sm:size-16"><LayoutTemplate size={24} aria-hidden /></span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
          <div className="min-w-0"><h3 className="break-words text-lg font-bold">{item.name}</h3><p className="mt-0.5 text-sm text-muted-foreground">{item.scope.kind === "device" ? "This browser" : "Your account, on this device"}{item.updatedAt ? ` · ${new Date(item.updatedAt).toLocaleDateString("en-AU")}` : ""}</p>{item.readOnly && <p className="mt-2 max-w-xl text-sm text-muted-foreground">This template can&apos;t be opened in this version of the app. Download its recovery files before you change anything.</p>}</div>
          {!item.readOnly && <div className="flex shrink-0 flex-wrap gap-1.5"><button type="button" disabled={busy || !canApply} onClick={() => void act(item, "apply")} className={primary}>Use in current project</button><button type="button" disabled={busy} onClick={() => void act(item, "new")} className="btn btn-tinted min-h-10 px-4 text-sm disabled:cursor-wait"><Plus size={16} aria-hidden /> New project</button></div>}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {!item.readOnly && <><Link href={`/templates/design?template=${encodeURIComponent(item.id)}&scope=${item.scope.kind}`} aria-disabled={busy} tabIndex={busy ? -1 : undefined} className={`${control} ${busy ? "pointer-events-none" : ""}`}><Palette size={15} aria-hidden /><span className="max-sm:sr-only">Design</span></Link><button type="button" disabled={busy} onClick={() => void act(item, "export")} className={control}><Download size={15} aria-hidden /><span className="max-sm:sr-only">Export</span></button><button type="button" disabled={busy} data-template-focus="rename" onClick={() => { focusTarget.current = "name"; setName(item.name); setEditing(true); setDeleting(false); }} className={control}><Pencil size={15} aria-hidden /><span className="max-sm:sr-only">Rename</span></button><button type="button" disabled={busy} onClick={() => void act(item, "duplicate")} className={control}><Copy size={15} aria-hidden /><span className="max-sm:sr-only">Duplicate</span></button></>}
          <button type="button" disabled={busy} onClick={() => void act(item, "raw")} className={control}>Recovery files</button><button type="button" disabled={busy} data-template-focus="delete" onClick={() => { focusTarget.current = "keep"; setDeleting(true); setEditing(false); }} className={control}><Trash2 size={15} aria-hidden /><span className="max-sm:sr-only">Delete</span></button>
        </div>
        {editing && <form className="mt-4 flex flex-wrap items-end gap-2" onSubmit={event => { event.preventDefault(); void act(item, "rename", name.trim()).then(ok => { if (ok) setEditing(false); }); }}><label className="min-w-0 flex-1 basis-44 text-sm font-bold">Template name<input data-template-focus="name" value={name} disabled={busy} onChange={event => setName(event.target.value)} maxLength={100} required className="field mt-1.5 font-medium" /></label><button disabled={busy || !name.trim()} className={primary}>Save name</button><button type="button" disabled={busy} onClick={() => { focusTarget.current = "rename"; setEditing(false); }} className={control}>Cancel</button></form>}
        {deleting && <div role="group" aria-label={`Confirm deletion of ${item.name}`} className="notice mt-4"><p className="max-w-xl">Delete this template from this browser? Projects that already use it won&apos;t change. Export it first if you want a backup.</p><div className="mt-2 flex flex-wrap gap-2"><button type="button" disabled={busy} onClick={() => void act(item, "delete")} className="btn btn-danger min-h-10 px-4 text-sm disabled:cursor-wait">Delete template</button><button type="button" disabled={busy} data-template-focus="keep" onClick={() => { focusTarget.current = "delete"; setDeleting(false); }} className={control}>Keep template</button></div></div>}
      </div>
    </div>
    {recovery?.key === item.key && <section className="panel-muted mt-4 p-4 sm:ml-[5.25rem]" aria-label={`Recovery files for ${item.name}`}><p className="max-w-2xl text-sm text-muted-foreground">Raw files for this template. They can include private text and account details, so use Export to share it.</p><div className="mt-2 flex flex-wrap gap-1.5"><button type="button" className={control} onClick={() => downloadProjectBlob(recovery.manifest, projectDownloadName(item.name, "json"))}><Download size={15} aria-hidden /> Template data</button>{Array.from(recovery.decorations, ([id, blob], index) => <button type="button" key={id} className={control} onClick={() => downloadProjectBlob(blob, projectDownloadName(id, "png"))}><Download size={15} aria-hidden /> Decoration {index + 1}</button>)}</div></section>}
  </li>;
}
