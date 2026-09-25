"use client";
import { HelpTooltip } from "@/components/HelpTooltip";
import { useCallback, useEffect, useRef, useState } from "react";
import type { EventReminderClient } from "@/lib/events/reminder-client";
import { eventControl, eventError } from "./EventHostControls";
type Projection = Awaited<ReturnType<EventReminderClient["read"]>>;
type Choice = { expectedRevision: number; email: boolean; push: boolean };
export function EventReminderPanel({ client, eventId, disabled = false, onBusyChange, onDirtyChange, onInitialReadSettled }: { client: EventReminderClient; eventId: string; disabled?: boolean; onBusyChange?(busy: boolean): void; onDirtyChange?(dirty: boolean): void; onInitialReadSettled?(): void }) {
  const [value, setValue] = useState<Projection | null>(null), [pending, setPending] = useState<Choice | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null), [lost, setLost] = useState(false);
  const active = useRef<AbortController | null>(null), live = useRef(false), external = useRef(disabled), callbacks = useRef({ onBusyChange, onDirtyChange, onInitialReadSettled });
  const initialReadSettled = useRef(false);
  useEffect(() => { external.current = disabled; callbacks.current = { onBusyChange, onDirtyChange, onInitialReadSettled }; if (disabled) active.current?.abort(); }, [disabled, onBusyChange, onDirtyChange, onInitialReadSettled]);
  const run = useCallback(async (save?: Choice) => {
    if (active.current || external.current) return;
    const controller = new AbortController(); active.current = controller; setBusy(true); setError(null); setNotice(null);
    try {
      const next = save ? await client.save(eventId, save, controller.signal) : await client.read(eventId, controller.signal);
      client.assertActive(controller.signal); if (!live.current) return;
      setValue(next); setPending(null); setLost(false); if (save) setNotice("Reminder preferences confirmed. Expiry still applies even if a reminder cannot be delivered.");
    } catch (failure) {
      if (live.current) {
        setNotice(null);
        const code = failure && typeof failure === "object" && "code" in failure ? String(failure.code) : "";
        const accessLost = ["identity_changed", "access_denied", "expired"].includes(code);
        if (accessLost) { setValue(null); setPending(null); setLost(true); }
        setError(save || accessLost ? eventError(failure) : "Reminder settings are unavailable. Try again later or keep your own expiry reminder.");
      }
    } finally {
      if (active.current === controller) active.current = null;
      if (live.current) {
        setBusy(false);
        if (!save && !initialReadSettled.current) { initialReadSettled.current = true; callbacks.current.onInitialReadSettled?.(); }
      }
    }
  }, [client, eventId]);
  useEffect(() => { live.current = true; const timer = setTimeout(() => void run(), 0); const hide = () => active.current?.abort(); addEventListener("pagehide", hide); return () => { live.current = false; clearTimeout(timer); removeEventListener("pagehide", hide); active.current?.abort(); callbacks.current.onBusyChange?.(false); callbacks.current.onDirtyChange?.(false); }; }, [run]);
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  useEffect(() => { if (!disabled && !value && !error && !lost) { const timer = setTimeout(() => void run(), 0); return () => clearTimeout(timer); } }, [disabled, value, error, lost, run]);
  useEffect(() => { onDirtyChange?.(!!pending); }, [pending, onDirtyChange]);
  const change = (channel: "email" | "push", enabled: boolean) => { if (!value || busy || disabled || pending) return; const next = { expectedRevision: value.settings.revision, email: value.settings.email, push: value.settings.push, [channel]: enabled }; setPending(next); void run(next); };
  return <section className="border-t border-border py-7" aria-label="Expiry reminder"><h3 className="font-display text-2xl">Expiry reminder <HelpTooltip label="About expiry reminders">The reminder is scheduled about 24 hours before expiry, or at the next check if enabled later. It is sent once per expiry date, even if preferences change.</HelpTooltip></h3><p className="mt-3 max-w-2xl text-sm text-foreground/70">Get a reminder before photos expire. Keep your own reminder too; expiry does not change.</p>
    {error && <p role="alert" className="mt-3 text-sm">{error}</p>}{notice && <p role="status" className="mt-3 text-sm">{notice}</p>}{busy && <p role="status" className="mt-3 text-sm">Checking reminder preferences...</p>}
    {value && !lost && <><p className="mt-3 text-sm">Delivery status: {value.settings.status}.</p><div className="mt-4 space-y-3">{(["email", "push"] as const).map(channel => { const available = value.configured[channel] && value.settings[channel === "email" ? "emailAvailable" : "pushAvailable"]; return <label key={channel} className="flex items-start gap-3 text-sm"><input type="checkbox" checked={value.settings[channel]} disabled={disabled || busy || !!pending || !available && !value.settings[channel]} onChange={event => change(channel, event.target.checked)} className="mt-1 accent-accent" /><span>{channel === "email" ? "Email my verified account address" : "Notify my subscribed browsers"}{!value.configured[channel] ? <span className="block text-foreground/70">This delivery channel is not configured here.</span> : !available ? <span className="block text-foreground/70">{channel === "email" ? "No verified account email is available." : "No browser notification subscription is available."}</span> : null}</span></label>; })}</div></>}
    {pending && <div className="mt-4 rounded-xl bg-muted p-4"><p className="text-sm">These preferences may already be saved. Retry or check them before leaving.</p><button className={`${eventControl} mt-2 border border-border`} disabled={busy || disabled} onClick={() => void run(pending)}>Retry exact preferences</button><button className={`${eventControl} mt-2`} disabled={busy || disabled} onClick={() => void run()}>Check current preferences</button></div>}
    {!pending && <button className={`${eventControl} mt-4 border border-border`} disabled={busy || disabled || lost} onClick={() => void run()}>Refresh reminder status</button>}
  </section>;
}
