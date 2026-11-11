"use client";

import Link from "next/link";
import { useMemo } from "react";
import { ArrowLeft, LoaderCircle, LockKeyhole } from "lucide-react";
import { useAuth } from "@/lib/auth";
import type { CloudProjectView } from "@/lib/projects/cloud-contract";
import { CloudLibrary } from "./CloudLibrary";
import { CloudProjectDetail } from "./CloudProjectDetail";
import { PageHeader } from "@/components/ui/PageHeader";
import { useCloudRuntime } from "@/hooks/useCloudRuntime";
import { useBoothSession } from "@/lib/session";
import { useRouter } from "next/navigation";

function AccountCloudLibrary({ ownerId }: { ownerId: string }) {
  const { runtime, error } = useCloudRuntime(ownerId);
  const { openProject } = useBoothSession(), router = useRouter();
  const Detail = useMemo(() => function Detail({ view, onBack }: { view: CloudProjectView; onBack(): void }) { return runtime ? <CloudProjectDetail key={view.project.id} client={runtime.client} uploads={runtime.uploads} designs={runtime.designs} challenges={runtime.challenges} drafts={runtime.drafts} initialView={view} onBack={onBack} onOpenDesign={async result => { runtime.client.assertActive(); await runtime.designs.adoptOpen(result); const { project } = result; await openProject(project.id, project.scope); runtime.client.assertActive(); router.push("/customize"); }} /> : null; }, [runtime, openProject, router]);
  if (error) return <p role="alert" className="notice max-w-2xl border border-destructive/25 bg-destructive/8"><span className="font-bold text-destructive">Couldn&apos;t open your cloud library in this browser.</span> Refresh the page to try again.</p>;
  if (!runtime) return <p role="status" className="panel flex min-h-48 items-center justify-center gap-2 text-sm text-muted-foreground"><LoaderCircle size={18} aria-hidden className="animate-spin motion-reduce:animate-none" /> Opening your cloud library…</p>;
  return <CloudLibrary drafts={runtime.drafts} client={runtime.client} uploads={runtime.uploads} ownerId={ownerId} ProjectView={Detail} />;
}

export function CloudProjectHub() {
  const { user, loading, enabled } = useAuth();
  return <main className="mx-auto flex min-h-dvh w-full max-w-5xl flex-1 flex-col gap-6 px-4 pt-4 pb-10 sm:px-8 sm:pt-6">
    <PageHeader title="Cloud projects" leading={<nav aria-label="Project navigation"><Link href="/projects" className="btn btn-plain -ml-3.5 min-h-10 text-sm"><ArrowLeft size={16} aria-hidden /> My projects</Link></nav>} />
    <div className="page-body flex flex-col gap-5">
      {loading ? <p role="status" className="panel flex min-h-48 items-center justify-center gap-2 text-sm text-muted-foreground"><LoaderCircle size={18} aria-hidden className="animate-spin motion-reduce:animate-none" /> Checking your account…</p> : user && enabled ? <AccountCloudLibrary key={user.id} ownerId={user.id} /> : <section className="panel flex min-h-64 flex-col items-center justify-center gap-4 px-6 py-12 text-center"><span className="glyph size-14 rounded-2xl bg-[#0ea5e9]"><LockKeyhole size={26} aria-hidden /></span><h2 className="font-display text-2xl">{enabled ? "Sign in to open your cloud library" : "Cloud projects aren't available here"}</h2>{enabled && <p className="max-w-sm text-sm text-muted-foreground">Signing in doesn&apos;t upload your device projects.</p>}<div className="flex flex-wrap justify-center gap-2">{enabled && <Link href="/login?next=%2Fprojects%2Fcloud" className="btn btn-primary">Sign in</Link>}<Link href="/projects" className="btn btn-quiet">Open my projects</Link></div></section>}
    </div>
  </main>;
}
