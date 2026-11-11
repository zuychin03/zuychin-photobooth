"use client";

import { useCallback } from "react";

/**
 * Callback ref that writes --sticky-top for a `sticky` sidebar. A sidebar that fits pins under the floating
 * nav (`offset`); a taller one gets a negative top, so it scrolls until its bottom is in view and pins there.
 */
export function useStickyTop(offset = 88, gap = 16) {
  return useCallback((element: HTMLElement | null) => {
    if (!element) return;
    const update = () => {
      const bottomNav = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--app-bottom-nav-height")) || 0;
      const top = Math.min(offset, window.innerHeight - element.offsetHeight - bottomNav - gap);
      element.style.setProperty("--sticky-top", `${Math.round(top)}px`);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
      element.style.removeProperty("--sticky-top");
    };
  }, [offset, gap]);
}
