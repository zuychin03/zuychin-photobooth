"use client";

import Link from "next/link";
import { useMemo } from "react";
import { ArrowLeft, LoaderCircle, LockKeyhole } from "lucide-react";
import { useAuth } from "@/lib/auth";
import type { CloudProjectView } from "@/lib/projects/cloud-contract";
import { CloudLibrary } from "./CloudLibrary";
import { cloudControl } from "./CloudControls";
import { CloudProjectDetail } from "./CloudProjectDetail";
import { useCloudRuntime } from "@/hooks/useCloudRuntime";
import { useBoothSession } from "@/lib/session";
import { useRouter } from "next/navigation";

function AccountCloudLibrary({ ownerId }: { ownerId: string }) {
  const { runtime, error } = useCloudRuntime(ownerId);
  const { openProject } = useBoothSession(), router = useRouter();
  const Detail = useMemo(() => function Detail({ view, onBack }: { view: CloudProjectView; onBack(): void }) { return runtime ? <CloudProjectDetail key={view.project.id} client={runtime.client} uploads={runtime.uploads} designs={runtime.designs} challenges={runtime.challenges} drafts={runtime.drafts} initialView={view} onBack={onBack} onOpenDesign={async result => { runtime.client.assertActive(); await runtime.designs.adoptOpen(result); const { project } = result; await openProject(project.id, project.scope); runtime.client.assertActive(); router.push("/customize"); }} /> : null; }, [runtime, openProject, router]);
  if (error) return <p role="alert" className="mt-8 max-w-xl rounded-xl bg-muted p-4 leading-relaxed">Cloud upload recovery could not be opened in this browser. Refresh this page to try again. Your local projects and files are still available.</p>;
  if (!runtime) return <p role="status" className="mt-10 flex items-center gap-2"><LoaderCircle size={18} aria-hidden className="animate-spin motion-reduce:animate-none" /> Opening your account&apos;s cloud library…</p>;
  return <CloudLibrary drafts={runtime.drafts} client={runtime.client} uploads={runtime.uploads} ownerId={ownerId} ProjectView={Detail} />;
}

export function CloudProjectHub() {
  const { user, loading, enabled } = useAuth();
  return <main className="mx-auto min-h-dvh w-full max-w-5xl px-5 py-6 sm:px-8 sm:py-8">
    <nav aria-label="Project navigation"><Link href="/projects" className={`${cloudControl} -ml-4 hover:bg-muted`}><ArrowLeft size={17} aria-hidden /> Device projects</Link></nav>
    <header className="mt-8"><h1 className="font-display text-4xl font-semibold sm:text-5xl">Cloud projects</h1><p className="mt-3 max-w-xl leading-relaxed text-foreground/70">Your cloud originals and shared projects.</p></header>
    {loading ? <p role="status" className="mt-10 flex items-center gap-2"><LoaderCircle size={18} aria-hidden className="animate-spin motion-reduce:animate-none" /> Checking your account…</p> : user && enabled ? <AccountCloudLibrary key={user.id} ownerId={user.id} /> : <section className="mt-8 border-t border-border py-9"><LockKeyhole size={26} aria-hidden className="text-foreground/60" /><h2 className="mt-4 font-display text-2xl">{enabled ? "Sign in to open your cloud library" : "Cloud projects are unavailable here"}</h2><p className="mt-3 max-w-lg leading-relaxed text-foreground/70">{enabled ? "Your device projects stay local. Signing in does not upload them." : "You can keep creating, editing and backing up projects on this device."}</p><div className="mt-5 flex flex-wrap gap-3">{enabled && <Link href="/login?next=%2Fprojects%2Fcloud" className={`${cloudControl} bg-accent text-accent-foreground`}>Sign in</Link>}<Link href="/projects" className={`${cloudControl} border border-border`}>Open device projects</Link></div></section>}
  </main>;
}
