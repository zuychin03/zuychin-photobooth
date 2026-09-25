"use client";

import { type FocusEvent, useCallback, useId, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BookHeart, CalendarDays, Camera, ChevronLeft, ChevronRight, FolderOpen, Heart, Images, LayoutTemplate, LogIn, LogOut, UserRound } from "lucide-react";
import { Logo } from "@/components/Logo";
import { MobileNav } from "@/components/MobileNav";
import { useAuth } from "@/lib/auth";
import { useAppNavigation } from "@/components/AppNavigation";
import { useKioskLocked } from "@/components/events/EventKioskGuard";

export function SiteNav() {
  const { user, enabled: authEnabled } = useAuth(), pathname = usePathname();
  const navigation = useAppNavigation(), locked = useKioskLocked(), header = useRef<HTMLElement>(null);
  const pill = useRef<HTMLElement>(null), scroller = useRef<HTMLDivElement>(null), options = useRef<HTMLDivElement>(null);
  const pillAnchor = useRef<HTMLDivElement>(null);
  const [floatingPill, setFloatingPill] = useState<{ left: number; width: number; height: number } | null>(null);
  const [viewportRevision, refreshViewport] = useState(0);
  const placePill = useCallback(() => {
    const anchor = pillAnchor.current;
    if (!anchor || !matchMedia("(min-width: 768px)").matches) { setFloatingPill(null); return; }
    const rect = anchor.getBoundingClientRect();
    const next = rect.top < 16 ? { left: rect.left, width: rect.width, height: rect.height } : null;
    setFloatingPill(previous => previous?.left === next?.left && previous?.width === next?.width && previous?.height === next?.height ? previous : next);
  }, []);
  useLayoutEffect(() => {
    const resize = () => { setFloatingPill(null); refreshViewport(value => value + 1); };
    window.addEventListener("scroll", placePill, { passive: true });
    window.addEventListener("resize", resize);
    return () => { window.removeEventListener("scroll", placePill); window.removeEventListener("resize", resize); };
  }, [placePill]);
  useLayoutEffect(() => { if (!floatingPill) placePill(); }, [floatingPill, placePill, pathname, user?.id, viewportRevision]);
  const scrollId = useId();
  const [scrollState, setScrollState] = useState({ overflow: false, atStart: true, atEnd: true });
  const measureScroll = useCallback(() => {
    const container = pill.current, viewport = scroller.current, content = options.current;
    if (!container || !viewport || !content) return;
    const style = getComputedStyle(container);
    const available = container.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const next = {
      overflow: content.scrollWidth > available + 1,
      atStart: viewport.scrollLeft <= 1,
      atEnd: viewport.scrollLeft >= viewport.scrollWidth - viewport.clientWidth - 1,
    };
    setScrollState(previous => previous.overflow === next.overflow && previous.atStart === next.atStart && previous.atEnd === next.atEnd ? previous : next);
  }, []);
  useLayoutEffect(() => {
    measureScroll();
    const observer = new ResizeObserver(measureScroll);
    for (const element of [pill.current, scroller.current, options.current]) if (element) observer.observe(element);
    return () => observer.disconnect();
  }, [measureScroll]);
  const scrollToEdge = (end: boolean) => {
    const viewport = scroller.current;
    if (!viewport) return;
    viewport.scrollTo({ left: end ? viewport.scrollWidth - viewport.clientWidth : 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  };
  const revealFocusedOption = (event: FocusEvent<HTMLDivElement>) => {
    const viewport = event.currentTarget, target = event.target;
    const bounds = viewport.getBoundingClientRect(), option = target.getBoundingClientRect();
    const offset = option.left < bounds.left ? option.left - bounds.left : option.right > bounds.right ? option.right - bounds.right : 0;
    if (offset) viewport.scrollTo({ left: viewport.scrollLeft + offset, behavior: "instant" });
  };
  useLayoutEffect(() => {
    const element = header.current;
    if (!element) return;
    const measure = () => document.documentElement.style.setProperty("--app-nav-height", `${element.getBoundingClientRect().height}px`);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => { observer.disconnect(); document.documentElement.style.removeProperty("--app-nav-height"); };
  }, []);

  const links = [
    { href: "/booth", label: "Create", icon: Camera, active: pathname === "/booth" },
    { href: "/together", label: "Together", icon: Heart, active: /^\/(together|room|relay|challenges)(\/|$)/.test(pathname) },
    { href: "/events", label: "Events", icon: CalendarDays, active: /^\/(events|e|receipt|kiosk-locked)(\/|$)/.test(pathname) },
    { href: "/projects", label: "Projects", icon: FolderOpen, active: /^\/(projects|customize)(\/|$)/.test(pathname) },
    { href: "/templates", label: "Templates", icon: LayoutTemplate, active: pathname.startsWith("/templates") },
    ...(user ? [
      { href: "/memories", label: "Memories", icon: BookHeart, active: pathname.startsWith("/memories") },
      { href: "/timeline", label: "Vault", icon: Images, active: pathname === "/timeline" },
    ] : []),
  ];
  const brand = <><Logo className="h-8 w-auto text-foreground sm:h-9" /><span className="font-display whitespace-nowrap text-base font-semibold sm:text-lg">Zuychin <span className="text-accent">/ Photobooth</span></span></>;
  const guard = (href: string, event: { preventDefault(): void }) => { if (locked || navigation?.canNavigate(href) === false) { event.preventDefault(); return false; } return true; };
  const linkStyle = "flex min-h-11 shrink-0 items-center gap-2 whitespace-nowrap rounded-full px-4 transition-colors hover:bg-accent/10 hover:text-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring";
  const scrollButtonStyle = "flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent/10 hover:text-accent disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring";
  const accountHref = user ? "/timeline?signout=1" : "/login?next=/timeline";
  const accountLabel = user ? "Sign out" : "Sign in";
  const account = (compact: boolean) => {
    const iconOnly = compact || Boolean(user);
    const className = iconOnly ? "flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-muted transition-colors hover:bg-accent/15 hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" : `${linkStyle} gap-2 bg-muted`;
    const content = user ? <LogOut size={20} aria-hidden /> : compact ? <UserRound size={20} aria-hidden /> : <><LogIn size={16} aria-hidden />Sign in</>;
    return locked ? <span aria-disabled="true" aria-label={accountLabel} className={`${className} opacity-40`}>{content}</span> : <Link href={accountHref} aria-label={accountLabel} title={iconOnly ? accountLabel : undefined} onNavigate={event => guard(accountHref, event)} aria-current={!user && pathname === "/login" ? "page" : undefined} className={className}>{content}</Link>;
  };

  return <><header ref={header} className="relative z-[45] shrink-0">
    <div className="flex w-full flex-wrap items-center justify-between gap-x-6 gap-y-4 px-5 pt-5 pb-3 sm:px-8 md:flex-nowrap lg:py-5">
      <div className="flex w-full items-center justify-between gap-3 md:w-auto md:shrink-0">
        {locked ? <span className="flex min-h-11 items-center gap-2.5">{brand}</span> : <Link href="/" aria-label="Zuychin Photobooth home" onNavigate={event => guard("/", event)} className="flex min-h-11 items-center gap-2.5 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">{brand}</Link>}
        {authEnabled && <div className="md:hidden">{account(true)}</div>}
      </div>
      <div ref={pillAnchor} className="hidden min-w-0 max-w-full md:block" style={floatingPill ? { width: floatingPill.width, height: floatingPill.height } : undefined}>
      <nav ref={pill} aria-label="Main navigation" style={floatingPill ? { position: "fixed", top: 16, left: floatingPill.left, width: floatingPill.width } : undefined} className="flex w-full min-w-0 max-w-full items-center rounded-full border border-border/60 bg-muted/75 p-1 text-sm font-medium backdrop-blur-xl">
        {scrollState.overflow && <button type="button" aria-label="Scroll menu to start" aria-controls={scrollId} title="First options" disabled={scrollState.atStart} onClick={() => scrollToEdge(false)} className={scrollButtonStyle}><ChevronLeft size={18} aria-hidden /></button>}
        <div ref={scroller} id={scrollId} onScroll={measureScroll} onFocusCapture={revealFocusedOption} className="scrollbar-hide min-w-0 flex-1 overflow-x-auto overscroll-x-contain rounded-full">
          <div ref={options} className="flex w-max items-center gap-0.5">
            {links.map(({ icon: Icon, ...link }) => locked ? <span key={link.href} aria-disabled="true" className={`${linkStyle} opacity-40`}><Icon size={17} aria-hidden />{link.label}</span> : <Link key={link.href} href={link.href} onNavigate={event => guard(link.href, event)} aria-current={link.active ? "page" : undefined} className={`${linkStyle} ${link.active ? "bg-accent/10 text-accent" : ""}`}><Icon size={17} aria-hidden />{link.label}</Link>)}
            {authEnabled && <div className="hidden shrink-0 sm:flex">{account(false)}</div>}
          </div>
        </div>
        {scrollState.overflow && <button type="button" aria-label="Scroll menu to end" aria-controls={scrollId} title="Last options" disabled={scrollState.atEnd} onClick={() => scrollToEdge(true)} className={scrollButtonStyle}><ChevronRight size={18} aria-hidden /></button>}
      </nav>
      </div>
    </div>
    {locked && <p className="pb-2 text-center text-xs text-muted-foreground">Kiosk locked. Use Operator to exit.</p>}
  </header>{!locked && <MobileNav key={`${pathname}:${user?.id ?? "guest"}`} links={links} canNavigate={guard} />}</>;
}
