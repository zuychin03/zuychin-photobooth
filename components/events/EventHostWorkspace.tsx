"use client";
import { useRecoveryRelease } from "@/components/ReleaseMode";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, CalendarClock, CalendarHeart, LoaderCircle, Lock, Plus, RefreshCw, UserPlus } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Section } from "@/components/ui/Section";
import type { EventReminderClient } from "@/lib/events/reminder-client";
import type { EventModerationClient } from "@/lib/events/moderation-client";
import type { EventExportClient } from "@/lib/events/export-client";
import type { EventReviewClient } from "@/lib/events/review-client";
import type { EventHostClient } from "@/lib/events/client";
import type { EventHostList, EventHostSummary } from "@/lib/events/host-contract";
import type { EventCreateInput } from "@/lib/events/contract";
import { defaultEventInput } from "@/lib/events/host-actions";
import { EventHostForm } from "./EventHostForm";
import { EventHostDetail } from "./EventHostDetail";
import { EventGlyph, EventHostConfirm, EventStatusChip, useEventLeaveWarning } from "./EventHostControls";
import { useEventHostTask } from "./useEventHostTask";

export function EventHostWorkspace({ client, exportClient, reviewClient, reminderClient, moderationClient, initialEventId, onDirtyChange }: { client: EventHostClient; exportClient?: EventExportClient; reviewClient?: EventReviewClient; reminderClient?: EventReminderClient; moderationClient?: EventModerationClient; initialEventId?: string; onDirtyChange?(dirty: boolean): void }) {
  const recovery = useRecoveryRelease();
  const task = useEventHostTask(client), [support, setSupport] = useState<"checking" | "ready" | "unavailable">("checking");
  const [page, setPage] = useState<EventHostList | null>(null), [selected, setSelected] = useState<EventHostSummary | null>(null), [creating, setCreating] = useState(false);
  const [form, setForm] = useState<EventCreateInput>(defaultEventInput), [pending, setPending] = useState<{ eventId: string; event: EventCreateInput } | null>(null), [confirm, setConfirm] = useState(false);
  const [notice, setNotice] = useState<string | null>(null), [returnFocus, setReturnFocus] = useState<HTMLElement | null>(null), title = useRef<HTMLHeadingElement>(null);
  const { run } = task;
  useEventLeaveWarning(creating);
  useEffect(() => { if (!selected) onDirtyChange?.(creating); }, [creating, selected, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  const load = useCallback((after?: string) => run(async (signal, check) => {
    const caps = await client.capabilities(signal); check();
    if (caps.hostVersion !== 1) { setSupport("unavailable"); return; }
    const list = await client.list({ after, limit: 25 }, signal); check(); setPage(list); setSupport("ready");
  }), [client, run]);
  useEffect(() => {
    void run(async (signal, check) => {
      const caps = await client.capabilities(signal); check(); if (caps.hostVersion !== 1) { setSupport("unavailable"); return; }
      let list = await client.list({ limit: 25 }, signal); check(); setPage(list); setSupport("ready");
      if (initialEventId) {
        for (let index = 0; index < 40; index++) {
          const match = list.events.find(item => item.eventId === initialEventId); if (match) { setSelected(match); return; }
          if (!list.nextCursor) break;
          list = await client.list({ after: list.nextCursor, limit: 25 }, signal); check();
        }
        setNotice("Couldn't find that event. Look through your events or check the invitation.");
      }
    });
  }, [client, initialEventId, run]);
  const create = () => {
    if (recovery || task.isBusy()) return;
    const request = pending ?? { eventId: crypto.randomUUID(), event: structuredClone({ ...form, title: form.title.trim() }) };
    setPending(request);
    void task.run(async (signal, check) => {
      const result = await client.create(request.eventId, request.event, signal); check();
      setPending(null); setCreating(false); setSelected({ eventId: result.eventId, title: result.title, timezone: result.timezone, startsAt: result.startsAt, closesAt: result.closesAt, expiresAt: result.expiresAt, status: result.status, role: "owner", membership: "active" });
      setNotice("Draft created. Check its look and dates before opening it to guests.");
    });
  };
  if (task.lost) return <><PageHeader title="Your events" /><p role="alert" className="page-body notice max-w-3xl border border-destructive/25 bg-destructive/8">Your event access changed. Refresh the page.</p></>;
  if (selected) return <EventHostDetail key={selected.eventId} client={client} exportClient={exportClient} reviewClient={reviewClient} reminderClient={reminderClient} moderationClient={moderationClient} summary={selected} onDirtyChange={onDirtyChange} onBack={() => { setSelected(null); setNotice(null); void load(); requestAnimationFrame(() => title.current?.focus()); }} />;
  const row = "btn min-h-10 text-sm";
  return <>
    <div inert={confirm || undefined} className="flex flex-col gap-6">
      <PageHeader title={creating ? "New event" : "Your events"} headingRef={title} actions={!creating && <>
        {support === "ready" && <button className="btn btn-primary" disabled={recovery || task.busy} onClick={() => { setCreating(true); setForm(defaultEventInput()); setNotice(null); requestAnimationFrame(() => title.current?.focus()); }}><Plus size={18} aria-hidden /> Create an event</button>}
        <button className="btn btn-quiet" disabled={task.busy} onClick={() => void load()}><RefreshCw size={16} aria-hidden /> Refresh</button>
      </>} />
      <div className="page-body flex flex-col gap-5">
        {task.error && <p role="alert" className="notice max-w-3xl border border-destructive/25 bg-destructive/8">{task.error}</p>}
        {notice && <p role="status" className="notice max-w-3xl">{notice}</p>}
        {task.busy && <p role="status" className="flex items-center gap-2 text-sm font-bold"><LoaderCircle size={16} className="animate-spin text-accent motion-reduce:animate-none" aria-hidden /> Loading…</p>}
        {support !== "ready" ? <p className="panel flex min-h-40 items-center justify-center p-6 text-center text-sm text-muted-foreground">{support === "checking" ? "Checking if events are available…" : "Event hosting isn't ready on this server yet."}</p> : creating ? <form className="flex max-w-3xl flex-col gap-5" onSubmit={event => { event.preventDefault(); create(); }}>
          <Section id="event-new-details-title" title="Details and dates" icon={CalendarClock} tone="amber">
            <EventHostForm value={pending?.event ?? form} onChange={setForm} disabled={task.busy || Boolean(pending)} />
            <p className="mt-5 flex items-start gap-2 text-sm text-muted-foreground"><Lock size={15} className="mt-0.5 shrink-0" aria-hidden />Photos stay private until you approve them for sharing.</p>
          </Section>
          {pending && <p role="status" className="notice">Try again here so you don&apos;t create a duplicate.</p>}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><button type="button" className="btn btn-quiet" disabled={task.busy} onClick={event => { setReturnFocus(event.currentTarget); setConfirm(true); }}>Back to events</button><button type="submit" className="btn btn-primary" disabled={recovery || task.busy}>{pending ? "Try again" : "Create draft"}</button></div>
        </form> : !page?.events.length ? <section className="panel flex min-h-64 flex-col items-center justify-center gap-4 px-6 py-12 text-center"><span className="glyph size-14 rounded-2xl bg-[#f59e0b]"><CalendarHeart size={26} aria-hidden /></span><h2 className="font-display text-2xl">No events yet</h2></section> : <section aria-labelledby="event-list-title" className="panel overflow-hidden">
          <h2 id="event-list-title" className="border-b border-border px-4 py-3 text-sm font-bold text-muted-foreground tabular-nums sm:px-5">{page.events.length} {page.events.length === 1 ? "event" : "events"}</h2>
          <ul className="divide-y divide-border">{page.events.map(item => <li key={item.eventId} className="flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-4 sm:px-5">
            <div className="flex min-w-0 flex-1 basis-64 items-center gap-3"><EventGlyph icon={item.membership === "invited" ? UserPlus : CalendarHeart} tone={item.membership === "invited" ? "violet" : "amber"} /><div className="min-w-0"><h3 className="break-words text-lg font-bold">{item.title}</h3><p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground"><EventStatusChip status={item.status} />{item.role === "owner" ? "Owner" : item.membership === "invited" ? "Moderator invitation" : "Moderator"} · {new Date(item.expiresAt) <= new Date() ? "Expired" : `Expires ${new Date(item.expiresAt).toLocaleDateString("en-AU", { timeZone: item.timezone })}`}</p></div></div>
            <button className={`${row} ${item.membership === "invited" ? "btn-partner" : "btn-tinted"}`} disabled={task.busy} onClick={() => setSelected(item)}>{item.membership === "invited" ? "Review invitation" : "Open event"} <ArrowRight size={15} aria-hidden /></button>
          </li>)}</ul>
          <div className="flex flex-wrap justify-end gap-2 border-t border-border p-3"><button className={`${row} btn-plain`} disabled={task.busy} onClick={() => void load()}>First page</button>{page.nextCursor && <button className={`${row} btn-quiet`} disabled={task.busy} onClick={() => void load(page.nextCursor!)}>Next page</button>}</div>
        </section>}
      </div>
    </div>
    {confirm && <EventHostConfirm title="Leave without saving?" action="Leave" busy={task.busy} returnFocus={returnFocus} onKeep={() => setConfirm(false)} onConfirm={() => { setConfirm(false); setCreating(false); setPending(null); void load(); requestAnimationFrame(() => title.current?.focus()); }}><p>{pending ? "The event might already have been created. Refresh your events before creating another." : "Your changes will be lost."}</p></EventHostConfirm>}
  </>;
}
