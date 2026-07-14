"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ImagePlus, RefreshCcw, SwitchCamera } from "lucide-react";
import { CameraPreview } from "@/components/CameraPreview";
import { Countdown, CaptureFlash } from "@/components/Countdown";
import { FilterBar } from "@/components/FilterBar";
import { useCamera } from "@/hooks/useCamera";
import { captureFrame, fileToCanvas } from "@/lib/capture";
import { getFilter } from "@/lib/filters";
import { LAYOUTS, getLayout } from "@/lib/layouts";
import { playShutter, playTick } from "@/lib/sound";
import { useBoothSession } from "@/lib/session";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Phase = "setup" | "shooting" | "done";

export default function BoothPage() {
  const router = useRouter();
  const { session, update, setShot, reset } = useBoothSession();
  const [phase, setPhase] = useState<Phase>("setup");
  const [count, setCount] = useState<number | null>(null);
  const [flash, setFlash] = useState(0);
  const [thumbs, setThumbs] = useState<string[]>([]);
  const cancelled = useRef(false);

  const { videoRef, attachVideo, ready, error, facing, canFlip, toggleFacing, retry } =
    useCamera(true);

  const layout = getLayout(session.layoutId);
  const filter = getFilter(session.filterId);
  const soloLayouts = LAYOUTS.filter((l) => l.mode === "solo");
  const mirror = facing === "user";
  // The preview box matches the strip cell's aspect so object-cover shows the
  // exact center-crop that compose will put on the strip.
  const cellAspect = layout.cellAspect;

  useEffect(() => {
    // entering the solo booth always starts a fresh session
    reset();
    return () => {
      cancelled.current = true;
    };
  }, [reset]);

  const runSequence = useCallback(async () => {
    if (!videoRef.current) return;
    cancelled.current = false;
    setPhase("shooting");
    setThumbs([]);
    const video = videoRef.current;

    for (let i = 0; i < layout.shots; i++) {
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
      setShot("A", i, shot);
      setThumbs((t) => [...t, shot.toDataURL("image/jpeg", 0.6)]);
      await sleep(i === layout.shots - 1 ? 700 : 900);
    }
    if (cancelled.current) return;
    setPhase("done");
    router.push("/customize");
  }, [layout.shots, mirror, router, setShot, videoRef]);

  const onUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const list = Array.from(files).slice(0, layout.shots);
    for (let i = 0; i < list.length; i++) {
      setShot("A", i, await fileToCanvas(list[i]));
    }
    router.push("/customize");
  };

  return (
    <main className="booth-mode flex h-dvh flex-col overflow-hidden bg-background md:flex-row md:items-stretch md:justify-center">
      {/* Camera stage: width-capped so the controls stay beside the camera
          instead of being pushed to the far edge of ultrawide screens. */}
      <div className="relative flex min-h-0 flex-1 items-center justify-center p-4 pt-16 sm:p-6 sm:pt-16 md:max-w-4xl">
        <button
          onClick={() => {
            cancelled.current = true;
            router.push("/");
          }}
          aria-label="Back"
          className="glass-card absolute top-4 left-4 z-40 flex h-11 w-11 items-center justify-center rounded-full"
        >
          <ArrowLeft size={20} />
        </button>

        {error ? (
          <div className="flex flex-col items-center justify-center gap-4 px-8 text-center">
            <p className="text-lg font-semibold">
              {error === "denied"
                ? "Camera access was blocked"
                : error === "no-camera"
                  ? "No camera found"
                  : "Couldn't start the camera"}
            </p>
            <p className="max-w-sm text-sm text-muted-foreground">
              {error === "denied"
                ? "Allow camera access in your browser settings, or build a strip from photos you already have."
                : "You can still build a strip from photos you already have."}
            </p>
            <div className="flex gap-3">
              <button
                onClick={retry}
                className="glass-card flex min-h-12 items-center gap-2 rounded-2xl px-5 font-semibold"
              >
                <RefreshCcw size={18} /> Try again
              </button>
              <label className="flex min-h-12 cursor-pointer items-center gap-2 rounded-2xl bg-accent px-5 font-semibold text-accent-foreground">
                <ImagePlus size={18} /> Upload photos
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  onChange={(e) => onUpload(e.target.files)}
                />
              </label>
            </div>
          </div>
        ) : (
          /* Sized by width and capped by the height budget while keeping the
             cell's exact ratio, so the feed never swallows the viewport. */
          <div
            className="relative w-[min(100%,54dvh*var(--cell-ar))] overflow-hidden rounded-2xl bg-black shadow-2xl shadow-black/40 md:w-[min(100%,74dvh*var(--cell-ar))]"
            style={
              {
                aspectRatio: cellAspect,
                "--cell-ar": cellAspect,
              } as React.CSSProperties
            }
          >
            <CameraPreview videoRef={attachVideo} mirror={mirror} filterCss={filter.css} />
            {!ready && (
              <div className="absolute inset-0 flex items-center justify-center text-muted-foreground">
                Starting camera…
              </div>
            )}
            <Countdown value={count} />
            <CaptureFlash trigger={flash} />
            {canFlip && phase === "setup" && (
              <button
                onClick={toggleFacing}
                aria-label="Switch camera"
                className="glass-card absolute top-3 right-3 z-40 flex h-11 w-11 items-center justify-center rounded-full"
              >
                <SwitchCamera size={20} />
              </button>
            )}
            {/* Shot progress */}
            {phase === "shooting" && (
              <div className="absolute top-3 left-1/2 z-20 flex -translate-x-1/2 gap-2">
                {Array.from({ length: layout.shots }, (_, i) => (
                  <div
                    key={i}
                    className={`h-2 w-6 rounded-full transition ${
                      i < thumbs.length ? "bg-accent" : "bg-white/25"
                    }`}
                  />
                ))}
              </div>
            )}
            {/* Captured thumbnails */}
            {thumbs.length > 0 && (
              <div className="absolute top-3 right-3 z-20 flex flex-col gap-2">
                {thumbs.map((src, i) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={i}
                    src={src}
                    alt={`Shot ${i + 1}`}
                    className="w-14 rounded-md border border-white/20 shadow-lg"
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Controls */}
      {!error && (
        <div className="z-40 flex shrink-0 flex-col gap-3 overflow-y-auto p-4 pb-6 md:w-96 md:justify-center md:gap-5 md:p-6">
          {phase === "setup" && (
            <>
              <div className="scrollbar-hide flex gap-2 overflow-x-auto md:flex-wrap md:overflow-visible">
                {soloLayouts.map((l) => (
                  <button
                    key={l.id}
                    onClick={() => update({ layoutId: l.id })}
                    className={`min-h-11 shrink-0 rounded-full px-4 text-sm font-medium transition ${
                      session.layoutId === l.id
                        ? "bg-foreground text-background"
                        : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {l.name} · {l.shots} shots
                  </button>
                ))}
              </div>
              <FilterBar
                value={session.filterId}
                onChange={(id) => update({ filterId: id })}
                layoutClass="scrollbar-hide overflow-x-auto md:flex-wrap md:overflow-visible"
              />
              <button
                onClick={runSequence}
                disabled={!ready}
                aria-label="Start shooting"
                className="mx-auto mt-1 flex h-20 w-20 shrink-0 items-center justify-center rounded-full border-4 border-white/80 bg-accent shadow-lg shadow-accent/40 transition active:scale-95 disabled:opacity-40"
              >
                <span className="h-14 w-14 rounded-full bg-white/90" />
              </button>
            </>
          )}
          {phase === "shooting" && (
            <p className="text-center text-sm text-muted-foreground">
              {layout.shots} shots, no retakes. That&apos;s the booth way.
            </p>
          )}
        </div>
      )}
    </main>
  );
}
