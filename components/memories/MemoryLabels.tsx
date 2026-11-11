"use client";

import { useAppNavigationGuard } from "@/components/AppNavigation";

import { useEffect, useId, useRef, useState } from "react";
import { BookMarked, Library, Plus, Tag } from "lucide-react";
import { Dropdown } from "@/components/Dropdown";
import type { MemoryActivity, MemoryChapter } from "@/lib/memories/activity-contract";

const quiet = "btn btn-quiet min-h-10 px-3.5 text-[0.8125rem]";
export function MemoryLabelEditor({ item, chapters, busy, stale, onSave, onCancel }: { item: MemoryActivity; chapters: MemoryChapter[]; busy: boolean; stale: boolean; onSave(chapterId: string | null, occasion: string | null): void; onCancel(): void }) {
  const id = useId(), field = useRef<HTMLInputElement>(null);
  const [chapterId, setChapterId] = useState(item.annotation?.chapterId ?? ""), [occasion, setOccasion] = useState(item.annotation?.occasion ?? "");
  useEffect(() => { field.current?.focus(); }, []);
  return <form className="mt-3 space-y-4 rounded-2xl bg-card p-4 shadow-[inset_0_0_0_1px_var(--panel-stroke)] sm:p-5" onSubmit={event => { event.preventDefault(); onSave(chapterId || null, occasion.trim() || null); }}><fieldset disabled={busy || stale} className="space-y-4"><legend className="flex items-center gap-2 font-bold"><Tag size={16} className="text-accent" aria-hidden />Labels</legend><p className="pt-1 text-sm text-muted-foreground">Only you can see these labels.</p><div className="grid gap-4 sm:grid-cols-2"><label htmlFor={`${id}-occasion`} className="block text-sm font-bold">Occasion<input ref={field} id={`${id}-occasion`} className="field mt-1.5 font-medium" value={occasion} onChange={event => setOccasion(event.target.value)} maxLength={80} placeholder="A slow Sunday" /></label><Dropdown label="Chapter" showLabel value={chapterId} options={[{ value: "", label: "No chapter" }, ...chapters.map(chapter => ({ value: chapter.id, label: chapter.title }))]} onChange={setChapterId} disabled={busy || stale} /></div></fieldset><div className="flex flex-wrap gap-2"><button className="btn btn-primary min-h-10 text-sm" disabled={busy || stale}>Save labels</button><button className="btn btn-quiet min-h-10 text-sm" type="button" disabled={busy} onClick={onCancel}>Cancel</button></div></form>;
}

export function MemoryChapters({ chapters, busy, stale, onSave, onDelete }: { chapters: MemoryChapter[]; busy: boolean; stale: boolean; onSave(id: string, revision: number, title: string): Promise<boolean>; onDelete(chapter: MemoryChapter): Promise<boolean> }) {
  const [editor, setEditor] = useState<{ id: string; revision: number; title: string } | null>(null), [remove, setRemove] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null), confirm = useRef<HTMLButtonElement>(null), heading = useRef<HTMLHeadingElement>(null), id = useId();
  const [leaveWarning, setLeaveWarning] = useState(false);
  useAppNavigationGuard(() => {
    if (editor || remove) { setLeaveWarning(true); return false; }
    return true;
  });
  const editorId = editor?.id;
  useEffect(() => { if (editorId) input.current?.focus(); }, [editorId]);
  useEffect(() => { if (remove) confirm.current?.focus(); }, [remove]);
  return <section className="panel p-4 sm:p-6" aria-labelledby={`${id}-title`}><div className="flex flex-wrap items-center justify-between gap-3"><div className="flex min-w-0 items-center gap-3"><span className="glyph bg-[#f59e0b]"><Library size={18} strokeWidth={2.25} aria-hidden /></span><h2 ref={heading} tabIndex={-1} id={`${id}-title`} className="font-display text-xl leading-tight outline-none">Your chapters</h2></div><button disabled={busy || stale || Boolean(editor) || chapters.length >= 100} className="btn btn-tinted min-h-10 text-sm" onClick={() => { setRemove(null); setEditor({ id: crypto.randomUUID(), revision: -1, title: "" }); }}><Plus size={16} aria-hidden /> New chapter</button></div>
    <p className="mt-3 text-sm text-muted-foreground">Group memories into chapters only you can see.</p>
    {leaveWarning && (editor || remove) && <p role="alert" className="notice mt-3 font-bold">Save or cancel the chapter before you leave.</p>}
    {editor && <form className="panel-muted mt-4 p-4" onSubmit={event => { event.preventDefault(); void onSave(editor.id, editor.revision, editor.title.trim()).then(ok => { if (ok) { setEditor(null); heading.current?.focus(); } }); }}><label htmlFor={`${id}-name`} className="block text-sm font-bold">{editor.revision < 0 ? "New chapter name" : "Rename chapter"}<input ref={input} id={`${id}-name`} className="field mt-1.5 font-medium" required maxLength={80} value={editor.title} disabled={busy || stale} onChange={event => setEditor({ ...editor, title: event.target.value })} placeholder="Our first home" /></label><div className="mt-3 flex flex-wrap gap-2"><button className="btn btn-primary min-h-10 text-sm" disabled={busy || stale || !editor.title.trim()}>Save chapter</button><button className="btn btn-quiet min-h-10 text-sm" disabled={busy} type="button" onClick={() => { setEditor(null); heading.current?.focus(); }}>Cancel</button></div></form>}
    {!chapters.length && <p className="mt-4 rounded-2xl bg-muted/50 px-4 py-6 text-center text-sm text-muted-foreground">No chapters yet.</p>}
    <ul className="mt-3 divide-y divide-border">{chapters.map(chapter => <li key={chapter.id} className="py-3"><div className="flex flex-wrap items-center justify-between gap-2"><span className="flex min-w-0 items-center gap-2.5 font-bold [overflow-wrap:anywhere]"><BookMarked size={16} className="shrink-0 text-muted-foreground" aria-hidden />{chapter.title}</span><div className="flex shrink-0 flex-wrap gap-1"><button disabled={busy || stale || Boolean(editor)} className={quiet} aria-label={`Rename chapter ${chapter.title}`} onClick={() => { setRemove(null); setEditor({ id: chapter.id, revision: chapter.revision, title: chapter.title }); }}>Rename</button><button disabled={busy || stale || Boolean(editor)} className={quiet} aria-label={`Delete chapter ${chapter.title}`} onClick={() => setRemove(chapter.id)}>Delete</button></div></div>{remove === chapter.id && <div className="notice mt-3"><p>Delete “{chapter.title}”? Only empty chapters can be deleted.</p><div className="mt-3 flex flex-wrap gap-2"><button ref={confirm} className="btn btn-danger min-h-10 text-sm" disabled={busy || stale} onClick={() => { void onDelete(chapter).then(ok => { if (ok) { setRemove(null); heading.current?.focus(); } }); }}>Delete</button><button className="btn btn-quiet min-h-10 text-sm" disabled={busy} onClick={() => setRemove(null)}>Cancel</button></div></div>}</li>)}</ul>
  </section>;
}
