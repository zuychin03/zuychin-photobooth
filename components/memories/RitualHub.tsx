"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowLeft, LoaderCircle } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { createClient } from "@/lib/supabase/client";
import { getMyCouple, type Couple } from "@/lib/couple";
import { createRitualClient, type RitualClient } from "@/lib/memories/ritual-client";
import { cloudControl } from "@/components/cloud/CloudControls";
import { PushToggle } from "@/components/PushToggle";
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
  if (error) return <div className="mt-9"><p role="alert" className="max-w-xl text-sm leading-relaxed">Your account or pairing could not be checked. Check your connection and sign-in, then try again.</p><button className={`${cloudControl} mt-4 border border-border`} onClick={() => { setError(false); setState(null); setAttempt(value => value + 1); }}>Try again</button></div>;
  if (!state) return <p role="status" className="mt-9 flex items-center gap-2"><LoaderCircle size={18} aria-hidden className="animate-spin motion-reduce:animate-none" /> Checking your account and pairing…</p>;
  if (!state.couple?.member_b) return <section className="mt-9 border-t border-border py-8"><h2 className="font-display text-2xl">Choose your photo partner first</h2><p className="mt-3 max-w-xl text-sm leading-relaxed text-foreground/75">Rituals belong to your current pair. Open your album to create or join a pairing, then return here.</p><Link href="/timeline" className={`${cloudControl} mt-5 bg-accent text-accent-foreground`}>Open album</Link></section>;
  return <><div className="mt-7 flex items-center gap-3 text-sm"><span>Notifications on this device</span><PushToggle key={ownerId} userId={ownerId} /></div><RitualWorkspace key={`${ownerId}-${state.couple.id}-${attempt}`} client={state.client} coupleId={state.couple.id} /></>;
}

export function RitualHub({ available }: { available: boolean }) {
  const { user, loading, enabled } = useAuth();
  return <main className="mx-auto min-h-dvh max-w-4xl px-5 py-6 sm:px-8 sm:py-8"><nav aria-label="Memory navigation"><Link href="/timeline" className={`${cloudControl} -ml-4 hover:bg-muted`}><ArrowLeft size={17} aria-hidden /> Your album</Link></nav><header className="mt-8"><h1 className="font-display text-4xl font-semibold sm:text-5xl">Photo rituals</h1><p className="mt-3 max-w-xl leading-relaxed text-foreground/75">Plan your next photo together.</p></header>
    {!available || !enabled ? <section className="mt-9 border-t border-border py-8"><h2 className="font-display text-2xl">Rituals are not available here yet</h2><p className="mt-3 max-w-xl text-sm leading-relaxed text-foreground/75">You can still create photos and return to your existing album.</p><Link href="/projects" className={`${cloudControl} mt-5 border border-border`}>Open device projects</Link></section> : loading ? <p role="status" className="mt-9">Checking your account…</p> : user ? <AccountRituals key={user.id} ownerId={user.id} /> : <section className="mt-9 border-t border-border py-8"><h2 className="font-display text-2xl">Sign in to plan a ritual</h2><p className="mt-3 text-sm">Your reminders stay with your account and current photo partner.</p><Link href="/login?next=%2Fmemories%2Frituals" className={`${cloudControl} mt-5 bg-accent text-accent-foreground`}>Sign in</Link></section>}
  </main>;
}
