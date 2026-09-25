"use client";
import { useAppNavigationGuard } from "@/components/AppNavigation";
import type { ChallengeDraftJournal } from "@/lib/memories/challenge-drafts";

import { useEffect, useRef, useState, type ComponentType } from "react";
import { Check, Cloud, LoaderCircle, Plus, RefreshCw } from "lucide-react";
import { Dropdown } from "@/components/Dropdown";
import { CloudInvitationId } from "./CloudMembers";
import { cloudControl, cloudError, cloudInput, cloudSize } from "./CloudControls";
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
    if (busy || running.current) { setError("Wait for the current project action to finish before leaving."); return false; }
    if (creating) { setError("Finish or cancel the project form before leaving."); return false; }
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
    const name = title.trim();
    if (!name) return;
    const pending = creation ?? { id: crypto.randomUUID(), title: name, kind };
    setCreation(pending);
    const project = await client.create({ ...pending, maxBytes: CLOUD_PROJECT_LIMITS.projectBytes }, signal);
    const result = await client.view(project.id, signal);
    if (!signal.aborted) { setCreation(null); setTitle(""); setCreating(false); setView(result); }
  }, "Cloud storage cannot allocate another project right now. Your existing cloud and device projects are unchanged. Try again later.");
  const back = () => { setView(null); setError(null); void refresh(); requestAnimationFrame(() => heading.current?.focus()); };

  if (view) return <ProjectView view={view} onBack={back} />;
  return <section aria-labelledby="cloud-library-heading" className="mt-8">
    <div className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-6">
      <div><h2 ref={heading} tabIndex={-1} id="cloud-library-heading" className="font-display text-3xl font-semibold outline-none">Your cloud library</h2><p className="mt-2 max-w-xl text-sm leading-relaxed text-foreground/70">Upload only what you choose. Originals are shared only with accepted members.</p></div>
      {state === "ready" && <button ref={newProjectButton} className={`${cloudControl} bg-accent text-accent-foreground`} disabled={busy || creating} onClick={() => { setCreating(true); requestAnimationFrame(() => nameInput.current?.focus()); }}><Plus size={17} aria-hidden /> New cloud project</button>}
    </div>
    {state === "loading" && <p role="status" className="flex min-h-48 items-center gap-2 text-foreground/70"><LoaderCircle size={18} aria-hidden className="animate-spin motion-reduce:animate-none" /> Checking cloud availability…</p>}
    {state === "unavailable" && <div className="py-10"><Cloud size={26} className="text-foreground/60" aria-hidden /><h3 className="mt-4 font-display text-2xl">Cloud projects are unavailable here</h3><p className="mt-3 max-w-lg leading-relaxed text-foreground/70">Your local projects still work. Nothing is uploaded while this connection is unavailable.</p><button className={`${cloudControl} mt-5 border border-border`} disabled={busy} onClick={() => void refresh()}><RefreshCw size={16} aria-hidden /> Check again</button></div>}
    {error && <p role="alert" className="mt-4 rounded-xl bg-muted p-4 text-sm leading-relaxed">{error}</p>}
    {creating && <form className="mt-6 max-w-lg space-y-4 border-b border-border pb-6" onSubmit={event => { event.preventDefault(); void create(); }}>
      <label className="block text-sm font-medium">Project name<input ref={nameInput} className={`${cloudInput} mt-2`} value={title} onChange={event => setTitle(event.target.value)} maxLength={100} required disabled={busy || Boolean(creation)} autoComplete="off" /></label>
      <Dropdown label="Who is this project for?" showLabel value={kind} onChange={value => setKind(value as typeof kind)} disabled={busy || Boolean(creation)} options={[{ value: "personal", label: "Only me" }, { value: "friend", label: "Me and invited friends" }]} />
      <p className="text-sm leading-relaxed text-foreground/70">{kind === "personal" ? "This project stays private to you." : "Invite up to three friends after creating it. They must accept before seeing originals."} This choice cannot change later. Uploads use its {cloudSize(CLOUD_PROJECT_LIMITS.projectBytes)} allowance; your device library stays separate.</p>
      <div className="flex flex-wrap gap-2"><button className={`${cloudControl} bg-accent text-accent-foreground`} disabled={busy || !title.trim()}>{creation ? "Retry creating project" : kind === "personal" ? "Create private project" : "Create shared project"}</button><button type="button" className={cloudControl} disabled={busy} onClick={() => { setCreating(false); setCreation(null); setTitle(""); requestAnimationFrame(() => newProjectButton.current?.focus()); }}>Cancel</button></div>
      {creation && !busy && <p className="text-sm text-foreground/70">The last request may have reached the server. Retry keeps the same project, or refresh the library before starting another.</p>}
    </form>}
    {state === "ready" && <>
      <div className="my-3 flex items-center justify-between gap-3"><p className="text-sm text-foreground/70">{listing.projects.length ? "Saved projects and invitations" : "No cloud projects yet"}</p><button className={cloudControl} disabled={busy} onClick={() => void refresh()}><RefreshCw size={15} aria-hidden /> Refresh</button></div>
      {listing.projects.length ? <ul aria-label="Cloud projects">{listing.projects.map(project => <li key={project.id} className="flex flex-col gap-4 border-t border-border py-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0"><h3 className="break-words text-lg font-medium">{project.title}</h3><p className="mt-1 text-sm text-foreground/70">{project.membership === "invited" ? "Invitation to a shared project" : project.kind === "personal" ? "Only you" : "Shared project"} · {new Date(project.createdAt).toLocaleDateString("en-AU")}</p></div>
        <button className={`${cloudControl} shrink-0 self-start ${project.membership === "invited" ? "bg-accent text-accent-foreground" : "border border-border hover:bg-muted"}`} disabled={busy} onClick={() => void open(project)}>{project.membership === "invited" ? <><Check size={16} aria-hidden /> Accept invitation</> : "Open project"}</button>
      </li>)}</ul> : <div className="py-10"><h3 className="font-display text-2xl">Keep the originals you want to return to.</h3><p className="mt-3 max-w-lg leading-relaxed text-foreground/70">Create a cloud project to upload photos. Device projects stay separate.</p></div>}
      {listing.nextCursor && <button className={`${cloudControl} mt-4 border border-border`} disabled={busy} onClick={() => void run(async signal => { const result = await client.list(listing.nextCursor!, 20, signal); if (!signal.aborted) setListing(previous => ({ projects: [...previous.projects, ...result.projects.filter(item => !previous.projects.some(old => old.id === item.id))], nextCursor: result.nextCursor })); })}>Show more cloud projects</button>}
    </>}
    {state === "ready" && <CloudInvitationId ownerId={ownerId} />}
    {drafts && <ChallengeDraftRecovery journal={drafts} disabled={busy} runAction={run} openProject={id => void run(async signal => { const result = await client.view(id, signal); if (!signal.aborted) { setView(result); setCreating(false); } })} />}
    <CloudUploadRecovery uploads={uploads} disabled={busy} runAction={run} openProject={id => void run(async signal => { const result = await client.view(id, signal); if (!signal.aborted) { setView(result); setCreating(false); } })} />
    {busy && <p role="status" className="mt-4 flex items-center gap-2 text-sm"><LoaderCircle size={16} aria-hidden className="animate-spin motion-reduce:animate-none" /> Updating your cloud library…</p>}
  </section>;
}
