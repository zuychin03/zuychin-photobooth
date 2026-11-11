"use client";

import { useAppNavigationGuard } from "@/components/AppNavigation";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Camera, Check, Copy, LayoutGrid, Loader2, Sparkles, Users } from "lucide-react";
import { FilterBar } from "@/components/FilterBar";
import { LayoutPicker } from "@/components/LayoutPicker";
import { PageHeader } from "@/components/ui/PageHeader";
import { Section } from "@/components/ui/Section";
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
    if ((originals.length > 0 && !originalsSaved) || step === "saving") { setError("Wait for your photos to finish saving before you leave."); return false; }
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
    }).catch(() => { if (current() && !cancelled) setError("Couldn't load your pairing. Refresh and try again."); }).finally(() => { if (current() && !cancelled) setChecked(true); });
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
        setError(failure instanceof Error ? failure.message : "Couldn't save your half. Your photos are still on this page.");
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
      <main className="mx-auto flex min-h-dvh w-full max-w-lg flex-1 flex-col justify-center px-4 py-10">
        <section className="panel page-body flex flex-col items-center gap-4 p-6 text-center sm:p-8">
          <span className="glyph size-14 rounded-2xl bg-[#8b5cf6]"><Users size={26} strokeWidth={2.25} aria-hidden /></span>
          <h1 className="font-display text-2xl sm:text-3xl">Pair with your partner first</h1>
          {error && <p role="alert" className="text-sm font-bold text-destructive">{error}</p>}
          <p className="max-w-sm text-sm text-muted-foreground">
            Your partner finishes the other half. Pair up in your Shared Vault.
          </p>
          <button onClick={() => router.push("/timeline")} className="btn btn-primary">
            Go to the vault
          </button>
        </section>
      </main>
    );
  }

  if (loading || !user || !checked) {
    return (
      <main className="flex min-h-dvh flex-1 items-center justify-center">
        <Loader2 className="animate-spin text-muted-foreground motion-reduce:animate-none" />
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
            const current = scope.capture(); if (!current() || !user || !captureId) throw new Error("This page changed. Reload and try again.");
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
      <main className="flex min-h-dvh flex-1 flex-col items-center justify-center gap-3 px-4">
        <Loader2 className="animate-spin text-muted-foreground motion-reduce:animate-none" />
        <p className="text-sm font-bold text-muted-foreground">Saving your half…</p>
        {error && <p role="alert" className="notice max-w-sm">{error}</p>}
      </main>
    );
  }

  if (step === "failed" && pendingUpload) {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-lg flex-1 flex-col justify-center px-4 py-10">
        <section className="panel flex flex-col items-center gap-4 p-6 text-center sm:p-8">
          <p role="alert" className="max-w-sm text-sm font-bold text-destructive">{error}</p>
          <RelayOriginalRecovery originals={originals} saved={originalsSaved} />
          <button onClick={() => void onShot(pendingUpload.frames)} className="btn btn-primary">Retry saving</button>
        </section>
      </main>
    );
  }

  if (step === "done") {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-lg flex-1 flex-col justify-center px-4 py-10">
        <section className="panel page-body flex flex-col items-center gap-4 p-6 text-center sm:p-8">
          <span className="glyph size-14 rounded-2xl bg-[#10b981]"><Check size={28} strokeWidth={2.5} aria-hidden /></span>
          <h1 className="font-display text-2xl sm:text-3xl">Your half is saved</h1>
          <p className="max-w-sm text-sm text-muted-foreground">
            Tell your partner. It&apos;s waiting in their shared album to finish.
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            <button onClick={copyLink} className="btn btn-quiet">
              {copied ? <Check size={16} className="text-success" /> : <Copy size={16} />}
              {copied ? "Copied" : "Copy link"}
            </button>
            <button onClick={() => router.push("/timeline")} className="btn btn-primary">
              Done
            </button>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-5xl flex-1 flex-col gap-6 px-4 pt-4 pb-10 sm:px-8 sm:pt-6">
      <PageHeader
        title="Relay strip"
        leading={<button onClick={() => router.push("/timeline")} aria-label="Back" className="btn btn-quiet min-w-11 px-0"><ArrowLeft size={18} /></button>}
      />
      <div className="page-body flex flex-1 flex-col gap-5">
        <div className="grid gap-5 lg:grid-cols-2">
          <Section id="relay-layout-title" title="Layout" icon={LayoutGrid} tone="rose">
            <LayoutPicker label="Layout" asynchronous layouts={DUO_LAYOUTS} value={layoutId} onChange={setLayoutId} />
          </Section>

          <Section id="relay-filter-title" title="Filter" icon={Sparkles} tone="rose">
            <FilterBar value={filterId} onChange={setFilterId} />
          </Section>
        </div>

        <button
          onClick={() => { const id = captureId ?? crypto.randomUUID(); setCaptureId(id); const url = new URL(location.href); url.searchParams.set("draft", id); window.history.replaceState(window.history.state, "", url.pathname + url.search); setStep("shoot"); }}
          className="btn btn-primary mt-auto min-h-14 w-full text-base sm:w-auto sm:self-end sm:px-10"
        >
          <Camera size={20} aria-hidden />
          Shoot my half
        </button>
      </div>
    </main>
  );
}
