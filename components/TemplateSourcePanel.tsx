"use client";

import { HelpTooltip } from "@/components/HelpTooltip";

import { useState } from "react";
import { ImagePlus, LoaderCircle } from "lucide-react";
import { Dropdown } from "./Dropdown";
import type { PhotoProject } from "@/lib/projects/model";
import { ROLES, type Role } from "@/lib/layouts";

export function TemplateSourcePanel({ project, onImport }: { project: PhotoProject; onImport: (role: Role, index: number, file: File) => Promise<void> }) {
  const options = ROLES.flatMap(role => Array.from({ length: project.editor.template?.requiredSources[role] ?? 0 }, (_, index) => ({ value: `${role}:${index}`, label: `${role} · Photo ${index + 1}${project.sourceOrder[role][index] ? "" : " (missing)"}` })));
  const [value, setValue] = useState(options[0]?.value ?? "A:0");
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  return <section className="flex flex-col gap-3">
    <div className="flex items-center gap-1.5"><h2 className="font-display text-lg">Template photos</h2><HelpTooltip label="About template photos">Switching templates reuses the photos you already have. It won&apos;t open the camera.</HelpTooltip></div>
    <Dropdown showLabel label="Photo position" value={options.some(option => option.value === value) ? value : options[0]?.value ?? ""} options={options} onChange={setValue} disabled={busy} />
    <label className={`btn btn-quiet relative w-full cursor-pointer text-sm focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring ${busy ? "opacity-50" : ""}`}>
      {busy ? <LoaderCircle size={16} className="animate-spin motion-reduce:animate-none" aria-hidden /> : <ImagePlus size={16} aria-hidden />}{busy ? "Importing photo…" : "Import or replace this photo"}
      <input type="file" accept="image/jpeg,image/png,image/webp" aria-label="Import a photo" className="sr-only" disabled={busy} onChange={async event => {
        const file = event.target.files?.[0]; event.target.value = ""; if (!file) return;
        const selected = options.find(option => option.value === value) ?? options[0]; if (!selected) return;
        const [role, index] = selected.value.split(":"); setBusy(true); setError(null);
        try { await onImport(role as Role, Number(index), file); } catch (error) { setError(error instanceof Error ? error.message : "Couldn't import that photo."); }
        finally { setBusy(false); }
      }} />
    </label>
    {error && <p role="alert" className="text-sm font-bold text-destructive">{error}</p>}
  </section>;
}
