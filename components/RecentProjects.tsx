"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowRight, Clock3 } from "lucide-react";
import { Section } from "@/components/ui/Section";
import { useAuth } from "@/lib/auth";
import { useBoothSession } from "@/lib/session";
import { loadRecentProjects, type RecentProject } from "@/lib/projects/recent";

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
  return <div className="mx-auto mb-8 w-full max-w-6xl px-4 sm:px-8">
    <Section id="recent-projects-title" title="Pick up where you left off" icon={Clock3} tone="violet" action={<Link className="btn btn-plain min-h-10 text-sm" href="/projects">All projects <ArrowRight size={16} aria-hidden /></Link>}>
      {loading ? <p role="status" className="py-2 text-sm text-muted-foreground">Checking recent projects…</p> : error ? <p role="alert" className="py-2 text-sm">Recent projects could not be opened. Use All projects to retry or recover a saved draft.</p> : rows.length ? <ul className="-mx-2 grid gap-1 sm:grid-cols-2 lg:grid-cols-3">{rows.map(row => <li key={row.key} className="flex min-w-0 items-center justify-between gap-3 rounded-2xl px-3 py-2.5 transition-colors hover:bg-muted/60"><div className="min-w-0"><h3 className="truncate font-bold">{row.name}</h3><p className="mt-0.5 text-sm text-muted-foreground">{row.scope.kind === "device" ? "This device" : "Account draft"}{row.readOnly ? " · Recovery available" : ""}</p></div>{row.readOnly ? <Link className="btn btn-quiet min-h-10 shrink-0 text-sm" href="/projects">Recovery</Link> : <button type="button" className="btn btn-tinted min-h-10 shrink-0 text-sm" disabled={Boolean(busy) || session.hydrating} onClick={() => void resume(row)} aria-label={`Continue ${row.name}`}>{busy === row.key ? "Opening…" : "Continue"}</button>}</li>)}</ul> : <p className="py-1 text-sm text-muted-foreground">Nothing saved yet.</p>}
    </Section>
  </div>;
}
