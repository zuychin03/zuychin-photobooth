"use client";

import { CaptureFeedbackSettings, settingRow, switchTrack } from "./CaptureFeedbackSettings";
import type { CameraDevice } from "@/lib/camera";
import type { ProjectCaptureSettings } from "@/lib/projects/model";
import { Dropdown } from "@/components/Dropdown";

const group = "panel px-4 pt-3 pb-1.5 sm:px-5";

export function CaptureSettings({ value, cameras, disabled, onChange }: {
  value: ProjectCaptureSettings;
  cameras: readonly CameraDevice[];
  disabled: boolean;
  onChange(patch: Partial<ProjectCaptureSettings>): void;
}) {
  return <>
    <fieldset disabled={disabled} className={`${group} disabled:opacity-60`}>
      <legend className="float-left w-full pb-1 font-display text-[1.0625rem]">Capture</legend>
      <div className="clear-both divide-y divide-border text-[0.9375rem]">
        <div className="py-3">
          <div className="flex items-center justify-between gap-3">
            <span>Style</span>
            <div role="group" aria-label="Booth style" className="segmented">
              {(["classic", "flexible"] as const).map(style => <button key={style} type="button" aria-pressed={value.style === style} onClick={() => { if (value.style !== style) onChange({ style }); }}>{style === "classic" ? "Classic" : "Flexible"}</button>)}
            </div>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">{value.style === "classic" ? "Opens the editor after the last shot." : "Stays here so you can review your shots."}</p>
        </div>
        <div className="flex items-center justify-between gap-3 py-3">
          <span>Timer</span>
          <div role="group" aria-label="Timer" className="segmented">
            {([3, 5, 10] as const).map(seconds => <button key={seconds} type="button" aria-pressed={value.timerSeconds === seconds} onClick={() => { if (value.timerSeconds !== seconds) onChange({ timerSeconds: seconds }); }} className="tabular-nums"><span aria-hidden>{seconds}s</span><span className="sr-only">{seconds} seconds</span></button>)}
          </div>
        </div>
        <div className="py-3">
          <Dropdown label="Camera" showLabel value={value.cameraId ?? ""} disabled={disabled} onChange={cameraId => onChange({ cameraId: cameraId || null })} options={[
            { value: "", label: "Default camera" },
            ...(value.cameraId && !cameras.some(camera => camera.id === value.cameraId) ? [{ value: value.cameraId, label: "Last used camera (not connected)", disabled: true }] : []),
            ...cameras.filter(camera => camera.id).map(camera => ({ value: camera.id, label: camera.label })),
          ]} />
        </div>
        <label className={settingRow}><span>Mirror photo</span><input type="checkbox" checked={value.mirror} onChange={event => onChange({ mirror: event.target.checked })} className="peer sr-only" /><span aria-hidden className={switchTrack} /></label>
        <label className={settingRow}><span>Screen fill light</span><input type="checkbox" checked={value.fillLight} onChange={event => onChange({ fillLight: event.target.checked })} className="peer sr-only" /><span aria-hidden className={switchTrack} /></label>
      </div>
    </fieldset>
    <CaptureFeedbackSettings disabled={disabled} className={group} />
  </>;
}
