"use client";

import { useState } from "react";
import { ArrowLeft, ArrowRight, FlipHorizontal, RotateCw } from "lucide-react";
import { FILTERS } from "@/lib/filters";
import { LAYOUTS, cellShotIndex, getLayout, type Role } from "@/lib/layouts";
import { defaultCellEdit, type PhotoCellEdit } from "@/lib/projects/transforms";
import type { PhotoProject, ProjectEditorSettings, ProjectSourceOrder } from "@/lib/projects/model";
import { Dropdown } from "@/components/Dropdown";

interface Props {
  project: PhotoProject;
  editor: ProjectEditorSettings;
  change(patch: Partial<ProjectEditorSettings>): void;
  reorder(order: ProjectSourceOrder): Promise<void>;
}

export function PhotoEditPanel({ project, editor, change, reorder }: Props) {
  const [selection, setSelection] = useState("0:A");
  const [moving, setMoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const layout = getLayout(editor.layoutId);
  const cells = Array.from({ length: layout.rows * layout.cols }, (_, index) => {
    const owner = layout.duoPattern?.[index] ?? "A";
    return (owner === "AB" ? ["A", "B"] : [owner]).map(role => ({ key: `${index}:${role}`, index, role: role as Role }));
  }).flat();
  const selected = cells.find(cell => cell.key === selection) ?? cells[0];
  const edit = editor.cellEdits[selected.key] ?? defaultCellEdit(cellShotIndex(layout, selected.index));
  const controlsDisabled = Boolean(editor.sceneId);
  const update = (patch: Partial<PhotoCellEdit>) => change({ cellEdits: { ...editor.cellEdits, [selected.key]: { ...edit, ...patch } } });
  const control = "min-h-11 rounded-lg border border-border bg-card px-3 text-sm focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50";

  async function move(role: Role, index: number, offset: number) {
    setMoving(true); setError(null);
    const order = [...project.sourceOrder[role]];
    [order[index], order[index + offset]] = [order[index + offset], order[index]];
    try { await reorder({ ...project.sourceOrder, [role]: order }); }
    catch (error) { setError(error instanceof Error ? error.message : "Photo order could not be saved"); }
    finally { setMoving(false); }
  }

  return <details className="border-y border-border py-4" open>
    <summary className="min-h-8 cursor-pointer font-semibold">Photos &amp; crop</summary>
    <div className="mt-4 flex flex-col gap-4">
      <div className="flex flex-col gap-2 text-sm"><span>Layout</span>
        <Dropdown label="Layout" value={editor.layoutId} onChange={value => {
          const next = getLayout(value);
          change({ layoutId: next.id, cellEdits: Object.fromEntries(Object.entries(editor.cellEdits).filter(([key]) => Number(key.split(":")[0]) < next.rows * next.cols)) });
        }} options={LAYOUTS.filter(item => item.mode === project.mode).map(item => ({ value: item.id, label: item.name }))} />
      </div>
      {project.participants.map(person => <div key={person.id}>
        <p className="text-sm text-muted-foreground">{project.mode === "solo" ? "Photo order" : `Participant ${person.role} photo order`}</p>
        <div className="mt-2 flex flex-wrap gap-2">{project.sourceOrder[person.role].map((id, index, order) => <div key={`${id}-${index}`} className="flex items-center gap-1 rounded-lg bg-muted px-1">
          <button type="button" className="flex h-11 w-11 items-center justify-center disabled:opacity-30" aria-label={`Move ${person.role} photo ${index + 1} earlier`} disabled={moving || index === 0} onClick={() => void move(person.role, index, -1)}><ArrowLeft size={14} /></button>
          <span className="text-sm">{index + 1}{id ? "" : " empty"}</span>
          <button type="button" className="flex h-11 w-11 items-center justify-center disabled:opacity-30" aria-label={`Move ${person.role} photo ${index + 1} later`} disabled={moving || index === order.length - 1} onClick={() => void move(person.role, index, 1)}><ArrowRight size={14} /></button>
        </div>)}</div>
      </div>)}
      {controlsDisabled && <p className="text-sm text-muted-foreground">Turn off the Together scene to crop individual photos, or use scene placement below.</p>}
      <fieldset disabled={controlsDisabled} className="flex flex-col gap-3 disabled:opacity-50">
        <div className="flex flex-col gap-2 text-sm"><span>Photo cell</span>
          <Dropdown label="Photo cell" value={selected.key} disabled={controlsDisabled} onChange={setSelection} options={cells.map(cell => ({ value: cell.key, label: `Cell ${cell.index + 1}${project.mode === "solo" ? "" : ` · ${cell.role}`}` }))} />
        </div>
        <div className="flex flex-col gap-2 text-sm"><span>Source photo</span>
          <Dropdown label="Source photo" value={String(edit.sourceIndex)} disabled={controlsDisabled} onChange={value => update({ sourceIndex: Number(value) })} options={Array.from({ length: 4 }, (_, index) => ({ value: String(index), label: `Photo ${index + 1}${project.sourceOrder[selected.role][index] ? "" : " (empty)"}`, disabled: !project.sourceOrder[selected.role][index] }))} />
        </div>
        {([['zoom', 'Zoom', 1, 4], ['offsetX', 'Horizontal crop', -1, 1], ['offsetY', 'Vertical crop', -1, 1]] as const).map(([field, label, min, max]) => <label key={field} className="flex flex-col gap-1 text-sm"><span className="flex justify-between">{label}<span className="tabular-nums">{edit[field].toFixed(2)}{field === 'zoom' ? '×' : ''}</span></span><input aria-label={label} className="h-11 w-full accent-accent" type="range" min={min} max={max} step="0.02" value={edit[field]} onChange={event => update({ [field]: Number(event.target.value) })} /></label>)}
        <div className="flex flex-wrap gap-2">
          <button className={`${control} flex items-center gap-2`} type="button" onClick={() => update({ rotation: ((edit.rotation + 90) % 360) as PhotoCellEdit["rotation"] })}><RotateCw size={16} /> Rotate {edit.rotation}°</button>
          <button className={`${control} flex items-center gap-2`} type="button" aria-pressed={edit.mirror} onClick={() => update({ mirror: !edit.mirror })}><FlipHorizontal size={16} /> Mirror{edit.mirror ? " on" : " off"}</button>
          <button className={control} type="button" onClick={() => { const next = { ...editor.cellEdits }; delete next[selected.key]; change({ cellEdits: next }); }}>Reset crop</button>
        </div>
        <div className="flex flex-col gap-2 text-sm"><span>Cell filter</span>
          <Dropdown label="Cell filter" value={edit.filterId ?? "inherit"} disabled={controlsDisabled} onChange={value => update({ filterId: value === "inherit" ? null : value })} options={[{ value: "inherit", label: "Use strip filter" }, ...FILTERS.map(filter => ({ value: filter.id, label: filter.name }))]} />
        </div>
      </fieldset>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </div>
  </details>;
}
