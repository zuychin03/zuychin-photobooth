"use client";

import { type FocusEvent, useCallback, useId, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, type LucideIcon } from "lucide-react";

export interface SiteNavLink { href: string; label: string; active: boolean; icon: LucideIcon }

export function MobileNav({ links, canNavigate }: { links: SiteNavLink[]; canNavigate(href: string, event: { preventDefault(): void }): boolean }) {
  const tray = useRef<HTMLElement>(null);
  const viewport = useRef<HTMLDivElement>(null), options = useRef<HTMLDivElement>(null);
  const scrollId = useId();
  const [edges, setEdges] = useState({ start: true, end: true });
  const measureScroll = useCallback(() => {
    const element = viewport.current;
    if (!element) return;
    const next = { start: element.scrollLeft <= 1, end: element.scrollLeft >= element.scrollWidth - element.clientWidth - 1 };
    setEdges(previous => previous.start === next.start && previous.end === next.end ? previous : next);
  }, []);
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
      if (target) reveal(target);
      measureScroll();
    };
    update();
    const observer = new ResizeObserver(update);
    for (const element of [viewport.current, options.current]) if (element) observer.observe(element);
    return () => observer.disconnect();
  }, [destinationSignature, measureScroll]);
  const scroll = (end: boolean) => {
    const element = viewport.current;
    if (element) element.scrollTo({ left: end ? element.scrollWidth - element.clientWidth : 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  };
  const revealFocus = (event: FocusEvent<HTMLDivElement>) => reveal(event.target);
  const arrowStyle = "flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-accent/10 hover:text-accent disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring";

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
  }, []);

  const tabStyle = "group flex min-h-14 min-w-[4.5rem] shrink-0 flex-col items-center justify-center gap-1 rounded-full px-1 py-1 text-xs font-medium transition-colors hover:text-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring";
  return <nav ref={tray} aria-label="Mobile navigation" className="fixed left-[calc(0.375rem+env(safe-area-inset-left))] right-[calc(0.375rem+env(safe-area-inset-right))] bottom-[calc(0.375rem+env(safe-area-inset-bottom))] z-[45] rounded-full border border-border/70 bg-background/85 px-2 py-2 backdrop-blur-xl md:hidden">
    <div className="mx-auto flex max-w-lg items-center gap-1">
      <button type="button" aria-label="Scroll mobile menu to start" aria-controls={scrollId} disabled={edges.start} onClick={() => scroll(false)} className={arrowStyle}><ChevronLeft size={18} aria-hidden /></button>
      <div ref={viewport} id={scrollId} onScroll={measureScroll} onFocusCapture={revealFocus} className="scrollbar-hide min-w-0 flex-1 overflow-x-auto overscroll-x-contain rounded-full">
      <div ref={options} className="flex w-max min-w-full items-center justify-between gap-1">
      {links.map(({ icon: Icon, ...link }) => <Link key={link.href} href={link.href} aria-current={link.active ? "page" : undefined} onNavigate={event => { canNavigate(link.href, event); }} className={`${tabStyle} ${link.active ? "text-accent" : "text-muted-foreground"}`}>
        <span className={`flex h-7 w-11 max-w-full shrink-0 items-center justify-center rounded-full transition-colors group-active:bg-accent/20 ${link.active ? "bg-accent/15 group-hover:bg-accent/20" : "group-hover:bg-accent/10"}`}><Icon size={21} aria-hidden /></span>
        <span>{link.label}</span>
      </Link>)}
      </div>
      </div>
      <button type="button" aria-label="Scroll mobile menu to end" aria-controls={scrollId} disabled={edges.end} onClick={() => scroll(true)} className={arrowStyle}><ChevronRight size={18} aria-hidden /></button>
    </div>
  </nav>;
}
