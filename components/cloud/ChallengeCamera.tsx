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
    if (operation.current || busy) { setError("Wait for the photo to finish, or close the camera."); return false; }
    if (photo) { setError("Use this photo, or close the camera to discard it."); return false; }
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
      if (accepted) close(); else setError("Couldn't save this photo. Download a copy before closing, then try Use this photo again.");
    } catch { if (live.current && !abort.signal.aborted) setError("Couldn't save this photo. Download a copy before closing, then try again."); }
    finally { operation.current = false; using.current = false; if (live.current) setBusy(false); }
  };
  const cameraError = cameraFailure === "denied" ? "Camera access is blocked. Allow it in your browser settings, or choose a file." : cameraFailure === "no-camera" ? "No camera found. Connect one and try again, or choose a file." : cameraFailure === "in-use" ? "Another app is using the camera. Close it and try again, or choose a file." : "Couldn't start the camera. Try again, or choose a file.";
  return <section className="panel-muted my-4 p-4 sm:p-5" aria-labelledby="challenge-camera-heading">
    <div className="flex items-center justify-between gap-3"><h3 ref={heading} id="challenge-camera-heading" tabIndex={-1} className="font-display text-xl outline-none">Take your photo {sourceIndex + 1}</h3><button className="btn btn-quiet min-w-11 bg-card px-0" aria-label="Close camera" onClick={close}><X size={18} aria-hidden /></button></div>
    {story && storyMembers && <ChallengeStoryPose plan={story} members={storyMembers} sourceIndex={sourceIndex} />}
    {error && <p role="alert" className="notice mt-4 bg-card font-bold text-destructive">{error}</p>}
    {photo ? <div className="mt-4"><h4 ref={reviewHeading} tabIndex={-1} className="font-bold outline-none">Review photo {sourceIndex + 1}</h4><Image unoptimized src={photo.url} width={photo.width} height={photo.height} alt={`Your captured challenge photo ${sourceIndex + 1}`} className="mt-3 max-h-[28rem] w-full rounded-2xl object-contain" /><div className="mt-4 flex flex-wrap gap-2"><button className="btn btn-primary" disabled={busy || disabled} onClick={() => void selectPhoto()}>Use this photo</button><button className="btn btn-quiet bg-card" disabled={busy || disabled} onClick={() => { clearPhoto(); setError(null); setStarted(true); retry(); }}><RotateCcw size={16} aria-hidden /> Retake</button><a className="btn btn-plain" href={photo.url} download={photo.file.name}>Download a copy</a></div><p className="mt-3 text-sm text-muted-foreground">Closing or retaking discards this photo.</p></div> : <>
      <div className="relative mt-4 aspect-video overflow-hidden rounded-2xl bg-black"><CameraPreview videoRef={attachVideo} mirror={mirror} filterCss="none" className="!object-contain" />{count !== null && <span className="pointer-events-none absolute inset-0 flex items-center justify-center font-display text-8xl text-white drop-shadow-[0_2px_24px_rgba(0,0,0,0.55)]">{count}</span>}</div>
      <p role="status" aria-live="polite" className="mt-3 text-sm font-bold">{count !== null ? `Photo ${sourceIndex + 1} in ${count}` : busy ? "Processing your photo…" : started && !ready && !cameraFailure ? "Waiting for camera access…" : ready ? "Camera ready." : "Camera is off."}</p>
      {started && cameraFailure && <p role="alert" className="mt-2 text-sm text-destructive">{cameraError}</p>}
      <fieldset disabled={busy || disabled} className="mt-4 grid gap-4 sm:grid-cols-2"><legend className="sr-only">Camera settings</legend><Dropdown label="Timer" showLabel value={String(timer)} disabled={busy || disabled} options={[3, 5, 10].map(value => ({ value: String(value), label: `${value} seconds` }))} onChange={value => setTimer(Number(value) as 3 | 5 | 10)} /><Dropdown label="Camera" showLabel value={cameraId ?? ""} disabled={busy || disabled} options={[{ value: "", label: "Default camera" }, ...cameras.filter(device => device.id).map(device => ({ value: device.id, label: device.label }))]} onChange={value => setCameraId(value || null)} /><label className="flex min-h-11 items-center gap-2 text-sm font-bold"><input type="checkbox" checked={mirror} onChange={event => setMirror(event.target.checked)} className="h-5 w-5 accent-accent" /> Mirror photo</label></fieldset>
      <div className="mt-4 flex flex-wrap gap-2">{!started ? <button className="btn btn-primary" disabled={busy || disabled} onClick={() => { setError(null); setStarted(true); retry(); }}><Camera size={17} aria-hidden /> Start camera</button> : cameraFailure ? <button className="btn btn-quiet bg-card" disabled={busy || disabled} onClick={() => retry()}>Try again</button> : <button className="btn btn-primary" disabled={busy || disabled || !ready} onClick={() => void shoot()}><Camera size={17} aria-hidden /> Take photo {sourceIndex + 1}</button>}{busy && <button className="btn btn-quiet bg-card" onClick={() => { request.current?.abort(); stopCamera(); setError("Stopped. No photo was used."); }}><LoaderCircle size={16} aria-hidden className="animate-spin motion-reduce:animate-none" /> Stop</button>}</div>
    </>}
  </section>;
}
