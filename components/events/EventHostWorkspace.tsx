"use client";
import { useCallback, useEffect, useRef, useState } from "react";
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
import { EventHostConfirm, eventControl, useEventLeaveWarning } from "./EventHostControls";
import { useEventHostTask } from "./useEventHostTask";

export function EventHostWorkspace({ client, exportClient, reviewClient, reminderClient, moderationClient, initialEventId, onDirtyChange }: { client: EventHostClient; exportClient?: EventExportClient; reviewClient?: EventReviewClient; reminderClient?: EventReminderClient; moderationClient?: EventModerationClient; initialEventId?: string; onDirtyChange?(dirty: boolean): void }) {
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
        setNotice("That event could not be found in the checked pages for this account. Browse your events or check the invitation.");
      }
    });
  }, [client, initialEventId, run]);
  const create = () => {
    if (task.isBusy()) return;
    const request = pending ?? { eventId: crypto.randomUUID(), event: structuredClone({ ...form, title: form.title.trim() }) };
    setPending(request);
    void task.run(async (signal, check) => {
      const result = await client.create(request.eventId, request.event, signal); check();
      setPending(null); setCreating(false); setSelected({ eventId: result.eventId, title: result.title, timezone: result.timezone, startsAt: result.startsAt, closesAt: result.closesAt, expiresAt: result.expiresAt, status: result.status, role: "owner", membership: "active" });
      setNotice("Draft created. Review its look and retention before opening contributions.");
    });
  };
  if (task.lost) return <section className="border-t border-border py-8"><p role="alert">Your event access changed. Refresh this page to check your account before continuing.</p></section>;
  if (selected) return <EventHostDetail key={selected.eventId} client={client} exportClient={exportClient} reviewClient={reviewClient} reminderClient={reminderClient} moderationClient={moderationClient} summary={selected} onDirtyChange={onDirtyChange} onBack={() => { setSelected(null); setNotice(null); void load(); requestAnimationFrame(() => title.current?.focus()); }} />;
  return <section className="border-t border-border py-7">
    <div inert={confirm || undefined}>
      <header className="flex flex-wrap items-center justify-between gap-3"><h2 ref={title} tabIndex={-1} className="font-display text-2xl outline-none">{creating ? "Create an event draft" : "Hosted and invited events"}</h2>{!creating && <button className={`${eventControl} border border-border`} disabled={task.busy} onClick={() => void load()}>Refresh events</button>}</header>
      {task.error && <p role="alert" className="mt-4 text-sm leading-relaxed">{task.error}</p>}
      {notice && <p role="status" className="mt-4 text-sm leading-relaxed">{notice}</p>}
      {task.busy && <p role="status" className="mt-4 text-sm">Checking the event service…</p>}
      {support !== "ready" ? <p className="mt-5 max-w-xl text-sm leading-relaxed">{support === "checking" ? "Checking host workspace availability. If it remains unavailable, use Refresh events to try again." : "Event hosting is not ready on this server. Your existing event data has not changed."}</p> : creating ? <form className="mt-6 max-w-3xl space-y-6" onSubmit={event => { event.preventDefault(); create(); }}>
        <EventHostForm value={pending?.event ?? form} onChange={setForm} disabled={task.busy || Boolean(pending)} />
        <p className="text-sm leading-relaxed text-foreground/70">Create a draft, choose its look, then open it to guests. Photos stay private until approved for sharing.</p>
        {pending && <p role="status" className="rounded-xl bg-muted p-4 text-sm leading-relaxed">Retry here to avoid creating a duplicate. If you leave, refresh your event list before creating again.</p>}
        <div className="flex flex-wrap gap-2"><button type="submit" className={`${eventControl} bg-accent text-accent-foreground`} disabled={task.busy}>{pending ? "Retry this creation" : "Create draft"}</button><button type="button" className={eventControl} disabled={task.busy} onClick={event => { setReturnFocus(event.currentTarget); setConfirm(true); }}>Back to events</button></div>
      </form> : <>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-foreground/70">After an interrupted request, refresh first. Your event may already exist.</p>
        <button className={`${eventControl} my-5 bg-accent text-accent-foreground`} disabled={task.busy} onClick={() => { setCreating(true); setForm(defaultEventInput()); setNotice(null); requestAnimationFrame(() => title.current?.focus()); }}>Create an event</button>
        {!page?.events.length ? <p className="py-5 text-sm">No events on this page. Create a draft or ask the owner to invite your account as a moderator.</p> : <ul className="divide-y divide-border">{page.events.map(item => <li key={item.eventId} className="flex flex-wrap items-center justify-between gap-4 py-5"><div className="min-w-0"><h3 className="break-words font-display text-xl">{item.title}</h3><p className="mt-1 text-sm text-foreground/70">{item.role === "owner" ? "Owner" : item.membership === "invited" ? "Moderator invitation" : "Moderator"} · {item.status} · {new Date(item.expiresAt) <= new Date() ? "Expired" : `Expires ${new Date(item.expiresAt).toLocaleDateString("en-AU", { timeZone: item.timezone })}`}</p></div><button className={`${eventControl} border border-border`} disabled={task.busy} onClick={() => setSelected(item)}>{item.membership === "invited" ? "Review invitation" : "Open event"}</button></li>)}</ul>}
        <div className="mt-5 flex flex-wrap gap-2"><button className={eventControl} disabled={task.busy} onClick={() => void load()}>First page</button>{page?.nextCursor && <button className={`${eventControl} border border-border`} disabled={task.busy} onClick={() => void load(page.nextCursor!)}>Next page</button>}</div>
      </>}
    </div>
    {confirm && <EventHostConfirm title="Leave event setup?" action="Leave setup" busy={task.busy} returnFocus={returnFocus} onKeep={() => setConfirm(false)} onConfirm={() => { setConfirm(false); setCreating(false); setPending(null); void load(); requestAnimationFrame(() => title.current?.focus()); }}><p>{pending ? "The creation may already have reached the server. Leaving discards this page’s exact retry request. Refresh the event list before creating another." : "Your unsaved setup choices will be lost."}</p></EventHostConfirm>}
  </section>;
}
