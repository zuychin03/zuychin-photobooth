/* eslint-disable @next/next/no-img-element -- Explicit local preview uses a disposable Blob URL. */
"use client";

import { HelpTooltip } from "@/components/HelpTooltip";
import { useEffect, useRef, useState } from "react";
import { ImagePlus, Download, X } from "lucide-react";
import { cloudControl } from "@/components/cloud/CloudControls";
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
    catch { if (alive.current && !abort.signal.aborted) setError("The preview could not be prepared. Choose a still JPEG, PNG or WebP up to 10 MiB, or try again after other photo processing finishes."); }
    finally { running.current = false; if (alive.current) setBusy(false); callback.current?.(false); }
  };
  const shown = preview?.settingsKey === settingsKey ? preview : null;
  return <section className="border-t border-border py-6" aria-labelledby="event-test-preview-title"><h2 id="event-test-preview-title" className="font-display text-2xl">Try your event look <HelpTooltip label="About test previews">Try the frame, filter and caption without uploading or using event space. The original stays unchanged; imported photo dates are omitted.</HelpTooltip></h2><p className="mt-2 max-w-xl text-sm leading-relaxed text-foreground/75">Preview a photo on this device. Nothing is uploaded.</p>
    <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (file) void choose(file); }} />
    <div className="mt-4 flex flex-wrap gap-2"><button className={`${cloudControl} border border-border`} disabled={disabled || busy} onClick={() => input.current?.click()}><ImagePlus size={17} aria-hidden /> {busy ? "Preparing preview…" : "Choose a test photo"}</button>{(shown || busy) && <button className={cloudControl} onClick={clear}><X size={17} aria-hidden /> {busy ? "Cancel preview" : "Clear preview"}</button>}</div>
    {error && <p role="alert" className="mt-3 text-sm leading-relaxed">{error}</p>}{busy && <p role="status" className="mt-3 text-sm">Preparing a local preview. Nothing is uploaded.</p>}
    {shown && <div className="mt-5"><img src={shown.url} alt="Local test of the current event look" className="max-h-[28rem] max-w-full rounded-xl object-contain" />{shown.warning && <p className="mt-3 max-w-xl text-sm leading-relaxed text-foreground/75">{shown.warning}</p>}<button className={`${cloudControl} mt-3 border border-border`} disabled={disabled || busy} onClick={() => downloadProjectBlob(shown.blob, "event-look-preview.jpg")}><Download size={17} aria-hidden /> Save test preview</button></div>}
  </section>;
}
