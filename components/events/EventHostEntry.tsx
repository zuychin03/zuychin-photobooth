"use client";
import { useAppNavigationGuard } from "@/components/AppNavigation";
import Link from "next/link";
import { useState } from "react";
import { useAuth } from "@/lib/auth";
import { useEventHostRuntime } from "@/hooks/useEventHostRuntime";
import { EventHostWorkspace } from "./EventHostWorkspace";
import { eventControl } from "./EventHostControls";

function AccountEvents({ ownerId, eventId, onDirtyChange }: { ownerId: string; eventId?: string; onDirtyChange(dirty: boolean): void }) {
  const { client, exportClient, reviewClient, reminderClient, moderationClient, error } = useEventHostRuntime(ownerId);
  if (error) return <p role="alert" className="mt-8">Your event workspace closed because account access changed or could not be checked. Refresh to try again.</p>;
  return client ? <EventHostWorkspace client={client} exportClient={exportClient} reviewClient={reviewClient} reminderClient={reminderClient} moderationClient={moderationClient} initialEventId={eventId} onDirtyChange={onDirtyChange} /> : <p role="status" className="mt-8">Opening your account’s events…</p>;
}
export function EventHostEntry({ configured, eventId }: { configured: boolean; eventId?: string }) {
  const { user, loading, enabled } = useAuth();
  const [dirty, setDirty] = useState(false), [leaveNotice, setLeaveNotice] = useState(false);
  useAppNavigationGuard(() => { if (!dirty) return true; setLeaveNotice(true); return false; });
  return <main className="mx-auto min-h-dvh max-w-6xl px-5 py-6 sm:px-8">
    {leaveNotice && dirty && <p role="status" className="mt-3 text-sm">Finish or cancel the current event changes before leaving. Use Back to events to review unsaved changes.</p>}
    <header className="my-8 max-w-2xl"><h1 className="mt-2 font-display text-4xl font-semibold sm:text-5xl">Your events</h1><p className="mt-4 leading-relaxed text-foreground/70">Collect photos from your guests. Set the dates, then invite them.</p></header>
    {!configured || !enabled ? <section className="border-t border-border py-8"><h2 className="font-display text-2xl">Events are unavailable here</h2><p className="mt-3 max-w-xl text-sm leading-relaxed">Event hosting is unavailable here. You can still save photos on this device.</p><Link href="/booth" className={`${eventControl} mt-4 border border-border`}>Open the booth</Link></section> : loading ? <p role="status">Checking your account…</p> : user ? <AccountEvents key={user.id} ownerId={user.id} eventId={eventId} onDirtyChange={setDirty} /> : <section className="border-t border-border py-8"><h2 className="font-display text-2xl">Sign in to host an event</h2><p className="mt-3 text-sm">Guests use a separate invitation and do not need an account.</p><Link href={`/login?next=${encodeURIComponent(eventId ? `/events/${eventId}` : "/events")}`} className={`${eventControl} mt-4 bg-accent text-accent-foreground`}>Sign in</Link></section>}
  </main>;
}
