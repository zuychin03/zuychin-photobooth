"use client";
import { useAppNavigationGuard } from "@/components/AppNavigation";
import type { ChallengeDraftJournal } from "@/lib/memories/challenge-drafts";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { ArrowDownToLine, Eye, LoaderCircle, RefreshCw, Upload, X } from "lucide-react";
import { Dropdown } from "@/components/Dropdown";
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
const stage = { prepared: "Ready to upload", reserved: "Space reserved", uploading: "Upload confirmation pending", uploaded: "Uploaded, awaiting verification", finalising: "Verification pending", ready: "Verified and ready", failed: "Upload could not finish" };

export function CloudProjectDetail({ client, uploads, designs, challenges, drafts, initialView, onBack, onOpenDesign, openRepository }: Props) {
  const [view, setView] = useState(initialView), [records, setRecords] = useState<CloudUploadRecord[]>([]);
  const [kind, setKind] = useState<"photo" | "decoration">("photo");
  const [busy, setBusy] = useState<string | null>(null), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ id: string; url: string; width: number; height: number } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null), [dismissing, setDismissing] = useState<string | null>(null);
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);
  const [deleteProject, setDeleteProject] = useState(false);
  const [showChallenges, setShowChallenges] = useState(false);
  const [focusTarget, focusControl] = useState<string | null>(null);
  const files = useRef(new Map<string, File>()), controller = useRef<AbortController | null>(null), mounted = useRef(false);
  const picker = useRef<HTMLInputElement>(null), resumeId = useRef<string | null>(null), running = useRef(false);
  const previewUrl = useRef<string | null>(null), projectId = view.project.id;
  const heading = useRef<HTMLHeadingElement>(null);
  useAppNavigationGuard(() => {
    if (!busy && !running.current) return true;
    setNotice("Wait for the current project action to finish before leaving."); return false;
  }, !showChallenges);
  const joinedCount = view.members.filter(member => member.status === "accepted").length;

  useEffect(() => { if (focusTarget && !busy) document.getElementById(focusTarget)?.focus(); }, [focusTarget, busy]);

  useEffect(() => {
    mounted.current = true;
    heading.current?.focus();
    void uploads.list().then(next => { if (mounted.current) setRecords(next.filter(item => item.projectId === initialView.project.id)); }).catch(() => { if (mounted.current) setError("Upload recovery could not be opened. Keep your original files and refresh."); });
    const selectedFiles = files.current;
    return () => { mounted.current = false; controller.current?.abort(); selectedFiles.clear(); if (previewUrl.current) URL.revokeObjectURL(previewUrl.current); };
  }, [uploads, initialView.project.id]);

  const clearPreview = () => { if (previewUrl.current) URL.revokeObjectURL(previewUrl.current); previewUrl.current = null; setPreview(null); };
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
        setError(code === "file_required" ? "Choose the same original file to continue this upload." : code === "file_mismatch" ? "That is a different file. Choose the original used for this upload." : name === "prepare" ? "This file could not be prepared. Choose a supported still image within the size limits, and allow browser storage for upload recovery." : cloudError(failure));
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
      setNotice("File selected. Choose Resume upload to check that it matches and continue.");
      await updateRecords();
    } else {
      const record = await uploads.prepare(projectId, file, { kind }, signal);
      if (!signal.aborted) { files.current.set(record.id, file); setSelectedFileId(record.id); focusControl(`cloud-upload-${record.id}`); setNotice("The file is checked locally. Choose Upload original below to send it to this project."); }
      await updateRecords();
    }
  });
  const upload = (record: CloudUploadRecord, withFile: boolean) => run(record.id, async signal => {
    const result = await uploads.run(record.id, withFile ? files.current.get(record.id) : undefined, signal);
    if (!signal.aborted) {
      if (result.state === "ready") { files.current.delete(record.id); setSelectedFileId(null); setNotice("The original is verified and ready."); }
      else setNotice(result.state === "failed" ? "The original could not be verified. Keep the file on your device." : "Confirmation is still pending. Check its status again shortly; do not start a duplicate upload.");
    }
    await refresh(signal);
    if (!signal.aborted && result.state === "ready") heading.current?.focus();
  });
  const show = (asset: CloudProjectAsset, download: boolean) => run(asset.id, async signal => {
    clearPreview();
    const blob = await client.download({ ...asset, projectId }, signal);
    client.assertActive(signal);
    if (download) { downloadProjectBlob(blob, `original-${asset.id}.${asset.mime === "image/jpeg" ? "jpg" : asset.mime.split("/")[1]}`); setNotice("Original prepared for download. Check your browser's downloads."); }
    else { const url = URL.createObjectURL(blob); previewUrl.current = url; setPreview({ id: asset.id, url, width: asset.width, height: asset.height }); }
  });
  const remove = (asset: CloudProjectAsset) => run(asset.id, async signal => {
    clearPreview();
    await client.delete(projectId, asset.id, signal);
    if (!signal.aborted) { setDeleting(null); setNotice("New access to this original is blocked. Existing links may work for up to five minutes, and downloaded copies remain. Space is released after storage cleanup is confirmed."); }
    await refresh(signal);
    if (!signal.aborted) heading.current?.focus();
  });
  const pending = records.filter(record => record.state !== "ready");

  if (showChallenges && challenges) return <ChallengeWorkspace drafts={drafts} project={view} client={client} challenges={challenges} uploads={uploads} onBack={() => { setShowChallenges(false); void run("refresh", refresh); focusControl("cloud-project-heading"); }} />;

  return <section className="mt-7" aria-labelledby="cloud-project-heading">
    <CloudBack disabled={Boolean(busy)} onBack={onBack} />
    <header className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-6"><div className="min-w-0"><h2 ref={heading} tabIndex={-1} id="cloud-project-heading" className="break-words font-display text-3xl font-semibold outline-none">{view.project.title}</h2><p className="mt-2 text-sm text-foreground/70">{view.project.kind === "personal" ? "Only you" : `${joinedCount} ${joinedCount === 1 ? "person" : "people"} in this project`} · {cloudSize(view.project.maxBytes)} project allowance</p></div><button className={cloudControl} disabled={Boolean(busy)} onClick={() => void run("refresh", refresh)}><RefreshCw size={16} aria-hidden /> Refresh</button></header>
    {error && <p role="alert" className="mt-4 rounded-xl bg-muted p-4 text-sm leading-relaxed">{error}</p>}
    {notice && <p role="status" className="mt-4 max-w-2xl rounded-xl bg-muted p-4 text-sm leading-relaxed">{notice}</p>}
    {busy && busy !== "design" && busy !== "design-save" && <div className="mt-4 flex flex-wrap items-center gap-3"><p role="status" className="flex items-center gap-2 text-sm"><LoaderCircle size={16} aria-hidden className="animate-spin motion-reduce:animate-none" /> {busy === "prepare" ? "Checking this file…" : "Waiting for cloud confirmation…"}</p><button className={`${cloudControl} border border-border`} onClick={() => { controller.current?.abort(); clearPreview(); setNotice("Stopped waiting. An upload may still have reached the server. Check its status before sending it again."); }}>Stop waiting</button></div>}
    {challenges && view.project.kind === "friend" && <section className="flex flex-wrap items-center justify-between gap-4 border-b border-border py-6"><div><h3 className="font-display text-2xl">Photo challenges</h3><p className="mt-2 max-w-lg text-sm text-foreground/70">Add photos in your own time, then reveal them together.</p></div><button className={`${cloudControl} border border-border`} disabled={Boolean(busy)} onClick={() => { clearPreview(); setShowChallenges(true); }}>Photo challenges</button></section>}
    {onOpenDesign && <CloudDesignPanel key={projectId} client={client} projectId={projectId} openRepository={openRepository} disabled={Boolean(busy) && busy !== "design"} onBusy={value => { running.current = value; setBusy(value ? "design" : null); if (value) clearPreview(); }} onOpened={onOpenDesign} />}
    {designs && view.project.ownerId === client.ownerId && <CloudDesignSavePanel key={`save-${projectId}`} client={client} designs={designs} view={view} openRepository={openRepository} disabled={Boolean(busy) && busy !== "design-save"} onBusy={value => { running.current = value; setBusy(value ? "design-save" : null); if (value) clearPreview(); }} />}
    <div className="grid gap-9 py-7 lg:grid-cols-[minmax(0,1fr)_18rem]">
      <section aria-labelledby="originals-heading" className="min-w-0"><h3 id="originals-heading" className="text-lg font-semibold">Available originals</h3><p className="mt-2 text-sm leading-relaxed text-foreground/70">Verified originals you can access.</p>
        {view.assets.length ? <ul className="mt-5" aria-label="Available cloud originals">{view.assets.map((asset, index) => <li key={asset.id} className="border-t border-border py-4">
          <div className="flex flex-wrap items-center justify-between gap-3"><div><h4 className="font-medium">{asset.kind === "decoration" ? "PNG decoration" : "Photo"} {index + 1}</h4><p className="mt-1 text-sm text-foreground/70">{asset.width} × {asset.height} · {cloudSize(asset.bytes)} · {asset.ownerId === client.ownerId ? "Your original" : "Shared original"}</p></div><div className="flex flex-wrap gap-1"><button className={cloudControl} disabled={Boolean(busy)} aria-label={`Preview ${asset.kind === "decoration" ? "decoration" : "photo"} ${index + 1}`} onClick={() => void show(asset, false)}><Eye size={16} aria-hidden /> Preview</button><button className={cloudControl} disabled={Boolean(busy)} aria-label={`Download original ${index + 1}`} onClick={() => void show(asset, true)}><ArrowDownToLine size={16} aria-hidden /> Download</button></div></div>
          {preview?.id === asset.id && <figure className="mt-3"><div className="relative flex justify-center rounded-xl bg-muted p-4"><Image unoptimized src={preview.url} width={preview.width} height={preview.height} alt={`Original ${index + 1}`} className="max-h-96 max-w-full object-contain" /><button className={`${cloudControl} absolute top-2 right-2 bg-card`} aria-label="Close original preview" onClick={clearPreview}><X size={17} aria-hidden /></button></div><figcaption className="mt-2 text-sm text-foreground/70">This preview is cleared when you refresh or leave the project.</figcaption></figure>}
          {asset.ownerId === client.ownerId && <div className="mt-2">{deleting === asset.id ? <div className="rounded-xl bg-muted p-4"><p className="text-sm leading-relaxed">Delete this cloud original? This blocks new access for everyone and cannot be undone here. Existing links may work for up to five minutes; downloaded copies remain. Keep your own copy first.</p><div className="mt-3 flex flex-wrap gap-2"><button className={`${cloudControl} border border-border`} disabled={Boolean(busy)} id={`cloud-confirm-delete-${asset.id}`} onClick={() => void remove(asset)}>Delete cloud original</button><button className={cloudControl} disabled={Boolean(busy)} onClick={() => { setDeleting(null); focusControl(`cloud-delete-${asset.id}`); }}>Keep original</button></div></div> : <button className={`${cloudControl} -ml-4 text-foreground/70 underline underline-offset-4`} disabled={Boolean(busy)} id={`cloud-delete-${asset.id}`} onClick={() => { setDeleting(asset.id); focusControl(`cloud-confirm-delete-${asset.id}`); }}>Delete original</button>}</div>}
        </li>)}</ul> : <div className="py-10"><p className="font-display text-2xl">Your originals will appear here.</p><p className="mt-3 max-w-md text-sm leading-relaxed text-foreground/70">Choose a photo to upload. It becomes available after the server verifies the file.</p></div>}
      </section>
      <aside className="border-t border-border pt-6 lg:border-t-0 lg:pt-0" aria-labelledby="upload-heading"><h3 id="upload-heading" className="text-lg font-semibold">Add an original</h3><p className="mt-2 text-sm leading-relaxed text-foreground/70">JPEG, PNG or WebP. Up to 10 MiB and 4096 pixels per side.</p><div className="mt-4"><Dropdown label="Original type" showLabel value={kind} onChange={value => setKind(value as typeof kind)} disabled={Boolean(busy)} options={[{ value: "photo", label: "Photo" }, { value: "decoration", label: "PNG decoration" }]} /></div>{kind === "decoration" && <p className="mt-2 text-sm text-foreground/70">Decorations use PNG, up to 4 MiB and 2048 pixels per side.</p>}<button className={`${cloudControl} mt-4 w-full bg-accent text-accent-foreground`} disabled={Boolean(busy)} onClick={() => { resumeId.current = null; if (picker.current) { picker.current.accept = kind === "decoration" ? "image/png" : "image/jpeg,image/png,image/webp"; picker.current.click(); } }}><Upload size={17} aria-hidden /> Choose {kind === "photo" ? "photo" : "decoration"}</button><input ref={picker} type="file" tabIndex={-1} className="sr-only" aria-label="Choose cloud original" accept={kind === "decoration" ? "image/png" : "image/jpeg,image/png,image/webp"} onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void choose(file); }} /><p className="mt-3 text-sm leading-relaxed text-foreground/70">Pending verification can temporarily reserve extra upload space.</p></aside>
    </div>
    {pending.length > 0 && <section className="border-t border-border pt-6" aria-labelledby="pending-heading">
      <h3 id="pending-heading" className="text-lg font-semibold">Upload recovery</h3>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-foreground/70">Saved locally for this account. Reloading never resends files. Choose the same original to resume.</p>
      <ul className="mt-4">{pending.map((record, index) => <li key={record.id} className="border-t border-border py-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div><p className="font-medium">{record.asset.kind === "decoration" ? "Decoration" : "Photo"} upload {index + 1}</p><p className="mt-1 text-sm text-foreground/70">{busy === record.id ? "Awaiting confirmation" : stage[record.state]} · {cloudSize(record.asset.bytes)} · {record.asset.width} × {record.asset.height}</p></div>
          <div className="flex flex-wrap gap-2">
            {record.state !== "failed" && <>
              {selectedFileId === record.id && <button id={`cloud-upload-${record.id}`} className={`${cloudControl} bg-accent text-accent-foreground`} disabled={Boolean(busy)} onClick={() => void upload(record, true)}><Upload size={16} aria-hidden /> {record.state === "prepared" ? "Upload original" : "Resume upload"}</button>}
              {record.state !== "prepared" && <button className={`${cloudControl} border border-border`} disabled={Boolean(busy)} onClick={() => void upload(record, false)}>Check status</button>}
              {selectedFileId !== record.id && <button className={cloudControl} disabled={Boolean(busy)} onClick={() => { resumeId.current = record.id; if (picker.current) { picker.current.accept = record.asset.mime; picker.current.click(); } }}>Choose same file</button>}
            </>}
            {["prepared", "failed"].includes(record.state) && <button id={`cloud-dismiss-${record.id}`} className={`${cloudControl} underline underline-offset-4`} disabled={Boolean(busy)} onClick={() => { setDismissing(record.id); focusControl(`cloud-confirm-dismiss-${record.id}`); }}>Dismiss tracking</button>}
          </div>
        </div>
        {record.state === "failed" && <p className="mt-2 text-sm text-foreground/70">Keep the original file. Cleanup may still be pending.</p>}
        {dismissing === record.id && <div className="mt-3 rounded-xl bg-muted p-4"><p className="text-sm leading-relaxed">Remove this recovery record from this browser? This does not delete a cloud original or release reserved space. Refresh the project first if the upload result is uncertain.</p><div className="mt-3 flex flex-wrap gap-2"><button id={`cloud-confirm-dismiss-${record.id}`} className={`${cloudControl} border border-border`} disabled={Boolean(busy)} onClick={() => void run("dismiss", async () => { await uploads.forget(record.id); files.current.delete(record.id); setSelectedFileId(null); setDismissing(null); await updateRecords(); setNotice("Recovery tracking dismissed. Your local file and any cloud original are unchanged."); focusControl("cloud-project-heading"); })}>Dismiss recovery record</button><button className={cloudControl} disabled={Boolean(busy)} onClick={() => { setDismissing(null); focusControl(`cloud-dismiss-${record.id}`); }}>Keep tracking</button></div></div>}
      </li>)}</ul>
    </section>}
    <CloudMembers client={client} view={view} disabled={Boolean(busy)} runAction={run} onUpdated={next => { clearPreview(); setView(next); }} />
    {view.project.ownerId === client.ownerId && <section className="mt-8 border-t border-border pt-6" aria-label="Project removal">
      {deleteProject ? <div className="max-w-2xl rounded-xl bg-muted p-4"><h3 className="font-medium">Delete this cloud project?</h3><p className="mt-2 text-sm leading-relaxed">This removes the project and blocks new access to its originals for everyone. You cannot undo it here. Existing links may work for up to five minutes, and downloaded copies remain. Your device projects are separate.</p><div className="mt-4 flex flex-wrap gap-2"><button className={`${cloudControl} border border-border`} disabled={Boolean(busy)} id="cloud-confirm-project-delete" onClick={() => void run("delete-project", async signal => { clearPreview(); await client.delete(projectId, undefined, signal); client.assertActive(signal); onBack(); })}>Delete cloud project</button><button className={cloudControl} disabled={Boolean(busy)} onClick={() => { setDeleteProject(false); focusControl("cloud-delete-project"); }}>Keep project</button></div></div> : <button className={`${cloudControl} -ml-4 underline underline-offset-4`} disabled={Boolean(busy)} id="cloud-delete-project" onClick={() => { setDeleteProject(true); focusControl("cloud-confirm-project-delete"); }}>Delete project…</button>}
    </section>}
  </section>;
}
