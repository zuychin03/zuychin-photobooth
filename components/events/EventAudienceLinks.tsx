"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Dropdown } from "@/components/Dropdown";
import type { EventHostClient } from "@/lib/events/client";
import { EventInvitationQr } from "./EventInvitationQr";
import { EventHostConfirm, eventControl, eventInput, useEventLeaveWarning } from "./EventHostControls";
import { useEventHostTask } from "./useEventHostTask";

type Audience = "gallery" | "wall";
type Issue = { kind: "issue"; audience: Audience; requestId: string; expiresAt: string };
type Pending = Issue | { kind: "revoke"; audience: Audience; token: string };
type Issued = { audience: Audience; token: string; expiresAt: string };

export function EventAudienceLinks({ client, eventId, expiresAt, disabled = false, onBusyChange, onDirtyChange }: { client: EventHostClient; eventId: string; expiresAt: string; disabled?: boolean; onBusyChange?(busy: boolean): void; onDirtyChange?(dirty: boolean): void }) {
  const task = useEventHostTask(client), id = useId(), [audience, setAudience] = useState<Audience>("gallery"), [duration, setDuration] = useState("24"), [issued, setIssued] = useState<Issued | null>(null), [pending, setPending] = useState<Pending | null>(null), [confirm, setConfirm] = useState<"issue" | "revoke" | "discard" | null>(null), [notice, setNotice] = useState<string | null>(null), [now, setNow] = useState(Date.now);
  const callbacks = useRef({ onBusyChange, onDirtyChange }), heading = useRef<HTMLHeadingElement>(null), link = useRef<HTMLInputElement>(null), alive = useRef(false);
  useEffect(() => { callbacks.current = { onBusyChange, onDirtyChange }; }, [onBusyChange, onDirtyChange]);
  useEffect(() => { callbacks.current.onBusyChange?.(task.busy); }, [task.busy]);
  useEffect(() => { callbacks.current.onDirtyChange?.(!task.lost && (!!pending || !!confirm)); }, [pending, confirm, task.lost]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; callbacks.current.onBusyChange?.(false); callbacks.current.onDirtyChange?.(false); }; }, []);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); const hide = () => { if (document.hidden) setIssued(null); }; document.addEventListener("visibilitychange", hide); return () => { clearInterval(timer); document.removeEventListener("visibilitychange", hide); }; }, []);
  useEffect(() => { if (!task.lost) return; let current = true; queueMicrotask(() => { if (current && alive.current) { setIssued(null); setPending(null); setConfirm(null); setNotice(null); } }); return () => { current = false; }; }, [task.lost]);
  useEventLeaveWarning(!task.lost && !!pending);
  const expired = !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= now, visible = issued && Date.parse(issued.expiresAt) > now ? issued : null;
  const run = (request: Pending) => {
    if (disabled || task.isBusy()) return;
    setConfirm(null); setPending(request); setNotice(null);
    void task.run(async (signal, check) => {
      if (request.kind === "issue") {
        const result = await client.issue(eventId, { requestId: request.requestId, kind: request.audience === "wall" ? "display" : "gallery", expiresAt: request.expiresAt, rotate: false }, signal); check();
        if (document.hidden) { setNotice("The access action was confirmed while this page was hidden. Retry the exact action to reveal the link here."); return; }
        setIssued({ audience: request.audience, ...result });
        setNotice("Access link confirmed. Copy it before leaving this page. Creating another link does not revoke this one.");
      } else { await client.revokeToken(eventId, request.token, signal); check(); setIssued(null); setNotice("This access link has been revoked. Connected viewers will clear media on their next check; already-issued image links can last up to five minutes."); }
      setPending(null);
    }).finally(() => { requestAnimationFrame(() => { if (alive.current) { if (link.current) link.current.focus(); else heading.current?.focus(); } }); });
  };
  if (task.lost) return <section className="border-t border-border py-6"><p role="alert">Event access changed. This page cleared its private links and retry details. An earlier unconfirmed action may already have succeeded. Return to your events and reopen this event to check access.</p></section>;
  return <section className="border-t border-border py-6" aria-labelledby={`${id}-title`}>
    <div inert={confirm ? true : undefined}>
      <h3 ref={heading} tabIndex={-1} id={`${id}-title`} className="font-display text-2xl outline-none">Gallery and wall links</h3>
      <p className="mt-3 max-w-2xl text-sm leading-relaxed text-foreground/70">Create separate gallery and wall links. Each shows approved, consenting photos and cannot be used to upload.</p>
      <div className="mt-4 grid max-w-xl gap-4 sm:grid-cols-2">
        <Dropdown label="Audience access" showLabel value={audience} disabled={disabled || task.busy || !!pending} options={[{ value: "gallery", label: "Event gallery" }, { value: "wall", label: "Event wall" }]} onChange={value => setAudience(value as Audience)} />
        <Dropdown label="Link lifetime" showLabel value={duration} disabled={disabled || task.busy || !!pending} options={[{ value: "1", label: "1 hour" }, { value: "24", label: "24 hours" }, { value: "event", label: "Until photos expire" }]} onChange={setDuration} />
      </div>
      <p className="mt-3 text-xs leading-relaxed text-foreground/70">A link always expires by the event&apos;s retention deadline. Anyone holding it can use or forward it.</p>
      {task.error && <p role="alert" className="mt-3 text-sm">{task.error}</p>}{notice && <p role="status" className="mt-3 text-sm leading-relaxed">{notice}</p>}
      <div className="mt-4 flex flex-wrap gap-2">{pending ? <><button className={`${eventControl} border border-border`} disabled={disabled || task.busy} onClick={() => run(pending)}>Retry exact access action</button><button className={eventControl} disabled={disabled || task.busy} onClick={() => setConfirm("discard")}>Dismiss access retry…</button></> : <button className={`${eventControl} border border-border`} disabled={disabled || task.busy || expired} onClick={() => setConfirm("issue")}>Create {audience} access…</button>}</div>
      {pending && <p className="mt-3 text-sm leading-relaxed">The link may already exist. Retry here to recover it without creating another; leaving loses this retry.</p>}
      {visible && <div className="mt-5 max-w-xl"><label htmlFor={`${id}-link`} className="text-sm font-medium">Private {visible.audience} link</label><input ref={link} id={`${id}-link`} className={`${eventInput} mt-2`} readOnly value={`${location.origin}/e/${eventId}/${visible.audience}#token=${visible.token}`} onFocus={event => event.currentTarget.select()} /><p className="mt-2 text-xs text-foreground/70">Expires {new Date(visible.expiresAt).toLocaleString("en-AU")}. Keep a copy if you need to revoke this exact token later.</p><EventInvitationQr eventId={eventId} token={visible.token} expiresAt={visible.expiresAt} audience={visible.audience} /><button className={`${eventControl} mt-3 border border-border`} disabled={disabled || task.busy || !!pending} onClick={() => setConfirm("revoke")}>Revoke this {visible.audience} link…</button></div>}
    </div>
    {confirm && <EventHostConfirm title={confirm === "issue" ? `Create ${audience} access?` : confirm === "revoke" ? "Revoke this audience link?" : "Dismiss this access retry?"} action={confirm === "issue" ? "Create access link" : confirm === "revoke" ? "Revoke access link" : "Dismiss local retry"} busy={task.busy} onKeep={() => setConfirm(null)} onConfirm={() => {
      if (confirm === "issue") run({ kind: "issue", audience, requestId: crypto.randomUUID(), expiresAt: new Date(Math.min(Date.parse(expiresAt), duration === "event" ? Infinity : Date.now() + Number(duration) * 3600000)).toISOString() });
      else if (confirm === "revoke" && visible) run({ kind: "revoke", audience: visible.audience, token: visible.token });
      else if (confirm === "discard") { setPending(null); setConfirm(null); setNotice("Only the local retry record was removed. An earlier access link may still exist."); }
    }}><p>{confirm === "issue" ? `Anyone with this link can open approved ${audience} photos until it expires. Creating the link does not approve or publish any photo.` : confirm === "revoke" ? "This stops new checks using the selected link. Other audience links and private guest receipts remain separate. Existing downloaded copies cannot be recalled." : "This does not revoke a link or undo a server action. Retrying first is the only way to recover an unconfirmed link from this page."}</p></EventHostConfirm>}
  </section>;
}
