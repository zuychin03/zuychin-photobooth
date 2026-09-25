"use client";

import Link from "next/link";
import Image from "next/image";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Workspace } from "@/components/rooms/RoomWorkspace";
import { createRoomWorkspaceFixture, type RoomFixturePerson, type RoomWorkspaceFixture } from "@/lib/rtc/workspace-fixture";
import type { RoomPostcardProbeResult } from "@/lib/rtc/postcard-probe";
import type { useCamera } from "@/hooks/useCamera";

export function SyntheticRoom() {
  const [fixture, setFixture] = useState<RoomWorkspaceFixture | null>(null), [selected, setSelected] = useState(0), [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null), [copy, setCopy] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<string[]>([]);
  const [theme, setTheme] = useState<"light" | "dark">("dark");
  const current = useRef<RoomWorkspaceFixture | null>(null);
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; void current.current?.stop().catch(() => {}); }, []);
  useEffect(() => {
    if (!fixture) return;
    const timer = setInterval(() => setDiagnostics([...fixture.diagnostics]), 1000);
    return () => clearInterval(timer);
  }, [fixture]);
  const start = async (count: 2 | 4) => {
    if (busy || fixture) return; setBusy(true); setError(null); setCopy(null); setDiagnostics([]);
    const token = generation.current;
    try { const next = await createRoomWorkspaceFixture(count); if (token !== generation.current) { await next.stop(); return; } current.current = next; setFixture(next); setSelected(0); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Fixture failed"); }
    finally { setBusy(false); }
  };
  const stop = async () => {
    const previous = current.current; if (!previous || busy) return;
    setBusy(true); setFixture(null); setError(null); setCopy(null); current.current = null;
    try { await previous.stop(); } catch (failure) { setError(failure instanceof Error ? failure.message : "Fixture cleanup failed"); }
    finally { setBusy(false); }
  };
  return <div className={`${theme} min-h-dvh bg-background text-foreground`}><section aria-label="Synthetic room controls" className="border-b border-border bg-muted/40 px-6 py-5"><div className="mx-auto max-w-7xl"><Link href="/v2-lab" className="text-sm text-accent underline">Back to development lab</Link><h1 className="mt-3 font-display text-2xl">Room interface rehearsal</h1><p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">Synthetic people, real peer connections and isolated local databases. No camera, microphone or hosted API is used. The controls below display the actual room interface.</p><div className="mt-4 flex flex-wrap gap-3"><button className="min-h-11 rounded-xl border border-border bg-card px-4 text-sm" onClick={() => setTheme(value => value === "dark" ? "light" : "dark")}>{theme === "dark" ? "Inspect light theme" : "Inspect dark theme"}</button>{!fixture ? <>{([2, 4] as const).map(count => <button className="min-h-11 rounded-xl border border-border bg-card px-4 text-sm disabled:opacity-50" disabled={busy} key={count} onClick={() => void start(count)}>Start {count}-person room rehearsal</button>)}</> : <><button className="min-h-11 rounded-xl border border-border bg-card px-4 text-sm disabled:opacity-50" disabled={busy} onClick={() => void stop()}>Stop rehearsal</button><button className="min-h-11 rounded-xl border border-border bg-card px-4 text-sm" onClick={() => fixture.disconnectHost()}>Disconnect synthetic host</button><button className="min-h-11 rounded-xl border border-border bg-card px-4 text-sm" onClick={() => { fixture.failNextHostSave(); setError("The next host original will fail its first local save. Use the room recovery controls to retry it."); }}>Fail next host photo save</button></>}</div>{fixture && <nav className="mt-4 flex flex-wrap gap-2" aria-label="Rehearsal participant">{fixture.people.map((person, index) => <button key={person.name} aria-pressed={index === selected} onClick={() => setSelected(index)} className={`min-h-11 rounded-xl px-4 text-sm ${index === selected ? "bg-accent text-accent-foreground" : "border border-border"}`}>{person.name}{index === 0 ? " · host" : ""}</button>)}</nav>}{error && <p role="alert" className="mt-3 text-sm">{error}</p>}{fixture && diagnostics.length > 0 && <details className="mt-3 text-xs" open><summary>Fixture diagnostics</summary><pre className="whitespace-pre-wrap">{diagnostics.join("\n")}</pre></details>}{copy && <p role="status" className="mt-3 text-sm">Independent editable copy saved in the fixture database: {copy}</p>}</div></section>{fixture?.people.map((person, index) => <div key={person.name} hidden={index !== selected}><FixturePerson active={index === selected} person={person} onCopy={async id => setCopy(id)} /></div>)}</div>;
}

function FixturePerson({ person, onCopy, active }: { person: RoomFixturePerson; onCopy(id: string): Promise<void>; active: boolean }) {
  const snapshot = useSyncExternalStore(person.controller.subscribe, person.controller.getSnapshot, person.controller.getSnapshot);
  const [probeBusy, setProbeBusy] = useState(false), [probe, setProbe] = useState<RoomPostcardProbeResult | null>(null), [probeError, setProbeError] = useState<string | null>(null), [preview, setPreview] = useState<string | null>(null);
  const probeWork = useRef<AbortController | null>(null), probeURL = useRef<string | null>(null);
  useEffect(() => {
    const clear = () => { probeWork.current?.abort(); if (probeURL.current) { URL.revokeObjectURL(probeURL.current); probeURL.current = null; } };
    const hide = () => { if (document.hidden) { clear(); setPreview(null); } };
    if (!active) { clear(); }
    document.addEventListener("visibilitychange", hide);
    return () => { clear(); document.removeEventListener("visibilitychange", hide); };
  }, [active, person]);
  const checkPostcard = async () => {
    if (probeWork.current) return;
    const abort = new AbortController(); probeWork.current = abort; setProbeBusy(true); setProbe(null); setProbeError(null);
    if (probeURL.current) URL.revokeObjectURL(probeURL.current); probeURL.current = null; setPreview(null);
    try {
      const result = await (await import("@/lib/rtc/postcard-probe")).runRoomPostcardProbe(person, abort.signal);
      if (abort.signal.aborted || document.hidden) return;
      setProbe(result);
      if (result.preview) { const url = URL.createObjectURL(result.preview); probeURL.current = url; setPreview(url); }
    } catch (error) { if (!abort.signal.aborted) setProbeError(error instanceof Error ? error.message : "Probe failed"); }
    finally { if (probeWork.current === abort) { probeWork.current = null; setProbeBusy(false); } }
  };
  const ready = snapshot.round?.participants.length === 4 && snapshot.room.capture?.state === "committed" && snapshot.savedShots === 4 * snapshot.room.capture.shotIds.length && !snapshot.capturing && !snapshot.pendingLocalFrames.length && !snapshot.busy;
  const [camera] = useState<ReturnType<typeof useCamera>>(() => {
    const videoRef = { current: null as HTMLVideoElement | null }, stream = { current: person.stream };
    return { videoRef, stream, ready: true, error: null, facing: "user", cameras: [], canFlip: false,
      attachVideo(element) { videoRef.current = element; if (element) { element.srcObject = person.stream; void element.play().catch(() => {}); } },
      toggleFacing() {}, retry() { void videoRef.current?.play().catch(() => {}); },
    };
  });
  return <>
    <section className="mx-auto max-w-7xl border-b border-border px-6 py-4" aria-label="Room postcard native probe">
      <button className="min-h-11 rounded-xl border border-border bg-card px-4 text-sm disabled:opacity-50" disabled={!ready || probeBusy || !active} onClick={() => void checkPostcard()}>{probeBusy ? "Checking full originals…" : "Check full postcard render"}</button>
      <p className="mt-2 text-xs text-muted-foreground">Complete a four-person capture first. Use Original with a separate-photo or split layout. This checks actual saved bytes and native canvas output; it does not submit to an event.</p>
      {probeError && <p role="alert" className="mt-3 text-sm">{probeError}</p>}
      {probe && <div role="status" className="mt-3 text-sm"><p>{probe.checks.filter(check => check.passed).length}/{probe.checks.length} checks passed.</p><ul>{probe.checks.map(check => <li key={check.name} className="mt-2">{check.passed ? "Pass" : "Fail"}: {check.name}. {check.detail}</li>)}</ul></div>}
      {preview && <Image src={preview} alt="Full-original postcard native render, reduced for inspection" width={640} height={640} unoptimized className="mt-4 h-auto max-h-96 w-auto max-w-full object-contain" />}
    </section>
    <div inert={probeBusy}><Workspace previewActive={active && !probeBusy} controller={person.controller} fixtureCamera={camera} fixtureProjectDatabaseName={person.projectDatabaseName} onOpenCopy={onCopy} /></div>
  </>;
}
