"use client";
import { useEffect, useRef } from "react";
import { useCapturePreferences } from "@/hooks/useCapturePreferences";

export function Countdown({ value }: { value: number | null }) {
  const { reducedMotion } = useCapturePreferences();
  if (value === null) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center">
      <span
        key={value}
        className={`${reducedMotion ? "" : "countdown-pulse"} text-[9rem] leading-none font-bold text-white drop-shadow-[0_2px_24px_rgba(0,0,0,0.55)]`}
        style={{ fontFamily: "var(--font-fraunces)" }}
      >
        {value}
      </span>
    </div>
  );
}

export function CaptureFlash({ trigger }: { trigger: number }) {
  const { flash } = useCapturePreferences(), element = useRef<HTMLDivElement>(null), previous = useRef(trigger);
  useEffect(() => {
    const changed = previous.current !== trigger; previous.current = trigger;
    if (!changed || !trigger || !flash) return;
    const animation = element.current?.animate([{ opacity: .85 }, { opacity: 0 }], { duration: 450, easing: "ease-out" });
    return () => animation?.cancel();
  }, [trigger, flash]);
  return <div ref={element} aria-hidden="true" className="pointer-events-none absolute inset-0 z-30 bg-white opacity-0" />;
}
