"use client";

import { useAppNavigationGuard } from "@/components/AppNavigation";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Check, Copy, Loader2 } from "lucide-react";
import { FilterBar } from "@/components/FilterBar";
import { RelayOriginalRecovery } from "@/components/RelayOriginalRecovery";
import { loadRelayOriginals, saveRelayOriginals } from "@/lib/relay-recovery";
import { RoleCapture } from "@/components/RoleCapture";
import { useRelayPageScope } from "@/hooks/useRelayPageScope";
import { useAuth } from "@/lib/auth";
import { Couple, getMyCouple } from "@/lib/couple";
import { createRelay } from "@/lib/relay";
import { notifyPartner } from "@/lib/push-client";
import { LAYOUTS, getLayout } from "@/lib/layouts";
import { UploadSaveError } from "@/lib/upload-intent";

const DUO_LAYOUTS = LAYOUTS.filter((l) => l.mode === "duo");

type Step = "setup" | "shoot" | "saving" | "failed" | "done";

export default function NewRelayPage() {
  const { user, loading, enabled } = useAuth();
  return <NewRelayAccountPage key={`${user?.id ?? "signed-out"}:${loading}:${enabled}`} />;
}

function NewRelayAccountPage() {
  const scope = useRelayPageScope();
  const [originals, setOriginals] = useState<Blob[]>([]);
  const [captureId, setCaptureId] = useState<string | null>(null);
  const [initialOriginals, setInitialOriginals] = useState<Blob[]>([]);
  const [originalsSaved, setOriginalsSaved] = useState(false);
  useEffect(() => { if (!originals.length || originalsSaved) return; const warn = (event: BeforeUnloadEvent) => event.preventDefault(); window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn); }, [originals.length, originalsSaved]);
  const router = useRouter();
  const { user, loading, enabled } = useAuth();
  const [couple, setCouple] = useState<Couple | null>(null);
  const [checked, setChecked] = useState(false);
  const [layoutId, setLayoutId] = useState(DUO_LAYOUTS[0].id);
  const [filterId, setFilterId] = useState("none");
  const [step, setStep] = useState<Step>("setup");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useAppNavigationGuard(() => {
    if ((originals.length > 0 && !originalsSaved) || step === "saving") { setError("Wait for the current work and save your originals before leaving."); return false; }
    return true;
  });
  const [pendingUpload, setPendingUpload] = useState<{ id: string; frames: HTMLCanvasElement[] } | null>(null);

  useEffect(() => {
    if (enabled && !loading && !user) router.replace("/login?next=/relay/new");
  }, [enabled, loading, user, router]);

  useEffect(() => {
    const current = scope.capture(); let cancelled = false;
    if (user && !loading) void getMyCouple(user.id).then(async c => {
      if (!current() || cancelled) return; setCouple(c);
      const draftId = new URL(location.href).searchParams.get("draft");
      if (draftId && /^[a-f0-9-]{36}$/i.test(draftId)) {
        const loaded = await loadRelayOriginals({ id: draftId, ownerId: user.id, role: "A", active: current });
        if (!current() || cancelled) return;
        setCaptureId(draftId);
        if (loaded) { setLayoutId(loaded.project.editor.layoutId); setFilterId(loaded.project.editor.filterId); setOriginals(loaded.originals); setInitialOriginals(loaded.originals); setOriginalsSaved(true); setStep("shoot"); }
      }
    }).catch(() => { if (current() && !cancelled) setError("Your pairing could not be loaded. Please refresh and try again."); }).finally(() => { if (current() && !cancelled) setChecked(true); });
    return () => { cancelled = true; };
  }, [user, loading, scope]);

  const layout = getLayout(layoutId);
  const paired = !!couple?.member_b;

  const onShot = useCallback(
    async (frames: HTMLCanvasElement[], sourceOriginals: Blob[] = originals) => {
      const current = scope.capture();
      if (!current() || !user || !couple) { for (const frame of frames) frame.width = frame.height = 0; return; }
      const id = pendingUpload?.id ?? captureId;
      if (!id) { for (const frame of frames) frame.width = frame.height = 0; return; }
      setPendingUpload({ id, frames });
      setStep("saving");
      setError(null);
      setOriginals(sourceOriginals);
      try {
        await saveRelayOriginals({ id, ownerId: user.id, layoutId, filterId, role: "A", shots: layout.shots, originals: sourceOriginals, active: current });
        if (!current()) return;
        setOriginalsSaved(true);
        const relayId = await createRelay(user.id, couple.id, {
          layoutId,
          filterId,
          sceneId: null,
          shots: layout.shots,
        }, frames, { id });
        if (!current()) return;
        notifyPartner("relay", relayId);
        setStep("done");
        setPendingUpload(null);
        for (const frame of frames) frame.width = frame.height = 0;
      } catch (failure) {
        if (!current()) return;
        if (failure instanceof UploadSaveError && failure.restartRequired) setPendingUpload({ id: crypto.randomUUID(), frames });
        setError(failure instanceof Error ? failure.message : "Your half could not be saved. Your photos remain on this page.");
        setStep("failed");
      } finally { if (!current()) for (const frame of frames) frame.width = frame.height = 0; }
    },
    [user, couple, layoutId, filterId, layout.shots, pendingUpload, scope, originals, captureId],
  );

  const copyLink = async () => {
    const current = scope.capture(); if (!current()) return;
    await navigator.clipboard.writeText(`${location.origin}/timeline`);
    if (!current()) return;
    setCopied(true);
    setTimeout(() => { if (current()) setCopied(false); }, 1600);
  };

  if (!enabled || (checked && !paired)) {
    return (
      <main className="flex min-h-dvh flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="text-lg font-semibold">Pair with your partner first</p>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <p className="max-w-sm text-sm text-muted-foreground">
          Relay strips need a paired partner to finish your half. Set that up in
          your Shared Vault.
        </p>
        <button onClick={() => router.push("/timeline")} className="rounded-full bg-accent px-5 py-2.5 font-semibold text-accent-foreground">
          Go to the vault
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
          initialOriginals={initialOriginals}
          onCheckpoint={async blobs => {
            const current = scope.capture(); if (!current() || !user || !captureId) throw new Error("Your relay page changed.");
            await saveRelayOriginals({ id: captureId, ownerId: user.id, layoutId, filterId, role: "A", shots: layout.shots, originals: blobs, active: current });
          }}
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
        {error && <p role="alert" className="max-w-sm px-4 text-sm">{error}</p>}
      </main>
    );
  }

  if (step === "failed" && pendingUpload) {
    return (
      <main className="flex min-h-dvh flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
        <p role="alert" className="max-w-sm text-sm text-destructive">{error}</p>
        <RelayOriginalRecovery originals={originals} saved={originalsSaved} />
        <button onClick={() => void onShot(pendingUpload.frames)} className="rounded-full bg-accent px-5 py-2.5 font-semibold text-accent-foreground">Retry saving</button>
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
        Take your photos now. Your partner can finish the strip later.
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
        onClick={() => { const id = captureId ?? crypto.randomUUID(); setCaptureId(id); const url = new URL(location.href); url.searchParams.set("draft", id); window.history.replaceState(window.history.state, "", url.pathname + url.search); setStep("shoot"); }}
        className="mt-auto min-h-13 rounded-2xl bg-accent font-semibold text-accent-foreground shadow-lg shadow-accent/25"
      >
        Shoot my half
      </button>
    </main>
  );
}
