"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Bell, BellOff, BellRing } from "lucide-react";
import { type PushState, disablePush, enablePush, getPushState, pushErrorMessage } from "@/lib/push-client";

export function PushToggle({ userId }: { userId: string }) {
  return <AccountPushToggle key={userId} userId={userId} />;
}

function AccountPushToggle({ userId }: { userId: string }) {
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false), [portalRoot, setPortalRoot] = useState<Element | null>(null);
  const id = useId(), trigger = useRef<HTMLButtonElement>(null), popup = useRef<HTMLDivElement>(null), heading = useRef<HTMLHeadingElement>(null);
  const live = useRef(false), working = useRef(false);
  const close = useCallback((restore = false) => { setOpen(false); if (restore) trigger.current?.focus({ preventScroll: true }); }, []);
  const show = () => {
    if (trigger.current?.closest("[inert]")) return;
    setPortalRoot(typeof HTMLElement.prototype.showPopover === "function" ? null : trigger.current?.closest("dialog[open]") ?? document.body);
    setOpen(true);
  };
  const position = useCallback(() => {
    const button = trigger.current, panel = popup.current;
    if (!button || !panel) return;
    const rect = button.getBoundingClientRect(), parent = (button.closest("header") ?? button.parentElement?.parentElement)?.getBoundingClientRect(), visual = window.visualViewport;
    const x = visual?.offsetLeft ?? 0, y = visual?.offsetTop ?? 0, width = visual?.width ?? window.innerWidth, height = visual?.height ?? window.innerHeight;
    if (!rect.width || rect.bottom < y || rect.top > y + height || button.closest("[inert]")) { close(); return; }
    const left = Math.max(x + 12, parent?.left ?? x + 12), right = Math.min(x + width - 12, parent?.right ?? x + width - 12);
    panel.style.width = `${Math.max(0, Math.min(280, right - left))}px`;
    const below = y + height - rect.bottom - 16, above = rect.top - y - 16, useBelow = panel.scrollHeight <= below || below >= above;
    panel.style.maxHeight = `${Math.max(40, useBelow ? below : above)}px`;
    const size = panel.getBoundingClientRect();
    Object.assign(panel.style, { left: `${Math.max(left, Math.min(rect.right - size.width, right - size.width))}px`, top: `${useBelow ? rect.bottom + 8 : Math.max(y + 12, rect.top - size.height - 8)}px`, visibility: "visible" });
  }, [close]);

  useEffect(() => {
    let active = true; live.current = true;
    void getPushState(userId).then(value => { if (active) setState(value); }).catch(failure => { if (active) setError(pushErrorMessage(failure)); });
    return () => { active = false; live.current = false; };
  }, [userId]);

  useLayoutEffect(() => {
    if (!open || !popup.current) return;
    if (!portalRoot && typeof popup.current.showPopover === "function" && !popup.current.matches(":popover-open")) popup.current.showPopover();
    position(); heading.current?.focus({ preventScroll: true });
  }, [open, portalRoot, position]);
  useLayoutEffect(() => { if (open) position(); }, [state, error, busy, open, position]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent | FocusEvent) => { if (event.target instanceof Node && !trigger.current?.contains(event.target) && !popup.current?.contains(event.target)) close(); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); } };
    document.addEventListener("pointerdown", outside, true); document.addEventListener("focusin", outside, true); document.addEventListener("keydown", escape, true);
    window.addEventListener("resize", position); window.addEventListener("scroll", position, true);
    window.visualViewport?.addEventListener("resize", position); window.visualViewport?.addEventListener("scroll", position);
    return () => {
      document.removeEventListener("pointerdown", outside, true); document.removeEventListener("focusin", outside, true); document.removeEventListener("keydown", escape, true);
      window.removeEventListener("resize", position); window.removeEventListener("scroll", position, true);
      window.visualViewport?.removeEventListener("resize", position); window.visualViewport?.removeEventListener("scroll", position);
    };
  }, [open, close, position]);

  if (state === "unsupported") return null;

  const update = async (action: "check" | "enable" | "disable") => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError(null);
    try {
      const next = await (action === "check" ? getPushState(userId) : action === "disable" ? disablePush(userId) : enablePush(userId));
      if (live.current) { setState(next); heading.current?.focus({ preventScroll: true }); }
    } catch (failure) {
      if (!live.current) return;
      setError(pushErrorMessage(failure));
      show();
      try { const next = await getPushState(userId); if (live.current) setState(next); }
      catch { if (live.current) setState(null); }
    } finally {
      working.current = false;
      if (live.current) setBusy(false);
    }
  };

  const canDisable = state === "subscribed" || state === "unsupported_subscription" || state === "unregistered";
  const warning = !!error || state === "unregistered" || state === "unsupported_subscription" || state === "denied";
  const guidance = error ?? (state === "unsupported_subscription" ? "This browser's notifications aren't supported here. Turn them off or use another browser." : state === "unregistered" ? "This browser subscription isn't saved for your account." : state === "denied" ? "Notifications are blocked in browser settings." : null);
  const controls = open ? <div ref={popup} id={id} role="region" aria-labelledby={`${id}-heading`} popover={portalRoot ? undefined : "manual"}
    className="glass-strong m-0 overflow-y-auto rounded-[1.375rem] border-0 p-4 text-left text-sm text-foreground"
    style={{ position: "fixed", inset: "auto", zIndex: 1100, display: "block", visibility: "hidden" }}>
    <div className="flex items-center justify-between gap-2"><h2 ref={heading} id={`${id}-heading`} tabIndex={-1} className="flex items-center gap-2 text-base font-bold outline-none"><span className={`flex size-7 items-center justify-center rounded-lg text-white ${state === "subscribed" ? "bg-[#f43f5e]" : "bg-[#64748b]"}`}>{state === "subscribed" ? <BellRing size={15} aria-hidden /> : <Bell size={15} aria-hidden />}</span>Notifications</h2><button type="button" onClick={() => close(true)} className="btn btn-plain -mr-2 min-h-10 text-sm">Close</button></div>
    <p role={error ? "alert" : "status"} className={`mt-2 ${warning ? "font-bold" : "text-muted-foreground"}`}>{guidance ?? (busy ? "Updating notifications…" : state === null ? "Checking notifications…" : state === "subscribed" ? "On for this account and browser." : "Off in this browser.")}</p>
    <div className="mt-3 flex flex-wrap gap-2">
      {(state === null || state === "unregistered" || state === "unsubscribed") && <button type="button" disabled={busy} onClick={() => void update(state === null ? "check" : "enable")} className="btn btn-primary min-h-10 text-sm">{error || state === "unregistered" ? "Retry" : state === null ? "Check again" : "Turn on"}</button>}
      {canDisable && <button type="button" disabled={busy} onClick={() => void update("disable")} className="btn btn-quiet min-h-10 text-sm">Turn off</button>}
    </div>
  </div> : null;

  return (
    <span className="inline-flex shrink-0">
    <button
      ref={trigger}
      type="button"
      onClick={() => open ? close(true) : show()}
      aria-label={warning ? "Notification settings need attention" : "Notification settings"}
      aria-expanded={open}
      aria-controls={open ? id : undefined}
      title={warning ? "Notification settings need attention" : "Notification settings"}
      className={`btn btn-quiet relative size-11 shrink-0 px-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${
        state === "denied" ? "opacity-40" : ""
      } ${state === "subscribed" ? "text-accent" : ""}`}
    >
      {state === "subscribed" ? (
        <BellRing size={18} aria-hidden />
      ) : state === "denied" ? (
        <BellOff size={18} aria-hidden />
      ) : (
        <Bell size={18} aria-hidden />
      )}
      {warning && <span aria-hidden className="absolute top-1.5 right-1.5 size-2.5 rounded-full bg-accent shadow-[0_0_0_2px_var(--card)]" />}
    </button>
    {portalRoot && controls ? createPortal(controls, portalRoot) : controls}
    </span>
  );
}
