"use client";

import { CaptureFeedbackSettings } from "./CaptureFeedbackSettings";
import type { CameraDevice } from "@/lib/camera";
import type { ProjectCaptureSettings } from "@/lib/projects/model";
import { Dropdown } from "@/components/Dropdown";

export function CaptureSettings({ value, cameras, disabled, onChange }: {
  value: ProjectCaptureSettings;
  cameras: readonly CameraDevice[];
  disabled: boolean;
  onChange(patch: Partial<ProjectCaptureSettings>): void;
}) {
  return <fieldset disabled={disabled} className="space-y-3 disabled:opacity-60">
    <legend className="mb-2 text-sm font-semibold">Capture settings</legend>
    <div className="grid grid-cols-2 gap-3">
      <div className="space-y-1 text-sm"><span>Booth style</span>
        <Dropdown label="Booth style" value={value.style} disabled={disabled} onChange={style => onChange({ style: style as ProjectCaptureSettings["style"] })} options={[{ value: "classic", label: "Classic" }, { value: "flexible", label: "Flexible" }]} />
      </div>
      <div className="space-y-1 text-sm"><span>Timer</span>
        <Dropdown label="Timer" value={String(value.timerSeconds)} disabled={disabled} onChange={timer => onChange({ timerSeconds: Number(timer) as 3 | 5 | 10 })} options={[3, 5, 10].map(seconds => ({ value: String(seconds), label: `${seconds} seconds` }))} />
      </div>
    </div>
    <p className="text-sm text-muted-foreground">{value.style === "classic" ? "Classic keeps each shot without retakes." : "Flexible lets you retake any shot."}</p>
    <div className="space-y-1 text-sm"><span>Camera</span>
      <Dropdown label="Camera" value={value.cameraId ?? ""} disabled={disabled} onChange={cameraId => onChange({ cameraId: cameraId || null })} options={[
        { value: "", label: "Default camera" },
        ...(value.cameraId && !cameras.some(camera => camera.id === value.cameraId) ? [{ value: value.cameraId, label: "Previously selected camera (unavailable)", disabled: true }] : []),
        ...cameras.filter(camera => camera.id).map(camera => ({ value: camera.id, label: camera.label })),
      ]} />
    </div>
    <div className="flex flex-wrap gap-x-5 gap-y-1">
      <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={value.mirror} onChange={event => onChange({ mirror: event.target.checked })} className="h-4 w-4 accent-accent" /> Mirror photo</label>
      <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={value.fillLight} onChange={event => onChange({ fillLight: event.target.checked })} className="h-4 w-4 accent-accent" /> Screen fill light</label>
    </div>
    <CaptureFeedbackSettings disabled={disabled} />
  </fieldset>;
}
