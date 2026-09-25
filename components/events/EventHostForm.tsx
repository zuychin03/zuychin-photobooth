"use client";
import { useId } from "react";
import { Dropdown } from "@/components/Dropdown";
import type { EventCreateInput } from "@/lib/events/contract";
import { EVENT_FRAME_IDS, EVENT_FILTER_IDS, EVENT_SCENE_IDS, type EventLook } from "@/lib/events/host-contract";
import { getCuratedAsset } from "@/lib/assets/registry";
import { FRAMES } from "@/lib/decor";
import { FILTERS } from "@/lib/filters";
import { eventDateFromLocal, eventScheduleReview, localEventDate } from "@/lib/events/host-actions";
import { eventInput } from "./EventHostControls";

export function EventHostForm({ value, onChange, disabled, scheduleLocked = false }: { value: EventCreateInput; onChange(value: EventCreateInput): void; disabled: boolean; scheduleLocked?: boolean }) {
  const id = useId(), review = eventScheduleReview(value), change = <K extends keyof EventCreateInput>(key: K, next: EventCreateInput[K]) => onChange({ ...value, [key]: next });
  return <fieldset disabled={disabled} className="grid min-w-0 gap-4 sm:grid-cols-2">
    <legend className="sr-only">Event details</legend>
    <label className="block text-sm font-medium sm:col-span-2" htmlFor={`${id}-title`}>Event title<input id={`${id}-title`} className={`${eventInput} mt-2`} value={value.title} maxLength={100} required onChange={event => change("title", event.target.value)} /></label>
    <label className="block text-sm font-medium sm:col-span-2" htmlFor={`${id}-timezone`}>Event timezone<input id={`${id}-timezone`} className={`${eventInput} mt-2`} value={value.timezone} aria-invalid={!review} aria-describedby={`${id}-zone-hint`} disabled={disabled || scheduleLocked} required onChange={event => { const next = event.target.value; event.target.setCustomValidity(eventScheduleReview({ ...value, timezone: next }) ? "" : "Enter a valid named timezone."); change("timezone", next); }} /><span id={`${id}-zone-hint`} className="mt-1 block text-xs font-normal text-foreground/70">{!review ? "Enter a valid named timezone, such as Australia/Sydney." : `Dates below use your device’s timezone (${Intl.DateTimeFormat().resolvedOptions().timeZone}). Changing the event timezone does not shift these instants.`}</span></label>
    {([ ["startsAt", "Contributions start"], ["closesAt", "Contributions close"], ["expiresAt", "Photos expire"] ] as const).map(([key, label]) => <label key={key} className="block text-sm font-medium" htmlFor={`${id}-${key}`}>{label}<input id={`${id}-${key}`} type="datetime-local" className={`${eventInput} mt-2`} value={localEventDate(value[key])} disabled={disabled || scheduleLocked && key === "startsAt"} required onChange={event => { const date = eventDateFromLocal(event.target.value); if (date) change(key, date); }} /></label>)}
    <label className="block text-sm font-medium" htmlFor={`${id}-guests`}>Guest limit<input id={`${id}-guests`} type="number" min={1} max={25} className={`${eventInput} mt-2`} value={value.maxGuests} onChange={event => change("maxGuests", Number(event.target.value))} /></label>
    <label className="block text-sm font-medium" htmlFor={`${id}-contributions`}>Contribution limit<input id={`${id}-contributions`} type="number" min={1} max={100} className={`${eventInput} mt-2`} value={value.maxContributions} onChange={event => change("maxContributions", Number(event.target.value))} /></label>
    <label className="block text-sm font-medium" htmlFor={`${id}-storage`}>Storage budget (MB)<input id={`${id}-storage`} type="number" min={4.1} max={250} step={0.1} className={`${eventInput} mt-2`} value={value.maxBytes / 1000000} onChange={event => change("maxBytes", Math.round(Number(event.target.value) * 1000000))} /><span className="mt-1 block text-xs font-normal text-foreground/70">Budget includes temporary uploads and finished photos.</span></label>
    {review && <div className="rounded-xl bg-muted p-4 sm:col-span-2"><h4 className="text-sm font-semibold">Review in {value.timezone}</h4><dl className="mt-2 grid gap-2 text-sm">{["Contributions start", "Contributions close", "Photos expire"].map((label, index) => <div key={label} className="flex flex-wrap justify-between gap-x-4"><dt>{label}</dt><dd>{review[index]}</dd></div>)}</dl></div>}
  </fieldset>;
}
export function EventHostLook({ value, onChange, disabled }: { value: EventLook; onChange(value: EventLook): void; disabled: boolean }) {
  const id = useId(), asset = value.sceneId ? getCuratedAsset(value.sceneId) : null, frame = FRAMES.find(frame => frame.id === value.frameId)!;
  return <section className="grid gap-6 border-t border-border pt-6 md:grid-cols-[1fr_15rem]">
    <div className="space-y-4"><h3 className="font-display text-2xl">Event look</h3><p className="text-sm leading-relaxed text-foreground/70">The look and caption lock after the first accepted contribution. Photos already on guest devices stay unchanged.</p>
      <Dropdown label="Frame" showLabel disabled={disabled} value={value.frameId} options={EVENT_FRAME_IDS.map(id => ({ value: id, label: FRAMES.find(item => item.id === id)!.name }))} onChange={frameId => onChange({ ...value, frameId: frameId as EventLook["frameId"] })} />
      <Dropdown label="Photo filter" showLabel disabled={disabled} value={value.filterId} options={EVENT_FILTER_IDS.map(id => ({ value: id, label: FILTERS.find(item => item.id === id)!.name }))} onChange={filterId => onChange({ ...value, filterId: filterId as EventLook["filterId"] })} />
      <Dropdown label="Event scene" showLabel disabled={disabled} value={value.sceneId ?? "none"} options={[{ value: "none", label: "No scene" }, ...EVENT_SCENE_IDS.map(id => ({ value: id, label: getCuratedAsset(id)!.name }))]} onChange={sceneId => onChange({ ...value, sceneId: sceneId === "none" ? null : sceneId as EventLook["sceneId"] })} />
      <label htmlFor={`${id}-caption`} className="block text-sm font-medium">Default caption<input id={`${id}-caption`} className={`${eventInput} mt-2`} disabled={disabled} maxLength={320} value={value.caption} onChange={event => onChange({ ...value, caption: [...event.target.value].slice(0, 160).join("") })} /></label>
      <label className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" disabled={disabled} checked={value.showDate} onChange={event => onChange({ ...value, showDate: event.target.checked })} />Show event date by default</label>
    </div>
    <figure className="self-start rounded-sm p-3 shadow-sm" style={{ background: frame.color, color: frame.ink }}>
      <div role="img" aria-label={asset ? `${asset.name} event scene preview` : "Plain event frame preview"} className="aspect-[3/4] bg-cover bg-center" style={{ backgroundColor: asset?.fallback.colour ?? "#e7ddd2", backgroundImage: asset ? `url("${asset.thumbnail.path}")` : undefined }} />
      <figcaption className="mt-3 break-words text-center text-sm">{value.caption || "Your celebration"}</figcaption><p className="mt-2 text-center text-xs">Filters appear on guest photos.</p>
    </figure>
  </section>;
}
