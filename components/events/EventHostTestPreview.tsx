/* eslint-disable @next/next/no-img-element -- Explicit local preview uses a disposable Blob URL. */
"use client";

import { HelpTooltip } from "@/components/HelpTooltip";
import { useEffect, useRef, useState } from "react";
import { ImagePlus, Download, X } from "lucide-react";
import { EventPanelHead } from "./EventHostControls";
import { prepareEventGuestPhoto } from "@/lib/events/guest-photo";
import type { EventSettingsInput } from "@/lib/events/host-contract";
import { downloadProjectBlob } from "@/lib/projects/download";

export function EventHostTestPreview({ settings, disabled = false, onBusyChange }: { settings: EventSettingsInput; disabled?: boolean; onBusyChange?(busy: boolean): void }) {
  const [preview, setPreview] = useState<{ url: string; blob: Blob; settingsKey: string; warning: string | null } | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null), active = useRef<AbortController | null>(null), url = useRef<string | null>(null), alive = useRef(false), running = useRef(false), callback = useRef(onBusyChange); const settingsKey = JSON.stringify(settings);
  useEffect(() => { callback.current = onBusyChange; }, [onBusyChange]);
  const clear = () => { active.current?.abort(); if (url.current) URL.revokeObjectURL(url.current); url.current = null; setPreview(null); };
  useEffect(() => { alive.current = true; const hidden = () => { if (document.hidden) { active.current?.abort(); if (url.current) URL.revokeObjectURL(url.current); url.current = null; setPreview(null); } }; document.addEventListener("visibilitychange", hidden); return () => { alive.current = false; active.current?.abort(); if (url.current) URL.revokeObjectURL(url.current); url.current = null; callback.current?.(false); document.removeEventListener("visibilitychange", hidden); }; }, []);
  useEffect(() => { active.current?.abort(); if (url.current) URL.revokeObjectURL(url.current); url.current = null; let current = true; queueMicrotask(() => { if (current) setPreview(null); }); return () => { current = false; }; }, [settingsKey]);
  const choose = async (file: File) => {
    if (running.current || disabled) return; running.current = true; clear(); const abort = new AbortController(); active.current = abort; setBusy(true); callback.current?.(true); setError(null);
    try { const prepared = await prepareEventGuestPhoto(file, { version: 1, eventId: "00000000-0000-4000-8000-000000000000", ...settings.event, look: settings.look, status: "draft", capacityAvailable: true, canReserve: false }, abort.signal); if (!alive.current || abort.signal.aborted) return; const next = URL.createObjectURL(prepared.blob); url.current = next; setPreview({ ...prepared, url: next, settingsKey }); }
    catch { if (alive.current && !abort.signal.aborted) setError("Couldn't make the preview. Choose a JPEG, PNG or WebP up to 10 MiB, then try again."); }
    finally { running.current = false; if (alive.current) setBusy(false); callback.current?.(false); }
  };
  const shown = preview?.settingsKey === settingsKey ? preview : null;
  return <section className="panel p-4 sm:p-6" aria-labelledby="event-test-preview-title"><EventPanelHead id="event-test-preview-title" icon={ImagePlus} tone="sky">Try your event look <HelpTooltip label="About test previews">The preview uses your frame, filter and caption. It doesn&apos;t use any event storage.</HelpTooltip></EventPanelHead><p className="mt-3 text-sm text-muted-foreground">Nothing is uploaded.</p>
    <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (file) void choose(file); }} />
    <div className="mt-4 flex flex-wrap gap-2"><button className="btn btn-tinted min-h-10 text-sm" disabled={disabled || busy} onClick={() => input.current?.click()}><ImagePlus size={16} aria-hidden /> {busy ? "Preparing preview…" : "Choose a test photo"}</button>{(shown || busy) && <button className="btn btn-plain min-h-10 text-sm" onClick={clear}><X size={16} aria-hidden /> {busy ? "Cancel preview" : "Clear preview"}</button>}</div>
    {error && <p role="alert" className="notice mt-4 border border-destructive/25 bg-destructive/8">{error}</p>}{busy && <p role="status" className="mt-3 text-sm text-muted-foreground">Making the preview…</p>}
    {shown && <div className="panel-muted mt-4 flex flex-col items-center gap-3 p-3 sm:p-4"><img src={shown.url} alt="Preview of your event look" className="max-h-[28rem] max-w-full rounded-xl object-contain shadow-[0_14px_32px_-18px_rgb(0_0_0/0.5)]" />{shown.warning && <p className="max-w-xl self-start text-sm text-muted-foreground">{shown.warning}</p>}<button className="btn btn-quiet min-h-10 self-start text-sm" disabled={disabled || busy} onClick={() => downloadProjectBlob(shown.blob, "event-look-preview.jpg")}><Download size={16} aria-hidden /> Download preview</button></div>}
  </section>;
}
