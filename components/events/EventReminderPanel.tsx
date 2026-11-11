"use client";
import { HelpTooltip } from "@/components/HelpTooltip";
import { useCallback, useEffect, useRef, useState } from "react";
import type { EventReminderClient } from "@/lib/events/reminder-client";
import { BellRing } from "lucide-react";
import { EventPanelHead, eventError } from "./EventHostControls";
type Projection = Awaited<ReturnType<EventReminderClient["read"]>>;
type Choice = { expectedRevision: number; email: boolean; push: boolean };
export function EventReminderPanel({ client, eventId, disabled = false, onBusyChange, onDirtyChange, onInitialReadSettled }: { client: EventReminderClient; eventId: string; disabled?: boolean; onBusyChange?(busy: boolean): void; onDirtyChange?(dirty: boolean): void; onInitialReadSettled?(): void }) {
  const [value, setValue] = useState<Projection | null>(null), [pending, setPending] = useState<Choice | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null), [lost, setLost] = useState(false);
  const active = useRef<AbortController | null>(null), live = useRef(false), external = useRef(disabled), callbacks = useRef({ onBusyChange, onDirtyChange, onInitialReadSettled });
  const initialReadSettled = useRef(false);
  useEffect(() => { external.current = disabled; callbacks.current = { onBusyChange, onDirtyChange, onInitialReadSettled }; if (disabled) active.current?.abort("panel_disabled"); }, [disabled, onBusyChange, onDirtyChange, onInitialReadSettled]);
  const run = useCallback(async (save?: Choice) => {
    if (active.current || external.current) return;
    const controller = new AbortController(); active.current = controller; setBusy(true); setError(null); setNotice(null);
    let interruptedRead = false;
    try {
      const next = save ? await client.save(eventId, save, controller.signal) : await client.read(eventId, controller.signal);
      client.assertActive(controller.signal); if (!live.current) return;
      setValue(next); setPending(null); setLost(false); if (save) setNotice("Reminder settings saved.");
    } catch (failure) {
      if (live.current) {
        setNotice(null);
        const code = failure && typeof failure === "object" && "code" in failure ? String(failure.code) : "";
        const accessLost = ["identity_changed", "access_denied", "expired"].includes(code);
        interruptedRead = !save && code === "cancelled" && controller.signal.aborted && controller.signal.reason === "panel_disabled";
        if (interruptedRead) return;
        if (accessLost) { setValue(null); setPending(null); setLost(true); }
        setError(save || accessLost ? eventError(failure) : "Couldn't load reminder settings. Try again later.");
      }
    } finally {
      if (active.current === controller) active.current = null;
      if (live.current) {
        setBusy(false);
        if (!save && !interruptedRead && !initialReadSettled.current) { initialReadSettled.current = true; callbacks.current.onInitialReadSettled?.(); }
      }
    }
  }, [client, eventId]);
  useEffect(() => { live.current = true; const timer = setTimeout(() => void run(), 0); const hide = () => active.current?.abort(); addEventListener("pagehide", hide); return () => { live.current = false; clearTimeout(timer); removeEventListener("pagehide", hide); active.current?.abort(); callbacks.current.onBusyChange?.(false); callbacks.current.onDirtyChange?.(false); }; }, [run]);
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  useEffect(() => { if (!disabled && !value && !busy && !pending && !error && !lost) { const timer = setTimeout(() => void run(), 0); return () => clearTimeout(timer); } }, [disabled, value, busy, pending, error, lost, run]);
  useEffect(() => { onDirtyChange?.(!!pending); }, [pending, onDirtyChange]);
  const change = (channel: "email" | "push", enabled: boolean) => { if (!value || busy || disabled || pending) return; const next = { expectedRevision: value.settings.revision, email: value.settings.email, push: value.settings.push, [channel]: enabled }; setPending(next); void run(next); };
  return <section className="panel p-4 sm:p-6" aria-label="Expiry reminder"><EventPanelHead icon={BellRing} tone="amber" action={!pending && <button className="btn btn-quiet min-h-10 text-sm" disabled={busy || disabled || lost} onClick={() => void run()}>Refresh</button>}>Expiry reminder <HelpTooltip label="About expiry reminders">Scheduled once per expiry date, about 24 hours before expiry, or at the next check if enabled later.</HelpTooltip></EventPanelHead><p className="mt-3 text-sm text-muted-foreground">Reminders can fail. Photos still expire on time, so keep your own reminder too.</p>
    {error && <p role="alert" className="notice mt-4 border border-destructive/25 bg-destructive/8">{error}</p>}{notice && <p role="status" className="notice mt-4">{notice}</p>}{busy && <p role="status" className="mt-3 text-sm text-muted-foreground">Loading…</p>}
    {value && !lost && <><p className="mt-4 text-sm">Delivery status: <span className="font-bold">{value.settings.status}</span>.</p><div className="mt-3 grid gap-2">{(["email", "push"] as const).map(channel => { const available = value.configured[channel] && value.settings[channel === "email" ? "emailAvailable" : "pushAvailable"]; return <label key={channel} className="panel-muted flex min-h-12 cursor-pointer items-start gap-3 px-4 py-3 text-sm"><input type="checkbox" checked={value.settings[channel]} disabled={disabled || busy || !!pending || !available && !value.settings[channel]} onChange={event => change(channel, event.target.checked)} className="mt-0.5 size-5 shrink-0 accent-accent" /><span className="font-bold">{channel === "email" ? "Email me" : "Send a push notification"}{!value.configured[channel] ? <span className="mt-0.5 block font-medium text-muted-foreground">Not available here.</span> : !available ? <span className="mt-0.5 block font-medium text-muted-foreground">{channel === "email" ? "Your account doesn't have a verified email." : "Turn on notifications in a browser first."}</span> : null}</span></label>; })}</div></>}
    {pending && <div className="notice mt-4"><p>These settings may have already saved. Try again, or check them.</p><div className="mt-3 flex flex-wrap gap-2"><button className="btn btn-quiet min-h-10 text-sm" disabled={busy || disabled} onClick={() => void run(pending)}>Try again</button><button className="btn btn-plain min-h-10 text-sm" disabled={busy || disabled} onClick={() => void run()}>Check</button></div></div>}
  </section>;
}
