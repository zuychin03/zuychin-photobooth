"use client";
import { useAppNavigationGuard } from "@/components/AppNavigation";
import Link from "next/link";
import { useState } from "react";
import { useAuth } from "@/lib/auth";
import { useEventHostRuntime } from "@/hooks/useEventHostRuntime";
import { CalendarHeart, Camera, LoaderCircle, LogIn } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { EventHostWorkspace } from "./EventHostWorkspace";

function Waiting({ children }: { children: React.ReactNode }) {
  return <><PageHeader title="Your events" /><p role="status" className="page-body panel flex min-h-48 items-center justify-center gap-2 text-sm text-muted-foreground"><LoaderCircle size={18} className="animate-spin motion-reduce:animate-none" aria-hidden /> {children}</p></>;
}
function AccountEvents({ ownerId, eventId, onDirtyChange }: { ownerId: string; eventId?: string; onDirtyChange(dirty: boolean): void }) {
  const { client, exportClient, reviewClient, reminderClient, moderationClient, error } = useEventHostRuntime(ownerId);
  if (error) return <><PageHeader title="Your events" /><p role="alert" className="page-body notice border border-destructive/25 bg-destructive/8">Couldn&apos;t check your account. Refresh to try again.</p></>;
  return client ? <EventHostWorkspace client={client} exportClient={exportClient} reviewClient={reviewClient} reminderClient={reminderClient} moderationClient={moderationClient} initialEventId={eventId} onDirtyChange={onDirtyChange} /> : <Waiting>Opening your events…</Waiting>;
}
export function EventHostEntry({ configured, eventId }: { configured: boolean; eventId?: string }) {
  const { user, loading, enabled } = useAuth();
  const [dirty, setDirty] = useState(false), [leaveNotice, setLeaveNotice] = useState(false);
  useAppNavigationGuard(() => { if (!dirty) return true; setLeaveNotice(true); return false; });
  const empty = "page-body panel flex min-h-64 flex-col items-center justify-center gap-4 px-6 py-12 text-center";
  return <main className="mx-auto flex min-h-dvh w-full max-w-6xl flex-1 flex-col gap-6 px-4 pt-4 pb-10 sm:px-8 sm:pt-6">
    {leaveNotice && dirty && <p role="status" className="notice max-w-2xl">You have unsaved changes. Use Back to events to review them before you leave.</p>}
    {!configured || !enabled ? <><PageHeader title="Your events" /><section className={empty}><span className="glyph size-14 rounded-2xl bg-[#f59e0b]"><CalendarHeart size={26} aria-hidden /></span><h2 className="font-display text-2xl">Events aren&apos;t available here</h2><Link href="/booth" className="btn btn-quiet"><Camera size={17} aria-hidden /> Open the booth</Link></section></> : loading ? <Waiting>Checking your account…</Waiting> : user ? <AccountEvents key={user.id} ownerId={user.id} eventId={eventId} onDirtyChange={setDirty} /> : <><PageHeader title="Your events" /><section className={empty}><span className="glyph size-14 rounded-2xl bg-[#f59e0b]"><CalendarHeart size={26} aria-hidden /></span><h2 className="font-display text-2xl">Sign in to host an event</h2><Link href={`/login?next=${encodeURIComponent(eventId ? `/events/${eventId}` : "/events")}`} className="btn btn-primary"><LogIn size={17} aria-hidden /> Sign in</Link></section></>}
  </main>;
}
