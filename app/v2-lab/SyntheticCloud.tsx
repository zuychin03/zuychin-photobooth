"use client";

import Link from "next/link";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { CloudLibrary } from "@/components/cloud/CloudLibrary";
import { cloudControl } from "@/components/cloud/CloudControls";
import { CloudProjectDetail } from "@/components/cloud/CloudProjectDetail";
import { createCloudUIFixture, type CloudUIFixture, type CloudFixtureSession } from "@/lib/projects/cloud-ui-fixture";
import type { CloudProjectView } from "@/lib/projects/cloud-contract";
import { downloadProjectBlob } from "@/lib/projects/download";
import { Dropdown } from "@/components/Dropdown";
import type { CloudFixturePeopleCount, CloudFixturePersonIndex } from "@/lib/projects/cloud-fixture-people";

const FixtureContext = createContext<{ session: CloudFixtureSession; fixture: CloudUIFixture } | null>(null);
function ProjectView({ view, onBack }: { view: CloudProjectView; onBack(): void }) {
  const context = useContext(FixtureContext), [notice, setNotice] = useState<string | null>(null), [error, setError] = useState<string | null>(null), [changing, setChanging] = useState(false);
  const live = useRef(false);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  if (!context) return null;
  const { session, fixture } = context;
  const change = async (work: () => Promise<void> | void, message: string) => {
    if (changing) return; setChanging(true); setError(null);
    try { await work(); session.client.assertActive(); if (live.current) setNotice(message); }
    catch (failure) { if (live.current) setError(failure instanceof Error ? failure.message : "Synthetic action failed"); }
    finally { if (live.current) setChanging(false); }
  };
  return <>
    <section aria-label="Synthetic project controls" className="border-b border-border py-5">
      <p className="text-sm text-foreground/70">These actions affect only this rehearsal’s isolated account projects and in-memory challenges. Opening a design stays here and never enters the real editor.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button className={`${cloudControl} border border-border`} disabled={changing} onClick={() => { fixture.loseDesignAcknowledgement(); setNotice("The next design save will commit, then lose its response. Continue its saved request to reconcile."); }}>Lose next design-save response</button>
        <button className={`${cloudControl} border border-border`} disabled={changing} onClick={() => void change(() => fixture.advanceDesignHead(view.project.id), "Synthetic cloud head advanced. Existing prepared requests now have a stale expected revision.")}>Advance cloud head from another device</button>
        <button className={`${cloudControl} border border-border`} disabled={changing} onClick={() => void change(() => fixture.revokeDesignSource(view.project.id), "Bound original revoked in the fake server. Check or open the design again; local copies remain intact.")}>Revoke one bound original</button>
        <button className={`${cloudControl} border border-border`} disabled={changing} onClick={() => { fixture.losePartialAcknowledgement(); setNotice("The next successful partial proposal will be saved, then lose its response. Remount and continue its saved request to reconcile."); }}>Lose next partial-proposal response</button>
        <button className={`${cloudControl} border border-border`} disabled={changing} onClick={() => { const count = fixture.expireContributions(view.project.id); setNotice(`${count} synthetic challenge${count === 1 ? "" : "s"} marked expired. The agreed deadline stays unchanged. Refresh to inspect expiry; submitted originals and partial proposals remain.`); }}>Expire this project&apos;s contributions</button>
      </div>
      {notice && <p role="status" className="mt-3 break-words text-sm">{notice}</p>}
      {error && <p role="alert" className="mt-3 text-sm">{error}</p>}
    </section>
    <CloudProjectDetail drafts={session.drafts} designs={session.designs} openRepository={fixture.openRepository} key={`${session.key}:${view.project.id}`} client={session.client} uploads={session.uploads} challenges={session.challenges} initialView={view} onBack={onBack} onOpenDesign={async result => {
      await session.designs.adoptOpen(result); session.client.assertActive();
      if (live.current) setNotice(`Editable copy saved and linked in the isolated account repository: ${result.project.id}. No navigation occurred. Choose it in the saved-device-project control below to prepare another version.`);
    }} />
  </>;
}

export function SyntheticCloud() {
  const [fixture, setFixture] = useState<CloudUIFixture | null>(null), [session, setSession] = useState<CloudFixtureSession | null>(null);
  const [person, setPerson] = useState<CloudFixturePersonIndex>(0), [peopleCount, setPeopleCount] = useState<CloudFixturePeopleCount>(2), [held, setHeld] = useState(false), [busy, setBusy] = useState(false), [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null), [probe, setProbe] = useState<string[]>([]), [diagnostics, setDiagnostics] = useState<string[]>([]);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [storySupported, setStorySupported] = useState(true);
  const current = useRef<CloudUIFixture | null>(null), generation = useRef(0), uploadController = useRef<AbortController | null>(null);
  useEffect(() => () => { generation.current++; uploadController.current?.abort(); void current.current?.close().catch(() => {}); }, []);
  useEffect(() => { if (!fixture) return; const timer = setInterval(() => setDiagnostics([...fixture.diagnostics]), 500); return () => clearInterval(timer); }, [fixture]);
  const run = async (work: () => Promise<void>) => {
    if (busy) return; setBusy(true); setError(null);
    try { await work(); } catch (failure) { setError(failure instanceof Error ? failure.message : "Rehearsal failed"); } finally { setBusy(false); }
  };
  const start = () => run(async () => {
    const token = ++generation.current, next = await createCloudUIFixture(location.origin, peopleCount);
    if (token !== generation.current) { await next.close(); return; }
    current.current = next;
    let active: CloudFixtureSession;
    try { active = await next.mount(0); }
    catch (failure) { if (current.current === next) current.current = null; await next.close(); throw failure; }
    if (token !== generation.current) { await next.close(); return; }
    setFixture(next); setSession(active); setPerson(0); setHeld(false); setStorySupported(true); setNotice(null); setDiagnostics([]);
  });
  const mount = (nextPerson: CloudFixturePersonIndex) => run(async () => {
    if (!fixture) return;
    uploadController.current?.abort(); setSession(null); const active = await fixture.mount(nextPerson);
    if (current.current === fixture) { setSession(active); setPerson(nextPerson); setNotice(`Showing ${active.name}'s isolated synthetic account.`); }
  });
  const stop = () => run(async () => {
    generation.current++; uploadController.current?.abort(); const previous = current.current; current.current = null; setSession(null); setFixture(null); setNotice(null); setDiagnostics([]); await previous?.close();
  });
  const uploadSample = async () => {
    if (!fixture || !session || uploading) return;
    const abort = new AbortController(); uploadController.current = abort; setUploading(true); setError(null);
    try {
      const record = await session.uploads.prepare(session.projectId, fixture.sample, { kind: "photo" }, abort.signal);
      const result = await session.uploads.run(record.id, fixture.sample, abort.signal);
      if (!abort.signal.aborted) setNotice(result.state === "ready" ? "Synthetic PNG verified by the fixture. Open or refresh the private project to inspect it." : "Synthetic upload is pending. Open or refresh the private project, then use its recovery controls.");
    } catch (failure) { if (!abort.signal.aborted) setError(failure instanceof Error ? failure.message : "Synthetic upload failed"); }
    finally { setUploading(false); }
  };
  return <div className={`${theme} min-h-dvh bg-background text-foreground`}>
    <section aria-label="Synthetic cloud controls" className="border-b border-border bg-muted/40 px-5 py-6"><div className="mx-auto max-w-6xl">
      <Link href="/v2-lab" className="text-sm text-accent underline underline-offset-4">Back to development lab</Link>
      <h1 className="mt-4 font-display text-3xl font-semibold">Cloud interface rehearsal</h1>
      <p className="mt-3 max-w-3xl text-sm leading-relaxed text-foreground/70">Synthetic temporary demo. The actual cloud interface, client, save coordinator and isolated browser databases run against an in-memory transport. Start seeds one saved account design per person. No account, hosted API or Storage request is used. Selected files remain in this browser. Reload resets the simulated server; this does not prove server durability, SQL permissions or production image verification. Use Stop and clear rehearsal before leaving to remove its temporary journals and projects.</p>
      <div className="mt-5 flex flex-wrap gap-2">
        {!fixture && <Dropdown label="Synthetic group size" showLabel value={String(peopleCount)} options={[2, 3, 4].map(count => ({ value: String(count), label: `${count} people` }))} disabled={busy} onChange={value => setPeopleCount(Number(value) as CloudFixturePeopleCount)} />}
        <button className={`${cloudControl} border border-border bg-card`} onClick={() => setTheme(value => value === "dark" ? "light" : "dark")}>{theme === "dark" ? "Inspect light theme" : "Inspect dark theme"}</button>
        {!fixture ? <button className={`${cloudControl} bg-accent text-accent-foreground`} disabled={busy} onClick={() => void start()}>Start cloud rehearsal</button> : <>
          <button className={`${cloudControl} border border-border bg-card`} disabled={busy} onClick={() => void stop()}>Stop and clear rehearsal</button>
          {fixture.people.filter(candidate => candidate.index !== person).map(candidate => <button key={candidate.ownerId} className={`${cloudControl} border border-border bg-card`} disabled={busy} onClick={() => void mount(candidate.index)}>Switch to {candidate.name}</button>)}
          <button className={`${cloudControl} border border-border bg-card`} disabled={busy} onClick={() => { if (session) { uploadController.current?.abort(); fixture.unmount(); setSession(null); setNotice("Workspace unmounted; fixture memory and isolated journal remain until remount or stop."); } else void mount(person); }}>{session ? "Unmount workspace" : "Remount workspace"}</button>
          <button className={`${cloudControl} border border-border bg-card`} aria-pressed={held} onClick={() => { fixture.holdVerification(!held); setHeld(!held); }}>{held ? "Release verification" : "Hold verification pending"}</button>
          <button className={`${cloudControl} border border-border bg-card`} aria-pressed={!storySupported} onClick={() => { fixture.setStorySupport(!storySupported); setStorySupported(!storySupported); setNotice("Synthetic story capability changed. Reopen Photo challenges to refresh it; saved stories remain on this device."); }}>{storySupported ? "Simulate older story server" : "Restore story support"}</button>
          <button className={`${cloudControl} border border-border bg-card`} onClick={() => { fixture.failNext(); setNotice("The next synthetic request will fail before mutation. Retry through the normal interface."); }}>Fail next request</button>
          <button className={`${cloudControl} border border-border bg-card`} disabled={!session || busy || uploading} onClick={() => void uploadSample()}>Upload synthetic PNG</button>
          <button className={`${cloudControl} border border-border bg-card`} onClick={() => downloadProjectBlob(fixture.sample, fixture.sample.name)}>Download sample PNG</button>
          <button className={`${cloudControl} border border-border bg-card`} disabled={!session || busy || uploading} onClick={() => void run(async () => { if (!session) return; for (const record of await session.uploads.list()) if (record.state === "ready") await session.uploads.forget(record.id); setNotice("Completed local upload tracking cleared for this synthetic account. Fixture originals remain. Remount to inspect account-based recovery."); })}>Clear completed local tracking</button>
        </>}
        <button className={`${cloudControl} border border-border bg-card`} disabled={busy} onClick={() => void run(async () => { const { runCloudUploadJournalProbe } = await import("@/lib/projects/cloud-upload-probe"); const result = await runCloudUploadJournalProbe(); setProbe(result.checks); })}>Run isolated journal checks</button>
        <button className={`${cloudControl} border border-border bg-card`} disabled={busy} onClick={() => void run(async () => { const { runPartialDraftsProbe } = await import("@/lib/memories/challenge-partial-drafts-probe"); const result = await runPartialDraftsProbe(); setProbe(result.checks); })}>Run partial journal checks</button>
      </div>
      {session && <p className="mt-4 text-sm font-medium">Synthetic account: {session.name}. Seeded private project and {person === 1 ? "owned friendship project" : "friendship invitation"}. {fixture?.people.length} people in this rehearsal.</p>}
      {(busy || uploading) && <p role="status" className="mt-3 text-sm">{uploading ? "Sending synthetic PNG through the real upload manager…" : "Preparing rehearsal…"}</p>}
      {notice && <p role="status" className="mt-3 max-w-3xl text-sm">{notice}</p>}
      {error && <p role="alert" className="mt-3 text-sm">{error}</p>}
      {probe.length > 0 && <details className="mt-4 text-sm" open><summary>{probe.length} native journal checks passed</summary><ul className="mt-2 list-disc space-y-1 pl-5">{probe.map(check => <li key={check}>{check}</li>)}</ul></details>}
      {diagnostics.length > 0 && <details className="mt-4 text-sm"><summary>Recent synthetic requests</summary><ul className="mt-2 space-y-1">{diagnostics.map((entry, index) => <li key={index}>{entry}</li>)}</ul></details>}
    </div></section>
    {session && fixture && <main className="mx-auto max-w-6xl px-5 pb-12"><FixtureContext.Provider value={{ session, fixture }}><CloudLibrary drafts={session.drafts} key={session.key} client={session.client} uploads={session.uploads} ownerId={session.ownerId} ProjectView={ProjectView} /></FixtureContext.Provider></main>}
  </div>;
}
