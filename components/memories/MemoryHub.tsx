"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { createClient } from "@/lib/supabase/client";
import { openMemoryRuntime, type MemoryRuntime } from "@/lib/memories/memory-runtime";
import { cloudControl } from "@/components/cloud/CloudControls";
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
  if (error) return <section className="mt-9"><p role="alert" className="text-sm">Your account could not be checked. Check your sign-in and connection, then try again.</p><button className={`${cloudControl} mt-4 border border-border`} onClick={() => { setError(false); setRuntime(null); setAttempt(value => value + 1); }}>Try again</button></section>;
  return runtime ? <MemoryWorkspace key={`${ownerId}-${attempt}`} runtime={runtime} voiceEnabled={voiceAvailable} /> : <p role="status" className="mt-9">Checking your account…</p>;
}

export function MemoryHub({ available, voiceAvailable = false }: { available: boolean; voiceAvailable?: boolean }) {
  const { user, enabled, loading } = useAuth();
  return <main className="mx-auto min-h-dvh max-w-5xl px-5 py-6 sm:px-8 sm:py-8"><nav aria-label="Memory navigation" className="flex flex-wrap justify-between gap-2"><Link href="/timeline" className={`${cloudControl} -ml-4 hover:bg-muted`}><ArrowLeft size={17} aria-hidden /> Your album</Link><Link href="/memories/rituals" className={`${cloudControl} border border-border`}>Photo rituals</Link></nav><header className="mt-8"><h1 className="font-display text-4xl font-semibold sm:text-5xl">A life in little moments</h1><p className="mt-3 max-w-xl leading-relaxed text-foreground/75">Revisit your photos, organise chapters and make a yearly recap.</p></header>
    {!available || !enabled ? <section className="mt-9 border-t border-border py-8"><h2 className="font-display text-2xl">Memories are not available here yet</h2><p className="mt-3 max-w-xl text-sm leading-relaxed text-foreground/75">Your existing album and projects are still here.</p><Link href="/projects" className={`${cloudControl} mt-5 border border-border`}>Open device projects</Link></section> : loading ? <p role="status" className="mt-9">Checking your account…</p> : user ? <AccountMemories key={user.id} ownerId={user.id} voiceAvailable={voiceAvailable} /> : <section className="mt-9 border-t border-border py-8"><h2 className="font-display text-2xl">Sign in to revisit your memories</h2><p className="mt-3 text-sm">Your chapters and occasion labels stay with your account.</p><Link href="/login?next=%2Fmemories" className={`${cloudControl} mt-5 bg-accent text-accent-foreground`}>Sign in</Link></section>}
  </main>;
}
