"use client";

import { useEffect, useRef, useState } from "react";
import { Dropdown } from "@/components/Dropdown";
import { SharedPreviewPainter, type SharedPreviewStatus } from "@/lib/shared-preview";
import { createSyntheticPeople, type SyntheticPeople } from "@/lib/feasibility/shared-preview-probe";
import { getScene } from "@/lib/scenes";

export function SyntheticTogether() {
  const target = useRef<HTMLCanvasElement>(null), sources = useRef<HTMLDivElement>(null), painter = useRef<SharedPreviewPainter | null>(null), people = useRef<SyntheticPeople | null>(null);
  const [running, setRunning] = useState(false), [count, setCount] = useState<2 | 4>(2), [together, setTogether] = useState(false), [paused, setPaused] = useState(false), [missing, setMissing] = useState(false);
  const [status, setStatus] = useState<SharedPreviewStatus | null>(null), [ready, setReady] = useState(false), [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!running || !target.current || process.env.NODE_ENV !== "development") return;
    let live = true; const instance = new SharedPreviewPainter(target.current, { onStatus: value => { if (live) setStatus(value); } }); painter.current = instance;
    void createSyntheticPeople(count).then(fixture => {
      if (!live) { fixture.stop(); return; } people.current = fixture;
      fixture.inputs.forEach(input => { input.video.className = "h-28 w-20 rounded-lg object-cover"; sources.current?.appendChild(input.video); });
      instance.start({ inputs: fixture.inputs, intendedRoles: fixture.inputs.map(input => input.role), localRole: "A", scene: null }); setReady(true);
    }).catch(reason => { if (live) setError(reason instanceof Error ? reason.message : "Synthetic sources could not start."); });
    return () => { live = false; void instance.dispose(); if (painter.current === instance) painter.current = null; people.current?.stop(); people.current = null; };
  }, [running, count]);
  useEffect(() => {
    const fixture = people.current, instance = painter.current;
    if (!ready || !fixture || !instance) return;
    let live = true;
    const apply = async () => {
      if (paused) fixture.inputs[1].video.pause(); else await fixture.inputs[1].video.play();
      if (!live) return;
      instance.update({ inputs: missing ? fixture.inputs.slice(0, 1) : fixture.inputs, intendedRoles: fixture.inputs.map(input => input.role), localRole: "A", scene: together ? getScene("studio-cream") : null, places: { A: { dx: -0.05, dy: 0, scale: 0.9 } } });
      if (together) instance.retryTogether();
    };
    void apply().catch(reason => { if (live) setError(reason instanceof Error ? reason.message : "Synthetic playback failed."); });
    return () => { live = false; };
  }, [ready, together, paused, missing]);
  const button = "min-h-11 rounded-lg border border-border px-4 text-sm disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
  return <section aria-labelledby="together-fixture-heading" className="space-y-4 border-b border-border py-7">
    <h2 id="together-fixture-heading" className="text-lg font-semibold">P5 shared preview interface</h2>
    <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">Coloured silhouettes exercise two- and four-person placement without a camera. Start the sources, then explicitly try Together to load the local segmentation model. This fixture does not prove real human edges or phone performance.</p>
    <div className="flex flex-wrap items-end gap-3">
      <Dropdown label="Synthetic people" showLabel value={String(count)} options={[{ value: "2", label: "Two people" }, { value: "4", label: "Four people" }]} disabled={running} onChange={value => setCount(value === "4" ? 4 : 2)} />
      <button type="button" className={button} onClick={() => { setReady(false); setTogether(false); setPaused(false); setMissing(false); setError(null); setStatus(null); setRunning(value => !value); }}>{running ? "Stop preview fixture" : "Start synthetic people"}</button>
      {running && <button type="button" className={`${button} bg-accent text-accent-foreground`} disabled={!ready} aria-pressed={together} onClick={() => setTogether(value => !value)}>{together ? "Show original tiles" : "Try Together"}</button>}
    </div>
    <div ref={sources} className="flex flex-wrap gap-3" aria-label="Synthetic source videos" />
    <canvas ref={target} className={running ? "block aspect-[3/2] w-full max-w-2xl rounded-xl bg-muted" : "hidden"} aria-label="Shared synthetic preview" />
    {running && <div className="flex flex-wrap gap-3"><button type="button" className={button} disabled={!ready} aria-pressed={paused} onClick={() => setPaused(value => !value)}>{paused ? "Resume person B" : "Pause person B"}</button><button type="button" className={button} disabled={!ready} aria-pressed={missing} onClick={() => setMissing(value => !value)}>{missing ? "Restore remote people" : "Remove remote inputs"}</button></div>}
    <p role="status" className="text-sm text-muted-foreground">{error ? "Preview could not finish." : !running ? "The fixture is stopped." : !ready ? "Starting synthetic video sources…" : status ? `${status.mode === "together" ? "Together preview" : status.mode === "local-only" ? "Local-only fallback" : status.mode === "warming" ? "Loading and measuring Together" : status.mode === "originals" ? "Original video tiles" : "Waiting for sources"}. Showing ${status.displayedRoles.join(", ") || "no sources"}${status.missingRoles.length ? `; missing ${status.missingRoles.join(", ")}` : ""}${status.reason ? ` (${status.reason.replaceAll("-", " ")})` : ""}.` : "Sources are ready."}</p>
    {error && <p role="alert" className="text-sm text-accent">{error}</p>}
    {status && <p className="text-xs text-muted-foreground">Scheduling estimate: {status.fps.toFixed(1)} updates/s. Last group inference: {status.inferenceMs === null ? "not run" : `${status.inferenceMs.toFixed(1)} ms`}.</p>}
  </section>;
}
