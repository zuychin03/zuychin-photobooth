"use client";
import { useAppNavigationGuard } from "@/components/AppNavigation";

import { HelpTooltip } from "@/components/HelpTooltip";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { LayoutTemplate, LoaderCircle, Plus, RefreshCw, Upload } from "lucide-react";
import { TemplateRow, type ShelfRow, type Action, type Recovery } from "@/components/TemplateRow";
import { Dropdown } from "@/components/Dropdown";
import { useAuth } from "@/lib/auth";
import { useBoothSession } from "@/lib/session";
import { downloadProjectBlob, projectDownloadName } from "@/lib/projects/download";
import { designFromRecipe, templateForNewProject } from "@/lib/templates/application";
import { exportTemplateBundle, importTemplateBundle, TEMPLATE_BUNDLE_MIME } from "@/lib/templates/bundle";
import { templateFromProject } from "@/lib/templates/from-project";
import { templateScopeKey, validateTemplateRecipe, type TemplateScope } from "@/lib/templates/model";
import { openTemplateShelf } from "@/lib/templates/storage";

const control = "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-3 text-sm font-medium transition hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-wait disabled:opacity-50";
const failureText = (error: unknown) => error instanceof Error ? error.message : "This template action could not finish. Try again or keep a recovery backup.";


export default function TemplatesPage() {
  const { user, loading } = useAuth();
  return <TemplateShelfPage key={`${loading ? "loading" : "ready"}:${user?.id ?? "device"}`} owner={user?.id ?? null} authLoading={loading} />;
}

function TemplateShelfPage({ owner, authLoading }: { owner: string | null; authLoading: boolean }) {
  const router = useRouter(), session = useBoothSession();
  const [rows, setRows] = useState<ShelfRow[]>([]), [loading, setLoading] = useState(true), [refresh, setRefresh] = useState(0), [count, setCount] = useState(20);
  const [busy, setBusy] = useState<string | null>(null), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const [includeText, setIncludeText] = useState(false), [saving, setSaving] = useState(false), [name, setName] = useState("My template"), [destination, setDestination] = useState("device");
  const [recovery, setRecovery] = useState<Recovery | null>(null), input = useRef<HTMLInputElement>(null), active = useRef(true), job = useRef(false);
  useAppNavigationGuard(() => {
    if (job.current || busy) { setNotice("Wait for the current template action to finish before leaving."); return false; }
    if (saving) { setNotice("Save or cancel the template form before leaving."); return false; }
    return true;
  });
  const heading = useRef<HTMLHeadingElement>(null), focusAfterMutation = useRef(false);
  useLayoutEffect(() => { if (!busy && focusAfterMutation.current) { focusAfterMutation.current = false; heading.current?.focus({ preventScroll: true }); } });
  const accountKey = `${authLoading ? "loading" : "ready"}:${owner ?? "device"}`, account = useRef(accountKey);
  const scopes = useMemo<TemplateScope[]>(() => [{ kind: "device" }, ...(owner && !authLoading ? [{ kind: "account" as const, ownerId: owner }] : [])], [owner, authLoading]);
  const visible = rows.filter(row => row.scope.kind === "device" || (!authLoading && row.scope.ownerId === owner)), page = visible.slice(0, count);
  useLayoutEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    let current = true;
    const read = async () => {
      setLoading(true);
      try {
        const next: ShelfRow[] = [];
        for (const scope of scopes) { const shelf = await openTemplateShelf(scope); try { next.push(...(await shelf.list()).map(item => ({ ...item, scope, key: `${templateScopeKey(scope)}/${item.id}` }))); } finally { shelf.close(); } }
        if (current) setRows(next.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")));
      } catch (failure) { if (current) setError(failureText(failure)); }
      finally { if (current) setLoading(false); }
    };
    void read(); return () => { current = false; };
  }, [scopes, refresh]);
  const guard = (key: string, scope?: TemplateScope) => {
    if (!active.current || account.current !== key || (scope?.kind === "account" && (authLoading || scope.ownerId !== owner))) throw new Error("The active account changed. Reopen the template shelf to continue.");
  };
  const run = async (label: string, work: (key: string) => Promise<void>): Promise<boolean> => {
    if (job.current) return false;
    const key = account.current; job.current = true; setBusy(label); setError(null); setNotice(null);
    try { await work(key); return true; }
    catch (failure) { if (active.current && account.current === key) setError(failureText(failure)); return false; }
    finally { job.current = false; if (active.current) setBusy(null); }
  };
  const act = (row: ShelfRow, action: Action, nextName?: string) => run(action, async key => {
    guard(key, row.scope);
    const shelf = await openTemplateShelf(row.scope);
    try {
      guard(key, row.scope);
      if (action === "delete") await shelf.delete(row.id, row.revision);
      else if (action === "rename") await shelf.rename(row.id, nextName ?? row.name, row.revision);
      else if (action === "duplicate") await shelf.duplicate(row.id);
      else if (action === "raw") { const raw = await shelf.exportRaw(row.id); guard(key, row.scope); setRecovery({ key: row.key, ...raw }); return; }
      else {
        const loaded = await shelf.load(row.id); guard(key, row.scope);
        if (!loaded || loaded.kind !== "current") throw new Error("This recipe is unavailable for editing. Keep its recovery files and try a newer app.");
        if (action === "export") {
          const blob = await exportTemplateBundle(loaded.recipe, loaded.decorations, { includeText }); guard(key, row.scope);
          downloadProjectBlob(blob, projectDownloadName(loaded.recipe.name, "pbtemplate")); setNotice(includeText ? "Template export prepared with its saved text." : "Template export prepared. Captions and text layers are blank; no source photos are included."); return;
        }
        let design = designFromRecipe(loaded.recipe);
        if (action === "new") {
          const plan = templateForNewProject(design); design = plan.design;
          await session.startProject({ name: loaded.recipe.name, mode: plan.mode, role: "A", participants: plan.roles.map(role => ({ id: crypto.randomUUID(), role })), capture: { requiredShots: plan.requiredShots }, editor: { layoutId: plan.layoutId } }); guard(key, row.scope);
        } else if (!session.project || Object.keys(design.requiredSources).some(role => !session.project!.participants.some(person => person.role === role))) throw new Error("This template needs different participant roles. Choose New project to assign its roles to a fresh project.");
        const applied = await session.applyTemplate(design, loaded.decorations); guard(key, row.scope);
        router.push(applied.mode === "solo" && !applied.media.some(item => item.kind === "photo") ? "/booth" : "/customize"); return;
      }
      guard(key, row.scope); focusAfterMutation.current = true; setRefresh(value => value + 1); setRecovery(null);
      setNotice(action === "delete" ? "Template deleted from this browser." : action === "rename" ? "Template name saved." : "A separate template copy is saved in the same local scope.");
    } finally { shelf.close(); }
  });
  const saveCurrent = () => run("save", async key => {
    const project = await session.flushEditor(); guard(key);
    if (!project) throw new Error("Open a project before saving its design as a template.");
    const design = templateFromProject(project), timestamp = new Date().toISOString();
    const scope: TemplateScope = destination === "account" && owner && !authLoading ? { kind: "account", ownerId: owner } : { kind: "device" };
    const recipe = validateTemplateRecipe({ ...design, schemaVersion: 1, id: crypto.randomUUID(), name: name.trim(), revision: 0, scope, createdAt: timestamp, updatedAt: timestamp });
    const available = session.getDecorationBlobs(), decorations = new Map(design.decorations.map(item => { const blob = available.get(item.id); if (!blob) throw new Error("A PNG decoration is missing. Reopen the project and try again."); return [item.id, blob] as const; }));
    const shelf = await openTemplateShelf(scope); try { guard(key, scope); await shelf.save(recipe, decorations, null); } finally { shelf.close(); }
    guard(key, scope); setSaving(false); setRefresh(value => value + 1); setNotice("Template saved locally with its layout, look and text defaults. Source photos stay in your project.");
  });
  const importFile = (file: File) => run("import", async key => {
    const imported = await importTemplateBundle(file); guard(key);
    const shelf = await openTemplateShelf({ kind: "device" }); try { guard(key); await shelf.save(imported.recipe, imported.decorations, null); } finally { shelf.close(); }
    guard(key); setRefresh(value => value + 1); setNotice("Template imported into this browser. Choose a project to use it.");
  });

  return <main className="mx-auto flex min-h-dvh w-full max-w-4xl flex-1 flex-col px-5 py-6 sm:px-8 sm:py-8">
    <header className="mt-8 flex flex-col justify-between gap-6 border-b border-border pb-7 sm:flex-row sm:items-end"><div><h1 ref={heading} tabIndex={-1} className="font-display text-4xl font-semibold focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring sm:text-5xl">My templates</h1><p className="mt-3 max-w-lg text-foreground/70">Reuse your favourite layouts and looks.</p></div><div className="flex shrink-0 flex-wrap gap-2"><button type="button" disabled={Boolean(busy) || session.hydrating || !session.project} onClick={() => setSaving(value => !value)} className={`${control} bg-accent text-accent-foreground hover:bg-accent/90`}><Plus size={17} aria-hidden /> Save current design</button><button type="button" disabled={Boolean(busy)} onClick={() => input.current?.click()} className={`${control} border border-border bg-card`}><Upload size={17} aria-hidden /> Import</button><input ref={input} type="file" accept={`.pbtemplate,${TEMPLATE_BUNDLE_MIME}`} className="sr-only" tabIndex={-1} aria-label="Import a template bundle" onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void importFile(file); }} /></div></header>
    <div className="mt-4 flex flex-wrap items-center justify-between gap-2"><div className="flex min-w-0 items-center gap-2"><p className="max-w-xl text-sm text-foreground/70">{owner ? "Your device and account shelves are local to this browser." : "No account needed. Templates stay in this browser."}</p><HelpTooltip label="About template roles">New projects assign template roles in order, A to D.</HelpTooltip></div><button type="button" disabled={Boolean(busy) || loading} onClick={() => setRefresh(value => value + 1)} className={control}><RefreshCw size={15} aria-hidden /> Refresh</button></div>
    {saving && <form className="mt-5 flex flex-wrap items-end gap-3 rounded-xl bg-muted p-4" onSubmit={event => { event.preventDefault(); void saveCurrent(); }}><label className="min-w-0 flex-1 basis-52 text-sm font-medium">Template name<input data-template-focus="name" value={name} disabled={Boolean(busy)} onChange={event => setName(event.target.value)} maxLength={100} required className="mt-1 min-h-11 w-full rounded-xl border border-border bg-card px-3 outline-ring" /></label><Dropdown label="Save to" value={destination} options={[{ value: "device", label: "This browser" }, ...(owner && !authLoading ? [{ value: "account", label: "My account on this device" }] : [])]} onChange={setDestination} disabled={Boolean(busy)} /><button disabled={Boolean(busy) || !name.trim()} className={`${control} bg-accent text-accent-foreground hover:bg-accent/90`}>Save template</button><button type="button" disabled={Boolean(busy)} onClick={() => setSaving(false)} className={control}>Cancel</button></form>}
    {error && <div role="alert" className="mt-4 rounded-xl bg-muted p-4"><p className="font-medium">That action could not finish</p><p className="mt-1 break-words text-sm">{error}</p></div>}
    {notice && <p role="status" className="mt-4 rounded-xl bg-muted p-4 text-sm">{notice}</p>}
    {busy && <p role="status" className="mt-4 flex items-center gap-2 text-sm"><LoaderCircle size={16} className="animate-spin motion-reduce:animate-none" aria-hidden /> {busy === "import" ? "Checking the recipe and its PNG files…" : "Working with your local template…"}</p>}
    <div className="mt-5 flex flex-wrap items-center justify-between gap-3"><label className="flex min-h-11 max-w-xl cursor-pointer items-center gap-3 text-sm"><input type="checkbox" checked={includeText} disabled={Boolean(busy)} onChange={event => setIncludeText(event.target.checked)} className="size-4 shrink-0 accent-accent" /><span>Include saved captions and text when exporting. They may contain personal details.</span></label><Link href="/templates/design" className={control}><LayoutTemplate size={17} aria-hidden /> Design current project</Link></div>
    {loading ? <p role="status" className="flex min-h-48 items-center justify-center gap-2 text-sm text-foreground/70"><LoaderCircle size={18} className="animate-spin motion-reduce:animate-none" aria-hidden /> Opening your template shelf…</p> : page.length ? <><ul aria-label="Saved templates" className="mt-3">{page.map(item => <TemplateRow key={item.key} item={item} busy={Boolean(busy)} canApply={Boolean(session.project) && !session.hydrating} recovery={recovery} act={act} />)}</ul>{visible.length > page.length && <button type="button" onClick={() => setCount(value => value + 20)} className={`${control} my-4 self-center bg-muted`}>Show more templates</button>}</> : !error && <section className="flex min-h-64 flex-col items-start justify-center py-10"><h2 className="font-display text-2xl font-semibold">Make the next strip feel like you.</h2><p className="mt-3 max-w-lg text-foreground/70">Save your current design, make a frame, or import a .pbtemplate file. Recipes never include source photos.</p><Link href="/templates/design" className={`${control} mt-5 bg-accent text-accent-foreground hover:bg-accent/90`}><LayoutTemplate size={17} aria-hidden /> Design a frame</Link></section>}
    <footer className="mt-8 border-t border-border pt-5 pb-3"><p className="max-w-2xl text-sm text-foreground/70">Back up templates before clearing browser data. Account templates hide on sign-out. Exports include PNG decorations, but no source photos, room access or account details.</p></footer>
  </main>;
}
