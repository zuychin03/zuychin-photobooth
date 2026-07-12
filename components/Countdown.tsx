"use client";

export function Countdown({ value }: { value: number | null }) {
  if (value === null) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center">
      <span
        key={value}
        className="countdown-pulse text-[9rem] leading-none font-bold text-white drop-shadow-[0_2px_24px_rgba(0,0,0,0.55)]"
        style={{ fontFamily: "var(--font-fraunces)" }}
      >
        {value}
      </span>
    </div>
  );
}

export function CaptureFlash({ trigger }: { trigger: number }) {
  if (trigger === 0) return null;
  return (
    <div
      key={trigger}
      className="capture-flash pointer-events-none absolute inset-0 z-30 bg-white"
    />
  );
}
