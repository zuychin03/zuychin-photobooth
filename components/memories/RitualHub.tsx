"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowLeft, Bell, CalendarHeart, HeartHandshake, LoaderCircle } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { createClient } from "@/lib/supabase/client";
import { getMyCouple, type Couple } from "@/lib/couple";
import { createRitualClient, type RitualClient } from "@/lib/memories/ritual-client";
import { PushToggle } from "@/components/PushToggle";
import { PageHeader } from "@/components/ui/PageHeader";
import { RitualWorkspace } from "./RitualWorkspace";

function AccountRituals({ ownerId }: { ownerId: string }) {
  const [state, setState] = useState<{ client: RitualClient; couple: Couple | null } | null>(null), [error, setError] = useState(false), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let mounted = true, identity: { ownerId: string; epoch: number } | null = { ownerId, epoch: attempt }, client: RitualClient | undefined, unsubscribe: (() => void) | undefined;
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 10_000);
    const stop = () => { identity = null; client?.close(); controller.abort(); };
    void Promise.resolve().then(async () => {
      if (!mounted || controller.signal.aborted) return;
      const auth = createClient();
      const subscription = auth.auth.onAuthStateChange((_event, session) => { if (session?.user.id !== ownerId) { stop(); if (mounted) { setState(null); setError(true); } } });
      unsubscribe = () => subscription.data.subscription.unsubscribe();
      client = createRitualClient({ appOrigin: location.origin, identity: () => identity, accessToken: async () => { const result = await auth.auth.getSession(); return !result.error && result.data.session?.user.id === ownerId ? result.data.session.access_token : null; } });
      const couple = await getMyCouple(ownerId, controller.signal); client.assertActive(controller.signal);
      if (mounted) { setState({ client, couple }); setError(false); }
    }).catch(() => { stop(); unsubscribe?.(); if (mounted) { setState(null); setError(true); } }).finally(() => clearTimeout(timeout));
    return () => { mounted = false; clearTimeout(timeout); stop(); unsubscribe?.(); };
  }, [ownerId, attempt]);
  if (error) return <div className="notice border border-destructive/25 bg-destructive/8"><p role="alert" className="font-bold text-destructive">Couldn&apos;t check your account or pairing. Check your connection and try again.</p><button className="btn btn-quiet mt-3 min-h-10 text-sm" onClick={() => { setError(false); setState(null); setAttempt(value => value + 1); }}>Try again</button></div>;
  if (!state) return <p role="status" className="panel flex min-h-48 items-center justify-center gap-2 text-sm text-muted-foreground"><LoaderCircle size={18} aria-hidden className="animate-spin motion-reduce:animate-none" /> Checking your account…</p>;
  if (!state.couple?.member_b) return <section className="panel flex min-h-64 flex-col items-center justify-center gap-4 px-6 py-12 text-center"><span className="glyph size-14 rounded-2xl bg-[#8b5cf6]"><HeartHandshake size={26} aria-hidden /></span><h2 className="font-display text-2xl">Pair with your partner first</h2><Link href="/timeline" className="btn btn-primary">Open album</Link></section>;
  return <><div className="panel flex min-h-16 flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6"><span className="flex items-center gap-3 font-bold"><span className="glyph bg-[#64748b]"><Bell size={18} strokeWidth={2.25} aria-hidden /></span>Notifications on this device</span><PushToggle key={ownerId} userId={ownerId} /></div><RitualWorkspace key={`${ownerId}-${state.couple.id}-${attempt}`} client={state.client} coupleId={state.couple.id} /></>;
}

export function RitualHub({ available }: { available: boolean }) {
  const { user, loading, enabled } = useAuth();
  return <main className="mx-auto flex min-h-dvh w-full max-w-5xl flex-1 flex-col gap-6 px-4 pt-4 pb-10 sm:px-8 sm:pt-6">
    <PageHeader title="Photo rituals" leading={<nav aria-label="Memory navigation"><Link href="/timeline" className="btn btn-plain -ml-3.5 min-h-10 text-sm"><ArrowLeft size={16} aria-hidden /> Your album</Link></nav>} />
    <div className="page-body flex flex-col gap-5">
      {!available || !enabled ? <section className="panel flex min-h-64 flex-col items-center justify-center gap-4 px-6 py-12 text-center"><span className="glyph size-14 rounded-2xl bg-[#64748b]"><CalendarHeart size={26} aria-hidden /></span><h2 className="font-display text-2xl">Rituals aren&apos;t available here yet</h2><Link href="/projects" className="btn btn-quiet">Open my projects</Link></section> : loading ? <p role="status" className="panel flex min-h-48 items-center justify-center gap-2 text-sm text-muted-foreground"><LoaderCircle size={18} aria-hidden className="animate-spin motion-reduce:animate-none" /> Checking your account…</p> : user ? <AccountRituals key={user.id} ownerId={user.id} /> : <section className="panel flex min-h-64 flex-col items-center justify-center gap-4 px-6 py-12 text-center"><span className="glyph size-14 rounded-2xl bg-[#f59e0b]"><CalendarHeart size={26} aria-hidden /></span><h2 className="font-display text-2xl">Sign in to plan a ritual</h2><p className="max-w-sm text-sm text-muted-foreground">Rituals are shared with your paired partner.</p><Link href="/login?next=%2Fmemories%2Frituals" className="btn btn-primary">Sign in</Link></section>}
    </div>
  </main>;
}
