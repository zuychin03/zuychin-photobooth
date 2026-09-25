"use client";

import { useAppNavigationGuard } from "@/components/AppNavigation";

import { useEffect, useId, useRef, useState } from "react";
import { Dropdown } from "@/components/Dropdown";
import { cloudControl, cloudInput } from "@/components/cloud/CloudControls";
import type { MemoryActivity, MemoryChapter } from "@/lib/memories/activity-contract";

const secondary = `${cloudControl} border border-border hover:bg-muted`;
const primary = `${cloudControl} bg-accent text-accent-foreground hover:opacity-90`;
export function MemoryLabelEditor({ item, chapters, busy, stale, onSave, onCancel }: { item: MemoryActivity; chapters: MemoryChapter[]; busy: boolean; stale: boolean; onSave(chapterId: string | null, occasion: string | null): void; onCancel(): void }) {
  const id = useId(), field = useRef<HTMLInputElement>(null);
  const [chapterId, setChapterId] = useState(item.annotation?.chapterId ?? ""), [occasion, setOccasion] = useState(item.annotation?.occasion ?? "");
  useEffect(() => { field.current?.focus(); }, []);
  return <form className="mt-4 max-w-xl space-y-4" onSubmit={event => { event.preventDefault(); onSave(chapterId || null, occasion.trim() || null); }}><fieldset disabled={busy || stale} className="space-y-4"><legend className="text-sm font-semibold">Your labels for this memory</legend><p className="pt-2 text-sm leading-relaxed text-foreground/75">Only you see these labels. They remain if the photo expires.</p><label htmlFor={`${id}-occasion`} className="block text-sm font-medium">Occasion<input ref={field} id={`${id}-occasion`} className={`${cloudInput} mt-2`} value={occasion} onChange={event => setOccasion(event.target.value)} maxLength={80} placeholder="A slow Sunday" /></label><Dropdown label="Chapter for this memory" showLabel value={chapterId} options={[{ value: "", label: "No chapter" }, ...chapters.map(chapter => ({ value: chapter.id, label: chapter.title }))]} onChange={setChapterId} disabled={busy || stale} /></fieldset><div className="flex flex-wrap gap-2"><button className={primary} disabled={busy || stale}>Save labels</button><button className={secondary} type="button" disabled={busy} onClick={onCancel}>Cancel</button></div></form>;
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
  return <section className="mt-8 border-t border-border pt-7" aria-labelledby={`${id}-title`}><div className="flex flex-wrap items-start justify-between gap-3"><div><h2 ref={heading} tabIndex={-1} id={`${id}-title`} className="font-display text-2xl font-semibold outline-none">Your chapters</h2><p className="mt-2 text-sm text-foreground/75">Private names for the seasons of your life.</p></div><button disabled={busy || stale || Boolean(editor) || chapters.length >= 100} className={secondary} onClick={() => { setRemove(null); setEditor({ id: crypto.randomUUID(), revision: -1, title: "" }); }}>New chapter</button></div>
    {leaveWarning && (editor || remove) && <p role="alert" className="mt-3 text-sm">Save or cancel the open chapter before leaving.</p>}
    {editor && <form className="mt-5 max-w-xl" onSubmit={event => { event.preventDefault(); void onSave(editor.id, editor.revision, editor.title.trim()).then(ok => { if (ok) { setEditor(null); heading.current?.focus(); } }); }}><label htmlFor={`${id}-name`} className="block text-sm font-medium">{editor.revision < 0 ? "New chapter name" : "Rename chapter"}<input ref={input} id={`${id}-name`} className={`${cloudInput} mt-2`} required maxLength={80} value={editor.title} disabled={busy || stale} onChange={event => setEditor({ ...editor, title: event.target.value })} /></label><div className="mt-3 flex flex-wrap gap-2"><button className={primary} disabled={busy || stale || !editor.title.trim()}>Save chapter</button><button className={secondary} disabled={busy} type="button" onClick={() => { setEditor(null); heading.current?.focus(); }}>Cancel</button></div></form>}
    {!chapters.length && <p className="mt-5 text-sm text-foreground/75">Start a chapter such as “Our first home” or “Little adventures”, then add memories to it.</p>}
    <ul className="mt-4 divide-y divide-border">{chapters.map(chapter => <li key={chapter.id} className="py-3"><div className="flex flex-wrap items-center justify-between gap-2"><span className="min-w-0 break-words font-medium">{chapter.title}</span><div className="flex shrink-0 flex-wrap gap-1"><button disabled={busy || stale || Boolean(editor)} className={secondary} aria-label={`Rename chapter ${chapter.title}`} onClick={() => { setRemove(null); setEditor({ id: chapter.id, revision: chapter.revision, title: chapter.title }); }}>Rename</button><button disabled={busy || stale || Boolean(editor)} className={secondary} aria-label={`Delete chapter ${chapter.title}`} onClick={() => setRemove(chapter.id)}>Delete</button></div></div>{remove === chapter.id && <div className="mt-3 text-sm"><p>Delete “{chapter.title}”? This removes an empty chapter only. First remove the chapter label from any memories inside it.</p><div className="mt-3 flex flex-wrap gap-2"><button ref={confirm} className={secondary} disabled={busy || stale} onClick={() => { void onDelete(chapter).then(ok => { if (ok) { setRemove(null); heading.current?.focus(); } }); }}>Confirm chapter deletion</button><button className={secondary} disabled={busy} onClick={() => setRemove(null)}>Keep chapter</button></div></div>}</li>)}</ul>
  </section>;
}
