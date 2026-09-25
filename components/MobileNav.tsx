"use client";

import { useLayoutEffect, useRef } from "react";
import Link from "next/link";
import { type LucideIcon } from "lucide-react";

export interface SiteNavLink { href: string; label: string; active: boolean; icon: LucideIcon }

export function MobileNav({ links, canNavigate }: { links: SiteNavLink[]; canNavigate(href: string, event: { preventDefault(): void }): boolean }) {
  const tray = useRef<HTMLElement>(null);
  const destinations = links.slice(0, 5);

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

  const tabStyle = "flex min-h-14 min-w-0 flex-col items-center justify-center gap-1 rounded-xl px-1 py-2 text-xs font-medium transition-colors hover:bg-accent/10 hover:text-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring";
  return <nav ref={tray} aria-label="Mobile navigation" className="fixed left-[calc(0.375rem+env(safe-area-inset-left))] right-[calc(0.375rem+env(safe-area-inset-right))] bottom-[calc(0.375rem+env(safe-area-inset-bottom))] z-[45] rounded-2xl border border-border/70 bg-background/85 px-2 py-2 backdrop-blur-xl md:hidden">
    <div className="mx-auto grid max-w-lg grid-cols-5 gap-1">
      {destinations.map(({ icon: Icon, ...link }) => <Link key={link.href} href={link.href} aria-current={link.active ? "page" : undefined} onNavigate={event => { canNavigate(link.href, event); }} className={`${tabStyle} ${link.active ? "bg-accent/10 text-accent" : "text-muted-foreground"}`}><Icon size={21} aria-hidden /><span>{link.label}</span></Link>)}
    </div>
  </nav>;
}
