"use client";
import { useRecoveryRelease } from "@/components/ReleaseMode";
import { useAppNavigationGuard } from "@/components/AppNavigation";
import type { ChallengeDraftJournal } from "@/lib/memories/challenge-drafts";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { ArrowDownToLine, ArrowRight, Eye, ImageIcon, Images, LoaderCircle, LockKeyhole, RefreshCw, Sticker, Trash2, Trophy, Upload, Users, X } from "lucide-react";
import { Dropdown } from "@/components/Dropdown";
import { MobileControlPanel } from "@/components/MobileControlPanel";
import type { CloudProjectAsset, CloudProjectView } from "@/lib/projects/cloud-contract";
import type { CloudProjectClient } from "@/lib/projects/cloud-client";
import type { CloudUploadManager, CloudUploadRecord } from "@/lib/projects/cloud-upload";
import { downloadProjectBlob } from "@/lib/projects/download";
import { CloudBack, cloudError, cloudSize } from "./CloudControls";
import { CloudMembers } from "./CloudMembers";
import type { ChallengeClient } from "@/lib/memories/challenge-client";
import { ChallengeWorkspace } from "./ChallengeWorkspace";
import { CloudDesignSavePanel } from "./CloudDesignSavePanel";
import type { CloudDesignSaveCoordinator } from "@/lib/projects/cloud-design-save";
import { CloudDesignPanel } from "./CloudDesignPanel";
import type { CloudDesignOpenResult } from "@/lib/projects/cloud-design-open";
import type { openProjectRepository } from "@/lib/projects/storage";

interface Props { client: CloudProjectClient; uploads: CloudUploadManager; designs?: CloudDesignSaveCoordinator; challenges?: ChallengeClient; drafts?: ChallengeDraftJournal; initialView: CloudProjectView; onBack(): void; onOpenDesign?(result: Extract<CloudDesignOpenResult, { kind: "opened" }>): Promise<void>; openRepository?: typeof openProjectRepository }
const stage = { prepared: "Ready to upload", reserved: "Space reserved", uploading: "Uploading", uploaded: "Uploaded, checking", finalising: "Checking", ready: "Ready", failed: "Didn't finish" };

export function CloudProjectDetail({ client, uploads, designs, challenges, drafts, initialView, onBack, onOpenDesign, openRepository }: Props) {
  const recovery = useRecoveryRelease();
  const [view, setView] = useState(initialView), [records, setRecords] = useState<CloudUploadRecord[]>([]);
  const [kind, setKind] = useState<"photo" | "decoration">("photo");
  const [busy, setBusy] = useState<string | null>(null), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ id: string; url: string; width: number; height: number } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null), [dismissing, setDismissing] = useState<string | null>(null);
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);
  const [deleteProject, setDeleteProject] = useState(false);
  const [showChallenges, setShowChallenges] = useState(false);
  const [uploadPanelOpen, setUploadPanelOpen] = useState(false);
  const [focusTarget, focusControl] = useState<string | null>(null);
  const files = useRef(new Map<string, File>()), controller = useRef<AbortController | null>(null), mounted = useRef(false);
  const picker = useRef<HTMLInputElement>(null), resumeId = useRef<string | null>(null), running = useRef(false);
  const previewUrl = useRef<string | null>(null), projectId = view.project.id;
  const heading = useRef<HTMLHeadingElement>(null);
  useAppNavigationGuard(() => {
    if (!busy && !running.current) return true;
    setNotice("Wait for this to finish before you leave."); return false;
  }, !showChallenges);
  const joinedCount = view.members.filter(member => member.status === "accepted").length;

  useEffect(() => { if (focusTarget && !busy) document.getElementById(focusTarget)?.focus(); }, [focusTarget, busy]);

  useEffect(() => {
    mounted.current = true;
    heading.current?.focus();
    void uploads.list().then(next => { if (mounted.current) setRecords(next.filter(item => item.projectId === initialView.project.id)); }).catch(() => { if (mounted.current) setError("Couldn't load unfinished uploads. Refresh to try again."); });
    const selectedFiles = files.current;
    return () => { mounted.current = false; controller.current?.abort(); selectedFiles.clear(); if (previewUrl.current) URL.revokeObjectURL(previewUrl.current); };
  }, [uploads, initialView.project.id]);

  const clearPreview = () => { if (previewUrl.current) URL.revokeObjectURL(previewUrl.current); previewUrl.current = null; setPreview(null); };
  const stopWaiting = () => { controller.current?.abort(); clearPreview(); setNotice("Stopped waiting. The upload might still finish, so check its status before sending it again."); };
  const updateRecords = async () => { const next = await uploads.list(); if (mounted.current) setRecords(next.filter(item => item.projectId === projectId)); };
  const refresh = async (signal: AbortSignal) => { clearPreview(); const next = await client.view(projectId, signal); if (!signal.aborted && mounted.current) setView(next); await updateRecords(); };
  const run = async (name: string, work: (signal: AbortSignal) => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    const abort = new AbortController(); controller.current = abort;
    setBusy(name); setError(null); setNotice(null);
    try { await work(abort.signal); }
    catch (failure) {
      if (mounted.current && !abort.signal.aborted) {
        const code = failure && typeof failure === "object" && "code" in failure ? failure.code : "";
        setError(code === "file_required" ? "Choose the same file to continue this upload." : code === "file_mismatch" ? "That's a different file. Choose the one you used for this upload." : name === "prepare" ? "Couldn't prepare this file. Choose a JPEG, PNG or WebP within the size limits." : cloudError(failure));
      }
    } finally {
      if (mounted.current) { await updateRecords().catch(() => {}); setBusy(null); }
      running.current = false;
    }
  };
  const choose = (file: File) => run("prepare", async signal => {
    const existing = resumeId.current; resumeId.current = null;
    files.current.clear();
    setSelectedFileId(null);
    if (existing) {
      files.current.set(existing, file);
      setSelectedFileId(existing);
      focusControl(`cloud-upload-${existing}`);
      setNotice("File selected. Choose Resume upload to continue.");
      await updateRecords();
    } else {
      const record = await uploads.prepare(projectId, file, { kind }, signal);
      if (!signal.aborted) { files.current.set(record.id, file); setSelectedFileId(record.id); focusControl(`cloud-upload-${record.id}`); setNotice("File ready. Choose Upload to send it."); }
      await updateRecords();
    }
  });
  const upload = (record: CloudUploadRecord, withFile: boolean) => run(record.id, async signal => {
    if (recovery && (withFile || record.state === "prepared")) return;
    const result = await uploads.run(record.id, withFile ? files.current.get(record.id) : undefined, signal);
    if (!signal.aborted) {
      if (result.state === "ready") { files.current.delete(record.id); setSelectedFileId(null); setNotice("Uploaded."); }
      else setNotice(result.state === "failed" ? "Couldn't check the upload. Keep the file on your device." : "Still waiting for confirmation. Check again soon, and don't upload it twice.");
    }
    await refresh(signal);
    if (!signal.aborted && result.state === "ready") { setUploadPanelOpen(false); focusControl("cloud-project-heading"); }
  });
  const show = (asset: CloudProjectAsset, download: boolean) => run(asset.id, async signal => {
    clearPreview();
    const blob = await client.download({ ...asset, projectId }, signal);
    client.assertActive(signal);
    if (download) { downloadProjectBlob(blob, `original-${asset.id}.${asset.mime === "image/jpeg" ? "jpg" : asset.mime.split("/")[1]}`); setNotice("Downloading now. Check your downloads folder."); }
    else { const url = URL.createObjectURL(blob); previewUrl.current = url; setPreview({ id: asset.id, url, width: asset.width, height: asset.height }); }
  });
  const remove = (asset: CloudProjectAsset) => run(asset.id, async signal => {
    clearPreview();
    await client.delete(projectId, asset.id, signal);
    if (!signal.aborted) { setDeleting(null); setNotice("Photo deleted."); }
    await refresh(signal);
    if (!signal.aborted) heading.current?.focus();
  });
  const pending = records.filter(record => record.state !== "ready");

  if (showChallenges && challenges) return <ChallengeWorkspace drafts={drafts} project={view} client={client} challenges={challenges} uploads={uploads} onBack={() => { setShowChallenges(false); void run("refresh", refresh); focusControl("cloud-project-heading"); }} />;

  const quiet = "btn btn-quiet min-h-10 text-sm";
  return <section className="flex flex-col gap-5" aria-labelledby="cloud-project-heading">
    <div><CloudBack disabled={Boolean(busy)} onBack={onBack} /></div>
    <header className="panel flex flex-wrap items-center justify-between gap-4 p-4 sm:p-6">
      <div className="flex min-w-0 items-center gap-4"><span className={`glyph size-12 rounded-2xl ${view.project.kind === "personal" ? "bg-[#0ea5e9]" : "bg-[#8b5cf6]"}`}>{view.project.kind === "personal" ? <LockKeyhole size={22} strokeWidth={2.25} aria-hidden /> : <Users size={22} strokeWidth={2.25} aria-hidden />}</span><div className="min-w-0"><h2 ref={heading} tabIndex={-1} id="cloud-project-heading" className="break-words font-display text-2xl leading-tight outline-none sm:text-3xl">{view.project.title}</h2><p className="mt-1 text-sm text-muted-foreground">{view.project.kind === "personal" ? "Only you" : `${joinedCount} ${joinedCount === 1 ? "person" : "people"} in this project`} · {cloudSize(view.project.maxBytes)} of storage</p></div></div>
      <button className="btn btn-plain min-h-10 text-sm" disabled={Boolean(busy)} onClick={() => void run("refresh", refresh)}><RefreshCw size={16} aria-hidden /> Refresh</button>
    </header>
    {error && <p role="alert" className="notice border border-destructive/25 bg-destructive/8 font-bold text-destructive">{error}</p>}
    {notice && <p role="status" className="notice max-w-2xl">{notice}</p>}
    {busy && busy !== "design" && busy !== "design-save" && <div className="flex flex-wrap items-center gap-3"><p role="status" className="flex items-center gap-2 text-sm font-bold"><LoaderCircle size={16} aria-hidden className="animate-spin text-accent motion-reduce:animate-none" /> {busy === "prepare" ? "Checking this file…" : "Waiting for confirmation…"}</p><button className={quiet} onClick={stopWaiting}>Stop waiting</button></div>}
    {!recovery && challenges && view.project.kind === "friend" && <section className="panel flex flex-wrap items-center justify-between gap-4 p-4 sm:p-6"><div className="flex min-w-0 items-center gap-3"><span className="glyph bg-[#f59e0b]"><Trophy size={18} strokeWidth={2.25} aria-hidden /></span><div className="min-w-0"><h3 className="font-display text-xl leading-tight">Photo challenges</h3><p className="mt-0.5 text-sm text-muted-foreground">Add photos in your own time, then reveal them together.</p></div></div><button className="btn btn-tinted" disabled={Boolean(busy)} onClick={() => { clearPreview(); setShowChallenges(true); }}>Open challenges <ArrowRight size={16} aria-hidden /></button></section>}
    <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_17rem] lg:grid-cols-[minmax(0,1fr)_19rem]">
      <aside className="min-w-0 md:panel md:col-start-2 md:row-start-1 md:p-5" aria-label="Upload tools">
        <MobileControlPanel open={uploadPanelOpen} onOpenChange={setUploadPanelOpen} label={pending.length ? "Add photos & unfinished uploads" : "Add photos"} title="Upload photos">
          {uploadPanelOpen && <>
            {error && <p role="alert" className="notice border border-destructive/25 bg-destructive/8 font-bold text-destructive">{error}</p>}
            {notice && <p role="status" className="notice">{notice}</p>}
            {busy && <div className="space-y-2"><p role="status" className="flex items-center gap-2 text-sm font-bold"><LoaderCircle size={16} aria-hidden className="animate-spin text-accent motion-reduce:animate-none" /> {busy === "prepare" ? "Checking this file…" : "Waiting for confirmation…"}</p><button className={quiet} onClick={stopWaiting}>Stop waiting</button></div>}
          </>}
          <section aria-labelledby="upload-heading"><div className="flex items-center gap-3"><span className="glyph bg-[#f43f5e]"><Upload size={18} strokeWidth={2.25} aria-hidden /></span><h3 id="upload-heading" className="font-display text-xl leading-tight">Add a photo</h3></div><p className="mt-3 text-sm text-muted-foreground">JPEG, PNG or WebP, up to 10 MiB and 4096 pixels per side.</p><div className="mt-4"><Dropdown label="Type" showLabel value={kind} onChange={value => setKind(value as typeof kind)} disabled={Boolean(busy)} options={[{ value: "photo", label: "Photo" }, { value: "decoration", label: "PNG decoration" }]} /></div>{kind === "decoration" && <p className="mt-2 text-sm text-muted-foreground">Decorations use PNG, up to 4 MiB and 2048 pixels per side.</p>}<button className="btn btn-primary mt-4 w-full" disabled={recovery || Boolean(busy)} onClick={() => { resumeId.current = null; if (picker.current) { picker.current.accept = kind === "decoration" ? "image/png" : "image/jpeg,image/png,image/webp"; picker.current.click(); } }}><Upload size={17} aria-hidden /> Choose {kind === "photo" ? "photo" : "decoration"}</button><input ref={picker} type="file" tabIndex={-1} className="sr-only" aria-label="Choose a file to upload" accept={kind === "decoration" ? "image/png" : "image/jpeg,image/png,image/webp"} onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void choose(file); }} /></section>
    {pending.length > 0 && <section className="border-t border-border pt-4" aria-labelledby="pending-heading">
      <h3 id="pending-heading" className="font-bold">Unfinished uploads</h3>
      <p className="mt-1 text-sm text-muted-foreground">To resume, choose the same file again.</p>
      <ul className="mt-2 divide-y divide-border">{pending.map((record, index) => <li key={record.id} className="py-3">
        <div className="flex flex-col gap-2">
          <div><p className="text-sm font-bold">{record.asset.kind === "decoration" ? "Decoration" : "Photo"} upload {index + 1}</p><p className="mt-0.5 text-sm text-muted-foreground">{busy === record.id ? "Waiting for confirmation" : stage[record.state]} · {cloudSize(record.asset.bytes)} · {record.asset.width} × {record.asset.height}</p></div>
          <div className="flex flex-wrap gap-1.5">
            {record.state !== "failed" && <>
              {selectedFileId === record.id && <button id={`cloud-upload-${record.id}`} className="btn btn-primary min-h-10 text-sm" disabled={recovery || Boolean(busy)} onClick={() => void upload(record, true)}><Upload size={16} aria-hidden /> {record.state === "prepared" ? "Upload" : "Resume upload"}</button>}
              {record.state !== "prepared" && <button className={quiet} disabled={Boolean(busy)} onClick={() => void upload(record, false)}>Check status</button>}
              {selectedFileId !== record.id && <button className={quiet} disabled={recovery || Boolean(busy)} onClick={() => { resumeId.current = record.id; if (picker.current) { picker.current.accept = record.asset.mime; picker.current.click(); } }}>Choose same file</button>}
            </>}
            {["prepared", "failed"].includes(record.state) && <button id={`cloud-dismiss-${record.id}`} className="btn btn-plain min-h-10 text-sm" disabled={Boolean(busy)} onClick={() => { setDismissing(record.id); focusControl(`cloud-confirm-dismiss-${record.id}`); }}>Remove from list</button>}
          </div>
        </div>
        {record.state === "failed" && <p className="mt-2 text-sm text-muted-foreground">Keep the file on your device.</p>}
        {dismissing === record.id && <div className="notice mt-3"><p>Remove this from the list? Nothing is deleted from the cloud. Refresh first if you&apos;re not sure the upload finished.</p><div className="mt-3 flex flex-wrap gap-2"><button id={`cloud-confirm-dismiss-${record.id}`} className="btn btn-danger min-h-10 text-sm" disabled={Boolean(busy)} onClick={() => void run("dismiss", async () => { await uploads.forget(record.id); files.current.delete(record.id); setSelectedFileId(null); setDismissing(null); await updateRecords(); setNotice("Removed from the list."); setUploadPanelOpen(false); focusControl("cloud-project-heading"); })}>Remove</button><button className={quiet} disabled={Boolean(busy)} onClick={() => { setDismissing(null); focusControl(`cloud-dismiss-${record.id}`); }}>Cancel</button></div></div>}
      </li>)}</ul>
    </section>}
        </MobileControlPanel>
      </aside>
      <section aria-labelledby="originals-heading" className="panel min-w-0 p-4 sm:p-6 md:col-start-1 md:row-start-1">
        <div className="flex items-center justify-between gap-3"><div className="flex min-w-0 items-center gap-3"><span className="glyph bg-[#f43f5e]"><Images size={18} strokeWidth={2.25} aria-hidden /></span><h3 id="originals-heading" className="font-display text-xl leading-tight">Photos</h3></div>{view.assets.length > 0 && <span className="text-sm font-bold tabular-nums text-muted-foreground">{view.assets.length}</span>}</div>
        {view.assets.length ? <ul className="mt-4 grid gap-3 sm:grid-cols-2" aria-label="Project photos">{view.assets.map((asset, index) => <li key={asset.id} className={`panel-muted flex min-w-0 flex-col p-2.5 ${preview?.id === asset.id || deleting === asset.id ? "sm:col-span-2" : ""}`}>
          {preview?.id === asset.id ? <figure className="relative flex justify-center overflow-hidden rounded-2xl bg-card p-3 shadow-[inset_0_0_0_1px_var(--panel-stroke)]"><Image unoptimized src={preview.url} width={preview.width} height={preview.height} alt={`Photo ${index + 1}`} className="max-h-96 max-w-full rounded-xl object-contain" /><button className="glass absolute top-2 right-2 flex size-11 items-center justify-center rounded-full" aria-label="Close preview" onClick={clearPreview}><X size={17} aria-hidden /></button></figure> : <div className="flex aspect-[4/3] items-center justify-center rounded-2xl bg-card text-muted-foreground shadow-[inset_0_0_0_1px_var(--panel-stroke)]">{asset.kind === "decoration" ? <Sticker size={28} aria-hidden /> : <ImageIcon size={28} aria-hidden />}</div>}
          <div className="flex flex-wrap items-center justify-between gap-2 px-1.5 pt-2.5"><div className="min-w-0"><h4 className="font-bold">{asset.kind === "decoration" ? "PNG decoration" : "Photo"} {index + 1}</h4><p className="mt-0.5 text-xs text-muted-foreground">{asset.width} × {asset.height} · {cloudSize(asset.bytes)} · {asset.ownerId === client.ownerId ? "Yours" : "Shared"}</p></div><div className="flex flex-wrap gap-1"><button className="btn btn-quiet size-10 min-h-10 px-0" disabled={Boolean(busy)} aria-label={`Preview ${asset.kind === "decoration" ? "decoration" : "photo"} ${index + 1}`} onClick={() => void show(asset, false)}><Eye size={16} aria-hidden /></button><button className="btn btn-quiet size-10 min-h-10 px-0" disabled={Boolean(busy)} aria-label={`Download photo ${index + 1}`} onClick={() => void show(asset, true)}><ArrowDownToLine size={16} aria-hidden /></button>{asset.ownerId === client.ownerId && deleting !== asset.id && <button className="btn btn-quiet size-10 min-h-10 px-0 text-destructive" disabled={Boolean(busy)} id={`cloud-delete-${asset.id}`} onClick={() => { setDeleting(asset.id); focusControl(`cloud-confirm-delete-${asset.id}`); }}><Trash2 size={16} aria-hidden /><span className="sr-only">Delete photo</span></button>}</div></div>
          {asset.ownerId === client.ownerId && deleting === asset.id && <div className="notice mx-1.5 mt-2.5 mb-1 bg-card"><p>Delete this photo for everyone? You can&apos;t undo this, so download a copy first if you need one. Existing links may work for five minutes; downloaded copies remain.</p><div className="mt-3 flex flex-wrap gap-2"><button className="btn btn-danger min-h-10 text-sm" disabled={Boolean(busy)} id={`cloud-confirm-delete-${asset.id}`} onClick={() => void remove(asset)}>Delete photo</button><button className={quiet} disabled={Boolean(busy)} onClick={() => { setDeleting(null); focusControl(`cloud-delete-${asset.id}`); }}>Cancel</button></div></div>}
        </li>)}</ul> : <div className="mt-4 flex min-h-40 flex-col items-center justify-center rounded-2xl bg-muted/50 px-6 py-8 text-center"><p className="font-display text-xl">No photos yet</p><p className="mt-2 max-w-xs text-sm text-muted-foreground">Uploaded photos show up here once they&apos;re checked.</p></div>}
      </section>
    </div>
    {(onOpenDesign || (!recovery && designs && view.project.ownerId === client.ownerId)) && <div className="grid gap-5 lg:grid-cols-2 lg:[&>:only-child]:col-span-2">
      {onOpenDesign && <CloudDesignPanel key={projectId} client={client} projectId={projectId} openRepository={openRepository} disabled={Boolean(busy) && busy !== "design"} onBusy={value => { running.current = value; setBusy(value ? "design" : null); if (value) clearPreview(); }} onOpened={onOpenDesign} />}
      {!recovery && designs && view.project.ownerId === client.ownerId && <CloudDesignSavePanel key={`save-${projectId}`} client={client} designs={designs} view={view} openRepository={openRepository} disabled={Boolean(busy) && busy !== "design-save"} onBusy={value => { running.current = value; setBusy(value ? "design-save" : null); if (value) clearPreview(); }} />}
    </div>}
    <CloudMembers client={client} view={view} disabled={Boolean(busy)} runAction={run} onUpdated={next => { clearPreview(); setView(next); }} />
    {view.project.ownerId === client.ownerId && <section className="panel p-4 sm:p-6" aria-label="Project removal">
      {deleteProject ? <div className="notice"><h3 className="font-bold text-destructive">Delete this cloud project?</h3><p className="mt-1">This deletes the project and its photos for everyone. You can&apos;t undo this. Existing links may work for five minutes; downloaded copies and device projects remain.</p><div className="mt-3 flex flex-wrap gap-2"><button className="btn btn-danger min-h-10 text-sm" disabled={Boolean(busy)} id="cloud-confirm-project-delete" onClick={() => void run("delete-project", async signal => { clearPreview(); await client.delete(projectId, undefined, signal); client.assertActive(signal); onBack(); })}>Delete cloud project</button><button className={quiet} disabled={Boolean(busy)} onClick={() => { setDeleteProject(false); focusControl("cloud-delete-project"); }}>Cancel</button></div></div> : <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-3"><span className="glyph bg-[#64748b]"><Trash2 size={18} strokeWidth={2.25} aria-hidden /></span><p className="font-display text-xl leading-tight">Delete project</p></div><button className="btn btn-danger min-h-10 text-sm" disabled={Boolean(busy)} id="cloud-delete-project" onClick={() => { setDeleteProject(true); focusControl("cloud-confirm-project-delete"); }}>Delete project…</button></div>}
    </section>}
  </section>;
}
