"use client";

import { useId } from "react";
import { Dropdown } from "@/components/Dropdown";
import { STRIP_CHOICES, type StripOptions } from "@/lib/strip-style";

type Field = keyof StripOptions;

const LABELS: Record<Field, string> = { finish: "Photo finish", sprockets: "Film edges", spacing: "Spacing", band: "Caption position", footer: "Footer", date: "Date", font: "Font", dateFormat: "Date format" };

/** Labelled controls for the chosen strip style fields, two to a row. */
export function StripStyleControls({ value, onChange, fields, disabled = false }: { value: StripOptions; onChange(next: StripOptions): void; fields: readonly Field[]; disabled?: boolean }) {
  const id = useId();
  return (
    <div className="grid grid-cols-2 gap-3">
      {fields.map(field => field === "sprockets" ? (
        <div key={field} className="flex min-w-0 flex-col gap-1.5 text-sm">
          <span id={`${id}-sprockets`} className="font-bold">{LABELS.sprockets}</span>
          <button type="button" id={`${id}-sprockets-state`} aria-labelledby={`${id}-sprockets ${id}-sprockets-state`} aria-pressed={value.sprockets} disabled={disabled} onClick={() => onChange({ ...value, sprockets: !value.sprockets })} className="btn btn-quiet min-h-11 px-3.5 text-sm aria-pressed:bg-accent/15 aria-pressed:text-accent disabled:opacity-50">
            {value.sprockets ? "On" : "Off"}
          </button>
        </div>
      ) : (
        <Dropdown key={field} showLabel label={LABELS[field]} value={value[field]} disabled={disabled} className="min-w-0" options={STRIP_CHOICES[field].map(([id, name]) => ({ value: id, label: name }))} onChange={next => onChange({ ...value, [field]: next })} />
      ))}
    </div>
  );
}
