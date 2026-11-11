"use client";

import { type FocusEvent, useCallback, useId, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BookHeart, CalendarDays, Camera, ChevronLeft, ChevronRight, FolderOpen, Heart, Images, LayoutTemplate, LogIn, LogOut, UserRound } from "lucide-react";
import { Logo } from "@/components/Logo";
import { MobileNav } from "@/components/MobileNav";
import { ThemeToggle } from "@/components/ThemeToggle";
import { useAuth } from "@/lib/auth";
import { useAppNavigation } from "@/components/AppNavigation";
import { useKioskLocked } from "@/components/events/EventKioskGuard";
import { useRecoveryRelease } from "@/components/ReleaseMode";
import { useLiquidIndicator } from "@/components/ui/useLiquidIndicator";
import { useGlassLens } from "@/components/ui/useGlassLens";

// Kept laid out (not display:none) so its natural width can still be measured.
const pillMeasuredOnly = "invisible pointer-events-none absolute left-0 top-0 h-0 w-0 overflow-hidden";
const pillMeasuredBelowMd = "max-md:invisible max-md:pointer-events-none max-md:absolute max-md:left-0 max-md:top-0 max-md:h-0 max-md:w-0 max-md:overflow-hidden";

export function SiteNav() {
  const { user, enabled: authEnabled } = useAuth(), pathname = usePathname();
  const recovery = useRecoveryRelease();
  const navigation = useAppNavigation(), locked = useKioskLocked(), header = useRef<HTMLElement>(null);
  const pill = useRef<HTMLElement>(null), scroller = useRef<HTMLDivElement>(null), options = useRef<HTMLDivElement>(null);
  const pillAnchor = useRef<HTMLDivElement>(null), droplet = useRef<HTMLSpanElement>(null);
  const row = useRef<HTMLDivElement>(null), brandBox = useRef<HTMLDivElement>(null);
  // Null until measured; the server render falls back to the md breakpoint.
  const [topFits, setTopFits] = useState<boolean | null>(null), fits = useRef<boolean | null>(null);
  const [floatingPill, setFloatingPill] = useState<{ left: number; width: number; height: number } | null>(null);
  const [viewportRevision, refreshViewport] = useState(0);
  const placePill = useCallback(() => {
    const anchor = pillAnchor.current;
    if (!anchor || !(fits.current ?? matchMedia("(min-width: 768px)").matches)) { setFloatingPill(null); return; }
    const rect = anchor.getBoundingClientRect();
    const safeTop = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--safe-top")) || 0;
    const next = rect.top < 16 + safeTop ? { left: rect.left, width: rect.width, height: rect.height } : null;
    setFloatingPill(previous => previous?.left === next?.left && previous?.width === next?.width && previous?.height === next?.height ? previous : next);
  }, []);
  useLayoutEffect(() => {
    const resize = () => { setFloatingPill(null); refreshViewport(value => value + 1); };
    window.addEventListener("scroll", placePill, { passive: true });
    window.addEventListener("resize", resize);
    return () => { window.removeEventListener("scroll", placePill); window.removeEventListener("resize", resize); };
  }, [placePill]);
  useLayoutEffect(() => { if (!floatingPill) placePill(); }, [floatingPill, placePill, pathname, user?.id, viewportRevision, topFits]);
  useLayoutEffect(() => {
    const measure = () => {
      const container = row.current, brandItem = brandBox.current?.firstElementChild, content = options.current;
      if (!container || !(brandItem instanceof HTMLElement) || !content) return;
      const style = getComputedStyle(container);
      const available = container.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      // Brand, the row gap, every link at full width, and the pill's padding.
      const next = brandItem.offsetWidth + parseFloat(style.columnGap || "0") + content.offsetWidth + 12 <= available;
      fits.current = next;
      setTopFits(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (const element of [row.current, options.current, brandBox.current]) if (element) observer.observe(element);
    return () => observer.disconnect();
  }, []);
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
  useLiquidIndicator(options, droplet, `${pathname}:${links.length}:${viewportRevision}`);
  useGlassLens(pill, topFits !== false);
  const brand = <><Logo className="h-9 w-auto text-foreground" /><span className="flex flex-col leading-none"><span className="font-display text-lg leading-none">Zuychin</span><span className="mt-1 text-[0.6875rem] font-bold tracking-[0.14em] text-accent uppercase">Photobooth</span></span></>;
  const guard = (href: string, event: { preventDefault(): void }) => { if (locked || navigation?.canNavigate(href) === false) { event.preventDefault(); return false; } return true; };
  const linkStyle = "relative z-[1] flex min-h-10 shrink-0 items-center gap-2 whitespace-nowrap rounded-full px-4 font-bold transition-colors hover:text-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring";
  const scrollButtonStyle = "flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-accent disabled:cursor-default disabled:opacity-30 disabled:hover:text-muted-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring";
  const accountHref = user ? "/timeline?signout=1" : recovery ? "/login?next=/projects/cloud" : "/login?next=/timeline";
  const accountLabel = user ? "Sign out" : "Sign in";
  const collapsibleMobileNav = pathname === "/booth" || pathname === "/customize" || /^\/room\/[^/]+\/?$/.test(pathname) || /^\/relay\/(?!new\/?$)[^/]+\/?$/.test(pathname);
  const circleStyle = "flex shrink-0 items-center justify-center rounded-full transition-colors hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
  const account = (compact: boolean) => {
    const iconOnly = compact || Boolean(user);
    const className = iconOnly ? `${circleStyle} h-11 w-11 ${compact ? "glass" : "relative z-[1]"}` : `${linkStyle} btn-tinted`;
    const content = user ? <LogOut size={20} aria-hidden /> : compact ? <UserRound size={20} aria-hidden /> : <><LogIn size={16} aria-hidden />Sign in</>;
    return locked ? <span aria-disabled="true" aria-label={accountLabel} className={`${className} opacity-40`}>{content}</span> : <Link href={accountHref} aria-label={accountLabel} title={iconOnly ? accountLabel : undefined} onNavigate={event => guard(accountHref, event)} aria-current={!user && pathname === "/login" ? "page" : undefined} className={className}>{content}</Link>;
  };

  return <><div aria-hidden className="scroll-edge scroll-edge-top" data-on={floatingPill ? "" : undefined} /><div aria-hidden className="scroll-edge scroll-edge-status" data-on="" /><header ref={header} className="site-header relative z-[45] shrink-0">
    <div ref={row} className="flex w-full items-center justify-between gap-x-6 px-4 pt-[calc(1rem+var(--safe-top))] pb-2 sm:px-8 md:pt-[calc(1.25rem+var(--safe-top))] md:pb-4">
      <div ref={brandBox} className="flex shrink-0 items-center">
        {locked ? <span className="flex min-h-11 items-center gap-2.5">{brand}</span> : <Link href="/" aria-label="Zuychin Photobooth home" onNavigate={event => guard("/", event)} className="flex min-h-11 items-center gap-2.5 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">{brand}</Link>}
      </div>
      <div ref={pillAnchor} className={`min-w-0 max-w-full ${topFits === null ? pillMeasuredBelowMd : topFits ? "" : pillMeasuredOnly}`} style={floatingPill ? { width: floatingPill.width, height: floatingPill.height } : undefined}>
      <nav ref={pill} aria-label="Main navigation" style={floatingPill ? { position: "fixed", top: "calc(1rem + var(--safe-top))", left: floatingPill.left, width: floatingPill.width } : undefined} className="glass flex w-full min-w-0 max-w-full items-center rounded-full px-1.5 text-sm">
        {scrollState.overflow && <button type="button" aria-label="Scroll menu to start" aria-controls={scrollId} title="First options" disabled={scrollState.atStart} onClick={() => scrollToEdge(false)} className={scrollButtonStyle}><ChevronLeft size={18} aria-hidden /></button>}
        <div ref={scroller} id={scrollId} onScroll={measureScroll} onFocusCapture={revealFocusedOption} className="scrollbar-hide min-w-0 flex-1 overflow-x-auto overscroll-x-contain rounded-full py-1.5">
          <div ref={options} className="relative flex w-max items-center gap-0.5">
            <span ref={droplet} aria-hidden className="droplet" />
            {links.map(({ icon: Icon, ...link }) => locked ? <span key={link.href} aria-disabled="true" className={`${linkStyle} opacity-40`}><Icon size={17} aria-hidden />{link.label}</span> : <Link key={link.href} href={link.href} onNavigate={event => guard(link.href, event)} aria-current={link.active ? "page" : undefined} className={`${linkStyle} ${link.active ? "text-accent" : "text-foreground/80"}`}><Icon size={17} strokeWidth={2.25} aria-hidden />{link.label}</Link>)}
            <div className="ml-1 flex shrink-0 items-center gap-1.5 border-l border-foreground/10 pl-1.5"><ThemeToggle className={`${circleStyle} relative z-[1] h-10 w-10 text-foreground/80`} />{authEnabled && account(false)}</div>
          </div>
        </div>
        {scrollState.overflow && <button type="button" aria-label="Scroll menu to end" aria-controls={scrollId} title="Last options" disabled={scrollState.atEnd} onClick={() => scrollToEdge(true)} className={scrollButtonStyle}><ChevronRight size={18} aria-hidden /></button>}
      </nav>
      </div>
      <div className={`flex items-center gap-2 ${topFits === null ? "md:hidden" : topFits ? "hidden" : ""}`}><ThemeToggle className={`${circleStyle} glass h-11 w-11`} />{authEnabled && account(true)}</div>
    </div>
    {locked && <p className="pb-2 text-center text-xs text-muted-foreground">Kiosk locked. Use Operator to exit.</p>}
  </header>{!locked && <MobileNav key={`${collapsibleMobileNav}:${user?.id ?? "guest"}`} links={links} canNavigate={guard} collapsible={collapsibleMobileNav} presence={topFits === null ? "below-md" : topFits ? "hidden" : "shown"} />}</>;
}
