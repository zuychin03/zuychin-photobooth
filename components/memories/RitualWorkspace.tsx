"use client";

import { useAppNavigationGuard } from "@/components/AppNavigation";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { CalendarHeart, LoaderCircle, Plus, RefreshCw } from "lucide-react";
import { Dropdown } from "@/components/Dropdown";
import { cloudControl, cloudInput } from "@/components/cloud/CloudControls";
import type { RitualClient } from "@/lib/memories/ritual-client";
import type { RitualChannels, RitualPage, RitualRow } from "@/lib/memories/ritual-contract";
import { reviewRitual, ritualError, ritualFields, ritualInstant, type RitualFields, type RitualReview } from "@/lib/memories/ritual-editor";

type Editor = { id: string; row?: RitualRow };
const secondary = `${cloudControl} border border-border hover:bg-muted`;
const primary = `${cloudControl} bg-accent text-accent-foreground hover:opacity-90`;
const cadence = [{ value: "once", label: "Once" }, { value: "weekly", label: "Weekly" }, { value: "monthly", label: "Monthly" }, { value: "yearly", label: "Yearly" }];
const adjustmentText = { "date-clamp": "This month uses its last day; the original anchor is kept for later months.", "gap-shift": "The selected time falls in a daylight-saving gap. The preview moves it forward by the gap.", "fold-earlier": "This time occurs twice. The earlier occurrence is selected.", "fold-later": "This time occurs twice. The later occurrence is selected." };

function RitualEditor({ editor, busy, stale, onCancel, onRefresh, onSave }: { editor: Editor; busy: boolean; stale: boolean; onCancel(): void; onRefresh(): void; onSave(review: RitualReview): Promise<boolean> }) {
  const id = useId(), heading = useRef<HTMLHeadingElement>(null);
  const [fields, setFields] = useState(() => ritualFields(editor.row)), [review, setReview] = useState<RitualReview | null>(null), [error, setError] = useState<string | null>(null), [attempted, setAttempted] = useState(false);
  useEffect(() => { heading.current?.focus(); }, [review]);
  const change = <K extends keyof RitualFields>(key: K, value: RitualFields[K]) => setFields(previous => ({ ...previous, [key]: value }));
  const prepare = () => {
    try { setReview(reviewRitual(fields, new Date().toISOString(), editor.row)); setError(null); }
    catch (failure) { setError(failure instanceof Error && !failure.message.startsWith("Invalid") ? failure.message : "Enter a title, valid date and time, and an IANA timezone such as Australia/Sydney."); }
  };
  const title = editor.row?.legacy ? "Review your existing reminder" : editor.row ? "Edit ritual" : "Make time for a photo";
  return <section aria-labelledby={`${id}-title`} className="mt-7 border-t border-border py-7">
    <h3 ref={heading} tabIndex={-1} id={`${id}-title`} className="font-display text-2xl font-semibold outline-none">{review ? "Review this ritual" : title}</h3>
    {editor.row?.legacy && <p className="mt-3 max-w-2xl text-sm leading-relaxed text-foreground/75">The original timezone was not recorded. Its existing next instant is {ritualInstant(editor.row.scheduledAt, "UTC")}. Choose and confirm the zone for future reminders. Nothing changes until you save.</p>}
    {!review ? <form className="mt-6 max-w-2xl space-y-5" onSubmit={event => { event.preventDefault(); prepare(); }}>
      <fieldset disabled={busy || stale} className="space-y-5 disabled:opacity-60">
        <label className="block text-sm font-medium" htmlFor={`${id}-name`}>Ritual name<input id={`${id}-name`} className={`${cloudInput} mt-2`} value={fields.title} onChange={event => change("title", event.target.value)} maxLength={200} required placeholder="Our Sunday photo" /></label>
        <div className="grid min-w-0 gap-5 sm:grid-cols-2">
          <label className="block min-w-0 text-sm font-medium" htmlFor={`${id}-date`}>Anchor date<input id={`${id}-date`} type="date" min="1970-01-01" max="2199-12-31" className={`${cloudInput} mt-2 min-w-0`} value={fields.date} onInput={event => change("date", event.currentTarget.value)} onChange={event => change("date", event.target.value)} required /></label>
          <label className="block min-w-0 text-sm font-medium" htmlFor={`${id}-time`}>Time in the saved zone<input id={`${id}-time`} type="time" className={`${cloudInput} mt-2 min-w-0`} value={fields.time} onInput={event => change("time", event.currentTarget.value)} onChange={event => change("time", event.target.value)} required /></label>
        </div>
        <label className="block text-sm font-medium" htmlFor={`${id}-zone`}>Timezone<input id={`${id}-zone`} className={`${cloudInput} mt-2`} value={fields.zone} onChange={event => change("zone", event.target.value)} maxLength={100} required autoCapitalize="none" spellCheck={false} aria-describedby={`${id}-zone-help`} /></label>
        <p id={`${id}-zone-help`} className="-mt-3 text-sm leading-relaxed text-foreground/75">Use a region such as Australia/Sydney or Asia/Ho_Chi_Minh. Travelling will not change this saved zone.</p>
        <div className="grid gap-5 sm:grid-cols-2"><Dropdown label="Repeat" showLabel value={fields.frequency} options={cadence} onChange={value => change("frequency", value as RitualFields["frequency"])} disabled={busy || stale} />{fields.frequency !== "once" && <Dropdown label="Repeat interval" showLabel value={fields.interval} options={Array.from({ length: 12 }, (_, index) => ({ value: String(index + 1), label: `Every ${index + 1} ${fields.frequency === "weekly" ? "week" : fields.frequency === "monthly" ? "month" : "year"}${index ? "s" : ""}` }))} onChange={value => change("interval", value)} disabled={busy || stale} />}</div>
        <details className="text-sm"><summary className="min-h-11 cursor-pointer content-center font-medium focus-visible:outline-2 focus-visible:outline-ring">Calendar and daylight-saving choices</summary><div className="mt-3 grid gap-4">
          {(fields.frequency === "monthly" || fields.frequency === "yearly") && <Dropdown label="When the date is missing" showLabel value={fields.invalidDate} options={[{ value: "clamp", label: "Use the last day of that month" }, { value: "skip", label: "Skip that occurrence" }]} onChange={value => change("invalidDate", value as RitualFields["invalidDate"])} disabled={busy || stale} />}
          <Dropdown label="When clocks skip this time" showLabel value={fields.gap} options={[{ value: "shift-forward", label: "Move forward by the clock change" }, { value: "skip", label: "Skip that occurrence" }]} onChange={value => change("gap", value as RitualFields["gap"])} disabled={busy || stale} />
          <Dropdown label="When clocks repeat this time" showLabel value={fields.fold} options={[{ value: "later", label: "Use the later occurrence" }, { value: "earlier", label: "Use the earlier occurrence" }]} onChange={value => change("fold", value as RitualFields["fold"])} disabled={busy || stale} />
        </div></details>
      </fieldset>
      {error && <p role="alert" className="text-sm font-medium">{error}</p>}
      <div className="flex flex-wrap gap-2"><button type="submit" disabled={busy || stale} className={primary}>Review schedule</button><button type="button" disabled={busy} className={secondary} onClick={onCancel}>Cancel</button></div>
    </form> : <div className="mt-5 max-w-2xl">
      <p className="break-words text-lg font-semibold">{review.input.title}</p>
      <dl className="mt-4 grid gap-3 text-sm"><div><dt className="text-foreground/65">Next reminder in {review.input.schedule.timeZone}</dt><dd className="mt-1 font-medium">{ritualInstant(review.occurrence.instant, review.input.schedule.timeZone)}</dd></div><div><dt className="text-foreground/65">The same instant in UTC</dt><dd className="mt-1">{ritualInstant(review.occurrence.instant, "UTC")}</dd></div><div><dt className="text-foreground/65">Repeat</dt><dd className="mt-1">{review.input.schedule.frequency === "once" ? "Once" : `Every ${review.input.schedule.interval} ${review.input.schedule.frequency === "weekly" ? "week(s)" : review.input.schedule.frequency === "monthly" ? "month(s)" : "year(s)"}, anchored to ${review.input.schedule.anchorDate}`}</dd></div></dl>
      {review.adjustments.map(value => <p key={value} className="mt-3 text-sm font-medium">{adjustmentText[value]}</p>)}
      <p className="mt-4 text-sm leading-relaxed text-foreground/75">Each person chooses their own email and push reminders.</p>
      {editor.row?.paused && <p className="mt-3 text-sm font-medium">This ritual will stay paused after editing.</p>}
      {attempted && <p className="mt-3 text-sm leading-relaxed">Refresh, then retry this request. If you leave, check your reminders before creating another.</p>}
      <div className="mt-5 flex flex-wrap gap-2"><button disabled={busy || stale} className={primary} onClick={() => { setAttempted(true); void onSave(review); }}>{attempted ? "Retry reviewed request" : editor.row?.legacy ? "Confirm upgrade" : "Save ritual"}</button>{!attempted && <button disabled={busy} className={secondary} onClick={() => setReview(null)}>Change details</button>}{stale && <button disabled={busy} className={secondary} onClick={onRefresh}>Refresh reminders</button>}<button disabled={busy} className={secondary} onClick={onCancel}>{attempted ? "Leave reviewed request" : "Cancel"}</button></div>
    </div>}
  </section>;
}

function Channels({ row, busy, onSave, onCancel }: { row: RitualRow; busy: boolean; onSave(channels: RitualChannels): void; onCancel(): void }) {
  const [channels, setChannels] = useState(row.channels);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => { first.current?.focus(); }, []);
  return <form className="mt-4 max-w-xl" onSubmit={event => { event.preventDefault(); onSave(channels); }}><fieldset disabled={busy}><legend className="text-sm font-semibold">Your reminders for this ritual</legend><p className="mt-2 text-sm leading-relaxed text-foreground/75">These choices apply to you. Your partner chooses separately. Push also needs notifications enabled on this device.</p>{(["email", "push"] as const).map(channel => <label key={channel} className="mt-2 flex min-h-11 items-center gap-3 text-sm"><input ref={channel === "email" ? first : undefined} type="checkbox" className="size-5 accent-accent" checked={channels[channel]} onChange={event => setChannels(previous => ({ ...previous, [channel]: event.target.checked }))} />{channel === "email" ? "Email me" : "Send me push reminders"}</label>)}</fieldset><div className="mt-3 flex flex-wrap gap-2"><button disabled={busy} className={primary}>Save my reminder choices</button><button type="button" disabled={busy} className={secondary} onClick={onCancel}>Cancel</button></div></form>;
}

export function RitualWorkspace({ client, coupleId }: { client: RitualClient; coupleId: string }) {
  const [page, setPage] = useState<RitualPage | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [note, setNote] = useState<string | null>(null), [stale, setStale] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(null), [channelsId, setChannelsId] = useState<string | null>(null), [deleteId, setDeleteId] = useState<string | null>(null);
  const [accessLost, setAccessLost] = useState(false);
  useAppNavigationGuard(() => {
    if (busy || editor || channelsId || deleteId) { setNote("Save or cancel the open reminder before leaving."); return false; }
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
    if (editor?.row) { setEditor(null); setNote("Reminders refreshed. Open the current reminder to review any further changes."); }
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
    setEditor(null); setStale(true); setNote("Ritual saved. Refresh the full list to manage it and choose your reminders."); heading.current?.focus();
  }, true);
  const locked = busy || stale || Boolean(editor) || !page;
  if (accessLost) return <section className="mt-9 border-t border-border py-7"><h2 ref={lostHeading} tabIndex={-1} className="font-display text-2xl outline-none">This pairing is no longer available</h2><p role="alert" className="mt-3 max-w-xl text-sm leading-relaxed">Return to your album to check your account and pairing before opening reminders again.</p><Link href="/timeline" className={`${primary} mt-5`}>Return to album</Link></section>;
  return <section className="mt-9" aria-labelledby="rituals-heading">
    <div className="flex flex-wrap items-center justify-between gap-4"><h2 id="rituals-heading" ref={heading} tabIndex={-1} className="font-display text-2xl font-semibold outline-none">Your rituals</h2><div className="flex flex-wrap gap-2"><button className={secondary} disabled={busy} onClick={() => void refresh()}><RefreshCw size={16} aria-hidden /> Refresh</button><button className={primary} disabled={locked || Boolean(channelsId || deleteId)} onClick={() => setEditor({ id: crypto.randomUUID() })}><Plus size={17} aria-hidden /> New ritual</button></div></div>
    <p className="mt-3 max-w-2xl text-sm leading-relaxed text-foreground/75">Plan a photo date. Pause or resume whenever you need.</p>
    {busy && <p role="status" className="mt-4 flex items-center gap-2 text-sm"><LoaderCircle size={16} aria-hidden className="animate-spin motion-reduce:animate-none" /> Checking your reminder request…</p>}
    {error && <p role="alert" className="mt-4 max-w-2xl text-sm font-medium">{error}</p>}
    {note && <p role="status" className="mt-4 max-w-2xl text-sm font-medium">{note}</p>}
    {stale && <p className="mt-3 text-sm">Refresh the reminders before making another change.</p>}
    {editor && <RitualEditor key={editor.id} editor={editor} busy={busy} stale={stale} onCancel={() => { setEditor(null); heading.current?.focus(); }} onRefresh={() => void refresh()} onSave={save} />}
    {!page && !error ? <p role="status" className="mt-8 text-sm">Loading your reminders…</p> : page?.items.length === 0 ? <div className="mt-8 border-t border-border py-8"><CalendarHeart size={28} aria-hidden className="text-accent" /><h3 className="mt-4 font-display text-xl">Something to look forward to</h3><p className="mt-2 max-w-lg text-sm leading-relaxed text-foreground/75">Add a photo date, weekly catch-up or yearly tradition.</p></div> : <ul className="mt-6 divide-y divide-border">{page?.items.map(row => {
      const mine = row.creatorId === client.ownerId, trouble = row.delivery?.status === "failed" || row.delivery?.status === "uncertain";
      return <li key={row.id} className="py-6"><div className="flex flex-wrap items-start justify-between gap-3"><h3 className="min-w-0 max-w-2xl break-words font-display text-xl font-semibold [overflow-wrap:anywhere]">{row.title}</h3><span className="text-sm font-medium text-foreground/75">{row.legacy ? "Existing reminder" : trouble ? "Needs attention" : row.paused ? "Paused" : row.enabled ? "Scheduled" : "Finished"}</span></div>
        <p className="mt-2 text-sm leading-relaxed">{row.legacy ? `${row.active ? "Next" : "Last scheduled"}: ${ritualInstant(row.scheduledAt, "UTC")}. Original timezone not recorded.` : row.next ? `${row.paused || trouble ? "Saved occurrence" : "Next"}: ${ritualInstant(row.next.instant, row.schedule!.timeZone)} (${row.schedule!.timeZone}).` : "No upcoming occurrence."}</p>
        {row.legacy ? <p className="mt-2 text-sm text-foreground/75">{mine ? "Review and upgrade to choose a timezone and use pause or personal reminder choices." : "The creator can review and upgrade this reminder."}</p> : <>
          <p className="mt-2 text-sm text-foreground/75">Your reminders: {row.channels.email ? "email on" : "email off"}, {row.channels.push ? "push on" : "push off"}.</p>
          {row.delivery?.status === "pending" && <p className="mt-2 text-sm">This occurrence is waiting for delivery.</p>}{row.delivery?.status === "retrying" && <p className="mt-2 text-sm">Delivery is retrying ({row.delivery.attempts} of 5 attempts).</p>}
          {trouble && <p className="mt-3 max-w-2xl text-sm font-medium">{row.delivery?.status === "uncertain" ? "A reminder may have been sent, but delivery could not be confirmed." : "Delivery stopped after unsuccessful attempts."} Automatic delivery is stopped. {mine ? "Resume to schedule the next future occurrence, or edit this ritual." : "Its creator can resume a future occurrence."}</p>}
        </>}
        <div className="mt-4 flex flex-wrap gap-2">
          {mine && <button className={secondary} disabled={locked || Boolean(channelsId || deleteId)} onClick={() => setEditor({ id: row.id, row })}>{row.legacy ? "Review upgrade" : "Edit schedule"}</button>}
          {mine && !row.legacy && <button className={secondary} disabled={locked || Boolean(channelsId || deleteId)} onClick={() => void run(async signal => { const next = row.paused || !row.enabled ? await client.resume(coupleId, row.id, row.revision, signal) : await client.pause(coupleId, row.id, row.revision, signal); client.assertActive(signal); if (active.current) changed(next, next.paused ? "Ritual paused. A reminder already sent cannot be recalled." : next.enabled ? "Ritual resumed from its next future occurrence. No backlog will be sent." : "There is no future occurrence. Edit the date to schedule another."); }, true)}>{row.paused || !row.enabled ? "Resume ritual" : "Pause ritual"}</button>}
          {!row.legacy && <button className={secondary} disabled={locked || Boolean(channelsId || deleteId)} onClick={() => setChannelsId(row.id)}>My reminder choices</button>}
          {mine && <button className={`${cloudControl} hover:bg-muted`} disabled={locked || Boolean(channelsId || deleteId)} onClick={() => setDeleteId(row.id)}>Delete ritual</button>}
        </div>
        {channelsId === row.id && <Channels key={`${row.id}-${row.revision}`} row={row} busy={busy || stale} onCancel={() => setChannelsId(null)} onSave={channels => void run(async signal => { const next = await client.setChannels(coupleId, row.id, row.revision, channels, signal); client.assertActive(signal); if (active.current) changed(next, "Your reminder choices were saved. Your partner’s choices are unchanged."); }, true)} />}
        {deleteId === row.id && <div className="mt-4 max-w-xl"><p className="text-sm font-medium">Delete this ritual for both of you?</p><p className="mt-2 text-sm text-foreground/75">Future reminders stop. Your photographs stay available. A reminder already sent cannot be recalled.</p><div className="mt-3 flex flex-wrap gap-2"><button ref={deleteButton} className={primary} disabled={busy || stale} onClick={() => void run(async signal => { await client.delete(coupleId, row.id, row.revision, signal); client.assertActive(signal); if (active.current) { setPage(previous => previous && ({ ...previous, items: previous.items.filter(item => item.id !== row.id) })); setDeleteId(null); setNote("Ritual deleted. Your photographs were not changed."); heading.current?.focus(); } }, true)}>Confirm delete ritual</button><button className={secondary} disabled={busy} onClick={() => setDeleteId(null)}>Keep ritual</button></div></div>}
      </li>;
    })}</ul>}
    {page?.nextCursor && <button className={`${secondary} mt-4`} disabled={locked || Boolean(channelsId || deleteId)} onClick={() => void refresh(page.nextCursor!)}>Next reminders</button>}
  </section>;
}
