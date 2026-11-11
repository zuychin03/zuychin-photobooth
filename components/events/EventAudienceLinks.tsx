"use client";
import { useRecoveryRelease } from "@/components/ReleaseMode";

import { useEffect, useId, useRef, useState } from "react";
import { Dropdown } from "@/components/Dropdown";
import type { EventHostClient } from "@/lib/events/client";
import { EventInvitationQr } from "./EventInvitationQr";
import { Link2 } from "lucide-react";
import { EventHostConfirm, EventPanelHead, useEventLeaveWarning } from "./EventHostControls";
import { useEventHostTask } from "./useEventHostTask";

type Audience = "gallery" | "wall";
type Issue = { kind: "issue"; audience: Audience; requestId: string; expiresAt: string };
type Pending = Issue | { kind: "revoke"; audience: Audience; token: string };
type Issued = { audience: Audience; token: string; expiresAt: string };

export function EventAudienceLinks({ client, eventId, expiresAt, disabled = false, onBusyChange, onDirtyChange }: { client: EventHostClient; eventId: string; expiresAt: string; disabled?: boolean; onBusyChange?(busy: boolean): void; onDirtyChange?(dirty: boolean): void }) {
  const recovery = useRecoveryRelease();
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
    if (disabled || task.isBusy() || recovery && request.kind === "issue") return;
    setConfirm(null); setPending(request); setNotice(null);
    void task.run(async (signal, check) => {
      if (request.kind === "issue") {
        const result = await client.issue(eventId, { requestId: request.requestId, kind: request.audience === "wall" ? "display" : "gallery", expiresAt: request.expiresAt, rotate: false }, signal); check();
        if (document.hidden) { setNotice("The link was created while this page was in the background. Try again to show it here."); return; }
        setIssued({ audience: request.audience, ...result });
        setNotice("Link created. Copy it before you leave this page.");
      } else { await client.revokeToken(eventId, request.token, signal); check(); setIssued(null); setNotice("Link revoked. People viewing it will lose access within a few minutes."); }
      setPending(null);
    }).finally(() => { requestAnimationFrame(() => { if (alive.current) { if (link.current) link.current.focus(); else heading.current?.focus(); } }); });
  };
  if (task.lost) return <section className="panel p-4 sm:p-6"><p role="alert" className="font-bold">Your event access changed. Go back to your events and reopen this one.</p></section>;
  return <section className="panel p-4 sm:p-6" aria-labelledby={`${id}-title`}>
    <div inert={confirm ? true : undefined}>
      <EventPanelHead id={`${id}-title`} headingRef={heading} icon={Link2} tone="green">Gallery and wall links</EventPanelHead>
      <p className="mt-3 text-sm text-muted-foreground">People can view photos but not upload. Anyone with the link can open it or pass it on.</p>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Dropdown label="Link type" showLabel value={audience} disabled={disabled || task.busy || !!pending} options={[{ value: "gallery", label: "Event gallery" }, { value: "wall", label: "Event wall" }]} onChange={value => setAudience(value as Audience)} />
        <Dropdown label="Expires after" showLabel value={duration} disabled={disabled || task.busy || !!pending} options={[{ value: "1", label: "1 hour" }, { value: "24", label: "24 hours" }, { value: "event", label: "Until photos expire" }]} onChange={setDuration} />
      </div>
      {task.error && <p role="alert" className="notice mt-4 border border-destructive/25 bg-destructive/8">{task.error}</p>}{notice && <p role="status" className="notice mt-4">{notice}</p>}
      <div className="mt-4 flex flex-wrap gap-2">{pending ? <><button className="btn btn-quiet min-h-10 text-sm" disabled={disabled || task.busy || recovery && pending.kind === "issue"} onClick={() => run(pending)}>Try again</button><button className="btn btn-plain min-h-10 text-sm" disabled={disabled || task.busy} onClick={() => setConfirm("discard")}>Dismiss…</button></> : <button className="btn btn-tinted min-h-10 text-sm" disabled={recovery || disabled || task.busy || expired} onClick={() => setConfirm("issue")}>Create {audience} link…</button>}</div>
      {pending && <p className="mt-3 text-sm">The link may already exist. Try again to get it back.</p>}
      {visible && <div className="panel-muted mt-4 p-4"><label htmlFor={`${id}-link`} className="text-sm font-bold">Your {visible.audience} link</label><input ref={link} id={`${id}-link`} className="field mt-1.5 text-sm font-medium" readOnly value={`${location.origin}/e/${eventId}/${visible.audience}#token=${visible.token}`} onFocus={event => event.currentTarget.select()} /><p className="mt-2 text-xs text-muted-foreground">Expires {new Date(visible.expiresAt).toLocaleString("en-AU")}. Keep a copy in case you want to revoke it later.</p><EventInvitationQr eventId={eventId} token={visible.token} expiresAt={visible.expiresAt} audience={visible.audience} /><button className="btn btn-quiet mt-3 min-h-10 text-sm" disabled={disabled || task.busy || !!pending} onClick={() => setConfirm("revoke")}>Revoke this {visible.audience} link…</button></div>}
    </div>
    {confirm && <EventHostConfirm title={confirm === "issue" ? `Create a ${audience} link?` : confirm === "revoke" ? "Revoke this link?" : "Dismiss?"} action={confirm === "issue" ? "Create link" : confirm === "revoke" ? "Revoke link" : "Dismiss"} busy={task.busy} onKeep={() => setConfirm(null)} onConfirm={() => {
      if (confirm === "issue") run({ kind: "issue", audience, requestId: crypto.randomUUID(), expiresAt: new Date(Math.min(Date.parse(expiresAt), duration === "event" ? Infinity : Date.now() + Number(duration) * 3600000)).toISOString() });
      else if (confirm === "revoke" && visible) run({ kind: "revoke", audience: visible.audience, token: visible.token });
      else if (confirm === "discard") { setPending(null); setConfirm(null); setNotice("Dismissed. The link may still exist."); }
    }}><p>{confirm === "issue" ? `Anyone with this link can see approved ${audience} photos until it expires.` : confirm === "revoke" ? "This link will stop working. Downloaded copies can't be recalled." : "This doesn't revoke the link. Try again first if you want to get it back."}</p></EventHostConfirm>}
  </section>;
}
