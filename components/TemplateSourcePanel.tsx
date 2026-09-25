"use client";

import { HelpTooltip } from "@/components/HelpTooltip";

import { useState } from "react";
import { Dropdown } from "./Dropdown";
import type { PhotoProject } from "@/lib/projects/model";
import { ROLES, type Role } from "@/lib/layouts";

export function TemplateSourcePanel({ project, onImport }: { project: PhotoProject; onImport: (role: Role, index: number, file: File) => Promise<void> }) {
  const options = ROLES.flatMap(role => Array.from({ length: project.editor.template?.requiredSources[role] ?? 0 }, (_, index) => ({ value: `${role}:${index}`, label: `${role} · Photo ${index + 1}${project.sourceOrder[role][index] ? "" : " (missing)"}` })));
  const [value, setValue] = useState(options[0]?.value ?? "A:0");
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  return <section className="space-y-2 border-y border-border py-4">
    <div className="flex items-center gap-2"><h2 className="font-medium">Template photos</h2><HelpTooltip label="About template photos">Changing the template reuses your originals. It never starts a camera.</HelpTooltip></div>
    <p className="text-sm text-muted-foreground">Reuse an original or import a missing photo.</p>
    <Dropdown label="Photo position" value={options.some(option => option.value === value) ? value : options[0]?.value ?? ""} options={options} onChange={setValue} disabled={busy} />
    <label className="relative flex min-h-11 cursor-pointer items-center justify-center rounded-xl border border-border px-3 text-sm focus-within:ring-2 focus-within:ring-accent">
      {busy ? "Importing photo…" : "Import or replace this photo"}
      <input type="file" accept="image/jpeg,image/png,image/webp" aria-label="Import template photo" className="sr-only" disabled={busy} onChange={async event => {
        const file = event.target.files?.[0]; event.target.value = ""; if (!file) return;
        const selected = options.find(option => option.value === value) ?? options[0]; if (!selected) return;
        const [role, index] = selected.value.split(":"); setBusy(true); setError(null);
        try { await onImport(role as Role, Number(index), file); } catch (error) { setError(error instanceof Error ? error.message : "Photo could not be imported"); }
        finally { setBusy(false); }
      }} />
    </label>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </section>;
}
