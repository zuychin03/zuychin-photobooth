"use client";
import { useEffect, useRef } from "react";

export const eventControl = "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50";
export const eventInput = "min-h-11 w-full min-w-0 rounded-xl border border-border bg-card px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-60";
export function eventError(error: unknown) {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  return ({ access_denied: "Your access has changed. Return to your events and check your account.", identity_changed: "Your account changed. Reopen your events to continue.", capacity: "The event or request limit has been reached. Your existing event remains available.", conflict: "These settings or this action changed elsewhere. Check the current event before preparing a new request.", expired: "The contribution window or event retention has ended. Refresh to check its status.", not_ready: "This event service or action is not ready. Refresh and try again.", rate_limited: "Too many requests. Wait a minute before trying again.", invalid_request: "Check the dates, limits and text before trying again." } as Record<string, string>)[code] ?? "Confirmation did not arrive. The action may already have reached the server. Retry its exact saved request or check the event first.";
}
export function useEventLeaveWarning(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const leave = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", leave); return () => window.removeEventListener("beforeunload", leave);
  }, [dirty]);
}
export function EventHostConfirm({ title, children, action, busy, returnFocus, returnFocusRef, fallbackFocusRef, onKeep, onConfirm }: { title: string; children: React.ReactNode; action: string; busy: boolean; returnFocus?: HTMLElement | null; returnFocusRef?: React.RefObject<HTMLElement | null>; fallbackFocusRef?: React.RefObject<HTMLElement | null>; onKeep(): void; onConfirm(): void }) {
  const keep = useRef<HTMLButtonElement>(null), previous = useRef<Element | null>(null);
  useEffect(() => {
    previous.current = returnFocusRef?.current ?? returnFocus ?? document.activeElement;
    const fallback = fallbackFocusRef?.current;
    keep.current?.focus();
    return () => {
      const target = previous.current;
      requestAnimationFrame(() => {
        if (target instanceof HTMLElement && target.isConnected && !target.matches(":disabled") && !target.closest("[inert]")) target.focus();
        if (document.activeElement !== target && fallback?.isConnected) fallback.focus();
      });
    };
  }, [returnFocus, returnFocusRef, fallbackFocusRef]);
  return <section role="group" aria-label={title} className="my-5 rounded-xl border border-border bg-muted p-5" onKeyDown={event => { if (event.key === "Escape" && !busy) { event.preventDefault(); onKeep(); } }}>
    <h3 className="font-semibold">{title}</h3><div className="mt-2 max-w-2xl text-sm leading-relaxed">{children}</div>
    <div className="mt-4 flex flex-wrap gap-2"><button ref={keep} type="button" className={`${eventControl} border border-border`} disabled={busy} onClick={onKeep}>Keep working</button><button type="button" className={eventControl} disabled={busy} onClick={onConfirm}>{action}</button></div>
  </section>;
}
