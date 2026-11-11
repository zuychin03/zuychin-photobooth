"use client";

import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { CirclePause, LogOut } from "lucide-react";
import { FeatureIncoming } from "@/components/FeatureIncoming";
import { useKioskLocked } from "@/components/events/EventKioskGuard";
import { incomingFeature, recoveryPausedFeature, recoverySignOutRequested } from "@/lib/release-mode";
import { useAuth } from "@/lib/auth";
import { useBoothSession } from "@/lib/session";
import { useAppNavigationGuard } from "@/components/AppNavigation";

const LocalReleaseContext = createContext(false);
const RecoveryReleaseContext = createContext(false);

export function ReleaseModeProvider({ localOnly, recovery = false, children }: { localOnly: boolean; recovery?: boolean; children: ReactNode }) {
  return <LocalReleaseContext.Provider value={localOnly}><RecoveryReleaseContext.Provider value={recovery}>{children}</RecoveryReleaseContext.Provider></LocalReleaseContext.Provider>;
}

export function useLocalRelease() { return useContext(LocalReleaseContext); }
export function useRecoveryRelease() { return useContext(RecoveryReleaseContext); }

function RecoverySignOut() {
  const { user, loading, signOut } = useAuth();
  const booth = useBoothSession(), heading = useRef<HTMLHeadingElement>(null), owner = useRef<string | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  useLayoutEffect(() => { owner.current = user?.id ?? null; if (!loading) heading.current?.focus(); }, [user?.id, loading]);
  useAppNavigationGuard(() => !busy);
  const leave = async () => {
    if (busy || !user || owner.current !== user.id) return;
    const expectedOwner = user.id;
    setBusy(true); setError(null);
    let resume: (() => void) | undefined;
    try {
      resume = await booth.suspendForSignOut();
      if (owner.current !== expectedOwner) throw new Error("Account changed");
      await signOut();
    } catch { setError("Couldn't sign you out. Check your account and try again."); }
    finally { resume?.(); setBusy(false); }
  };
  return <main className="mx-auto flex min-h-[70dvh] w-full max-w-xl flex-1 flex-col items-center justify-center px-4 py-12">
    <section className="page-head panel flex w-full flex-col items-center gap-5 px-6 py-10 text-center sm:px-10 sm:py-12">
      <span className="glyph size-16 rounded-[1.25rem] bg-[#64748b]"><LogOut size={28} strokeWidth={2.25} aria-hidden /></span>
      <div>
        <h1 ref={heading} tabIndex={-1} className="font-display text-3xl leading-tight outline-none">{loading ? "Checking your account…" : user ? "Sign out of this account?" : "You're signed out"}</h1>
        <p className="mx-auto mt-3 max-w-sm text-sm text-muted-foreground">Your account drafts stay on this device, hidden until you sign in again.</p>
      </div>
      {error && <p role="alert" className="notice w-full border border-destructive/25 bg-destructive/8 font-bold text-destructive">{error}</p>}
      <div className="flex flex-wrap justify-center gap-2">
        {!loading && user && <button disabled={busy} onClick={() => void leave()} className="btn btn-primary">{busy ? "Signing out…" : "Sign out"}</button>}
        <Link href="/projects" aria-disabled={busy || undefined} onNavigate={event => { if (busy) event.preventDefault(); }} className="btn btn-quiet">Your projects</Link>
      </div>
    </section>
  </main>;
}

export function ReleaseFeatureBoundary({ children }: { children: ReactNode }) {
  const localOnly = useLocalRelease(), recovery = useRecoveryRelease(), pathname = usePathname(), search = useSearchParams(), locked = useKioskLocked();
  if (recovery && !locked && recoverySignOutRequested(pathname, search)) return <RecoverySignOut />;
  const feature = recovery ? recoveryPausedFeature(pathname, search) : localOnly ? incomingFeature(pathname, search) : null;
  if (feature && !locked) return <FeatureIncoming feature={feature} recovery={recovery} />;
  return <>{recovery && !locked && <p role="status" className="notice mx-auto mt-3 flex w-[calc(100%-2rem)] max-w-[60rem] items-center gap-2.5 text-muted-foreground sm:w-[calc(100%-4rem)]"><CirclePause size={17} className="shrink-0 text-warning" aria-hidden />New uploads are paused. Your saved projects, photos and downloads remain available.</p>}{children}</>;
}
