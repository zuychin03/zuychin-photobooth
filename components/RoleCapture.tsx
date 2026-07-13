"use client";

import { useCallback, useRef, useState } from "react";
import { SwitchCamera } from "lucide-react";
import { CameraPreview } from "@/components/CameraPreview";
import { Countdown, CaptureFlash } from "@/components/Countdown";
import { useCamera } from "@/hooks/useCamera";
import { captureFrame } from "@/lib/capture";
import { getFilter } from "@/lib/filters";
import { playShutter, playTick } from "@/lib/sound";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs a countdown-driven N-shot capture and returns the frames. */
export function RoleCapture({
  shots,
  filterId,
  onDone,
  hint,
}: {
  shots: number;
  filterId: string;
  onDone: (frames: HTMLCanvasElement[]) => void;
  hint?: string;
}) {
  const { videoRef, attachVideo, ready, error, facing, canFlip, toggleFacing, retry } =
    useCamera(true);
  const [count, setCount] = useState<number | null>(null);
  const [flash, setFlash] = useState(0);
  const [progress, setProgress] = useState(0);
  const [shooting, setShooting] = useState(false);
  const cancelled = useRef(false);
  const filter = getFilter(filterId);
  const mirror = facing === "user";

  const run = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;
    cancelled.current = false;
    setShooting(true);
    setProgress(0);
    const frames: HTMLCanvasElement[] = [];
    for (let i = 0; i < shots; i++) {
      for (let c = 3; c >= 1; c--) {
        if (cancelled.current) return;
        setCount(c);
        playTick();
        await sleep(1000);
      }
      setCount(null);
      if (cancelled.current) return;
      const shot = captureFrame(video, mirror);
      playShutter();
      setFlash((f) => f + 1);
      frames.push(shot);
      setProgress(i + 1);
      await sleep(i === shots - 1 ? 500 : 800);
    }
    onDone(frames);
  }, [videoRef, mirror, shots, onDone]);

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-sm text-muted-foreground">
        <p>Camera unavailable. Allow access to shoot your part.</p>
        <button onClick={retry} className="glass-card min-h-11 rounded-full px-4 font-medium text-foreground">
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="relative flex h-full flex-col">
      <div className="relative flex-1 overflow-hidden">
        <CameraPreview videoRef={attachVideo} mirror={mirror} filterCss={filter.css} />
        {!ready && (
          <div className="absolute inset-0 flex items-center justify-center text-muted-foreground">
            Starting camera…
          </div>
        )}
        <Countdown value={count} />
        <CaptureFlash trigger={flash} />
        {canFlip && !shooting && (
          <button
            onClick={toggleFacing}
            aria-label="Switch camera"
            className="glass-card absolute top-4 right-4 flex h-11 w-11 items-center justify-center rounded-full"
          >
            <SwitchCamera size={20} />
          </button>
        )}
        {shooting && (
          <div className="absolute top-4 left-1/2 z-20 flex -translate-x-1/2 gap-2">
            {Array.from({ length: shots }, (_, i) => (
              <div
                key={i}
                className={`h-2 w-6 rounded-full transition ${
                  i < progress ? "bg-accent" : "bg-white/25"
                }`}
              />
            ))}
          </div>
        )}
      </div>
      <div className="flex flex-col items-center gap-3 p-4 pb-6">
        {!shooting && hint && (
          <p className="text-center text-sm text-muted-foreground">{hint}</p>
        )}
        {!shooting && (
          <button
            onClick={run}
            disabled={!ready}
            aria-label="Start shooting"
            className="flex h-20 w-20 items-center justify-center rounded-full border-4 border-white/80 bg-accent shadow-lg shadow-accent/40 transition active:scale-95 disabled:opacity-40"
          >
            <span className="h-14 w-14 rounded-full bg-white/90" />
          </button>
        )}
        {shooting && (
          <p className="text-center text-sm text-muted-foreground">
            {shots} shots, hold your poses
          </p>
        )}
      </div>
    </div>
  );
}
