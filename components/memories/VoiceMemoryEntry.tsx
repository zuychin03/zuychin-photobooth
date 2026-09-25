"use client";

import { useAppNavigationGuard } from "@/components/AppNavigation";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { openVoiceRuntime, type VoiceRuntime } from "@/lib/memories/voice-runtime";
import { cloudControl } from "@/components/cloud/CloudControls";
import VoiceMemoryCaption from "./VoiceMemoryCaption";

export function VoiceMemoryEntry({ ownerId, activityId, onClose }: { ownerId: string; activityId: string; onClose(): void }) {
  const [runtime, setRuntime] = useState<VoiceRuntime | null>(null), [error, setError] = useState(false);
  const [busy, setBusy] = useState(false), [dirty, setDirty] = useState(false), [confirmClose, setConfirmClose] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null), keepButton = useRef<HTMLButtonElement>(null), closeButton = useRef<HTMLButtonElement>(null);
  useAppNavigationGuard(() => {
    if (busy || dirty) { setConfirmClose(true); return false; }
    return true;
  });
  const keepEditing = () => { setConfirmClose(false); requestAnimationFrame(() => closeButton.current?.focus()); };
  useEffect(() => {
    let live = true, handle: ReturnType<typeof openVoiceRuntime> | undefined;
    heading.current?.focus();
    void Promise.resolve().then(async () => {
      if (!live) return;
      setRuntime(null); setError(false); setBusy(false); setDirty(false); setConfirmClose(false);
      const auth = createClient();
      handle = openVoiceRuntime({ ownerId, appOrigin: location.origin,
        accessToken: async () => { const result = await auth.auth.getSession(); return !result.error && result.data.session?.user.id === ownerId ? result.data.session.access_token : null; },
        subscribe: listener => { const result = auth.auth.onAuthStateChange((_event, session) => listener(session?.user.id ?? null)); return () => result.data.subscription.unsubscribe(); },
        onInvalidated: () => { if (live) { setRuntime(null); setError(true); setBusy(false); setDirty(false); } },
      });
      const next = await handle.ready; next.client.assertActive(); if (live) setRuntime(next);
    }).catch(() => { handle?.close(); if (live) setError(true); });
    return () => { live = false; handle?.close(); };
  }, [ownerId]);
  useEffect(() => { if (confirmClose) keepButton.current?.focus(); }, [confirmClose]);
  useEffect(() => {
    if (!dirty) return;
    const leave = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", leave);
    return () => window.removeEventListener("beforeunload", leave);
  }, [dirty]);
  return <div className="mt-5 border-y border-border py-5">
    <h3 ref={heading} tabIndex={-1} className="mb-4 text-lg font-medium outline-none">A note for this memory</h3>
    {error ? <p role="alert" className="text-sm">Private caption recovery could not be opened. Close this panel, check your sign-in and browser storage, then try again. Your memory library is still available.</p> : runtime?.client.ownerId === ownerId ? <VoiceMemoryCaption key={`${ownerId}:${activityId}`} activityId={activityId} client={runtime.client} journal={runtime.journal} onBusyChange={setBusy} onDirtyChange={setDirty} locked={confirmClose} /> : <p role="status" className="text-sm">Opening private caption recovery…</p>}
    <button ref={closeButton} className={`${cloudControl} mt-5 border border-border`} disabled={busy || confirmClose} onClick={() => { if (dirty) setConfirmClose(true); else onClose(); }}>Close caption editor</button>
    {confirmClose && <div role="group" aria-label="Leave caption editor?" onKeyDown={event => { if (event.key === "Escape" && !busy) { event.preventDefault(); keepEditing(); } }} className="mt-4 rounded-xl bg-muted p-4"><p className="max-w-xl text-sm leading-relaxed">Leave this editor? Text not kept as a draft will be lost. Saved local drafts and pending requests remain with this account.</p><div className="mt-3 flex flex-wrap gap-2"><button ref={keepButton} className={`${cloudControl} border border-border`} disabled={busy} onClick={keepEditing}>Keep editing</button><button className={cloudControl} disabled={busy} onClick={onClose}>Leave caption editor</button></div></div>}
  </div>;
}
