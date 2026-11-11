"use client";

import { useAppNavigationGuard } from "@/components/AppNavigation";

import { useEffect, useRef, useState } from "react";
import { RelayOriginalRecovery } from "./RelayOriginalRecovery";
import { CaptureFeedbackSettings } from "./CaptureFeedbackSettings";
import { MobileControlPanel } from "./MobileControlPanel";
import { SwitchCamera } from "lucide-react";
import { CameraPreview } from "@/components/CameraPreview";
import { Countdown, CaptureFlash } from "@/components/Countdown";
import { useCamera } from "@/hooks/useCamera";
import { captureFrame } from "@/lib/capture";
import { getFilter } from "@/lib/filters";
import { importRelayPhotos, relayFrameOriginal, relayOriginalEncoder } from "@/lib/relay-recovery";
import { playShutter, playTick } from "@/lib/sound";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const release = (frames: HTMLCanvasElement[]) => { for (const frame of frames) frame.width = frame.height = 0; };

export function RoleCapture({ shots, filterId, onDone, onCheckpoint, initialOriginals = [], onUnsavedChange, hint, rehearsalPhotos }: {
  shots: number; filterId: string; onDone(frames: HTMLCanvasElement[], originals: Blob[]): void;
  onCheckpoint(originals: Blob[]): Promise<void>; onUnsavedChange?(unsaved: boolean): void; initialOriginals?: readonly Blob[]; hint?: string; rehearsalPhotos?: File[];
}) {
  const synthetic = process.env.NODE_ENV === "development" && Boolean(rehearsalPhotos);
  const { videoRef, attachVideo, ready, error: cameraError, facing, canFlip, toggleFacing, retry } = useCamera(!synthetic);
  const error = synthetic ? "Synthetic camera denial" : cameraError;
  const [count, setCount] = useState<number | null>(null), [flash, setFlash] = useState(0), [progress, setProgress] = useState(initialOriginals.length);
  const [shooting, setShooting] = useState(false), [nativeBusy, setNativeBusy] = useState(relayOriginalEncoder.busy), [captureError, setCaptureError] = useState<string | null>(null), [discarding, setDiscarding] = useState(false);
  const originals = useRef<Blob[]>([...initialOriginals]), frames = useRef<HTMLCanvasElement[]>([]), checkpointed = useRef(initialOriginals.length);
  const [shownOriginals, setShownOriginals] = useState<Blob[]>([...initialOriginals]), [unsaved, setUnsaved] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const cancelled = useRef(false), running = useRef(false), handedOff = useRef(false);
  useEffect(() => {
    cancelled.current = false;
    const ownedFrames = frames.current;
    void relayOriginalEncoder.settled().then(() => { if (!cancelled.current) setNativeBusy(false); });
    return () => { cancelled.current = true; if (!handedOff.current) void relayOriginalEncoder.settled().then(() => release(ownedFrames)); };
  }, []);
  useEffect(() => { if (!unsaved) return; const warn = (event: BeforeUnloadEvent) => event.preventDefault(); window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn); }, [unsaved]);
  useEffect(() => { onUnsavedChange?.(unsaved || shooting); return () => onUnsavedChange?.(false); }, [onUnsavedChange, unsaved, shooting]);
  useAppNavigationGuard(() => {
    if (unsaved || shooting) { setCaptureError("Finish taking your photos and let them save before you leave."); return false; }
    return true;
  }, !synthetic);
  const active = () => !cancelled.current;
  const ensureFrames = async () => {
    for (let index = frames.current.length; index < originals.current.length; index++) {
      const decoded = await importRelayPhotos([originals.current[index]], 1, active);
      if (!active()) { release(decoded); throw new Error("Capture closed"); }
      frames.current.push(decoded[0]);
    }
  };
  const finish = () => { if (active()) { handedOff.current = true; onDone(frames.current, [...originals.current]); } };
  const checkpoint = async () => {
    await onCheckpoint([...originals.current]);
    if (!active()) throw new Error("Capture closed");
    checkpointed.current = originals.current.length; setProgress(checkpointed.current); setUnsaved(false);
  };
  const perform = async (operation: () => Promise<void>) => {
    if (running.current || relayOriginalEncoder.busy) return;
    running.current = true; setShooting(true); setCaptureError(null);
    try { await operation(); }
    catch (failure) { if (active()) setCaptureError(failure instanceof Error ? failure.message : "Your photo is still here. Try saving again, or download a copy."); }
    finally { running.current = false; if (active()) { setCount(null); setShooting(false); } }
  };
  const run = () => perform(async () => {
    await ensureFrames();
    while (checkpointed.current < shots) {
      const index = checkpointed.current;
      if (!frames.current[index]) {
        const video = videoRef.current;
        if (!video || !ready) throw new Error("Try the camera again, or import the rest of your photos.");
        for (let c = 3; c >= 1; c--) { if (!active()) return; setCount(c); playTick(); await sleep(1000); }
        setCount(null); if (!active()) return;
        if (video.videoWidth > 4096 || video.videoHeight > 4096 || video.videoWidth * video.videoHeight > 12 * 1024 * 1024) throw new Error("Your camera's photos are too big. Import smaller photos instead.");
        frames.current.push(captureFrame(video, facing === "user")); setUnsaved(true); playShutter(); setFlash(value => value + 1);
      }
      if (!originals.current[index]) {
        setNativeBusy(true);
        try { const blob = await relayFrameOriginal(frames.current[index]); if (!active()) return; originals.current.push(blob); setShownOriginals([...originals.current]); }
        finally { void relayOriginalEncoder.settled().then(() => { if (active()) setNativeBusy(false); }); }
      }
      await checkpoint();
      if (!active()) return;
      await sleep(index === shots - 1 ? 100 : 400);
    }
    finish();
  });
  const importPhotos = (files: File[]) => perform(async () => {
    const remaining = shots - checkpointed.current;
    if (files.length !== remaining || remaining < 1) throw new Error(`Pick exactly ${remaining} more ${remaining === 1 ? "photo" : "photos"}.`);
    await ensureFrames();
    for (const file of files) {
      const decoded = await importRelayPhotos([file], 1, active);
      frames.current.push(decoded[0]); originals.current.push(file); setShownOriginals([...originals.current]); setUnsaved(true);
      await checkpoint();
    }
    finish();
  });
  const discard = () => {
    release(frames.current.splice(checkpointed.current)); originals.current.splice(checkpointed.current);
    setShownOriginals([...originals.current]); setUnsaved(false); setDiscarding(false); setCaptureError(null);
  };
  const remaining = shots - progress;
  return <div className="relative flex h-full min-h-0 flex-col">
    {!error && <div className="relative min-h-48 flex-1 overflow-hidden"><CameraPreview videoRef={attachVideo} mirror={facing === "user"} filterCss={getFilter(filterId).css} />{!ready && <p className="absolute inset-0 flex items-center justify-center text-sm font-bold text-muted-foreground">Starting camera…</p>}<Countdown value={count} /><CaptureFlash trigger={flash} />{canFlip && !shooting && <button onClick={toggleFacing} aria-label="Switch camera" className="btn btn-glass absolute top-4 right-4 min-w-11 px-0"><SwitchCamera size={20} /></button>}</div>}
    <div className="flex justify-center p-3 pb-4 sm:p-4">
      <div className="panel flex w-full max-w-2xl flex-col items-center gap-3 p-4 sm:p-5">
        {error && <><p className="text-center">Can&apos;t use your camera. Try again, or import your photos.</p><button disabled={shooting || nativeBusy} onClick={retry} className="btn btn-quiet">Try camera again</button></>}
        <p role="status" className="text-center text-sm font-bold tabular-nums">{progress} of {shots} photos saved on this device.{shooting ? " Saving as you go…" : ""}</p>
        {!shooting && !captureError && <button disabled={nativeBusy || (remaining > 0 && (!ready || unsaved))} onClick={() => void run()} className="btn btn-primary min-h-14 px-8 text-base">{remaining === 0 ? "Continue with saved photos" : progress ? "Continue shooting" : "Start shooting"}</button>}
        {captureError && <p role="alert" className="max-w-sm text-center text-sm font-bold text-destructive">{captureError}</p>}
        {nativeBusy && !shooting && <p role="status" className="max-w-sm text-center text-sm text-muted-foreground">Still processing your photo. You can try again in a moment.</p>}
        {shownOriginals.length > 0 && <RelayOriginalRecovery originals={shownOriginals} saved={!unsaved} />}
        {captureError && <button disabled={shooting || nativeBusy} className="btn btn-primary" onClick={() => void run()}>{unsaved && shownOriginals.length === progress ? "Try again and continue" : "Try saving again and continue"}</button>}
        {unsaved && !shooting && <><p className="max-w-sm text-center text-sm">{unsaved && shownOriginals.length === progress ? "This photo hasn't saved yet. Your earlier photos are in My projects." : "This photo hasn't saved yet, but you can download it here. Your earlier photos are in My projects."}</p>{discarding ? <div role="alertdialog" aria-label="Discard unsaved photo" className="notice w-full max-w-sm text-center"><p>Discard just this unsaved photo? Your saved ones stay.</p><div className="mt-3 flex flex-wrap justify-center gap-2"><button autoFocus disabled={nativeBusy} className="btn btn-quiet min-h-10 text-sm" onClick={() => setDiscarding(false)}>Keep photo</button><button disabled={nativeBusy} className="btn btn-danger min-h-10 text-sm" onClick={discard}>Discard unsaved photo</button></div></div> : <button disabled={nativeBusy} className="btn btn-plain min-h-10 text-sm" onClick={() => setDiscarding(true)}>Discard unsaved photo</button>}</>}
        <MobileControlPanel open={settingsOpen} onOpenChange={setSettingsOpen} disabled={shooting || nativeBusy} label="Camera options & import" title="Capture options">
          {!shooting && <CaptureFeedbackSettings />}
          {remaining > 0 && <label className="panel-muted block p-4 text-sm font-bold">Import {remaining} remaining {remaining === 1 ? "photo" : "photos"}<input className="mt-3 block max-w-full text-sm font-medium file:mr-3 file:min-h-10 file:rounded-full file:border-0 file:bg-card file:px-4 file:font-bold file:text-foreground" type="file" accept="image/png,image/jpeg,image/webp" multiple disabled={shooting || nativeBusy || unsaved} onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ""; if (files.length) { setSettingsOpen(false); void importPhotos(files); } }} /><span className="mt-2 block text-xs font-medium text-muted-foreground">Pick exactly {remaining} {remaining === 1 ? "image" : "images"}, up to 10 MB each.</span></label>}
          {synthetic && remaining > 0 && <button disabled={shooting || nativeBusy || unsaved} className="btn btn-quiet" onClick={() => { setSettingsOpen(false); void importPhotos(rehearsalPhotos!.slice(progress)); }}>Import synthetic photos</button>}
          {!shooting && hint && <p className="text-center text-sm text-muted-foreground">{hint}</p>}
        </MobileControlPanel>
      </div>
    </div>
  </div>;
}
