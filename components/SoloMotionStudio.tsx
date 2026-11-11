"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Circle, X } from "lucide-react";
import { MotionExportPanel } from "./MotionExportPanel";
import type { MotionCapture } from "@/lib/exports/motion";
import { getFilter } from "@/lib/filters";

const control = "btn text-sm";

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
    if (!video) { setError("The camera stopped. Close this window and start the camera again."); return; }
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
      if (alive.current) setError(job.signal.aborted ? "Recording cancelled." : failure instanceof Error ? failure.message : "Couldn't record the loop. You can still take photos.");
    } finally { clearInterval(timer); if (abort.current === job) abort.current = null; if (alive.current) setRecording(false); }
  };
  return <dialog ref={dialog} aria-labelledby="solo-motion-title" onCancel={event => { event.preventDefault(); close(); }} className="glass-strong m-auto max-h-[92dvh] w-[calc(100%_-_2rem)] max-w-xl overflow-y-auto overscroll-contain rounded-[1.75rem] border-0 p-5 text-foreground sm:p-6">
    <header className="flex items-center justify-between gap-4"><h2 id="solo-motion-title" className="font-display text-2xl sm:text-3xl">Record a loop</h2><button type="button" onClick={close} aria-label="Close loop recorder" className={`${control} btn-quiet w-11 shrink-0 px-0`}><X size={20} aria-hidden /></button></header>
    <div className="mt-4 space-y-5">
      <p className="notice">Loops aren&apos;t saved to your project, so download yours before closing.</p>
      {!capture && <div className="relative overflow-hidden rounded-[1.25rem] bg-black"><video ref={livePreview} muted playsInline aria-label="Camera preview" className="max-h-[40dvh] w-full object-contain" style={{ transform: mirror ? "scaleX(-1)" : undefined, filter: getFilter(filterId).css }} />{recording && <p role="status" className="glass absolute right-3 bottom-3 rounded-full px-3.5 py-1.5 text-sm font-bold text-white tabular-nums">{countdown === null ? "Getting ready…" : `Recording · ${countdown.toFixed(1)} s left`}</p>}</div>}
      {error && <p role="alert" className="text-sm font-bold text-destructive">{error}</p>}
      {capture ? <><p className="text-sm font-bold tabular-nums">{capture.frameCount} frames captured · {capture.width} × {capture.height} pixels</p><MotionExportPanel getFrames={getFrames} name={name} delayMs={Math.max(1000 / 12, Math.min(2000, capture.elapsedMs / capture.frameCount))} warnings={capture.warnings} /><button type="button" onClick={() => { setCapture(null); setError(null); }} className={`${control} btn-quiet`}>Record again</button></> : <div className="flex gap-2"><button type="button" disabled={recording} onClick={() => void record()} className={`${control} btn-primary flex-1`}><Circle size={16} fill="currentColor" aria-hidden />{recording ? "Recording…" : "Record 2-second loop"}</button>{recording && <button type="button" onClick={() => abort.current?.abort()} className={`${control} btn-quiet`}>Cancel</button>}</div>}
    </div>
  </dialog>;
}
