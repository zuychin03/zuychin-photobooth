"use client";
import { useAppNavigationGuard } from "@/components/AppNavigation";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { Camera, LoaderCircle, RotateCcw, X } from "lucide-react";
import { CameraPreview } from "@/components/CameraPreview";
import { Dropdown } from "@/components/Dropdown";
import { useCamera } from "@/hooks/useCamera";
import { stopStream } from "@/lib/camera";
import { runCaptureSequence } from "@/lib/capture-sequence";
import { captureChallengePhoto, challengeCameraMessage } from "@/lib/memories/challenge-camera";
import { cloudControl } from "./CloudControls";
import type { StoryPlan } from "@/lib/stories/model";
import type { StoryMember } from "./challenge-story-review";
import { ChallengeStoryPose } from "./ChallengeStory";

interface Props {
  sourceIndex: number; disabled: boolean;
  story?: StoryPlan | null; storyMembers?: readonly StoryMember[];
  onUse(file: File, sourceIndex: number, signal: AbortSignal): Promise<boolean>;
  onClose(): void;
}
export function ChallengeCamera({ sourceIndex, disabled, onUse, onClose, story, storyMembers }: Props) {
  const [started, setStarted] = useState(false), [mirror, setMirror] = useState(true), [timer, setTimer] = useState<3 | 5 | 10>(3), [cameraId, setCameraId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [count, setCount] = useState<number | null>(null), [error, setError] = useState<string | null>(null);
  const [photo, setPhoto] = useState<{ file: File; url: string; width: number; height: number } | null>(null);
  const { stream: streamRef, videoRef, attachVideo, ready, error: cameraFailure, cameras, retry } = useCamera(started && !disabled, cameraId);
  const live = useRef(false), operation = useRef(false), using = useRef(false), request = useRef<AbortController | null>(null), objectUrl = useRef<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null), reviewHeading = useRef<HTMLHeadingElement>(null);
  useAppNavigationGuard(() => {
    if (operation.current || busy) { setError("Wait for the current photo action to finish, or close the camera before leaving."); return false; }
    if (photo) { setError("Use this photo, or close the camera to discard it before leaving."); return false; }
    return true;
  });
  const clearPhoto = () => { if (objectUrl.current) URL.revokeObjectURL(objectUrl.current); objectUrl.current = null; setPhoto(null); };
  const stopCamera = () => { stopStream(streamRef.current); streamRef.current = null; if (videoRef.current) videoRef.current.srcObject = null; setStarted(false); };
  useEffect(() => {
    live.current = true; heading.current?.focus();
    return () => { live.current = false; request.current?.abort(); stopStream(streamRef.current); streamRef.current = null; if (objectUrl.current) URL.revokeObjectURL(objectUrl.current); objectUrl.current = null; };
  }, [streamRef]);
  useEffect(() => {
    if (!disabled || using.current) return;
    request.current?.abort(); stopStream(streamRef.current); streamRef.current = null;
  }, [disabled, streamRef]);
  useEffect(() => { if (photo && !busy) reviewHeading.current?.focus(); }, [photo, busy]);
  const close = () => { request.current?.abort(); stopCamera(); clearPhoto(); onClose(); };
  const shoot = async () => {
    if (disabled || operation.current || !ready || !videoRef.current) return;
    operation.current = true; const abort = new AbortController(); request.current = abort;
    const video = videoRef.current; let width = 0, height = 0; setBusy(true); setError(null); clearPhoto();
    try {
      await runCaptureSequence([sourceIndex], timer, {
        cancelled: () => abort.signal.aborted || !live.current,
        pause: milliseconds => new Promise(resolve => {
          const done = () => { clearTimeout(timeout); abort.signal.removeEventListener("abort", done); resolve(); };
          const timeout = setTimeout(done, milliseconds); if (abort.signal.aborted) done(); else abort.signal.addEventListener("abort", done, { once: true });
        }),
        countdown: value => { if (live.current && !abort.signal.aborted) setCount(value); },
        capture: () => { width = video.videoWidth; height = video.videoHeight; const pending = captureChallengePhoto(video, mirror, sourceIndex, abort.signal); stopCamera(); return pending; },
        persist: async (_index, pending) => {
          const file = await pending; if (abort.signal.aborted || !live.current) return;
          const url = URL.createObjectURL(file); objectUrl.current = url;
          setPhoto({ file, url, width, height });
        },
        saved: () => {},
      });
    } catch (failure) { if (live.current && !abort.signal.aborted) setError(challengeCameraMessage(failure)); }
    finally { operation.current = false; if (live.current) { setBusy(false); setCount(null); } }
  };
  const selectPhoto = async () => {
    if (!photo || disabled || operation.current) return;
    operation.current = true; using.current = true; const abort = new AbortController(); request.current = abort; setBusy(true); setError(null);
    try {
      const accepted = await onUse(photo.file, sourceIndex, abort.signal);
      if (!live.current || abort.signal.aborted) return;
      if (accepted) close(); else setError("This photo was not confirmed saved and selected. Keep a local copy before closing. If storage is full, free space in Projects and retry Use this photo.");
    } catch { if (live.current && !abort.signal.aborted) setError("This photo could not be saved and selected. Keep a local copy before closing, or retry after checking local storage."); }
    finally { operation.current = false; using.current = false; if (live.current) setBusy(false); }
  };
  const cameraError = cameraFailure === "denied" ? "Camera access was not allowed. Change the browser permission and retry, or close this panel and choose a file." : cameraFailure === "no-camera" ? "No usable camera was found. Connect a camera and retry, or choose a file." : cameraFailure === "in-use" ? "The camera is in use or could not start. Close other camera apps and retry, or choose a file." : "The camera could not start. Retry, or close this panel and choose a file.";
  return <section className="my-6 border-y border-border py-6" aria-labelledby="challenge-camera-heading">
    <div className="flex items-start justify-between gap-3"><div><h3 ref={heading} id="challenge-camera-heading" tabIndex={-1} className="font-display text-2xl outline-none">Take your photo {sourceIndex + 1}</h3><p className="mt-2 max-w-xl text-sm leading-relaxed text-foreground/70">Review before using. This saves a local original; upload and submit separately. No sound or flash.</p></div><button className={cloudControl} aria-label="Close challenge camera" onClick={close}><X size={18} aria-hidden /></button></div>
    {story && storyMembers && <ChallengeStoryPose plan={story} members={storyMembers} sourceIndex={sourceIndex} />}
    {error && <p role="alert" className="mt-4 rounded-xl bg-muted p-4 text-sm leading-relaxed">{error}</p>}
    {photo ? <div className="mt-5"><h4 ref={reviewHeading} tabIndex={-1} className="font-semibold outline-none">Review photo {sourceIndex + 1}</h4><Image unoptimized src={photo.url} width={photo.width} height={photo.height} alt={`Your captured challenge photo ${sourceIndex + 1}`} className="mt-3 max-h-[28rem] w-full object-contain" /><div className="mt-4 flex flex-wrap gap-3"><button className={`${cloudControl} bg-accent text-accent-foreground`} disabled={busy || disabled} onClick={() => void selectPhoto()}>Use this photo</button><button className={`${cloudControl} border border-border`} disabled={busy || disabled} onClick={() => { clearPhoto(); setError(null); setStarted(true); retry(); }}><RotateCcw size={16} aria-hidden /> Retake</button><a className={`${cloudControl} underline underline-offset-4`} href={photo.url} download={photo.file.name}>Keep local copy</a></div><p className="mt-3 text-sm text-foreground/70">Closing or retaking discards this preview. Keep a local copy if you want it independently of this challenge.</p></div> : <>
      <div className="relative mt-5 aspect-video overflow-hidden bg-black"><CameraPreview videoRef={attachVideo} mirror={mirror} filterCss="none" className="!object-contain" />{count !== null && <span className="pointer-events-none absolute inset-0 flex items-center justify-center font-display text-8xl font-semibold text-white">{count}</span>}</div>
      <p role="status" aria-live="polite" className="mt-3 text-sm">{count !== null ? `Photo ${sourceIndex + 1} in ${count}` : busy ? "Preparing your local photo…" : started && !ready && !cameraFailure ? "Waiting for camera access. Allow it in your browser, or close this panel to choose a file." : ready ? "Camera ready. The preview shows the whole photo." : "Camera is off. Start it when you are ready."}</p>
      {started && cameraFailure && <p role="alert" className="mt-3 text-sm leading-relaxed">{cameraError}</p>}
      <fieldset disabled={busy || disabled} className="mt-5 grid gap-4 sm:grid-cols-2"><legend className="sr-only">Challenge camera settings</legend><Dropdown label="Timer" showLabel value={String(timer)} disabled={busy || disabled} options={[3, 5, 10].map(value => ({ value: String(value), label: `${value} seconds` }))} onChange={value => setTimer(Number(value) as 3 | 5 | 10)} /><Dropdown label="Camera" showLabel value={cameraId ?? ""} disabled={busy || disabled} options={[{ value: "", label: "Default camera" }, ...cameras.filter(device => device.id).map(device => ({ value: device.id, label: device.label }))]} onChange={value => setCameraId(value || null)} /><label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={mirror} onChange={event => setMirror(event.target.checked)} className="h-5 w-5 accent-accent" /> Mirror photo</label></fieldset>
      <div className="mt-4 flex flex-wrap gap-3">{!started ? <button className={`${cloudControl} bg-accent text-accent-foreground`} disabled={busy || disabled} onClick={() => { setError(null); setStarted(true); retry(); }}><Camera size={17} aria-hidden /> Start camera</button> : cameraFailure ? <button className={`${cloudControl} border border-border`} disabled={busy || disabled} onClick={() => retry()}>Retry camera</button> : <button className={`${cloudControl} bg-accent text-accent-foreground`} disabled={busy || disabled || !ready} onClick={() => void shoot()}><Camera size={17} aria-hidden /> Take photo {sourceIndex + 1}</button>}{busy && <button className={`${cloudControl} border border-border`} onClick={() => { request.current?.abort(); stopCamera(); setError("Capture stopped. No photo was selected or uploaded."); }}><LoaderCircle size={16} aria-hidden className="animate-spin motion-reduce:animate-none" /> Stop capture</button>}</div>
    </>}
  </section>;
}
