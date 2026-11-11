"use client";
import { useRecoveryRelease } from "@/components/ReleaseMode";
import { useAppNavigationGuard } from "@/components/AppNavigation";
import { useEffect, useRef, useState } from "react";
import type { EventGuestClient } from "@/lib/events/client";
import { prepareEventConsentChange, type EventOwnConsent } from "@/lib/events/own-consent";
import { Share2, X } from "lucide-react";
import { EventHostConfirm, EventPanelHead, useEventLeaveWarning } from "./EventHostControls";
import { eventGuestError } from "@/lib/events/guest-runtime";

export function EventGuestConsentPanel({ client, submissionId, onClose, onInvalid }: { client: EventGuestClient; submissionId: string; onClose(): void; onInvalid(error: unknown): boolean }) {
  const recovery = useRecoveryRelease();
  const [current, setCurrent] = useState<EventOwnConsent | null>(null), [gallery, setGallery] = useState(false), [wall, setWall] = useState(false), [pending, setPending] = useState<ReturnType<typeof prepareEventConsentChange> | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null), [confirm, setConfirm] = useState<{ kind: "reload" | "close"; focus: HTMLElement | null } | null>(null);
  const live = useRef(false), active = useRef<AbortController | null>(null), heading = useRef<HTMLHeadingElement>(null);
  const dirty = !!pending || !!current && (gallery !== current.consent.gallery || wall !== current.consent.wall);
  useAppNavigationGuard(() => { if (!busy && !dirty) return true; setNotice(busy ? "Wait for this to finish before you leave." : "Save or close your changes before you leave."); return false; });
  useEventLeaveWarning(dirty);
  useEffect(() => { live.current = true; heading.current?.focus(); const hidden = () => { if (document.hidden) active.current?.abort(); }; document.addEventListener("visibilitychange", hidden); return () => { live.current = false; active.current?.abort(); document.removeEventListener("visibilitychange", hidden); }; }, []);
  const adopt = (next: EventOwnConsent) => { setCurrent(next); setGallery(next.consent.gallery); setWall(next.consent.wall); setPending(null); setConfirm(null); requestAnimationFrame(() => heading.current?.focus()); };
  const run = async (work: (signal: AbortSignal) => Promise<void>) => { if (active.current || !live.current) return; const abort = new AbortController(); active.current = abort; setBusy(true); setError(null); setNotice(null); try { await work(abort.signal); } catch (e) { if (live.current && !abort.signal.aborted && !onInvalid(e)) { if (e && typeof e === "object" && "code" in e && e.code === "expired") { setCurrent(null); setPending(null); setGallery(false); setWall(false); } setError(eventGuestError(e)); } } finally { if (active.current === abort) { active.current = null; if (live.current) setBusy(false); } } };
  const load = () => run(async signal => { const next = await client.ownConsent(submissionId, signal); if (live.current && !signal.aborted) adopt(next); });
  const save = () => run(async signal => { if (!current) return; const frozen = pending ?? prepareEventConsentChange(current, recovery ? false : gallery, recovery ? false : wall); setPending(frozen); const next = await client.saveOwnConsent(submissionId, frozen, signal); if (live.current && !signal.aborted) { adopt(next); setNotice("Saved. The host still needs to approve before your photo is shared."); } });
  const ask = (kind: "reload" | "close") => setConfirm({ kind, focus: document.activeElement as HTMLElement });
  const row = "btn min-h-10 text-sm";
  return <section className="panel max-w-2xl p-4 sm:p-6"><EventPanelHead headingRef={heading} icon={Share2} tone="violet">Sharing your photo</EventPanelHead><p className="mt-3 text-sm">Your guestbook message isn&apos;t shown in the gallery or on the wall. You can&apos;t take back copies people have already downloaded.</p>
    {error && <p role="alert" className="notice mt-4 border border-destructive/25 bg-destructive/8">{error}</p>}{notice && <p role="status" className="notice mt-4">{notice}</p>}
    <div inert={!!confirm} className="mt-4 space-y-3">
      {!current ? <button className={`${row} btn-tinted`} disabled={busy} onClick={() => void load()}>Load sharing settings</button> : <>
        <div className="panel-muted divide-y divide-border overflow-hidden">
          <label className="flex min-h-12 cursor-pointer items-start gap-3 px-4 py-3 text-sm font-bold"><input type="checkbox" className="mt-0.5 size-5 shrink-0 accent-accent" checked={gallery} disabled={recovery || busy || !!pending} onChange={e => setGallery(e.target.checked)} /><span>Show it in the event gallery</span></label>
          <label className="flex min-h-12 cursor-pointer items-start gap-3 px-4 py-3 text-sm font-bold"><input type="checkbox" className="mt-0.5 size-5 shrink-0 accent-accent" checked={wall} disabled={recovery || busy || !!pending} onChange={e => setWall(e.target.checked)} /><span>Show it on the public event wall</span></label>
        </div>
        {recovery && <p className="text-sm text-muted-foreground">While uploads are paused, you can only turn sharing off.</p>}
        <p className="text-sm text-muted-foreground">Gallery: {current.receipt.gallery.replaceAll("_", " ")}. Wall: {current.receipt.wall.replaceAll("_", " ")}.</p>
        {pending && <p className="notice">Save not confirmed. Try again, or check your saved settings.</p>}
        <div className="flex flex-wrap gap-2"><button className={`${row} btn-primary`} disabled={busy || (recovery ? !current.consent.gallery && !current.consent.wall : !dirty)} onClick={() => void save()}>{recovery ? "Make photo private" : pending ? "Try again" : "Save"}</button>
        <button className={`${row} btn-quiet`} disabled={busy} onClick={() => dirty ? ask("reload") : void load()}>Check saved settings</button></div>
      </>}
      <button className={`${row} btn-plain`} disabled={busy} onClick={() => dirty ? ask("close") : onClose()}><X size={15} aria-hidden /> Close</button>
    </div>
    {confirm && <EventHostConfirm title="Discard your changes?" action={confirm.kind === "reload" ? "Load saved settings" : "Discard and close"} returnFocus={confirm.focus} busy={busy} onKeep={() => setConfirm(null)} onConfirm={() => confirm.kind === "reload" ? void load() : onClose()}><p>Your last change may have already saved.</p></EventHostConfirm>}
  </section>;
}
