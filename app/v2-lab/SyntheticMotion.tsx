"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import SoloMotionStudio from "@/components/SoloMotionStudio";

export function SyntheticMotion() {
  const canvas = useRef<HTMLCanvasElement>(null), video = useRef<HTMLVideoElement>(null);
  const [running, setRunning] = useState(false), [ready, setReady] = useState(false), [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const getVideo = useCallback(() => video.current, []);
  useEffect(() => {
    const image = canvas.current, target = video.current;
    if (!running || !image || !target) return;
    const context = image.getContext("2d");
    if (!context || !image.captureStream) { queueMicrotask(() => setError("Synthetic video capture is unavailable.")); return; }
    let live = true, frame = 0;
    const paint = () => { context.fillStyle = ["#f43f5e", "#0d9488", "#fbbf24", "#4f46e5"][frame++ % 4]; context.fillRect(0, 0, image.width, image.height); context.fillStyle = "#ffffff"; context.font = "bold 44px sans-serif"; context.fillText(`Synthetic frame ${frame}`, 70, 180); };
    paint();
    const stream = image.captureStream(12), timer = setInterval(paint, 250);
    target.srcObject = stream;
    void target.play().then(() => { if (live) setReady(true); }, () => { if (live) setError("Synthetic video playback failed."); });
    return () => { live = false; clearInterval(timer); target.pause(); target.srcObject = null; stream.getTracks().forEach(track => track.stop()); };
  }, [running]);
  return <section aria-label="Synthetic motion interface" className="space-y-4 border-b border-border py-7">
    <h2 className="text-lg font-semibold">P4 solo motion interface</h2>
    <p className="text-sm text-muted-foreground">This changing colour fixture exercises the normal recording and export dialog with a canvas stream. It requests no camera or microphone permission.</p>
    <canvas ref={canvas} width={640} height={360} className="hidden" />
    <video ref={video} muted playsInline aria-label="Synthetic camera feed" className={running ? "max-h-48 rounded-xl" : "hidden"} />
    {error && <p role="alert">{error}</p>}
    <div className="flex flex-wrap gap-3"><button type="button" onClick={() => { setOpen(false); setReady(false); setError(null); setRunning(value => !value); }} className="min-h-11 rounded-lg border border-border px-4 text-sm">{running ? "Stop synthetic camera" : "Start synthetic camera"}</button>{running && <button type="button" disabled={!ready} onClick={() => setOpen(true)} className="min-h-11 rounded-lg bg-accent px-4 text-sm text-accent-foreground disabled:opacity-50">Open synthetic motion studio</button>}</div>
    {open && <SoloMotionStudio getVideo={getVideo} mirror={false} filterId="none" name="synthetic-solo-motion" close={() => setOpen(false)} />}
  </section>;
}
