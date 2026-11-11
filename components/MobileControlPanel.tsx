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
    <button ref={trigger} type="button" disabled={disabled} aria-haspopup="dialog" aria-expanded={open} onClick={() => onOpenChange(true)} className="btn btn-glass w-full md:hidden">
      <SlidersHorizontal size={18} aria-hidden /> {label}
    </button>
    <dialog ref={dialog} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); close(); }} className="glass-strong fixed inset-x-0 top-auto bottom-0 m-0 max-h-[85dvh] w-full max-w-none overflow-y-auto overscroll-contain rounded-t-[1.75rem] border-0 p-0 text-foreground md:static md:m-0 md:max-h-none md:overflow-visible md:rounded-none md:bg-transparent md:bg-none md:shadow-none md:backdrop-filter-none">
      <header className="sticky top-0 z-10 bg-[var(--glass-fill-strong)] px-4 pt-2 pb-3 backdrop-blur-2xl md:sr-only">
        <span aria-hidden className="mx-auto mb-2 block h-1.5 w-10 rounded-full bg-muted-foreground/35 md:hidden" />
        <div className="flex items-center justify-between gap-3">
          <h2 id={titleId} className="font-display text-2xl">{title}</h2>
          <button type="button" onClick={close} aria-label="Close settings" className="btn btn-quiet w-11 shrink-0 px-0 md:hidden"><X size={20} aria-hidden /></button>
        </div>
      </header>
      <div className="flex flex-col gap-4 px-4 pt-1 pb-[max(1.25rem,env(safe-area-inset-bottom))] md:p-0">{children}</div>
    </dialog>
  </>;
}
