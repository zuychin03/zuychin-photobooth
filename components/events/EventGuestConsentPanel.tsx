"use client";
import { useAppNavigationGuard } from "@/components/AppNavigation";
import { useEffect, useRef, useState } from "react";
import type { EventGuestClient } from "@/lib/events/client";
import { prepareEventConsentChange, type EventOwnConsent } from "@/lib/events/own-consent";
import { EventHostConfirm, eventControl, useEventLeaveWarning } from "./EventHostControls";
import { eventGuestError } from "@/lib/events/guest-runtime";

export function EventGuestConsentPanel({ client, submissionId, onClose, onInvalid }: { client: EventGuestClient; submissionId: string; onClose(): void; onInvalid(error: unknown): boolean }) {
  const [current, setCurrent] = useState<EventOwnConsent | null>(null), [gallery, setGallery] = useState(false), [wall, setWall] = useState(false), [pending, setPending] = useState<ReturnType<typeof prepareEventConsentChange> | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null), [confirm, setConfirm] = useState<{ kind: "reload" | "close"; focus: HTMLElement | null } | null>(null);
  const live = useRef(false), active = useRef<AbortController | null>(null), heading = useRef<HTMLHeadingElement>(null);
  const dirty = !!pending || !!current && (gallery !== current.consent.gallery || wall !== current.consent.wall);
  useAppNavigationGuard(() => { if (!busy && !dirty) return true; setNotice(busy ? "Wait for this permission request to finish before leaving." : "Save or close your permission changes before leaving."); return false; });
  useEventLeaveWarning(dirty);
  useEffect(() => { live.current = true; heading.current?.focus(); const hidden = () => { if (document.hidden) active.current?.abort(); }; document.addEventListener("visibilitychange", hidden); return () => { live.current = false; active.current?.abort(); document.removeEventListener("visibilitychange", hidden); }; }, []);
  const adopt = (next: EventOwnConsent) => { setCurrent(next); setGallery(next.consent.gallery); setWall(next.consent.wall); setPending(null); setConfirm(null); requestAnimationFrame(() => heading.current?.focus()); };
  const run = async (work: (signal: AbortSignal) => Promise<void>) => { if (active.current || !live.current) return; const abort = new AbortController(); active.current = abort; setBusy(true); setError(null); setNotice(null); try { await work(abort.signal); } catch (e) { if (live.current && !abort.signal.aborted && !onInvalid(e)) { if (e && typeof e === "object" && "code" in e && e.code === "expired") { setCurrent(null); setPending(null); setGallery(false); setWall(false); } setError(eventGuestError(e)); } } finally { if (active.current === abort) { active.current = null; if (live.current) setBusy(false); } } };
  const load = () => run(async signal => { const next = await client.ownConsent(submissionId, signal); if (live.current && !signal.aborted) adopt(next); });
  const save = () => run(async signal => { if (!current) return; const frozen = pending ?? prepareEventConsentChange(current, gallery, wall); setPending(frozen); const next = await client.saveOwnConsent(submissionId, frozen, signal); if (live.current && !signal.aborted) { adopt(next); setNotice("Current photo permissions confirmed. New permission still needs host approval before publication."); } });
  const ask = (kind: "reload" | "close") => setConfirm({ kind, focus: document.activeElement as HTMLElement });
  return <section className="my-7 max-w-2xl border-y border-border py-6"><h2 ref={heading} tabIndex={-1} className="font-display text-3xl outline-none">Your photo permissions</h2><p className="mt-3 text-sm leading-relaxed">Gallery and wall choices are separate. They do not delete your event photo or publish your guestbook message. Existing downloads cannot be recalled.</p>
    {error && <p role="alert" className="mt-4 text-sm">{error}</p>}{notice && <p role="status" className="mt-4 text-sm">{notice}</p>}
    <div inert={!!confirm} className="mt-5 space-y-4">
      {!current ? <button className={`${eventControl} border border-border`} disabled={busy} onClick={() => void load()}>Load current photo permissions</button> : <>
        <label className="flex min-h-11 items-start gap-3 text-sm"><input type="checkbox" className="mt-1 size-5 accent-accent" checked={gallery} disabled={busy || !!pending} onChange={e => setGallery(e.target.checked)} /><span>Allow this photo in the event gallery</span></label>
        <label className="flex min-h-11 items-start gap-3 text-sm"><input type="checkbox" className="mt-1 size-5 accent-accent" checked={wall} disabled={busy || !!pending} onChange={e => setWall(e.target.checked)} /><span>Allow this photo on the public event wall</span></label>
        <p className="text-sm text-foreground/70">Current gallery status: {current.receipt.gallery.replaceAll("_", " ")}. Wall: {current.receipt.wall.replaceAll("_", " ")}. Your choices above are separate from the host’s approval.</p>
        <button className={`${eventControl} border border-border`} disabled={busy || !dirty} onClick={() => void save()}>{pending ? "Retry exact permission change" : "Save photo permissions"}</button>
        {pending && <p className="text-sm">Not confirmed. Retry these choices or check the saved permissions before changing them.</p>}
        <button className={eventControl} disabled={busy} onClick={() => dirty ? ask("reload") : void load()}>Check current permissions</button>
      </>}
      <button className={eventControl} disabled={busy} onClick={() => dirty ? ask("close") : onClose()}>Close photo permissions</button>
    </div>
    {confirm && <EventHostConfirm title="Leave these page edits?" action={confirm.kind === "reload" ? "Load current permissions" : "Discard page edits and close"} returnFocus={confirm.focus} busy={busy} onKeep={() => setConfirm(null)} onConfirm={() => confirm.kind === "reload" ? void load() : onClose()}><p>An unconfirmed request may already be saved. This clears only the edits and retry held in this page, not server permission.</p></EventHostConfirm>}
  </section>;
}
