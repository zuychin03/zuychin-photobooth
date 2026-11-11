"use client";
import { useId } from "react";
import { Dropdown } from "@/components/Dropdown";
import type { EventCreateInput } from "@/lib/events/contract";
import { EVENT_FRAME_IDS, EVENT_FILTER_IDS, EVENT_SCENE_IDS, type EventLook } from "@/lib/events/host-contract";
import { getCuratedAsset } from "@/lib/assets/registry";
import { FRAMES } from "@/lib/decor";
import { FILTERS } from "@/lib/filters";
import { eventDateFromLocal, eventScheduleReview, localEventDate } from "@/lib/events/host-actions";
import { Palette } from "lucide-react";
import { EventPanelHead } from "./EventHostControls";

const label = "block text-sm font-bold", input = "field mt-1.5 font-medium", hint = "mt-1.5 block text-xs font-medium text-muted-foreground";

export function EventHostForm({ value, onChange, disabled, scheduleLocked = false }: { value: EventCreateInput; onChange(value: EventCreateInput): void; disabled: boolean; scheduleLocked?: boolean }) {
  const id = useId(), review = eventScheduleReview(value), change = <K extends keyof EventCreateInput>(key: K, next: EventCreateInput[K]) => onChange({ ...value, [key]: next });
  return <fieldset disabled={disabled} className="grid min-w-0 gap-4 sm:grid-cols-2">
    <legend className="sr-only">Event details</legend>
    <label className={`${label} sm:col-span-2`} htmlFor={`${id}-title`}>Event title<input id={`${id}-title`} className={input} value={value.title} maxLength={100} required onChange={event => change("title", event.target.value)} /></label>
    <label className={`${label} sm:col-span-2`} htmlFor={`${id}-timezone`}>Event timezone<input id={`${id}-timezone`} className={input} value={value.timezone} aria-invalid={!review} aria-describedby={`${id}-zone-hint`} disabled={disabled || scheduleLocked} required onChange={event => { const next = event.target.value; event.target.setCustomValidity(eventScheduleReview({ ...value, timezone: next }) ? "" : "Enter a timezone like Australia/Sydney."); change("timezone", next); }} /><span id={`${id}-zone-hint`} className={hint}>{!review ? "Enter a timezone like Australia/Sydney." : `Dates below are in your device's timezone (${Intl.DateTimeFormat().resolvedOptions().timeZone}).`}</span></label>
    {([ ["startsAt", "Uploads open"], ["closesAt", "Uploads close"], ["expiresAt", "Photos expire"] ] as const).map(([key, text]) => <label key={key} className={`${label} ${key === "expiresAt" ? "sm:col-span-2" : ""}`} htmlFor={`${id}-${key}`}>{text}<input id={`${id}-${key}`} type="datetime-local" className={input} value={localEventDate(value[key])} disabled={disabled || scheduleLocked && key === "startsAt"} required onChange={event => { const date = eventDateFromLocal(event.target.value); if (date) change(key, date); }} /></label>)}
    <div className="grid gap-4 sm:col-span-2 sm:grid-cols-3">
      <label className={label} htmlFor={`${id}-guests`}>Guest limit<input id={`${id}-guests`} type="number" min={1} max={25} className={input} value={value.maxGuests} onChange={event => change("maxGuests", Number(event.target.value))} /></label>
      <label className={label} htmlFor={`${id}-contributions`}>Photo limit<input id={`${id}-contributions`} type="number" min={1} max={100} className={input} value={value.maxContributions} onChange={event => change("maxContributions", Number(event.target.value))} /></label>
      <label className={label} htmlFor={`${id}-storage`}>Storage (MB)<input id={`${id}-storage`} type="number" min={4.1} max={250} step={0.1} className={input} value={value.maxBytes / 1000000} onChange={event => change("maxBytes", Math.round(Number(event.target.value) * 1000000))} /><span className={hint}>Includes uploads still in progress.</span></label>
    </div>
    {review && <div className="panel-muted p-4 sm:col-span-2"><h3 className="text-sm font-bold">Event times <span className="font-medium text-muted-foreground">({value.timezone})</span></h3><dl className="mt-2 grid gap-1.5 text-sm">{["Uploads open", "Uploads close", "Photos expire"].map((text, index) => <div key={text} className="flex flex-wrap justify-between gap-x-4"><dt className="text-muted-foreground">{text}</dt><dd className="font-bold tabular-nums">{review[index]}</dd></div>)}</dl></div>}
  </fieldset>;
}
export function EventHostLook({ value, onChange, disabled }: { value: EventLook; onChange(value: EventLook): void; disabled: boolean }) {
  const id = useId(), asset = value.sceneId ? getCuratedAsset(value.sceneId) : null, frame = FRAMES.find(frame => frame.id === value.frameId)!;
  return <section aria-labelledby={`${id}-look`} className="panel p-4 sm:p-6">
    <EventPanelHead id={`${id}-look`} icon={Palette} tone="rose">Event look</EventPanelHead>
    <div className="mt-4 grid gap-6 md:grid-cols-[minmax(0,1fr)_13rem]">
    <div className="space-y-4"><p className="text-sm text-muted-foreground">You can&apos;t change the look or caption after the first photo comes in.</p>
      <Dropdown label="Frame" showLabel disabled={disabled} value={value.frameId} options={EVENT_FRAME_IDS.map(id => ({ value: id, label: FRAMES.find(item => item.id === id)!.name }))} onChange={frameId => onChange({ ...value, frameId: frameId as EventLook["frameId"] })} />
      <Dropdown label="Photo filter" showLabel disabled={disabled} value={value.filterId} options={EVENT_FILTER_IDS.map(id => ({ value: id, label: FILTERS.find(item => item.id === id)!.name }))} onChange={filterId => onChange({ ...value, filterId: filterId as EventLook["filterId"] })} />
      <Dropdown label="Event scene" showLabel disabled={disabled} value={value.sceneId ?? "none"} options={[{ value: "none", label: "No scene" }, ...EVENT_SCENE_IDS.map(id => ({ value: id, label: getCuratedAsset(id)!.name }))]} onChange={sceneId => onChange({ ...value, sceneId: sceneId === "none" ? null : sceneId as EventLook["sceneId"] })} />
      <label htmlFor={`${id}-caption`} className={label}>Default caption<input id={`${id}-caption`} className={input} disabled={disabled} maxLength={320} value={value.caption} onChange={event => onChange({ ...value, caption: [...event.target.value].slice(0, 160).join("") })} /></label>
      <label className="panel-muted flex min-h-12 cursor-pointer items-center gap-3 px-4 py-3 text-sm font-bold"><input type="checkbox" className="size-5 shrink-0 accent-accent" disabled={disabled} checked={value.showDate} onChange={event => onChange({ ...value, showDate: event.target.checked })} />Show event date by default</label>
    </div>
    <figure className="w-[min(100%,13rem,24dvh)] justify-self-center self-start rounded-md p-3 shadow-[0_14px_32px_-16px_rgb(0_0_0/0.45)] md:w-full md:rotate-[-1.5deg]" style={{ background: frame.color, color: frame.ink }}>
      <div role="img" aria-label={asset ? `${asset.name} event scene preview` : "Plain event frame preview"} className="aspect-[3/4] rounded-[2px] bg-cover bg-center" style={{ backgroundColor: asset?.fallback.colour ?? "#e7ddd2", backgroundImage: asset ? `url("${asset.thumbnail.path}")` : undefined }} />
      <figcaption className="mt-3 break-words text-center text-sm">{value.caption || "Your celebration"}</figcaption><p className="mt-2 text-center text-xs opacity-75">Filters appear on guest photos.</p>
    </figure>
    </div>
  </section>;
}
