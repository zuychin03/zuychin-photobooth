"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Circle, X } from "lucide-react";
import { MotionExportPanel } from "./MotionExportPanel";
import type { MotionCapture } from "@/lib/exports/motion";
import { getFilter } from "@/lib/filters";

const control = "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50";

export default function SoloMotionStudio({ getVideo, mirror, filterId, name, close }: {
  getVideo(): HTMLVideoElement | null; mirror: boolean; filterId: string; name: string; close(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null), livePreview = useRef<HTMLVideoElement>(null);
  const abort = useRef<AbortController | null>(null), alive = useRef(false);
  const [capture, setCapture] = useState<MotionCapture | null>(null), [recording, setRecording] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null), [error, setError] = useState<string | null>(null);
  const getFrames = useCallback(async () => {
    if (!capture) throw new Error("Record a short loop first.");
    return capture.frames;
  }, [capture]);

  useEffect(() => {
    alive.current = true; dialog.current?.showModal();
    return () => { alive.current = false; abort.current?.abort(); };
  }, []);
  useEffect(() => {
    const target = livePreview.current, video = getVideo();
    if (!target || !video || capture) return;
    target.srcObject = video.srcObject;
    void target.play().catch(() => {});
    return () => { target.pause(); target.srcObject = null; };
  }, [getVideo, capture]);
  useEffect(() => {
    if (!capture && !recording) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [capture, recording]);

  const record = async () => {
    if (abort.current) return;
    const video = getVideo();
    if (!video) { setError("The camera is no longer ready. Close the loop studio and try the camera again."); return; }
    const job = new AbortController(); abort.current = job;
    setRecording(true); setCountdown(null); setError(null);
    let timer: ReturnType<typeof setInterval> | undefined;
    try {
      const { captureSoloFrames } = await import("@/lib/exports/motion");
      if (job.signal.aborted || !alive.current) return;
      const started = performance.now(); setCountdown(2);
      timer = setInterval(() => { if (alive.current) setCountdown(Math.max(0, (2000 - (performance.now() - started)) / 1000)); }, 100);
      const result = await captureSoloFrames(video, { mirror, filterId, signal: job.signal });
      if (alive.current && !job.signal.aborted) setCapture(result);
    } catch (failure) {
      if (alive.current) setError(job.signal.aborted ? "Recording cancelled. Your still photos are unchanged." : failure instanceof Error ? failure.message : "The loop could not be captured. You can still take photos.");
    } finally { clearInterval(timer); if (abort.current === job) abort.current = null; if (alive.current) setRecording(false); }
  };
  return <dialog ref={dialog} aria-labelledby="solo-motion-title" onCancel={event => { event.preventDefault(); close(); }} className="m-auto max-h-[92dvh] w-[calc(100%_-_2rem)] max-w-xl overflow-y-auto rounded-2xl border border-border bg-card p-0 text-foreground shadow-2xl backdrop:bg-black/60">
    <header className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-border bg-card p-5"><div><h2 id="solo-motion-title" className="font-display text-3xl">A moment in motion</h2><p className="mt-2 text-sm text-muted-foreground">A two-second loop using your mirror and filter.</p></div><button type="button" onClick={close} aria-label="Close motion studio" className={`${control} w-11 shrink-0 px-0`}><X size={20} /></button></header>
    <div className="space-y-5 p-5">
      <p className="text-sm text-muted-foreground">Silent and temporary. Download before closing; your saved photos are unaffected.</p>
      {!capture && <div className="relative overflow-hidden rounded-xl bg-black"><video ref={livePreview} muted playsInline aria-label="Solo motion camera preview" className="max-h-[40dvh] w-full object-contain" style={{ transform: mirror ? "scaleX(-1)" : undefined, filter: getFilter(filterId).css }} />{recording && <p role="status" className="absolute right-3 bottom-3 rounded-lg bg-black/80 px-3 py-2 text-sm text-white">{countdown === null ? "Preparing loop…" : `Recording · ${countdown.toFixed(1)} s left`}</p>}</div>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {capture ? <><p className="text-sm">{capture.frameCount} frames captured · {capture.width} × {capture.height} pixels</p><MotionExportPanel getFrames={getFrames} name={name} delayMs={Math.max(1000 / 12, Math.min(2000, capture.elapsedMs / capture.frameCount))} warnings={capture.warnings} /><button type="button" onClick={() => { setCapture(null); setError(null); }} className={`${control} border border-border`}>Discard loop and record again</button></> : <div className="flex gap-2"><button type="button" disabled={recording} onClick={() => void record()} className={`${control} flex-1 bg-accent text-accent-foreground`}><Circle size={16} fill="currentColor" />{recording ? "Recording…" : "Record 2-second loop"}</button>{recording && <button type="button" onClick={() => abort.current?.abort()} className={`${control} border border-border`}>Cancel recording</button>}</div>}
    </div>
  </dialog>;
}
