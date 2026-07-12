"use client";

import { FILTERS } from "@/lib/filters";

export function FilterBar({
  value,
  onChange,
  disabled = false,
}: {
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="scrollbar-hide flex gap-2 overflow-x-auto px-1 py-1">
      {FILTERS.map((f) => (
        <button
          key={f.id}
          disabled={disabled}
          onClick={() => onChange(f.id)}
          className={`min-h-11 shrink-0 rounded-full px-4 text-sm font-medium transition ${
            value === f.id
              ? "bg-accent text-accent-foreground"
              : "bg-muted text-muted-foreground hover:text-foreground"
          } ${disabled ? "opacity-40" : ""}`}
        >
          {f.name}
        </button>
      ))}
    </div>
  );
}
