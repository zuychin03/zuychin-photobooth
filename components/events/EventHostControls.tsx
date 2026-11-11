"use client";
import { useEffect, useId, useRef, type ReactNode, type Ref } from "react";
import type { LucideIcon } from "lucide-react";

// v2-lab rehearsals still append their own fill to this.
export const eventControl = "btn min-h-11 text-sm disabled:cursor-not-allowed";
const tones = { rose: "bg-[#f43f5e]", violet: "bg-[#8b5cf6]", amber: "bg-[#f59e0b]", sky: "bg-[#0ea5e9]", green: "bg-[#10b981]", slate: "bg-[#64748b]" } as const;
export type EventTone = keyof typeof tones;
export function EventGlyph({ icon: Icon, tone, className = "" }: { icon: LucideIcon; tone: EventTone; className?: string }) {
  return <span className={`glyph ${tones[tone]} ${className}`}><Icon size={18} strokeWidth={2.25} aria-hidden /></span>;
}
// Section's header, for panels whose heading takes focus.
export function EventPanelHead({ id, icon, tone, headingRef, action, as: Heading = "h2", children }: { id?: string; icon: LucideIcon; tone: EventTone; headingRef?: Ref<HTMLHeadingElement>; action?: ReactNode; as?: "h2" | "h3"; children: ReactNode }) {
  return <div className="flex min-h-9 flex-wrap items-center justify-between gap-3">
    <div className="flex min-w-0 items-center gap-3"><EventGlyph icon={icon} tone={tone} /><Heading ref={headingRef} id={id} tabIndex={headingRef ? -1 : undefined} className="flex min-w-0 items-center gap-1.5 font-display text-xl leading-tight outline-none">{children}</Heading></div>
    {action}
  </div>;
}
const statusDot: Record<string, string> = { open: "bg-[#10b981]", paused: "bg-[#f59e0b]", draft: "bg-[#0ea5e9]", closed: "bg-[#64748b]", deleted: "bg-destructive" };
export function EventStatusChip({ status }: { status: string }) {
  return <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-xs leading-none font-bold text-foreground capitalize"><span aria-hidden className={`size-1.5 rounded-full ${statusDot[status] ?? "bg-muted-foreground"}`} />{status}</span>;
}
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
  return <dialog ref={dialog} aria-labelledby={titleId} aria-describedby={descriptionId} aria-busy={busy} className="glass-strong m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg overflow-y-auto overscroll-contain rounded-[1.75rem] border-0 p-5 text-foreground sm:p-6" onCancel={event => { event.preventDefault(); if (!busy) onKeep(); }}>
    <h3 id={titleId} className="font-display text-2xl leading-tight">{title}</h3><div id={descriptionId} className="mt-3 text-sm leading-relaxed">{children}</div>
    <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><button ref={keep} type="button" className="btn btn-quiet" disabled={busy} onClick={() => { if (!busy) onKeep(); }}>Keep working</button><button type="button" className="btn btn-primary" disabled={busy} onClick={() => { if (!busy) onConfirm(); }}>{action}</button></div>
  </dialog>;
}
