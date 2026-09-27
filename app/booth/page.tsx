"use client";
import { useAppNavigationGuard } from "@/components/AppNavigation";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { ImagePlus, RefreshCcw } from "lucide-react";
import { MobileControlPanel } from "@/components/MobileControlPanel";
import { CameraPreview } from "@/components/CameraPreview";
import { StoryGuide } from "@/components/StoryGuide";
import ThenNowStudio, { ThenNowGhost } from "@/components/ThenNowStudio";
import { storyStep, type StoryPlan } from "@/lib/stories/model";
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
  const [retakeSelection, setRetakeSelection] = useState<{ projectId: string; indices: number[] } | null>(null);
  const [controlsOpen, setControlsOpen] = useState(false);
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
  const savedPhotosHeading = useRef<HTMLParagraphElement>(null);
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
    if (pending) { setFailure("A photo hasn't saved yet. Download it or discard it before you leave."); return false; }
    if (operation.current || busy || downloadingPending) { setFailure("Hang on a second, the booth is still busy."); return false; }
    if (motionProject && motionProject === motionKey) { setFailure("Close the loop recorder before you leave."); return false; }
    return true;
  });
  const layout = getLayout(session.layoutId);
  const filter = getFilter(session.filterId);
  const requiredShots = capture?.requiredShots ?? layout.shots;
  const indices = Array.from({ length: requiredShots }, (_, index) => index);
  const missing = indices.filter(index => !session.shots.A[index]);
  const complete = missing.length === 0;
  const retakeTargets = indices.filter(index => retakeSelection?.projectId === project?.id && retakeSelection?.indices.includes(index) && session.shots.A[index]);
  const clearRetake = (index: number) => setRetakeSelection(value => value && value.projectId === project?.id ? { ...value, indices: value.indices.filter(item => item !== index) } : value);
  const focusSavedPhotos = () => requestAnimationFrame(() => savedPhotosHeading.current?.focus({ preventScroll: true }));
  const activePose = project?.editor.story && storyIndex !== undefined ? storyStep(project.editor.story, storyIndex, project.participants.map(person => person.id)) : null;
  const thumbs = useMemo(() => session.shots.A.map(shot => shot?.toDataURL("image/jpeg", 0.6) ?? null), [session.shots.A]);

  useEffect(() => {
    if (hydrating || project?.mode !== "solo" || storyNavigationHandled.current || window.location.hash !== "#photo-story") return;
    storyNavigationHandled.current = true;
    if (window.matchMedia("(max-width: 767px)").matches) {
      queueMicrotask(() => setControlsOpen(true));
      return;
    }
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
      if (mounted.current && generation === startupGeneration.current) setFailure(error instanceof Error ? error.message : "Couldn't start a new project. Your other projects are still there.");
    }).finally(() => { if (generation === startupGeneration.current) starting.current = false; });
  }, [hydrating, project, startProject]);

  const explain = (error: unknown) => error instanceof Error ? error.message : "Couldn't save that shot. Keep this page open and try again.";
  const persist = useCallback(async (index: number, canvas: HTMLCanvasElement) => {
    if (!project) throw new Error("Open a project before taking photos.");
    setPending({ index, canvas, projectId: project.id });
    await setShot("A", index, canvas);
    if (!cancelled.current) setPending(null);
  }, [project, setShot]);

  const shoot = async (selectedRetakes?: readonly number[]) => {
    if (!capture || !ready || !videoRef.current || operation.current || pending || curated.loading) return;
    const targets = selectedRetakes === undefined ? missing : indices.filter(index => selectedRetakes.includes(index) && session.shots.A[index]);
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
          if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) throw new Error("The camera isn't ready yet. Try again, or import a photo.");
          const shot = captureFrame(video, capture.mirror);
          playShutter(); setFlash(value => value + 1); return shot;
        },
        persist,
        saved: index => clearRetake(index),
      });
      if (finished && selectedRetakes === undefined && capture.style === "classic") router.push("/customize");
      if (finished && selectedRetakes !== undefined) focusSavedPhotos();
    } catch (error) { if (!cancelled.current) setFailure(explain(error)); }
    finally { operation.current = false; if (!cancelled.current) { setBusy(false); setStoryIndex(undefined); } }
  };

  const onUpload = async (files: FileList | null, retake = false) => {
    if (!capture || !project || !files?.length || operation.current || pending) return;
    const targets = retake ? retakeTargets : missing;
    if (!targets.length) return;
    if (retake && files.length !== targets.length) {
      setFailure(`Choose exactly ${targets.length} ${targets.length === 1 ? "photo" : "photos"} to replace the selected shots.`);
      return;
    }
    const selected = Array.from(files).slice(0, targets.length);
    cancelled.current = false;
    operation.current = true; setBusy(true); setFailure(null);
    try {
      for (let index = 0; index < selected.length; index++) {
        if (cancelled.current) return;
        setPending({ index: targets[index], blob: selected[index], projectId: project.id });
        await importShot("A", targets[index], selected[index]);
        if (!cancelled.current) { setPending(null); clearRetake(targets[index]); }
      }
      if (!cancelled.current && !retake && selected.length === missing.length && capture.style === "classic") router.push("/customize");
      if (!cancelled.current && retake) focusSavedPhotos();
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
        clearRetake(pending.index);
        if (retakeTargets.includes(pending.index)) focusSavedPhotos();
        if (missing.length > 0 && capture?.style === "classic" && missing.every(index => index === pending.index)) router.push("/customize");
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
        const timer = setTimeout(() => reject(new Error("The download took too long. Your photo is still here.")), 10_000);
        try { pending.canvas.toBlob(value => { clearTimeout(timer); if (value) resolve(value); else reject(new Error("Couldn't get the download ready. Your photo is still here.")); }, "image/png"); }
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
      if (!mounted.current || !previous || previous.id !== project?.id) throw new Error("You switched projects before the next round could start.");
      const roundCapture = previous.capture;
      const design = previous.editor.template ? templateFromProject(previous) : null;
      const decorations = design ? getDecorationBlobs() : new Map<string, Blob>();
      const nextId = crypto.randomUUID();
      await startProject({ id: nextId, capture: { ...roundCapture }, editor: { layoutId: previous.editor.layoutId, filterId: previous.editor.filterId, story: (design ? Math.max(...Object.values(design.requiredSources)) : getLayout(previous.editor.layoutId).shots) === 4 ? previous.editor.story : null } }, true);
      if (design) {
        if (!mounted.current || (await flushEditor())?.id !== nextId) throw new Error("You switched projects before the template could be added. Your last project is still saved.");
        await applyTemplate(design, decorations);
      }
    }
    catch (error) { setFailure(explain(error)); }
    finally { operation.current = false; setBusy(false); }
  };

  return (
    <main className="booth-mode flex min-h-[calc(100dvh-var(--app-nav-height,0px)-var(--app-bottom-nav-height,0px))] flex-col bg-background md:h-[calc(100dvh-var(--app-nav-height,0px))] md:flex-row md:items-stretch md:justify-center md:overflow-hidden">
      <div className={`relative flex shrink-0 items-center justify-center px-4 pt-3 pb-2 md:flex-1 md:p-6 md:min-h-0 md:max-w-4xl ${capture?.fillLight ? "bg-white" : ""}`}>
        {hydrating || !capture ? <div className="space-y-3 text-center"><p role="status">{failure ?? "Opening your project…"}</p>{failure && !hydrating && <button onClick={() => { setFailure(null); void startProject().catch(error => setFailure(explain(error))); }} className="min-h-11 rounded-xl bg-accent px-4 text-accent-foreground">Try again</button>}</div> : error ? (
          <div className="flex flex-col items-center justify-center gap-4 px-4 text-center">
            <p className="text-lg font-semibold">{error === "denied" ? "Camera access was blocked" : error === "no-camera" ? "No camera found" : "Couldn't start the camera"}</p>
            <p className="max-w-sm text-sm text-muted-foreground">{error === "denied" ? "Allow camera access in your browser settings, or import photos below." : "Choose another camera or import photos below."}</p>
            <button onClick={retry} disabled={busy} className="glass-card flex min-h-12 items-center gap-2 rounded-2xl px-5 font-semibold"><RefreshCcw size={18} /> Try camera again</button>
          </div>
        ) : (
          <div className="relative w-[min(100%,max(24dvh,calc(100dvh_-_23rem))*var(--cell-ar))] overflow-hidden rounded-2xl bg-black shadow-2xl shadow-black/40 md:w-[min(100%,74dvh*var(--cell-ar))]" style={{ aspectRatio: layout.cellAspect, "--cell-ar": layout.cellAspect } as React.CSSProperties}>
            <CameraPreview videoRef={attachVideo} mirror={capture.mirror} filterCss={filter.css} />
            {referenceCanvas && project?.editor.thenNow && <ThenNowGhost reference={referenceCanvas} plan={project.editor.thenNow} aspect={layout.cellAspect} />}
            {!ready && <div className="absolute inset-0 flex items-center justify-center text-white">Starting camera…</div>}
            <Countdown value={count} /><CaptureFlash trigger={flash} />
            {activePose && <p aria-live="polite" className="absolute inset-x-2 bottom-2 rounded-lg bg-black/80 px-3 py-2 text-center text-sm text-white md:hidden">{activePose.prompt}</p>}
          </div>
        )}
      </div>
      <div className="z-40 flex shrink-0 flex-col gap-3 px-4 pt-2 pb-4 md:w-96 md:overflow-y-auto md:p-6">
        {(failure || storageError) && <div role="alert" className="rounded-xl border border-destructive p-3 text-sm"><p>{failure ?? storageError}</p>{pending && <><p className="mt-2">This shot hasn&apos;t saved to your project yet. Try saving it again, or download a copy.</p><button disabled={busy || downloadingPending} onClick={() => void retryPending()} className="mt-2 min-h-11 rounded-lg bg-foreground px-4 text-background">Try saving again</button><button disabled={busy || downloadingPending} onClick={() => void downloadUnsavedPhoto()} className="mt-1 min-h-11 px-3 text-sm underline underline-offset-4">{downloadingPending ? "Getting the download ready…" : "Download this photo"}</button><button disabled={busy || downloadingPending} onClick={() => { setPending(null); setFailure(null); }} className="mt-1 min-h-11 px-3 text-sm underline underline-offset-4">Discard it</button></>}</div>}
        {capture && <>
          <p role="status" className="text-sm text-muted-foreground">{requiredShots - missing.length} of {requiredShots} shots saved{busy ? (count ? ". Get ready…" : ". Saving…") : ""}</p>
          {!complete && retakeTargets.length === 0 && <div className="flex items-center justify-center gap-5">
            <button onClick={() => void shoot()} disabled={!ready || busy || Boolean(pending) || curated.loading} aria-label={missing.length === requiredShots ? "Start shooting" : "Take the remaining shots"} className="flex h-20 w-20 shrink-0 items-center justify-center rounded-full border-4 border-foreground/70 bg-accent transition active:scale-95 disabled:opacity-40"><span className="h-14 w-14 rounded-full bg-white/90" /></button>
            <label className={`relative flex min-h-12 cursor-pointer items-center gap-2 rounded-xl border border-border px-4 font-semibold focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring ${busy || pending ? "opacity-40" : ""}`}><ImagePlus size={18} /> Import photos<input type="file" accept="image/jpeg,image/png,image/webp" multiple disabled={busy || Boolean(pending)} className="sr-only" onChange={event => { void onUpload(event.target.files); event.target.value = ""; }} /></label>
          </div>}
          {retakeTargets.length > 0 && <div className="space-y-2">
            <button disabled={!ready || busy || Boolean(pending) || curated.loading} onClick={() => void shoot(retakeTargets)} className="min-h-12 w-full rounded-xl bg-accent px-4 font-semibold text-accent-foreground disabled:opacity-40">Retake {retakeTargets.length} selected {retakeTargets.length === 1 ? "photo" : "photos"}</button>
            <label className="flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-xl border border-border px-3 text-sm focus-within:outline-2 focus-within:outline-ring"><ImagePlus size={18} /> Replace selected with imports<input type="file" accept="image/jpeg,image/png,image/webp" multiple disabled={busy || Boolean(pending)} className="sr-only" onChange={event => { void onUpload(event.target.files, true); event.target.value = ""; }} /></label>
            <p className="text-xs text-muted-foreground">Selected shots: {retakeTargets.map(index => index + 1).join(", ")}. Imports replace them in this order. Other photos and your design stay as they are.</p>
            <button disabled={busy || Boolean(pending)} onClick={() => { setRetakeSelection(null); focusSavedPhotos(); }} className="min-h-11 w-full text-sm underline underline-offset-4">Cancel selection</button>
          </div>}
          {complete && retakeTargets.length === 0 && <><button disabled={busy || Boolean(pending)} onClick={() => router.push("/customize")} className="min-h-12 rounded-xl bg-accent px-5 font-semibold text-accent-foreground">Edit this strip</button><button disabled={busy || Boolean(pending)} onClick={() => void nextRound()} className="min-h-11 text-sm font-medium underline underline-offset-4">Go again with the same settings</button></>}
          {thumbs.some(Boolean) && <p ref={savedPhotosHeading} tabIndex={-1} aria-label="Saved photos" className="rounded text-sm text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring">Select any saved photos to retake. Only selected shots will change.</p>}
          <div className="grid grid-cols-4 gap-2">
            {indices.map(index => <div key={index} className="min-w-0">
              {thumbs[index] ? <button type="button" disabled={busy || Boolean(pending)} aria-pressed={retakeTargets.includes(index)} aria-label={`Select shot ${index + 1} to retake`} onClick={() => setRetakeSelection({ projectId: project!.id, indices: retakeTargets.includes(index) ? retakeTargets.filter(item => item !== index) : [...retakeTargets, index] })} className={`w-full overflow-hidden rounded-lg border-2 text-sm disabled:opacity-40 ${retakeTargets.includes(index) ? "border-accent bg-accent text-accent-foreground" : "border-transparent bg-muted"}`}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={thumbs[index]!} alt={`Saved shot ${index + 1}`} className="aspect-[3/2] w-full object-cover" />
                <span className="flex min-h-11 items-center justify-center">{retakeTargets.includes(index) ? "Selected" : `Shot ${index + 1}`}</span>
              </button> : <div className="flex aspect-[3/2] items-center justify-center rounded-lg border border-dashed border-border text-sm text-muted-foreground">{index + 1}</div>}
            </div>)}
          </div>
          {!complete && <p className="text-center text-sm text-muted-foreground">You can mix camera shots and imported photos.</p>}
          <MobileControlPanel open={controlsOpen} onOpenChange={setControlsOpen} disabled={busy || Boolean(pending)}>
          {(failure || storageError) && <p role="alert" className="text-sm text-destructive md:hidden">{failure ?? storageError}</p>}
          {project?.editor.template ? <p className="text-sm text-muted-foreground">Your template takes {requiredShots} photos. You can change that in the frame designer.</p> : <div className="flex flex-wrap gap-2">
            {LAYOUTS.filter(item => item.mode === "solo").map(item => <button key={item.id} disabled={busy || Boolean(pending) || Boolean((project?.capturedAt || project?.media.some(item => item.kind === "photo")))} onClick={() => void changeLayout(item.id)} className={`min-h-11 rounded-full px-4 text-sm font-medium disabled:opacity-60 ${session.layoutId === item.id ? "bg-foreground text-background" : "bg-muted text-muted-foreground"}`}>{item.name} · {item.shots}</button>)}
          </div>}
          {curated.loading && <p role="status" className="text-sm text-muted-foreground">Loading artwork…</p>}
          {curated.fallback.length > 0 && <p role="status" className="text-sm text-muted-foreground">Couldn&apos;t load {curated.fallback.join(", ")}, so a built-in background is filling in.</p>}
          {project && <div id="photo-story" ref={storyAnchor} tabIndex={-1} aria-label="Photo story" className="scroll-mt-4 rounded-xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"><StoryGuide plan={project.editor.story ?? null} members={project.participants.map(person => ({ id: person.id, name: "You" }))} activeStep={busy ? storyIndex : undefined} disabled={busy || Boolean(pending) || Boolean((project.capturedAt !== null || project.media.some(item => item.kind === "photo"))) || Boolean(project.editor.template && requiredShots !== 4)} onChange={story => void changeStory(story)} /></div>}
          {project?.editor.story && <p className="text-xs leading-relaxed text-muted-foreground">Flip through the prompts before you start. The timer runs before each pose.</p>}
          <CaptureSettings value={capture} cameras={cameras} disabled={busy || Boolean(pending)} onChange={patch => void changeCapture(patch)} />
          <FilterBar value={session.filterId} onChange={id => { if (!busy && !pending) void update({ filterId: id }).catch(error => setFailure(explain(error))); }} layoutClass="scrollbar-hide overflow-x-auto md:flex-wrap md:overflow-visible" />
          {project && <ThenNowStudio key={`${project.scope.kind}:${project.scope.kind === "account" ? project.scope.ownerId : "device"}:${project.id}`} project={project} disabled={captureBusy || Boolean(pending)} onBusyChange={setReferenceBusy} />}
          </MobileControlPanel>
          <button ref={motionTrigger} type="button" disabled={!ready || busy || Boolean(pending)} onClick={() => setMotionProject(motionKey)} className="min-h-11 rounded-xl border border-border px-4 text-sm font-medium disabled:opacity-40">Record a short loop</button>

        </>}
      </div>
      {project && capture && motionProject === motionKey && <SoloMotionStudio key={motionKey} getVideo={getMotionVideo} mirror={capture.mirror} filterId={session.filterId} name={project.name} close={() => { setMotionProject(null); requestAnimationFrame(() => motionTrigger.current?.focus({ preventScroll: true })); }} />}
    </main>
  );
}
