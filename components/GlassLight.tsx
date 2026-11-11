"use client";

import { useEffect } from "react";

const SURFACES = ".glass, .glass-strong, .btn-glass";

// One delegated listener moves the specular light on whichever glass surface is under the pointer.
export function GlassLight() {
  useEffect(() => {
    let frame = 0, pending: PointerEvent | null = null;
    const place = () => {
      frame = 0;
      const event = pending;
      pending = null;
      if (!(event?.target instanceof Element)) return;
      const surface = event.target.closest<HTMLElement>(SURFACES);
      if (!surface) return;
      const box = surface.getBoundingClientRect();
      if (!box.width || !box.height) return;
      surface.style.setProperty("--glass-x", `${((event.clientX - box.left) / box.width) * 100}%`);
      surface.style.setProperty("--glass-y", `${((event.clientY - box.top) / box.height) * 100}%`);
    };
    const queue = (event: PointerEvent) => {
      pending = event;
      if (!frame) frame = requestAnimationFrame(place);
    };
    document.addEventListener("pointermove", queue, { passive: true });
    document.addEventListener("pointerdown", queue, { passive: true });
    return () => {
      document.removeEventListener("pointermove", queue);
      document.removeEventListener("pointerdown", queue);
      cancelAnimationFrame(frame);
    };
  }, []);
  return null;
}
