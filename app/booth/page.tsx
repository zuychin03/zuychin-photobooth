"use client";
import { useAppNavigationGuard } from "@/components/AppNavigation";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { ImagePlus, RefreshCcw } from "lucide-react";
import { CameraPreview } from "@/components/CameraPreview";
import { StoryGuide } from "@/components/StoryGuide";
import ThenNowStudio, { ThenNowGhost } from "@/components/ThenNowStudio";
import type { StoryPlan } from "@/lib/stories/model";
import { CaptureSettings } from "@/components/CaptureSettings";
import { Countdown, CaptureFlash } from "@/components/Countdown";
import { FilterBar } from "@/components/FilterBar";
import { useCamera } from "@/hooks/useCamera";
import { useCuratedAssets } from "@/hooks/useCuratedAssets";
import { captureFrame } from "@/lib/capture";
import { runCaptureSequence } from "@/lib/capture-sequence";
import { getFilter } from "@/lib/filters";
import { LAYOUTS, getLayout } from "@/lib/layouts";
import { playShutter, playTick } from "@/lib/sound";
import { useBoothSession } from "@/lib/session";
import type { ProjectCaptureSettings } from "@/lib/projects/model";
import { templateFromProject } from "@/lib/templates/from-project";

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const SoloMotionStudio = dynamic(() => import("@/components/SoloMotionStudio"), { ssr: false });
type PendingShot = ({ index: number; canvas: HTMLCanvasElement } | { index: number; blob: Blob }) & { projectId: string };

export default function BoothPage() {
  const router = useRouter();
  const { session, project, hydrating, storageError, update, updateCapture, setShot, importShot, startProject, applyTemplate, getDecorationBlobs, flushEditor, editProject, referenceCanvas } = useBoothSession();
  const curated = useCuratedAssets(project?.editor.sceneId ?? null, project?.editor.materialId ?? null);
  const [captureBusy, setBusy] = useState(false), [referenceBusy, setReferenceBusy] = useState(false);
  const busy = captureBusy || referenceBusy;
  const [storyIndex, setStoryIndex] = useState<number | undefined>(undefined);
  const [count, setCount] = useState<number | null>(null);
  const [flash, setFlash] = useState(0);
  const [failure, setFailure] = useState<string | null>(null);
  const [pendingState, setPending] = useState<PendingShot | null>(null);
  const [downloadingPending, setDownloadingPending] = useState(false);
  const [motionProject, setMotionProject] = useState<string | null>(null);
  const motionTrigger = useRef<HTMLButtonElement>(null);
  const pending = pendingState?.projectId === project?.id ? pendingState : null;
  const mounted = useRef(true);
  const cancelled = useRef(false);
  const operation = useRef(false);
  const captureFocus = useRef<{ control: HTMLElement; projectId: string | undefined } | null>(null);
  const starting = useRef(false);
  const startupGeneration = useRef(0);
  const storyAnchor = useRef<HTMLDivElement>(null);
  const storyNavigationHandled = useRef(false);
  const downloadGeneration = useRef(0);
  const capture = project?.capture;
  const { videoRef, attachVideo, ready, error, cameras, retry } = useCamera(!hydrating && project?.mode === "solo", capture?.cameraId ?? null);
  const getMotionVideo = useCallback(() => ready ? videoRef.current : null, [ready, videoRef]);
  const motionKey = project ? `${project.scope.kind === "account" ? project.scope.ownerId : "device"}:${project.id}` : null;
  useAppNavigationGuard(() => {
    if (pending) { setFailure("Download or discard the unsaved photo before leaving this page."); return false; }
    if (operation.current || busy || downloadingPending) { setFailure("Wait for the current photo action to finish before leaving."); return false; }
    if (motionProject && motionProject === motionKey) { setFailure("Close the motion studio before leaving."); return false; }
    return true;
  });
  const layout = getLayout(session.layoutId);
  const filter = getFilter(session.filterId);
  const requiredShots = capture?.requiredShots ?? layout.shots;
  const indices = Array.from({ length: requiredShots }, (_, index) => index);
  const missing = indices.filter(index => !session.shots.A[index]);
  const complete = missing.length === 0;
  const thumbs = useMemo(() => session.shots.A.map(shot => shot?.toDataURL("image/jpeg", 0.6) ?? null), [session.shots.A]);

  useEffect(() => {
    if (hydrating || project?.mode !== "solo" || storyNavigationHandled.current || window.location.hash !== "#photo-story") return;
    storyNavigationHandled.current = true;
    storyAnchor.current?.scrollIntoView({ block: "start" });
    if (document.activeElement === document.body) storyAnchor.current?.focus({ preventScroll: true });
  }, [hydrating, project?.mode]);

  useEffect(() => {
    mounted.current = true;
    cancelled.current = false;
    return () => { mounted.current = false; cancelled.current = true; captureFocus.current = null; };
  }, []);

  useLayoutEffect(() => {
    if (busy) return;
    const target = captureFocus.current;
    captureFocus.current = null;
    if (mounted.current && target?.projectId === project?.id && target?.control.isConnected
      && document.activeElement === document.body && !target.control.matches(":disabled")
      && !target.control.closest("[inert]")) target.control.focus({ preventScroll: true });
  }, [busy, project?.id]);

  useEffect(() => {
    cancelled.current = true;
    downloadGeneration.current++;
    queueMicrotask(() => { setPending(null); setCount(null); setFailure(null); setDownloadingPending(false); });
  }, [project?.id]);

  useEffect(() => {
    if (!pending) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [pending]);

  useEffect(() => {
    if (hydrating) { starting.current = false; startupGeneration.current++; return; }
    if (project?.mode === "solo" || starting.current) return;
    starting.current = true;
    const generation = ++startupGeneration.current;
    void startProject().catch(error => {
      if (mounted.current && generation === startupGeneration.current) setFailure(error instanceof Error ? error.message : "Could not create a draft. Your existing projects are unchanged.");
    }).finally(() => { if (generation === startupGeneration.current) starting.current = false; });
  }, [hydrating, project, startProject]);

  const explain = (error: unknown) => error instanceof Error ? error.message : "Could not save this shot. Keep this page open and try again.";
  const persist = useCallback(async (index: number, canvas: HTMLCanvasElement) => {
    if (!project) throw new Error("Open a draft before capturing");
    setPending({ index, canvas, projectId: project.id });
    await setShot("A", index, canvas);
    if (!cancelled.current) setPending(null);
  }, [project, setShot]);

  const shoot = async (retakeIndex?: number) => {
    if (!capture || !ready || !videoRef.current || operation.current || pending || curated.loading) return;
    if (retakeIndex !== undefined && capture.style !== "flexible") return;
    const targets = retakeIndex === undefined ? missing : [retakeIndex];
    if (!targets.length) return;
    cancelled.current = false;
    operation.current = true;
    setBusy(true);
    setFailure(null);
    const video = videoRef.current;
    try {
      const finished = await runCaptureSequence(targets, capture.timerSeconds, {
        beforeShot: index => setStoryIndex(index),
        cancelled: () => cancelled.current,
        pause,
        countdown: value => { if (!cancelled.current) { setCount(value); if (value !== null) playTick(); } },
        capture: () => {
          if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) throw new Error("The camera is not ready. Try again or import a photo.");
          const shot = captureFrame(video, capture.mirror);
          playShutter(); setFlash(value => value + 1); return shot;
        },
        persist,
        saved: () => {},
      });
      if (finished && capture.style === "classic") router.push("/customize");
    } catch (error) { if (!cancelled.current) setFailure(explain(error)); }
    finally { operation.current = false; if (!cancelled.current) { setBusy(false); setStoryIndex(undefined); } }
  };

  const onUpload = async (files: FileList | null) => {
    if (!capture || !project || !files?.length || operation.current || pending) return;
    const selected = Array.from(files).slice(0, missing.length);
    cancelled.current = false;
    operation.current = true; setBusy(true); setFailure(null);
    try {
      for (let index = 0; index < selected.length; index++) {
        if (cancelled.current) return;
        setPending({ index: missing[index], blob: selected[index], projectId: project.id });
        await importShot("A", missing[index], selected[index]);
        if (!cancelled.current) setPending(null);
      }
      if (!cancelled.current && selected.length === missing.length && capture.style === "classic") router.push("/customize");
    } catch (error) { if (!cancelled.current) setFailure(explain(error)); }
    finally { operation.current = false; if (!cancelled.current) setBusy(false); }
  };

  const retryPending = async () => {
    if (!pending || operation.current) return;
    cancelled.current = false;
    operation.current = true; setBusy(true); setFailure(null);
    try {
      if ("canvas" in pending) await setShot("A", pending.index, pending.canvas);
      else await importShot("A", pending.index, pending.blob);
      if (!cancelled.current) {
        setPending(null);
        if (capture?.style === "classic" && missing.every(index => index === pending.index)) router.push("/customize");
      }
    } catch (error) { if (!cancelled.current) setFailure(explain(error)); }
    finally { operation.current = false; if (!cancelled.current) setBusy(false); }
  };

  const downloadUnsavedPhoto = async () => {
    if (!pending || downloadingPending) return;
    const generation = ++downloadGeneration.current;
    setDownloadingPending(true);
    try {
      const blob = "blob" in pending ? pending.blob : await new Promise<Blob>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Photo download encoding timed out. Your captured photo is still here.")), 10_000);
        try { pending.canvas.toBlob(value => { clearTimeout(timer); if (value) resolve(value); else reject(new Error("Photo download encoding failed. Your captured photo is still here.")); }, "image/png"); }
        catch (error) { clearTimeout(timer); reject(error); }
      });
      if (!mounted.current || generation !== downloadGeneration.current) return;
      const extension = blob.type === "image/jpeg" ? "jpg" : blob.type === "image/png" ? "png" : blob.type === "image/webp" ? "webp" : "bin";
      const url = URL.createObjectURL(blob), link = document.createElement("a");
      link.href = url; link.download = `photobooth-unsaved-photo-${pending.index + 1}.${extension}`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (error) { if (mounted.current && generation === downloadGeneration.current) setFailure(explain(error)); }
    finally { if (mounted.current && generation === downloadGeneration.current) setDownloadingPending(false); }
  };

  const changeCapture = async (patch: Partial<ProjectCaptureSettings>) => {
    if (operation.current) return;
    const control = document.activeElement;
    captureFocus.current = control instanceof HTMLElement && control !== document.body
      ? { control, projectId: project?.id } : null;
    operation.current = true; setBusy(true); setFailure(null);
    try { await updateCapture(patch); } catch (error) { setFailure(explain(error)); }
    finally {
      if (document.activeElement !== document.body) captureFocus.current = null;
      operation.current = false; setBusy(false);
    }
  };
  const changeLayout = async (layoutId: string) => {
    if (operation.current || project?.editor.template) return;
    operation.current = true; setBusy(true); setFailure(null);
    try {
      const editorPatch = { layoutId, ...(getLayout(layoutId).shots !== 4 ? { story: null } : {}) };
      if ((project?.capturedAt || project?.media.some(item => item.kind === "photo"))) await editProject(editorPatch);
      else await updateCapture({ requiredShots: getLayout(layoutId).shots as 3 | 4 }, editorPatch);
    } catch (error) { setFailure(explain(error)); }
    finally { operation.current = false; setBusy(false); }
  };
  const changeStory = async (story: StoryPlan | null) => {
    if (!project || operation.current || (project.capturedAt !== null || project.media.some(item => item.kind === "photo"))) return;
    operation.current = true; setBusy(true); setFailure(null);
    const control = document.activeElement;
    captureFocus.current = control instanceof HTMLElement ? { control, projectId: project.id } : null;
    try {
      await updateCapture(story ? { requiredShots: 4, ...(!project.editor.story ? { timerSeconds: 10 } : {}) } : {}, { story, ...(story && !project.editor.template && layout.shots !== 4 ? { layoutId: "strip4" } : {}) });
    } catch (error) { setFailure(explain(error)); }
    finally { operation.current = false; setBusy(false); }
  };
  const nextRound = async () => {
    if (!capture || operation.current) return;
    operation.current = true; setBusy(true); setFailure(null);
    try {
      const previous = await flushEditor();
      if (!mounted.current || !previous || previous.id !== project?.id) throw new Error("The active project changed before another round could start.");
      const roundCapture = previous.capture;
      const design = previous.editor.template ? templateFromProject(previous) : null;
      const decorations = design ? getDecorationBlobs() : new Map<string, Blob>();
      const nextId = crypto.randomUUID();
      await startProject({ id: nextId, capture: { ...roundCapture }, editor: { layoutId: previous.editor.layoutId, filterId: previous.editor.filterId, story: (design ? Math.max(...Object.values(design.requiredSources)) : getLayout(previous.editor.layoutId).shots) === 4 ? previous.editor.story : null } }, true);
      if (design) {
        if (!mounted.current || (await flushEditor())?.id !== nextId) throw new Error("The active project changed before its template could be restored. Your previous project is still saved.");
        await applyTemplate(design, decorations);
      }
    }
    catch (error) { setFailure(explain(error)); }
    finally { operation.current = false; setBusy(false); }
  };

  return (
    <main className="booth-mode flex min-h-dvh flex-col bg-background md:h-[calc(100dvh-var(--app-nav-height,0px))] md:flex-row md:items-stretch md:justify-center md:overflow-hidden">
      <div className={`relative flex min-h-[42dvh] flex-1 items-center justify-center p-4 pt-16 sm:p-6 sm:pt-16 md:min-h-0 md:max-w-4xl ${capture?.fillLight ? "bg-white" : ""}`}>
        {hydrating || !capture ? <div className="space-y-3 text-center"><p role="status">{failure ?? "Restoring your draft…"}</p>{failure && !hydrating && <button onClick={() => { setFailure(null); void startProject().catch(error => setFailure(explain(error))); }} className="min-h-11 rounded-xl bg-accent px-4 text-accent-foreground">Try creating a draft again</button>}</div> : error ? (
          <div className="flex flex-col items-center justify-center gap-4 px-4 text-center">
            <p className="text-lg font-semibold">{error === "denied" ? "Camera access was blocked" : error === "no-camera" ? "No camera found" : "Couldn't start the camera"}</p>
            <p className="max-w-sm text-sm text-muted-foreground">{error === "denied" ? "Allow camera access in your browser settings, or import photos below." : "Choose another camera or import photos below."}</p>
            <button onClick={retry} disabled={busy} className="glass-card flex min-h-12 items-center gap-2 rounded-2xl px-5 font-semibold"><RefreshCcw size={18} /> Try camera again</button>
          </div>
        ) : (
          <div className="relative w-[min(100%,46dvh*var(--cell-ar))] overflow-hidden rounded-2xl bg-black shadow-2xl shadow-black/40 md:w-[min(100%,74dvh*var(--cell-ar))]" style={{ aspectRatio: layout.cellAspect, "--cell-ar": layout.cellAspect } as React.CSSProperties}>
            <CameraPreview videoRef={attachVideo} mirror={capture.mirror} filterCss={filter.css} />
            {referenceCanvas && project?.editor.thenNow && <ThenNowGhost reference={referenceCanvas} plan={project.editor.thenNow} aspect={layout.cellAspect} />}
            {!ready && <div className="absolute inset-0 flex items-center justify-center text-white">Starting camera…</div>}
            <Countdown value={count} /><CaptureFlash trigger={flash} />
          </div>
        )}
      </div>
      <div className="z-40 flex shrink-0 flex-col gap-4 p-4 pb-6 md:w-96 md:overflow-y-auto md:p-6">
        {(failure || storageError) && <div role="alert" className="rounded-xl border border-destructive p-3 text-sm"><p>{failure ?? storageError}</p>{pending && <><p className="mt-2">This shot is still on this page. Retry saving it or download a separate copy. It is not saved to your project yet.</p><button disabled={busy || downloadingPending} onClick={() => void retryPending()} className="mt-2 min-h-11 rounded-lg bg-foreground px-4 text-background">Retry saving shot</button><button disabled={busy || downloadingPending} onClick={() => void downloadUnsavedPhoto()} className="mt-1 min-h-11 px-3 text-sm underline underline-offset-4">{downloadingPending ? "Preparing download…" : "Download unsaved photo"}</button><button disabled={busy || downloadingPending} onClick={() => { setPending(null); setFailure(null); }} className="mt-1 min-h-11 px-3 text-sm underline underline-offset-4">Discard this unsaved shot</button></>}</div>}
        {capture && <>
          {project?.editor.template ? <p className="text-sm text-muted-foreground">Your saved frame uses {requiredShots} photos. Change its photo slots in the frame designer.</p> : <div className="flex flex-wrap gap-2">
            {LAYOUTS.filter(item => item.mode === "solo").map(item => <button key={item.id} disabled={busy || Boolean(pending) || Boolean((project?.capturedAt || project?.media.some(item => item.kind === "photo")))} onClick={() => void changeLayout(item.id)} className={`min-h-11 rounded-full px-4 text-sm font-medium disabled:opacity-60 ${session.layoutId === item.id ? "bg-foreground text-background" : "bg-muted text-muted-foreground"}`}>{item.name} · {item.shots}</button>)}
          </div>}
          {curated.loading && <p role="status" className="text-sm text-muted-foreground">Loading your selected artwork…</p>}
          {curated.fallback.length > 0 && <p role="status" className="text-sm text-muted-foreground">Using a built-in fallback for {curated.fallback.join(", ")}. Your original photos are saved independently.</p>}
          {project && <div id="photo-story" ref={storyAnchor} tabIndex={-1} aria-label="Photo story" className="scroll-mt-4 rounded-xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"><StoryGuide plan={project.editor.story ?? null} members={project.participants.map(person => ({ id: person.id, name: "You" }))} activeStep={busy ? storyIndex : undefined} disabled={busy || Boolean(pending) || Boolean((project.capturedAt !== null || project.media.some(item => item.kind === "photo"))) || Boolean(project.editor.template && requiredShots !== 4)} onChange={story => void changeStory(story)} /></div>}
          {project?.editor.story && <p className="text-xs leading-relaxed text-muted-foreground">Preview your prompts before starting. The timer applies to each pose.</p>}
          <CaptureSettings value={capture} cameras={cameras} disabled={busy || Boolean(pending)} onChange={patch => void changeCapture(patch)} />
          <FilterBar value={session.filterId} onChange={id => { if (!busy && !pending) void update({ filterId: id }).catch(error => setFailure(explain(error))); }} layoutClass="scrollbar-hide overflow-x-auto md:flex-wrap md:overflow-visible" />
          <p role="status" className="text-sm text-muted-foreground">{requiredShots - missing.length} of {requiredShots} shots saved{busy ? (count ? ". Get ready…" : ". Saving…") : ""}</p>
          <div className="grid grid-cols-4 gap-2">
            {indices.map(index => <div key={index} className="min-w-0">
              {thumbs[index] ? <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={thumbs[index]!} alt={`Saved shot ${index + 1}`} className="aspect-[3/2] w-full rounded-lg object-cover" />
                {capture.style === "flexible" && <button disabled={!ready || busy || Boolean(pending) || curated.loading} onClick={() => void shoot(index)} className="min-h-11 w-full text-sm font-medium underline underline-offset-4 disabled:opacity-40" aria-label={`Retake shot ${index + 1}`}>Retake</button>}
              </> : <div className="flex aspect-[3/2] items-center justify-center rounded-lg border border-dashed border-border text-sm text-muted-foreground">{index + 1}</div>}
            </div>)}
          </div>
          {!complete && <div className="flex items-center justify-center gap-5">
            <button onClick={() => void shoot()} disabled={!ready || busy || Boolean(pending) || curated.loading} aria-label={missing.length === requiredShots ? "Start shooting" : "Capture remaining shots"} className="flex h-20 w-20 shrink-0 items-center justify-center rounded-full border-4 border-foreground/70 bg-accent transition active:scale-95 disabled:opacity-40"><span className="h-14 w-14 rounded-full bg-white/90" /></button>
            <label className={`relative flex min-h-12 cursor-pointer items-center gap-2 rounded-xl border border-border px-4 font-semibold focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring ${busy || pending ? "opacity-40" : ""}`}><ImagePlus size={18} /> Import photos<input type="file" accept="image/jpeg,image/png,image/webp" multiple disabled={busy || Boolean(pending)} className="sr-only" onChange={event => { void onUpload(event.target.files); event.target.value = ""; }} /></label>
          </div>}
          {complete && <><button disabled={busy || Boolean(pending)} onClick={() => router.push("/customize")} className="min-h-12 rounded-xl bg-accent px-5 font-semibold text-accent-foreground">Edit this strip</button><button disabled={busy || Boolean(pending)} onClick={() => void nextRound()} className="min-h-11 text-sm font-medium underline underline-offset-4">Next round with these settings</button></>}
          {!complete && <p className="text-center text-sm text-muted-foreground">Use camera shots, imported photos, or both.</p>}
          <button ref={motionTrigger} type="button" disabled={!ready || busy || Boolean(pending)} onClick={() => setMotionProject(motionKey)} className="min-h-11 rounded-xl border border-border px-4 text-sm font-medium disabled:opacity-40">Record a short solo loop</button>
          {project && <ThenNowStudio key={`${project.scope.kind}:${project.scope.kind === "account" ? project.scope.ownerId : "device"}:${project.id}`} project={project} disabled={captureBusy || Boolean(pending)} onBusyChange={setReferenceBusy} />}
        </>}
      </div>
      {project && capture && motionProject === motionKey && <SoloMotionStudio key={motionKey} getVideo={getMotionVideo} mirror={capture.mirror} filterId={session.filterId} name={project.name} close={() => { setMotionProject(null); requestAnimationFrame(() => motionTrigger.current?.focus({ preventScroll: true })); }} />}
    </main>
  );
}
