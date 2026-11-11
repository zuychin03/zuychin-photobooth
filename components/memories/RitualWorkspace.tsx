"use client";

import { useAppNavigationGuard } from "@/components/AppNavigation";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { BellRing, CalendarHeart, ChevronRight, Clock, LoaderCircle, Mail, Plus, RefreshCw, Unlink } from "lucide-react";
import { Dropdown } from "@/components/Dropdown";
import type { RitualClient } from "@/lib/memories/ritual-client";
import type { RitualChannels, RitualPage, RitualRow } from "@/lib/memories/ritual-contract";
import { reviewRitual, ritualError, ritualFields, ritualInstant, type RitualFields, type RitualReview } from "@/lib/memories/ritual-editor";

type Editor = { id: string; row?: RitualRow };
const secondary = "btn btn-quiet min-h-10 text-sm";
const primary = "btn btn-primary min-h-10 text-sm";
const plain = "btn btn-plain min-h-10 text-sm";
const toggle = "relative h-7 w-12 shrink-0 cursor-pointer appearance-none rounded-full bg-[color-mix(in_srgb,var(--foreground)_16%,transparent)] transition-colors duration-200 checked:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50 before:absolute before:top-0.5 before:left-0.5 before:size-6 before:rounded-full before:bg-white before:shadow-[0_2px_6px_rgb(0_0_0/0.25)] before:transition-transform before:duration-300 before:ease-[var(--spring-bounce)] checked:before:translate-x-5 motion-reduce:before:transition-none";
const cadence = [{ value: "once", label: "Once" }, { value: "weekly", label: "Weekly" }, { value: "monthly", label: "Monthly" }, { value: "yearly", label: "Yearly" }];
const adjustmentText = { "date-clamp": "This month is shorter, so the reminder moves to its last day.", "gap-shift": "Daylight saving skips this time, so the reminder moves forward.", "fold-earlier": "This time happens twice because of daylight saving. Using the first one.", "fold-later": "This time happens twice because of daylight saving. Using the second one." };

function RitualEditor({ editor, busy, stale, onCancel, onRefresh, onSave }: { editor: Editor; busy: boolean; stale: boolean; onCancel(): void; onRefresh(): void; onSave(review: RitualReview): Promise<boolean> }) {
  const id = useId(), heading = useRef<HTMLHeadingElement>(null);
  const [fields, setFields] = useState(() => ritualFields(editor.row)), [review, setReview] = useState<RitualReview | null>(null), [error, setError] = useState<string | null>(null), [attempted, setAttempted] = useState(false);
  useEffect(() => { heading.current?.focus(); }, [review]);
  const change = <K extends keyof RitualFields>(key: K, value: RitualFields[K]) => setFields(previous => ({ ...previous, [key]: value }));
  const prepare = () => {
    try { setReview(reviewRitual(fields, new Date().toISOString(), editor.row)); setError(null); }
    catch (failure) { setError(failure instanceof Error && !failure.message.startsWith("Invalid") ? failure.message : "Enter a title, a date and time, and a timezone like Australia/Sydney."); }
  };
  const title = editor.row?.legacy ? "Update your reminder" : editor.row ? "Edit ritual" : "New ritual";
  return <section aria-labelledby={`${id}-title`} className="panel-muted mx-4 mt-4 p-4 sm:mx-6 sm:p-5">
    <h3 ref={heading} tabIndex={-1} id={`${id}-title`} className="font-display text-lg leading-tight outline-none">{review ? "Check the details" : title}</h3>
    {editor.row?.legacy && <p className="mt-2 text-sm text-muted-foreground">This older reminder has no timezone. The next one is {ritualInstant(editor.row.scheduledAt, "UTC")}. Choose a timezone for future reminders.</p>}
    {!review ? <form className="mt-4 space-y-4" onSubmit={event => { event.preventDefault(); prepare(); }}>
      <fieldset disabled={busy || stale} className="space-y-4 disabled:opacity-60">
        <label className="block text-sm font-bold" htmlFor={`${id}-name`}>Ritual name<input id={`${id}-name`} className="field mt-1.5 font-medium" value={fields.title} onChange={event => change("title", event.target.value)} maxLength={200} required placeholder="Our Sunday photo" /></label>
        <div className="grid min-w-0 gap-4 sm:grid-cols-2">
          <label className="block min-w-0 text-sm font-bold" htmlFor={`${id}-date`}>Start date<input id={`${id}-date`} type="date" min="1970-01-01" max="2199-12-31" className="field mt-1.5 min-w-0 font-medium" value={fields.date} onInput={event => change("date", event.currentTarget.value)} onChange={event => change("date", event.target.value)} required /></label>
          <label className="block min-w-0 text-sm font-bold" htmlFor={`${id}-time`}>Time<input id={`${id}-time`} type="time" className="field mt-1.5 min-w-0 font-medium" value={fields.time} onInput={event => change("time", event.currentTarget.value)} onChange={event => change("time", event.target.value)} required /></label>
        </div>
        <div><label className="block text-sm font-bold" htmlFor={`${id}-zone`}>Timezone<input id={`${id}-zone`} className="field mt-1.5 font-medium" value={fields.zone} onChange={event => change("zone", event.target.value)} maxLength={100} required autoCapitalize="none" spellCheck={false} aria-describedby={`${id}-zone-help`} /></label>
        <p id={`${id}-zone-help`} className="mt-1.5 text-sm text-muted-foreground">Like Australia/Sydney or Asia/Ho_Chi_Minh. It stays the same when you travel.</p></div>
        <div className="grid gap-4 sm:grid-cols-2"><Dropdown label="Repeat" showLabel value={fields.frequency} options={cadence} onChange={value => change("frequency", value as RitualFields["frequency"])} disabled={busy || stale} />{fields.frequency !== "once" && <Dropdown label="How often" showLabel value={fields.interval} options={Array.from({ length: 12 }, (_, index) => ({ value: String(index + 1), label: `Every ${index + 1} ${fields.frequency === "weekly" ? "week" : fields.frequency === "monthly" ? "month" : "year"}${index ? "s" : ""}` }))} onChange={value => change("interval", value)} disabled={busy || stale} />}</div>
        <details className="group text-sm"><summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-xl font-bold focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden"><ChevronRight size={16} aria-hidden className="text-muted-foreground transition-transform duration-300 ease-[var(--spring-soft)] group-open:rotate-90 motion-reduce:transition-none" />Daylight saving and short months</summary><div className="mt-2 grid gap-4 sm:grid-cols-2">
          {(fields.frequency === "monthly" || fields.frequency === "yearly") && <Dropdown label="If the month is too short" showLabel value={fields.invalidDate} options={[{ value: "clamp", label: "Use the last day of that month" }, { value: "skip", label: "Skip that date" }]} onChange={value => change("invalidDate", value as RitualFields["invalidDate"])} disabled={busy || stale} />}
          <Dropdown label="If clocks jump past this time" showLabel value={fields.gap} options={[{ value: "shift-forward", label: "Move it forward" }, { value: "skip", label: "Skip that date" }]} onChange={value => change("gap", value as RitualFields["gap"])} disabled={busy || stale} />
          <Dropdown label="If clocks go back over this time" showLabel value={fields.fold} options={[{ value: "later", label: "Use the second one" }, { value: "earlier", label: "Use the first one" }]} onChange={value => change("fold", value as RitualFields["fold"])} disabled={busy || stale} />
        </div></details>
      </fieldset>
      {error && <p role="alert" className="notice border border-destructive/25 bg-destructive/8 font-bold text-destructive">{error}</p>}
      <div className="flex flex-wrap gap-2"><button type="submit" disabled={busy || stale} className={primary}>Review schedule</button><button type="button" disabled={busy} className={secondary} onClick={onCancel}>Cancel</button></div>
    </form> : <div className="mt-4">
      <p className="break-words text-lg font-bold">{review.input.title}</p>
      <dl className="mt-3 grid gap-px overflow-hidden rounded-2xl bg-border text-sm sm:grid-cols-3"><div className="bg-card p-3.5"><dt className="text-muted-foreground">Next reminder in {review.input.schedule.timeZone}</dt><dd className="mt-1 font-bold">{ritualInstant(review.occurrence.instant, review.input.schedule.timeZone)}</dd></div><div className="bg-card p-3.5"><dt className="text-muted-foreground">In UTC</dt><dd className="mt-1">{ritualInstant(review.occurrence.instant, "UTC")}</dd></div><div className="bg-card p-3.5"><dt className="text-muted-foreground">Repeat</dt><dd className="mt-1">{review.input.schedule.frequency === "once" ? "Once" : `Every ${review.input.schedule.interval} ${review.input.schedule.frequency === "weekly" ? "week(s)" : review.input.schedule.frequency === "monthly" ? "month(s)" : "year(s)"}, starting ${review.input.schedule.anchorDate}`}</dd></div></dl>
      {review.adjustments.map(value => <p key={value} className="mt-3 text-sm font-bold text-warning">{adjustmentText[value]}</p>)}
      <p className="mt-3 text-sm text-muted-foreground">You and your partner each choose how you get reminders.</p>
      {editor.row?.paused && <p className="mt-3 text-sm font-bold">This ritual will stay paused after editing.</p>}
      {attempted && <p className="mt-3 text-sm">Refresh, then try again.</p>}
      <div className="mt-4 flex flex-wrap gap-2"><button disabled={busy || stale} className={primary} onClick={() => { setAttempted(true); void onSave(review); }}>{attempted ? "Try again" : editor.row?.legacy ? "Save" : "Save ritual"}</button>{!attempted && <button disabled={busy} className={secondary} onClick={() => setReview(null)}>Edit details</button>}{stale && <button disabled={busy} className={secondary} onClick={onRefresh}>Refresh</button>}<button disabled={busy} className={plain} onClick={onCancel}>Cancel</button></div>
    </div>}
  </section>;
}

function Channels({ row, busy, onSave, onCancel }: { row: RitualRow; busy: boolean; onSave(channels: RitualChannels): void; onCancel(): void }) {
  const [channels, setChannels] = useState(row.channels);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => { first.current?.focus(); }, []);
  return <form className="panel-muted mt-4 p-4" onSubmit={event => { event.preventDefault(); onSave(channels); }}><fieldset disabled={busy}><legend className="font-bold">How you get reminders</legend><p className="mt-1 text-sm text-muted-foreground">Just for you. Push reminders also need notifications turned on for this device.</p><div className="mt-3 divide-y divide-border overflow-hidden rounded-2xl bg-card">{(["email", "push"] as const).map(channel => <label key={channel} className="flex min-h-13 cursor-pointer items-center justify-between gap-3 px-4 py-2.5 text-sm font-bold"><span className="flex items-center gap-2.5">{channel === "email" ? <Mail size={16} className="text-muted-foreground" aria-hidden /> : <BellRing size={16} className="text-muted-foreground" aria-hidden />}{channel === "email" ? "Email me" : "Send me push reminders"}</span><input ref={channel === "email" ? first : undefined} type="checkbox" className={toggle} checked={channels[channel]} onChange={event => setChannels(previous => ({ ...previous, [channel]: event.target.checked }))} /></label>)}</div></fieldset><div className="mt-3 flex flex-wrap gap-2"><button disabled={busy} className={primary}>Save</button><button type="button" disabled={busy} className={secondary} onClick={onCancel}>Cancel</button></div></form>;
}

export function RitualWorkspace({ client, coupleId }: { client: RitualClient; coupleId: string }) {
  const [page, setPage] = useState<RitualPage | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [note, setNote] = useState<string | null>(null), [stale, setStale] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(null), [channelsId, setChannelsId] = useState<string | null>(null), [deleteId, setDeleteId] = useState<string | null>(null);
  const [accessLost, setAccessLost] = useState(false);
  useAppNavigationGuard(() => {
    if (busy || editor || channelsId || deleteId) { setNote("Save or cancel the reminder before you leave."); return false; }
    return true;
  });
  const active = useRef(true), work = useRef<AbortController | null>(null), heading = useRef<HTMLHeadingElement>(null);
  const deleteButton = useRef<HTMLButtonElement>(null), lostHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (deleteId) deleteButton.current?.focus(); }, [deleteId]);
  useEffect(() => { if (accessLost) lostHeading.current?.focus(); }, [accessLost]);
  const loseAccess = () => { setAccessLost(true); setPage(null); setEditor(null); setChannelsId(null); setDeleteId(null); setNote(null); setStale(true); };
  const run = async (operation: (signal: AbortSignal) => Promise<void>, mutation = false) => {
    if (work.current || !active.current) return false;
    const controller = new AbortController(); work.current = controller; setBusy(true); setError(null); setNote(null);
    try { await operation(controller.signal); client.assertActive(controller.signal); return true; }
    catch (failure) { if (active.current) { setError(ritualError(failure)); if (failure && typeof failure === "object" && "code" in failure && (failure.code === "access_denied" || failure.code === "account_changed")) loseAccess(); else if (mutation) setStale(true); } return false; }
    finally { if (work.current === controller) work.current = null; if (active.current) setBusy(false); }
  };
  const refresh = (after?: string) => run(async signal => {
    const next = await client.list(coupleId, after, 20, signal); client.assertActive(signal); if (!active.current) return;
    setPage(next); setStale(false); setChannelsId(null); setDeleteId(null);
    if (editor?.row) { setEditor(null); setNote("Refreshed. Open the reminder again to keep editing."); }
  });
  useEffect(() => {
    active.current = true; const controller = new AbortController(); work.current = controller;
    void client.list(coupleId, undefined, 20, controller.signal).then(next => { client.assertActive(controller.signal); if (active.current) setPage(next); }).catch(failure => { if (!controller.signal.aborted && active.current) { setError(ritualError(failure)); if (failure && typeof failure === "object" && "code" in failure && (failure.code === "access_denied" || failure.code === "account_changed")) loseAccess(); } }).finally(() => { if (work.current === controller) work.current = null; });
    return () => { active.current = false; work.current?.abort(); };
  }, [client, coupleId]);
  const changed = (row: RitualRow, message: string) => { setPage(previous => previous && ({ ...previous, items: previous.items.map(item => item.id === row.id ? row : item) })); setNote(message); setChannelsId(null); setDeleteId(null); heading.current?.focus(); };
  const save = (review: RitualReview) => run(async signal => {
    if (!editor) return;
    const row = editor.row?.legacy ? await client.upgrade(coupleId, editor.id, editor.row.scheduledAt, review.input, signal) : editor.row ? await client.edit(coupleId, editor.id, editor.row.revision, review.input, signal) : await client.create(coupleId, { id: editor.id, ...review.input }, signal);
    client.assertActive(signal); if (!active.current) return;
    setPage(previous => ({ version: 1, items: [row, ...(previous?.items.filter(item => item.id !== row.id) ?? [])].slice(0, 20), nextCursor: null }));
    setEditor(null); setStale(true); setNote("Ritual saved. Refresh to see it in the list."); heading.current?.focus();
  }, true);
  const locked = busy || stale || Boolean(editor) || !page;
  if (accessLost) return <section className="panel flex min-h-64 flex-col items-center justify-center gap-4 px-6 py-12 text-center"><span className="glyph size-14 rounded-2xl bg-[#8b5cf6]"><Unlink size={26} aria-hidden /></span><h2 ref={lostHeading} tabIndex={-1} className="font-display text-2xl outline-none">You&apos;re no longer paired</h2><p role="alert" className="text-sm text-muted-foreground">Check your pairing in your album.</p><Link href="/timeline" className="btn btn-primary">Open album</Link></section>;
  return <section className="panel overflow-hidden pb-2 sm:pb-3" aria-labelledby="rituals-heading">
    <div className="flex flex-wrap items-center justify-between gap-3 px-4 pt-4 sm:px-6 sm:pt-6"><div className="flex min-w-0 items-center gap-3"><span className="glyph bg-[#f59e0b]"><CalendarHeart size={18} strokeWidth={2.25} aria-hidden /></span><h2 id="rituals-heading" ref={heading} tabIndex={-1} className="font-display text-xl leading-tight outline-none">Your rituals</h2></div><div className="flex flex-wrap gap-2"><button className={plain} disabled={busy} onClick={() => void refresh()}><RefreshCw size={15} aria-hidden /> Refresh</button><button className={primary} disabled={locked || Boolean(channelsId || deleteId)} onClick={() => setEditor({ id: crypto.randomUUID() })}><Plus size={17} aria-hidden /> New ritual</button></div></div>
    <div className="space-y-3 px-4 pt-4 empty:hidden sm:px-6">
      {busy && <p role="status" className="flex items-center gap-2 text-sm font-bold"><LoaderCircle size={16} aria-hidden className="animate-spin text-accent motion-reduce:animate-none" /> Working…</p>}
      {error && <p role="alert" className="notice border border-destructive/25 bg-destructive/8 font-bold text-destructive">{error}</p>}
      {note && <p role="status" className="notice">{note}</p>}
      {stale && <p className="text-sm font-bold text-warning">Refresh before making another change.</p>}
    </div>
    {editor && <RitualEditor key={editor.id} editor={editor} busy={busy} stale={stale} onCancel={() => { setEditor(null); heading.current?.focus(); }} onRefresh={() => void refresh()} onSave={save} />}
    {!page && !error ? <p role="status" className="flex min-h-40 items-center justify-center gap-2 px-4 text-sm text-muted-foreground"><LoaderCircle size={16} aria-hidden className="animate-spin motion-reduce:animate-none" /> Loading your reminders…</p> : page?.items.length === 0 ? <div className="mx-4 mt-4 mb-2 flex flex-col items-center rounded-2xl bg-muted/50 px-6 py-10 text-center sm:mx-6 sm:mb-3"><CalendarHeart size={28} aria-hidden className="text-accent" /><h3 className="mt-3 font-display text-xl">No rituals yet</h3><p className="mt-1 max-w-sm text-sm text-muted-foreground">Add a photo date, weekly catch-up or yearly tradition.</p></div> : <ul className="mt-4 divide-y divide-border border-t border-border">{page?.items.map(row => {
      const mine = row.creatorId === client.ownerId, trouble = row.delivery?.status === "failed" || row.delivery?.status === "uncertain";
      return <li key={row.id} className="px-4 py-5 sm:px-6"><div className="flex flex-wrap items-start justify-between gap-3"><h3 className="min-w-0 max-w-2xl break-words text-lg font-bold [overflow-wrap:anywhere]">{row.title}</h3><span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-bold ${row.legacy ? "bg-muted text-muted-foreground" : trouble ? "bg-destructive/12 text-destructive" : row.paused ? "bg-warning/15 text-warning" : row.enabled ? "bg-success/15 text-success" : "bg-muted text-muted-foreground"}`}>{row.legacy ? "Older reminder" : trouble ? "Delivery problem" : row.paused ? "Paused" : row.enabled ? "Scheduled" : "Finished"}</span></div>
        <p className="mt-1.5 flex items-start gap-2 text-sm"><Clock size={15} aria-hidden className="mt-0.5 shrink-0 text-muted-foreground" /><span>{row.legacy ? `${row.active ? "Next" : "Last scheduled"}: ${ritualInstant(row.scheduledAt, "UTC")}. No timezone set.` : row.next ? `${row.paused || trouble ? "Scheduled for" : "Next"}: ${ritualInstant(row.next.instant, row.schedule!.timeZone)} (${row.schedule!.timeZone}).` : "Nothing coming up."}</span></p>
        {row.legacy ? <p className="mt-1.5 text-sm text-muted-foreground">{mine ? "Update it to set a timezone and use the newer options." : "Whoever made it can update it."}</p> : <>
          <p className="mt-1.5 text-sm text-muted-foreground">Your reminders: {row.channels.email ? "email on" : "email off"}, {row.channels.push ? "push on" : "push off"}.</p>
          {row.delivery?.status === "pending" && <p className="mt-1.5 text-sm">Waiting to send.</p>}{row.delivery?.status === "retrying" && <p className="mt-1.5 text-sm">Trying to send again ({row.delivery.attempts} of 5).</p>}
          {trouble && <p className="notice mt-3 font-bold">{row.delivery?.status === "uncertain" ? "A reminder may have been sent, but we couldn't confirm it." : "Sending failed."} Reminders are paused. {mine ? "Resume it or edit the ritual." : "Whoever made it can resume it."}</p>}
        </>}
        <div className="mt-3 flex flex-wrap gap-1.5">
          {mine && <button className={secondary} disabled={locked || Boolean(channelsId || deleteId)} onClick={() => setEditor({ id: row.id, row })}>{row.legacy ? "Update" : "Edit schedule"}</button>}
          {mine && !row.legacy && <button className={secondary} disabled={locked || Boolean(channelsId || deleteId)} onClick={() => void run(async signal => { const next = row.paused || !row.enabled ? await client.resume(coupleId, row.id, row.revision, signal) : await client.pause(coupleId, row.id, row.revision, signal); client.assertActive(signal); if (active.current) changed(next, next.paused ? "Ritual paused." : next.enabled ? "Ritual resumed. Missed reminders won't be sent." : "Nothing is coming up. Edit the date to schedule another."); }, true)}>{row.paused || !row.enabled ? "Resume" : "Pause"}</button>}
          {!row.legacy && <button className={secondary} disabled={locked || Boolean(channelsId || deleteId)} onClick={() => setChannelsId(row.id)}>My reminders</button>}
          {mine && <button className={`${plain} text-destructive`} disabled={locked || Boolean(channelsId || deleteId)} onClick={() => setDeleteId(row.id)}>Delete ritual</button>}
        </div>
        {channelsId === row.id && <Channels key={`${row.id}-${row.revision}`} row={row} busy={busy || stale} onCancel={() => setChannelsId(null)} onSave={channels => void run(async signal => { const next = await client.setChannels(coupleId, row.id, row.revision, channels, signal); client.assertActive(signal); if (active.current) changed(next, "Your reminder settings were saved."); }, true)} />}
        {deleteId === row.id && <div className="notice mt-4"><p className="font-bold">Delete this ritual for both of you?</p><p className="mt-1 text-muted-foreground">Reminders will stop for both of you. Your photos aren&apos;t affected.</p><div className="mt-3 flex flex-wrap gap-2"><button ref={deleteButton} className="btn btn-danger min-h-10 text-sm" disabled={busy || stale} onClick={() => void run(async signal => { await client.delete(coupleId, row.id, row.revision, signal); client.assertActive(signal); if (active.current) { setPage(previous => previous && ({ ...previous, items: previous.items.filter(item => item.id !== row.id) })); setDeleteId(null); setNote("Ritual deleted."); heading.current?.focus(); } }, true)}>Delete</button><button className={secondary} disabled={busy} onClick={() => setDeleteId(null)}>Cancel</button></div></div>}
      </li>;
    })}</ul>}
    {page?.nextCursor && <div className="border-t border-border p-3 text-center"><button className={secondary} disabled={locked || Boolean(channelsId || deleteId)} onClick={() => void refresh(page.nextCursor!)}>Show more</button></div>}
  </section>;
}
