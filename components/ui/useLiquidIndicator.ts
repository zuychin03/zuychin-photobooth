"use client";

import { useLayoutEffect, type RefObject } from "react";

const lastX = new WeakMap<HTMLElement, number>();

/** Slides a glass droplet under the `[aria-current="page"]` child of `host`, squashing it as it travels. */
export function useLiquidIndicator(host: RefObject<HTMLElement | null>, drop: RefObject<HTMLElement | null>, signature: string) {
  useLayoutEffect(() => {
    const scope = host.current, indicator = drop.current;
    if (!scope || !indicator) return;
    const place = (travel: boolean) => {
      const active = scope.querySelector<HTMLElement>('[aria-current="page"]');
      if (!active) { indicator.style.setProperty("opacity", "0"); indicator.removeAttribute("data-ready"); lastX.delete(indicator); return; }
      const x = active.offsetLeft, previous = lastX.get(indicator);
      indicator.style.setProperty("width", `${active.offsetWidth}px`);
      indicator.style.setProperty("height", `${active.offsetHeight}px`);
      indicator.style.setProperty("translate", `${x}px ${active.offsetTop}px`);
      indicator.style.setProperty("opacity", "1");
      if (travel && previous !== undefined && Math.abs(previous - x) > 1 && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
        indicator.animate([{ scale: "1 1" }, { scale: "1.16 0.84", offset: 0.28 }, { scale: "0.97 1.03", offset: 0.62 }, { scale: "1 1" }], { duration: 620, easing: "ease-out" });
      }
      lastX.set(indicator, x);
      if (!indicator.hasAttribute("data-ready")) requestAnimationFrame(() => indicator.setAttribute("data-ready", ""));
    };
    place(true);
    const observer = new ResizeObserver(() => place(false));
    observer.observe(scope);
    return () => observer.disconnect();
  }, [host, drop, signature]);
}
