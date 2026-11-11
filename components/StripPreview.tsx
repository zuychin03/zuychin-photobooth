"use client";

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Expand, X } from "lucide-react";
import { composeStrip, compositionSize, type ComposeInput } from "@/lib/compose";
import { createStripPreviewGesture } from "@/lib/strip-preview-gesture";

export function StripPreview({ input, assetsVersion, children, gesturesEnabled = true, className = "relative" }: {
  input: ComposeInput; assetsVersion: number; children: ReactNode; gesturesEnabled?: boolean; className?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null), canvas = useRef<HTMLCanvasElement>(null);
  const trigger = useRef<HTMLButtonElement>(null), returnFocus = useRef<HTMLElement | null>(null);
  const opened = useRef(false), ignoreOpeningClick = useRef(false), overflow = useRef<string | null>(null);
  const closing = useRef<ReturnType<typeof setTimeout> | null>(null), animation = useRef<Animation | null>(null);
  const gesture = useRef<ReturnType<typeof createStripPreviewGesture> | null>(null);
  const [open, setOpen] = useState(false), [error, setError] = useState(false);
  const titleId = useId();

  const close = useCallback((immediate = false) => {
    if (!opened.current) return;
    const finish = () => {
      if (closing.current !== null) clearTimeout(closing.current);
      closing.current = null; animation.current?.cancel(); animation.current = null;
      opened.current = false;
      dialog.current?.close();
      if (overflow.current !== null) { document.body.style.overflow = overflow.current; overflow.current = null; }
      if (canvas.current) canvas.current.width = canvas.current.height = 0;
      setOpen(false);
      const previous = returnFocus.current;
      (previous?.isConnected && previous !== document.body ? previous : trigger.current)?.focus({ preventScroll: true });
    };
    if (immediate) { finish(); return; }
    if (closing.current !== null) return;
    const target = canvas.current;
    if (target?.animate && target.width > 0 && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      animation.current?.cancel();
      animation.current = target.animate([{ opacity: 1, transform: "scale(1)" }, { opacity: 0, transform: "scale(.97)" }], { duration: 120, easing: "ease-in", fill: "forwards" });
      closing.current = setTimeout(finish, 120);
    } else finish();
  }, []);
  const show = useCallback(() => {
    if (opened.current || !dialog.current) return;
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ignoreOpeningClick.current = true;
    dialog.current.showModal();
    opened.current = true;
    overflow.current = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    setError(false); setOpen(true);
  }, []);
  useEffect(() => {
    const current = createStripPreviewGesture({ open: show, close });
    gesture.current = current;
    const move = (event: PointerEvent) => current.move(event.pointerId, event.clientX, event.clientY);
    const end = (event: PointerEvent) => current.end(event.pointerId);
    const other = (event: PointerEvent) => current.otherPointer(event.pointerId);
    const cancel = () => current.cancel();
    const hide = () => { current.cancel(); close(true); };
    // Listen above the dialog because showModal changes the pointer's hit target.
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", end, true);
    window.addEventListener("pointerdown", other, true);
    window.addEventListener("pointercancel", cancel, true);
    window.addEventListener("blur", hide);
    document.addEventListener("visibilitychange", hide);
    return () => {
      window.removeEventListener("pointermove", move, true); window.removeEventListener("pointerup", end, true);
      window.removeEventListener("pointerdown", other, true); window.removeEventListener("pointercancel", cancel, true);
      window.removeEventListener("blur", hide); document.removeEventListener("visibilitychange", hide);
      current.cancel(); gesture.current = null; close(true);
    };
  }, [show, close]);
  useEffect(() => { if (!gesturesEnabled) gesture.current?.cancel(); }, [gesturesEnabled]);
  useEffect(() => {
    if (!open) return;
    const target = canvas.current;
    if (!target) return;
    const draw = () => {
      if (!opened.current) return;
      try {
        const size = compositionSize(input), viewport = window.visualViewport;
        const width = Math.max(1, (viewport?.width ?? window.innerWidth) - 32);
        const height = Math.max(1, (viewport?.height ?? window.innerHeight) - 112);
        const fit = Math.min(width / size.width, height / size.height);
        composeStrip(target, input, Math.min(fit * Math.min(window.devicePixelRatio || 1, 2), 1800 / Math.max(size.width, size.height)));
        target.style.width = `${Math.max(1, Math.floor(size.width * fit))}px`;
        target.style.height = `${Math.max(1, Math.floor(size.height * fit))}px`;
      } catch { setError(true); target.width = target.height = 0; }
    };
    draw();
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) animation.current = target.animate?.([{ opacity: .7, transform: "scale(.97)" }, { opacity: 1, transform: "scale(1)" }], { duration: 120, easing: "ease-out" }) ?? null;
    window.addEventListener("resize", draw); window.visualViewport?.addEventListener("resize", draw);
    return () => { window.removeEventListener("resize", draw); window.visualViewport?.removeEventListener("resize", draw); target.width = target.height = 0; };
  }, [open, input, assetsVersion]);

  return <div className={`${className} ${gesturesEnabled ? "max-md:[&_canvas]:[-webkit-touch-callout:none] max-md:[&_canvas]:select-none" : ""}`} onContextMenu={event => {
    if (gesturesEnabled && event.target instanceof HTMLCanvasElement && window.matchMedia("(max-width: 767px)").matches) event.preventDefault();
  }} onPointerDown={event => {
    if (opened.current || !gesturesEnabled || event.defaultPrevented || !event.isPrimary || event.button !== 0 || !(event.target instanceof HTMLCanvasElement) || !window.matchMedia("(max-width: 767px)").matches) return;
    gesture.current?.start(event.pointerId, event.clientX, event.clientY);
  }}>
    {children}
    <button ref={trigger} type="button" aria-label="Expand strip preview" aria-haspopup="dialog" aria-expanded={open} onClick={show} className="btn btn-glass absolute top-3 left-3 z-10 w-11 px-0"><Expand size={19} aria-hidden /></button>
    <dialog ref={dialog} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); gesture.current?.cancel(); close(); }} onClose={() => close(true)} onPointerDown={() => { ignoreOpeningClick.current = false; }} onClick={() => { if (!ignoreOpeningClick.current) { gesture.current?.cancel(); close(); } }} className="glass-strong fixed inset-0 m-0 h-dvh max-h-none w-screen max-w-none overflow-hidden rounded-none border-0 p-0 text-foreground open:flex open:flex-col">
      <header className="flex items-center justify-between gap-3 px-4 pt-[max(.75rem,env(safe-area-inset-top))] pb-1 sm:px-6">
        <h2 id={titleId} className="font-display text-xl">Your strip</h2>
        <button type="button" autoFocus aria-label="Close strip preview" onClick={() => { gesture.current?.cancel(); close(); }} className="btn btn-quiet w-11 px-0"><X size={22} aria-hidden /></button>
      </header>
      <div className="flex min-h-0 flex-1 items-center justify-center px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {error && <p role="alert" className="notice font-bold">Couldn&apos;t draw the preview. Close it and try again.</p>}
        <canvas ref={canvas} hidden={error} role="img" aria-label="Full strip preview" className="max-h-full max-w-full rounded-md object-contain shadow-2xl shadow-black/30" />
      </div>
    </dialog>
  </div>;
}

export default StripPreview;
