"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowRight } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useBoothSession } from "@/lib/session";
import { loadRecentProjects, type RecentProject } from "@/lib/projects/recent";

const control = "inline-flex min-h-11 items-center gap-2 rounded-xl px-3 text-sm font-medium hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50";
export function RecentProjects() {
  const { user, loading } = useAuth();
  return <RecentProjectList key={loading ? "loading" : user?.id ?? "device"} ownerId={loading ? null : user?.id ?? null} authLoading={loading} />;
}
function RecentProjectList({ ownerId, authLoading }: { ownerId: string | null; authLoading: boolean }) {
  const session = useBoothSession(), router = useRouter(), active = useRef(false), working = useRef(false);
  const [rows, setRows] = useState<RecentProject[]>([]), [loading, setLoading] = useState(true), [busy, setBusy] = useState<string | null>(null), [error, setError] = useState(false);
  useLayoutEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    if (authLoading) return;
    let current = true;
    const check = () => { if (!current || !active.current) throw new Error("cancelled"); };
    void loadRecentProjects(ownerId, check).then(result => { check(); setRows(result); }).catch(() => { if (current && active.current) setError(true); }).finally(() => { if (current && active.current) setLoading(false); });
    return () => { current = false; };
  }, [ownerId, authLoading]);
  const resume = async (row: RecentProject) => {
    if (working.current || !active.current || authLoading || row.scope.kind === "account" && row.scope.ownerId !== ownerId) return;
    working.current = true; setBusy(row.key); setError(false);
    try {
      const project = await session.openProject(row.id, row.scope);
      if (!active.current) return;
      router.push(project.media.some(media => media.kind === "photo") ? "/customize" : "/booth");
    } catch { if (active.current) setError(true); }
    finally { working.current = false; if (active.current) setBusy(null); }
  };
  return <section aria-labelledby="recent-projects-title" className="mx-auto mb-10 w-full max-w-5xl border-t border-border px-6 pt-7">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 id="recent-projects-title" className="font-display text-2xl">Pick up where you left off</h2><Link className={control} href="/projects">All projects <ArrowRight size={16} aria-hidden /></Link></div>
    <p className="mt-2 text-sm text-muted-foreground">On this device{ownerId ? ", including your account drafts" : ""}. No automatic uploads.</p>
    {loading ? <p role="status" className="py-5 text-sm text-muted-foreground">Checking recent projects…</p> : error ? <p role="alert" className="py-5 text-sm">Recent projects could not be opened. Use All projects to retry or recover a saved draft.</p> : rows.length ? <ul className="mt-4 divide-y divide-border">{rows.map(row => <li key={row.key} className="flex min-w-0 items-center justify-between gap-4 py-3"><div className="min-w-0"><h3 className="break-words font-medium">{row.name}</h3><p className="mt-1 text-sm text-muted-foreground">{row.scope.kind === "device" ? "Device project" : "Account draft"}{row.readOnly ? " · Recovery available" : ""}</p></div>{row.readOnly ? <Link className={`${control} shrink-0`} href="/projects">Recovery</Link> : <button className={`${control} shrink-0`} disabled={Boolean(busy) || session.hydrating} onClick={() => void resume(row)} aria-label={`Continue ${row.name}`}>{busy === row.key ? "Opening…" : "Continue"}<ArrowRight size={16} aria-hidden /></button>}</li>)}</ul> : <p className="py-5 text-sm text-muted-foreground">Your next saved project will appear here. Start a booth session or import a project from your library.</p>}
  </section>;
}
