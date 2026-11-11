"use client";
import { useRecoveryRelease } from "@/components/ReleaseMode";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, CalendarClock, ListChecks, LoaderCircle, Lock, Pause, Play, QrCode, RefreshCw, Tablet, Trash2, UserPlus, Users } from "lucide-react";
import { HelpTooltip } from "@/components/HelpTooltip";
import { PageHeader } from "@/components/ui/PageHeader";
import { Section } from "@/components/ui/Section";
import { useStickyTop } from "@/components/ui/useStickyTop";
import { EventHostGuestbookPanel } from "./EventHostGuestbookPanel";
import { EventInvitationQr } from "./EventInvitationQr";
import { EventModerationPanel } from "./EventModerationPanel";
import type { EventModerationClient } from "@/lib/events/moderation-client";
import { EventReminderPanel } from "./EventReminderPanel";
import { EventExportPanel } from "./EventExportPanel";
import { EventHostTestPreview } from "./EventHostTestPreview";
import { EventHostContributionPreview } from "./EventHostContributionPreview";
import type { EventReviewClient } from "@/lib/events/review-client";
import type { EventReminderClient } from "@/lib/events/reminder-client";
import type { EventExportClient } from "@/lib/events/export-client";
import type { EventHostClient, EventHostDashboard } from "@/lib/events/client";
import type { EventHostSummary, EventSettings, EventSettingsInput } from "@/lib/events/host-contract";
import { executeEventHostMutation, type EventHostMutation } from "@/lib/events/host-actions";
import { EventHostForm, EventHostLook } from "./EventHostForm";
import { EventGlyph, EventHostConfirm, EventStatusChip, useEventLeaveWarning } from "./EventHostControls";
import { useEventHostTask } from "./useEventHostTask";

type Confirmation = { kind: "back" | "refresh" | "dismiss" } | { kind: "mutation"; title: string; copy: string; action: string; request: EventHostMutation };
export function EventHostDetail({ client, exportClient, reviewClient, reminderClient, moderationClient, summary, onBack, onDirtyChange }: { client: EventHostClient; exportClient?: EventExportClient; reviewClient?: EventReviewClient; reminderClient?: EventReminderClient; moderationClient?: EventModerationClient; summary: EventHostSummary; onBack(): void; onDirtyChange?(dirty: boolean): void }) {
  const recovery = useRecoveryRelease();
  const router = useRouter();
  const task = useEventHostTask(client), [dashboard, setDashboard] = useState<EventHostDashboard | null>(null), [settings, setSettings] = useState<EventSettings | null>(null), [form, setForm] = useState<EventSettingsInput | null>(null);
  const [pending, setPending] = useState<EventHostMutation | null>(null), [confirmation, setConfirmationState] = useState<(Confirmation & { returnFocus: HTMLElement | null }) | null>(null), [notice, setNotice] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(summary.membership === "active"), [invitation, setInvitation] = useState<{ token: string; expiresAt: string } | null>(null), [revokeToken, setRevokeToken] = useState("");
  const [guestbookBusy, setGuestbookBusy] = useState(false), [guestbookDirty, setGuestbookDirty] = useState(false), guestbookBlocked = guestbookBusy || guestbookDirty;
  const [moderationBusy, setModerationBusy] = useState(false), [moderationDirty, setModerationDirty] = useState(false), moderationBlocked = moderationBusy || moderationDirty;
  const [reminderReadSettled, setReminderReadSettled] = useState(false);
  const onReminderReadSettled = useCallback(() => setReminderReadSettled(true), []);
  const [reminderBusy, setReminderBusy] = useState(false), [reminderDirty, setReminderDirty] = useState(false), reminderBlocked = reminderBusy || reminderDirty;
  const [exportBusy, setExportBusy] = useState(false), [exportDirty, setExportDirty] = useState(false), [moderatorId, setModeratorId] = useState("");
  const [testBusy, setTestBusy] = useState(false), [reviewBusy, setReviewBusy] = useState(false), previewBusy = testBusy || reviewBusy;
  const [after, setAfter] = useState<string | undefined>(), heading = useRef<HTMLHeadingElement>(null), sidebar = useStickyTop();
  const [now, setNow] = useState(Date.now), { run } = task;
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const dirty = Boolean(form && settings && JSON.stringify(form) !== JSON.stringify({ event: settings.event, look: settings.look })), owner = summary.role === "owner", blocked = task.busy || Boolean(pending) || exportBusy || exportDirty || previewBusy || reminderBlocked || moderationBlocked || guestbookBlocked, expired = Date.parse(dashboard?.event.expiresAt ?? summary.expiresAt) <= now, deleted = dashboard?.event.status === "deleted";
  useEventLeaveWarning(dirty || Boolean(pending) || exportDirty || exportBusy || previewBusy || reminderBlocked || moderationBlocked || guestbookBlocked);
  useEffect(() => { onDirtyChange?.(task.busy || dirty || Boolean(pending) || exportDirty || exportBusy || previewBusy || reminderBlocked || moderationBlocked || guestbookBlocked); }, [task.busy, dirty, pending, exportDirty, exportBusy, previewBusy, reminderBlocked, moderationBlocked, guestbookBlocked, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  const setConfirmation = (next: Confirmation | null) => setConfirmationState(next ? { ...next, returnFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null } : null);
  const refresh = useCallback(async (signal: AbortSignal, check: () => void, cursor?: string) => {
    const [next, config] = await Promise.all([client.dashboard(summary.eventId, { after: cursor, limit: 25 }, signal), client.settings(summary.eventId, signal)]); check();
    setDashboard(next); setSettings(config); setForm({ event: config.event, look: config.look }); setAfter(cursor);
  }, [client, summary.eventId]);
  useEffect(() => {
    heading.current?.focus();
    if (summary.membership === "active") void run((signal, check) => refresh(signal, check));
  }, [summary.membership, run, refresh]);
  const pausedMutation = (request: EventHostMutation) => recovery && (request.kind === "settings" || request.kind === "issue" || request.kind === "state" && request.action === "open" || request.kind === "moderator" && request.action === "invite_moderator");
  const mutate = (request: EventHostMutation) => {
    if (pausedMutation(request)) return;
    if (task.isBusy() || exportBusy || exportDirty || previewBusy || reminderBlocked || moderationBlocked || guestbookBlocked) return;
    setPending(request); setConfirmation(null); setNotice(null);
    void task.run(async (signal, check) => {
      const result = await executeEventHostMutation(client, request, signal); check();
      if (result.issued) setInvitation(result.issued);
      if (request.kind === "revoke") { setInvitation(null); setRevokeToken(""); }
      setPending(null);
      if (result.settings) { setSettings(result.settings); setForm({ event: result.settings.event, look: result.settings.look }); }
      setNotice(request.kind === "issue" ? "Invitation ready. Anyone with this link can join as a guest until it expires." : request.kind === "revoke" ? "Revoked." : "Done.");
      await refresh(signal, check); requestAnimationFrame(() => heading.current?.focus());
    });
  };
  const askState = (action: "open" | "pause" | "close" | "delete") => {
    if (!dashboard) return;
    const messages = { open: "Guests with the invitation can add photos between the dates you set. Check the look and dates first.", pause: "Guests can't add new photos while it's paused. Uploads already in progress can still finish.", close: "Guests can't add any more photos. Existing photos stay until they expire.", delete: "This removes access for everyone and permanently deletes the photos. Downloaded copies can't be recalled." };
    setConfirmation({ kind: "mutation", title: `${action[0].toUpperCase()}${action.slice(1)} this event?`, copy: messages[action], action: `${action[0].toUpperCase()}${action.slice(1)} event`, request: { kind: "state", eventId: summary.eventId, action, previous: dashboard.event.status } });
  };
  const accept = () => void task.run(async (signal, check) => {
    let list = await client.list({ limit: 25 }, signal); check();
    for (let page = 0; page < 40; page++) {
      const item = list.events.find(event => event.eventId === summary.eventId);
      if (item) { if (item.membership === "invited") await client.manage(summary.eventId, "accept_moderator", {}, signal); check(); setAccepted(true); await refresh(signal, check); return; }
      if (!list.nextCursor) break; list = await client.list({ after: list.nextCursor, limit: 25 }, signal); check();
    }
    throw { code: "access_denied" };
  });
  const performConfirmation = () => {
    if (!confirmation) return;
    const next = confirmation; setConfirmation(null);
    if (next.kind === "mutation") mutate(next.request);
    else if (next.kind === "back") onBack();
    else if (next.kind === "dismiss") { setPending(null); setNotice("Dismissed. Refresh before making another change, as it may have gone through."); }
    else void task.run((signal, check) => refresh(signal, check));
  };
  if (task.lost) return <><PageHeader title={summary.title} /><section className="page-body panel flex max-w-xl flex-col items-start gap-4 p-6"><p role="alert" className="font-bold">Your access to this event has changed.</p><button className="btn btn-quiet" onClick={onBack}><ArrowLeft size={17} aria-hidden /> Back to events</button></section></>;
  const row = "btn min-h-10 text-sm";
  const stats = dashboard ? [
    { label: "Guests", value: `${dashboard.usage.guests} / ${dashboard.event.maxGuests}`, used: dashboard.usage.guests / dashboard.event.maxGuests, fill: "bg-[#8b5cf6]" },
    { label: "Photos", value: `${dashboard.usage.count} / ${dashboard.event.maxContributions}`, used: dashboard.usage.count / dashboard.event.maxContributions, fill: "bg-[#f43f5e]" },
    { label: "Storage used", value: `${(dashboard.usage.bytes / 1000000).toFixed(1)} / ${dashboard.event.maxBytes / 1000000} MB`, used: dashboard.usage.bytes / dashboard.event.maxBytes, fill: "bg-[#0ea5e9]" },
  ] : [];
  return <>
    <div inert={Boolean(confirmation) || undefined} className="flex flex-col gap-6">
      <PageHeader headingRef={heading} title={<span className="break-words">{dashboard?.event.title ?? summary.title}</span>}
        leading={<button className="btn btn-plain -ml-3.5 min-h-10 text-sm" disabled={task.busy || exportBusy || previewBusy || reminderBusy || moderationBusy || guestbookBusy} onClick={() => dirty || pending || exportDirty || reminderDirty || moderationDirty || guestbookDirty ? setConfirmation({ kind: "back" }) : onBack()}><ArrowLeft size={16} aria-hidden /> Back to events</button>}
        meta={<span className="flex flex-wrap items-center gap-2"><EventStatusChip status={dashboard?.event.status ?? summary.status} />{owner ? "Owner" : "Moderator"}{expired ? " · Expired" : ""}</span>}
        actions={accepted && <>
          {owner && dashboard && !["open", "deleted", "closed"].includes(dashboard.event.status) && <button className="btn btn-primary" disabled={recovery || blocked || dirty || expired} onClick={() => askState("open")}><Play size={16} aria-hidden /> Open to guests</button>}
          {owner && dashboard?.event.status === "open" && <button className="btn btn-quiet" disabled={blocked || dirty || expired} onClick={() => askState("pause")}><Pause size={16} aria-hidden /> Pause</button>}
          {owner && dashboard && !["closed", "deleted"].includes(dashboard.event.status) && <button className="btn btn-quiet" disabled={blocked || dirty || expired} onClick={() => askState("close")}><Lock size={16} aria-hidden /> Close…</button>}
          {owner && dashboard && !deleted && <button className="btn btn-danger" disabled={blocked || dirty} onClick={() => askState("delete")}><Trash2 size={16} aria-hidden /> Delete event…</button>}
          <button className="btn btn-quiet" disabled={blocked} onClick={() => dirty ? setConfirmation({ kind: "refresh" }) : void task.run((signal, check) => refresh(signal, check))}><RefreshCw size={16} aria-hidden /> Refresh</button>
        </>} />
      <div className="page-body flex flex-col gap-5">
        {task.error && <p role="alert" className="notice max-w-3xl border border-destructive/25 bg-destructive/8">{task.error}</p>}
        {notice && <p role="status" className="notice max-w-3xl">{notice}</p>}
        {task.busy && <p role="status" className="flex items-center gap-2 text-sm font-bold"><LoaderCircle size={16} className="animate-spin text-accent motion-reduce:animate-none" aria-hidden /> Waiting for confirmation…</p>}
        {pending && <section aria-label="Unconfirmed event action" className="notice max-w-3xl"><p>This {pending.kind === "issue" ? "invitation" : "change"} may have already gone through. Try again, or dismiss and refresh to check.</p><div className="mt-3 flex flex-wrap gap-2"><button className={`${row} btn-quiet`} disabled={task.busy || pausedMutation(pending)} onClick={() => mutate(pending)}>Try again</button><button className={`${row} btn-plain`} disabled={task.busy} onClick={() => setConfirmation({ kind: "dismiss" })}>Dismiss…</button></div></section>}
        {!accepted ? <Section id="event-moderator-invite-title" title="Moderator invitation" icon={UserPlus} tone="violet" className="max-w-xl" bodyClassName="mt-3"><p className="text-sm text-muted-foreground">Accept to help review guests&apos; photos.</p><button className="btn btn-partner mt-4" disabled={recovery || task.busy || expired} onClick={accept}>Accept</button></Section> : <>
          {exportBusy && <p role="status" className="notice max-w-3xl">Exporting. Other controls are paused until it&apos;s done.</p>}
          {exportDirty && !exportBusy && <p role="status" className="notice max-w-3xl">Finish or discard the export before changing this event.</p>}
          {reminderBusy && <p role="status" className="notice max-w-3xl">Updating reminder settings…</p>}
          {reminderDirty && !reminderBusy && <p role="status" className="notice max-w-3xl">Save or discard your reminder settings before changing this event.</p>}
          {dashboard && <section aria-label="Usage" className="panel grid gap-5 p-4 sm:grid-cols-3 sm:p-6">{stats.map(stat => <div key={stat.label} className="min-w-0"><p className="flex flex-wrap items-baseline justify-between gap-x-3"><span className="text-sm font-bold text-muted-foreground">{stat.label}</span><strong className="font-display text-2xl font-normal tabular-nums">{stat.value}</strong></p><div className="mt-2.5 h-2 overflow-hidden rounded-full bg-muted" aria-hidden><div className={`h-full rounded-full ${stat.fill}`} style={{ width: `${Math.max(2, Math.min(1, stat.used || 0) * 100)}%` }} /></div></div>)}</section>}
          {/* Columns flatten on mobile so `order` keeps panels in task order. */}
          <div className={`flex flex-col gap-5 ${owner ? "lg:grid lg:grid-cols-[minmax(0,1fr)_21rem] xl:grid-cols-[minmax(0,1fr)_24rem]" : ""}`}>
            <div className="contents lg:tile-stack lg:min-w-0 lg:gap-5">
              {form && settings && <form className="order-1 flex flex-col gap-5" onSubmit={event => { event.preventDefault(); if (!dirty || blocked) return; mutate({ kind: "settings", eventId: summary.eventId, requestId: crypto.randomUUID(), expectedRevision: settings.revision, settings: structuredClone(form) }); }}>
                <Section id="event-details-title" title="Details and dates" icon={CalendarClock} tone="amber"><EventHostForm value={form.event} onChange={event => setForm({ ...form, event })} disabled={recovery || !owner || blocked || deleted || expired} scheduleLocked={settings.locked} /></Section>
                <EventHostLook value={form.look} onChange={look => setForm({ ...form, look })} disabled={recovery || !owner || blocked || settings.locked || deleted || expired} />
                {(settings.locked || owner && !deleted && !expired) && <div className="flex flex-wrap items-center justify-between gap-3">
                  {settings.locked ? <p className="flex items-center gap-2 text-sm text-muted-foreground"><Lock size={15} className="shrink-0" aria-hidden />The look and caption are locked now that photos have come in.</p> : <span />}
                  {owner && !deleted && !expired && <button className="btn btn-primary min-w-28" disabled={recovery || blocked || !dirty} type="submit">Save</button>}
                </div>}
              </form>}
              {form && <div className="order-2"><EventHostTestPreview settings={form} disabled={task.busy || Boolean(pending) || exportBusy || exportDirty || reviewBusy || reminderBlocked || moderationBlocked || guestbookBlocked || Boolean(confirmation)} onBusyChange={setTestBusy} /></div>}
              {!recovery && reviewClient && !deleted && !expired && <div className="order-7"><EventHostContributionPreview client={reviewClient} eventId={summary.eventId} disabled={task.busy || Boolean(pending) || dirty || exportBusy || exportDirty || testBusy || reminderBlocked || moderationBlocked || guestbookBlocked || Boolean(confirmation)} onBusyChange={setReviewBusy} /></div>}
              {!recovery && moderationClient && !deleted && !expired && <div className="order-8"><EventModerationPanel client={moderationClient} hostClient={client} reviewClient={reviewClient} eventId={summary.eventId} expiresAt={dashboard?.event.expiresAt ?? summary.expiresAt} owner={owner} disabled={task.busy || Boolean(pending) || dirty || previewBusy || reminderBlocked || exportBusy || exportDirty || guestbookBlocked || Boolean(confirmation)} onBusyChange={setModerationBusy} onDirtyChange={setModerationDirty} /></div>}
              {dashboard && !deleted && !expired && <div className="order-9"><EventHostGuestbookPanel client={client} eventId={summary.eventId} owner={owner} startsAt={dashboard.event.startsAt} closesAt={dashboard.event.closesAt} timezone={dashboard.event.timezone} disabled={task.busy || Boolean(pending) || dirty || previewBusy || reminderBlocked || moderationBlocked || exportBusy || exportDirty || Boolean(confirmation)} onBusyChange={setGuestbookBusy} onDirtyChange={setGuestbookDirty} /></div>}
              {dashboard && <section aria-labelledby="event-submissions-title" className="order-11 panel overflow-hidden">
                <div className="flex items-center gap-3 px-4 pt-4 pb-3 sm:px-6 sm:pt-6"><EventGlyph icon={ListChecks} tone="sky" /><h2 id="event-submissions-title" className="font-display text-xl leading-tight">Guest photos</h2></div>
                {!dashboard.submissions.length ? <p className="px-4 pb-6 text-sm text-muted-foreground sm:px-6">No photos yet.</p> : <ul className="divide-y divide-border border-t border-border">{dashboard.submissions.map(item => <li key={item.submissionId} className="px-4 py-3 text-sm sm:px-6"><p className="break-all font-mono text-xs text-muted-foreground">{item.submissionId}</p><p className="mt-1"><span className="font-bold">{item.state}</span> · Gallery {item.gallery} · Wall {item.wall}</p>{["reserved", "uploading", "finalising", "failed", "expired"].includes(item.state) && <p className="mt-1 text-muted-foreground">Still uses space until it&apos;s cleaned up.</p>}</li>)}</ul>}
                {(after || dashboard.submissions.length === 25) && <div className="flex flex-wrap justify-end gap-2 border-t border-border p-3">{after && <button className={`${row} btn-plain`} disabled={blocked || dirty} onClick={() => void task.run((signal, check) => refresh(signal, check))}>First page</button>}{dashboard.submissions.length === 25 && <button className={`${row} btn-quiet`} disabled={blocked || dirty} onClick={() => void task.run((signal, check) => refresh(signal, check, dashboard.submissions.at(-1)!.submissionId))}>Next page</button>}</div>}
              </section>}
            </div>
            {/* Much shorter than the main column, so it stays in view instead of stretching. */}
            <div ref={sidebar} className="contents lg:sticky lg:top-[var(--sticky-top,5.5rem)] lg:flex lg:min-w-0 lg:flex-col lg:gap-5 lg:self-start">
              {owner && dashboard && !deleted && !expired && <Section id="event-invite-title" title="Invite guests" icon={QrCode} tone="violet" className="order-3">
                <div className="flex flex-wrap gap-2"><button className={`${row} btn-tinted`} disabled={recovery || blocked || dirty || dashboard.event.status !== "open"} onClick={() => mutate({ kind: "issue", eventId: summary.eventId, requestId: crypto.randomUUID(), expiresAt: dashboard.event.closesAt, rotate: false })}>Create invitation link</button><button className={`${row} btn-quiet`} disabled={recovery || blocked || dirty || dashboard.event.status !== "open"} onClick={() => setConfirmation({ kind: "mutation", title: "Replace all invitation links?", copy: "Older links will stop working for new guests. Guests who already joined keep access.", action: "Replace links", request: { kind: "issue", eventId: summary.eventId, requestId: crypto.randomUUID(), expiresAt: dashboard.event.closesAt, rotate: true } })}>Replace all links…</button></div>
                {invitation && <div className="mt-4"><label className="block text-sm font-bold" htmlFor="event-invite-link">Invitation link<input id="event-invite-link" className="field mt-1.5 text-sm font-medium" readOnly value={`${location.origin}/events/${summary.eventId}/join#invite=${invitation.token}`} onFocus={event => event.currentTarget.select()} /></label><EventInvitationQr eventId={summary.eventId} token={invitation.token} expiresAt={invitation.expiresAt} /><p className="mt-3 text-xs text-muted-foreground">Expires {new Date(invitation.expiresAt).toLocaleString("en-AU", { timeZone: summary.timezone })}. Copy it now, as it won&apos;t be shown again after you leave.</p><button className={`${row} btn-quiet mt-3`} disabled={blocked} onClick={() => setConfirmation({ kind: "mutation", title: "Revoke this invitation?", copy: "New guests won't be able to join with it. Guests who already joined keep access.", action: "Revoke invitation", request: { kind: "revoke", eventId: summary.eventId, token: invitation.token } })}>Revoke this invitation…</button></div>}
                <details className="panel-muted mt-4 px-4 text-sm"><summary className="min-h-11 cursor-pointer py-3 font-bold">Revoke an older link</summary><div className="pb-4"><label className="block font-bold" htmlFor="event-revoke-token">Invite code from the link<input id="event-revoke-token" className="field mt-1.5 font-mono text-sm" disabled={blocked || dirty} autoComplete="off" spellCheck={false} value={revokeToken} maxLength={43} onChange={event => setRevokeToken(event.target.value)} /></label><button className={`${row} btn-quiet mt-3`} disabled={blocked || dirty || !/^[A-Za-z0-9_-]{43}$/.test(revokeToken)} onClick={() => setConfirmation({ kind: "mutation", title: "Revoke this link?", copy: "Nobody new will be able to join with it.", action: "Revoke", request: { kind: "revoke", eventId: summary.eventId, token: revokeToken } })}>Revoke…</button></div></details>
              </Section>}
              {owner && dashboard && !deleted && !expired && <Section id="event-moderators-title" title="Moderators" icon={Users} tone="slate" className="order-4" bodyClassName="mt-3"><p className="text-sm text-muted-foreground">Only you can change settings or export.</p><label className="mt-4 block text-sm font-bold" htmlFor="event-moderator-id">Moderator account ID<input id="event-moderator-id" className="field mt-1.5 font-mono text-sm" value={moderatorId} onChange={event => setModeratorId(event.target.value)} disabled={blocked || dirty} autoComplete="off" spellCheck={false} maxLength={36} /></label><div className="mt-3 flex flex-wrap gap-2">{(["invite_moderator", "revoke_moderator"] as const).map(action => <button key={action} className={`${row} ${action === "invite_moderator" ? "btn-tinted" : "btn-quiet"}`} disabled={recovery && action === "invite_moderator" || blocked || dirty || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(moderatorId) || moderatorId === client.ownerId} onClick={() => setConfirmation({ kind: "mutation", title: action === "invite_moderator" ? "Invite this moderator?" : "Revoke this moderator?", copy: `${moderatorId}: ${action === "invite_moderator" ? "They can accept it from their events list." : "They'll lose moderator access to this event."}`, action: action === "invite_moderator" ? "Invite moderator" : "Revoke moderator", request: { kind: "moderator", eventId: summary.eventId, action, userId: moderatorId } })}>{action === "invite_moderator" ? "Invite moderator…" : "Revoke moderator…"}</button>)}</div></Section>}
              {owner && dashboard && !deleted && !expired && <Section id="event-kiosk-title" title={<span className="inline-flex items-center gap-1.5">Shared kiosk <HelpTooltip label="About shared kiosks">For a shared device at the event. Setup adds a PIN and signs you out before guests use it.</HelpTooltip></span>} icon={Tablet} tone="rose" className="order-5" action={<button type="button" className={`${row} btn-quiet`} disabled={recovery || blocked || dirty} onClick={() => router.push(`/e/${summary.eventId}/kiosk`)}>Set up kiosk</button>} />}
              {!recovery && owner && reminderClient && !deleted && !expired && <div className="order-6"><EventReminderPanel client={reminderClient} eventId={summary.eventId} disabled={task.busy || Boolean(pending) || dirty || exportBusy || exportDirty || previewBusy || moderationBlocked || guestbookBlocked || Boolean(confirmation)} onBusyChange={setReminderBusy} onDirtyChange={setReminderDirty} onInitialReadSettled={onReminderReadSettled} /></div>}
              {owner && exportClient && <div className="order-10"><EventExportPanel client={exportClient} eventId={summary.eventId} disabled={Boolean(!recovery && reminderClient && !deleted && !expired && !reminderReadSettled) || task.busy || Boolean(pending) || dirty || previewBusy || reminderBlocked || moderationBlocked || guestbookBlocked || Boolean(confirmation)} onBusyChange={setExportBusy} onDirtyChange={setExportDirty} /></div>}
            </div>
          </div>
        </>}
      </div>
    </div>
    {confirmation && <EventHostConfirm fallbackFocusRef={heading} returnFocus={confirmation.returnFocus} title={confirmation.kind === "mutation" ? confirmation.title : confirmation.kind === "back" ? "Leave this event?" : confirmation.kind === "refresh" ? "Discard unsaved changes?" : "Dismiss?"} action={confirmation.kind === "mutation" ? confirmation.action : confirmation.kind === "back" ? "Leave" : confirmation.kind === "refresh" ? "Refresh" : "Dismiss"} busy={task.busy} onKeep={() => setConfirmation(null)} onConfirm={performConfirmation}><p>{confirmation.kind === "mutation" ? confirmation.copy : confirmation.kind === "refresh" ? "Refreshing discards your unsaved changes." : confirmation.kind === "dismiss" ? "If it already went through, it stays. Refresh afterwards to check." : "Unsaved changes and this page's retry details will be lost. An earlier request may have worked. Refresh the event before repeating it."}</p></EventHostConfirm>}
  </>;
}
