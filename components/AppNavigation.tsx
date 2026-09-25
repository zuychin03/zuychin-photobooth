"use client";

import { createContext, useCallback, useContext, useId, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { usePathname } from "next/navigation";

type Guard = (href: string) => boolean;
interface Navigation {
  register(id: string, guard: Guard): () => void;
  canNavigate: Guard;
}
const Context = createContext<Navigation | null>(null);

export function AppNavigationProvider({ children }: { children: ReactNode }) {
  const guards = useRef(new Map<string, Guard>()), pathname = usePathname();
  const register = useCallback((id: string, guard: Guard) => {
    guards.current.set(id, guard);
    return () => { guards.current.delete(id); };
  }, []);
  const canNavigate = useCallback((href: string) => {
    if (pathname.startsWith("/v2-lab")) return true;
    for (const guard of guards.current.values()) if (!guard(href)) return false;
    return true;
  }, [pathname]);
  const value = useMemo(() => ({ register, canNavigate }), [register, canNavigate]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useAppNavigationGuard(guard: Guard, enabled = true) {
  const register = useContext(Context)?.register, id = useId(), latest = useRef(guard);
  useLayoutEffect(() => { latest.current = guard; });
  useLayoutEffect(() => {
    if (enabled) return register?.(id, href => latest.current(href));
  }, [register, id, enabled]);
}

export function useAppNavigation() {
  return useContext(Context);
}
