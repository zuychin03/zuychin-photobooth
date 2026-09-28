"use client";
import { useRecoveryRelease } from "@/components/ReleaseMode";
import { useEffect, useRef, useState } from "react";
import type { EventHostClient } from "@/lib/events/client";
import { EVENT_MISSIONS, type EventMissionSettings } from "@/lib/events/guestbook-contract";
import { prepareEventMissionEdit } from "@/lib/events/mission-edit";
import { eventDateFromLocal, localEventDate } from "@/lib/events/host-actions";
import { EventHostConfirm, eventControl, eventInput, useEventLeaveWarning } from "./EventHostControls";
import { useEventHostTask } from "./useEventHostTask";

export function EventHostGuestbookPanel({ client, eventId, owner, startsAt, closesAt, timezone, disabled = false, onBusyChange, onDirtyChange }: { client: EventHostClient; eventId: string; owner: boolean; startsAt: string; closesAt: string; timezone: string; disabled?: boolean; onBusyChange?(value: boolean): void; onDirtyChange?(value: boolean): void }) {
  const recovery = useRecoveryRelease();
  const task = useEventHostTask(client), [settings, setSettings] = useState<EventMissionSettings | null>(null), [ids, setIds] = useState<string[]>([]), [end, setEnd] = useState(""), [available, setAvailable] = useState<boolean | null>(null), [page, setPage] = useState<Awaited<ReturnType<EventHostClient["guestbook"]>> | null>(null), [pending, setPending] = useState<ReturnType<typeof prepareEventMissionEdit> | null>(null), [notice, setNotice] = useState<string | null>(null), [confirm, setConfirm] = useState<{ kind: "reload" | "discard"; focus: HTMLElement | null } | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const focusHeading = () => requestAnimationFrame(() => heading.current?.focus());
  const dirty = !!pending || !!settings && (JSON.stringify(ids) !== JSON.stringify(settings.missionIds) || end !== settings.endsAt), blocked = disabled || task.busy || task.lost || !!confirm;
  useEventLeaveWarning(dirty);
  useEffect(() => { onBusyChange?.(task.busy); }, [task.busy, onBusyChange]);
  useEffect(() => { onDirtyChange?.(!task.lost && (dirty || !!confirm)); }, [dirty, confirm, task.lost, onDirtyChange]);
  useEffect(() => () => { onBusyChange?.(false); onDirtyChange?.(false); }, [onBusyChange, onDirtyChange]);
  const adopt = (value: EventMissionSettings) => { setSettings(value); setIds(value.missionIds); setEnd(value.endsAt); };
  const load = () => { if (disabled || task.isBusy()) return; setNotice(null); setPage(null); void task.run(async (signal, check) => { const caps = await client.capabilities(signal); check(); setAvailable(caps.guestbookVersion === 1); if (caps.guestbookVersion !== 1) return; const next = await client.missions(eventId, signal); check(); adopt(next); setPending(null); setConfirm(null); focusHeading(); }); };
  const browse = (after?: string) => { if (blocked || dirty) return; setPage(null); setNotice(null); void task.run(async (signal, check) => { const next = await client.guestbook(eventId, { limit: 25, after }, signal); check(); setPage(next); focusHeading(); }); };
  const save = () => { if (blocked || !settings || !owner) return; setNotice(null); let request = pending; try { request ??= prepareEventMissionEdit(settings, ids, end, { startsAt, closesAt }); } catch { task.setError("Choose up to six poses and an end time within the upload dates."); return; } const frozen = request; setPending(frozen); void task.run(async (signal, check) => { const next = await client.saveMissions(eventId, frozen, signal); check(); adopt(next); setPending(null); setNotice("Missions saved."); focusHeading(); }); };
  let review = "Enter a valid end time."; try { if (end) review = new Intl.DateTimeFormat("en-AU", { dateStyle: "medium", timeStyle: "short", timeZone: timezone }).format(new Date(end)); } catch {}
  return <section className="border-t border-border py-7"><h3 ref={heading} tabIndex={-1} className="font-display text-2xl outline-none">Pose missions and guestbook</h3><p className="mt-3 max-w-2xl text-sm leading-relaxed text-foreground/70">Guests can try the poses if they like. Guestbook messages are private.</p>
    {task.error && <p role="alert" className="mt-4 text-sm">{task.error}</p>}{notice && <p role="status" className="mt-4 text-sm">{notice}</p>}
    {task.lost ? <p className="mt-4 text-sm">Your access changed. Reopen this event.</p> : <div inert={!!confirm}>
      <button className={`${eventControl} mt-4 border border-border`} disabled={blocked} onClick={() => dirty ? setConfirm({ kind: "reload", focus: document.activeElement as HTMLElement }) : load()}>{settings ? "Refresh missions" : "Load missions and guestbook"}</button>
      {dirty && <button className={`${eventControl} mt-4`} disabled={blocked} onClick={() => setConfirm({ kind: "discard", focus: document.activeElement as HTMLElement })}>Discard changes</button>}
      {available === false && <p className="mt-3 text-sm">Missions and the guestbook aren&apos;t available for this event.</p>}
      {settings && available && <><p className="mt-4 text-sm">{settings.locked ? "Missions are locked now that photos have come in." : owner ? "Choose up to six poses before the first photo comes in." : "Only the event owner can change missions."}</p>
        <fieldset className="mt-4 space-y-3" disabled={recovery || blocked || !!pending || settings.locked || !owner}><legend className="sr-only">Poses</legend>{EVENT_MISSIONS.map(mission => <label key={mission.id} className="flex min-h-11 items-start gap-3 text-sm"><input type="checkbox" className="mt-1 size-5 shrink-0 accent-accent" checked={ids.includes(mission.id)} onChange={e => setIds(current => e.target.checked ? [...current, mission.id] : current.filter(id => id !== mission.id))} /><span>{mission.label}</span></label>)}<label className="block text-sm">Missions end (your timezone)<input type="datetime-local" className={`${eventInput} mt-2 max-w-sm`} value={localEventDate(end)} onChange={e => { const value = eventDateFromLocal(e.target.value); if (value) setEnd(value); }} /></label></fieldset><p className="mt-3 text-sm">In {timezone}: {review}.</p>
        {owner && <button className={`${eventControl} mt-4 border border-border`} disabled={recovery || blocked || !dirty || settings.locked && !pending} onClick={save}>{pending ? "Try again" : "Save missions"}</button>}
        {pending && <p className="mt-3 text-sm">These may have already saved. Try again, or refresh to check.</p>}
        <div className="mt-6 flex flex-wrap gap-2"><button className={`${eventControl} border border-border`} disabled={blocked || dirty} onClick={() => browse()}>Load guestbook</button>{page?.nextCursor && <button className={`${eventControl} border border-border`} disabled={blocked || dirty} onClick={() => browse(page.nextCursor!)}>Next page</button>}</div>
        {page && <>{!page.entries.length ? <p className="mt-4 text-sm">No messages yet.</p> : <ul className="mt-4 divide-y divide-border">{page.entries.map(entry => <li key={entry.submissionId} className="py-4"><p className="break-all font-mono text-xs">{entry.submissionId}</p>{!entry.note ? <p className="mt-2 text-sm">This photo isn&apos;t available anymore.</p> : <><p className="mt-2 whitespace-pre-wrap text-sm">{entry.note.withdrawn ? "Message withdrawn." : entry.note.message || "No message."}</p>{entry.note.signature && <p className="mt-2 text-sm">{entry.note.signature}</p>}{entry.note.mission && <p className="mt-2 text-sm text-foreground/70">{entry.note.mission.label} {entry.note.missionCompleted ? "Done." : "Waiting for the photo."}</p>}</>}</li>)}</ul>}</>}
      </>}
    </div>}
    {confirm && <EventHostConfirm title="Discard your changes?" action={confirm.kind === "discard" ? "Discard" : "Refresh"} returnFocus={confirm.focus} busy={task.busy} onKeep={() => setConfirm(null)} onConfirm={() => { if (confirm.kind === "reload") load(); else { if (settings) adopt(settings); setPending(null); setConfirm(null); setNotice("Changes discarded."); } }}><p>Your unsaved choices will be lost.</p></EventHostConfirm>}
  </section>;
}
