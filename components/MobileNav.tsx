"use client";

import { type FocusEvent, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, Menu, X, type LucideIcon } from "lucide-react";
import { useLiquidIndicator } from "@/components/ui/useLiquidIndicator";
import { useGlassLens } from "@/components/ui/useGlassLens";

export interface SiteNavLink { href: string; label: string; active: boolean; icon: LucideIcon }

const MAX_SCROLLED_TABS = 5;

export function MobileNav({ links, canNavigate, collapsible = false, presence = "below-md" }: { links: SiteNavLink[]; collapsible?: boolean; presence?: "below-md" | "shown" | "hidden"; canNavigate(href: string, event: { preventDefault(): void }): boolean }) {
  const tray = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();
  const visible = !collapsible || expanded;
  const viewport = useRef<HTMLDivElement>(null), options = useRef<HTMLDivElement>(null), droplet = useRef<HTMLSpanElement>(null);
  const scrollId = useId();
  const [edges, setEdges] = useState({ start: true, end: true });
  const bar = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<{ overflow: boolean; cap?: number }>({ overflow: true });
  const measureScroll = useCallback(() => {
    const element = viewport.current;
    if (!element) return;
    const next = { start: element.scrollLeft <= 1, end: element.scrollLeft >= element.scrollWidth - element.clientWidth - 1 };
    setEdges(previous => previous.start === next.start && previous.end === next.end ? previous : next);
  }, []);
  const measureFit = useCallback(() => {
    const nav = tray.current, row = bar.current, list = options.current;
    const tabs = list ? Array.from(list.children).filter((child): child is HTMLAnchorElement => child instanceof HTMLAnchorElement) : [];
    if (!nav || !row || !list || !tabs.length) return;
    const surface = collapsible ? row.parentElement ?? nav : nav, surfaceStyle = getComputedStyle(surface);
    const rowGap = Number.parseFloat(getComputedStyle(row).columnGap) || 0, tabGap = Number.parseFloat(getComputedStyle(list).columnGap) || 0;
    const limit = collapsible ? nav.clientWidth : Number.parseFloat(getComputedStyle(nav).maxWidth) || document.documentElement.clientWidth - 20;
    const room = limit - Number.parseFloat(surfaceStyle.paddingLeft) - Number.parseFloat(surfaceStyle.paddingRight) - (collapsible && trigger.current ? trigger.current.offsetWidth + rowGap : 0);
    const span = (count: number) => tabs.slice(0, count).reduce((sum, tab) => sum + tab.offsetWidth, 0) + tabGap * (count - 1);
    const overflow = span(tabs.length) > room + 0.5;
    const cap = overflow ? Math.ceil(span(Math.min(MAX_SCROLLED_TABS, tabs.length))) : undefined;
    setFit(previous => previous.overflow === overflow && previous.cap === cap ? previous : { overflow, cap });
  }, [collapsible]);
  const reveal = (target: HTMLElement) => {
    const element = viewport.current;
    if (!element) return;
    const bounds = element.getBoundingClientRect(), item = target.getBoundingClientRect();
    const offset = item.left < bounds.left ? item.left - bounds.left : item.right > bounds.right ? item.right - bounds.right : 0;
    if (offset) element.scrollTo({ left: element.scrollLeft + offset, behavior: "instant" });
  };
  const destinationSignature = JSON.stringify(links.map(({ href, label, active }) => [href, label, active]));
  useLayoutEffect(() => {
    const update = () => {
      const focused = document.activeElement;
      const target = focused instanceof HTMLElement && options.current?.contains(focused)
        ? focused : options.current?.querySelector<HTMLElement>('[aria-current="page"]');
      measureFit();
      if (target) reveal(target);
      measureScroll();
    };
    update();
    const observer = new ResizeObserver(update);
    for (const element of [viewport.current, options.current]) if (element) observer.observe(element);
    window.addEventListener("resize", update);
    return () => { observer.disconnect(); window.removeEventListener("resize", update); };
  }, [destinationSignature, measureFit, measureScroll, visible]);
  useEffect(() => {
    if (!collapsible || !expanded) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !tray.current?.contains(event.target)) {
        if (tray.current?.contains(document.activeElement)) trigger.current?.focus({ preventScroll: true });
        setExpanded(false);
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const restore = tray.current?.contains(document.activeElement);
      setExpanded(false);
      if (restore) { event.preventDefault(); trigger.current?.focus(); }
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", dismiss); document.removeEventListener("keydown", escape); };
  }, [collapsible, expanded]);
  const scroll = (end: boolean) => {
    const element = viewport.current;
    if (element) element.scrollTo({ left: end ? element.scrollWidth - element.clientWidth : 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  };
  const revealFocus = (event: FocusEvent<HTMLDivElement>) => reveal(event.target);
  useLiquidIndicator(options, droplet, `${destinationSignature}:${visible}`);
  useGlassLens(tray, !collapsible && presence !== "hidden");
  const arrowStyle = "flex h-11 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-accent disabled:opacity-25 disabled:hover:text-muted-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring";

  useLayoutEffect(() => {
    const element = tray.current;
    if (!element) return;
    const measure = () => {
      const height = element.getBoundingClientRect().height;
      const clearance = height ? height + (Number.parseFloat(getComputedStyle(element).bottom) || 0) : 0;
      document.documentElement.style.setProperty("--app-bottom-nav-height", `${clearance}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener("resize", measure);
    return () => { observer.disconnect(); window.removeEventListener("resize", measure); document.documentElement.style.removeProperty("--app-bottom-nav-height"); };
  }, [collapsible]);

  const tabStyle = "relative z-[1] flex min-h-[3.25rem] min-w-[4.25rem] shrink-0 flex-col items-center justify-center gap-0.5 rounded-full px-1.5 text-[0.6875rem] font-bold transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring";
  const glass = "glass rounded-full";
  const presenceClass = presence === "below-md" ? "md:hidden" : presence === "hidden" ? "hidden" : "";
  return <>{!collapsible && <div aria-hidden className={`scroll-edge scroll-edge-bottom ${presenceClass}`} data-on="" />}<nav ref={tray} aria-label="Mobile navigation" className={`mobile-tabbar fixed bottom-[calc(0.5rem+env(safe-area-inset-bottom))] z-[45] ${presenceClass} ${collapsible ? "right-[calc(0.625rem+env(safe-area-inset-right))] left-[calc(0.625rem+env(safe-area-inset-left))] pointer-events-none flex h-11 justify-end" : `${glass} left-1/2 w-max max-w-[calc(100vw-1.25rem-env(safe-area-inset-left)-env(safe-area-inset-right))] -translate-x-1/2 px-1.5`}`}>
    <div className={collapsible ? `absolute right-0 bottom-0 w-max max-w-full ${expanded ? `${glass} pointer-events-auto px-1.5 motion-safe:animate-[sheet-rise_420ms_var(--spring-soft)]` : "pointer-events-none"}` : undefined}>
    <div ref={bar} className={`flex items-center gap-1 ${visible ? "mx-auto" : "justify-end"}`}>
      {visible && <div id={panelId} className="contents">
      {fit.overflow && <button type="button" aria-label="Scroll mobile menu to start" aria-controls={scrollId} disabled={edges.start} onClick={() => scroll(false)} className={arrowStyle}><ChevronLeft size={18} aria-hidden /></button>}
      <div ref={viewport} id={scrollId} onScroll={measureScroll} onFocusCapture={revealFocus} style={fit.cap ? { maxWidth: fit.cap } : undefined} className="scrollbar-hide min-w-0 flex-1 overflow-x-auto overscroll-x-contain rounded-full py-1.5">
      <div ref={options} className="relative flex w-max min-w-full items-center justify-between gap-0.5">
      <span ref={droplet} aria-hidden className="droplet" />
      {links.map(({ icon: Icon, ...link }) => <Link key={link.href} href={link.href} aria-current={link.active ? "page" : undefined} onNavigate={event => { if (canNavigate(link.href, event)) setExpanded(false); }} className={`${tabStyle} ${link.active ? "text-accent" : "text-foreground/75"}`}>
        <Icon size={22} strokeWidth={link.active ? 2.4 : 2} aria-hidden />
        <span>{link.label}</span>
      </Link>)}
      </div>
      </div>
      {fit.overflow && <button type="button" aria-label="Scroll mobile menu to end" aria-controls={scrollId} disabled={edges.end} onClick={() => scroll(true)} className={arrowStyle}><ChevronRight size={18} aria-hidden /></button>}
      </div>}
      {collapsible && <button ref={trigger} type="button" aria-label={expanded ? "Collapse mobile menu" : "Menu"} aria-expanded={expanded} aria-controls={panelId} onClick={() => setExpanded(value => !value)} className={expanded ? arrowStyle : `${glass} pointer-events-auto flex h-11 min-w-11 items-center justify-center gap-2 px-4 text-sm font-bold transition-colors hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring motion-reduce:transition-none`}>{expanded ? <X size={18} aria-hidden /> : <><Menu size={18} aria-hidden />Menu</>}</button>}
    </div>
    </div>
  </nav></>;
}
