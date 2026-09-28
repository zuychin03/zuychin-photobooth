"use client";
import { useRecoveryRelease } from "@/components/ReleaseMode";
import { useAppNavigationGuard } from "@/components/AppNavigation";
import type { ChallengeDraftJournal } from "@/lib/memories/challenge-drafts";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { ArrowDownToLine, Eye, LoaderCircle, RefreshCw, Upload, X } from "lucide-react";
import { Dropdown } from "@/components/Dropdown";
import { MobileControlPanel } from "@/components/MobileControlPanel";
import type { CloudProjectAsset, CloudProjectView } from "@/lib/projects/cloud-contract";
import type { CloudProjectClient } from "@/lib/projects/cloud-client";
import type { CloudUploadManager, CloudUploadRecord } from "@/lib/projects/cloud-upload";
import { downloadProjectBlob } from "@/lib/projects/download";
import { CloudBack, cloudControl, cloudError, cloudSize } from "./CloudControls";
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

  return <section className="mt-7" aria-labelledby="cloud-project-heading">
    <CloudBack disabled={Boolean(busy)} onBack={onBack} />
    <header className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-6"><div className="min-w-0"><h2 ref={heading} tabIndex={-1} id="cloud-project-heading" className="break-words font-display text-3xl font-semibold outline-none">{view.project.title}</h2><p className="mt-2 text-sm text-foreground/70">{view.project.kind === "personal" ? "Only you" : `${joinedCount} ${joinedCount === 1 ? "person" : "people"} in this project`} · {cloudSize(view.project.maxBytes)} of storage</p></div><button className={cloudControl} disabled={Boolean(busy)} onClick={() => void run("refresh", refresh)}><RefreshCw size={16} aria-hidden /> Refresh</button></header>
    {error && <p role="alert" className="mt-4 rounded-xl bg-muted p-4 text-sm leading-relaxed">{error}</p>}
    {notice && <p role="status" className="mt-4 max-w-2xl rounded-xl bg-muted p-4 text-sm leading-relaxed">{notice}</p>}
    {busy && busy !== "design" && busy !== "design-save" && <div className="mt-4 flex flex-wrap items-center gap-3"><p role="status" className="flex items-center gap-2 text-sm"><LoaderCircle size={16} aria-hidden className="animate-spin motion-reduce:animate-none" /> {busy === "prepare" ? "Checking this file…" : "Waiting for confirmation…"}</p><button className={`${cloudControl} border border-border`} onClick={stopWaiting}>Stop waiting</button></div>}
    {!recovery && challenges && view.project.kind === "friend" && <section className="flex flex-wrap items-center justify-between gap-4 border-b border-border py-6"><div><h3 className="font-display text-2xl">Photo challenges</h3><p className="mt-2 max-w-lg text-sm text-foreground/70">Add photos in your own time, then reveal them together.</p></div><button className={`${cloudControl} border border-border`} disabled={Boolean(busy)} onClick={() => { clearPreview(); setShowChallenges(true); }}>Open challenges</button></section>}
    {onOpenDesign && <CloudDesignPanel key={projectId} client={client} projectId={projectId} openRepository={openRepository} disabled={Boolean(busy) && busy !== "design"} onBusy={value => { running.current = value; setBusy(value ? "design" : null); if (value) clearPreview(); }} onOpened={onOpenDesign} />}
    {!recovery && designs && view.project.ownerId === client.ownerId && <CloudDesignSavePanel key={`save-${projectId}`} client={client} designs={designs} view={view} openRepository={openRepository} disabled={Boolean(busy) && busy !== "design-save"} onBusy={value => { running.current = value; setBusy(value ? "design-save" : null); if (value) clearPreview(); }} />}
    <div className="grid gap-9 py-7 lg:grid-cols-[minmax(0,1fr)_18rem]">
      <aside className="min-w-0 lg:col-start-2 lg:row-start-1" aria-label="Upload tools">
        <MobileControlPanel open={uploadPanelOpen} onOpenChange={setUploadPanelOpen} label={pending.length ? "Add photos & unfinished uploads" : "Add photos"} title="Upload photos">
          {uploadPanelOpen && <>
            {error && <p role="alert" className="rounded-xl bg-muted p-3 text-sm">{error}</p>}
            {notice && <p role="status" className="text-sm">{notice}</p>}
            {busy && <div className="space-y-2"><p role="status" className="flex items-center gap-2 text-sm"><LoaderCircle size={16} aria-hidden className="animate-spin motion-reduce:animate-none" /> {busy === "prepare" ? "Checking this file…" : "Waiting for confirmation…"}</p><button className={`${cloudControl} border border-border`} onClick={stopWaiting}>Stop waiting</button></div>}
          </>}
          <section aria-labelledby="upload-heading"><h3 id="upload-heading" className="text-lg font-semibold">Add a photo</h3><p className="mt-2 text-sm leading-relaxed text-foreground/70">JPEG, PNG or WebP, up to 10 MiB and 4096 pixels per side.</p><div className="mt-4"><Dropdown label="Type" showLabel value={kind} onChange={value => setKind(value as typeof kind)} disabled={Boolean(busy)} options={[{ value: "photo", label: "Photo" }, { value: "decoration", label: "PNG decoration" }]} /></div>{kind === "decoration" && <p className="mt-2 text-sm text-foreground/70">Decorations use PNG, up to 4 MiB and 2048 pixels per side.</p>}<button className={`${cloudControl} mt-4 w-full bg-accent text-accent-foreground`} disabled={recovery || Boolean(busy)} onClick={() => { resumeId.current = null; if (picker.current) { picker.current.accept = kind === "decoration" ? "image/png" : "image/jpeg,image/png,image/webp"; picker.current.click(); } }}><Upload size={17} aria-hidden /> Choose {kind === "photo" ? "photo" : "decoration"}</button><input ref={picker} type="file" tabIndex={-1} className="sr-only" aria-label="Choose a file to upload" accept={kind === "decoration" ? "image/png" : "image/jpeg,image/png,image/webp"} onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void choose(file); }} /></section>
    {pending.length > 0 && <section className="border-t border-border pt-6" aria-labelledby="pending-heading">
      <h3 id="pending-heading" className="text-lg font-semibold">Unfinished uploads</h3>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-foreground/70">To resume, choose the same file again.</p>
      <ul className="mt-4">{pending.map((record, index) => <li key={record.id} className="border-t border-border py-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div><p className="font-medium">{record.asset.kind === "decoration" ? "Decoration" : "Photo"} upload {index + 1}</p><p className="mt-1 text-sm text-foreground/70">{busy === record.id ? "Waiting for confirmation" : stage[record.state]} · {cloudSize(record.asset.bytes)} · {record.asset.width} × {record.asset.height}</p></div>
          <div className="flex flex-wrap gap-2">
            {record.state !== "failed" && <>
              {selectedFileId === record.id && <button id={`cloud-upload-${record.id}`} className={`${cloudControl} bg-accent text-accent-foreground`} disabled={recovery || Boolean(busy)} onClick={() => void upload(record, true)}><Upload size={16} aria-hidden /> {record.state === "prepared" ? "Upload" : "Resume upload"}</button>}
              {record.state !== "prepared" && <button className={`${cloudControl} border border-border`} disabled={Boolean(busy)} onClick={() => void upload(record, false)}>Check status</button>}
              {selectedFileId !== record.id && <button className={cloudControl} disabled={recovery || Boolean(busy)} onClick={() => { resumeId.current = record.id; if (picker.current) { picker.current.accept = record.asset.mime; picker.current.click(); } }}>Choose same file</button>}
            </>}
            {["prepared", "failed"].includes(record.state) && <button id={`cloud-dismiss-${record.id}`} className={`${cloudControl} underline underline-offset-4`} disabled={Boolean(busy)} onClick={() => { setDismissing(record.id); focusControl(`cloud-confirm-dismiss-${record.id}`); }}>Remove from list</button>}
          </div>
        </div>
        {record.state === "failed" && <p className="mt-2 text-sm text-foreground/70">Keep the file on your device.</p>}
        {dismissing === record.id && <div className="mt-3 rounded-xl bg-muted p-4"><p className="text-sm leading-relaxed">Remove this from the list? Nothing is deleted from the cloud. Refresh first if you&apos;re not sure the upload finished.</p><div className="mt-3 flex flex-wrap gap-2"><button id={`cloud-confirm-dismiss-${record.id}`} className={`${cloudControl} border border-border`} disabled={Boolean(busy)} onClick={() => void run("dismiss", async () => { await uploads.forget(record.id); files.current.delete(record.id); setSelectedFileId(null); setDismissing(null); await updateRecords(); setNotice("Removed from the list."); setUploadPanelOpen(false); focusControl("cloud-project-heading"); })}>Remove</button><button className={cloudControl} disabled={Boolean(busy)} onClick={() => { setDismissing(null); focusControl(`cloud-dismiss-${record.id}`); }}>Cancel</button></div></div>}
      </li>)}</ul>
    </section>}
        </MobileControlPanel>
      </aside>
      <section aria-labelledby="originals-heading" className="min-w-0 lg:col-start-1 lg:row-start-1"><h3 id="originals-heading" className="text-lg font-semibold">Photos</h3>
        {view.assets.length ? <ul className="mt-5" aria-label="Project photos">{view.assets.map((asset, index) => <li key={asset.id} className="border-t border-border py-4">
          <div className="flex flex-wrap items-center justify-between gap-3"><div><h4 className="font-medium">{asset.kind === "decoration" ? "PNG decoration" : "Photo"} {index + 1}</h4><p className="mt-1 text-sm text-foreground/70">{asset.width} × {asset.height} · {cloudSize(asset.bytes)} · {asset.ownerId === client.ownerId ? "Yours" : "Shared"}</p></div><div className="flex flex-wrap gap-1"><button className={cloudControl} disabled={Boolean(busy)} aria-label={`Preview ${asset.kind === "decoration" ? "decoration" : "photo"} ${index + 1}`} onClick={() => void show(asset, false)}><Eye size={16} aria-hidden /> Preview</button><button className={cloudControl} disabled={Boolean(busy)} aria-label={`Download photo ${index + 1}`} onClick={() => void show(asset, true)}><ArrowDownToLine size={16} aria-hidden /> Download</button></div></div>
          {preview?.id === asset.id && <figure className="mt-3"><div className="relative flex justify-center rounded-xl bg-muted p-4"><Image unoptimized src={preview.url} width={preview.width} height={preview.height} alt={`Photo ${index + 1}`} className="max-h-96 max-w-full object-contain" /><button className={`${cloudControl} absolute top-2 right-2 bg-card`} aria-label="Close preview" onClick={clearPreview}><X size={17} aria-hidden /></button></div></figure>}
          {asset.ownerId === client.ownerId && <div className="mt-2">{deleting === asset.id ? <div className="rounded-xl bg-muted p-4"><p className="text-sm leading-relaxed">Delete this photo for everyone? You can&apos;t undo this, so download a copy first if you need one. Existing links may work for five minutes; downloaded copies remain.</p><div className="mt-3 flex flex-wrap gap-2"><button className={`${cloudControl} border border-border`} disabled={Boolean(busy)} id={`cloud-confirm-delete-${asset.id}`} onClick={() => void remove(asset)}>Delete photo</button><button className={cloudControl} disabled={Boolean(busy)} onClick={() => { setDeleting(null); focusControl(`cloud-delete-${asset.id}`); }}>Cancel</button></div></div> : <button className={`${cloudControl} -ml-4 text-foreground/70 underline underline-offset-4`} disabled={Boolean(busy)} id={`cloud-delete-${asset.id}`} onClick={() => { setDeleting(asset.id); focusControl(`cloud-confirm-delete-${asset.id}`); }}>Delete photo</button>}</div>}
        </li>)}</ul> : <div className="py-10"><p className="font-display text-2xl">No photos yet.</p><p className="mt-3 max-w-md text-sm leading-relaxed text-foreground/70">Uploaded photos show up here once they&apos;re checked.</p></div>}
      </section>

    </div>
    <CloudMembers client={client} view={view} disabled={Boolean(busy)} runAction={run} onUpdated={next => { clearPreview(); setView(next); }} />
    {view.project.ownerId === client.ownerId && <section className="mt-8 border-t border-border pt-6" aria-label="Project removal">
      {deleteProject ? <div className="max-w-2xl rounded-xl bg-muted p-4"><h3 className="font-medium">Delete this cloud project?</h3><p className="mt-2 text-sm leading-relaxed">This deletes the project and its photos for everyone. You can&apos;t undo this. Existing links may work for five minutes; downloaded copies and device projects remain.</p><div className="mt-4 flex flex-wrap gap-2"><button className={`${cloudControl} border border-border`} disabled={Boolean(busy)} id="cloud-confirm-project-delete" onClick={() => void run("delete-project", async signal => { clearPreview(); await client.delete(projectId, undefined, signal); client.assertActive(signal); onBack(); })}>Delete cloud project</button><button className={cloudControl} disabled={Boolean(busy)} onClick={() => { setDeleteProject(false); focusControl("cloud-delete-project"); }}>Cancel</button></div></div> : <button className={`${cloudControl} -ml-4 underline underline-offset-4`} disabled={Boolean(busy)} id="cloud-delete-project" onClick={() => { setDeleteProject(true); focusControl("cloud-confirm-project-delete"); }}>Delete project…</button>}
    </section>}
  </section>;
}
