"use client";
import { useRecoveryRelease } from "@/components/ReleaseMode";
import { useAppNavigationGuard } from "@/components/AppNavigation";
import type { ChallengeDraftJournal } from "@/lib/memories/challenge-drafts";

import { useEffect, useRef, useState, type ComponentType } from "react";
import { ArrowRight, Check, Cloud, LoaderCircle, LockKeyhole, Mail, Plus, RefreshCw, Users } from "lucide-react";
import { Dropdown } from "@/components/Dropdown";
import { CloudInvitationId } from "./CloudMembers";
import { cloudError, cloudSize } from "./CloudControls";
import { CLOUD_PROJECT_LIMITS, type CloudProjectList, type CloudProjectListItem, type CloudProjectView } from "@/lib/projects/cloud-contract";
import type { CloudProjectClient } from "@/lib/projects/cloud-client";
import type { CloudUploadManager } from "@/lib/projects/cloud-upload";
import { ChallengeDraftRecovery } from "./ChallengeDraftRecovery";
import { CloudUploadRecovery } from "./CloudUploadRecovery";


interface Props {
  client: CloudProjectClient;
  uploads: CloudUploadManager;
  drafts?: ChallengeDraftJournal;
  ownerId: string;
  ProjectView: ComponentType<{ view: CloudProjectView; onBack(): void }>;
}

export function CloudLibrary({ client, uploads, drafts, ownerId, ProjectView }: Props) {
  const recovery = useRecoveryRelease();
  const [listing, setListing] = useState<CloudProjectList>({ projects: [], nextCursor: null });
  const [view, setView] = useState<CloudProjectView | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "unavailable">("loading");
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false), [title, setTitle] = useState("");
  const controller = useRef<AbortController | null>(null), mounted = useRef(false);
  const running = useRef(false);
  const [kind, setKind] = useState<"personal" | "friend">("personal");
  const [creation, setCreation] = useState<{ id: string; title: string; kind: "personal" | "friend" } | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useAppNavigationGuard(() => {
    if (busy || running.current) { setError("Wait for this to finish before you leave."); return false; }
    if (creating) { setError("Finish or cancel the new project first."); return false; }
    return true;
  }, !view);
  const nameInput = useRef<HTMLInputElement>(null), newProjectButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    mounted.current = true;
    const abort = new AbortController(); controller.current = abort;
    void (async () => {
      try {
        await client.capabilities(abort.signal);
        const result = await client.list(undefined, 20, abort.signal);
        if (!abort.signal.aborted) { setListing(result); setState("ready"); }
      } catch { if (!abort.signal.aborted) setState("unavailable"); }
    })();
    return () => { mounted.current = false; abort.abort(); controller.current?.abort(); };
  }, [client]);

  const run = async (work: (signal: AbortSignal) => Promise<void>, capacityMessage?: string) => {
    if (running.current) return;
    running.current = true;
    const abort = new AbortController(); controller.current = abort;
    setBusy(true); setError(null);
    try { await work(abort.signal); }
    catch (failure) { if (!abort.signal.aborted && mounted.current) setError(capacityMessage && failure && typeof failure === "object" && "code" in failure && failure.code === "capacity" ? capacityMessage : cloudError(failure)); }
    finally { running.current = false; if (!abort.signal.aborted && mounted.current) setBusy(false); }
  };
  const refresh = () => run(async signal => {
    await client.capabilities(signal);
    const result = await client.list(undefined, 20, signal);
    if (!signal.aborted) { setListing(result); setState("ready"); }
  });
  const open = (project: CloudProjectListItem) => run(async signal => {
    if (project.membership === "invited") await client.member(project.id, ownerId, "accept", signal);
    const result = await client.view(project.id, signal);
    if (!signal.aborted) { setView(result); setCreating(false); }
  });
  const create = () => run(async signal => {
    if (recovery) return;
    const name = title.trim();
    if (!name) return;
    const pending = creation ?? { id: crypto.randomUUID(), title: name, kind };
    setCreation(pending);
    const project = await client.create({ ...pending, maxBytes: CLOUD_PROJECT_LIMITS.projectBytes }, signal);
    const result = await client.view(project.id, signal);
    if (!signal.aborted) { setCreation(null); setTitle(""); setCreating(false); setView(result); }
  }, "There's no room for another cloud project right now. Try again later.");
  const back = () => { setView(null); setError(null); void refresh(); requestAnimationFrame(() => heading.current?.focus()); };

  if (view) return <ProjectView view={view} onBack={back} />;
  return <section aria-labelledby="cloud-library-heading" className="flex flex-col gap-5">
    <div className="panel overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 p-4 sm:px-6 sm:pt-6 sm:pb-5">
        <div className="flex min-w-0 items-center gap-3"><span className="glyph bg-[#0ea5e9]"><Cloud size={18} strokeWidth={2.25} aria-hidden /></span><div className="min-w-0"><h2 ref={heading} tabIndex={-1} id="cloud-library-heading" className="font-display text-xl leading-tight outline-none">Your cloud library</h2><p className="mt-0.5 text-sm text-muted-foreground">Nothing uploads unless you choose it.</p></div></div>
        {state === "ready" && <div className="flex flex-wrap gap-2"><button className="btn btn-plain min-h-10 text-sm" disabled={busy} onClick={() => void refresh()}><RefreshCw size={15} aria-hidden /> Refresh</button><button ref={newProjectButton} className="btn btn-primary min-h-10 text-sm" disabled={recovery || busy || creating} onClick={() => { setCreating(true); requestAnimationFrame(() => nameInput.current?.focus()); }}><Plus size={17} aria-hidden /> New cloud project</button></div>}
      </div>
      {state === "loading" && <p role="status" className="flex min-h-40 items-center justify-center gap-2 border-t border-border text-sm text-muted-foreground"><LoaderCircle size={18} aria-hidden className="animate-spin motion-reduce:animate-none" /> Connecting…</p>}
      {state === "unavailable" && <div className="flex flex-col items-center gap-3 border-t border-border px-6 py-10 text-center"><h3 className="font-display text-xl">Cloud projects aren&apos;t available right now</h3><button className="btn btn-quiet" disabled={busy} onClick={() => void refresh()}><RefreshCw size={16} aria-hidden /> Check again</button></div>}
      {error && <p role="alert" className="notice mx-4 mb-4 border border-destructive/25 bg-destructive/8 font-bold text-destructive sm:mx-6">{error}</p>}
      {creating && <form className="panel-muted mx-4 mb-4 grid gap-4 p-4 sm:mx-6 sm:grid-cols-2 sm:p-5" onSubmit={event => { event.preventDefault(); void create(); }}>
        <label className="block text-sm font-bold">Project name<input ref={nameInput} className="field mt-1.5 font-medium" value={title} onChange={event => setTitle(event.target.value)} maxLength={100} required disabled={busy || Boolean(creation)} autoComplete="off" /></label>
        <Dropdown label="Who is this project for?" showLabel value={kind} onChange={value => setKind(value as typeof kind)} disabled={busy || Boolean(creation)} options={[{ value: "personal", label: "Only me" }, { value: "friend", label: "Me and invited friends" }]} />
        <p className="text-sm text-muted-foreground sm:col-span-2">{kind === "personal" ? "Only you can see it." : "You can invite up to three friends. They see photos once they accept."} You can&apos;t change this later. Storage: {cloudSize(CLOUD_PROJECT_LIMITS.projectBytes)}.</p>
        <div className="flex flex-wrap gap-2 sm:col-span-2"><button className="btn btn-primary" disabled={recovery || busy || !title.trim()}>{creation ? "Try again" : kind === "personal" ? "Create private project" : "Create shared project"}</button><button type="button" className="btn btn-quiet" disabled={busy} onClick={() => { setCreating(false); setCreation(null); setTitle(""); requestAnimationFrame(() => newProjectButton.current?.focus()); }}>Cancel</button></div>
        {creation && !busy && <p className="text-sm text-muted-foreground sm:col-span-2">The last attempt might have worked. Try again to finish it, or refresh the library first.</p>}
      </form>}
      {state === "ready" && <>
        {listing.projects.length ? <ul aria-label="Cloud projects" className="divide-y divide-border border-t border-border">{listing.projects.map(project => <li key={project.id} className="flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-4 sm:px-6">
          <span className={`flex size-12 shrink-0 items-center justify-center rounded-2xl ${project.membership === "invited" ? "bg-partner/15 text-partner" : "bg-muted text-muted-foreground"}`}>{project.membership === "invited" ? <Mail size={20} aria-hidden /> : project.kind === "personal" ? <LockKeyhole size={20} aria-hidden /> : <Users size={20} aria-hidden />}</span>
          <div className="min-w-0 flex-1 basis-40"><h3 className="break-words text-lg font-bold">{project.title}</h3><p className="mt-0.5 text-sm text-muted-foreground">{project.membership === "invited" ? "Invitation" : project.kind === "personal" ? "Only you" : "Shared project"} · {new Date(project.createdAt).toLocaleDateString("en-AU")}</p></div>
          <button className={`btn min-h-10 shrink-0 text-sm ${project.membership === "invited" ? "btn-partner" : "btn-quiet"}`} disabled={busy || recovery && project.membership === "invited"} onClick={() => void open(project)}>{project.membership === "invited" ? <><Check size={16} aria-hidden /> Accept invitation</> : <>Open project <ArrowRight size={16} aria-hidden /></>}</button>
        </li>)}</ul> : <p className="border-t border-border px-6 py-10 text-center font-display text-xl">No cloud projects yet</p>}
        {listing.nextCursor && <div className="border-t border-border p-3 text-center"><button className="btn btn-quiet text-sm" disabled={busy} onClick={() => void run(async signal => { const result = await client.list(listing.nextCursor!, 20, signal); if (!signal.aborted) setListing(previous => ({ projects: [...previous.projects, ...result.projects.filter(item => !previous.projects.some(old => old.id === item.id))], nextCursor: result.nextCursor })); })}>Show more</button></div>}
      </>}
    </div>
    {busy && <p role="status" className="flex items-center gap-2 text-sm font-bold"><LoaderCircle size={16} aria-hidden className="animate-spin text-accent motion-reduce:animate-none" /> Updating…</p>}
    <div className="grid gap-5 lg:grid-cols-2 lg:[&>:only-child]:col-span-2">
      {state === "ready" && <CloudInvitationId ownerId={ownerId} />}
      {!recovery && drafts && <ChallengeDraftRecovery journal={drafts} disabled={busy} runAction={run} openProject={id => void run(async signal => { const result = await client.view(id, signal); if (!signal.aborted) { setView(result); setCreating(false); } })} />}
      <CloudUploadRecovery uploads={uploads} disabled={busy} runAction={run} openProject={id => void run(async signal => { const result = await client.view(id, signal); if (!signal.aborted) { setView(result); setCreating(false); } })} />
    </div>
  </section>;
}
