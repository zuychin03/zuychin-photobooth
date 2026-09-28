"use client";
import { useAppNavigationGuard } from "@/components/AppNavigation";
import type { ChallengeDraftJournal } from "@/lib/memories/challenge-drafts";

import Image from "next/image";
import { EventPostcardComposer } from "@/components/events/EventPostcardComposer";
import { createClient } from "@/lib/supabase/client";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowDownToLine, LoaderCircle, RefreshCw, Upload, X } from "lucide-react";
import { Dropdown } from "@/components/Dropdown";
import type { CloudProjectAsset, CloudProjectView } from "@/lib/projects/cloud-contract";
import type { CloudProjectClient } from "@/lib/projects/cloud-client";
import type { CloudUploadManager, CloudUploadRecord } from "@/lib/projects/cloud-upload";
import type { ChallengeClient } from "@/lib/memories/challenge-client";
import type { ChallengeSubmission, ChallengeView } from "@/lib/memories/challenge-contract";
import { challengeError, challengeOwnedUploads, challengeSubmission } from "@/lib/memories/challenge-ui";
import { renderChallengePng } from "@/lib/memories/challenge-render";
import { downloadProjectBlob } from "@/lib/projects/download";
import { cloudControl, cloudSize } from "./CloudControls";
import { ChallengePartials } from "./ChallengePartials";
import { ChallengeCamera } from "./ChallengeCamera";
import { ChallengeStoryPose, ChallengeStoryReview } from "./ChallengeStory";
import { createChallengeCameraOriginals } from "@/lib/memories/challenge-camera-originals";

const stages = { prepared: "Ready to upload", reserved: "Space reserved", uploading: "Uploading", uploaded: "Checking", finalising: "Checking", ready: "Ready", failed: "Didn't finish" };
type Action = "accept" | "decline" | "open" | "cancel" | "withdraw";
interface Props { initialView: ChallengeView; project: CloudProjectView; client: CloudProjectClient; challenges: ChallengeClient; uploads: CloudUploadManager; drafts?: ChallengeDraftJournal; onBack(): void }
interface PhotoChoice { id: string; state: CloudUploadRecord["state"]; asset: Pick<CloudProjectAsset, "width" | "height" | "bytes"> }

export function ChallengeDetail({ initialView, project, client, challenges, uploads, drafts, onBack }: Props) {
  const [postcardBusy, setPostcardBusy] = useState(false), [partialPostcardBusy, setPartialPostcardBusy] = useState(false);
  const preparedCameraFiles = useRef(new WeakMap<File, CloudUploadRecord>());
  const originalsRef = useRef<ReturnType<typeof createChallengeCameraOriginals> | null>(null);
  const [savedCameraIds, setSavedCameraIds] = useState<string[]>([]);
  const [view, setView] = useState(initialView), [records, setRecords] = useState<CloudUploadRecord[]>([]), [selection, setSelection] = useState<Record<number, string>>({});
  const [cloudPhotos, setCloudPhotos] = useState<CloudProjectAsset[] | null>(null), [cameraSource, setCameraSource] = useState<number | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Action | "submit" | null>(null), [attempt, setAttempt] = useState<ChallengeSubmission | null>(null), [now, setNow] = useState(() => Date.now());
  const [preview, setPreview] = useState<{ url: string; width: number; height: number; result: boolean; partial?: boolean } | null>(null), [fileIds, setFileIds] = useState<string[]>([]), [focus, setFocus] = useState("challenge-heading");
  const controller = useRef<AbortController | null>(null), running = useRef(false), live = useRef(false), files = useRef(new Map<string, File>()), url = useRef<string | null>(null);
  const picker = useRef<HTMLInputElement>(null), pick = useRef<{ sourceIndex: number; recordId?: string } | null>(null);
  const mine = view.members.find(member => member.userId === client.ownerId), assignments = view.assignments.filter(item => item.userId === client.ownerId);
  const expired = now >= Date.parse(view.expiresAt), editable = mine?.status === "accepted" && !mine.submitted && view.status === "open" && !expired && !view.accessLost;
  const cameraOpen = cameraSource !== null && editable && !attempt && !confirm, actionBusy = busy || cameraOpen || postcardBusy || partialPostcardBusy;
  useAppNavigationGuard(() => {
    if (!busy && !running.current && !postcardBusy && !partialPostcardBusy) return true;
    setNotice("Wait for this to finish before you leave."); return false;
  }, !cameraOpen);
  const choices: PhotoChoice[] = [...records.filter(record => record.state !== "ready" && !cloudPhotos?.some(photo => photo.id === record.id)), ...(cloudPhotos ?? []).map(asset => ({ id: asset.id, state: "ready" as const, asset }))];
  choices.sort((a, b) => a.id.localeCompare(b.id));
  const locked = actionBusy || Boolean(attempt) || confirm === "submit" || !cloudPhotos, complete = assignments.length > 0 && assignments.every(item => choices.some(record => record.id === selection[item.sourceIndex] && record.state === "ready")) && new Set(Object.values(selection)).size === assignments.length;
  const fullResult = !view.accessLost && mine?.status === "accepted" && view.members.every(member => member.status === "accepted" && member.submitted) && (view.status === "revealed" || view.policy === "immediate" && view.status === "open" && !expired);
  const assertPostcardSource = (signal?: AbortSignal) => { client.assertActive(signal); challenges.assertActive(signal); if (!live.current || !fullResult) throw { code: "access_lost" }; };
  const sourceAccessToken = async () => {
    client.assertActive(); challenges.assertActive();
    const { data, error } = await createClient().auth.getSession();
    client.assertActive(); challenges.assertActive();
    if (error || data.session?.user.id !== client.ownerId) throw { code: "account_changed" };
    return data.session.access_token;
  };
  const clearPreview = () => { if (url.current) URL.revokeObjectURL(url.current); url.current = null; setPreview(null); };
  const updateRecords = async () => { const next = await uploads.list(); if (live.current) setRecords(next.filter(record => record.projectId === view.projectId && record.asset.protection.kind === "challenge" && record.asset.protection.id === view.id)); };
  useEffect(() => {
    const originals = createChallengeCameraOriginals({ ownerId: client.ownerId, challengeId: initialView.id, assertActive: signal => client.assertActive(signal) }); originalsRef.current = originals;
    live.current = true; const heldFiles = files.current, abort = new AbortController();
    void uploads.list().then(next => { if (live.current) setRecords(next.filter(record => record.projectId === initialView.projectId && record.asset.protection.kind === "challenge" && record.asset.protection.id === initialView.id)); }).catch(failure => { if (live.current) setError(challengeError(failure)); });
    void challengeOwnedUploads(challenges, initialView.id, abort.signal).then(next => { if (!abort.signal.aborted) setCloudPhotos(next); }).catch(failure => { if (!abort.signal.aborted) setError(challengeError(failure)); });
    void originals.list(abort.signal).then(ids => { if (!abort.signal.aborted) setSavedCameraIds(ids); }).catch(() => {});
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => { live.current = false; abort.abort(); void originals.close(); if (originalsRef.current === originals) originalsRef.current = null; clearInterval(timer); controller.current?.abort(); heldFiles.clear(); if (url.current) URL.revokeObjectURL(url.current); };
  }, [uploads, challenges, client, initialView.id, initialView.projectId]);
  useEffect(() => { if (!busy) document.getElementById(focus)?.focus(); }, [focus, busy]);
  const acceptView = (next: Awaited<ReturnType<ChallengeClient["view"]>>) => { if ("unsupported" in next) throw new Error("Unsupported challenge"); if (live.current) setView(next); };
  const refresh = async (signal: AbortSignal) => { clearPreview(); acceptView(await challenges.view(view.id, signal)); setCloudPhotos(await challengeOwnedUploads(challenges, view.id, signal)); await updateRecords(); };
  const run = async (work: (signal: AbortSignal) => Promise<void>) => {
    if (running.current) return; running.current = true; const abort = new AbortController(); controller.current = abort; setBusy(true); setError(null); setNotice(null);
    try { await work(abort.signal); } catch (failure) { if (live.current && !abort.signal.aborted) setError(challengeError(failure)); }
    finally { running.current = false; if (live.current) { await updateRecords().catch(() => {}); setBusy(false); } }
  };
  const manage = (action: Action) => run(async signal => { clearPreview(); acceptView(await challenges.manage(view.id, action, signal)); setConfirm(null); setFocus("challenge-heading"); });
  const selectUpload = (sourceIndex: number, id: string) => {
    const next = { ...selection }; if (id) next[sourceIndex] = id; else delete next[sourceIndex];
    const selected = new Set(Object.values(next)); for (const key of files.current.keys()) if (!selected.has(key)) files.current.delete(key);
    setFileIds([...files.current.keys()]); setSelection(next); clearPreview();
  };
  const choose = (file: File) => run(async signal => {
    const target = pick.current; pick.current = null; if (!target || !editable || attempt) return;
    const record = target.recordId ? records.find(item => item.id === target.recordId) : await uploads.prepare(view.projectId, file, { kind: "photo", protection: { kind: "challenge", id: view.id } }, signal);
    if (!record) return; client.assertActive(signal); files.current.set(record.id, file); selectUpload(target.sourceIndex, record.id); setNotice("File selected. Choose Upload photo to send it."); setFocus(`challenge-upload-${target.sourceIndex}`);
  });
  const selectCameraPhoto = async (file: File, sourceIndex: number, captureSignal: AbortSignal): Promise<boolean> => {
    let accepted = false;
    await run(async signal => {
      const active = AbortSignal.any([signal, captureSignal]);
      client.assertActive(active);
      if (!editable || attempt || confirm || !assignments.some(item => item.sourceIndex === sourceIndex)) throw { code: "not_ready" };
      let record = preparedCameraFiles.current.get(file);
      if (!record) { record = await uploads.prepare(view.projectId, file, { kind: "photo", protection: { kind: "challenge", id: view.id } }, active); preparedCameraFiles.current.set(file, record); }
      const originals = originalsRef.current; if (!originals) throw { code: "cancelled" };
      await originals.save(record, file, sourceIndex, active);
      setSavedCameraIds(await originals.list(active));
      client.assertActive(active); if (!live.current) throw { code: "cancelled" };
      files.current.set(record.id, file); selectUpload(sourceIndex, record.id); accepted = true;
      setNotice("Photo saved and selected. Choose Upload photo to send it.");
    });
    return accepted;
  };
  const recoverCamera = (record: CloudUploadRecord, sourceIndex: number) => run(async signal => {
    const originals = originalsRef.current; if (!originals) throw { code: "cancelled" };
    const file = await originals.load(record, signal); client.assertActive(signal); files.current.set(record.id, file); selectUpload(sourceIndex, record.id);
    setNotice("Photo recovered. Choose Upload photo to continue.");
  });
  const upload = (record: CloudUploadRecord, withFile: boolean) => run(async signal => {
    const result = await uploads.run(record.id, withFile ? files.current.get(record.id) : undefined, signal);
    if (result.state === "ready") { files.current.delete(record.id); setFileIds([...files.current.keys()]); setCloudPhotos(await challengeOwnedUploads(challenges, view.id, signal)); setNotice("Photo uploaded. Check your photos, then submit."); }
    else setNotice(result.state === "pending" ? "Still waiting for confirmation. Check its status before uploading again." : "This upload didn't finish. Keep the file on your device.");
    setFocus("challenge-photos-heading");
  });
  const showOriginal = (assetId: string) => run(async signal => { clearPreview(); const current = await client.view(view.projectId, signal), asset = current.assets.find(item => item.id === assetId); if (!asset) throw { code: "access_lost" }; const blob = await client.download({ ...asset, projectId: view.projectId }, signal); client.assertActive(signal); url.current = URL.createObjectURL(blob); setPreview({ url: url.current, width: asset.width, height: asset.height, result: false }); setFocus("challenge-preview-heading"); });
  const render = (download: boolean) => run(async signal => { clearPreview(); const result = await renderChallengePng({ challenges, projects: client, challengeId: view.id, signal }); client.assertActive(signal); if (download) { downloadProjectBlob(result.blob, `challenge-${view.id}.png`); setNotice(["Downloading now. Check your downloads folder.", ...result.warnings].join(" ")); } else { url.current = URL.createObjectURL(result.blob); setPreview({ url: url.current, width: result.width, height: result.height, result: true }); setNotice(result.warnings.join(" ") || null); setFocus("challenge-preview-heading"); } });
  const submit = () => run(async signal => { if (!editable || !complete) throw { code: "not_ready" }; const input = attempt ?? await challengeSubmission(view.id, client.ownerId, assignments.map(item => ({ sourceIndex: item.sourceIndex, assetId: selection[item.sourceIndex] }))); client.assertActive(signal); setAttempt(input); clearPreview(); acceptView(await challenges.submit(view.id, input, signal)); setConfirm(null); files.current.clear(); setFileIds([]); setNotice("Submitted."); setFocus("challenge-heading"); });
  const ask = (action: Action | "submit") => { setConfirm(action); setFocus("challenge-confirm-action"); };
  const chooseFile = (sourceIndex: number, recordId?: string) => { pick.current = { sourceIndex, recordId }; picker.current?.click(); };

  return <section className="mt-7" aria-labelledby="challenge-heading">
    <button className={`${cloudControl} -ml-4 mb-4`} disabled={actionBusy} onClick={onBack}><ArrowLeft size={16} aria-hidden /> Photo challenges</button>
    <header className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-5"><div><h2 id="challenge-heading" tabIndex={-1} className="font-display text-3xl font-semibold outline-none">Your photo challenge</h2><p className="mt-2 text-sm capitalize text-foreground/70">{view.status === "open" && expired ? "Deadline passed" : view.status} · {mine ? `Your role: ${mine.role}` : "Invitation"}</p></div><button className={cloudControl} disabled={actionBusy} onClick={() => void run(refresh)}><RefreshCw size={16} aria-hidden /> Refresh</button></header>
    {error && <p role="alert" className="mt-4 rounded-xl bg-muted p-4 text-sm leading-relaxed">{error}</p>}
    {notice && <p role="status" className="mt-4 rounded-xl bg-muted p-4 text-sm leading-relaxed">{notice}</p>}
    {busy && <div className="mt-4 flex flex-wrap items-center gap-3"><p role="status" className="flex items-center gap-2 text-sm"><LoaderCircle size={16} aria-hidden className="animate-spin motion-reduce:animate-none" /> Waiting for confirmation…</p><button className={`${cloudControl} border border-border`} onClick={() => { controller.current?.abort(); clearPreview(); setNotice("Stopped waiting. It may have worked, so refresh before trying again."); }}>Stop waiting</button></div>}
    <div className="grid gap-8 py-7 md:grid-cols-[minmax(0,1fr)_16rem]"><section className="min-w-0"><h3 className="font-semibold">How it works</h3><p className="mt-3 text-sm leading-relaxed">{view.policy === "all_submitted" ? "Photos stay hidden until everyone is done." : "Everyone sees each person's photos as soon as they submit."}</p><p className="mt-2 text-sm leading-relaxed text-foreground/70">Deadline: {new Date(view.expiresAt).toLocaleString("en-AU")} ({Intl.DateTimeFormat().resolvedOptions().timeZone}).</p><ul className="mt-5 divide-y divide-border" aria-label="People">{view.members.map(member => <li key={member.userId} className="py-3"><p className="text-sm font-medium">Role {member.role}{member.userId === client.ownerId ? " · You" : ""} · {member.status === "accepted" ? member.submitted ? "Submitted" : "Joined" : member.status}</p><p className="mt-1 break-all text-xs text-foreground/70">{member.userId}</p></li>)}</ul></section>
      <figure><div className="relative mx-auto w-full max-w-56 overflow-hidden rounded-sm bg-[#faf4ed]" style={{ aspectRatio: `${view.design.canvas.width}/${view.design.canvas.height}` }}>{view.design.slots.map(slot => <div key={slot.id} className="absolute flex items-center justify-center border border-[#332b34]/20 bg-[#df8497]/30 text-center text-xs font-semibold text-[#332b34]" style={{ left: `${slot.x * 100}%`, top: `${slot.y * 100}%`, width: `${slot.width * 100}%`, height: `${slot.height * 100}%` }}>{slot.role} · {slot.sourceIndex + 1}</div>)}</div><figcaption className="mt-3 text-center text-xs leading-relaxed text-foreground/70">Letters are people. Numbers are photos.</figcaption></figure>
    </div>
    {view.accessLost && <p role="status" className="mb-6 rounded-xl bg-muted p-4 text-sm leading-relaxed">Someone left or a photo was removed, so the full result can&apos;t be shown.</p>}
    {mine?.status === "invited" && view.status === "draft" && !expired && <div className="mb-7"><p className="mb-3 max-w-xl text-sm leading-relaxed">Accepting also adds you to the shared project.</p><div className="flex flex-wrap gap-3"><button className={`${cloudControl} bg-accent text-accent-foreground`} disabled={actionBusy} onClick={() => void manage("accept")}>Accept</button><button className={cloudControl} disabled={actionBusy} onClick={() => ask("decline")}>Decline</button></div></div>}
    {project.project.ownerId === client.ownerId && view.status === "draft" && !expired && <div className="mb-7"><button className={`${cloudControl} bg-accent text-accent-foreground`} disabled={actionBusy || view.members.some(member => member.status !== "accepted") || view.accessLost} onClick={() => void manage("open")}>Start the challenge</button><p className="mt-2 text-sm text-foreground/70">Everyone needs to accept first. Refresh to check.</p></div>}
    {view.story && <ChallengeStoryReview title="Photo story" plan={view.story} members={view.members} assignments={view.assignments} frozen />}{editable && <section className="border-t border-border py-6" aria-labelledby="challenge-photos-heading"><h3 id="challenge-photos-heading" tabIndex={-1} className="text-lg font-semibold outline-none">Your photos</h3><p className="mt-2 max-w-2xl text-sm leading-relaxed text-foreground/70">JPEG, PNG or WebP, up to 10 MiB. Upload your photos, then submit them.</p><input ref={picker} type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" tabIndex={-1} aria-label="Choose a photo" onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void choose(file); }} />
      {cameraOpen && <ChallengeCamera key={cameraSource} sourceIndex={cameraSource!} story={view.story} storyMembers={view.members} disabled={busy} onUse={selectCameraPhoto} onClose={() => { setCameraSource(null); setFocus("challenge-photos-heading"); }} />}
      <ol className="mt-5 divide-y divide-border">{assignments.map(item => { const record = choices.find(record => record.id === selection[item.sourceIndex]); return <li key={item.sourceIndex} className="py-5"><h4 className="font-medium">Your photo {item.sourceIndex + 1}</h4>{view.story && <ChallengeStoryPose plan={view.story} members={view.members} sourceIndex={item.sourceIndex} />}<div className="mt-3 flex flex-wrap gap-2"><button className={`${cloudControl} border border-border`} disabled={locked} onClick={() => chooseFile(item.sourceIndex)}>Choose photo {item.sourceIndex + 1}</button><button className={`${cloudControl} border border-border`} disabled={locked} onClick={() => { pick.current = null; clearPreview(); setCameraSource(item.sourceIndex); setFocus("challenge-camera-heading"); }}>Take photo {item.sourceIndex + 1}</button>{record && record.state !== "ready" && record.state !== "failed" && <>{fileIds.includes(record.id) ? <button id={`challenge-upload-${item.sourceIndex}`} className={`${cloudControl} bg-accent text-accent-foreground`} disabled={locked} onClick={() => void upload(records.find(item => item.id === record.id)!, true)}><Upload size={16} aria-hidden /> Upload photo {item.sourceIndex + 1}</button> : <button className={cloudControl} disabled={locked} onClick={() => chooseFile(item.sourceIndex, record.id)}>Choose same file</button>}{!fileIds.includes(record.id) && savedCameraIds.includes(record.id) && <button className={cloudControl} disabled={locked} onClick={() => void recoverCamera(records.find(item => item.id === record.id)!, item.sourceIndex)}>Use saved camera photo</button>}{record.state !== "prepared" && <button className={cloudControl} disabled={locked} onClick={() => void upload(records.find(item => item.id === record.id)!, false)}>Check status</button>}</>}{record?.state === "ready" && <button className={cloudControl} disabled={actionBusy} onClick={() => void showOriginal(record.id)}>View photo {item.sourceIndex + 1}</button>}</div>{record && <p className="mt-2 text-sm text-foreground/70">{stages[record.state]} · {record.asset.width} × {record.asset.height} · {cloudSize(record.asset.bytes)}</p>}
        {choices.length > 0 && <div className="mt-4 max-w-lg"><Dropdown label={`Use an earlier upload for photo ${item.sourceIndex + 1}`} showLabel disabled={locked} value={selection[item.sourceIndex] ?? ""} onChange={id => selectUpload(item.sourceIndex, id)} options={[{ value: "", label: "None" }, ...choices.map((record, index) => ({ value: record.id, label: `Upload ${index + 1} · ${stages[record.state]} · ${record.asset.width} × ${record.asset.height}`, disabled: assignments.some(other => other.sourceIndex !== item.sourceIndex && selection[other.sourceIndex] === record.id) }))]} /></div>}
      </li>; })}</ol><button className={`${cloudControl} mt-5 bg-accent text-accent-foreground`} disabled={actionBusy || !complete} onClick={() => ask("submit")}>{attempt ? "Try again" : "Submit my photos"}</button>{attempt && <p className="mt-3 max-w-xl text-sm text-foreground/70">Refresh to check whether it went through.</p>}
    </section>}
    {mine?.submitted && !fullResult && <p className="mb-6 text-sm leading-relaxed">You&apos;ve submitted your photos. {view.status === "open" && !expired ? "Check back when everyone else is done." : "This challenge can't be completed."}</p>}
    {!fullResult && view.visibleSources.length > 0 && <section className="border-t border-border py-6"><h3 className="font-semibold">Photos you can see</h3><div className="mt-3 flex flex-wrap gap-2">{view.visibleSources.map(source => <button key={source.assetId} className={`${cloudControl} border border-border`} disabled={actionBusy} onClick={() => void showOriginal(source.assetId)}>Preview role {view.members.find(member => member.userId === source.userId)?.role} photo {source.sourceIndex + 1}</button>)}</div></section>}
    {fullResult && <section className="border-t border-border py-7"><h3 className="font-display text-2xl">Finished strip</h3><div className="mt-4 flex flex-wrap gap-3"><button className={`${cloudControl} bg-accent text-accent-foreground`} disabled={actionBusy} onClick={() => void render(false)}>Preview</button><button className={`${cloudControl} border border-border`} disabled={actionBusy} onClick={() => void render(true)}><ArrowDownToLine size={16} aria-hidden /> Download PNG</button></div></section>}
    {fullResult && view.status === "revealed" && <EventPostcardComposer source={{ kind: "challenge", id: view.id }} design={view.design} assertSourceActive={assertPostcardSource} sourceAccessToken={sourceAccessToken} disabled={busy || cameraOpen || partialPostcardBusy || Boolean(confirm)} onBusyChange={setPostcardBusy} render={async (signal, frozenDesign) => {
      assertPostcardSource(signal);
      if (JSON.stringify(frozenDesign) !== JSON.stringify(view.design)) throw new Error("The postcard layout doesn't match this challenge.");
      const result = await renderChallengePng({ challenges, projects: client, challengeId: view.id, signal });
      assertPostcardSource(signal);
      if (result.recipeHash !== view.recipeHash) throw new Error("The challenge result changed. Check it, then try again.");
      return result.blob;
    }} />}
    {mine?.status === "accepted" && view.status !== "draft" && <ChallengePartials drafts={drafts} view={view} challenges={challenges} projects={client} busy={busy || cameraOpen || postcardBusy || Boolean(confirm)} onPostcardBusyChange={setPartialPostcardBusy} sourceAccessToken={sourceAccessToken} run={run} clearPreview={clearPreview} onNotice={setNotice} onFocus={setFocus} showPreview={result => { clearPreview(); url.current = URL.createObjectURL(result.blob); setPreview({ url: url.current, width: result.width, height: result.height, result: true, partial: true }); setFocus("challenge-preview-heading"); }} />}
    {preview && <figure className="border-t border-border py-6"><div className="flex items-center justify-between gap-3"><h3 id="challenge-preview-heading" tabIndex={-1} className="font-semibold outline-none">{preview.partial ? "Partial result" : preview.result ? "Finished strip" : "Your photo"}</h3><button className={cloudControl} aria-label="Close preview" onClick={() => { clearPreview(); setFocus("challenge-heading"); }}><X size={18} aria-hidden /></button></div><Image unoptimized src={preview.url} width={preview.width} height={preview.height} alt={preview.partial ? "Partial result, with blank spots for missing photos" : preview.result ? "Finished challenge strip" : "Your selected photo"} className="mx-auto mt-4 max-h-[32rem] w-auto max-w-full object-contain" /></figure>}
    {confirm && <section className="my-6 max-w-2xl rounded-xl bg-muted p-5" aria-label="Confirm challenge action"><h3 className="font-semibold">{confirm === "submit" ? "Submit these photos?" : confirm === "withdraw" ? "Withdraw from this challenge?" : confirm === "decline" ? "Decline this invitation?" : "Cancel this challenge?"}</h3><p className="mt-2 text-sm leading-relaxed">{confirm === "submit" ? `You can't change them after this. ${view.policy === "immediate" ? "Everyone will see them immediately." : "If everyone else is done, this reveals the result."}` : confirm === "withdraw" ? "This blocks future access to the full result for everyone and can't be undone. Your cloud photos and downloaded copies remain." : confirm === "decline" ? "You can't change this later." : "This ends the challenge without revealing hidden photos. It can't be reopened."}</p><div className="mt-4 flex flex-wrap gap-3"><button id="challenge-confirm-action" className={`${cloudControl} border border-border`} disabled={actionBusy} onClick={() => void (confirm === "submit" ? submit() : manage(confirm))}>{confirm === "submit" ? "Submit" : confirm === "withdraw" ? "Withdraw" : confirm === "decline" ? "Decline" : "Cancel challenge"}</button><button className={cloudControl} disabled={actionBusy} onClick={() => { setConfirm(null); setFocus("challenge-heading"); }}>Go back</button></div></section>}
    <footer className="mt-6 border-t border-border py-5"><div className="flex flex-wrap gap-2">{project.project.ownerId === client.ownerId && (view.status === "draft" || view.status === "open") && <button className={`${cloudControl} -ml-4 underline underline-offset-4`} disabled={actionBusy} onClick={() => ask("cancel")}>Cancel challenge…</button>}{mine?.status === "accepted" && <button className={`${cloudControl} underline underline-offset-4`} disabled={actionBusy} onClick={() => ask("withdraw")}>Withdraw from challenge…</button>}</div><details className="mt-3 text-sm text-foreground/70"><summary className="cursor-pointer py-2">Challenge ID</summary><p className="break-all py-2">{view.id}</p></details></footer>
  </section>;
}
