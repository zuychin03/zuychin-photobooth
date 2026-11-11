"use client";
import { useAppNavigationGuard } from "@/components/AppNavigation";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowUpFromLine, Camera, Cloud, HardDrive, LoaderCircle, RefreshCw } from "lucide-react";
import { ProjectLibraryRow, type LibraryAction, type LibraryProject } from "@/components/ProjectLibraryRow";
import { useAuth } from "@/lib/auth";
import { useBoothSession } from "@/lib/session";
import { exportProjectBundle, importProjectBundle } from "@/lib/projects/bundle";
import { downloadProjectBlob, projectDownloadName } from "@/lib/projects/download";
import { discardProjectEditorRecovery } from "@/lib/projects/editor-queue";
import { projectImageToCanvas } from "@/lib/projects/images";
import type { ProjectScope } from "@/lib/projects/model";
import { openProjectRepository, type LoadedProject } from "@/lib/projects/storage";
import { RoomMetadataHousekeeping } from "@/components/RoomMetadataHousekeeping";
import { PageHeader } from "@/components/ui/PageHeader";
import { Section } from "@/components/ui/Section";

const message = (error: unknown) => error instanceof Error ? error.message : "Couldn't open the project. Try again, or download its recovery files to be safe.";
const scopeId = (scope: ProjectScope) => scope.kind === "device" ? "device" : `account:${scope.ownerId}`;
const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toLocaleString("en-AU", { maximumFractionDigits: 1 })} MiB`;

async function thumbnail(loaded: LoadedProject): Promise<Blob | null> {
  if (loaded.kind !== "current") return null;
  const id = Object.values(loaded.project.sourceOrder).flat().find(Boolean);
  const declaration = loaded.project.media.find(item => item.id === id), blob = id ? loaded.media.get(id) : null;
  if (!declaration || !blob) return null;
  const original = await projectImageToCanvas(blob, declaration), small = document.createElement("canvas");
  const scale = Math.min(160 / original.width, 160 / original.height, 1);
  small.width = Math.max(1, Math.round(original.width * scale)); small.height = Math.max(1, Math.round(original.height * scale));
  try {
    small.getContext("2d")?.drawImage(original, 0, 0, small.width, small.height);
    return await new Promise<Blob | null>(resolve => small.toBlob(resolve, "image/webp", 0.75));
  } finally { original.width = original.height = small.width = small.height = 0; }
}

export default function ProjectsPage() {
  const router = useRouter(), { user, loading: authLoading } = useAuth();
  const session = useBoothSession(), owner = user?.id ?? null;
  const [rows, setRows] = useState<LibraryProject[]>([]), [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null), [refresh, setRefresh] = useState(0), [count, setCount] = useState(20);
  useAppNavigationGuard(() => {
    if (!busy) return true;
    setNotice("Wait for this to finish before you leave."); return false;
  });
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const [estimate, setEstimate] = useState<{ usage?: number; quota?: number; persisted: boolean } | null>(null);
  const input = useRef<HTMLInputElement>(null), authEpoch = useRef(0);
  const heading = useRef<HTMLHeadingElement>(null), focusAfterAction = useRef(false);
  useLayoutEffect(() => {
    if (busy || !focusAfterAction.current) return;
    focusAfterAction.current = false;
    heading.current?.focus({ preventScroll: true });
  }, [busy]);
  const scopes = useMemo<ProjectScope[]>(() => [{ kind: "device" }, ...(owner && !authLoading ? [{ kind: "account" as const, ownerId: owner }] : [])], [owner, authLoading]);
  const visible = useMemo(() => rows.filter(item => item.scope.kind === "device" || (!authLoading && item.scope.ownerId === owner)), [rows, owner, authLoading]);
  const page = useMemo(() => visible.slice(0, count), [visible, count]);
  useEffect(() => { authEpoch.current++; }, [owner, authLoading]);

  useEffect(() => {
    let active = true;
    const read = async () => {
      setLoading(true); setError(null);
      try {
        const next: LibraryProject[] = [];
        for (const scope of scopes) {
          const repository = await openProjectRepository(scope);
          try { next.push(...(await repository.list()).map(row => ({ ...row, scope, key: `${scopeId(scope)}/${row.id}` }))); }
          finally { repository.close(); }
        }
        if (active) setRows(next.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")));
      } catch (failure) { if (active) setError(message(failure)); }
      finally { if (active) setLoading(false); }
    };
    void read();
    return () => { active = false; };
  }, [scopes, refresh]);

  useEffect(() => {
    let active = true;
    const urls: string[] = [];
    const preview = async () => {
      setThumbnails({});
      for (const item of page) {
        if (!active) break;
        if (item.readOnly) continue;
        const repository = await openProjectRepository(item.scope);
        try {
          const loaded = await repository.load(item.id), image = loaded ? await thumbnail(loaded) : null;
          if (active && image) {
            const url = URL.createObjectURL(image); urls.push(url);
            setThumbnails(previous => ({ ...previous, [item.key]: url }));
          }
        } catch { /* A failed preview never prevents opening the recovery files. */ }
        finally { repository.close(); }
      }
    };
    void preview().catch(() => {});
    return () => { active = false; for (const url of urls) URL.revokeObjectURL(url); };
  }, [page]);

  useEffect(() => {
    let active = true;
    const read = async () => {
      if (!navigator.storage?.estimate) return;
      try {
        const sizes = await navigator.storage.estimate(), persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
        if (active) setEstimate({ usage: sizes.usage, quota: sizes.quota, persisted });
      } catch { /* Storage estimates are optional browser information. */ }
    };
    void read();
    return () => { active = false; };
  }, [refresh]);

  const assertVisible = useCallback((scope: ProjectScope, epoch: number) => {
    if (epoch !== authEpoch.current || (scope.kind === "account" && (authLoading || scope.ownerId !== owner))) throw new Error("You switched accounts. Reopen My projects to keep going.");
  }, [owner, authLoading]);

  const readRecovery = async (item: LibraryProject): Promise<LoadedProject> => {
    const epoch = authEpoch.current;
    assertVisible(item.scope, epoch);
    const repository = await openProjectRepository(item.scope);
    try {
      const loaded = await repository.load(item.id);
      assertVisible(item.scope, epoch);
      if (!loaded) throw new Error("This project isn't in this browser anymore. Refresh the list.");
      return loaded;
    } finally { repository.close(); }
  };

  const act = async (item: LibraryProject, action: LibraryAction, name?: string) => {
    const epoch = authEpoch.current;
    let recoveryDiscarded = false;
    setBusy(item.key); setError(null); setNotice(null);
    try {
      assertVisible(item.scope, epoch);
      if (action !== "delete" && session.project?.id === item.id && scopeId(session.project.scope) === scopeId(item.scope) && session.storageStatus === "saving") await session.flush();
      if (action === "delete") {
        await discardProjectEditorRecovery(item);
        recoveryDiscarded = true;
      }
      assertVisible(item.scope, epoch);
      const repository = await openProjectRepository(item.scope);
      try {
        if (action === "rename") await repository.rename(item.id, name ?? item.name, item.revision);
        else if (action === "duplicate") await repository.duplicate(item.id);
        else if (action === "delete") {
          const latest = await repository.load(item.id);
          assertVisible(item.scope, epoch);
          if (!latest || latest.kind !== "current") throw new Error("This project is gone or needs recovering. Refresh the list and try again.");
          await repository.delete(item.id, latest.project.revision);
          if (session.project?.id === item.id && scopeId(session.project.scope) === scopeId(item.scope)) await session.forgetProject(item.id, item.scope);
        }
        else if (action === "recover") await repository.recoverCheckpoint(item.id, item.revision);
        else {
          const loaded = await repository.load(item.id);
          if (!loaded || loaded.kind !== "current") throw new Error("This project can't be opened in this version of the app. Keep its recovery files.");
          assertVisible(item.scope, epoch);
          if (action === "export") {
            const bundle = await exportProjectBundle(loaded.project, loaded.media);
            assertVisible(item.scope, epoch);
            downloadProjectBlob(bundle, projectDownloadName(loaded.project.name, "pbproject"));
            setNotice("Backup downloaded. Keep the .pbproject file somewhere safe.");
          } else {
            await session.openProject(item.id, item.scope);
            assertVisible(item.scope, epoch);
            router.push(loaded.project.media.some(media => media.kind === "photo") ? "/customize" : "/booth");
          }
        }
      } finally { repository.close(); }
      if (["rename", "duplicate", "delete", "recover"].includes(action)) {
        assertVisible(item.scope, epoch); setRefresh(value => value + 1);
        if (["rename", "recover"].includes(action) && session.project?.id === item.id && scopeId(session.project.scope) === scopeId(item.scope)) await session.openProject(item.id, item.scope);
        setNotice(action === "delete" ? "Project deleted." : action === "recover" ? "Previous save restored." : action === "duplicate" ? "Copy saved." : "Renamed.");
      }
    } catch (failure) {
      setError(recoveryDiscarded ? `${message(failure)} Any unsaved edits to it were already thrown away. Refresh the list to see where things stand.` : message(failure));
      throw failure;
    }
    finally { if (epoch === authEpoch.current && action !== "resume") focusAfterAction.current = true; setBusy(null); }
  };

  const importFile = async (file: File) => {
    const epoch = authEpoch.current;
    setBusy("import"); setError(null); setNotice(null);
    try {
      const imported = await importProjectBundle(file);
      assertVisible({ kind: "device" }, epoch);
      const repository = await openProjectRepository({ kind: "device" });
      try { await repository.save(imported.project, imported.media, null); }
      finally { repository.close(); }
      setRefresh(value => value + 1);
      assertVisible({ kind: "device" }, epoch);
      await session.openProject(imported.project.id, { kind: "device" });
      router.push(imported.project.media.some(media => media.kind === "photo") ? "/customize" : "/booth");
    } catch (failure) { setError(message(failure)); }
    finally { setBusy(null); }
  };

  const create = async () => {
    setBusy("create"); setError(null);
    try { await session.startProject(); router.push("/booth"); }
    catch (failure) { setError(message(failure)); }
    finally { setBusy(null); }
  };
  const persist = async () => {
    setBusy("storage"); setError(null);
    try {
      const granted = navigator.storage?.persist ? await navigator.storage.persist() : false;
      setNotice(granted ? "Done. Your browser won't clear these files on its own, but clearing your browser data still deletes them, so keep a backup too." : "Your browser didn't allow this. Export the projects you want to keep.");
      setRefresh(value => value + 1);
    } catch (failure) { setError(message(failure)); }
    finally { setBusy(null); }
  };

  const used = estimate?.usage !== undefined && estimate.quota ? Math.min(1, estimate.usage / estimate.quota) : null;
  return <main className="mx-auto flex min-h-dvh w-full max-w-5xl flex-1 flex-col gap-6 px-4 pt-4 pb-10 sm:px-8 sm:pt-6">
    <PageHeader title="My projects" headingRef={heading} meta={owner ? "Includes drafts from your account. Nothing uploads automatically." : undefined} actions={<>
      <button type="button" disabled={Boolean(busy) || session.hydrating} onClick={() => void create()} className="btn btn-primary"><Camera size={18} aria-hidden /> New project</button>
      <button type="button" disabled={Boolean(busy)} onClick={() => input.current?.click()} className="btn btn-quiet"><ArrowUpFromLine size={17} aria-hidden /> Import</button>
      <Link href="/projects/cloud" className="btn btn-quiet"><Cloud size={17} aria-hidden /> Cloud projects</Link>
      <input ref={input} type="file" accept=".pbproject,application/x-photobooth-project" className="sr-only" tabIndex={-1} aria-label="Import a .pbproject file" onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void importFile(file); }} />
    </>} />
    <div className="page-body flex flex-col gap-5">
      {error && <div role="alert" className="notice border border-destructive/25 bg-destructive/8"><p className="font-bold text-destructive">That didn&apos;t work</p><p className="mt-1 break-words">{error}</p><p className="mt-1 text-muted-foreground">If it&apos;s open in another tab, refresh and try again.</p></div>}
      {notice && <p role="status" className="notice max-w-2xl">{notice}</p>}
      {busy && <p role="status" className="flex items-center gap-2 text-sm font-bold"><LoaderCircle size={16} className="animate-spin text-accent motion-reduce:animate-none" aria-hidden /> {busy === "import" ? "Importing the project…" : busy === "create" ? "Starting a new project…" : "Working on it…"}</p>}
      {loading ? <p role="status" className="panel flex min-h-48 items-center justify-center gap-2 text-sm text-muted-foreground"><LoaderCircle size={18} className="animate-spin motion-reduce:animate-none" aria-hidden /> Loading your projects…</p> : visible.length ? <section aria-labelledby="project-list-title" className="panel overflow-hidden">
        <div className="flex items-center justify-between gap-3 border-b border-border py-2 pr-2 pl-4 sm:pl-5"><h2 id="project-list-title" className="text-sm font-bold text-muted-foreground tabular-nums">{visible.length} {visible.length === 1 ? "project" : "projects"}</h2><button type="button" className="btn btn-plain min-h-10 text-sm" disabled={Boolean(busy) || loading} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={15} aria-hidden /> Refresh</button></div>
        <ul aria-label="Your projects" className="divide-y divide-border">{page.map(item => <ProjectLibraryRow key={item.key} item={item} thumbnail={thumbnails[item.key]} busy={Boolean(busy)} onAction={act} onRecovery={readRecovery} />)}</ul>
        {visible.length > page.length && <div className="border-t border-border p-3 text-center"><button type="button" onClick={() => setCount(value => value + 20)} className="btn btn-quiet text-sm">Show more projects</button></div>}
      </section> : !error && <section className="panel flex min-h-64 flex-col items-center justify-center gap-4 px-6 py-12 text-center"><span className="glyph size-14 rounded-2xl bg-[#f43f5e]"><Camera size={26} aria-hidden /></span><h2 className="font-display text-2xl">No projects yet</h2><button type="button" disabled={Boolean(busy) || session.hydrating} onClick={() => void create()} className="btn btn-primary"><Camera size={18} aria-hidden /> Start your first project</button></section>}
      <div className="grid gap-5 lg:grid-cols-2">
        <Section id="project-backup-title" title="Back up your projects" icon={HardDrive} tone="sky" bodyClassName="mt-3">
          <p className="text-sm text-muted-foreground">Browsers can clear their storage, so export anything you want to keep.</p>
          {estimate && <div className="mt-4">
            {used !== null && <div className="h-2 overflow-hidden rounded-full bg-muted" aria-hidden><div className="h-full rounded-full bg-[#0ea5e9]" style={{ width: `${Math.max(2, used * 100)}%` }} /></div>}
            <p className="mt-2 text-sm font-bold tabular-nums">{estimate.usage !== undefined ? `${megabytes(estimate.usage)} used` : "Storage use unknown"}{estimate.quota !== undefined ? <span className="font-medium text-muted-foreground"> of about {megabytes(estimate.quota)}</span> : null}</p>
          </div>}
          <button type="button" disabled={Boolean(busy) || estimate?.persisted} onClick={() => void persist()} className="btn btn-quiet mt-4 text-sm">{estimate?.persisted ? "Your browser is keeping these files" : "Ask your browser to keep these files"}</button>
        </Section>
        <RoomMetadataHousekeeping ownerId={authLoading ? null : owner} />
      </div>
    </div>
  </main>;
}
