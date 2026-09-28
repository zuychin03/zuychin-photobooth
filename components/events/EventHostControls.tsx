"use client";
import { useEffect, useId, useRef } from "react";

export const eventControl = "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50";
export const eventInput = "min-h-11 w-full min-w-0 rounded-xl border border-border bg-card px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-60";
export function eventError(error: unknown) {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  return ({ access_denied: "Your access has changed. Go back to your events.", identity_changed: "You switched accounts. Reopen your events.", capacity: "You've reached a limit for events or requests.", conflict: "This changed somewhere else. Check the event before trying again.", expired: "This event has closed or expired. Refresh to check.", not_ready: "This isn't ready yet. Refresh and try again.", rate_limited: "Too many requests. Wait a minute before trying again.", invalid_request: "Check the dates, limits and text before trying again." } as Record<string, string>)[code] ?? "No reply from the server, but it may have worked. Check the event before trying again.";
}
export function useEventLeaveWarning(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const leave = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", leave); return () => window.removeEventListener("beforeunload", leave);
  }, [dirty]);
}
export function EventHostConfirm({ title, children, action, busy, returnFocus, returnFocusRef, fallbackFocusRef, onKeep, onConfirm }: { title: string; children: React.ReactNode; action: string; busy: boolean; returnFocus?: HTMLElement | null; returnFocusRef?: React.RefObject<HTMLElement | null>; fallbackFocusRef?: React.RefObject<HTMLElement | null>; onKeep(): void; onConfirm(): void }) {
  const dialog = useRef<HTMLDialogElement>(null), keep = useRef<HTMLButtonElement>(null), previous = useRef<Element | null>(null), titleId = useId(), descriptionId = useId();
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    previous.current = returnFocusRef?.current ?? returnFocus ?? document.activeElement;
    const fallback = fallbackFocusRef?.current;
    const overflow = document.body.style.overflow;
    element.showModal();
    document.body.style.overflow = "hidden";
    keep.current?.focus();
    return () => {
      const target = previous.current;
      element.close();
      document.body.style.overflow = overflow;
      requestAnimationFrame(() => {
        if (element.isConnected && element.open) return;
        if (target instanceof HTMLElement && target.isConnected && !target.matches(":disabled") && !target.closest("[inert]")) target.focus();
        if (document.activeElement !== target && fallback?.isConnected) fallback.focus();
      });
    };
  }, [returnFocus, returnFocusRef, fallbackFocusRef]);
  return <dialog ref={dialog} aria-labelledby={titleId} aria-describedby={descriptionId} aria-busy={busy} className="m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg overflow-y-auto overscroll-contain rounded-2xl border border-border bg-card p-5 text-foreground shadow-xl backdrop:bg-black/60" onCancel={event => { event.preventDefault(); if (!busy) onKeep(); }}>
    <h3 id={titleId} className="font-display text-2xl">{title}</h3><div id={descriptionId} className="mt-3 text-sm leading-relaxed">{children}</div>
    <div className="mt-5 flex flex-wrap gap-2"><button ref={keep} type="button" className={`${eventControl} border border-border`} disabled={busy} onClick={() => { if (!busy) onKeep(); }}>Keep working</button><button type="button" className={`${eventControl} bg-accent text-accent-foreground`} disabled={busy} onClick={() => { if (!busy) onConfirm(); }}>{action}</button></div>
  </dialog>;
}
