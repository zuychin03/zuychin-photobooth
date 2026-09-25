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

const control = "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50";
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
    catch (failure) { queueMicrotask(() => { if (alive.current) setError(failure instanceof Error ? failure.message : "The export preview could not be drawn."); }); }
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
        if (job.signal.aborted) setNotice("Export cancelled. Your saved photos are unchanged.");
        else setError(failure instanceof Error ? failure.message : "The file could not be prepared. Try PNG or a smaller format.");
      }
    } finally { if (controller.current === job) controller.current = null; if (alive.current) setBusy(false); }
  };
  const download = () => {
    if (!artifact) return;
    downloadProjectBlob(artifact.blob, projectDownloadName(name, artifact.extension));
    setNotice("The file was sent to your browser's downloads.");
  };
  const share = async () => {
    if (!artifact) return;
    const file = new File([artifact.blob], projectDownloadName(name, artifact.extension), { type: artifact.mime });
    if (!navigator.canShare?.({ files: [file] })) { download(); return; }
    try { await navigator.share({ files: [file], title: name }); }
    catch (failure) { if (alive.current && !(failure instanceof DOMException && failure.name === "AbortError")) setError("Sharing did not finish. You can download the prepared file instead."); }
  };

  return <dialog ref={dialog} aria-labelledby="export-title" onCancel={event => { event.preventDefault(); close(); }}
    className="m-auto max-h-[92dvh] w-[calc(100%_-_2rem)] max-w-5xl overflow-y-auto rounded-2xl border border-border bg-card p-0 text-foreground shadow-2xl backdrop:bg-black/60">
    <header className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-border bg-card p-5 sm:p-6"><div><h2 id="export-title" className="font-display text-3xl">Keep it your way</h2><p className="mt-2 text-sm text-muted-foreground">Choose a size and check the crop.</p></div><button type="button" onClick={close} aria-label="Close export studio" className={`${control} w-11 shrink-0 px-0`}><X size={20} /></button></header>
    <div className="flex flex-wrap gap-2 px-5 pt-5 sm:px-6" role="group" aria-label="Export type"><button type="button" aria-pressed={mode === "still"} disabled={busy} onClick={() => setMode("still")} className={`${control} ${mode === "still" ? "bg-foreground text-background" : "border border-border"}`}>Image or print</button><button type="button" aria-pressed={mode === "motion"} disabled={busy || !canAnimate} onClick={() => setMode("motion")} className={`${control} ${mode === "motion" ? "bg-foreground text-background" : "border border-border"}`}>Photo loop</button></div>
    {!canAnimate && <p className="px-5 pt-3 text-sm text-muted-foreground sm:px-6">Photo loops need at least two photos in a solo project.</p>}
    {mode === "motion" ? <div className="mx-auto max-w-xl space-y-5 p-5 sm:p-6"><p className="text-sm text-muted-foreground">Cycle your photos through this frame. Originals and saved edits stay unchanged.</p><MotionExportPanel getFrames={getMotionFrames} name={name} /></div> : <>
    <div className="grid gap-6 p-5 sm:p-6 md:grid-cols-[minmax(0,1fr)_minmax(18rem,22rem)]">
      <section aria-label="Export preview" className="min-w-0"><div className="flex min-h-64 items-center justify-center rounded-xl bg-muted p-4"><canvas ref={preview} role="img" aria-label="Preview of the exported file, including its crop and margins" className="max-h-[55dvh] max-w-full object-contain shadow-md" /></div><p className="mt-3 text-center text-sm tabular-nums">{geometry.width} × {geometry.height} {geometry.unit}{pdf ? " · PDF at 300 ppi target" : ""}</p>{pdf && <p className="mt-2 text-center text-sm text-muted-foreground">Print at actual size or 100%. Printer margins and colour can vary.</p>}</section>
      <section aria-label="Export settings" className="min-w-0 space-y-4">
        <Dropdown showLabel label="Output size" value={profileId} options={[...STILL_PROFILES, ...PDF_PROFILES].map(item => ({ value: item.id, label: item.label }))} onChange={chooseProfile} disabled={busy} />
        <Dropdown showLabel label="Fit" value={fit} options={[{ value: "contain", label: "Keep the whole frame" }, { value: "cover", label: "Fill the size and crop edges" }]} onChange={value => change({ fit: value as ProjectExportSettings["fit"] })} disabled={busy || profileId === "original"} />
        {!pdf && <><Dropdown showLabel label="File format" value={format} options={[{ value: "png", label: "PNG · lossless" }, { value: "jpeg", label: "JPEG · smaller file" }]} onChange={value => change({ format: value as "png" | "jpeg" })} disabled={busy} />{format === "jpeg" && <label className="block text-sm font-medium">JPEG quality · {Math.round(quality * 100)}%<input type="range" min={.6} max={1} step={.02} value={quality} disabled={busy} onChange={event => change({ quality: Number(event.target.value) })} className="mt-2 min-h-11 w-full accent-accent" /></label>}</>}
        {pdf && <><label className="block text-sm font-medium">{profileId === "a4-contact" ? "Outer page margin" : "Safe margin"} · {margin} mm<input type="range" min={0} max={profileId === "a4-contact" ? 20 : 10} step={1} value={margin} disabled={busy} onChange={event => change({ marginMm: Number(event.target.value) })} className="mt-2 min-h-11 w-full accent-accent" /></label><label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={cutMarks} disabled={busy} onChange={event => change({ cutMarks: event.target.checked })} className="h-4 w-4 accent-accent" /> Include cut marks</label>{profileId === "a4-contact" && <p className="text-sm text-muted-foreground">Three copies, each 50.8 × 152.4 mm, with a 2 mm safe margin.</p>}</>}
        <div className="border-t border-border pt-4"><div className="flex items-center gap-2"><p className="text-sm font-medium">Photo detail</p><HelpTooltip label="About photo detail">A larger export cannot add detail to a low-resolution original. Cropping also reduces the detail available for printing.</HelpTooltip></div><p className="mt-1 text-sm text-muted-foreground">{pdf && resolution.minimumPpi !== null ? `Lowest effective resolution: ${Math.floor(resolution.minimumPpi)} ppi.` : resolution.minimumPixelRatio !== null ? `Smallest source supplies ${Math.round(resolution.minimumPixelRatio * 100)}% of the requested pixel detail.` : "Add photos to estimate the available detail."}</p>{resolution.warnings.length > 0 && <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">{resolution.warnings.map(message => <li key={message}>{message}</li>)}</ul>}</div>
        {saveError && <p role="alert" className="text-sm text-destructive">Export settings are not saved yet: {saveError} Preparing the file will retry the local save.</p>}{error && <p role="alert" className="text-sm text-destructive">{error}</p>}{notice && <p role="status" className="text-sm">{notice}</p>}
        {artifact ? <div className="space-y-3 border-t border-border pt-4"><p role="status" className="text-sm">{artifact.extension.toUpperCase()} ready · {byteLabel(artifact.bytes)}</p><div className="flex flex-wrap gap-2"><button type="button" onClick={download} className={`${control} flex-1 bg-accent text-accent-foreground`}><Download size={17} />Download {artifact.extension.toUpperCase()}</button><button type="button" onClick={() => void share()} className={`${control} border border-border`}><Share2 size={17} />Share</button></div></div>
          : <div className="flex flex-wrap gap-2"><button type="button" onClick={() => void generate()} disabled={busy} className={`${control} flex-1 bg-accent text-accent-foreground`}>{busy && <LoaderCircle size={17} className="animate-spin motion-reduce:animate-none" />}{busy ? "Preparing file…" : "Prepare file"}</button>{busy && <button type="button" onClick={() => controller.current?.abort()} className={`${control} border border-border`}>Cancel</button>}</div>}
      </section>
    </div></>}
  </dialog>;
}
