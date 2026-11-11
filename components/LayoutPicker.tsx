"use client";

import { useState } from "react";
import { LAYOUT_CATEGORIES, type LayoutCategory, type StripLayout } from "@/lib/layouts";
import { LayoutGlyph } from "@/components/LayoutGlyph";

export function layoutMeta(layout: StripLayout, asynchronous = false): string {
  const unit = layout.mode === "solo" || asynchronous ? "photo" : "round";
  return `${layout.shots} ${unit}${layout.shots === 1 ? "" : "s"}${asynchronous && layout.mode !== "solo" ? " each" : ""}`;
}

/** Categories present in a flow's layouts, in catalogue order. */
export function layoutCategories(layouts: readonly StripLayout[]): LayoutCategory[] {
  return LAYOUT_CATEGORIES.map(item => item.id).filter(id => layouts.some(layout => layout.category === id));
}

interface Props {
  layouts: readonly StripLayout[];
  value: string;
  onChange(id: string): void;
  label: string;
  disabled?: boolean;
  isDisabled?(layout: StripLayout): boolean;
  columns?: 2 | 3;
  /** relays and challenges: people shoot separately, so count photos each instead of rounds */
  asynchronous?: boolean;
}

/** Category chips, then tiles for the layouts in that category. */
export function LayoutPicker({ layouts, value, onChange, label, disabled = false, isDisabled, columns = 3, asynchronous = false }: Props) {
  const categories = layoutCategories(layouts);
  const current = layouts.find(layout => layout.id === value)?.category ?? categories[0];
  const [chosen, setChosen] = useState<LayoutCategory | null>(null);
  const category = chosen && categories.includes(chosen) ? chosen : current;
  const visible = layouts.filter(layout => layout.category === category);
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {categories.length > 1 && (
        <div className="scrollbar-hide -mx-1 overflow-x-auto px-1">
          <div role="group" aria-label={`${label} category`} className="segmented flex w-max min-w-full [&>*]:flex-1 [&>*]:px-2.5">
            {categories.map(id => (
              <button key={id} type="button" aria-pressed={id === category} disabled={disabled} onClick={() => setChosen(id)}>
                {LAYOUT_CATEGORIES.find(item => item.id === id)!.name}
              </button>
            ))}
          </div>
        </div>
      )}
      <div role="group" aria-label={label} className={`grid gap-2 ${columns === 2 ? "grid-cols-2" : "grid-cols-3"}`}>
        {visible.map(layout => {
          const selected = layout.id === value;
          return (
            <button
              key={layout.id}
              type="button"
              aria-pressed={selected}
              disabled={disabled || isDisabled?.(layout)}
              onClick={() => { if (!selected) onChange(layout.id); }}
              className={`flex min-w-0 flex-col items-center gap-2 rounded-2xl px-2 py-3 text-center disabled:opacity-60 ${selected ? "bg-accent/15 text-foreground shadow-[inset_0_0_0_2px_var(--accent)]" : "bg-muted text-muted-foreground"}`}
            >
              <LayoutGlyph layout={layout} selected={selected} />
              <span className="text-xs leading-tight font-bold">{layout.name}</span>
              <span className="text-[0.6875rem] tabular-nums">{layoutMeta(layout, asynchronous)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
