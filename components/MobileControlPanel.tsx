"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { SlidersHorizontal, X } from "lucide-react";

export function MobileControlPanel({ children, open, onOpenChange, disabled = false, label = "Settings, filters & stories", title = "Set up your photos" }: {
  children: ReactNode;
  open: boolean;
  onOpenChange(open: boolean): void;
  disabled?: boolean;
  label?: string;
  title?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  useEffect(() => {
    const panel = dialog.current;
    if (!panel) return;
    const desktop = window.matchMedia("(min-width: 768px)");
    const previousOverflow = document.body.style.overflow;
    const sync = () => {
      const restoreTrigger = !desktop.matches && !open && panel.contains(document.activeElement);
      panel.close();
      document.body.style.overflow = previousOverflow;
      if (desktop.matches) panel.show();
      else if (open) {
        panel.showModal();
        document.body.style.overflow = "hidden";
      }
      if (restoreTrigger) requestAnimationFrame(() => trigger.current?.focus({ preventScroll: true }));
    };
    sync();
    desktop.addEventListener("change", sync);
    return () => {
      desktop.removeEventListener("change", sync);
      panel.close();
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  const close = () => {
    onOpenChange(false);
    requestAnimationFrame(() => trigger.current?.focus({ preventScroll: true }));
  };

  return <>
    <button ref={trigger} type="button" disabled={disabled} aria-haspopup="dialog" aria-expanded={open} onClick={() => onOpenChange(true)} className="flex min-h-11 items-center justify-center gap-2 rounded-xl border border-border px-4 text-sm font-medium md:hidden">
      <SlidersHorizontal size={18} /> {label}
    </button>
    <dialog ref={dialog} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); close(); }} className="fixed inset-x-0 top-auto bottom-0 m-0 max-h-[85dvh] w-full max-w-none overflow-y-auto overscroll-contain rounded-t-2xl bg-card p-0 text-foreground shadow-2xl backdrop:bg-black/60 md:static md:m-0 md:max-h-none md:overflow-visible md:rounded-none md:bg-transparent md:shadow-none">
      <header className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-border bg-card px-4 py-3 md:sr-only">
        <h2 id={titleId} className="font-display text-2xl">{title}</h2>
        <button type="button" onClick={close} aria-label="Close settings" className="flex min-h-11 min-w-11 items-center justify-center rounded-xl md:hidden"><X size={20} /></button>
      </header>
      <div className="flex flex-col gap-4 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] md:p-0">{children}</div>
    </dialog>
  </>;
}
