"use client";

import { useAppNavigationGuard } from "@/components/AppNavigation";

import { Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  Bookmark,
  BookmarkCheck,
  CalendarHeart,
  Check,
  Clock,
  Copy,
  Flame,
  Heart,
  Loader2,
  Sparkles,
  Trash2,
  Unlink,
} from "lucide-react";
import { useAuth, type SignOutResult } from "@/lib/auth";
import { useBoothSession } from "@/lib/session";
import { normalizeRoomCode } from "@/lib/room-code";
import {
  Couple,
  TimelineStrip,
  createCouple,
  deleteStrip,
  getMyCouple,
  joinCouple,
  listStrips,
  saveStrip,
  setStripKept,
  unpair,
} from "@/lib/couple";
import { WEEKLY_STRIP_CAP, daysUntilPurge, isRetained } from "@/lib/retention";
import { Relay, listRelays, relayIsMyTurn } from "@/lib/relay";
import { sameIsoWeek, startOfIsoWeek, weeklyStreak } from "@/lib/streak";
import {
  CADENCES,
  Cadence,
  PhotoDate,
  createPhotoDate,
  deletePhotoDate,
  listPhotoDates,
} from "@/lib/photo-dates";
import { renderWeeklyRecap, weeklyStripUrl } from "@/lib/recap";
import { createClient } from "@/lib/supabase/client";
import { PushToggle } from "@/components/PushToggle";
import { Dropdown } from "@/components/Dropdown";

export default function TimelinePage() {
  return <Suspense fallback={<main className="min-h-dvh p-6" role="status">Opening your Shared Vault…</main>}><TimelineContent /></Suspense>;
}

function TimelineContent() {
  const router = useRouter(), search = useSearchParams();
  const { user, loading, enabled, signOut } = useAuth();
  const boothSession = useBoothSession();
  const [signOutOpen, setSignOutOpen] = useState(false);
  const [unpairTarget, setUnpairTarget] = useState<{ coupleId: string; ownerId: string } | null>(null);
  const vaultHeading = useRef<HTMLHeadingElement>(null), unpairButton = useRef<HTMLButtonElement>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [signOutResult, setSignOutResult] = useState<SignOutResult | null>(null);
  const signOutHeading = useRef<HTMLHeadingElement>(null), signOutOwner = useRef<string | null>(null);

  const [couple, setCouple] = useState<Couple | null>(null);
  const [strips, setStrips] = useState<TimelineStrip[]>([]);
  const [relays, setRelays] = useState<Relay[]>([]);
  const [dates, setDates] = useState<PhotoDate[]>([]);
  const [ready, setReady] = useState(false);
  const [dateForm, setDateForm] = useState<{ title: string; when: string; cadence: Cadence } | null>(null);
  const [recapBusy, setRecapBusy] = useState(false);
  const [datePending, setDatePending] = useState(false);
  const [joinInput, setJoinInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [loadErr, setLoadErr] = useState(false);
  const [copied, setCopied] = useState(false);
  const [keepNote, setKeepNote] = useState<string | null>(null);
  const [mediaBusy, setMediaBusy] = useState<string | null>(null);
  const [dataOwner, setDataOwner] = useState<string | null>(null);
  const requestedSignOut = search.get("signout") === "1";
  useEffect(() => {
    if (!requestedSignOut || loading || !user || dataOwner !== user.id) return;
    let current = true;
    queueMicrotask(() => {
      if (!current) return;
      const url = new URL(location.href);
      if (url.searchParams.get("signout") !== "1") return;
      url.searchParams.delete("signout");
      window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
      signOutOwner.current = user.id;
      setSignOutError(null); setSignOutResult(null); setSignOutOpen(true);
    });
    return () => { current = false; };
  }, [requestedSignOut, loading, user, dataOwner]);
  useLayoutEffect(() => { if (signOutOpen) signOutHeading.current?.focus(); }, [signOutOpen, signOutResult, dataOwner]);
  useEffect(() => {
    if (!user || !signOutOwner.current || user.id === signOutOwner.current) return;
    queueMicrotask(() => { if (signOutOwner.current !== user.id) { setSignOutOpen(false); setSignOutError(null); setSignOutResult(null); } });
  }, [user]);
  useAppNavigationGuard(() => {
    if (busy || recapBusy || signingOut || dateForm || datePending || unpairTarget) {
      setErr("Finish the current work or close the reminder form before leaving. Unconfirmed reminders need the same retry."); return false;
    }
    return true;
  });
  const loadGeneration = useRef(0);
  const activeOwner = useRef<string | null>(user?.id ?? null);
  const formOwner = useRef<string | null>(null);
  const mediaRequests = useRef(new Map<string, string>());
  const recapWork = useRef<AbortController | null>(null), actionWork = useRef<AbortController | null>(null);
  const dateRequest = useRef<{ fingerprint: string; id: string } | null>(null);
  const mediaRequest = (key: string) => {
    if (!mediaRequests.current.has(key)) mediaRequests.current.set(key, crypto.randomUUID());
    return mediaRequests.current.get(key)!;
  };

  const refresh = useCallback(async () => {
    if (!user || activeOwner.current !== user.id) return;
    const generation = ++loadGeneration.current;
    setReady(false);
    setLoadErr(false);
    try {
      const [c, s, r, d] = await Promise.all([
        getMyCouple(user.id),
        listStrips(user.id),
        listRelays().catch(() => [] as Relay[]),
        listPhotoDates(),
      ]);
      if (generation !== loadGeneration.current) return;
      setCouple(c);
      setStrips(s);
      setRelays(r);
      setDates(d);
      setDataOwner(user.id);
    } catch (e) {
      if (generation !== loadGeneration.current) return;
      console.error("[album] load failed", e);
      setCouple(null); setStrips([]); setRelays([]); setDates([]); setDataOwner(user.id);
      setLoadErr(true);
    } finally {
      if (generation === loadGeneration.current) setReady(true);
    }
  }, [user]);

  useEffect(() => {
    if (enabled && !loading && !user && !signOutOpen) router.replace("/login?next=/timeline");
  }, [enabled, loading, user, router, signOutOpen]);

  const finishSignOut = async (removeLocalCopies: boolean) => {
    const owner = signOutOwner.current;
    if (!owner || user?.id !== owner || activeOwner.current !== owner || signingOut) return;
    recapWork.current?.abort(); actionWork.current?.abort();
    setSigningOut(true); setSignOutError(null);
    let resume: (() => void) | undefined;
    try {
      resume = await boothSession.suspendForSignOut();
      if (activeOwner.current !== owner) throw new Error("The active account changed. Open sign-out again for this account.");
      setSignOutResult(await signOut({ removeLocalCopies }));
    } catch (error) { setSignOutError(error instanceof Error ? error.message : "Sign-out could not finish. Please try again."); }
    finally { resume?.(); setSigningOut(false); }
  };

  const signOutPanel = <section className="rounded-2xl border border-border bg-card p-5" aria-labelledby="sign-out-title">
    <h2 ref={signOutHeading} tabIndex={-1} id="sign-out-title" className="font-display text-xl font-semibold outline-none">{signOutResult ? "You are signed out" : "Sign out of this account?"}</h2>
    {signOutResult ? <>
      <p className="mt-3 text-sm">{signOutResult.localCopies === "kept" ? "Your account drafts are hidden on this device. They will reappear when you sign in to the same account." : signOutResult.cleanupError ? "Sign-out finished, but local draft removal could not be completed. Remaining drafts are hidden. Sign in again and use My projects to review them." : `${signOutResult.cleanup?.removed ?? 0} account draft${signOutResult.cleanup?.removed === 1 ? "" : "s"} removed from this browser.`}</p>
      {Boolean(signOutResult.cleanup?.retained) && <p className="mt-2 text-sm">{signOutResult.cleanup!.retained} draft{signOutResult.cleanup!.retained === 1 ? " was" : "s were"} kept hidden because the format needs recovery, the project changed, or removal could not finish. Sign in again to keep recovery backups.</p>}
      {signOutResult.cleanup?.incomplete && <p className="mt-2 text-sm">Not every removal could be verified. Sign in again to review any remaining local drafts.</p>}
      {signOutResult.roomCleanup && <p className="mt-2 text-sm">Private room checkpoints and temporary transfers for this account were removed from this browser.</p>}
      <button type="button" onClick={() => router.replace("/")} className="mt-4 min-h-11 rounded-xl bg-accent px-4 text-sm font-semibold text-accent-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">Back to booth</button>
    </> : <>
      <p className="mt-3 max-w-xl text-sm text-foreground/75">Account drafts are stored in this browser. Keep them hidden for next time, or remove their local copies. Export important projects before removing them.</p>
      <p className="mt-2 max-w-xl text-sm text-foreground/75">Device projects and cloud memories stay available. Drafts that need recovery or a newer app will be kept hidden.</p>
      {boothSession.storageStatus === "error" && <p className="mt-3 text-sm font-medium">Some recent edits were not saved. Keeping drafts retains their last saved checkpoint; go back and export or retry before leaving if you need those edits.</p>}
      {signOutError && <p role="alert" className="mt-3 text-sm font-medium">{signOutError}</p>}
      {signingOut ? <p role="status" className="mt-4 flex items-center gap-2 text-sm"><Loader2 size={16} className="animate-spin motion-reduce:animate-none" aria-hidden /> Finishing sign-out and your local draft choice…</p> : <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" onClick={() => void finishSignOut(false)} className="min-h-11 rounded-xl bg-accent px-4 text-sm font-semibold text-accent-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">Sign out and keep drafts</button>
        <button type="button" onClick={() => void finishSignOut(true)} className="min-h-11 rounded-xl border border-border px-4 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">Sign out and remove local copies</button>
        {user && <button type="button" onClick={() => { setSignOutOpen(false); requestAnimationFrame(() => vaultHeading.current?.focus()); }} className="min-h-11 rounded-xl px-4 text-sm font-medium hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">Cancel</button>}
      </div>}
    </>}
  </section>;

  useEffect(() => {
    let active = true;
    activeOwner.current = user?.id ?? null;
    queueMicrotask(() => {
      if (!active) return;
      if (formOwner.current !== (user?.id ?? null)) {
        setDateForm(null); setUnpairTarget(null); setJoinInput(""); setErr(null); setKeepNote(null);
        setBusy(false); setRecapBusy(false); setDatePending(false); dateRequest.current = null;
        mediaRequests.current.clear(); formOwner.current = user?.id ?? null;
      }
      if (user) void refresh();
    });
    const generation = loadGeneration;
    const owner = activeOwner;
    const stop = () => { recapWork.current?.abort(); actionWork.current?.abort(); recapWork.current = null; actionWork.current = null; };
    const subscription = enabled ? createClient().auth.onAuthStateChange((_event, session) => { if (session?.user.id !== user?.id) { owner.current = null; stop(); } }).data.subscription : null;
    const hidden = () => { if (document.hidden) recapWork.current?.abort(); };
    document.addEventListener("visibilitychange", hidden);
    return () => { active = false; generation.current++; owner.current = null; stop(); subscription?.unsubscribe(); document.removeEventListener("visibilitychange", hidden); };
  }, [user, refresh, enabled]);

  const paired = !!couple?.member_b;
  const pending = !!couple && !couple.member_b;
  const streak = weeklyStreak(strips.map((s) => s.created_at));
  const openRelays = relays.filter((r) => r.status === "pending");
  const now = new Date();
  const thisWeekCount = strips.filter((s) => s.layout_id !== "recap" && s.url && sameIsoWeek(new Date(s.created_at), now)).length;
  const weekSaved = strips.filter(
    (s) => s.layout_id !== "recap" && sameIsoWeek(new Date(s.created_at), now),
  ).length;
  const expiringCount = strips.filter((s) => s.mine && !isRetained(s)).length;

  const toggleKeep = async (strip: TimelineStrip) => {
    if (mediaBusy) return;
    const kept = !strip.kept;
    const key = `keep:${strip.id}:${kept}`;
    setMediaBusy(strip.id);
    setKeepNote(null);
    try {
      const result = await setStripKept(strip.id, kept, mediaRequest(key));
      if (result.pending) {
        setKeepNote("Your archive change is queued. Refresh shortly to check whether it has finished.");
      } else {
        setStrips(list => list.map(value => value.id === strip.id ? { ...value, kept: result.kept } : value));
        mediaRequests.current.delete(key);
        setKeepNote(result.kept && result.pushed ? "Your strip is archived." : "Your archive change is complete.");
      }
    } catch (error) {
      setKeepNote(error instanceof Error ? error.message : "The archive change failed. Please try again.");
    } finally {
      setMediaBusy(null);
    }
  };

  const removeStrip = async (strip: TimelineStrip) => {
    if (mediaBusy) return;
    const key = `delete:${strip.id}`;
    setMediaBusy(strip.id);
    setKeepNote(null);
    try {
      const result = await deleteStrip(strip, mediaRequest(key));
      if (result.pending) setKeepNote("Deletion is queued. The strip stays visible until cleanup is confirmed. Refresh shortly to check.");
      else {
        setStrips(list => list.filter(value => value.id !== strip.id));
        mediaRequests.current.delete(key);
        setKeepNote("The strip has been deleted.");
      }
    } catch (error) {
      setKeepNote(error instanceof Error ? error.message : "Deletion failed. Please try again.");
    } finally {
      setMediaBusy(null);
    }
  };

  const runVaultAction = async (operation: (signal: AbortSignal, check: () => void) => Promise<void>) => {
    if (!user || actionWork.current) return;
    const owner = user.id, job = new AbortController(); actionWork.current = job; setBusy(true); setErr(null);
    const check = () => { if (job.signal.aborted || activeOwner.current !== owner) throw new Error("The active account changed. Refresh the vault."); };
    try {
      check(); const { data, error } = await createClient().auth.getSession(); check();
      if (error || data.session?.user.id !== owner) throw new Error("Sign in again before changing the vault.");
      await operation(job.signal, check);
    } catch (error) {
      if (activeOwner.current === owner && !job.signal.aborted) setErr(error instanceof Error ? error.message : "The change could not be confirmed. Refresh and try again.");
    } finally {
      if (actionWork.current === job) actionWork.current = null;
      if (activeOwner.current === owner && !job.signal.aborted) setBusy(false);
    }
  };

  const handleCreate = () => runVaultAction(async (_signal, check) => { const created = await createCouple(user!.id); check(); setCouple(created); });
  const handleJoin = () => runVaultAction(async (_signal, check) => { await joinCouple(normalizeRoomCode(joinInput)); check(); await refresh(); });

  const handleUnpair = (target?: { coupleId: string; ownerId: string }) => runVaultAction(async (_signal, check) => {
    if (!couple) return;
    if (target && (target.coupleId !== couple.id || target.ownerId !== user?.id || !couple.member_b)) throw new Error("The pairing changed. Refresh before trying again.");
    recapWork.current?.abort();
    await unpair(couple.id);
    check();
    setUnpairTarget(null); setCouple(null);
    await refresh();
    check(); setKeepNote("Pairing ended. Your own saved strips and local originals remain.");
    requestAnimationFrame(() => vaultHeading.current?.focus());
  });

  const addDate = () => runVaultAction(async (signal, check) => {
    if (!user || !couple || !dateForm?.title || !dateForm.when) return;
    const fingerprint = JSON.stringify([user.id, couple.id, dateForm]);
    if (dateRequest.current && dateRequest.current.fingerprint !== fingerprint) throw new Error("Confirm the pending reminder before starting another.");
    if (dateRequest.current?.fingerprint !== fingerprint) dateRequest.current = { fingerprint, id: crypto.randomUUID() };
    setDatePending(true);
    await createPhotoDate(user.id, couple.id, {
      title: dateForm.title,
      scheduledAt: new Date(dateForm.when).toISOString(),
      cadence: dateForm.cadence,
    }, { id: dateRequest.current.id, signal });
    check(); dateRequest.current = null; setDatePending(false);
    setDateForm(null);
    await refresh();
  });

  const removeDate = (id: string) => runVaultAction(async (signal, check) => {
    await deletePhotoDate(id, { signal }); check();
    setDates((list) => list.filter((d) => d.id !== id));
  });

  const makeRecap = async () => {
    if (!user || recapWork.current) return;
    const owner = user.id, originalCouple = couple?.id ?? null, job = new AbortController(); recapWork.current = job;
    let downloaded = false;
    const check = () => { if (job.signal.aborted || activeOwner.current !== owner || document.hidden) throw new Error("Recap cancelled. Refresh the vault before trying again."); };
    setRecapBusy(true); setKeepNote(null);
    try {
      const now = new Date();
      const weekStrips = strips.filter((s) => s.layout_id !== "recap" && sameIsoWeek(new Date(s.created_at), now) && s.url);
      if (weekStrips.length === 0) return;
      const supabase = createClient(), origin = process.env.NEXT_PUBLIC_SUPABASE_URL;
      if (!origin) throw new Error("Private photo downloads are unavailable here.");
      const assertAccount = async () => { check(); const { data, error } = await supabase.auth.getSession(); check(); if (error || data.session?.user.id !== owner) throw new Error("The active account changed. Reopen your vault."); };
      const sources = weekStrips.map(strip => ({ id: strip.id, async resolve(signal: AbortSignal) {
        await assertAccount();
        const { data, error } = await supabase.from("pb_strips").select("id,owner,couple_id,storage_path,created_at,purged").eq("id", strip.id).abortSignal(signal).maybeSingle(); check();
        if (error || !data || data.purged || data.owner !== strip.owner || data.couple_id !== strip.couple_id || data.storage_path !== strip.storage_path || data.created_at !== strip.created_at) throw new Error("A source photo is no longer available. Refresh the vault.");
        if (data.owner !== owner) { const current = await getMyCouple(owner, signal); check(); if (!current || current.id !== data.couple_id || ![current.member_a, current.member_b].includes(data.owner)) throw new Error("Access to a shared photo changed. Refresh the vault."); }
        const signed = await supabase.storage.from("photobooth-strips").createSignedUrl(data.storage_path, 60); check();
        if (signed.error || !signed.data?.signedUrl) throw new Error("A source photo could not be opened. Refresh and try again.");
        return { url: weeklyStripUrl(signed.data.signedUrl, origin.replace(/\/$/, ""), data.storage_path), fingerprint: JSON.stringify(data) };
      } }));
      const weekOf = startOfIsoWeek(now).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      });
      const title = `Week of ${weekOf}`;
      const { blob } = await renderWeeklyRecap(sources, title, { signal: job.signal, assertActive: check });
      await assertAccount(); check();
      const url = URL.createObjectURL(blob);
      try { check(); const a = document.createElement("a"); a.href = url; a.download = `zuychin-recap-week-of-${weekOf.replace(/\s+/g, "-").toLowerCase()}.png`; a.click(); downloaded = true; }
      finally { setTimeout(() => URL.revokeObjectURL(url), 30000); }
      for (const source of sources) { await source.resolve(job.signal); check(); }
      const currentCouple = await getMyCouple(owner, job.signal); await assertAccount();
      if ((currentCouple?.id ?? null) !== originalCouple) throw new Error("Pairing changed. The downloaded recap was not saved to the vault.");
      check(); await saveStrip(owner, originalCouple, blob, { layoutId: "recap", caption: `${title} recap` }, { id: mediaRequest(`recap:${weekOf}:${weekStrips.map(strip => strip.id).join(",")}`) }); check();
      setKeepNote("Your recap was sent to downloads and saved to the Shared Vault.");
      await refresh();
    } catch (error) {
      if (activeOwner.current === owner && recapWork.current === job) setKeepNote(job.signal.aborted ? "Recap cancelled. No further download or save will start." : `${downloaded ? "Your recap was sent to downloads, but its vault save could not be confirmed. " : ""}${error instanceof Error ? error.message : "The recap could not finish. Your original strips are unchanged. Refresh and try again."}`);
    } finally {
      if (recapWork.current === job) { recapWork.current = null; if (activeOwner.current === owner) setRecapBusy(false); }
    }
  };

  const copyCode = async () => {
    if (!couple?.pair_code) return;
    await navigator.clipboard.writeText(couple.pair_code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  if (!enabled) {
    return (
      <main className="flex min-h-dvh flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="text-lg font-semibold">The Shared Vault isn&apos;t available here</p>
        <p className="max-w-sm text-sm text-muted-foreground">
          Accounts are unavailable here. You can still use the booth.
        </p>
        <button onClick={() => router.push("/")} className="rounded-full bg-accent px-5 py-2.5 font-semibold text-accent-foreground">
          Back to booth
        </button>
      </main>
    );
  }

  if (!user && signOutOpen) return <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-1 flex-col justify-center px-5 py-8">{signOutPanel}</main>;

  if (loading || !user) {
    return (
      <main className="flex min-h-dvh flex-1 items-center justify-center">
        <Loader2 className="animate-spin text-muted-foreground" />
      </main>
    );
  }

  if (dataOwner !== user.id) return <main className="flex min-h-dvh flex-1 items-center justify-center gap-2" role="status"><Loader2 size={20} className="animate-spin motion-reduce:animate-none text-muted-foreground" aria-hidden /> Opening your Shared Vault…</main>;

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-3xl flex-1 flex-col gap-6 px-5 py-6">
      <header className="flex items-center justify-between">
        <h1 ref={vaultHeading} tabIndex={-1} className="text-xl font-semibold outline-none" style={{ fontFamily: "var(--font-fraunces)" }}>
          Shared Vault
        </h1>
        <div className="flex items-center gap-2">
          <PushToggle userId={user.id} />
        </div>
      </header>
      {signOutOpen && signOutPanel}
      {unpairTarget && unpairTarget.ownerId === user.id && unpairTarget.coupleId === couple?.id && <UnpairConfirmation busy={busy} error={err} onCancel={() => { setUnpairTarget(null); requestAnimationFrame(() => unpairButton.current?.focus()); }} onConfirm={() => void handleUnpair(unpairTarget)} />}
      {err && <div role="alert" className="rounded-xl border border-destructive/30 p-3 text-sm"><p>{err}</p><button disabled={busy} onClick={() => void refresh()} className="mt-1 min-h-11 underline disabled:opacity-50">Refresh vault status</button></div>}
      {keepNote && (
        <div role="status" className="rounded-xl bg-muted/60 px-3 py-2 text-sm">
          <p>{keepNote}</p>
          <button onClick={() => void refresh()} className="mt-1 underline">Refresh status</button>
        </div>
      )}

      {/* Pairing */}
      {!paired && (
        <section className="glass-card rounded-2xl p-5">
          <div className="mb-2 flex items-center gap-2 font-semibold">
            <Heart size={18} className="text-accent" /> Pair with your partner
          </div>
          {pending ? (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-muted-foreground">
                Share this code with your partner so your strips land in one Shared
                Vault.
              </p>
              <div className="flex items-center gap-2">
                <span className="rounded-xl bg-muted px-4 py-2 font-mono text-lg tracking-[0.3em]">
                  {couple!.pair_code}
                </span>
                <button
                  onClick={copyCode}
                  className="flex min-h-11 items-center gap-2 rounded-xl bg-accent/15 px-4 text-sm font-medium text-accent"
                >
                  {copied ? <Check size={16} /> : <Copy size={16} />}
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <button disabled={busy} onClick={() => void handleUnpair()} className="min-h-11 self-start text-xs text-muted-foreground underline disabled:opacity-50">
                Cancel this code
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-4 sm:flex-row">
              <button
                onClick={handleCreate}
                disabled={busy}
                className="flex-1 rounded-xl bg-accent px-4 py-3 font-semibold text-accent-foreground disabled:opacity-50"
              >
                Create a pairing code
              </button>
              <div className="flex flex-1 items-center gap-2">
                <input
                  aria-label="Pairing code"
                  value={joinInput}
                  onChange={(e) => setJoinInput(normalizeRoomCode(e.target.value))}
                  placeholder="Enter code"
                  className="min-h-12 w-full min-w-0 flex-1 rounded-xl border border-border bg-card px-4 font-mono tracking-[0.2em] uppercase outline-none focus:border-partner"
                />
                <button
                  onClick={handleJoin}
                  disabled={busy || joinInput.length < 6}
                  className="min-h-12 rounded-xl bg-partner/15 px-4 font-semibold text-partner disabled:opacity-50"
                >
                  Join
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      {paired && (
        <div className="flex items-center justify-between rounded-2xl bg-muted/60 px-4 py-2 text-sm">
          <span className="flex items-center gap-2 font-medium">
            <Heart size={15} className="text-accent" /> Paired
            {streak > 0 && (
              <span className="ml-2 flex items-center gap-1 text-warning">
                <Flame size={14} /> {streak} week{streak > 1 ? "s" : ""}
              </span>
            )}
          </span>
          <button ref={unpairButton} disabled={busy || recapBusy || Boolean(mediaBusy) || datePending} onClick={() => { setErr(null); setUnpairTarget({ coupleId: couple!.id, ownerId: user.id }); }} className="flex min-h-11 items-center gap-1 text-xs text-muted-foreground disabled:opacity-50">
            <Unlink size={13} /> Unpair
          </button>
        </div>
      )}

      {/* Relay strips */}
      {paired && (
        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-muted-foreground">Relay strips</h2>
            <button
              onClick={() => router.push("/relay/new")}
              className="flex min-h-9 items-center gap-1.5 rounded-full bg-accent/15 px-3 text-xs font-semibold text-accent"
            >
              <Clock size={14} /> Start a relay
            </button>
          </div>
          {ready && openRelays.length > 0 && (
            <div className="flex flex-col gap-2">
              {openRelays.map((r) => {
                const myTurn = relayIsMyTurn(r, user.id);
                return (
                  <button
                    key={r.id}
                    onClick={() => router.push(`/relay/${r.id}`)}
                    className={`flex items-center justify-between rounded-xl border px-4 py-3 text-left text-sm ${
                      myTurn ? "border-accent bg-accent/10" : "border-border"
                    }`}
                  >
                    <span className="font-medium">
                      {myTurn ? "Your turn to finish a relay" : "Waiting for your partner"}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {new Date(r.created_at).toLocaleDateString()}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </section>
      )}

      {/* Photo dates */}
      {paired && (
        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-muted-foreground">Photo dates</h2>
            <button
              disabled={busy || datePending}
              onClick={() =>
                setDateForm(dateForm ? null : { title: "", when: "", cadence: "weekly" })
              }
              className="flex min-h-9 items-center gap-1.5 rounded-full bg-accent/15 px-3 text-xs font-semibold text-accent"
            >
              <CalendarHeart size={14} /> Schedule
            </button>
          </div>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            <Link href="/memories" className="min-h-11 content-center text-sm font-medium text-accent underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring">Browse memories and chapters</Link>
            <Link href="/memories/rituals" className="min-h-11 content-center text-sm font-medium text-accent underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring">Open photo rituals and timezone settings</Link>
          </div>
          {dateForm && (
            <div className="glass-card flex flex-col gap-2 rounded-xl p-3">
              <input
                disabled={busy || datePending}
                aria-label="Reminder occasion"
                value={dateForm.title}
                onChange={(e) => setDateForm({ ...dateForm, title: e.target.value })}
                placeholder="What's the occasion?"
                className="min-h-11 rounded-lg border border-border bg-card px-3 outline-none focus:border-accent"
              />
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  disabled={busy || datePending}
                  aria-label="Reminder date and time"
                  type="datetime-local"
                  value={dateForm.when}
                  onChange={(e) => setDateForm({ ...dateForm, when: e.target.value })}
                  className="min-h-11 min-w-0 flex-1 rounded-lg border border-border bg-card px-3 text-sm outline-none focus:border-accent"
                />
                <Dropdown disabled={busy || datePending} label="Repeat photo date" value={dateForm.cadence} onChange={value => setDateForm({ ...dateForm, cadence: value as Cadence })} options={CADENCES.map(cadence => ({ value: cadence.id, label: cadence.label }))} className="min-w-28" />
              </div>
              <button
                onClick={addDate}
                disabled={busy || !dateForm.title || !dateForm.when}
                className="min-h-11 rounded-lg bg-accent font-semibold text-accent-foreground disabled:opacity-50"
              >
                {busy ? "Saving…" : datePending ? "Retry this reminder" : "Set reminder"}
              </button>
              {datePending && !busy && <p className="text-sm">This reminder has not been confirmed. Retry the same request before creating another. Once confirmed, you can delete it from the list.</p>}
              <p className="text-xs text-muted-foreground">
                Both of you get an email when it&apos;s time.
              </p>
            </div>
          )}
          {ready && dates.length > 0 && (
            <div className="flex flex-col gap-2">
              {dates.map((d) => (
                <div key={d.id} className="flex items-center justify-between rounded-xl border border-border px-4 py-2.5 text-sm">
                  <div className="flex flex-col">
                    <span className="font-medium">{d.title}</span>
                    <span className="text-xs text-muted-foreground">
                      {new Date(d.scheduled_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}
                      {d.cadence !== "once" && ` · ${CADENCES.find((c) => c.id === d.cadence)?.label.toLowerCase()}`}
                    </span>
                  </div>
                  <button disabled={busy} onClick={() => void removeDate(d.id)} aria-label="Delete photo date" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50">
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Strips */}
      {!ready ? (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="animate-spin text-muted-foreground" />
        </div>
      ) : loadErr ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center text-muted-foreground">
          <p>Couldn&apos;t load your Shared Vault.</p>
          <button
            onClick={() => void refresh()}
            className="rounded-full bg-accent px-5 py-2.5 font-semibold text-accent-foreground"
          >
            Try again
          </button>
        </div>
      ) : strips.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center text-muted-foreground">
          <p>No strips saved yet.</p>
          <button onClick={() => router.push("/")} className="rounded-full bg-accent px-5 py-2.5 font-semibold text-accent-foreground">
            Take some photos
          </button>
        </div>
      ) : (
        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-muted-foreground">
              {weekSaved}/{WEEKLY_STRIP_CAP} this week
            </h2>
            {thisWeekCount > 1 && (
              <button
                onClick={makeRecap}
                disabled={recapBusy}
                className="flex min-h-9 items-center gap-1.5 rounded-full bg-accent/15 px-3 text-xs font-semibold text-accent disabled:opacity-50"
              >
                <Sparkles size={14} /> {recapBusy ? "Making…" : "Make this week's recap"}
              </button>
            )}
            {recapBusy && <button onClick={() => recapWork.current?.abort()} className="min-h-11 px-2 text-sm underline">Cancel recap</button>}
          </div>
          {expiringCount > 0 && (
            <p className="rounded-xl bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
              The vault clears when the week resets. Bookmark a strip to keep it
              before then.
            </p>
          )}
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          {strips.map((s) => (
            <figure key={s.id} className="group relative">
              {s.url && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={s.url}
                  alt={s.caption ?? "Photo strip"}
                  className="w-full rounded-lg border border-border shadow-sm"
                />
              )}
              {s.mine && s.layout_id !== "recap" && (
                <button
                  onClick={() => toggleKeep(s)}
                  disabled={mediaBusy !== null}
                  aria-label={s.kept ? "Kept, tap to release" : "Keep this strip"}
                  aria-pressed={s.kept}
                  className={`absolute right-1.5 top-1.5 flex h-11 w-11 items-center justify-center rounded-full border border-border bg-card shadow-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50 ${
                    s.kept ? "text-accent" : "text-muted-foreground"
                  }`}
                >
                  {s.kept ? <BookmarkCheck size={15} /> : <Bookmark size={15} />}
                </button>
              )}
              <figcaption className="mt-1 flex flex-wrap items-center justify-between text-xs text-muted-foreground">
                <span className="flex flex-wrap items-center gap-1.5">
                  {new Date(s.created_at).toLocaleDateString()}
                  {(() => {
                    const d = daysUntilPurge(s);
                    if (d === null || d > 2) return null;
                    return (
                      <span className="text-warning">
                        {d === 0 ? "expiring" : `${d}d left`}
                      </span>
                    );
                  })()}
                </span>
                {s.mine && (
                  <button
                    onClick={() => void removeStrip(s)}
                    disabled={mediaBusy !== null}
                    aria-label="Delete strip"
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
                  >
                    <Trash2 size={14} className="text-destructive" />
                  </button>
                )}
              </figcaption>
            </figure>
          ))}
          </div>
        </section>
      )}
    </main>
  );
}


function UnpairConfirmation({ busy, error, onCancel, onConfirm }: { busy: boolean; error: string | null; onCancel(): void; onConfirm(): void }) {
  const dialog = useRef<HTMLDialogElement>(null), keep = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal(); keep.current?.focus();
    return () => element?.close();
  }, []);
  return <dialog ref={dialog} aria-labelledby="unpair-title" aria-describedby="unpair-description" onCancel={event => { event.preventDefault(); if (!busy) onCancel(); }} className="m-auto max-h-[calc(100dvh_-_2rem)] w-[calc(100%_-_2rem)] max-w-lg overflow-y-auto rounded-2xl border border-border bg-card p-5 text-foreground shadow-xl backdrop:bg-black/50">
    <h2 id="unpair-title" className="font-display text-xl font-semibold">End this pairing?</h2>
    <div id="unpair-description" className="mt-3 space-y-2 text-sm leading-relaxed">
      <p>You will lose access to each other’s strips. Shared relays and photo dates will be removed, and relay photo cleanup will be queued.</p>
      <p>Each person keeps their own saved strips and local originals. Save any finished relay to your vault or export it first.</p>
    </div>
    {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
    {busy && <p role="status" className="mt-3 text-sm">Ending the pairing…</p>}
    <div className="mt-5 flex flex-wrap gap-3">
      <button ref={keep} disabled={busy} onClick={onCancel} className="min-h-11 rounded-xl border border-border px-4 text-sm font-semibold disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-ring">Stay paired</button>
      <button disabled={busy} onClick={onConfirm} className="min-h-11 rounded-xl bg-destructive px-4 text-sm font-semibold text-white disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-ring">End pairing</button>
    </div>
  </dialog>;
}
