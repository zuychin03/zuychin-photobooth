"use client";

import { useAppNavigationGuard } from "@/components/AppNavigation";

import { Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  BookHeart,
  Bookmark,
  BookmarkCheck,
  CalendarDays,
  CalendarHeart,
  Camera,
  Check,
  Clock,
  Copy,
  Flame,
  Heart,
  Images,
  Loader2,
  LogOut,
  Plus,
  RefreshCw,
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
import { PageHeader } from "@/components/ui/PageHeader";
import { Section } from "@/components/ui/Section";
import { useStickyTop } from "@/components/ui/useStickyTop";

export default function TimelinePage() {
  return <Suspense fallback={<main className="flex min-h-dvh flex-1 items-center justify-center p-6 text-sm text-muted-foreground" role="status">Opening your Shared Vault…</main>}><TimelineContent /></Suspense>;
}

function TimelineContent() {
  const router = useRouter(), search = useSearchParams();
  const { user, loading, enabled, signOut } = useAuth();
  const boothSession = useBoothSession();
  const [signOutOpen, setSignOutOpen] = useState(false);
  const [unpairTarget, setUnpairTarget] = useState<{ coupleId: string; ownerId: string } | null>(null);
  const vaultHeading = useRef<HTMLHeadingElement>(null), unpairButton = useRef<HTMLButtonElement>(null), vaultSidebar = useStickyTop();
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
      setErr("Finish what you're doing or close the reminder form before you leave. If a reminder didn't go through, retry it first."); return false;
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
      if (activeOwner.current !== owner) throw new Error("You switched accounts. Open sign out again for this account.");
      setSignOutResult(await signOut({ removeLocalCopies }));
    } catch (error) { setSignOutError(error instanceof Error ? error.message : "Couldn't sign you out. Try again."); }
    finally { resume?.(); setSigningOut(false); }
  };

  const signOutPanel = <section className="panel p-4 sm:p-6" aria-labelledby="sign-out-title">
    <div className="flex min-w-0 items-center gap-3"><span className="glyph bg-[#64748b]"><LogOut size={18} strokeWidth={2.25} aria-hidden /></span><h2 ref={signOutHeading} tabIndex={-1} id="sign-out-title" className="font-display text-xl leading-tight outline-none">{signOutResult ? "You're signed out" : "Sign out of this account?"}</h2></div>
    {signOutResult ? <>
      <p className="mt-3 text-sm">{signOutResult.localCopies === "kept" ? "Your account drafts are hidden on this device. They'll come back when you sign in to this account again." : signOutResult.cleanupError ? "You're signed out, but some drafts couldn't be deleted from this device. They're hidden for now, so sign in again and check My projects." : `Deleted ${signOutResult.cleanup?.removed ?? 0} account draft${signOutResult.cleanup?.removed === 1 ? "" : "s"} from this browser.`}</p>
      {Boolean(signOutResult.cleanup?.retained) && <p className="mt-2 text-sm">{signOutResult.cleanup!.retained} draft{signOutResult.cleanup!.retained === 1 ? " was" : "s were"} hidden instead of deleted.</p>}
      {signOutResult.cleanup?.incomplete && <p className="mt-2 text-sm">We couldn&apos;t confirm every draft was deleted. Sign in again to check.</p>}
      {signOutResult.roomCleanup && <p className="mt-2 text-sm">Room data for this account was cleared from this browser too.</p>}
      <button type="button" onClick={() => router.replace("/")} className="btn btn-primary mt-4">Back to booth</button>
    </> : <>
      <p className="mt-3 text-sm text-muted-foreground">Your account drafts are saved in this browser. Hide them until you sign in again, or delete them. Export anything important before deleting.</p>
      {boothSession.storageStatus === "error" && <p className="notice mt-3 font-bold text-warning">Some recent edits didn&apos;t save. Keeping drafts keeps only the last save. Go back to export or retry first.</p>}
      {signOutError && <p role="alert" className="notice mt-3 border border-destructive/25 bg-destructive/8 font-bold text-destructive">{signOutError}</p>}
      {signingOut ? <p role="status" className="mt-4 flex items-center gap-2 text-sm font-bold"><Loader2 size={16} className="animate-spin text-accent motion-reduce:animate-none" aria-hidden /> Signing you out…</p> : <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" onClick={() => void finishSignOut(false)} className="btn btn-primary">Sign out and keep drafts</button>
        <button type="button" onClick={() => void finishSignOut(true)} className="btn btn-danger h-auto py-2.5 text-center whitespace-normal">Sign out and delete drafts from this device</button>
        {user && <button type="button" onClick={() => { setSignOutOpen(false); requestAnimationFrame(() => vaultHeading.current?.focus()); }} className="btn btn-plain">Cancel</button>}
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
        setKeepNote("Saving your change. Refresh soon to check it worked.");
      } else {
        setStrips(list => list.map(value => value.id === strip.id ? { ...value, kept: result.kept } : value));
        mediaRequests.current.delete(key);
        setKeepNote(result.kept && result.pushed ? "Your strip is archived." : "All done.");
      }
    } catch (error) {
      setKeepNote(error instanceof Error ? error.message : "Couldn't update that strip. Try again.");
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
      if (result.pending) setKeepNote("Deleting the strip. Refresh soon to check it's gone.");
      else {
        setStrips(list => list.filter(value => value.id !== strip.id));
        mediaRequests.current.delete(key);
        setKeepNote("Strip deleted.");
      }
    } catch (error) {
      setKeepNote(error instanceof Error ? error.message : "Couldn't delete the strip. Try again.");
    } finally {
      setMediaBusy(null);
    }
  };

  const runVaultAction = async (operation: (signal: AbortSignal, check: () => void) => Promise<void>) => {
    if (!user || actionWork.current) return;
    const owner = user.id, job = new AbortController(); actionWork.current = job; setBusy(true); setErr(null);
    const check = () => { if (job.signal.aborted || activeOwner.current !== owner) throw new Error("You switched accounts. Refresh the vault."); };
    try {
      check(); const { data, error } = await createClient().auth.getSession(); check();
      if (error || data.session?.user.id !== owner) throw new Error("Sign in again before changing the vault.");
      await operation(job.signal, check);
    } catch (error) {
      if (activeOwner.current === owner && !job.signal.aborted) setErr(error instanceof Error ? error.message : "Couldn't confirm that change. Refresh and try again.");
    } finally {
      if (actionWork.current === job) actionWork.current = null;
      if (activeOwner.current === owner && !job.signal.aborted) setBusy(false);
    }
  };

  const handleCreate = () => runVaultAction(async (_signal, check) => { const created = await createCouple(user!.id); check(); setCouple(created); });
  const handleJoin = () => runVaultAction(async (_signal, check) => { await joinCouple(normalizeRoomCode(joinInput)); check(); await refresh(); });

  const handleUnpair = (target?: { coupleId: string; ownerId: string }) => runVaultAction(async (_signal, check) => {
    if (!couple) return;
    if (target && (target.coupleId !== couple.id || target.ownerId !== user?.id || !couple.member_b)) throw new Error("Your pairing changed. Refresh and try again.");
    recapWork.current?.abort();
    await unpair(couple.id);
    check();
    setUnpairTarget(null); setCouple(null);
    await refresh();
    check(); setKeepNote("You're no longer paired. Your own strips and photos are still here.");
    requestAnimationFrame(() => vaultHeading.current?.focus());
  });

  const addDate = () => runVaultAction(async (signal, check) => {
    if (!user || !couple || !dateForm?.title || !dateForm.when) return;
    const fingerprint = JSON.stringify([user.id, couple.id, dateForm]);
    if (dateRequest.current && dateRequest.current.fingerprint !== fingerprint) throw new Error("Finish setting up the last reminder before you add another.");
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
    const check = () => { if (job.signal.aborted || activeOwner.current !== owner || document.hidden) throw new Error("Recap cancelled. Refresh the vault and try again."); };
    setRecapBusy(true); setKeepNote(null);
    try {
      const now = new Date();
      const weekStrips = strips.filter((s) => s.layout_id !== "recap" && sameIsoWeek(new Date(s.created_at), now) && s.url);
      if (weekStrips.length === 0) return;
      const supabase = createClient(), origin = process.env.NEXT_PUBLIC_SUPABASE_URL;
      if (!origin) throw new Error("Photo downloads don't work here.");
      const assertAccount = async () => { check(); const { data, error } = await supabase.auth.getSession(); check(); if (error || data.session?.user.id !== owner) throw new Error("You switched accounts. Reopen your vault."); };
      const sources = weekStrips.map(strip => ({ id: strip.id, async resolve(signal: AbortSignal) {
        await assertAccount();
        const { data, error } = await supabase.from("pb_strips").select("id,owner,couple_id,storage_path,created_at,purged").eq("id", strip.id).abortSignal(signal).maybeSingle(); check();
        if (error || !data || data.purged || data.owner !== strip.owner || data.couple_id !== strip.couple_id || data.storage_path !== strip.storage_path || data.created_at !== strip.created_at) throw new Error("One of the strips isn't available anymore. Refresh the vault.");
        if (data.owner !== owner) { const current = await getMyCouple(owner, signal); check(); if (!current || current.id !== data.couple_id || ![current.member_a, current.member_b].includes(data.owner)) throw new Error("Your access to one of the shared strips changed. Refresh the vault."); }
        const signed = await supabase.storage.from("photobooth-strips").createSignedUrl(data.storage_path, 60); check();
        if (signed.error || !signed.data?.signedUrl) throw new Error("Couldn't open one of the strips. Refresh and try again.");
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
      if ((currentCouple?.id ?? null) !== originalCouple) throw new Error("Your pairing changed, so the recap was downloaded but not saved to the vault.");
      check(); await saveStrip(owner, originalCouple, blob, { layoutId: "recap", caption: `${title} recap` }, { id: mediaRequest(`recap:${weekOf}:${weekStrips.map(strip => strip.id).join(",")}`) }); check();
      setKeepNote("Recap downloaded and saved to the Shared Vault.");
      await refresh();
    } catch (error) {
      if (activeOwner.current === owner && recapWork.current === job) setKeepNote(job.signal.aborted ? "Recap cancelled." : `${downloaded ? "Recap downloaded, but we couldn't confirm it saved to the vault. " : ""}${error instanceof Error ? error.message : "Couldn't finish the recap. Refresh and try again."}`);
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
      <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-1 flex-col items-center justify-center px-4 py-16">
        <section className="page-head panel flex w-full flex-col items-center gap-4 px-6 py-10 text-center sm:px-10 sm:py-12">
          <span className="glyph size-16 rounded-[1.25rem] bg-[#8b5cf6]"><Heart size={30} strokeWidth={2.25} aria-hidden /></span>
          <p className="font-display text-2xl leading-tight sm:text-3xl">The Shared Vault isn&apos;t available here</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            Accounts are unavailable here. You can still use the booth.
          </p>
          <button onClick={() => router.push("/")} className="btn btn-primary">
            Back to booth
          </button>
        </section>
      </main>
    );
  }

  if (!user && signOutOpen) return <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-1 flex-col justify-center px-4 py-8">{signOutPanel}</main>;

  if (loading || !user) {
    return (
      <main className="flex min-h-dvh flex-1 items-center justify-center">
        <Loader2 className="animate-spin text-muted-foreground motion-reduce:animate-none" />
      </main>
    );
  }

  if (dataOwner !== user.id) return <main className="flex min-h-dvh flex-1 items-center justify-center gap-2 text-sm text-muted-foreground" role="status"><Loader2 size={20} className="animate-spin motion-reduce:animate-none" aria-hidden /> Opening your Shared Vault…</main>;

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-5xl flex-1 flex-col gap-6 px-4 pt-4 pb-10 sm:px-8 sm:pt-6">
      <PageHeader
        title="Shared Vault"
        headingRef={vaultHeading}
        actions={<>
          {paired && <>
            <Link href="/memories" className="btn btn-quiet"><BookHeart size={17} aria-hidden /> Memories</Link>
            <Link href="/memories/rituals" className="btn btn-quiet"><CalendarHeart size={17} aria-hidden /> Photo rituals</Link>
          </>}
          <PushToggle userId={user.id} />
        </>}
      />
      <div className="page-body flex flex-col gap-5">
        {signOutOpen && signOutPanel}
        {unpairTarget && unpairTarget.ownerId === user.id && unpairTarget.coupleId === couple?.id && <UnpairConfirmation busy={busy} error={err} onCancel={() => { setUnpairTarget(null); requestAnimationFrame(() => unpairButton.current?.focus()); }} onConfirm={() => void handleUnpair(unpairTarget)} />}
        {err && <div role="alert" className="notice border border-destructive/25 bg-destructive/8"><p className="font-bold text-destructive">{err}</p><button disabled={busy} onClick={() => void refresh()} className="btn btn-quiet mt-2 min-h-10 text-sm"><RefreshCw size={15} aria-hidden /> Refresh vault status</button></div>}
        {keepNote && (
          <div role="status" className="notice flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <p>{keepNote}</p>
            <button onClick={() => void refresh()} className="btn btn-plain -mr-2 min-h-10 text-sm"><RefreshCw size={15} aria-hidden /> Refresh status</button>
          </div>
        )}

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_21rem]">
          <div ref={vaultSidebar} className="flex min-w-0 flex-col gap-5 lg:col-start-2 lg:row-start-1 lg:sticky lg:top-[var(--sticky-top,5.5rem)] lg:self-start">
            {!paired && (
              <Section id="vault-pair-title" title="Pair with your partner" icon={Heart} tone="violet" bodyClassName="mt-3">
                {pending ? (
                  <div className="flex flex-col gap-3">
                    <p className="text-sm text-muted-foreground">
                      Share this code with your partner so your strips land in one Shared
                      Vault.
                    </p>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-2xl bg-muted px-4 py-2.5 text-2xl font-black tracking-[0.24em] uppercase">
                        {couple!.pair_code}
                      </span>
                      <button
                        onClick={copyCode}
                        className="btn btn-tinted"
                      >
                        {copied ? <Check size={16} /> : <Copy size={16} />}
                        {copied ? "Copied" : "Copy"}
                      </button>
                    </div>
                    <button disabled={busy} onClick={() => void handleUnpair()} className="btn btn-plain -ml-3.5 min-h-10 self-start text-sm text-muted-foreground">
                      Cancel this code
                    </button>
                  </div>
                ) : (
                  <div className="flex flex-col gap-3 sm:flex-row lg:flex-col">
                    <button
                      onClick={handleCreate}
                      disabled={busy}
                      className="btn btn-primary min-h-12 flex-1"
                    >
                      Create a pairing code
                    </button>
                    <div className="flex flex-1 items-center gap-2">
                      <input
                        aria-label="Pairing code"
                        value={joinInput}
                        onChange={(e) => setJoinInput(normalizeRoomCode(e.target.value))}
                        placeholder="Enter code"
                        className="field min-h-12 min-w-0 flex-1 text-lg font-black tracking-[0.24em] uppercase placeholder-shown:text-base placeholder:font-bold placeholder:tracking-normal placeholder:normal-case placeholder:text-muted-foreground"
                      />
                      <button
                        onClick={handleJoin}
                        disabled={busy || joinInput.length < 6}
                        className="btn btn-partner min-h-12"
                      >
                        Join
                      </button>
                    </div>
                  </div>
                )}
              </Section>
            )}

            {paired && (
              <Section
                id="vault-paired-title"
                title="Paired"
                icon={Heart}
                tone="violet"
                bodyClassName="mt-3"
                action={<button ref={unpairButton} disabled={busy || recapBusy || Boolean(mediaBusy) || datePending} onClick={() => { setErr(null); setUnpairTarget({ coupleId: couple!.id, ownerId: user.id }); }} className="btn btn-plain -mr-2 min-h-10 text-sm text-muted-foreground">
                  <Unlink size={14} /> Unpair
                </button>}
              >
                {streak > 0 && (
                  <p className="flex items-center gap-2 text-warning">
                    <Flame size={20} aria-hidden /> <span className="font-display text-2xl leading-none tabular-nums">{streak}</span> <span className="text-sm font-bold">week{streak > 1 ? "s" : ""}</span>
                  </p>
                )}
              </Section>
            )}

            {paired && (
              <Section
                id="vault-relay-title"
                title="Relay strips"
                icon={Clock}
                tone="rose"
                bodyClassName="mt-3"
                action={<button
                  onClick={() => router.push("/relay/new")}
                  className="btn btn-tinted min-h-10 text-sm"
                >
                  <Plus size={15} aria-hidden /> Start a relay
                </button>}
              >
                {ready && openRelays.length > 0 && (
                  <div className="flex flex-col gap-2">
                    {openRelays.map((r) => {
                      const myTurn = relayIsMyTurn(r, user.id);
                      return (
                        <button
                          key={r.id}
                          onClick={() => router.push(`/relay/${r.id}`)}
                          className={`flex min-h-12 w-full items-center justify-between gap-3 rounded-full px-4 py-3 text-left text-sm transition-colors ${
                            myTurn ? "bg-accent/12 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--accent)_35%,transparent)]" : "bg-muted/70 hover:bg-muted"
                          }`}
                        >
                          <span className="font-bold">
                            {myTurn ? "Your turn to finish a relay" : "Waiting for your partner"}
                          </span>
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {new Date(r.created_at).toLocaleDateString()}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </Section>
            )}

            {paired && (
              <Section
                id="vault-dates-title"
                title="Photo dates"
                icon={CalendarDays}
                tone="amber"
                bodyClassName="mt-3"
                action={<button
                  disabled={busy || datePending}
                  onClick={() =>
                    setDateForm(dateForm ? null : { title: "", when: "", cadence: "weekly" })
                  }
                  className="btn btn-tinted min-h-10 text-sm"
                >
                  <Plus size={15} aria-hidden /> Schedule
                </button>}
              >
                {dateForm || (ready && dates.length > 0) ? <div className="flex flex-col gap-3">
                {dateForm && (
                  <div className="panel-muted flex flex-col gap-2 p-3">
                    <input
                      disabled={busy || datePending}
                      aria-label="Reminder occasion"
                      value={dateForm.title}
                      onChange={(e) => setDateForm({ ...dateForm, title: e.target.value })}
                      placeholder="What's the occasion?"
                      className="field font-medium"
                    />
                    <div className="flex flex-col gap-2 sm:flex-row lg:flex-col">
                      <input
                        disabled={busy || datePending}
                        aria-label="Reminder date and time"
                        type="datetime-local"
                        value={dateForm.when}
                        onChange={(e) => setDateForm({ ...dateForm, when: e.target.value })}
                        className="field min-w-0 flex-1 text-sm font-medium"
                      />
                      <Dropdown disabled={busy || datePending} label="Repeat photo date" value={dateForm.cadence} onChange={value => setDateForm({ ...dateForm, cadence: value as Cadence })} options={CADENCES.map(cadence => ({ value: cadence.id, label: cadence.label }))} className="min-w-28" />
                    </div>
                    <button
                      onClick={addDate}
                      disabled={busy || !dateForm.title || !dateForm.when}
                      className="btn btn-primary mt-1 w-full"
                    >
                      {busy ? "Saving…" : datePending ? "Retry this reminder" : "Set reminder"}
                    </button>
                    {datePending && !busy && <p className="text-sm font-bold text-warning">This reminder didn&apos;t save. Try again before adding another.</p>}
                    <p className="text-xs text-muted-foreground">
                      Both of you get an email when it&apos;s time.
                    </p>
                  </div>
                )}
                {ready && dates.length > 0 && (
                  <ul className="-my-1 divide-y divide-border">
                    {dates.map((d) => (
                      <li key={d.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                        <div className="flex min-w-0 flex-col">
                          <span className="font-bold [overflow-wrap:anywhere]">{d.title}</span>
                          <span className="text-xs text-muted-foreground">
                            {new Date(d.scheduled_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}
                            {d.cadence !== "once" && ` · ${CADENCES.find((c) => c.id === d.cadence)?.label.toLowerCase()}`}
                          </span>
                        </div>
                        <button disabled={busy} onClick={() => void removeDate(d.id)} aria-label="Delete photo date" className="-mr-2 flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50">
                          <Trash2 size={15} />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                </div> : null}
              </Section>
            )}
          </div>

          <div className="tile-stack min-w-0 lg:col-start-1 lg:row-start-1">
            <Section
              id="vault-strips-title"
              title="Strips"
              icon={Images}
              tone="sky"
              action={ready && !loadErr && strips.length > 0 ? <div className="flex flex-wrap items-center gap-1">
                {thisWeekCount > 1 && (
                  <button
                    onClick={makeRecap}
                    disabled={recapBusy}
                    className="btn btn-tinted min-h-10 text-sm"
                  >
                    <Sparkles size={15} /> {recapBusy ? "Making…" : "Make this week's recap"}
                  </button>
                )}
                {recapBusy && <button onClick={() => recapWork.current?.abort()} className="btn btn-plain min-h-10 text-sm">Cancel recap</button>}
              </div> : undefined}
            >
              {!ready ? (
                <div className="flex min-h-48 items-center justify-center">
                  <Loader2 className="animate-spin text-muted-foreground motion-reduce:animate-none" />
                </div>
              ) : loadErr ? (
                <div className="flex min-h-48 flex-col items-center justify-center gap-4 rounded-2xl bg-muted/50 px-6 py-10 text-center">
                  <p className="font-bold">Couldn&apos;t load your Shared Vault.</p>
                  <button
                    onClick={() => void refresh()}
                    className="btn btn-primary"
                  >
                    <RefreshCw size={17} aria-hidden /> Try again
                  </button>
                </div>
              ) : strips.length === 0 ? (
                <div className="flex min-h-56 flex-col items-center justify-center gap-4 rounded-2xl bg-muted/50 px-6 py-10 text-center">
                  <p className="font-display text-xl">No strips saved yet</p>
                  <button onClick={() => router.push("/")} className="btn btn-primary">
                    <Camera size={18} aria-hidden /> Take some photos
                  </button>
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-3">
                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted" aria-hidden><div className="h-full rounded-full bg-[#0ea5e9]" style={{ width: `${Math.min(100, weekSaved / WEEKLY_STRIP_CAP * 100)}%` }} /></div>
                    <p className="shrink-0 text-sm font-bold tabular-nums">
                      {weekSaved}/{WEEKLY_STRIP_CAP} this week
                    </p>
                  </div>
                  {expiringCount > 0 && (
                    <p className="notice mt-3 flex items-start gap-2 text-muted-foreground">
                      <Bookmark size={15} className="mt-0.5 shrink-0" aria-hidden />
                      The vault clears when the week resets. Bookmark a strip to keep it
                      before then.
                    </p>
                  )}
                  <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4">
                  {strips.map((s) => (
                    <figure key={s.id} className="group relative min-w-0">
                      <div className="relative min-h-24 overflow-hidden rounded-2xl bg-muted shadow-[inset_0_0_0_1px_var(--panel-stroke)]">
                      {s.url && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={s.url}
                          alt={s.caption ?? "Photo strip"}
                          className="block w-full"
                        />
                      )}
                      {s.mine && s.layout_id !== "recap" && (
                        <button
                          onClick={() => toggleKeep(s)}
                          disabled={mediaBusy !== null}
                          aria-label={s.kept ? "Kept, tap to release" : "Keep this strip"}
                          aria-pressed={s.kept}
                          className={`glass absolute top-2 right-2 flex size-11 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50 ${
                            s.kept ? "text-accent" : "text-foreground"
                          }`}
                        >
                          {s.kept ? <BookmarkCheck size={17} /> : <Bookmark size={17} />}
                        </button>
                      )}
                      </div>
                      <figcaption className="mt-1 flex items-center justify-between gap-1 pl-1 text-xs text-muted-foreground">
                        <span className="flex flex-wrap items-center gap-1.5">
                          {new Date(s.created_at).toLocaleDateString()}
                          {(() => {
                            const d = daysUntilPurge(s);
                            if (d === null || d > 2) return null;
                            return (
                              <span className="rounded-full bg-warning/15 px-1.5 py-0.5 font-bold text-warning">
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
                            className="flex size-11 shrink-0 items-center justify-center rounded-full text-destructive transition-colors hover:bg-destructive/10 focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
                          >
                            <Trash2 size={15} />
                          </button>
                        )}
                      </figcaption>
                    </figure>
                  ))}
                  </div>
                </>
              )}
            </Section>
          </div>
        </div>
      </div>
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
  return <dialog ref={dialog} aria-labelledby="unpair-title" aria-describedby="unpair-description" onCancel={event => { event.preventDefault(); if (!busy) onCancel(); }} className="glass-strong m-auto max-h-[calc(100dvh_-_2rem)] w-[calc(100%_-_2rem)] max-w-lg overflow-y-auto rounded-[1.75rem] border-0 p-5 text-foreground sm:p-6">
    <div className="flex items-center gap-3"><span className="glyph bg-[#8b5cf6]"><Unlink size={18} strokeWidth={2.25} aria-hidden /></span><h2 id="unpair-title" className="font-display text-xl leading-tight">End this pairing?</h2></div>
    <div id="unpair-description" className="mt-4 space-y-2 text-sm">
      <p>You&apos;ll lose access to each other&apos;s strips, and your shared relays and photo dates will be deleted.</p>
      <p className="text-muted-foreground">You&apos;ll each keep your own strips and photos. Save or export any finished relays first.</p>
    </div>
    {error && <p role="alert" className="notice mt-4 border border-destructive/25 bg-destructive/8 font-bold text-destructive">{error}</p>}
    {busy && <p role="status" className="mt-4 flex items-center gap-2 text-sm font-bold"><Loader2 size={16} className="animate-spin text-accent motion-reduce:animate-none" aria-hidden /> Ending the pairing…</p>}
    <div className="mt-5 flex flex-wrap justify-end gap-2">
      <button ref={keep} disabled={busy} onClick={onCancel} className="btn btn-quiet">Stay paired</button>
      <button disabled={busy} onClick={onConfirm} className="btn btn-danger">End pairing</button>
    </div>
  </dialog>;
}
