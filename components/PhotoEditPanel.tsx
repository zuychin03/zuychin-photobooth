"use client";

import { useState } from "react";
import { ArrowLeft, ArrowRight, ChevronDown, FlipHorizontal, RotateCw } from "lucide-react";
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
  const control = "btn btn-quiet px-3.5 text-sm";

  async function move(role: Role, index: number, offset: number) {
    setMoving(true); setError(null);
    const order = [...project.sourceOrder[role]];
    [order[index], order[index + offset]] = [order[index + offset], order[index]];
    try { await reorder({ ...project.sourceOrder, [role]: order }); }
    catch (error) { setError(error instanceof Error ? error.message : "Couldn't save the new order."); }
    finally { setMoving(false); }
  }

  return <details className="group" open>
    <summary className="flex min-h-9 cursor-pointer list-none items-center justify-between gap-3 font-display text-lg [&::-webkit-details-marker]:hidden">Photos &amp; crop<ChevronDown size={18} aria-hidden className="shrink-0 text-muted-foreground transition-transform duration-300 group-open:rotate-180 motion-reduce:transition-none" /></summary>
    <div className="mt-4 flex flex-col gap-5">
      <div className="flex flex-col gap-1.5 text-sm"><span className="font-bold">Layout</span>
        <Dropdown label="Layout" value={editor.layoutId} onChange={value => {
          const next = getLayout(value);
          change({ layoutId: next.id, cellEdits: Object.fromEntries(Object.entries(editor.cellEdits).filter(([key]) => Number(key.split(":")[0]) < next.rows * next.cols)) });
        }} options={LAYOUTS.filter(item => item.mode === project.mode).map(item => ({ value: item.id, label: item.name }))} />
      </div>
      {project.participants.map(person => <div key={person.id}>
        <p className="text-sm font-bold">{project.mode === "solo" ? "Photo order" : `Person ${person.role}'s photo order`}</p>
        <div className="mt-2 flex flex-wrap gap-1.5">{project.sourceOrder[person.role].map((id, index, order) => <div key={`${id}-${index}`} className="flex items-center rounded-full bg-muted">
          <button type="button" className="flex size-11 items-center justify-center rounded-full disabled:opacity-30" aria-label={`Move ${person.role} photo ${index + 1} earlier`} disabled={moving || index === 0} onClick={() => void move(person.role, index, -1)}><ArrowLeft size={15} aria-hidden /></button>
          <span className="min-w-4 text-center text-sm font-bold tabular-nums">{index + 1}{id ? "" : " empty"}</span>
          <button type="button" className="flex size-11 items-center justify-center rounded-full disabled:opacity-30" aria-label={`Move ${person.role} photo ${index + 1} later`} disabled={moving || index === order.length - 1} onClick={() => void move(person.role, index, 1)}><ArrowRight size={15} aria-hidden /></button>
        </div>)}</div>
      </div>)}
      {controlsDisabled && <p className="notice text-muted-foreground">Turn off the Together scene to crop photos one by one.</p>}
      <fieldset disabled={controlsDisabled} className="flex flex-col gap-4 border-t border-border pt-5 disabled:opacity-50">
        <div className="grid grid-cols-2 gap-3">
          <div className="flex min-w-0 flex-col gap-1.5 text-sm"><span className="font-bold">Photo slot</span>
            <Dropdown label="Photo slot" value={selected.key} disabled={controlsDisabled} onChange={setSelection} options={cells.map(cell => ({ value: cell.key, label: `Slot ${cell.index + 1}${project.mode === "solo" ? "" : ` · ${cell.role}`}` }))} />
          </div>
          <div className="flex min-w-0 flex-col gap-1.5 text-sm"><span className="font-bold">Photo in this slot</span>
            <Dropdown label="Photo in this slot" value={String(edit.sourceIndex)} disabled={controlsDisabled} onChange={value => update({ sourceIndex: Number(value) })} options={Array.from({ length: 4 }, (_, index) => ({ value: String(index), label: `Photo ${index + 1}${project.sourceOrder[selected.role][index] ? "" : " (empty)"}`, disabled: !project.sourceOrder[selected.role][index] }))} />
          </div>
        </div>
        {([['zoom', 'Zoom', 1, 4], ['offsetX', 'Horizontal crop', -1, 1], ['offsetY', 'Vertical crop', -1, 1]] as const).map(([field, label, min, max]) => <label key={field} className="flex flex-col text-sm font-bold"><span className="flex justify-between">{label}<span className="font-medium tabular-nums text-muted-foreground">{edit[field].toFixed(2)}{field === 'zoom' ? '×' : ''}</span></span><input aria-label={label} className="h-11 w-full accent-accent" type="range" min={min} max={max} step="0.02" value={edit[field]} onChange={event => update({ [field]: Number(event.target.value) })} /></label>)}
        <div className="flex flex-wrap gap-2">
          <button className={control} type="button" onClick={() => update({ rotation: ((edit.rotation + 90) % 360) as PhotoCellEdit["rotation"] })}><RotateCw size={16} aria-hidden /> Rotate {edit.rotation}°</button>
          <button className={`${control} aria-pressed:bg-accent/15 aria-pressed:text-accent`} type="button" aria-pressed={edit.mirror} onClick={() => update({ mirror: !edit.mirror })}><FlipHorizontal size={16} aria-hidden /> Mirror{edit.mirror ? " on" : " off"}</button>
          <button className={control} type="button" onClick={() => { const next = { ...editor.cellEdits }; delete next[selected.key]; change({ cellEdits: next }); }}>Reset crop</button>
        </div>
        <div className="flex flex-col gap-1.5 text-sm"><span className="font-bold">Filter for this slot</span>
          <Dropdown label="Filter for this slot" value={edit.filterId ?? "inherit"} disabled={controlsDisabled} onChange={value => update({ filterId: value === "inherit" ? null : value })} options={[{ value: "inherit", label: "Same as the strip" }, ...FILTERS.map(filter => ({ value: filter.id, label: filter.name }))]} />
        </div>
      </fieldset>
      {error && <p role="alert" className="text-sm font-bold text-destructive">{error}</p>}
    </div>
  </details>;
}
