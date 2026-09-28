"use client";

import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
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
  return <main className="mx-auto w-full max-w-2xl px-5 py-12">
    <h1 ref={heading} tabIndex={-1} className="font-display text-3xl font-semibold outline-none">{loading ? "Checking your account…" : user ? "Sign out of this account?" : "You're signed out"}</h1>
    <p className="mt-4 text-muted-foreground">Your account drafts stay on this device, hidden until you sign in again.</p>
    {error && <p role="alert" className="mt-4">{error}</p>}
    <div className="mt-6 flex flex-wrap gap-3">
      {!loading && user && <button disabled={busy} onClick={() => void leave()} className="min-h-12 rounded-2xl bg-accent px-5 py-3 font-semibold text-accent-foreground">{busy ? "Signing out…" : "Sign out"}</button>}
      <Link href="/projects" aria-disabled={busy || undefined} onNavigate={event => { if (busy) event.preventDefault(); }} className="inline-flex min-h-12 items-center rounded-2xl border border-border px-5 py-3">Your projects</Link>
    </div>
  </main>;
}

export function ReleaseFeatureBoundary({ children }: { children: ReactNode }) {
  const localOnly = useLocalRelease(), recovery = useRecoveryRelease(), pathname = usePathname(), search = useSearchParams(), locked = useKioskLocked();
  if (recovery && !locked && recoverySignOutRequested(pathname, search)) return <RecoverySignOut />;
  const feature = recovery ? recoveryPausedFeature(pathname, search) : localOnly ? incomingFeature(pathname, search) : null;
  if (feature && !locked) return <FeatureIncoming feature={feature} recovery={recovery} />;
  return <>{recovery && !locked && <p role="status" className="mx-auto w-full max-w-6xl px-5 py-2 text-sm text-muted-foreground sm:px-8">New uploads are paused. Your saved projects, photos and downloads remain available.</p>}{children}</>;
}
