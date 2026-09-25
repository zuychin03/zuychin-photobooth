"use client";

import { useEffect, useRef, useState } from "react";
import { Dropdown } from "@/components/Dropdown";

const choices = [
  { value: "alpha", label: "Alpha camera" },
  { value: "unavailable", label: "Unavailable camera", disabled: true },
  { value: "bravo", label: "Bravo camera with a long descriptive name that wraps in a narrow viewport" },
  ...Array.from({ length: 16 }, (_, index) => ({ value: `camera-${index}`, label: `Camera ${index + 1}` })),
  { value: "zulu", label: "Zulu camera" },
];
const button = "min-h-11 rounded-xl border border-border px-4 py-2 text-sm focus-visible:outline-2 focus-visible:outline-ring";

function RehearsalDialog({ close }: { close(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [value, setValue] = useState("alpha"), [bottom, setBottom] = useState(false), [count, setCount] = useState(0);
  const [observation, setObservation] = useState("Open the dropdown to inspect its real fallback portal.");
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    const timer = setInterval(() => {
      const popup = element?.querySelector<HTMLElement>('[role="listbox"]'), trigger = element?.querySelector<HTMLElement>('[role="combobox"]');
      const box = popup?.getBoundingClientRect(), visual = window.visualViewport;
      const left = visual?.offsetLeft ?? 0, top = visual?.offsetTop ?? 0, width = visual?.width ?? innerWidth, height = visual?.height ?? innerHeight;
      const activeId = trigger?.getAttribute("aria-activedescendant"), active = activeId ? document.getElementById(activeId) : null;
      setObservation(JSON.stringify({ nativeDialogOpen: Boolean(element?.open), expanded: trigger?.getAttribute("aria-expanded") === "true", fallbackPortalInsideDialog: Boolean(popup && element?.contains(popup) && !popup.hasAttribute("popover")), fitsViewport: box ? box.left >= left && box.top >= top && box.right <= left + width && box.bottom <= top + height : null, activeOption: active?.textContent ?? null, focus: document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent?.slice(0, 45) ?? null }, null, 2));
    }, 200);
    return () => { clearInterval(timer); element?.close(); };
  }, []);
  return <dialog ref={dialog} onCancel={event => { event.preventDefault(); close(); }} aria-labelledby="fallback-dialog-title" className="fixed m-auto w-[min(34rem,calc(100vw-24px))] max-h-[calc(100dvh-24px)] overflow-visible rounded-2xl border border-border bg-card p-4 text-foreground shadow-xl backdrop:bg-black/50">
    <div className="max-h-[calc(100dvh-56px)] overflow-y-auto">
    <h3 id="fallback-dialog-title" className="text-xl font-semibold">Dropdown fallback in a native dialog</h3>
    <p className="mt-2 text-sm text-muted-foreground">ArrowDown opens; another ArrowDown skips the disabled choice. Home/End move, Enter selects, Escape cancels the menu, Tab continues through the dialog.</p>
    <div className="mt-3 flex flex-wrap gap-2"><button className={button} onClick={() => setBottom(current => !current)}>{bottom ? "Place trigger at top" : "Place trigger at bottom"}</button><button className={button} onClick={() => setCount(current => current + 1)}>Dialog action · {count}</button><button className={button} onClick={close}>Close rehearsal</button></div>
    <div className={`mt-3 flex h-[min(25dvh,12rem)] flex-col overflow-hidden rounded-lg border border-dashed border-border p-2 ${bottom ? "justify-end" : "justify-start"}`}>
      <Dropdown developmentFallback showLabel label="Fallback camera" value={value} options={choices} onChange={setValue} />
    </div>
    <p className="mt-2 text-sm" role="status">Selected: {choices.find(choice => choice.value === value)?.label}</p>
    <pre className="mt-2 max-h-[20dvh] overflow-auto whitespace-pre-wrap break-all text-xs" aria-label="Fallback live observations">{observation}</pre>
    </div>
  </dialog>;
}

export function DropdownFallbackRehearsal() {
  const [open, setOpen] = useState(false), opener = useRef<HTMLButtonElement>(null);
  if (process.env.NODE_ENV !== "development") return null;
  const close = () => { setOpen(false); requestAnimationFrame(() => opener.current?.focus({ preventScroll: true })); };
  return <section className="mt-10 border-t border-border pt-6" aria-labelledby="dropdown-fallback-heading">
    <h2 id="dropdown-fallback-heading" className="text-xl font-semibold">Native dialog dropdown fallback</h2>
    <p className="my-3 text-sm text-muted-foreground">Development-only: exercises the real non-Popover branch without changing browser prototypes. The override is ignored in production. Use keyboard and pointer controls at desktop and narrow widths; observations are measurements, not an automatic accessibility pass.</p>
    <button ref={opener} className={button} onClick={() => setOpen(true)}>Open fallback dropdown rehearsal</button>
    {open && <RehearsalDialog close={close} />}
  </section>;
}
