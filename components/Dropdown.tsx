"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";
import { dropdownMatch, dropdownPlacement, dropdownPortalRoot, dropdownStep, dropdownUsesPopover, type DropdownOption } from "@/lib/dropdown";

export type { DropdownOption } from "@/lib/dropdown";
interface Props {
  label: string;
  value: string;
  options: readonly DropdownOption[];
  onChange(value: string): void;
  disabled?: boolean;
  showLabel?: boolean;
  className?: string;
  developmentFallback?: boolean;
}
const themeVariables = ["--background", "--foreground", "--card", "--muted", "--muted-foreground", "--accent", "--accent-foreground", "--border", "--ring", "--font-sans"];
const unavailable = (button: HTMLButtonElement | null) => Boolean(button?.matches(":disabled") || button?.closest("[inert]"));

export function Dropdown({ label, value, options, onChange, disabled = false, showLabel = false, className = "", developmentFallback = false }: Props) {
  const id = useId(), menuId = `${id}-listbox`, triggerId = `${id}-trigger`;
  const trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false), [active, setActive] = useState(-1), [nativePopover, setNativePopover] = useState(true);
  const [fallbackTheme, setFallbackTheme] = useState<CSSProperties>({});
  const [portalRoot, setPortalRoot] = useState<Element | null>(null);
  const search = useRef({ text: "", time: 0 });
  const selected = options.findIndex(option => option.value === value);
  const expanded = open && !disabled;
  const highlighted = options[active] && !options[active].disabled ? active : dropdownStep(options, -1, "first");
  const close = useCallback(() => { setOpen(false); search.current = { text: "", time: 0 }; }, []);
  if (disabled && open) setOpen(false);

  const show = (index = selected) => {
    if (disabled || unavailable(trigger.current)) return;
    const supported = dropdownUsesPopover(typeof HTMLElement.prototype.showPopover === "function", developmentFallback, process.env.NODE_ENV);
    setNativePopover(supported);
    if (!supported && trigger.current) {
      setPortalRoot(dropdownPortalRoot(trigger.current, document.body));
      const computed = getComputedStyle(trigger.current), copied: Record<string, string> = { fontFamily: computed.fontFamily, colorScheme: computed.colorScheme };
      for (const property of themeVariables) copied[property] = computed.getPropertyValue(property);
      setFallbackTheme(copied as CSSProperties);
    }
    setActive(index >= 0 && !options[index]?.disabled ? index : dropdownStep(options, -1, "first"));
    setOpen(true);
  };
  const choose = (index: number, restoreFocus = true) => {
    if (disabled || unavailable(trigger.current) || !options[index] || options[index].disabled) return;
    const next = options[index].value;
    close();
    if (next !== value) onChange(next);
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
  };

  const position = useCallback(() => {
    const button = trigger.current, popup = menu.current;
    if (!button || !popup) return;
    const rect = button.getBoundingClientRect(), visual = window.visualViewport;
    const viewport = { width: visual?.width ?? window.innerWidth, height: visual?.height ?? window.innerHeight, left: visual?.offsetLeft ?? 0, top: visual?.offsetTop ?? 0 };
    if (!rect.width || rect.bottom < viewport.top || rect.top > viewport.top + viewport.height || rect.left > viewport.left + viewport.width || rect.right < viewport.left || unavailable(button)) { close(); return; }
    popup.style.width = `${dropdownPlacement(rect, viewport, popup.scrollHeight).width}px`;
    const next = dropdownPlacement(rect, viewport, popup.scrollHeight);
    Object.assign(popup.style, { left: `${next.left}px`, top: `${next.top}px`, width: `${next.width}px`, maxHeight: `${next.maxHeight}px`, visibility: "visible" });
  }, [close]);

  useLayoutEffect(() => {
    const popup = menu.current;
    if (!popup) return;
    const canPopover = nativePopover && typeof popup.showPopover === "function";
    if (expanded) {
      if (canPopover && !popup.matches(":popover-open")) popup.showPopover();
      position();
    } else if (canPopover && popup.matches(":popover-open")) popup.hidePopover();
  }, [expanded, nativePopover, options.length, position]);

  useLayoutEffect(() => {
    if (!expanded) return;
    const popup = menu.current, option = document.getElementById(`${id}-option-${highlighted}`);
    if (!popup || !option) return;
    const top = option.offsetTop, bottom = top + option.offsetHeight;
    if (top < popup.scrollTop) popup.scrollTop = top;
    else if (bottom > popup.scrollTop + popup.clientHeight) popup.scrollTop = bottom - popup.clientHeight;
  }, [expanded, highlighted, id]);

  useEffect(() => {
    if (!expanded) return;
    const outside = (event: PointerEvent | FocusEvent) => {
      const target = event.target;
      if (target instanceof Node && !trigger.current?.contains(target) && !menu.current?.contains(target)) close();
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside, true);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    window.visualViewport?.addEventListener("resize", position);
    window.visualViewport?.addEventListener("scroll", position);
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(position) : null;
    if (trigger.current) observer?.observe(trigger.current);
    const disabledObserver = typeof MutationObserver === "function" ? new MutationObserver(() => { if (unavailable(trigger.current)) close(); }) : null;
    for (let ancestor = trigger.current?.parentElement; ancestor; ancestor = ancestor.parentElement) {
      disabledObserver?.observe(ancestor, { attributes: true, attributeFilter: ["disabled", "inert"] });
    }
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside, true);
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
      window.visualViewport?.removeEventListener("resize", position);
      window.visualViewport?.removeEventListener("scroll", position);
      observer?.disconnect();
      disabledObserver?.disconnect();
    };
  }, [expanded, close, position]);

  const keyboard = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled || unavailable(trigger.current)) return;
    if (event.key === "Escape") { if (expanded) { event.preventDefault(); event.stopPropagation(); close(); } return; }
    if (event.key === "Tab") { if (expanded) { if (highlighted >= 0) choose(highlighted, false); else close(); } return; }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      search.current = { text: "", time: 0 };
      if (event.altKey) {
        if (event.key === "ArrowUp" && expanded) { if (highlighted >= 0) choose(highlighted); else close(); }
        else if (event.key === "ArrowDown" && !expanded) show();
        return;
      }
      const direction = event.key === "ArrowDown" ? 1 : -1;
      if (expanded) setActive(dropdownStep(options, highlighted, direction));
      else show(selected >= 0 ? selected : dropdownStep(options, -1, direction));
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      search.current = { text: "", time: 0 };
      const next = dropdownStep(options, -1, event.key === "Home" ? "first" : "last");
      if (expanded) setActive(next); else show(next);
      return;
    }
    if (expanded && (event.key === "PageUp" || event.key === "PageDown")) {
      event.preventDefault(); search.current = { text: "", time: 0 };
      setActive(dropdownStep(options, highlighted, event.key === "PageDown" ? 1 : -1, 10));
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (expanded) { if (highlighted >= 0) choose(highlighted); } else show();
      return;
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      const now = event.timeStamp, old = now - search.current.time < 700 ? search.current.text : "";
      const repeated = old.length > 0 && Array.from(old).every(character => character.toLocaleLowerCase() === event.key.toLocaleLowerCase());
      const query = repeated ? event.key : old + event.key;
      const next = dropdownMatch(options, query, expanded ? highlighted : selected, Boolean(old) && !repeated);
      search.current = { text: query, time: now };
      if (expanded) setActive(next); else show(next);
    }
  };

  const popup = <div ref={menu} id={menuId} role="listbox" aria-label={label} popover={nativePopover ? "manual" : undefined}
    className="m-0 overflow-y-auto overscroll-contain rounded-xl border-0 bg-card p-1.5 text-foreground shadow-lg shadow-black/15 outline-none"
    style={{ ...(!nativePopover ? fallbackTheme : {}), position: "fixed", inset: "auto", zIndex: 1000, boxSizing: "border-box", display: expanded ? "block" : "none", visibility: "hidden", maxHeight: 320 }}
    onMouseDown={event => event.preventDefault()}>
    {options.length ? options.map((option, index) => <div key={option.value} id={`${id}-option-${index}`} role="option" aria-selected={option.value === value} aria-disabled={option.disabled || undefined}
      onPointerMove={event => { if (event.pointerType === "mouse" && !option.disabled) setActive(index); }}
      onClick={() => choose(index)}
      className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm leading-5 select-none ${option.disabled ? "cursor-not-allowed opacity-45" : highlighted === index ? "bg-accent/12 text-foreground" : "hover:bg-muted"}`}>
      <span className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">{option.label}</span>
      {option.value === value && <Check size={16} className="shrink-0 text-accent" aria-hidden />}
    </div>) : <div className="px-3 py-3 text-sm text-muted-foreground">No options available</div>}
  </div>;

  return <div className={`min-w-0 ${className}`}>
    {showLabel && <label htmlFor={triggerId} className="mb-1 block text-sm font-medium">{label}</label>}
    <button ref={trigger} id={triggerId} type="button" role="combobox" aria-label={label} aria-haspopup="listbox" aria-expanded={expanded} aria-controls={menuId}
      aria-activedescendant={expanded && highlighted >= 0 ? `${id}-option-${highlighted}` : undefined} disabled={disabled} onKeyDown={keyboard} onClick={() => expanded ? close() : show()}
      className="flex min-h-11 w-full items-center justify-between gap-3 rounded-xl border border-border bg-card px-3 py-2 text-left text-base leading-5 transition hover:border-accent/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50">
      <span className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">{options[selected]?.label ?? "Choose an option"}</span>
      <ChevronDown size={16} aria-hidden className={`shrink-0 text-foreground/60 transition-transform motion-reduce:transition-none ${expanded ? "rotate-180" : ""}`} />
    </button>
    {nativePopover ? popup : expanded && portalRoot ? createPortal(popup, portalRoot) : null}
  </div>;
}
