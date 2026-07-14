"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Check, Copy, Loader2 } from "lucide-react";
import { FilterBar } from "@/components/FilterBar";
import { RoleCapture } from "@/components/RoleCapture";
import { useAuth } from "@/lib/auth";
import { Couple, getMyCouple } from "@/lib/couple";
import { createRelay } from "@/lib/relay";
import { LAYOUTS, getLayout } from "@/lib/layouts";

const DUO_LAYOUTS = LAYOUTS.filter((l) => l.mode === "duo");

type Step = "setup" | "shoot" | "saving" | "done";

export default function NewRelayPage() {
  const router = useRouter();
  const { user, loading, enabled } = useAuth();
  const [couple, setCouple] = useState<Couple | null>(null);
  const [checked, setChecked] = useState(false);
  const [layoutId, setLayoutId] = useState(DUO_LAYOUTS[0].id);
  const [filterId, setFilterId] = useState("none");
  const [step, setStep] = useState<Step>("setup");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (enabled && !loading && !user) router.replace("/login?next=/relay/new");
  }, [enabled, loading, user, router]);

  useEffect(() => {
    if (user) getMyCouple(user.id).then((c) => { setCouple(c); setChecked(true); });
  }, [user]);

  const layout = getLayout(layoutId);
  const paired = !!couple?.member_b;

  const onShot = useCallback(
    async (frames: HTMLCanvasElement[]) => {
      if (!user || !couple) return;
      setStep("saving");
      try {
        await createRelay(user.id, couple.id, {
          layoutId,
          filterId,
          sceneId: null,
          shots: layout.shots,
        }, frames);
        setStep("done");
      } catch {
        setStep("setup");
      }
    },
    [user, couple, layoutId, filterId, layout.shots],
  );

  const copyLink = async () => {
    await navigator.clipboard.writeText(`${location.origin}/timeline`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  if (!enabled || (checked && !paired)) {
    return (
      <main className="flex min-h-dvh flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="text-lg font-semibold">Pair with your partner first</p>
        <p className="max-w-sm text-sm text-muted-foreground">
          Relay strips need a paired partner to finish your half. Set that up in
          your shared album.
        </p>
        <button onClick={() => router.push("/timeline")} className="rounded-full bg-accent px-5 py-2.5 font-semibold text-accent-foreground">
          Go to the album
        </button>
      </main>
    );
  }

  if (loading || !user || !checked) {
    return (
      <main className="flex min-h-dvh flex-1 items-center justify-center">
        <Loader2 className="animate-spin text-muted-foreground" />
      </main>
    );
  }

  if (step === "shoot") {
    return (
      <main className="booth-mode flex min-h-dvh flex-1 flex-col">
        <RoleCapture
          shots={layout.shots}
          filterId={filterId}
          onDone={onShot}
          hint="Shoot your half. Your partner fills the rest later."
        />
      </main>
    );
  }

  if (step === "saving") {
    return (
      <main className="flex min-h-dvh flex-1 flex-col items-center justify-center gap-3">
        <Loader2 className="animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">Saving your half…</p>
      </main>
    );
  }

  if (step === "done") {
    return (
      <main className="flex min-h-dvh flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-success/15">
          <Check className="text-success" size={28} />
        </div>
        <p className="text-lg font-semibold" style={{ fontFamily: "var(--font-fraunces)" }}>
          Your half is saved
        </p>
        <p className="max-w-sm text-sm text-muted-foreground">
          Tell your partner to open Photobooth. It&apos;s waiting in their shared
          album to finish.
        </p>
        <div className="flex gap-3">
          <button
            onClick={copyLink}
            className="glass-card flex min-h-11 items-center gap-2 rounded-full px-4 text-sm font-medium"
          >
            {copied ? <Check size={16} className="text-success" /> : <Copy size={16} />}
            {copied ? "Copied" : "Copy link"}
          </button>
          <button onClick={() => router.push("/timeline")} className="rounded-full bg-accent px-5 font-semibold text-accent-foreground">
            Done
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-1 flex-col gap-6 px-5 py-6">
      <header className="flex items-center gap-3">
        <button onClick={() => router.push("/timeline")} aria-label="Back" className="flex h-11 w-11 items-center justify-center rounded-full bg-muted">
          <ArrowLeft size={18} />
        </button>
        <h1 className="text-xl font-semibold" style={{ fontFamily: "var(--font-fraunces)" }}>
          Relay strip
        </h1>
      </header>

      <p className="text-sm text-muted-foreground">
        Take your photos now; your partner finishes the strip whenever they can. No
        need to be online together.
      </p>

      <section>
        <h2 className="mb-2 text-sm font-medium text-muted-foreground">Layout</h2>
        <div className="flex flex-col gap-2">
          {DUO_LAYOUTS.map((l) => (
            <button
              key={l.id}
              onClick={() => setLayoutId(l.id)}
              className={`min-h-12 rounded-xl border px-4 text-left text-sm font-medium transition ${
                layoutId === l.id ? "border-accent bg-accent/10" : "border-border"
              }`}
            >
              {l.name} · {l.shots} shots each
            </button>
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium text-muted-foreground">Filter</h2>
        <FilterBar value={filterId} onChange={setFilterId} />
      </section>

      <button
        onClick={() => setStep("shoot")}
        className="mt-auto min-h-13 rounded-2xl bg-accent font-semibold text-accent-foreground shadow-lg shadow-accent/25"
      >
        Shoot my half
      </button>
    </main>
  );
}
