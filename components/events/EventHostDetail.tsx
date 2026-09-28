"use client";
import { useRecoveryRelease } from "@/components/ReleaseMode";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Tablet } from "lucide-react";
import { HelpTooltip } from "@/components/HelpTooltip";
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
import { EventHostConfirm, eventControl, eventInput, useEventLeaveWarning } from "./EventHostControls";
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
  const [after, setAfter] = useState<string | undefined>(), heading = useRef<HTMLHeadingElement>(null);
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
  if (task.lost) return <section className="border-t border-border py-8"><p role="alert">Your access to this event has changed.</p><button className={`${eventControl} mt-4 border border-border`} onClick={onBack}>Back to events</button></section>;
  return <section className="border-t border-border py-7">
    <div inert={Boolean(confirmation) || undefined}>
      <header className="flex flex-wrap items-start justify-between gap-4"><div className="min-w-0"><h2 ref={heading} tabIndex={-1} className="break-words font-display text-3xl outline-none">{dashboard?.event.title ?? summary.title}</h2><p className="mt-2 text-sm text-foreground/70">{owner ? "Owner" : "Moderator"} · {dashboard?.event.status ?? summary.status}{expired ? " · Expired" : ""}</p></div><button className={eventControl} disabled={task.busy || exportBusy || previewBusy || reminderBusy || moderationBusy || guestbookBusy} onClick={() => dirty || pending || exportDirty || reminderDirty || moderationDirty || guestbookDirty ? setConfirmation({ kind: "back" }) : onBack()}>Back to events</button></header>
      {task.error && <p role="alert" className="mt-4 max-w-3xl text-sm leading-relaxed">{task.error}</p>}
      {notice && <p role="status" className="mt-4 max-w-3xl text-sm leading-relaxed">{notice}</p>}
      {task.busy && <p role="status" className="mt-4 text-sm">Waiting for confirmation…</p>}
      {pending && <section aria-label="Unconfirmed event action" className="my-5 rounded-xl bg-muted p-4"><p className="max-w-3xl text-sm leading-relaxed">This {pending.kind === "issue" ? "invitation" : "change"} may have already gone through. Try again, or dismiss and refresh to check.</p><div className="mt-3 flex flex-wrap gap-2"><button className={`${eventControl} border border-border`} disabled={task.busy || pausedMutation(pending)} onClick={() => mutate(pending)}>Try again</button><button className={eventControl} disabled={task.busy} onClick={() => setConfirmation({ kind: "dismiss" })}>Dismiss…</button></div></section>}
      {!accepted ? <section className="mt-7 max-w-xl"><h3 className="font-display text-2xl">Moderator invitation</h3><p className="mt-3 text-sm leading-relaxed">Accept to help review guests&apos; photos.</p><button className={`${eventControl} mt-4 bg-accent text-accent-foreground`} disabled={recovery || task.busy || expired} onClick={accept}>Accept</button></section> : <>
        <button className={`${eventControl} mt-5 border border-border`} disabled={blocked} onClick={() => dirty ? setConfirmation({ kind: "refresh" }) : void task.run((signal, check) => refresh(signal, check))}>Refresh</button>
        {dashboard && <section className="my-7 grid gap-4 border-y border-border py-6 sm:grid-cols-3" aria-label="Usage"><p><strong className="font-display text-2xl">{dashboard.usage.guests} / {dashboard.event.maxGuests}</strong><span className="mt-1 block text-sm text-foreground/70">Guests</span></p><p><strong className="font-display text-2xl">{dashboard.usage.count} / {dashboard.event.maxContributions}</strong><span className="mt-1 block text-sm text-foreground/70">Photos</span></p><p><strong className="font-display text-2xl">{(dashboard.usage.bytes / 1000000).toFixed(1)} / {dashboard.event.maxBytes / 1000000} MB</strong><span className="mt-1 block text-sm text-foreground/70">Storage used</span></p></section>}
        {owner && dashboard && <div className="mb-7 flex flex-wrap gap-2">
          {!["open", "deleted", "closed"].includes(dashboard.event.status) && <button className={`${eventControl} bg-accent text-accent-foreground`} disabled={recovery || blocked || dirty || expired} onClick={() => askState("open")}>Open to guests</button>}
          {dashboard.event.status === "open" && <button className={`${eventControl} border border-border`} disabled={blocked || dirty || expired} onClick={() => askState("pause")}>Pause</button>}
          {!["closed", "deleted"].includes(dashboard.event.status) && <button className={`${eventControl} border border-border`} disabled={blocked || dirty || expired} onClick={() => askState("close")}>Close…</button>}
          {!deleted && <button className={eventControl} disabled={blocked || dirty} onClick={() => askState("delete")}>Delete event…</button>}
        </div>}
        {form && settings && <form className="space-y-6" onSubmit={event => { event.preventDefault(); if (!dirty || blocked) return; mutate({ kind: "settings", eventId: summary.eventId, requestId: crypto.randomUUID(), expectedRevision: settings.revision, settings: structuredClone(form) }); }}>
          <h3 className="font-display text-2xl">Details and dates</h3><EventHostForm value={form.event} onChange={event => setForm({ ...form, event })} disabled={recovery || !owner || blocked || deleted || expired} scheduleLocked={settings.locked} />
          <EventHostLook value={form.look} onChange={look => setForm({ ...form, look })} disabled={recovery || !owner || blocked || settings.locked || deleted || expired} />
          {settings.locked && <p className="text-sm text-foreground/70">The look and caption are locked now that photos have come in.</p>}
          {owner && !deleted && !expired && <button className={`${eventControl} bg-accent text-accent-foreground`} disabled={recovery || blocked || !dirty} type="submit">Save</button>}
        </form>}
        {form && <EventHostTestPreview settings={form} disabled={task.busy || Boolean(pending) || exportBusy || exportDirty || reviewBusy || reminderBlocked || moderationBlocked || guestbookBlocked || Boolean(confirmation)} onBusyChange={setTestBusy} />}
        {owner && dashboard && !deleted && !expired && <section className="mt-8 border-t border-border py-7"><h3 className="font-display text-2xl">Invite guests</h3><p className="mt-3 max-w-2xl text-sm leading-relaxed text-foreground/70">Share this link with your guests.</p>
          <div className="mt-4 flex flex-wrap gap-2"><button className={`${eventControl} border border-border`} disabled={recovery || blocked || dirty || dashboard.event.status !== "open"} onClick={() => mutate({ kind: "issue", eventId: summary.eventId, requestId: crypto.randomUUID(), expiresAt: dashboard.event.closesAt, rotate: false })}>Create invitation link</button><button className={eventControl} disabled={recovery || blocked || dirty || dashboard.event.status !== "open"} onClick={() => setConfirmation({ kind: "mutation", title: "Replace all invitation links?", copy: "Older links will stop working for new guests. Guests who already joined keep access.", action: "Replace links", request: { kind: "issue", eventId: summary.eventId, requestId: crypto.randomUUID(), expiresAt: dashboard.event.closesAt, rotate: true } })}>Replace all links…</button></div>
          {invitation && <div className="mt-4 max-w-3xl"><label className="block text-sm font-medium" htmlFor="event-invite-link">Invitation link<input id="event-invite-link" className={`${eventInput} mt-2`} readOnly value={`${location.origin}/events/${summary.eventId}/join#invite=${invitation.token}`} onFocus={event => event.currentTarget.select()} /></label><EventInvitationQr eventId={summary.eventId} token={invitation.token} expiresAt={invitation.expiresAt} /><p className="mt-2 text-xs text-foreground/70">Expires {new Date(invitation.expiresAt).toLocaleString("en-AU", { timeZone: summary.timezone })}. Copy it now, as it won&apos;t be shown again after you leave.</p><button className={`${eventControl} mt-2 border border-border`} disabled={blocked} onClick={() => setConfirmation({ kind: "mutation", title: "Revoke this invitation?", copy: "New guests won't be able to join with it. Guests who already joined keep access.", action: "Revoke invitation", request: { kind: "revoke", eventId: summary.eventId, token: invitation.token } })}>Revoke this invitation…</button></div>}
          <details className="mt-5 text-sm"><summary className="cursor-pointer py-2">Revoke an older link</summary><label className="mt-3 block" htmlFor="event-revoke-token">Invite code from the link<input id="event-revoke-token" className={`${eventInput} mt-2`} disabled={blocked || dirty} autoComplete="off" spellCheck={false} value={revokeToken} maxLength={43} onChange={event => setRevokeToken(event.target.value)} /></label><button className={`${eventControl} mt-2 border border-border`} disabled={blocked || dirty || !/^[A-Za-z0-9_-]{43}$/.test(revokeToken)} onClick={() => setConfirmation({ kind: "mutation", title: "Revoke this link?", copy: "Nobody new will be able to join with it.", action: "Revoke", request: { kind: "revoke", eventId: summary.eventId, token: revokeToken } })}>Revoke…</button></details>
        </section>}
        {owner && dashboard && !deleted && !expired && <section className="border-t border-border py-7"><h3 className="font-display text-2xl">Moderators</h3><p className="mt-3 text-sm text-foreground/70">Invite someone to help review photos. Only you can change settings or export.</p><label className="mt-4 block text-sm" htmlFor="event-moderator-id">Moderator account ID<input id="event-moderator-id" className={`${eventInput} mt-2`} value={moderatorId} onChange={event => setModeratorId(event.target.value)} disabled={blocked || dirty} autoComplete="off" spellCheck={false} maxLength={36} /></label><div className="mt-3 flex flex-wrap gap-2">{(["invite_moderator", "revoke_moderator"] as const).map(action => <button key={action} className={`${eventControl} border border-border`} disabled={recovery && action === "invite_moderator" || blocked || dirty || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(moderatorId) || moderatorId === client.ownerId} onClick={() => setConfirmation({ kind: "mutation", title: action === "invite_moderator" ? "Invite this moderator?" : "Revoke this moderator?", copy: `${moderatorId}: ${action === "invite_moderator" ? "They can accept it from their events list." : "They'll lose moderator access to this event."}`, action: action === "invite_moderator" ? "Invite moderator" : "Revoke moderator", request: { kind: "moderator", eventId: summary.eventId, action, userId: moderatorId } })}>{action === "invite_moderator" ? "Invite moderator…" : "Revoke moderator…"}</button>)}</div></section>}
        {owner && dashboard && !deleted && !expired && <section className="flex flex-wrap items-center justify-between gap-3 border-t border-border py-7">
          <h3 className="inline-flex items-center gap-2 font-display text-2xl">Shared kiosk <HelpTooltip label="About shared kiosks">For a shared device at the event. Setup adds a PIN and signs you out before guests use it.</HelpTooltip></h3>
          <button type="button" className={`${eventControl} border border-border`} disabled={recovery || blocked || dirty} onClick={() => router.push(`/e/${summary.eventId}/kiosk`)}><Tablet size={18} aria-hidden /> Set up kiosk</button>
        </section>}
        {exportBusy && <p role="status" className="my-4 text-sm">Exporting. Other controls are paused until it&apos;s done.</p>}
        {exportDirty && !exportBusy && <p role="status" className="my-4 text-sm">Finish or discard the export before changing this event.</p>}
        {reminderBusy && <p role="status" className="my-4 text-sm">Saving reminder settings…</p>}
        {reminderDirty && !reminderBusy && <p role="status" className="my-4 text-sm">Save or discard your reminder settings before changing this event.</p>}
        {!recovery && owner && reminderClient && !deleted && !expired && <EventReminderPanel client={reminderClient} eventId={summary.eventId} disabled={task.busy || Boolean(pending) || dirty || exportBusy || exportDirty || previewBusy || moderationBlocked || guestbookBlocked || Boolean(confirmation)} onBusyChange={setReminderBusy} onDirtyChange={setReminderDirty} onInitialReadSettled={onReminderReadSettled} />}
        {!recovery && reviewClient && !deleted && !expired && <EventHostContributionPreview client={reviewClient} eventId={summary.eventId} disabled={task.busy || Boolean(pending) || dirty || exportBusy || exportDirty || testBusy || reminderBlocked || moderationBlocked || guestbookBlocked || Boolean(confirmation)} onBusyChange={setReviewBusy} />}
        {!recovery && moderationClient && !deleted && !expired && <EventModerationPanel client={moderationClient} hostClient={client} reviewClient={reviewClient} eventId={summary.eventId} expiresAt={dashboard?.event.expiresAt ?? summary.expiresAt} owner={owner} disabled={task.busy || Boolean(pending) || dirty || previewBusy || reminderBlocked || exportBusy || exportDirty || guestbookBlocked || Boolean(confirmation)} onBusyChange={setModerationBusy} onDirtyChange={setModerationDirty} />}
        {dashboard && !deleted && !expired && <EventHostGuestbookPanel client={client} eventId={summary.eventId} owner={owner} startsAt={dashboard.event.startsAt} closesAt={dashboard.event.closesAt} timezone={dashboard.event.timezone} disabled={task.busy || Boolean(pending) || dirty || previewBusy || reminderBlocked || moderationBlocked || exportBusy || exportDirty || Boolean(confirmation)} onBusyChange={setGuestbookBusy} onDirtyChange={setGuestbookDirty} />}
        {owner && exportClient && <EventExportPanel client={exportClient} eventId={summary.eventId} disabled={Boolean(!recovery && reminderClient && !deleted && !expired && !reminderReadSettled) || task.busy || Boolean(pending) || dirty || previewBusy || reminderBlocked || moderationBlocked || guestbookBlocked || Boolean(confirmation)} onBusyChange={setExportBusy} onDirtyChange={setExportDirty} />}
        {dashboard && <section className="border-t border-border py-7"><h3 className="font-display text-2xl">Guest photos</h3>{!dashboard.submissions.length ? <p className="mt-4 text-sm">No photos yet.</p> : <ul className="mt-4 divide-y divide-border">{dashboard.submissions.map(item => <li key={item.submissionId} className="py-3 text-sm"><p className="break-all font-mono text-xs">{item.submissionId}</p><p className="mt-1">{item.state} · Gallery {item.gallery} · Wall {item.wall}</p>{["reserved", "uploading", "finalising", "failed", "expired"].includes(item.state) && <p className="mt-1 text-foreground/70">Still uses space until it&apos;s cleaned up.</p>}</li>)}</ul>}<div className="mt-4 flex gap-2">{after && <button className={eventControl} disabled={blocked || dirty} onClick={() => void task.run((signal, check) => refresh(signal, check))}>First page</button>}{dashboard.submissions.length === 25 && <button className={`${eventControl} border border-border`} disabled={blocked || dirty} onClick={() => void task.run((signal, check) => refresh(signal, check, dashboard.submissions.at(-1)!.submissionId))}>Next page</button>}</div></section>}
      </>}
    </div>
    {confirmation && <EventHostConfirm fallbackFocusRef={heading} returnFocus={confirmation.returnFocus} title={confirmation.kind === "mutation" ? confirmation.title : confirmation.kind === "back" ? "Leave this event?" : confirmation.kind === "refresh" ? "Discard unsaved changes?" : "Dismiss?"} action={confirmation.kind === "mutation" ? confirmation.action : confirmation.kind === "back" ? "Leave" : confirmation.kind === "refresh" ? "Refresh" : "Dismiss"} busy={task.busy} onKeep={() => setConfirmation(null)} onConfirm={performConfirmation}><p>{confirmation.kind === "mutation" ? confirmation.copy : confirmation.kind === "refresh" ? "Refreshing discards your unsaved changes." : confirmation.kind === "dismiss" ? "If it already went through, it stays. Refresh afterwards to check." : "Unsaved changes and this page's retry details will be lost. An earlier request may have worked. Refresh the event before repeating it."}</p></EventHostConfirm>}
  </section>;
}
