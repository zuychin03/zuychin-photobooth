"use client";

import { useAppNavigationGuard } from "@/components/AppNavigation";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, Clock, Loader2, Trash2 } from "lucide-react";
import { RelayOriginalRecovery } from "@/components/RelayOriginalRecovery";
import { loadRelayOriginals, saveRelayOriginals } from "@/lib/relay-recovery";
import { RoleCapture } from "@/components/RoleCapture";
import { useRelayPageScope } from "@/hooks/useRelayPageScope";
import { useAuth } from "@/lib/auth";
import { useBoothSession } from "@/lib/session";
import { getLayout } from "@/lib/layouts";
import {
  Relay,
  completeRelay,
  deleteRelay,
  getRelay,
  loadRelayShots,
  relayIsMyTurn,
} from "@/lib/relay";

export default function RelayPage() {
  const { user, loading, enabled } = useAuth();
  const params = useParams<{ id: string }>();
  return <RelayAccountPage key={`${user?.id ?? "signed-out"}:${loading}:${enabled}:${params.id}`} />;
}

function RelayAccountPage() {
  const scope = useRelayPageScope();
  const [originals, setOriginals] = useState<Blob[]>([]);
  const [captureUnsaved, setCaptureUnsaved] = useState(false);
  const [initialOriginals, setInitialOriginals] = useState<Blob[]>([]);
  const [originalsSaved, setOriginalsSaved] = useState(false);
  useEffect(() => { if (!originals.length || originalsSaved) return; const warn = (event: BeforeUnloadEvent) => event.preventDefault(); window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn); }, [originals.length, originalsSaved]);
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const { user, loading, enabled } = useAuth();
  const { update } = useBoothSession();

  const [relay, setRelay] = useState<Relay | null>(null);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useAppNavigationGuard(() => {
    if ((originals.length > 0 && !originalsSaved) || busy) { setError("Wait for the current work and save your originals before leaving."); return false; }
    return true;
  });
  const [pendingFrames, setPendingFrames] = useState<HTMLCanvasElement[] | null>(null);
  const [cancelled, setCancelled] = useState(false);

  useEffect(() => {
    if (enabled && !loading && !user) {
      router.replace(`/login?next=/relay/${params.id}`);
    }
  }, [enabled, loading, user, router, params.id]);

  useEffect(() => {
    const current = scope.capture(); let cancelled = false;
    if (user && !loading) void getRelay(params.id).then(async r => {
      if (!current() || cancelled) return;
      if (r && relayIsMyTurn(r, user.id)) {
        const loaded = await loadRelayOriginals({ id: r.id, ownerId: user.id, role: "B", active: current });
        if (!current() || cancelled) return;
        if (loaded) {
          if (loaded.project.capture.requiredShots !== r.shots || loaded.project.editor.layoutId !== r.layout_id || loaded.project.editor.filterId !== r.filter_id) throw new Error("Your recovery project changed. Keep it from My projects before continuing.");
          setOriginals(loaded.originals); setInitialOriginals(loaded.originals); setOriginalsSaved(true);
        }
      }
      setRelay(r);
    }).catch(() => { if (current() && !cancelled) setError("This relay could not be loaded. Please refresh and try again."); }).finally(() => { if (current() && !cancelled) setChecked(true); });
    return () => { cancelled = true; };
  }, [user, loading, params.id, scope]);

  // Load both halves into the session, then hand off to the editor.
  const openInEditor = useCallback(
    async (r: Relay) => {
      const current = scope.capture(); if (!current()) return;
      setBusy(true);
      setError(null);
      try {
        const shots = await loadRelayShots(r);
        if (!current()) { for (const frames of Object.values(shots)) for (const canvas of frames ?? []) if (canvas) canvas.width = canvas.height = 0; return; }
        await update({
        mode: "duo",
        role: r.initiator === user?.id ? "A" : "B",
        layoutId: r.layout_id,
        filterId: r.filter_id,
        sceneId: r.scene_id,
        shots,
        members: ["A", "B"],
        promptSeed: null,
        roomCode: null,
        });
        if (current()) router.push("/customize");
      } catch (failure) {
        if (!current()) return;
        setError(failure instanceof Error ? failure.message : "Your relay photos could not be opened. Please try again.");
      } finally {
        if (current()) setBusy(false);
      }
    },
    [update, user, router, scope],
  );

  const onShot = useCallback(
    async (frames: HTMLCanvasElement[], sourceOriginals: Blob[] = originals) => {
      const current = scope.capture();
      if (!current() || !user || !relay) { for (const frame of frames) frame.width = frame.height = 0; return; }
      setBusy(true);
      setPendingFrames(frames);
      setError(null);
      setOriginals(sourceOriginals);
      try {
        await saveRelayOriginals({ id: relay.id, ownerId: user.id, layoutId: relay.layout_id, filterId: relay.filter_id, role: "B", shots: relay.shots, originals: sourceOriginals, active: current });
        if (!current()) return;
        setOriginalsSaved(true);
        await completeRelay(user.id, relay, frames);
        if (!current()) return;
        const done = { ...relay, partner: user.id, b_done: true, status: "complete" as const };
        for (const frame of frames) frame.width = frame.height = 0;
        setPendingFrames(null); setRelay(done);
        await openInEditor(done);
      } catch (failure) {
        if (!current()) return;
        setError(failure instanceof Error ? failure.message : "Your half could not be saved. Your photos remain on this page.");
      } finally {
        if (current()) setBusy(false); else for (const frame of frames) frame.width = frame.height = 0;
      }
    },
    [user, relay, openInEditor, scope, originals],
  );

  if (!enabled) {
    return (
      <main className="flex min-h-dvh flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="text-lg font-semibold">Relays aren&apos;t available here</p>
        <button onClick={() => router.push("/")} className="rounded-full bg-accent px-5 py-2.5 font-semibold text-accent-foreground">
          Back to booth
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

  if (!relay) {
    return (
      <main className="flex min-h-dvh flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="text-lg font-semibold">{error ?? "Relay not found"}</p>
        <button onClick={() => router.push("/timeline")} className="rounded-full bg-accent px-5 py-2.5 font-semibold text-accent-foreground">
          Back to the album
        </button>
      </main>
    );
  }

  const myTurn = relayIsMyTurn(relay, user.id);
  const layout = getLayout(relay.layout_id);

  if (myTurn && !busy && !pendingFrames) {
    return (
      <main className="booth-mode relative flex min-h-dvh flex-1 flex-col">
        <div className="absolute top-0 z-40 p-4">
          <button disabled={captureUnsaved} onClick={() => router.push("/timeline")} aria-label="Back" className="glass-card flex h-11 w-11 items-center justify-center rounded-full">
            <ArrowLeft size={20} />
          </button>
        </div>
        <RoleCapture
          shots={relay.shots}
          filterId={relay.filter_id}
          onUnsavedChange={setCaptureUnsaved}
          initialOriginals={initialOriginals}
          onCheckpoint={async blobs => {
            const current = scope.capture(); if (!current()) throw new Error("Your relay page changed.");
            await saveRelayOriginals({ id: relay.id, ownerId: user.id, layoutId: relay.layout_id, filterId: relay.filter_id, role: "B", shots: relay.shots, originals: blobs, active: current });
          }}
          onDone={onShot}
          hint="Your partner already shot their half. Finish the strip!"
        />
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {cancelled ? (
        <><p role="status">The relay is cancelled. Its photo cleanup is queued.</p><button onClick={() => router.push("/timeline")} className="text-sm underline">Back to the album</button></>
      ) : busy ? (
        <>
          <Loader2 className="animate-spin text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Putting your strip together…</p>
        </>
      ) : pendingFrames && relay.status !== "complete" ? (
        <>
          <RelayOriginalRecovery originals={originals} saved={originalsSaved} />
          <button onClick={() => void onShot(pendingFrames)} className="rounded-full bg-accent px-5 py-2.5 font-semibold text-accent-foreground">Retry saving</button>
        </>
      ) : relay.status === "complete" ? (
        <>
          <p className="text-lg font-semibold" style={{ fontFamily: "var(--font-fraunces)" }}>
            This relay is complete
          </p>
          <button onClick={() => openInEditor(relay)} className="rounded-full bg-accent px-5 py-2.5 font-semibold text-accent-foreground">
            Open in editor
          </button>
          <button onClick={() => router.push("/timeline")} className="text-sm text-muted-foreground underline">
            Back to the album
          </button>
        </>
      ) : (
        <>
          <Clock className="text-accent" size={28} />
          <p className="text-lg font-semibold" style={{ fontFamily: "var(--font-fraunces)" }}>
            Waiting for your partner
          </p>
          <p className="max-w-sm text-sm text-muted-foreground">
            You shot your half of this {layout.name.toLowerCase()}. It finishes once
            your partner adds theirs.
          </p>
          <div className="flex gap-3">
            <button
              onClick={async () => {
                const current = scope.capture(); if (!current()) return;
                setBusy(true);
                setError(null);
                try { await deleteRelay(relay.id); if (current()) setCancelled(true); }
                catch (failure) { if (current()) setError(failure instanceof Error ? failure.message : "Relay cancellation failed. Please try again."); }
                finally { if (current()) setBusy(false); }
              }}
              className="flex min-h-11 items-center gap-2 rounded-full bg-destructive/15 px-4 text-sm font-medium text-destructive"
            >
              <Trash2 size={15} /> Cancel relay
            </button>
            <button onClick={() => router.push("/timeline")} className="rounded-full bg-accent px-5 font-semibold text-accent-foreground">
              Back
            </button>
          </div>
        </>
      )}
    </main>
  );
}
