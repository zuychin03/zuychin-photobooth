"use client";

import { HelpTooltip } from "@/components/HelpTooltip";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, Download, ImagePlus, RotateCw } from "lucide-react";
import { Dropdown } from "./Dropdown";
import { MotionExportPanel } from "./MotionExportPanel";
import { settingRow, switchTrack } from "./CaptureFeedbackSettings";
import { useBoothSession } from "@/lib/session";
import type { PhotoProject } from "@/lib/projects/model";
import { openProjectRepository, type ProjectListItem } from "@/lib/projects/storage";
import { getLayout } from "@/lib/layouts";
import { downloadProjectBlob, projectDownloadName } from "@/lib/projects/download";
import { createExportCanvas, encodeExportCanvas, ExportJob, releaseExportCanvas } from "@/lib/exports/still";
import { DEFAULT_THEN_NOW_ALIGNMENT, drawThenNowAlternatingFrame, drawThenNowComparison, drawThenNowGhost, thenNowDateFromInstant, thenNowDateLabel, thenNowOutputSize, validateThenNowPlan, type ThenNowPlan } from "@/lib/memories/then-and-now";

const button = "btn btn-quiet text-sm";
type SavedSource = { projectId: string; mediaId: string; label: string; date: string | null };
const makePlan = (date: string | null, strip: boolean): ThenNowPlan => ({ version: 1, reference: { mediaId: "pending-reference", provenance: { kind: strip ? "imported-strip" : "imported-image" }, date, crop: strip ? { x: 0, y: 0, width: 1, height: 1 } : null }, alignment: { ...DEFAULT_THEN_NOW_ALIGNMENT }, ghostOpacity: .35 });

function ReferenceSlider({ label, value, min, max, step = .05, disabled, onCommit }: { label: string; value: number; min: number; max: number; step?: number; disabled: boolean; onCommit(value: number): void }) {
  const [draft, setDraft] = useState({ base: value, next: value });
  const displayed = draft.base === value ? draft.next : value;
  const commit = (next: number) => { if (next !== value) onCommit(next); };
  return <label className="block text-sm font-bold">{label}<span className="float-right font-medium tabular-nums text-muted-foreground">{displayed.toFixed(2)}</span><input type="range" min={min} max={max} step={step} value={displayed} disabled={disabled} onChange={event => setDraft({ base: value, next: Number(event.target.value) })} onPointerUp={event => commit(Number(event.currentTarget.value))} onKeyUp={event => { if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) commit(Number(event.currentTarget.value)); }} onBlur={event => commit(Number(event.currentTarget.value))} className="mt-1 min-h-11 w-full accent-accent" /></label>;
}

export function ThenNowGhost({ reference, plan, aspect }: { reference: HTMLCanvasElement; plan: ThenNowPlan; aspect: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    canvas.width = Math.min(640, Math.round(640 * aspect)); canvas.height = Math.min(640, Math.round(640 / aspect));
    const ctx = canvas.getContext("2d");
    if (ctx) { ctx.clearRect(0, 0, canvas.width, canvas.height); drawThenNowGhost(ctx, reference, plan, { x: 0, y: 0, width: canvas.width, height: canvas.height }); }
    return () => { canvas.width = canvas.height = 0; };
  }, [reference, plan, aspect]);
  return <canvas ref={ref} aria-hidden className="pointer-events-none absolute inset-0 h-full w-full" />;
}

export default function ThenNowStudio({ project, disabled = false, onBusyChange }: { project: PhotoProject; disabled?: boolean; onBusyChange?(busy: boolean): void }) {
  const { session, referenceCanvas, attachReference, copyReference, editProject } = useBoothSession();
  const plan = project.editor.thenNow;
  const [strip, setStrip] = useState(Boolean(plan?.reference.provenance.kind.endsWith("strip"))), [date, setDate] = useState(plan?.reference.date ?? "");
  const [sources, setSources] = useState<SavedSource[] | null>(null), [sourceKey, setSourceKey] = useState("");
  const [savedProjects, setSavedProjects] = useState<ProjectListItem[] | null>(null), [savedProjectKey, setSavedProjectKey] = useState("");
  const [selected, setSelected] = useState("0"), [working, setWorking] = useState(false), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const [motionBusy, setMotionBusy] = useState(false), motionOperation = useRef(false);
  const preview = useRef<HTMLCanvasElement>(null), sourcePreview = useRef<HTMLCanvasElement>(null);
  const mounted = useRef(true), operation = useRef(false), controller = useRef<AbortController | null>(null);
  const actionFocus = useRef<HTMLElement | null>(null);
  const busyCallback = useRef(onBusyChange);
  useEffect(() => { busyCallback.current = onBusyChange; }, [onBusyChange]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; controller.current?.abort(); busyCallback.current?.(false); }; }, []);
  const photos = session.shots.A.map((canvas, index) => ({ canvas, index })).filter(item => item.canvas);
  const current = photos.find(item => String(item.index) === selected)?.canvas ?? photos[0]?.canvas ?? null;
  const currentDate = thenNowDateFromInstant(project.capturedAt, project.captureTimeZone);
  const aspect = getLayout(project.editor.layoutId).cellAspect;
  const blocked = disabled || working || motionBusy;
  const motionBusyChange = useCallback((busy: boolean) => {
    motionOperation.current = busy;
    if (mounted.current) { setMotionBusy(busy); busyCallback.current?.(busy || operation.current); }
  }, []);
  const wholeStrip = plan?.reference.provenance.kind.endsWith("strip") && plan.reference.crop?.x === 0 && plan.reference.crop.y === 0 && plan.reference.crop.width === 1 && plan.reference.crop.height === 1;
  useLayoutEffect(() => {
    if (blocked) return;
    const control = actionFocus.current; actionFocus.current = null;
    if (control?.isConnected && document.activeElement === document.body && !control.matches(":disabled")) control.focus({ preventScroll: true });
  }, [blocked]);

  useEffect(() => {
    const canvas = preview.current, full = sourcePreview.current;
    if (!canvas || !referenceCanvas || !plan) return;
    const size = thenNowOutputSize(960, aspect, "comparison");
    canvas.width = current ? size.width : 640; canvas.height = current ? size.height : Math.round(640 / aspect);
    const ctx = canvas.getContext("2d");
    if (ctx) {
      if (current) drawThenNowComparison(ctx, referenceCanvas, current, plan, { ...size, currentDate });
      else drawThenNowGhost(ctx, referenceCanvas, { ...plan, ghostOpacity: 1 }, { x: 0, y: 0, width: canvas.width, height: canvas.height });
    }
    if (full) {
      full.width = 320; full.height = 240;
      const context = full.getContext("2d");
      if (context) {
        const scale = Math.min(320 / referenceCanvas.width, 240 / referenceCanvas.height), width = referenceCanvas.width * scale, height = referenceCanvas.height * scale, x = (320 - width) / 2, y = (240 - height) / 2;
        context.fillStyle = "#211c1c"; context.fillRect(0, 0, 320, 240); context.drawImage(referenceCanvas, x, y, width, height);
        if (plan.reference.crop) { const crop = plan.reference.crop; context.strokeStyle = "#ff7397"; context.lineWidth = 2; context.strokeRect(x + crop.x * width, y + crop.y * height, crop.width * width, crop.height * height); }
      }
    }
    return () => { canvas.width = canvas.height = 0; if (full) full.width = full.height = 0; };
  }, [referenceCanvas, plan, current, currentDate, aspect]);

  const run = async (action: (signal: AbortSignal) => Promise<void>) => {
    if (operation.current || motionOperation.current || disabled) return;
    actionFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const abort = new AbortController(); controller.current = abort; operation.current = true;
    setWorking(true); setError(null); setNotice(null); busyCallback.current?.(true);
    try { await action(abort.signal); }
    catch (failure) { if (mounted.current && !abort.signal.aborted) setError(failure instanceof Error ? failure.message : "Couldn't save that. Try again."); }
    finally { operation.current = false; if (controller.current === abort) controller.current = null; if (mounted.current) { setWorking(false); busyCallback.current?.(motionOperation.current); } }
  };
  const change = (next: ThenNowPlan) => void run(async () => { await editProject({ thenNow: validateThenNowPlan(next) }, undefined, project); });
  const listSources = () => void run(async signal => {
    const repo = await openProjectRepository(project.scope);
    try {
      const items = (await repo.list()).filter(item => !item.readOnly && item.id !== project.id);
      if (mounted.current && !signal.aborted) { setSavedProjects(items); setSavedProjectKey(items[0]?.id ?? ""); setSources(null); }
    } finally { repo.close(); }
  });
  const loadSources = () => void run(async signal => {
    const repo = await openProjectRepository(project.scope);
    try {
      const loaded = await repo.load(savedProjectKey), found: SavedSource[] = [];
      if (loaded?.kind === "current") {
        const used = new Set(Object.values(loaded.project.sourceOrder).flat().filter(Boolean));
        for (const media of loaded.project.media.filter(media => media.kind === "photo" && used.has(media.id))) found.push({ projectId: loaded.project.id, mediaId: media.id, label: `Photo ${found.length + 1}`, date: thenNowDateFromInstant(loaded.project.capturedAt, loaded.project.captureTimeZone) });
      }
      if (mounted.current && !signal.aborted) { setSources(found); setSourceKey(found[0] ? `${found[0].projectId}/${found[0].mediaId}` : ""); }
    } finally { repo.close(); }
  });
  const frames = useCallback(async (signal: AbortSignal) => {
    if (!referenceCanvas || !plan || !current) throw new Error("Add an old photo and take a new one first.");
    const size = thenNowOutputSize(640, aspect, "alternating"), canvas = createExportCanvas(size.width, size.height), job = new ExportJob({ signal }), result: Blob[] = [];
    try {
      for (const phase of ["then", "now"] as const) {
        job.check(); const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("Your browser couldn't draw the image.");
        drawThenNowAlternatingFrame(ctx, referenceCanvas, current, plan, phase, { ...size, currentDate });
        result.push(await encodeExportCanvas(canvas, "png", 1, job));
      }
      return result;
    } finally { releaseExportCanvas(canvas); }
  }, [referenceCanvas, plan, current, currentDate, aspect]);

  return <details id="then-now" className="group panel p-4 sm:p-5" open={Boolean(plan)}>
    <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 font-display text-[1.0625rem] [&::-webkit-details-marker]:hidden">Then & now<ChevronDown size={18} aria-hidden className="shrink-0 text-muted-foreground transition-transform duration-300 group-open:rotate-180 motion-reduce:transition-none" /></summary>
    <section aria-label="Then and now" className="mt-2 space-y-4">
      <p className="text-sm leading-relaxed text-muted-foreground">Line up a new photo with an old favourite. <HelpTooltip label="About the photo guide">A faint copy of the old photo shows over the camera to help you match the pose. It isn&apos;t saved in the new photo.</HelpTooltip></p>
      {error && <p role="alert" className="text-sm font-bold text-destructive">{error}</p>}
      {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
      <label className="block text-sm font-bold">Date of the old photo (optional)<input type="date" aria-label="Date of the old photo" value={date} disabled={blocked} onChange={event => setDate(event.target.value)} className="field mt-1.5 font-medium" /></label>
      <div>
        <span className="mb-1.5 block text-sm font-bold">What are you importing?</span>
        <div role="group" aria-label="What are you importing?" className="segmented w-full">
          <button type="button" aria-pressed={!strip} disabled={blocked} onClick={() => setStrip(false)} className="flex-1 disabled:opacity-50">Single photo</button>
          <button type="button" aria-pressed={strip} disabled={blocked} onClick={() => setStrip(true)} className="flex-1 disabled:opacity-50">Photo strip</button>
        </div>
      </div>
      <label className={`${button} relative w-full cursor-pointer focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring`}><ImagePlus size={17} aria-hidden /><span>{plan ? "Import a different old photo" : "Import an old photo"}</span><input type="file" aria-label="Import an old photo" className="sr-only" accept="image/jpeg,image/png,image/webp" disabled={blocked} onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void run(async () => { await attachReference(file, makePlan(date || null, strip)); }); }} /></label>
      <button type="button" className={`${button} w-full`} disabled={blocked} onClick={listSources}>Pick from my saved photos</button>
      {savedProjects && (savedProjects.length ? <div className="space-y-3"><Dropdown showLabel label="Project" value={savedProjectKey} onChange={value => { setSavedProjectKey(value); setSources(null); }} disabled={blocked} options={savedProjects.map(item => ({ value: item.id, label: item.name }))} /><button type="button" className={button} disabled={blocked || !savedProjectKey} onClick={loadSources}>Show its photos</button></div> : <p role="status" className="text-sm text-muted-foreground">You don&apos;t have any other projects saved here.</p>)}
      {sources && (sources.length ? <div className="space-y-3"><Dropdown label="Photo" value={sourceKey} onChange={setSourceKey} disabled={blocked} options={sources.map(source => ({ value: `${source.projectId}/${source.mediaId}`, label: source.label }))} /><button type="button" disabled={blocked || !sourceKey} className={button} onClick={() => void run(async () => { const source = sources.find(item => `${item.projectId}/${item.mediaId}` === sourceKey); if (!source) throw new Error("Pick a photo first."); await copyReference(source.projectId, source.mediaId, makePlan(source.date, false)); if (mounted.current) setDate(source.date ?? ""); })}>Use this photo</button></div> : <p role="status" className="text-sm text-muted-foreground">That project has no photos to use. Import one instead.</p>)}
      {plan && referenceCanvas && <>
        <figure className="space-y-2"><canvas ref={sourcePreview} role="img" aria-label="The old photo, with the selected area outlined" className="w-full rounded-2xl" /><figcaption className="text-xs text-muted-foreground">{wholeStrip ? "Use the crop sliders to pick one photo from the strip." : plan.reference.provenance.kind.endsWith("strip") ? "Your crop from the strip." : "Your old photo."}</figcaption></figure>
        <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm">Date of the old photo: {thenNowDateLabel(plan.reference.date)}</p><button type="button" className={`${button} min-h-10`} disabled={blocked || date === (plan.reference.date ?? "")} onClick={() => change({ ...plan, reference: { ...plan.reference, date: date || null } })}>Save date</button></div>
        {plan.reference.crop && <fieldset className="border-t border-border pt-4"><legend className="float-left w-full pb-3 text-sm font-bold">Crop the strip</legend><div className="clear-both space-y-3">{(["x", "y", "width", "height"] as const).map(field => <ReferenceSlider key={field} label={{ x: "Left edge", y: "Top edge", width: "Width", height: "Height" }[field]} min={field === "width" || field === "height" ? .02 : 0} max={field === "x" ? 1 - plan.reference.crop!.width : field === "y" ? 1 - plan.reference.crop!.height : field === "width" ? 1 - plan.reference.crop!.x : 1 - plan.reference.crop!.y} step={.01} value={plan.reference.crop![field]} disabled={blocked} onCommit={value => change({ ...plan, reference: { ...plan.reference, crop: { ...plan.reference.crop!, [field]: value } } })} />)}</div></fieldset>}
        <fieldset className="border-t border-border pt-4"><legend className="float-left w-full pb-3 text-sm font-bold">Line up the old photo</legend><div className="clear-both space-y-3">{([{ key: "zoom", label: "Zoom", min: 1, max: 4 }, { key: "offsetX", label: "Move left or right", min: -1, max: 1 }, { key: "offsetY", label: "Move up or down", min: -1, max: 1 }] as const).map(field => <ReferenceSlider key={field.key} label={field.label} min={field.min} max={field.max} value={plan.alignment[field.key]} disabled={blocked} onCommit={value => change({ ...plan, alignment: { ...plan.alignment, [field.key]: value } })} />)}
          <ReferenceSlider label="Guide opacity" min={0} max={1} value={plan.ghostOpacity} disabled={blocked} onCommit={value => change({ ...plan, ghostOpacity: value })} />
          <label className={settingRow}><span>Mirror the old photo</span><input type="checkbox" checked={plan.alignment.mirror} disabled={blocked} onChange={event => change({ ...plan, alignment: { ...plan.alignment, mirror: event.target.checked } })} className="peer sr-only" /><span aria-hidden className={switchTrack} /></label>
          <button type="button" className={`${button} w-full`} disabled={blocked} onClick={() => change({ ...plan, alignment: { ...plan.alignment, rotation: ((plan.alignment.rotation + 90) % 360) as 0 | 90 | 180 | 270 } })}><RotateCw size={16} aria-hidden />Rotate the old photo</button>
        </div></fieldset>
        {photos.length > 0 && <div className="border-t border-border pt-4"><Dropdown showLabel label="New photo to compare" value={String(photos.find(item => String(item.index) === selected)?.index ?? photos[0].index)} onChange={setSelected} disabled={blocked} options={photos.map(item => ({ value: String(item.index), label: `Photo ${item.index + 1}` }))} /></div>}
        <canvas ref={preview} role="img" aria-label={current ? "Then and now comparison" : "Preview of the lined-up old photo"} className="w-full rounded-2xl" />
        {current ? <><button type="button" className={`${button} w-full`} disabled={blocked} onClick={() => void run(async signal => {
          const size = thenNowOutputSize(1536, aspect, "comparison"), canvas = createExportCanvas(size.width, size.height), job = new ExportJob({ signal });
          try { const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("Your browser couldn't draw the image."); drawThenNowComparison(ctx, referenceCanvas, current, plan, { ...size, currentDate }); const blob = await encodeExportCanvas(canvas, "png", 1, job); job.check(); if (mounted.current) { downloadProjectBlob(blob, projectDownloadName(`${project.name}-then-and-now`, "png")); setNotice("Downloading now. Check your downloads folder."); } }
          finally { releaseExportCanvas(canvas); }
        })}><Download size={16} aria-hidden />Download the comparison</button><MotionExportPanel getFrames={frames} name={`${project.name}-then-and-now`} delayMs={1500} disabled={disabled || working} onBusyChange={motionBusyChange} /></> : <p className="text-sm text-muted-foreground">Take or import a new photo to compare.</p>}
        <button type="button" disabled={blocked} className="btn btn-danger w-full text-sm" onClick={() => void run(async () => { await editProject({ thenNow: null }, undefined, project); })}>Remove the old photo</button>
      </>}
    </section>
  </details>;
}
