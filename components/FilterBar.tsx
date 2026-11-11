"use client";

import { FILTERS } from "@/lib/filters";

export function FilterBar({
  value,
  onChange,
  disabled = false,
  layoutClass = "scrollbar-hide overflow-x-auto",
}: {
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  /** overflow behavior: horizontal scroll by default, pass "flex-wrap" to wrap */
  layoutClass?: string;
}) {
  return (
    <div className={`flex gap-1.5 p-1 ${layoutClass}`}>
      {FILTERS.map((f) => (
        <button
          key={f.id}
          disabled={disabled}
          onClick={() => onChange(f.id)}
          className={`min-h-11 shrink-0 rounded-full px-4 text-sm font-bold ${
            value === f.id
              ? "bg-accent text-accent-foreground shadow-[inset_0_1px_0_rgb(255_255_255/0.3)]"
              : "bg-muted text-muted-foreground hover:text-foreground"
          } ${disabled ? "opacity-40" : ""}`}
        >
          {f.name}
        </button>
      ))}
    </div>
  );
}
