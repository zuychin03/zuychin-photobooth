"use client";

import { HelpTooltip } from "@/components/HelpTooltip";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, LoaderCircle, Share2, X } from "lucide-react";
import { Dropdown } from "./Dropdown";
import { MotionExportPanel } from "./MotionExportPanel";
import { compositionSize, type ComposeInput } from "@/lib/compose";
import { PDF_PROFILES, STILL_PROFILES, getExportProfile, type ExportOptions, type ExportProfileId, type PdfProfileId, type StillProfileId } from "@/lib/exports/profiles";
import { projectExportSettings, validateExportSettings, type ProjectExportSettings } from "@/lib/exports/settings";
import { exportGeometry, sourceResolution } from "@/lib/exports/geometry";
import { ExportJob, renderExportPreview, type ExportArtifact } from "@/lib/exports/still";
import { downloadProjectBlob, projectDownloadName } from "@/lib/projects/download";

const control = "btn text-sm";
const byteLabel = (bytes: number) => bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export default function ExportStudio({ input, name, solo, settings, onSettingsChange, saveError, prepare, close }: {
  input: ComposeInput; name: string; solo: boolean; settings?: ProjectExportSettings; onSettingsChange(settings: ProjectExportSettings): void; saveError?: string | null; prepare(): Promise<void>; close(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null), preview = useRef<HTMLCanvasElement>(null);
  const controller = useRef<AbortController | null>(null), alive = useRef(false);
  const preparation = useRef(prepare);
  const preferences = projectExportSettings(settings);
  const { profileId, fit, format, quality, marginMm: margin, cutMarks } = preferences;
  const [mode, setMode] = useState<"still" | "motion">("still");
  const [busy, setBusy] = useState(false), [prepared, setPrepared] = useState<{ file: ExportArtifact; input: ComposeInput; options: ExportOptions; profileId: ExportProfileId } | null>(null);
  const [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const profile = getExportProfile(profileId), pdf = profile.kind === "pdf";
  const options = useMemo<ExportOptions>(() => ({ fit, format, quality, marginMm: pdf ? margin : 0, cutMarks: pdf && cutMarks }), [fit, format, quality, pdf, margin, cutMarks]);
  const artifact = prepared?.input === input && prepared.options === options && prepared.profileId === profileId ? prepared.file : null;
  const geometry = useMemo(() => exportGeometry(compositionSize(input), profileId, options), [input, profileId, options]);
  const resolution = useMemo(() => sourceResolution(input, geometry), [input, geometry]);
  const canAnimate = solo && !["B", "C", "D"].some(role => input.shots[role as "B" | "C" | "D"]?.some(Boolean)) && (input.shots.A ?? []).filter(Boolean).length >= 2;
  const getMotionFrames = useCallback(async (signal: AbortSignal) => {
    const job = new ExportJob({ signal });
    await job.wait(preparation.current());
    job.check();
    return (await import("@/lib/exports/photo-loop")).createPhotoLoopFrames(input, signal);
  }, [input]);

  useEffect(() => { preparation.current = prepare; }, [prepare]);

  useEffect(() => {
    alive.current = true;
    dialog.current?.showModal();
    return () => { alive.current = false; controller.current?.abort(); };
  }, []);
  useEffect(() => {
    const canvas = preview.current;
    if (!canvas) return;
    try { renderExportPreview(canvas, input, profileId, options, 900); }
    catch (failure) { queueMicrotask(() => { if (alive.current) setError(failure instanceof Error ? failure.message : "Couldn't draw the preview."); }); }
    return () => { canvas.width = canvas.height = 0; };
  }, [input, profileId, options, mode]);

  const change = (patch: Partial<ProjectExportSettings>) => { onSettingsChange(validateExportSettings({ ...preferences, ...patch })); setPrepared(null); setError(null); setNotice(null); };
  const chooseProfile = (value: string) => {
    const next = getExportProfile(value as ExportProfileId);
    change({ profileId: next.id, fit: next.fit, marginMm: next.id === "a4-contact" ? 10 : 2 });
  };
  const generate = async () => {
    if (controller.current) return;
    const job = new AbortController(); controller.current = job;
    setBusy(true); setError(null); setNotice(null); setPrepared(null);
    try {
      await new ExportJob({ signal: job.signal }).wait(prepare());
      if (!alive.current || job.signal.aborted) return;
      const settings = { ...options, signal: job.signal };
      const result = pdf
        ? await (await import("@/lib/exports/pdf")).exportPdf(input, profileId as PdfProfileId, settings)
        : await (await import("@/lib/exports/still")).exportStill(input, profileId as StillProfileId, settings);
      if (alive.current && !job.signal.aborted) setPrepared({ file: result, input, options, profileId });
    } catch (failure) {
      if (alive.current) {
        if (job.signal.aborted) setNotice("Export cancelled.");
        else setError(failure instanceof Error ? failure.message : "Couldn't create the file. Try PNG or a smaller size.");
      }
    } finally { if (controller.current === job) controller.current = null; if (alive.current) setBusy(false); }
  };
  const download = () => {
    if (!artifact) return;
    downloadProjectBlob(artifact.blob, projectDownloadName(name, artifact.extension));
    setNotice("Downloading now. Check your downloads folder.");
  };
  const share = async () => {
    if (!artifact) return;
    const file = new File([artifact.blob], projectDownloadName(name, artifact.extension), { type: artifact.mime });
    if (!navigator.canShare?.({ files: [file] })) { download(); return; }
    try { await navigator.share({ files: [file], title: name }); }
    catch (failure) { if (alive.current && !(failure instanceof DOMException && failure.name === "AbortError")) setError("Couldn't share it. Try downloading it instead."); }
  };

  return <dialog ref={dialog} aria-labelledby="export-title" onCancel={event => { event.preventDefault(); close(); }}
    className="glass-strong m-auto max-h-[92dvh] w-[calc(100%_-_2rem)] max-w-5xl overflow-y-auto overscroll-contain rounded-[1.75rem] border-0 p-5 text-foreground sm:p-6">
    <header className="flex flex-wrap items-center gap-x-4 gap-y-3">
      <h2 id="export-title" className="min-w-0 flex-1 font-display text-2xl sm:text-3xl">Export your strip</h2>
      <button type="button" onClick={close} aria-label="Close export" className={`${control} btn-quiet w-11 shrink-0 px-0 sm:order-last`}><X size={20} aria-hidden /></button>
      <div className="segmented max-sm:order-last max-sm:w-full" role="group" aria-label="Export type"><button type="button" aria-pressed={mode === "still"} disabled={busy} onClick={() => setMode("still")} className="disabled:opacity-40 max-sm:flex-1">Image or print</button><button type="button" aria-pressed={mode === "motion"} disabled={busy || !canAnimate} onClick={() => setMode("motion")} className="disabled:opacity-40 max-sm:flex-1">Photo loop</button></div>
    </header>
    {!canAnimate && <p className="mt-2 text-xs text-muted-foreground sm:text-right">Photo loops need at least two photos in a solo project.</p>}
    {mode === "motion" ? <div className="mx-auto mt-5 max-w-xl"><MotionExportPanel getFrames={getMotionFrames} name={name} /></div> : <>
    <div className="mt-5 grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(18rem,22rem)]">
      <section aria-label="Export preview" className="min-w-0 md:flex md:flex-col"><div className="panel-muted flex min-h-64 items-center justify-center p-4 sm:p-6 md:flex-1"><canvas ref={preview} role="img" aria-label="Preview of the exported file" className="max-h-[55dvh] max-w-full object-contain shadow-lg shadow-black/20" /></div><p className="mt-3 text-center text-sm font-bold tabular-nums">{geometry.width} × {geometry.height} {geometry.unit}{pdf ? " · PDF, aiming for 300 ppi" : ""}</p>{pdf && <p className="mt-1 text-center text-sm text-muted-foreground">Print at 100% (actual size).</p>}</section>
      <section aria-label="Export settings" className="min-w-0 space-y-4">
        <Dropdown showLabel label="Output size" value={profileId} options={[...STILL_PROFILES, ...PDF_PROFILES].map(item => ({ value: item.id, label: item.label }))} onChange={chooseProfile} disabled={busy} />
        <div>
          <span className="mb-1.5 block text-sm font-bold">Fit</span>
          <div role="group" aria-label="Fit" className="segmented w-full">{([["contain", "Whole strip"], ["cover", "Fill and crop"]] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={fit === value} disabled={busy || profileId === "original"} onClick={() => { if (fit !== value) change({ fit: value }); }} className="flex-1 disabled:opacity-40">{label}</button>)}</div>
        </div>
        {!pdf && <><div>
          <span className="mb-1.5 block text-sm font-bold">File format</span>
          <div role="group" aria-label="File format" className="segmented w-full">{([["png", "PNG · lossless"], ["jpeg", "JPEG · smaller"]] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={format === value} disabled={busy} onClick={() => { if (format !== value) change({ format: value }); }} className="flex-1 disabled:opacity-40">{label}</button>)}</div>
        </div>{format === "jpeg" && <label className="block text-sm font-bold">JPEG quality · <span className="tabular-nums">{Math.round(quality * 100)}%</span><input type="range" min={.6} max={1} step={.02} value={quality} disabled={busy} onChange={event => change({ quality: Number(event.target.value) })} className="mt-1 min-h-11 w-full accent-accent" /></label>}</>}
        {pdf && <><label className="block text-sm font-bold">{profileId === "a4-contact" ? "Outer page margin" : "Safe margin"} · <span className="tabular-nums">{margin} mm</span><input type="range" min={0} max={profileId === "a4-contact" ? 20 : 10} step={1} value={margin} disabled={busy} onChange={event => change({ marginMm: Number(event.target.value) })} className="mt-1 min-h-11 w-full accent-accent" /></label><label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm font-bold"><input type="checkbox" checked={cutMarks} disabled={busy} onChange={event => change({ cutMarks: event.target.checked })} className="size-5 accent-accent" /> Include cut marks</label>{profileId === "a4-contact" && <p className="text-sm text-muted-foreground">Three copies, each 50.8 × 152.4 mm, with a 2 mm safe margin.</p>}</>}
        <div className="panel-muted p-4"><div className="flex items-center gap-1.5"><p className="text-sm font-bold">Photo detail</p><HelpTooltip label="About photo detail">Exporting bigger won&apos;t add detail to a small photo, and cropping in leaves less detail for printing.</HelpTooltip></div><p className="mt-1 text-sm text-muted-foreground">{pdf && resolution.minimumPpi !== null ? `Your lowest-detail photo prints at ${Math.floor(resolution.minimumPpi)} ppi.` : resolution.minimumPixelRatio !== null ? `Your smallest photo has ${Math.round(resolution.minimumPixelRatio * 100)}% of the detail this size needs.` : "Add photos to see how much detail you'll get."}</p>{resolution.warnings.length > 0 && <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">{resolution.warnings.map(message => <li key={message}>{message}</li>)}</ul>}</div>
        {saveError && <p role="alert" className="text-sm font-bold text-destructive">Export settings haven&apos;t saved yet. {saveError}</p>}{error && <p role="alert" className="text-sm font-bold text-destructive">{error}</p>}{notice && <p role="status" className="text-sm">{notice}</p>}
        {artifact ? <div className="space-y-3 border-t border-border pt-4"><p role="status" className="text-sm font-bold tabular-nums">{artifact.extension.toUpperCase()} ready · {byteLabel(artifact.bytes)}</p><div className="flex flex-wrap gap-2"><button type="button" onClick={download} className={`${control} btn-primary flex-1`}><Download size={17} aria-hidden />Download {artifact.extension.toUpperCase()}</button><button type="button" onClick={() => void share()} className={`${control} btn-quiet`}><Share2 size={17} aria-hidden />Share</button></div></div>
          : <div className="flex flex-wrap gap-2"><button type="button" onClick={() => void generate()} disabled={busy} className={`${control} btn-primary flex-1`}>{busy && <LoaderCircle size={17} className="animate-spin motion-reduce:animate-none" aria-hidden />}{busy ? "Creating file…" : "Create file"}</button>{busy && <button type="button" onClick={() => controller.current?.abort()} className={`${control} btn-quiet`}>Cancel</button>}</div>}
      </section>
    </div></>}
  </dialog>;
}
