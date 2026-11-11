"use client";

import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { ChevronDown, Download } from "lucide-react";

export function EditorFinishMenu({ children, triggerRef }: { children: ReactNode; triggerRef: RefObject<HTMLButtonElement | null> }) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus({ preventScroll: true });
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [open, triggerRef]);

  return <div ref={container} className="absolute right-3 top-3 z-20 md:hidden" onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }}>
    <button ref={triggerRef} type="button" aria-label="Finish" aria-expanded={open} aria-controls={id}
      onClick={() => setOpen(value => !value)}
      className="editor-finish-trigger btn btn-primary ml-auto gap-1.5 px-4 text-sm">
      <Download size={16} aria-hidden="true" /><span>Finish</span><ChevronDown size={15} aria-hidden="true" className={`editor-finish-chevron transition-transform duration-300 ease-[var(--spring-soft)] motion-reduce:transition-none ${open ? "rotate-180" : ""}`} />
    </button>
    {open && <div id={id} role="group" aria-label="Finish your strip"
      className="glass-strong mt-2 flex w-52 max-w-[calc(100vw-2rem)] origin-top-right flex-col gap-1.5 rounded-[1.25rem] p-2 motion-safe:animate-[pop-enter_320ms_var(--spring-soft)]"
      onClick={event => {
        if (!(event.target as HTMLElement).closest("button:not(:disabled)")) return;
        setOpen(false);
        triggerRef.current?.focus({ preventScroll: true });
      }}>
      {children}
    </div>}
  </div>;
}
