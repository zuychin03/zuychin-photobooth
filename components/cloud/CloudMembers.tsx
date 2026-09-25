"use client";

import { useEffect, useState } from "react";
import { Copy, UserPlus } from "lucide-react";
import { cloudUuid, type CloudProjectView } from "@/lib/projects/cloud-contract";
import type { CloudProjectClient } from "@/lib/projects/cloud-client";
import { cloudControl, cloudInput } from "./CloudControls";

export function CloudInvitationId({ ownerId }: { ownerId: string }) {
  const [copied, setCopied] = useState(false), [failed, setFailed] = useState(false);
  const copy = async () => {
    setCopied(false); setFailed(false);
    try { await navigator.clipboard.writeText(ownerId); setCopied(true); } catch { setFailed(true); }
  };
  return <details className="mt-6 border-t border-border pt-4 text-sm">
    <summary className="cursor-pointer py-2 font-medium focus-visible:outline-2 focus-visible:outline-ring">Your invitation ID</summary>
    <p className="mt-3 max-w-xl leading-relaxed text-foreground/70">Share this ID with a friend who wants to invite you. You still choose whether to accept each project invitation.</p>
    <div className="mt-3 flex max-w-xl flex-wrap items-center gap-2"><input aria-label="Your invitation ID" readOnly value={ownerId} className={`${cloudInput} flex-1 basis-64 font-mono text-sm`} onFocus={event => event.target.select()} /><button className={`${cloudControl} border border-border`} onClick={() => void copy()}><Copy size={16} aria-hidden /> Copy ID</button></div>
    {(copied || failed) && <p role="status" className="mt-2">{copied ? "Invitation ID copied." : "Select the ID above and copy it with your device's copy command."}</p>}
  </details>;
}

interface Props { client: CloudProjectClient; view: CloudProjectView; disabled: boolean; onUpdated(view: CloudProjectView): void; runAction(name: string, work: (signal: AbortSignal) => Promise<void>): Promise<void> }

export function CloudMembers({ client, view, disabled, onUpdated, runAction }: Props) {
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
    catch { setError("Enter the full invitation ID from your friend's cloud library."); return; }
    if (action === "invite" && (checked === client.ownerId || view.members.some(member => member.userId === checked))) {
      setError("That person already has a place in this project. Removed people need a new project invitation in a new project."); return;
    }
    await runAction("membership", async signal => {
      await client.member(view.project.id, checked, action, signal);
      const latest = await client.view(view.project.id, signal); client.assertActive(signal);
      if (!signal.aborted) {
        onUpdated(latest); setInviteId(""); setRemoving(null);
        setNotice(action === "invite" ? "Invitation added. Your friend can accept it from their cloud library. No message was sent." : "New project access is blocked for this person. Previously issued links may work for up to five minutes; downloaded copies remain.");
        setFocusTarget("cloud-members-heading");
      }
    });
  };
  if (view.project.kind !== "friend") return null;
  return <section aria-labelledby="cloud-members-heading" className="mt-8 border-t border-border pt-6">
    <h3 id="cloud-members-heading" tabIndex={-1} className="text-lg font-semibold outline-none">People in this project</h3>
    <p className="mt-2 max-w-2xl text-sm leading-relaxed text-foreground/70">Up to four people, including you. Accepted members can see ordinary originals. Challenge photos follow their separate reveal rules.</p>
    {error && <p role="alert" className="mt-3 rounded-xl bg-muted p-4 text-sm">{error}</p>}
    {notice && <p role="status" className="mt-3 max-w-2xl rounded-xl bg-muted p-4 text-sm leading-relaxed">{notice}</p>}
    <ul className="mt-4" aria-label="Project members">{view.members.map((member, index) => <li key={member.userId} className="border-t border-border py-4">
      <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><p className="font-medium">{member.userId === client.ownerId ? "You" : member.userId === view.project.ownerId ? "Project owner" : `Friend ${index + 1}`} · {member.status === "invited" ? "Invitation pending" : member.status === "revoked" ? "Access removed" : "Joined"}</p><p className="mt-1 break-all font-mono text-xs text-foreground/65">{member.userId}</p></div>
      {owned && member.userId !== client.ownerId && member.status !== "revoked" && <button id={`member-remove-${member.userId}`} className={`${cloudControl} underline underline-offset-4`} disabled={locked} onClick={() => { setRemoving(member.userId); setFocusTarget(`member-confirm-${member.userId}`); }}>{member.status === "invited" ? "Cancel invitation…" : "Remove access…"}</button>}</div>
      {removing === member.userId && <div className="mt-3 max-w-2xl rounded-xl bg-muted p-4"><p className="text-sm leading-relaxed">Remove this person from this project? They cannot rejoin it, and their place cannot be reused. Their ordinary originals stay in the project; ongoing challenges may lose access to their contribution. Existing links may work for five minutes, and downloaded copies remain. Create a new project if the group changes.</p><div className="mt-3 flex flex-wrap gap-2"><button id={`member-confirm-${member.userId}`} disabled={locked} className={`${cloudControl} border border-border`} onClick={() => void change(member.userId, "revoke")}>Remove project access</button><button disabled={locked} className={cloudControl} onClick={() => { setRemoving(null); setFocusTarget(`member-remove-${member.userId}`); }}>Keep access</button></div></div>}
    </li>)}</ul>
    {owned && view.members.length < 4 && <form className="mt-5 max-w-xl" onSubmit={event => { event.preventDefault(); void change(inviteId, "invite"); }}>
      <label className="block text-sm font-medium">Friend&apos;s invitation ID<input className={`${cloudInput} mt-2 font-mono text-sm`} value={inviteId} onChange={event => setInviteId(event.target.value)} maxLength={36} required autoComplete="off" spellCheck={false} disabled={locked} /></label>
      <p className="mt-2 text-sm leading-relaxed text-foreground/70">Ask your friend to copy their ID from their cloud library. The invitation shows this project&apos;s name before they accept. Each invited person uses one of the project&apos;s four places permanently.</p>
      <button className={`${cloudControl} mt-3 bg-accent text-accent-foreground`} disabled={locked || !inviteId.trim()}><UserPlus size={16} aria-hidden /> Invite to project</button>
    </form>}
    {owned && view.members.length >= 4 && <p className="mt-3 max-w-xl text-sm leading-relaxed text-foreground/70">All four places have been used. Start a new project for a different group.</p>}
  </section>;
}
