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

const control = "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 text-sm font-medium transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-wait disabled:opacity-50";
const message = (error: unknown) => error instanceof Error ? error.message : "The project could not be opened. Try again or keep a recovery backup.";
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
    setNotice("Wait for the current project action to finish before leaving."); return false;
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
    if (epoch !== authEpoch.current || (scope.kind === "account" && (authLoading || scope.ownerId !== owner))) throw new Error("The active account changed. Open the library again to continue.");
  }, [owner, authLoading]);

  const readRecovery = async (item: LibraryProject): Promise<LoadedProject> => {
    const epoch = authEpoch.current;
    assertVisible(item.scope, epoch);
    const repository = await openProjectRepository(item.scope);
    try {
      const loaded = await repository.load(item.id);
      assertVisible(item.scope, epoch);
      if (!loaded) throw new Error("This project no longer exists in this browser. Refresh the library.");
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
          if (!latest || latest.kind !== "current") throw new Error("This project no longer exists or needs recovery. Refresh the library before continuing.");
          await repository.delete(item.id, latest.project.revision);
          if (session.project?.id === item.id && scopeId(session.project.scope) === scopeId(item.scope)) await session.forgetProject(item.id, item.scope);
        }
        else if (action === "recover") await repository.recoverCheckpoint(item.id, item.revision);
        else {
          const loaded = await repository.load(item.id);
          if (!loaded || loaded.kind !== "current") throw new Error("This draft needs recovery or a newer app. Keep its recovery files.");
          assertVisible(item.scope, epoch);
          if (action === "export") {
            const bundle = await exportProjectBundle(loaded.project, loaded.media);
            assertVisible(item.scope, epoch);
            downloadProjectBlob(bundle, projectDownloadName(loaded.project.name, "pbproject"));
            setNotice("Project backup prepared. Keep the .pbproject file somewhere you can find it again.");
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
        setNotice(action === "delete" ? "Project deleted from this browser." : action === "recover" ? "Previous settings restored." : action === "duplicate" ? "A separate copy is saved on this device." : "Project name saved.");
      }
    } catch (failure) {
      setError(recoveryDiscarded ? `${message(failure)} Pending editor changes were discarded as part of the confirmed deletion. Refresh the library to check the saved project.` : message(failure));
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
      setNotice(granted ? "The browser granted persistent storage. Keep an exported backup too; clearing browser data still removes projects." : "The browser did not grant persistent storage. You can still use projects and export backups.");
      setRefresh(value => value + 1);
    } catch (failure) { setError(message(failure)); }
    finally { setBusy(null); }
  };

  return <main className="mx-auto flex min-h-dvh w-full max-w-4xl flex-1 flex-col px-5 py-6 sm:px-8 sm:py-8">
    <nav aria-label="Project navigation" className="flex flex-wrap items-center justify-between gap-2"><Link href="/projects/cloud" className={`${control} hover:bg-muted`}><Cloud size={17} aria-hidden /> Cloud projects</Link></nav>
    <header className="mt-8 flex flex-col gap-6 border-b border-border pb-7 sm:flex-row sm:items-end sm:justify-between">
      <div><h1 ref={heading} tabIndex={-1} className="font-display text-4xl font-semibold sm:text-5xl">My projects</h1><p className="mt-3 max-w-lg text-base text-foreground/70">Your photos and edits, saved on this device.</p></div>
      <div className="flex shrink-0 flex-wrap gap-2">
        <button type="button" disabled={Boolean(busy) || session.hydrating} onClick={() => void create()} className={`${control} bg-accent text-accent-foreground hover:bg-accent/90`}><Camera size={17} aria-hidden /> New project</button>
        <button type="button" disabled={Boolean(busy)} onClick={() => input.current?.click()} className={`${control} border border-border bg-card hover:bg-muted`}><ArrowUpFromLine size={17} aria-hidden /> Import project</button>
        <input ref={input} type="file" accept=".pbproject,application/x-photobooth-project" className="sr-only" tabIndex={-1} aria-label="Import a .pbproject file" onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void importFile(file); }} />
      </div>
    </header>
    <div className="mt-5 flex flex-wrap items-center justify-between gap-2 text-sm text-foreground/70"><p>{owner ? "Device projects and account drafts. No automatic uploads." : "No account needed. These projects stay in this browser."}</p><button type="button" className={control} disabled={Boolean(busy) || loading} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={15} aria-hidden /> Refresh</button></div>
    {error && <div role="alert" className="mt-4 rounded-xl border border-border bg-muted p-4"><p className="font-medium">That action could not finish</p><p className="mt-1 break-words text-sm">{error}</p><p className="mt-2 text-sm text-foreground/70">Refresh if another tab changed this project. Your existing saved files have not been replaced by a failed save.</p></div>}
    {notice && <p role="status" className="mt-4 max-w-2xl rounded-xl bg-muted p-4 text-sm">{notice}</p>}
    {busy && <p role="status" className="mt-4 flex items-center gap-2 text-sm"><LoaderCircle size={16} className="animate-spin motion-reduce:animate-none" aria-hidden /> {busy === "import" ? "Checking the project and saving its originals…" : busy === "create" ? "Preparing a new project…" : "Working with your local files…"}</p>}
    {loading ? <p role="status" className="flex min-h-48 items-center justify-center gap-2 text-sm text-foreground/70"><LoaderCircle size={18} className="animate-spin motion-reduce:animate-none" aria-hidden /> Opening this browser&apos;s library…</p> : visible.length ? <>
      <ul aria-label="Saved local projects" className="mt-6">{page.map(item => <ProjectLibraryRow key={item.key} item={item} thumbnail={thumbnails[item.key]} busy={Boolean(busy)} onAction={act} onRecovery={readRecovery} />)}</ul>
      {visible.length > page.length && <button type="button" onClick={() => setCount(value => value + 20)} className={`${control} my-4 self-center bg-muted`}>Show more projects</button>}
    </> : !error && <section className="flex min-h-64 flex-col items-start justify-center py-10 sm:py-14"><h2 className="font-display text-2xl font-semibold">Start your first project.</h2><p className="mt-3 max-w-lg text-foreground/70">Take photos or import a .pbproject backup.</p><button type="button" disabled={Boolean(busy) || session.hydrating} onClick={() => void create()} className={`${control} mt-5 bg-accent text-accent-foreground hover:bg-accent/90`}><Camera size={17} aria-hidden /> Start your first project</button></section>}
    <footer className="mt-8 border-t border-border pt-6 pb-3">
      <RoomMetadataHousekeeping ownerId={authLoading ? null : owner} />
      <div className="flex items-start gap-3"><HardDrive size={19} className="mt-0.5 shrink-0 text-foreground/60" aria-hidden /><div><h2 className="font-medium">Keep a copy beyond this browser</h2><p className="mt-2 max-w-2xl text-sm text-foreground/70">Browser storage can be cleared. Back up important projects as .pbproject files. Account drafts stay local and are hidden when you sign out.</p>
        {estimate && <p className="mt-2 text-sm text-foreground/70 tabular-nums">{estimate.usage !== undefined ? `${megabytes(estimate.usage)} used by this site` : "Site storage estimate unavailable"}{estimate.quota !== undefined ? ` · ${megabytes(estimate.quota)} estimated site allowance` : ""}. {estimate.persisted ? "Persistent storage granted." : "Storage is best effort."}</p>}
        <button type="button" disabled={Boolean(busy) || estimate?.persisted} onClick={() => void persist()} className={`${control} -ml-4 mt-2 underline underline-offset-4`}>{estimate?.persisted ? "Persistent storage is enabled" : "Ask browser to keep local files"}</button>
      </div></div>
    </footer>
  </main>;
}
