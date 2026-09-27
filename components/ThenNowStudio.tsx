"use client";

import { HelpTooltip } from "@/components/HelpTooltip";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Dropdown } from "./Dropdown";
import { MotionExportPanel } from "./MotionExportPanel";
import { useBoothSession } from "@/lib/session";
import type { PhotoProject } from "@/lib/projects/model";
import { openProjectRepository, type ProjectListItem } from "@/lib/projects/storage";
import { getLayout } from "@/lib/layouts";
import { downloadProjectBlob, projectDownloadName } from "@/lib/projects/download";
import { createExportCanvas, encodeExportCanvas, ExportJob, releaseExportCanvas } from "@/lib/exports/still";
import { DEFAULT_THEN_NOW_ALIGNMENT, drawThenNowAlternatingFrame, drawThenNowComparison, drawThenNowGhost, thenNowDateFromInstant, thenNowDateLabel, thenNowOutputSize, validateThenNowPlan, type ThenNowPlan } from "@/lib/memories/then-and-now";

const button = "min-h-11 rounded-xl border border-border px-4 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-40";
type SavedSource = { projectId: string; mediaId: string; label: string; date: string | null };
const makePlan = (date: string | null, strip: boolean): ThenNowPlan => ({ version: 1, reference: { mediaId: "pending-reference", provenance: { kind: strip ? "imported-strip" : "imported-image" }, date, crop: strip ? { x: 0, y: 0, width: 1, height: 1 } : null }, alignment: { ...DEFAULT_THEN_NOW_ALIGNMENT }, ghostOpacity: .35 });

function ReferenceSlider({ label, value, min, max, step = .05, disabled, onCommit }: { label: string; value: number; min: number; max: number; step?: number; disabled: boolean; onCommit(value: number): void }) {
  const [draft, setDraft] = useState({ base: value, next: value });
  const displayed = draft.base === value ? draft.next : value;
  const commit = (next: number) => { if (next !== value) onCommit(next); };
  return <label className="block text-sm">{label}<span className="float-right tabular-nums text-muted-foreground">{displayed.toFixed(2)}</span><input type="range" min={min} max={max} step={step} value={displayed} disabled={disabled} onChange={event => setDraft({ base: value, next: Number(event.target.value) })} onPointerUp={event => commit(Number(event.currentTarget.value))} onKeyUp={event => { if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) commit(Number(event.currentTarget.value)); }} onBlur={event => commit(Number(event.currentTarget.value))} className="mt-1 min-h-11 w-full accent-accent" /></label>;
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

  return <details id="then-now" className="rounded-xl border border-border p-4" open={Boolean(plan)}>
    <summary className="min-h-11 cursor-pointer content-center font-semibold">Then & now</summary>
    <section aria-label="Then and now" className="mt-3 space-y-4">
      <p className="text-sm leading-relaxed text-muted-foreground">Line up a new photo with an old favourite. <HelpTooltip label="About the photo guide">A faint copy of the old photo sits over the camera so you can match the pose. It won&apos;t show up in your new photo.</HelpTooltip></p>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
      <label className="block text-sm">Date of the old photo (optional)<input type="date" aria-label="Date of the old photo" value={date} disabled={blocked} onChange={event => setDate(event.target.value)} className="mt-2 min-h-11 w-full rounded-xl border border-border bg-background px-3" /></label>
      <p className="text-xs text-muted-foreground">Not sure? Leave it blank and it&apos;ll show as an unknown date.</p>
      <Dropdown showLabel label="What are you importing?" value={strip ? "strip" : "image"} onChange={value => setStrip(value === "strip")} disabled={blocked} options={[{ value: "image", label: "A single photo" }, { value: "strip", label: "A whole photo strip" }]} />
      <p className="text-xs text-muted-foreground">This applies to the next photo you import.</p>
      <label className={`${button} relative flex cursor-pointer items-center justify-center focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring`}><span>{plan ? "Import a different old photo" : "Import an old photo"}</span><input type="file" aria-label="Import an old photo" className="sr-only" accept="image/jpeg,image/png,image/webp" disabled={blocked} onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void run(async () => { await attachReference(file, makePlan(date || null, strip)); }); }} /></label>
      <button type="button" className={`${button} w-full`} disabled={blocked} onClick={listSources}>Pick from my saved photos</button>
      {savedProjects && (savedProjects.length ? <div className="space-y-3"><Dropdown showLabel label="Project" value={savedProjectKey} onChange={value => { setSavedProjectKey(value); setSources(null); }} disabled={blocked} options={savedProjects.map(item => ({ value: item.id, label: item.name }))} /><button type="button" className={button} disabled={blocked || !savedProjectKey} onClick={loadSources}>Show its photos</button></div> : <p role="status" className="text-sm text-muted-foreground">You don&apos;t have any other projects saved here.</p>)}
      {sources && (sources.length ? <div className="space-y-3"><Dropdown label="Photo" value={sourceKey} onChange={setSourceKey} disabled={blocked} options={sources.map(source => ({ value: `${source.projectId}/${source.mediaId}`, label: source.label }))} /><button type="button" disabled={blocked || !sourceKey} className={button} onClick={() => void run(async () => { const source = sources.find(item => `${item.projectId}/${item.mediaId}` === sourceKey); if (!source) throw new Error("Pick a photo first."); await copyReference(source.projectId, source.mediaId, makePlan(source.date, false)); if (mounted.current) setDate(source.date ?? ""); })}>Use this photo</button></div> : <p role="status" className="text-sm text-muted-foreground">That project has no photos to use. Import one instead.</p>)}
      {plan && referenceCanvas && <>
        <figure className="space-y-2"><canvas ref={sourcePreview} role="img" aria-label="The old photo, with the selected area outlined" className="w-full rounded-lg" /><figcaption className="text-xs text-muted-foreground">{wholeStrip ? "The whole strip is selected. Use the crop sliders below to pick one photo from it." : plan.reference.provenance.kind.endsWith("strip") ? "Your crop from the photo strip." : "The full old photo. Adjusting it here won't change the file."}</figcaption></figure>
        <p className="text-sm">Date of the old photo: {thenNowDateLabel(plan.reference.date)}</p>
        <button type="button" className={button} disabled={blocked || date === (plan.reference.date ?? "")} onClick={() => change({ ...plan, reference: { ...plan.reference, date: date || null } })}>Save date</button>
        {plan.reference.crop && <fieldset className="space-y-3"><legend className="text-sm font-medium">Crop the strip</legend>{(["x", "y", "width", "height"] as const).map(field => <ReferenceSlider key={field} label={{ x: "Left edge", y: "Top edge", width: "Width", height: "Height" }[field]} min={field === "width" || field === "height" ? .02 : 0} max={field === "x" ? 1 - plan.reference.crop!.width : field === "y" ? 1 - plan.reference.crop!.height : field === "width" ? 1 - plan.reference.crop!.x : 1 - plan.reference.crop!.y} step={.01} value={plan.reference.crop![field]} disabled={blocked} onCommit={value => change({ ...plan, reference: { ...plan.reference, crop: { ...plan.reference.crop!, [field]: value } } })} />)}</fieldset>}
        <fieldset className="space-y-3"><legend className="text-sm font-medium">Line up the old photo</legend>{([{ key: "zoom", label: "Zoom", min: 1, max: 4 }, { key: "offsetX", label: "Move left or right", min: -1, max: 1 }, { key: "offsetY", label: "Move up or down", min: -1, max: 1 }] as const).map(field => <ReferenceSlider key={field.key} label={field.label} min={field.min} max={field.max} value={plan.alignment[field.key]} disabled={blocked} onCommit={value => change({ ...plan, alignment: { ...plan.alignment, [field.key]: value } })} />)}
          <ReferenceSlider label="Guide opacity" min={0} max={1} value={plan.ghostOpacity} disabled={blocked} onCommit={value => change({ ...plan, ghostOpacity: value })} />
          <label className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" checked={plan.alignment.mirror} disabled={blocked} onChange={event => change({ ...plan, alignment: { ...plan.alignment, mirror: event.target.checked } })} className="h-5 w-5 accent-accent" />Mirror the old photo</label>
          <button type="button" className={button} disabled={blocked} onClick={() => change({ ...plan, alignment: { ...plan.alignment, rotation: ((plan.alignment.rotation + 90) % 360) as 0 | 90 | 180 | 270 } })}>Rotate the old photo</button>
        </fieldset>
        {photos.length > 0 && <><Dropdown showLabel label="New photo to compare" value={String(photos.find(item => String(item.index) === selected)?.index ?? photos[0].index)} onChange={setSelected} disabled={blocked} options={photos.map(item => ({ value: String(item.index), label: `Photo ${item.index + 1}` }))} /><HelpTooltip label="About the new photo">Only used for this export. Next time you open the booth, it goes back to the first photo.</HelpTooltip></>}
        <canvas ref={preview} role="img" aria-label={current ? "Then and now comparison" : "Preview of the lined-up old photo"} className="w-full rounded-lg" />
        {current ? <><button type="button" className={`${button} w-full`} disabled={blocked} onClick={() => void run(async signal => {
          const size = thenNowOutputSize(1536, aspect, "comparison"), canvas = createExportCanvas(size.width, size.height), job = new ExportJob({ signal });
          try { const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("Your browser couldn't draw the image."); drawThenNowComparison(ctx, referenceCanvas, current, plan, { ...size, currentDate }); const blob = await encodeExportCanvas(canvas, "png", 1, job); job.check(); if (mounted.current) { downloadProjectBlob(blob, projectDownloadName(`${project.name}-then-and-now`, "png")); setNotice("Downloading now. Check your downloads folder."); } }
          finally { releaseExportCanvas(canvas); }
        })}>Download the comparison</button><MotionExportPanel getFrames={frames} name={`${project.name}-then-and-now`} delayMs={1500} disabled={disabled || working} onBusyChange={motionBusyChange} /></> : <p className="text-sm text-muted-foreground">Take or import a new photo to get a side-by-side comparison and a then-and-now animation.</p>}
        <button type="button" disabled={blocked} className={`${button} w-full`} onClick={() => void run(async () => { await editProject({ thenNow: null }, undefined, project); })}>Remove the old photo</button>
        <p className="text-xs text-muted-foreground">Changed your mind? You can undo this.</p>
      </>}
    </section>
  </details>;
}
