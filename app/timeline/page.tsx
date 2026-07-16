"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Bookmark,
  BookmarkCheck,
  CalendarHeart,
  Check,
  Clock,
  Copy,
  Flame,
  Heart,
  Loader2,
  LogOut,
  Sparkles,
  Trash2,
  Unlink,
} from "lucide-react";
import { useAuth } from "@/lib/auth";
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
import { loadImage, recapToBlob } from "@/lib/recap";
import { PushToggle } from "@/components/PushToggle";

export default function TimelinePage() {
  const router = useRouter();
  const { user, loading, enabled, signOut } = useAuth();

  const [couple, setCouple] = useState<Couple | null>(null);
  const [strips, setStrips] = useState<TimelineStrip[]>([]);
  const [relays, setRelays] = useState<Relay[]>([]);
  const [dates, setDates] = useState<PhotoDate[]>([]);
  const [ready, setReady] = useState(false);
  const [dateForm, setDateForm] = useState<{ title: string; when: string; cadence: Cadence } | null>(null);
  const [recapBusy, setRecapBusy] = useState(false);
  const [joinInput, setJoinInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [loadErr, setLoadErr] = useState(false);
  const [copied, setCopied] = useState(false);
  const [keepNote, setKeepNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!user) return;
    setReady(false);
    setLoadErr(false);
    try {
      const [c, s, r, d] = await Promise.all([
        getMyCouple(user.id),
        listStrips(user.id),
        listRelays().catch(() => [] as Relay[]),
        listPhotoDates().catch(() => [] as PhotoDate[]),
      ]);
      setCouple(c);
      setStrips(s);
      setRelays(r);
      setDates(d);
    } catch (e) {
      console.error("[album] load failed", e);
      setLoadErr(true);
    } finally {
      setReady(true);
    }
  }, [user]);

  useEffect(() => {
    if (enabled && !loading && !user) router.replace("/login?next=/timeline");
  }, [enabled, loading, user, router]);

  useEffect(() => {
    if (user) queueMicrotask(() => void refresh());
  }, [user, refresh]);

  const paired = !!couple?.member_b;
  const pending = !!couple && !couple.member_b;
  const streak = weeklyStreak(strips.map((s) => s.created_at));
  const openRelays = relays.filter((r) => r.status === "pending");
  const now = new Date();
  const thisWeekCount = strips.filter((s) => sameIsoWeek(new Date(s.created_at), now)).length;
  const weekSaved = strips.filter(
    (s) => s.layout_id !== "recap" && sameIsoWeek(new Date(s.created_at), now),
  ).length;
  const expiringCount = strips.filter((s) => s.mine && !isRetained(s)).length;

  const toggleKeep = async (strip: TimelineStrip) => {
    const kept = !strip.kept;
    setStrips((list) => list.map((x) => (x.id === strip.id ? { ...x, kept } : x)));
    setKeepNote(null);
    try {
      const { pushed } = await setStripKept(strip.id, kept);
      if (kept && !pushed) {
        setKeepNote(
          "Bookmarked here, but this deployment isn't set up to keep strips past the weekly reset yet — configure Cloudinary to archive them.",
        );
      }
    } catch {
      setStrips((list) => list.map((x) => (x.id === strip.id ? { ...x, kept: !kept } : x)));
    }
  };

  const handleCreate = async () => {
    if (!user) return;
    setBusy(true);
    setErr(null);
    try {
      setCouple(await createCouple(user.id));
    } catch {
      setErr("Couldn't create a pairing code.");
    } finally {
      setBusy(false);
    }
  };

  const handleJoin = async () => {
    setBusy(true);
    setErr(null);
    try {
      await joinCouple(normalizeRoomCode(joinInput));
      await refresh();
    } catch {
      setErr("That code is invalid or already used.");
    } finally {
      setBusy(false);
    }
  };

  const handleUnpair = async () => {
    if (!couple) return;
    await unpair(couple.id);
    setCouple(null);
    await refresh();
  };

  const addDate = async () => {
    if (!user || !couple || !dateForm?.title || !dateForm.when) return;
    await createPhotoDate(user.id, couple.id, {
      title: dateForm.title,
      scheduledAt: new Date(dateForm.when).toISOString(),
      cadence: dateForm.cadence,
    });
    setDateForm(null);
    await refresh();
  };

  const removeDate = async (id: string) => {
    await deletePhotoDate(id);
    setDates((list) => list.filter((d) => d.id !== id));
  };

  const makeRecap = async () => {
    if (!user) return;
    setRecapBusy(true);
    try {
      const now = new Date();
      const weekStrips = strips.filter((s) => sameIsoWeek(new Date(s.created_at), now) && s.url);
      if (weekStrips.length === 0) return;
      const imgs = await Promise.all(weekStrips.map((s) => loadImage(s.url!)));
      const weekOf = startOfIsoWeek(now).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      });
      const title = `Week of ${weekOf}`;
      const blob = await recapToBlob(imgs, title);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `zuychin-recap-week-of-${weekOf.replace(/\s+/g, "-").toLowerCase()}.png`;
      a.click();
      URL.revokeObjectURL(url);
      await saveStrip(user.id, couple?.id ?? null, blob, { layoutId: "recap", caption: `${title} recap` });
      await refresh();
    } finally {
      setRecapBusy(false);
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
          This deployment has no account backend configured. The booth still works
          without an account.
        </p>
        <button onClick={() => router.push("/")} className="rounded-full bg-accent px-5 py-2.5 font-semibold text-accent-foreground">
          Back to booth
        </button>
      </main>
    );
  }

  if (loading || !user) {
    return (
      <main className="flex min-h-dvh flex-1 items-center justify-center">
        <Loader2 className="animate-spin text-muted-foreground" />
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-3xl flex-1 flex-col gap-6 px-5 py-6">
      <header className="flex items-center justify-between">
        <button
          onClick={() => router.push("/")}
          className="flex min-h-11 items-center gap-2 rounded-full bg-muted px-4 text-sm font-medium"
        >
          <ArrowLeft size={16} /> Booth
        </button>
        <h1 className="text-xl font-semibold" style={{ fontFamily: "var(--font-fraunces)" }}>
          Shared Vault
        </h1>
        <div className="flex items-center gap-2">
          <PushToggle userId={user.id} />
          <button
            onClick={signOut}
            aria-label="Sign out"
            className="flex h-11 w-11 items-center justify-center rounded-full bg-muted"
          >
            <LogOut size={18} />
          </button>
        </div>
      </header>

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
              <button onClick={handleUnpair} className="self-start text-xs text-muted-foreground underline">
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
          {err && <p className="mt-2 text-sm text-destructive">{err}</p>}
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
          <button onClick={handleUnpair} className="flex items-center gap-1 text-xs text-muted-foreground">
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
              onClick={() =>
                setDateForm(dateForm ? null : { title: "", when: "", cadence: "weekly" })
              }
              className="flex min-h-9 items-center gap-1.5 rounded-full bg-accent/15 px-3 text-xs font-semibold text-accent"
            >
              <CalendarHeart size={14} /> Schedule
            </button>
          </div>
          {dateForm && (
            <div className="glass-card flex flex-col gap-2 rounded-xl p-3">
              <input
                value={dateForm.title}
                onChange={(e) => setDateForm({ ...dateForm, title: e.target.value })}
                placeholder="What's the occasion?"
                className="min-h-11 rounded-lg border border-border bg-card px-3 outline-none focus:border-accent"
              />
              <div className="flex gap-2">
                <input
                  type="datetime-local"
                  value={dateForm.when}
                  onChange={(e) => setDateForm({ ...dateForm, when: e.target.value })}
                  className="min-h-11 flex-1 rounded-lg border border-border bg-card px-3 text-sm outline-none focus:border-accent"
                />
                <select
                  value={dateForm.cadence}
                  onChange={(e) => setDateForm({ ...dateForm, cadence: e.target.value as Cadence })}
                  className="min-h-11 rounded-lg border border-border bg-card px-3 text-sm outline-none focus:border-accent"
                >
                  {CADENCES.map((c) => (
                    <option key={c.id} value={c.id}>{c.label}</option>
                  ))}
                </select>
              </div>
              <button
                onClick={addDate}
                disabled={!dateForm.title || !dateForm.when}
                className="min-h-10 rounded-lg bg-accent font-semibold text-accent-foreground disabled:opacity-50"
              >
                Set reminder
              </button>
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
                  <button onClick={() => removeDate(d.id)} aria-label="Delete photo date" className="text-muted-foreground">
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
          </div>
          {keepNote && (
            <p className="rounded-xl bg-muted/60 px-3 py-2 text-xs text-warning">{keepNote}</p>
          )}
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
                  aria-label={s.kept ? "Kept, tap to release" : "Keep this strip"}
                  aria-pressed={s.kept}
                  className={`glass-card absolute right-1.5 top-1.5 flex h-8 w-8 items-center justify-center rounded-full transition ${
                    s.kept ? "text-accent" : "text-muted-foreground opacity-0 group-hover:opacity-100"
                  }`}
                >
                  {s.kept ? <BookmarkCheck size={15} /> : <Bookmark size={15} />}
                </button>
              )}
              <figcaption className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
                <span className="flex items-center gap-1.5">
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
                    onClick={async () => {
                      await deleteStrip(s);
                      setStrips((list) => list.filter((x) => x.id !== s.id));
                    }}
                    aria-label="Delete strip"
                    className="opacity-0 transition group-hover:opacity-100"
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
