"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, Clock, Loader2, Trash2 } from "lucide-react";
import { RoleCapture } from "@/components/RoleCapture";
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
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const { user, loading, enabled } = useAuth();
  const { update } = useBoothSession();

  const [relay, setRelay] = useState<Relay | null>(null);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (enabled && !loading && !user) {
      router.replace(`/login?next=/relay/${params.id}`);
    }
  }, [enabled, loading, user, router, params.id]);

  useEffect(() => {
    if (user) getRelay(params.id).then((r) => { setRelay(r); setChecked(true); });
  }, [user, params.id]);

  // Load both halves into the session, then hand off to the editor.
  const openInEditor = useCallback(
    async (r: Relay) => {
      setBusy(true);
      const shots = await loadRelayShots(r);
      update({
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
      router.push("/customize");
    },
    [update, user, router],
  );

  const onShot = useCallback(
    async (frames: HTMLCanvasElement[]) => {
      if (!user || !relay) return;
      setBusy(true);
      await completeRelay(user.id, relay, frames);
      const done = { ...relay, partner: user.id, b_done: true, status: "complete" as const };
      await openInEditor(done);
    },
    [user, relay, openInEditor],
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
        <p className="text-lg font-semibold">Relay not found</p>
        <button onClick={() => router.push("/timeline")} className="rounded-full bg-accent px-5 py-2.5 font-semibold text-accent-foreground">
          Back to the album
        </button>
      </main>
    );
  }

  const myTurn = relayIsMyTurn(relay, user.id);
  const layout = getLayout(relay.layout_id);

  if (myTurn && busy === false) {
    return (
      <main className="booth-mode flex min-h-dvh flex-1 flex-col">
        <div className="absolute top-0 z-40 p-4">
          <button onClick={() => router.push("/timeline")} aria-label="Back" className="glass-card flex h-11 w-11 items-center justify-center rounded-full">
            <ArrowLeft size={20} />
          </button>
        </div>
        <RoleCapture
          shots={relay.shots}
          filterId={relay.filter_id}
          onDone={onShot}
          hint="Your partner already shot their half. Finish the strip!"
        />
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
      {busy ? (
        <>
          <Loader2 className="animate-spin text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Putting your strip together…</p>
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
              onClick={async () => { await deleteRelay(relay.id); router.push("/timeline"); }}
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
