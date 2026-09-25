"use client";

import { HelpTooltip } from "@/components/HelpTooltip";

import { useEffect, useRef, useState } from "react";
import { Download, LoaderCircle, Pause, Play, Share2 } from "lucide-react";
import { Dropdown } from "./Dropdown";
import { ExportJob } from "@/lib/exports/still";
import type { MotionArtifact, MotionVideoCapability } from "@/lib/exports/motion";
import { downloadProjectBlob, projectDownloadName } from "@/lib/projects/download";

const control = "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50";
const byteLabel = (bytes: number) => bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export function MotionExportPanel({ getFrames, name, delayMs = 500, warnings = [], disabled = false, onBusyChange }: {
  getFrames(signal: AbortSignal): Promise<readonly Blob[]>; name: string; delayMs?: number; warnings?: readonly string[]; disabled?: boolean; onBusyChange?(busy: boolean): void;
}) {
  const controller = useRef<AbortController | null>(null), alive = useRef(false);
  const busyCallback = useRef(onBusyChange);
  const [format, setFormat] = useState<"gif" | "mp4" | "webm">("gif");
  const [boomerang, setBoomerang] = useState(false), [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState<"encoding" | "checking" | null>(null), [progress, setProgress] = useState(0);
  const [capabilities, setCapabilities] = useState<MotionVideoCapability[] | null>(null);
  const [prepared, setPrepared] = useState<{ artifact: MotionArtifact; source: typeof getFrames; poster: Blob; delayMs: number; format: string; boomerang: boolean } | null>(null);
  const [urls, setUrls] = useState<{ artifact: MotionArtifact; animation: string; poster: string } | null>(null);
  const [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const result = prepared?.source === getFrames && prepared.delayMs === delayMs && prepared.format === format && prepared.boomerang === boomerang ? prepared : null;
  const artifact = result?.artifact;
  const blocked = disabled || Boolean(busy);

  useEffect(() => { busyCallback.current = onBusyChange; }, [onBusyChange]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; controller.current?.abort(); busyCallback.current?.(false); }; }, []);
  useEffect(() => {
    if (!result) return;
    const animation = URL.createObjectURL(result.artifact.blob), poster = URL.createObjectURL(result.poster);
    queueMicrotask(() => { if (alive.current) setUrls({ artifact: result.artifact, animation, poster }); });
    return () => { URL.revokeObjectURL(animation); URL.revokeObjectURL(poster); };
  }, [result]);

  const reset = () => { setPrepared(null); setPlaying(false); setError(null); setNotice(null); };
  const run = async (checking = false) => {
    if (controller.current || disabled) return;
    const abort = new AbortController(); controller.current = abort;
    busyCallback.current?.(true);
    setBusy(checking ? "checking" : "encoding"); setError(null); setNotice(null); setProgress(0);
    if (!checking) reset();
    try {
      const motion = await import("@/lib/exports/motion");
      const job = new ExportJob({ signal: abort.signal, timeoutMs: 90_000 });
      job.check();
      if (checking) {
        const checked = await job.wait(motion.probeMotionVideoFormats(abort.signal));
        if (alive.current && !abort.signal.aborted) setCapabilities(checked);
      } else {
        const frames = await job.wait(getFrames(abort.signal));
        job.check();
        const settings = { signal: abort.signal, delayMs, boomerang, onProgress: (done: number, total: number) => { if (alive.current && !abort.signal.aborted) setProgress(Math.round(done / total * 100)); } };
        const output = format === "gif" ? await motion.encodeMotionGif(frames, settings) : await motion.encodeMotionVideo(frames, { ...settings, format });
        if (alive.current && !abort.signal.aborted) setPrepared({ artifact: output, source: getFrames, poster: frames[0], delayMs, format, boomerang });
      }
    } catch (failure) {
      if (alive.current) {
        if (abort.signal.aborted) setNotice("Cancelled. Your still photos are unchanged.");
        else setError(failure instanceof Error ? failure.message : "Motion export could not finish. Your still photos remain available.");
      }
    } finally { if (controller.current === abort) controller.current = null; if (alive.current) { setBusy(null); busyCallback.current?.(false); } }
  };
  const download = () => {
    if (!artifact || blocked) return;
    downloadProjectBlob(artifact.blob, projectDownloadName(`${name}-loop`, artifact.extension));
    setNotice("The loop was sent to your browser's downloads.");
  };
  const share = async () => {
    if (!artifact || blocked) return;
    const file = new File([artifact.blob], projectDownloadName(`${name}-loop`, artifact.extension), { type: artifact.mime });
    if (!navigator.canShare?.({ files: [file] })) { download(); return; }
    try { await navigator.share({ files: [file], title: name }); }
    catch (failure) { if (alive.current && !(failure instanceof DOMException && failure.name === "AbortError")) setError("Sharing did not finish. Download the loop instead."); }
  };
  const media = artifact && urls?.artifact === artifact ? urls : null;
  return <section aria-label="Motion export" className="space-y-4">
    <Dropdown showLabel label="Motion format" value={format} disabled={blocked} onChange={value => { reset(); setFormat(value as typeof format); }} options={[
      { value: "gif", label: "GIF · animated image" },
      ...["mp4", "webm"].map(value => ({ value, label: `${value.toUpperCase()} · video`, disabled: !capabilities?.find(item => item.format === value)?.available })),
    ]} />
    <div className="flex items-center gap-2 text-sm text-muted-foreground"><span>Silent GIF or video</span><HelpTooltip label="About motion formats">GIF uses up to 640 pixels on its longest edge and a limited colour palette. Video uses up to 1280 × 720 pixels. Check this browser before choosing a video format.</HelpTooltip></div>
    <button type="button" disabled={blocked} onClick={() => void run(true)} className={`${control} border border-border`}>{busy === "checking" && <LoaderCircle size={16} className="animate-spin motion-reduce:animate-none" />}{capabilities ? "Check video formats again" : "Check video support"}</button>
    {capabilities && <p role="status" className="text-sm text-muted-foreground">{capabilities.map(item => `${item.format.toUpperCase()}: ${item.available ? "ready, encoding and playback checked" : "unavailable in this browser"}`).join(". ")}.</p>}
    <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={boomerang} disabled={blocked} onChange={event => { reset(); setBoomerang(event.target.checked); }} className="h-4 w-4 accent-accent" /> Play forwards, then backwards</label>
    {warnings.map(warning => <p key={warning} className="text-sm text-muted-foreground">{warning}</p>)}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}{notice && <p role="status" className="text-sm">{notice}</p>}
    {busy && <div role="status" className="space-y-2 text-sm"><p>{busy === "checking" ? "Checking a small sample video. Keep this tab open…" : `Preparing your loop · ${progress}%`}</p>{busy === "encoding" && <progress value={progress} max={100} aria-label="Motion export progress" className="w-full accent-accent" />}<button type="button" onClick={() => controller.current?.abort()} className={`${control} border border-border`}>Cancel motion export</button></div>}
    {artifact && !busy ? <div className="space-y-3 border-t border-border pt-4">
      <p role="status" className="text-sm">{artifact.extension.toUpperCase()} ready · {byteLabel(artifact.bytes)} · {artifact.width} × {artifact.height} · {(artifact.durationMs / 1000).toFixed(1)} seconds</p>
      {artifact.warnings.map(warning => <p key={warning} className="text-sm text-muted-foreground">{warning}</p>)}
      {media && (artifact.extension === "gif" ? <div className="space-y-2">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={playing ? media.animation : media.poster} alt={playing ? "Your animated photo loop" : "First frame of your photo loop"} className="mx-auto max-h-[45dvh] max-w-full rounded-lg" />
        <button type="button" disabled={disabled && !playing} onClick={() => setPlaying(value => !value)} className={`${control} border border-border`}>{playing ? <Pause size={16} /> : <Play size={16} />}{playing ? "Stop preview" : "Play preview"}</button>
      </div> : <video src={media.animation} poster={media.poster} controls playsInline preload="metadata" aria-label="Preview your recorded loop" className="mx-auto max-h-[45dvh] max-w-full rounded-lg" />)}
      <div className="flex flex-wrap gap-2"><button type="button" disabled={blocked} onClick={download} className={`${control} flex-1 bg-accent text-accent-foreground`}><Download size={17} />Download {artifact.extension.toUpperCase()}</button><button type="button" disabled={blocked} onClick={() => void share()} className={`${control} border border-border`}><Share2 size={17} />Share</button></div>
    </div> : !busy && <button type="button" disabled={blocked} onClick={() => void run()} className={`${control} w-full bg-accent text-accent-foreground`}>Prepare {format.toUpperCase()} loop</button>}
  </section>;
}
