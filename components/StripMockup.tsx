// Decorative CSS photo strip for the landing hero.
const TONES = [
  ["#fda4af", "#fecdd3"],
  ["#c4b5fd", "#ddd6fe"],
  ["#fcd34d", "#fde68a"],
  ["#6ee7b7", "#a7f3d0"],
];

export function StripMockup({
  tilt,
  className = "",
}: {
  tilt: number;
  className?: string;
}) {
  return (
    <div
      aria-hidden
      className={`w-24 sm:w-28 rounded-md bg-[#faf7f2] p-2 shadow-xl shadow-black/20 ${className}`}
      style={{ transform: `rotate(${tilt}deg)` }}
    >
      {TONES.map(([from, to], i) => (
        <div
          key={i}
          className="mb-2 h-14 sm:h-16 rounded-sm"
          style={{ background: `linear-gradient(135deg, ${from}, ${to})` }}
        />
      ))}
      <div className="flex items-center justify-center pb-1 pt-0.5">
        <span className="text-[9px] italic font-bold tracking-widest text-[#ff9d45]">
        26·12·2025
        </span>
      </div>
    </div>
  );
}
