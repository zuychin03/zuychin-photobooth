"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Check,
  Copy,
  Heart,
  Loader2,
  LogOut,
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
  unpair,
} from "@/lib/couple";

export default function TimelinePage() {
  const router = useRouter();
  const { user, loading, enabled, signOut } = useAuth();

  const [couple, setCouple] = useState<Couple | null>(null);
  const [strips, setStrips] = useState<TimelineStrip[]>([]);
  const [ready, setReady] = useState(false);
  const [joinInput, setJoinInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    if (!user) return;
    setReady(false);
    const [c, s] = await Promise.all([getMyCouple(user.id), listStrips(user.id)]);
    setCouple(c);
    setStrips(s);
    setReady(true);
  }, [user]);

  useEffect(() => {
    if (enabled && !loading && !user) router.replace("/login?next=/timeline");
  }, [enabled, loading, user, router]);

  useEffect(() => {
    if (user) queueMicrotask(() => void refresh());
  }, [user, refresh]);

  const paired = !!couple?.member_b;
  const pending = !!couple && !couple.member_b;

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

  const copyCode = async () => {
    if (!couple?.pair_code) return;
    await navigator.clipboard.writeText(couple.pair_code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  if (!enabled) {
    return (
      <main className="flex min-h-dvh flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="text-lg font-semibold">Timeline isn&apos;t available here</p>
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
          Our timeline
        </h1>
        <button
          onClick={signOut}
          aria-label="Sign out"
          className="flex h-11 w-11 items-center justify-center rounded-full bg-muted"
        >
          <LogOut size={18} />
        </button>
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
                Share this code with your partner so your strips land in one shared
                timeline.
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
          </span>
          <button onClick={handleUnpair} className="flex items-center gap-1 text-xs text-muted-foreground">
            <Unlink size={13} /> Unpair
          </button>
        </div>
      )}

      {/* Strips */}
      {!ready ? (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="animate-spin text-muted-foreground" />
        </div>
      ) : strips.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center text-muted-foreground">
          <p>No strips saved yet.</p>
          <button onClick={() => router.push("/")} className="rounded-full bg-accent px-5 py-2.5 font-semibold text-accent-foreground">
            Take some photos
          </button>
        </div>
      ) : (
        <section className="grid grid-cols-2 gap-4 sm:grid-cols-3">
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
              <figcaption className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
                <span>{new Date(s.created_at).toLocaleDateString()}</span>
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
        </section>
      )}
    </main>
  );
}
