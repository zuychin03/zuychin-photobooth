"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowLeft, BookHeart, CalendarHeart, LoaderCircle } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { createClient } from "@/lib/supabase/client";
import { openMemoryRuntime, type MemoryRuntime } from "@/lib/memories/memory-runtime";
import { PageHeader } from "@/components/ui/PageHeader";
import { MemoryWorkspace } from "./MemoryWorkspace";

function AccountMemories({ ownerId, voiceAvailable }: { ownerId: string; voiceAvailable: boolean }) {
  const [runtime, setRuntime] = useState<MemoryRuntime | null>(null), [error, setError] = useState(false), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true, handle: ReturnType<typeof openMemoryRuntime> | undefined;
    void Promise.resolve().then(async () => {
      if (!active) return;
      const auth = createClient();
      handle = openMemoryRuntime({ ownerId, appOrigin: location.origin, storageOrigin: new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).origin,
        accessToken: async () => { const result = await auth.auth.getSession(); return !result.error && result.data.session?.user.id === ownerId ? result.data.session.access_token : null; },
        subscribe: listener => { const result = auth.auth.onAuthStateChange((_event, session) => listener(session?.user.id ?? null)); return () => result.data.subscription.unsubscribe(); },
        onInvalidated: () => { if (active) { setRuntime(null); setError(true); } },
      });
      const next = await handle.ready; next.activity.assertActive(); if (active) setRuntime(next);
    }).catch(() => { handle?.close(); if (active) { setRuntime(null); setError(true); } });
    return () => { active = false; handle?.close(); };
  }, [ownerId, attempt]);
  if (error) return <section className="notice border border-destructive/25 bg-destructive/8"><p role="alert" className="font-bold text-destructive">Couldn&apos;t check your account. Check your connection and try again.</p><button className="btn btn-quiet mt-3 min-h-10 text-sm" onClick={() => { setError(false); setRuntime(null); setAttempt(value => value + 1); }}>Try again</button></section>;
  return runtime ? <MemoryWorkspace key={`${ownerId}-${attempt}`} runtime={runtime} voiceEnabled={voiceAvailable} /> : <p role="status" className="panel flex min-h-48 items-center justify-center gap-2 text-sm text-muted-foreground"><LoaderCircle size={18} aria-hidden className="animate-spin motion-reduce:animate-none" /> Checking your account…</p>;
}

export function MemoryHub({ available, voiceAvailable = false }: { available: boolean; voiceAvailable?: boolean }) {
  const { user, enabled, loading } = useAuth();
  return <main className="mx-auto flex min-h-dvh w-full max-w-5xl flex-1 flex-col gap-6 px-4 pt-4 pb-10 sm:px-8 sm:pt-6">
    <PageHeader title="Memories" leading={<nav aria-label="Memory navigation"><Link href="/timeline" className="btn btn-plain -ml-3.5 min-h-10 text-sm"><ArrowLeft size={16} aria-hidden /> Your album</Link></nav>} actions={<Link href="/memories/rituals" className="btn btn-quiet"><CalendarHeart size={17} aria-hidden /> Photo rituals</Link>} />
    <div className="page-body flex flex-col gap-5">
      {!available || !enabled ? <section className="panel flex min-h-64 flex-col items-center justify-center gap-4 px-6 py-12 text-center"><span className="glyph size-14 rounded-2xl bg-[#64748b]"><BookHeart size={26} aria-hidden /></span><h2 className="font-display text-2xl">Memories aren&apos;t available here yet</h2><Link href="/projects" className="btn btn-quiet">Open my projects</Link></section> : loading ? <p role="status" className="panel flex min-h-48 items-center justify-center gap-2 text-sm text-muted-foreground"><LoaderCircle size={18} aria-hidden className="animate-spin motion-reduce:animate-none" /> Checking your account…</p> : user ? <AccountMemories key={user.id} ownerId={user.id} voiceAvailable={voiceAvailable} /> : <section className="panel flex min-h-64 flex-col items-center justify-center gap-4 px-6 py-12 text-center"><span className="glyph size-14 rounded-2xl bg-[#8b5cf6]"><BookHeart size={26} aria-hidden /></span><h2 className="font-display text-2xl">Sign in to see your memories</h2><Link href="/login?next=%2Fmemories" className="btn btn-primary">Sign in</Link></section>}
    </div>
  </main>;
}
