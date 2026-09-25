"use client";
import { useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { Copy, Download, Pencil, Plus, Trash2 } from "lucide-react";
import { downloadProjectBlob, projectDownloadName } from "@/lib/projects/download";
import type { TemplateScope } from "@/lib/templates/model";
import type { TemplateListItem } from "@/lib/templates/storage";

export interface ShelfRow extends TemplateListItem { scope: TemplateScope; key: string }
export type Action = "apply" | "new" | "export" | "duplicate" | "rename" | "delete" | "raw";
export type Recovery = { key: string; manifest: Blob; decorations: Map<string, Blob> };
const control = "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-3 text-sm font-medium transition hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-wait disabled:opacity-50";

export function TemplateRow({ item, busy, canApply, recovery, act }: { item: ShelfRow; busy: boolean; canApply: boolean; recovery: Recovery | null; act: (row: ShelfRow, action: Action, name?: string) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false), [name, setName] = useState(item.name), [deleting, setDeleting] = useState(false);
  const row = useRef<HTMLLIElement>(null), focusTarget = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (busy || !focusTarget.current) return;
    row.current?.querySelector<HTMLElement>(`[data-template-focus="${focusTarget.current}"]`)?.focus({ preventScroll: true });
    focusTarget.current = null;
  });
  return <li ref={row} className="border-b border-border py-6">
    <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
      <div className="min-w-0"><h2 className="break-words font-display text-xl font-semibold">{item.name}</h2><p className="mt-1 text-sm text-foreground/65">{item.scope.kind === "device" ? "This browser" : "Your account, on this device"}{item.updatedAt ? ` · ${new Date(item.updatedAt).toLocaleDateString("en-AU")}` : ""}</p>{item.readOnly && <p className="mt-2 text-sm">This recipe needs recovery or a newer app. Keep its raw files before making changes.</p>}</div>
      {!item.readOnly && <div className="flex shrink-0 flex-wrap gap-1"><button type="button" disabled={busy || !canApply} onClick={() => void act(item, "apply")} className={`${control} bg-accent text-accent-foreground hover:bg-accent/90`}>Use in current project</button><button type="button" disabled={busy} onClick={() => void act(item, "new")} className={control}><Plus size={16} aria-hidden /> New project</button></div>}
    </div>
    <div className="mt-3 flex flex-wrap gap-1">
      {!item.readOnly && <><Link href={`/templates/design?template=${encodeURIComponent(item.id)}&scope=${item.scope.kind}`} aria-disabled={busy} tabIndex={busy ? -1 : undefined} className={`${control} ${busy ? "pointer-events-none opacity-50" : ""}`}><Pencil size={15} aria-hidden /> Design</Link><button type="button" disabled={busy} onClick={() => void act(item, "export")} className={control}><Download size={15} aria-hidden /> Export</button><button type="button" disabled={busy} data-template-focus="rename" onClick={() => { focusTarget.current = "name"; setName(item.name); setEditing(true); setDeleting(false); }} className={control}>Rename</button><button type="button" disabled={busy} onClick={() => void act(item, "duplicate")} className={control}><Copy size={15} aria-hidden /> Duplicate</button></>}
      <button type="button" disabled={busy} onClick={() => void act(item, "raw")} className={control}>Recovery files</button><button type="button" disabled={busy} data-template-focus="delete" onClick={() => { focusTarget.current = "keep"; setDeleting(true); setEditing(false); }} className={control}><Trash2 size={15} aria-hidden /> Delete</button>
    </div>
    {editing && <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={event => { event.preventDefault(); void act(item, "rename", name.trim()).then(ok => { if (ok) setEditing(false); }); }}><label className="min-w-0 flex-1 basis-48 text-sm font-medium">Template name<input data-template-focus="name" value={name} disabled={busy} onChange={event => setName(event.target.value)} maxLength={100} required className="mt-1 min-h-11 w-full rounded-xl border border-border bg-card px-3 outline-ring" /></label><button disabled={busy || !name.trim()} className={`${control} bg-accent text-accent-foreground hover:bg-accent/90`}>Save name</button><button type="button" disabled={busy} onClick={() => { focusTarget.current = "rename"; setEditing(false); }} className={control}>Cancel</button></form>}
    {deleting && <div role="group" aria-label={`Confirm deletion of ${item.name}`} className="mt-3 rounded-xl bg-muted p-4"><p className="max-w-xl text-sm">Delete this template and its decorations from this browser? Existing projects keep their copies. Export first for a backup.</p><div className="mt-2 flex flex-wrap gap-2"><button type="button" disabled={busy} onClick={() => void act(item, "delete")} className={`${control} bg-foreground text-background hover:bg-foreground/90`}>Delete template</button><button type="button" disabled={busy} data-template-focus="keep" onClick={() => { focusTarget.current = "delete"; setDeleting(false); }} className={control}>Keep template</button></div></div>}
    {recovery?.key === item.key && <section className="mt-3 rounded-xl bg-muted p-4" aria-label={`Recovery files for ${item.name}`}><p className="max-w-xl text-sm">Keep these files together for recovery. Raw data retains private text and local account details. Use regular Export for sharing.</p><div className="mt-2 flex flex-wrap gap-1"><button type="button" className={control} onClick={() => downloadProjectBlob(recovery.manifest, projectDownloadName(item.name, "json"))}><Download size={15} aria-hidden /> Raw recipe</button>{Array.from(recovery.decorations, ([id, blob], index) => <button type="button" key={id} className={control} onClick={() => downloadProjectBlob(blob, projectDownloadName(id, "png"))}><Download size={15} aria-hidden /> Decoration {index + 1}</button>)}</div></section>}
  </li>;
}
