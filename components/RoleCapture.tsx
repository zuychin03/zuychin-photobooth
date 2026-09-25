"use client";

import { useAppNavigationGuard } from "@/components/AppNavigation";

import { useEffect, useRef, useState } from "react";
import { RelayOriginalRecovery } from "./RelayOriginalRecovery";
import { CaptureFeedbackSettings } from "./CaptureFeedbackSettings";
import { SwitchCamera } from "lucide-react";
import { CameraPreview } from "@/components/CameraPreview";
import { Countdown, CaptureFlash } from "@/components/Countdown";
import { useCamera } from "@/hooks/useCamera";
import { captureFrame } from "@/lib/capture";
import { getFilter } from "@/lib/filters";
import { importRelayPhotos, relayFrameOriginal, relayOriginalEncoder } from "@/lib/relay-recovery";
import { playShutter, playTick } from "@/lib/sound";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const control = "min-h-11 rounded-xl border border-border px-4 py-2 text-sm disabled:opacity-40";
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
    if (unsaved || shooting) { setCaptureError("Finish capturing and save your originals before leaving."); return false; }
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
    catch (failure) { if (active()) setCaptureError(failure instanceof Error ? failure.message : "Your photo is retained. Retry saving or keep a local copy."); }
    finally { running.current = false; if (active()) { setCount(null); setShooting(false); } }
  };
  const run = () => perform(async () => {
    await ensureFrames();
    while (checkpointed.current < shots) {
      const index = checkpointed.current;
      if (!frames.current[index]) {
        const video = videoRef.current;
        if (!video || !ready) throw new Error("Retry the camera or import the remaining photos.");
        for (let c = 3; c >= 1; c--) { if (!active()) return; setCount(c); playTick(); await sleep(1000); }
        setCount(null); if (!active()) return;
        if (video.videoWidth > 4096 || video.videoHeight > 4096 || video.videoWidth * video.videoHeight > 12 * 1024 * 1024) throw new Error("This camera resolution exceeds the photo limit. Import smaller originals instead.");
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
    if (files.length !== remaining || remaining < 1) throw new Error(`Choose exactly ${remaining} remaining ${remaining === 1 ? "photo" : "photos"}.`);
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
    {!error && <div className="relative min-h-48 flex-1 overflow-hidden"><CameraPreview videoRef={attachVideo} mirror={facing === "user"} filterCss={getFilter(filterId).css} />{!ready && <p className="absolute inset-0 flex items-center justify-center">Starting camera…</p>}<Countdown value={count} /><CaptureFlash trigger={flash} />{canFlip && !shooting && <button onClick={toggleFacing} aria-label="Switch camera" className="glass-card absolute top-4 right-4 flex h-11 w-11 items-center justify-center rounded-full"><SwitchCamera size={20} /></button>}</div>}
    <div className="flex flex-col items-center gap-3 p-4 pb-6">
      {error && <><p>Camera unavailable. Retry access or import your photos.</p><button disabled={shooting || nativeBusy} onClick={retry} className={control}>Try camera again</button></>}
      <p role="status" className="text-center text-sm">{progress} of {shots} originals saved on this device.{shooting ? " Saving each photo before continuing…" : ""}</p>
      {captureError && <p role="alert" className="max-w-sm text-center text-sm text-destructive">{captureError}</p>}
      {nativeBusy && !shooting && <p role="status" className="max-w-sm text-sm">The image encoder is still finishing. Your photo is retained; retry becomes available when it settles.</p>}
      {shownOriginals.length > 0 && <RelayOriginalRecovery originals={shownOriginals} saved={!unsaved} />}
      {captureError && <button disabled={shooting || nativeBusy} className={control} onClick={() => void run()}>{unsaved && shownOriginals.length === progress ? "Retry preparation and continue" : "Retry saving and continue"}</button>}
      {unsaved && !shooting && <><p className="max-w-sm text-sm">{unsaved && shownOriginals.length === progress ? "The current photo is still on this page. Retry preparation to create its original download; previously saved photos remain in My projects." : "The current photo and its original download are available on this page. Retry saving; previously saved photos remain in My projects."}</p>{discarding ? <div role="alertdialog" aria-label="Discard unsaved relay photo"><p>Discard only the unsaved photo? Previously saved originals remain.</p><button autoFocus disabled={nativeBusy} className={control} onClick={() => setDiscarding(false)}>Keep photo</button><button disabled={nativeBusy} className={control} onClick={discard}>Discard unsaved photo</button></div> : <button disabled={nativeBusy} className={control} onClick={() => setDiscarding(true)}>Discard unsaved photo</button>}</>}
      {!shooting && <CaptureFeedbackSettings />}
      {remaining > 0 && <label className={control}>Import {remaining} remaining {remaining === 1 ? "photo" : "photos"}<input className="mt-2 block max-w-full text-sm" type="file" accept="image/png,image/jpeg,image/webp" multiple disabled={shooting || nativeBusy || unsaved} onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ""; if (files.length) void importPhotos(files); }} /><span className="mt-1 block text-xs">Choose exactly {remaining} {remaining === 1 ? "image" : "images"}, up to 10 MiB each. Originals stay unchanged.</span></label>}
      {synthetic && remaining > 0 && <button disabled={shooting || nativeBusy || unsaved} className={control} onClick={() => void importPhotos(rehearsalPhotos!.slice(progress))}>Import synthetic photos</button>}
      {!shooting && hint && <p className="text-center text-sm text-muted-foreground">{hint}</p>}
      {!shooting && !captureError && <button disabled={nativeBusy || (remaining > 0 && (!ready || unsaved))} onClick={() => void run()} className="min-h-13 rounded-full bg-accent px-6 py-3 font-semibold text-accent-foreground disabled:opacity-40">{remaining === 0 ? "Continue with saved originals" : progress ? "Continue shooting" : "Start shooting"}</button>}
    </div>
  </div>;
}
