"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Info } from "lucide-react";

interface Props {
  label: string;
  children: ReactNode;
  className?: string;
}

export function HelpTooltip({ label, children, className = "" }: Props) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null), bubble = useRef<HTMLSpanElement>(null);
  const pinned = useRef(false), hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);
  const [portalRoot, setPortalRoot] = useState<Element | null>(null);
  const [theme, setTheme] = useState<CSSProperties>({});

  const cancelHide = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = null;
  }, []);
  const close = useCallback(() => {
    cancelHide();
    pinned.current = false;
    setOpen(false);
  }, [cancelHide]);
  const show = () => {
    cancelHide();
    if (!trigger.current || trigger.current.closest("[inert]")) return;
    if (typeof HTMLElement.prototype.showPopover !== "function") {
      setPortalRoot(trigger.current.closest("dialog[open]") ?? document.body);
      const computed = getComputedStyle(trigger.current);
      const variables: Record<string, string> = { fontFamily: computed.fontFamily };
      for (const name of ["--card", "--foreground", "--border"]) variables[name] = computed.getPropertyValue(name);
      setTheme(variables as CSSProperties);
    }
    setOpen(true);
  };
  const leave = () => {
    cancelHide();
    hideTimer.current = setTimeout(() => {
      if (!pinned.current && document.activeElement !== trigger.current) close();
    }, 140);
  };

  const position = useCallback(() => {
    const button = trigger.current, popup = bubble.current;
    if (!button || !popup) return;
    const rect = button.getBoundingClientRect(), viewport = window.visualViewport;
    const left = viewport?.offsetLeft ?? 0, top = viewport?.offsetTop ?? 0;
    const width = viewport?.width ?? window.innerWidth, height = viewport?.height ?? window.innerHeight;
    if (!rect.width || rect.bottom < top || rect.top > top + height || button.closest("[inert]")) { close(); return; }
    popup.style.width = `${Math.min(280, width - 24)}px`;
    const below = top + height - rect.bottom - 16, above = rect.top - top - 16;
    const useBelow = popup.scrollHeight <= below || below >= above;
    popup.style.maxHeight = `${Math.max(40, useBelow ? below : above)}px`;
    const size = popup.getBoundingClientRect();
    Object.assign(popup.style, {
      left: `${Math.max(left + 12, Math.min(rect.left + rect.width / 2 - size.width / 2, left + width - size.width - 12))}px`,
      top: `${useBelow ? rect.bottom + 8 : Math.max(top + 12, rect.top - size.height - 8)}px`,
      visibility: "visible",
    });
  }, [close]);

  useLayoutEffect(() => {
    const popup = bubble.current;
    if (!open || !popup) return;
    if (!portalRoot && typeof popup.showPopover === "function") popup.showPopover();
    position();
  }, [open, portalRoot, position, children]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent | FocusEvent) => {
      if (event.target instanceof Node && !trigger.current?.contains(event.target) && !bubble.current?.contains(event.target)) close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside, true);
    document.addEventListener("keydown", escape, true);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    window.visualViewport?.addEventListener("resize", position);
    window.visualViewport?.addEventListener("scroll", position);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside, true);
      document.removeEventListener("keydown", escape, true);
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
      window.visualViewport?.removeEventListener("resize", position);
      window.visualViewport?.removeEventListener("scroll", position);
    };
  }, [open, close, position]);
  useEffect(() => cancelHide, [cancelHide]);

  const popup = open ? <span ref={bubble} id={id} role="tooltip" popover={portalRoot ? undefined : "manual"}
    className="m-0 overflow-y-auto rounded-xl border border-border bg-card px-3 py-2.5 text-left text-sm leading-relaxed font-normal tracking-normal whitespace-normal text-foreground normal-case shadow-lg shadow-black/15"
    style={{ ...theme, position: "fixed", inset: "auto", zIndex: 1100, display: "block", visibility: "hidden", overflowWrap: "anywhere" }}
    onPointerEnter={cancelHide} onPointerLeave={leave}>{children}</span> : null;

  return <span className={`inline-flex shrink-0 align-middle ${className}`}>
    <button ref={trigger} type="button" aria-label={label} aria-describedby={open ? id : undefined} aria-expanded={open}
      className="inline-flex size-8 items-center justify-center rounded-full text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [@media(pointer:coarse)]:size-11"
      onPointerEnter={event => { if (event.pointerType === "mouse" || event.pointerType === "pen") show(); }}
      onPointerLeave={leave}
      onFocus={event => { if (event.currentTarget.matches(":focus-visible")) show(); }}
      onBlur={close}
      onClick={event => { event.stopPropagation(); if (pinned.current) close(); else { pinned.current = true; show(); } }}>
      <Info size={16} aria-hidden />
    </button>
    {portalRoot && popup ? createPortal(popup, portalRoot) : popup}
  </span>;
}
