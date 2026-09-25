/* eslint-disable @next/next/no-img-element -- Private media uses one disposable Blob URL. */
"use client";

import { useEffect, useRef, useState } from "react";
import type { EventReviewClient } from "@/lib/events/review-client";
import { eventControl } from "./EventHostControls";

export function EventModerationPhoto({ client, eventId, submissionId, disabled, onClose, onBusyChange }: { client: EventReviewClient; eventId: string; submissionId: string; disabled: boolean; onClose(): void; onBusyChange(busy: boolean): void }) {
  const [preview, setPreview] = useState<string | null>(null), [error, setError] = useState(false);
  const figure = useRef<HTMLElement>(null);
  const callbacks = useRef({ onClose, onBusyChange });
  useEffect(() => { callbacks.current = { onClose, onBusyChange }; }, [onClose, onBusyChange]);
  useEffect(() => {
    if (disabled) return;
    const abort = new AbortController(); let url: string | null = null, running = false, freshUntil = 0, nextCheck = 0;
    const clear = () => { abort.abort(); if (url) URL.revokeObjectURL(url); url = null; setPreview(null); callbacks.current.onBusyChange(false); };
    const check = () => { client.assertActive(abort.signal); if (document.hidden || !navigator.onLine) throw new Error("unavailable"); };
    const failed = () => { if (!abort.signal.aborted) { clear(); setError(true); } };
    const checkAccess = async () => {
      if (running || abort.signal.aborted) return; running = true; const started = Date.now(); nextCheck = started + 5000;
      try { await client.access(eventId, submissionId, abort.signal); check(); if (Date.now() >= started + 10000) throw new Error("expired"); freshUntil = started + 10000; }
      catch { failed(); } finally { running = false; }
    };
    callbacks.current.onBusyChange(true);
    void Promise.resolve().then(async () => {
      setPreview(null); setError(false); const started = Date.now(); nextCheck = started + 5000; check(); const blob = await client.download(eventId, submissionId, abort.signal); check();
      if (Date.now() >= started + 10000) throw new Error("expired");
      freshUntil = started + 10000; url = URL.createObjectURL(blob); setPreview(url); requestAnimationFrame(() => { if (!abort.signal.aborted) figure.current?.focus(); });
    }).catch(failed).finally(() => { if (!abort.signal.aborted) callbacks.current.onBusyChange(false); });
    const timer = setInterval(() => { if (freshUntil && Date.now() >= freshUntil) failed(); else if (url && Date.now() >= nextCheck) void checkAccess(); }, 100);
    const hidden = () => { if (document.hidden) { clear(); callbacks.current.onClose(); } }, offline = () => { clear(); callbacks.current.onClose(); };
    document.addEventListener("visibilitychange", hidden); window.addEventListener("offline", offline);
    return () => { clearInterval(timer); abort.abort(); if (url) URL.revokeObjectURL(url); callbacks.current.onBusyChange(false); document.removeEventListener("visibilitychange", hidden); window.removeEventListener("offline", offline); };
  }, [client, eventId, submissionId, disabled]);
  return <figure ref={figure} tabIndex={-1} aria-label="Private photo review" className="my-4 outline-none">{error ? <p role="alert" className="text-sm">This preview could not be reauthorised and has been cleared. Close it and refresh moderation before trying again.</p> : preview && !disabled ? <img src={preview} alt="Private photo being reviewed for event publication" className="max-h-80 max-w-full rounded-xl object-contain" /> : <p role="status" className="text-sm">Checking this private photo…</p>}<button className={`${eventControl} mt-2`} onClick={onClose}>Close review photo</button></figure>;
}
