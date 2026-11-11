"use client";
import { useRecoveryRelease } from "@/components/ReleaseMode";

import { useEffect, useState } from "react";
import { ChevronDown, Copy, IdCard, UserPlus, UserRound, Users } from "lucide-react";
import { cloudUuid, type CloudProjectView } from "@/lib/projects/cloud-contract";
import type { CloudProjectClient } from "@/lib/projects/cloud-client";

export function CloudInvitationId({ ownerId }: { ownerId: string }) {
  const [copied, setCopied] = useState(false), [failed, setFailed] = useState(false);
  const copy = async () => {
    setCopied(false); setFailed(false);
    try { await navigator.clipboard.writeText(ownerId); setCopied(true); } catch { setFailed(true); }
  };
  return <details className="group panel p-4 text-sm sm:p-6">
    <summary className="flex min-h-9 cursor-pointer list-none items-center gap-3 rounded-xl focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring [&::-webkit-details-marker]:hidden"><span className="glyph bg-[#8b5cf6]"><IdCard size={18} strokeWidth={2.25} aria-hidden /></span><span className="flex-1 font-display text-xl leading-tight">Your invitation ID</span><ChevronDown size={18} aria-hidden className="text-muted-foreground transition-transform duration-300 ease-[var(--spring-soft)] group-open:rotate-180 motion-reduce:transition-none" /></summary>
    <p className="mt-4 text-muted-foreground">Give this ID to a friend so they can invite you to a project.</p>
    <div className="mt-3 flex flex-wrap items-center gap-2"><input aria-label="Your invitation ID" readOnly value={ownerId} className="field flex-1 basis-64 font-mono text-sm" onFocus={event => event.target.select()} /><button className="btn btn-partner min-h-10 text-sm" onClick={() => void copy()}><Copy size={16} aria-hidden /> Copy ID</button></div>
    {(copied || failed) && <p role="status" className="mt-2">{copied ? "Copied." : "Couldn't copy. Select the ID and copy it yourself."}</p>}
  </details>;
}

interface Props { client: CloudProjectClient; view: CloudProjectView; disabled: boolean; onUpdated(view: CloudProjectView): void; runAction(name: string, work: (signal: AbortSignal) => Promise<void>): Promise<void> }

export function CloudMembers({ client, view, disabled, onUpdated, runAction }: Props) {
  const recovery = useRecoveryRelease();
  const [inviteId, setInviteId] = useState("");
  const [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null), [focusTarget, setFocusTarget] = useState<string | null>(null);
  const owned = view.project.ownerId === client.ownerId, locked = disabled;
  useEffect(() => { if (focusTarget && !disabled) document.getElementById(focusTarget)?.focus(); }, [focusTarget, disabled]);
  const change = async (userId: string, action: "invite" | "revoke") => {
    if (disabled) return;
    setError(null); setNotice(null);
    let checked: string;
    try { checked = cloudUuid(userId.trim().toLowerCase()); }
    catch { setError("Enter your friend's full invitation ID."); return; }
    if (action === "invite" && (checked === client.ownerId || view.members.some(member => member.userId === checked))) {
      setError("That person is already in this project. People you've removed can only join a new project."); return;
    }
    await runAction("membership", async signal => {
      await client.member(view.project.id, checked, action, signal);
      const latest = await client.view(view.project.id, signal); client.assertActive(signal);
      if (!signal.aborted) {
        onUpdated(latest); setInviteId(""); setRemoving(null);
        setNotice(action === "invite" ? "Invited. Let your friend know, as no message is sent. They can accept it from their cloud library." : "Access removed. Links they already have may keep working for up to five minutes.");
        setFocusTarget("cloud-members-heading");
      }
    });
  };
  if (view.project.kind !== "friend") return null;
  const spots = view.members.length;
  return <section aria-labelledby="cloud-members-heading" className="panel p-4 sm:p-6">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-3"><span className="glyph bg-[#8b5cf6]"><Users size={18} strokeWidth={2.25} aria-hidden /></span><h3 id="cloud-members-heading" tabIndex={-1} className="font-display text-xl leading-tight outline-none">People in this project</h3></div>
      <div className="flex items-center gap-2" aria-hidden><span className="flex gap-1">{[0, 1, 2, 3].map(spot => <span key={spot} className={`h-2 w-5 rounded-full ${spot < spots ? "bg-[#8b5cf6]" : "bg-muted"}`} />)}</span><span className="text-sm font-bold tabular-nums text-muted-foreground">{spots}/4</span></div>
    </div>
    <p className="mt-3 text-sm text-muted-foreground">Up to four people, including you. Members can see project photos once they accept.</p>
    {error && <p role="alert" className="notice mt-3 border border-destructive/25 bg-destructive/8 font-bold text-destructive">{error}</p>}
    {notice && <p role="status" className="notice mt-3">{notice}</p>}
    <ul className="mt-3 divide-y divide-border" aria-label="Project members">{view.members.map((member, index) => <li key={member.userId} className="py-3.5">
      <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex min-w-0 items-center gap-3"><span className={`flex size-10 shrink-0 items-center justify-center rounded-full ${member.status === "revoked" ? "bg-muted text-muted-foreground" : "bg-partner/15 text-partner"}`}><UserRound size={18} aria-hidden /></span><div className="min-w-0"><p className="font-bold">{member.userId === client.ownerId ? "You" : member.userId === view.project.ownerId ? "Project owner" : `Friend ${index + 1}`} · <span className="font-medium text-muted-foreground">{member.status === "invited" ? "Invitation pending" : member.status === "revoked" ? "Access removed" : "Joined"}</span></p><p className="mt-0.5 break-all font-mono text-xs text-muted-foreground">{member.userId}</p></div></div>
      {owned && member.userId !== client.ownerId && member.status !== "revoked" && <button id={`member-remove-${member.userId}`} className="btn btn-plain min-h-10 text-sm text-destructive" disabled={locked} onClick={() => { setRemoving(member.userId); setFocusTarget(`member-confirm-${member.userId}`); }}>{member.status === "invited" ? "Cancel invitation…" : "Remove access…"}</button>}</div>
      {removing === member.userId && <div className="notice mt-3"><p>Remove this person? They can&apos;t rejoin, and their spot can&apos;t be reused. Their photos stay, but open challenges may lose their entries. Existing links may work for five minutes; downloaded copies remain.</p><div className="mt-3 flex flex-wrap gap-2"><button id={`member-confirm-${member.userId}`} disabled={locked} className="btn btn-danger min-h-10 text-sm" onClick={() => void change(member.userId, "revoke")}>Remove</button><button disabled={locked} className="btn btn-quiet min-h-10 text-sm" onClick={() => { setRemoving(null); setFocusTarget(`member-remove-${member.userId}`); }}>Cancel</button></div></div>}
    </li>)}</ul>
    {owned && view.members.length < 4 && <form className="panel-muted mt-3 p-4" onSubmit={event => { event.preventDefault(); void change(inviteId, "invite"); }}>
      <label className="block text-sm font-bold">Friend&apos;s invitation ID<input className="field mt-1.5 font-mono text-sm" value={inviteId} onChange={event => setInviteId(event.target.value)} maxLength={36} required autoComplete="off" spellCheck={false} disabled={locked} /></label>
      <p className="mt-2 text-sm text-muted-foreground">Your friend can find their ID in their cloud library. Each invite permanently uses one of the four spots.</p>
      <button className="btn btn-partner mt-3 min-h-10 text-sm" disabled={recovery || locked || !inviteId.trim()}><UserPlus size={16} aria-hidden /> Invite to project</button>
    </form>}
    {owned && view.members.length >= 4 && <p className="mt-3 text-sm text-muted-foreground">All four spots are used. Start a new project for a different group.</p>}
  </section>;
}
