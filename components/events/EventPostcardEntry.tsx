"use client";
import { useEffect, useRef } from "react";
import { LoaderCircle } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { useAuth } from "@/lib/auth";
import { createClient } from "@/lib/supabase/client";
import { EventClientError } from "@/lib/events/client";
import type { PostcardSource } from "@/lib/events/postcard-contract";
import { EventPostcardComposer } from "./EventPostcardComposer";

export function EventPostcardEntry(props: { eventId: string; postcardId: string; source: PostcardSource; available: boolean }) {
  const { user, loading } = useAuth();
  return <main className="mx-auto flex min-h-dvh w-full max-w-3xl flex-1 flex-col gap-6 px-4 pt-4 pb-10 sm:px-8 sm:pt-6"><PageHeader title="A postcard from everyone." /><div className="page-body">{!props.available ? <p role="status" className="notice">Event postcards aren&apos;t available here. Ask the host for help.</p> : loading ? <p role="status" className="panel flex min-h-40 items-center justify-center gap-2 text-sm text-muted-foreground"><LoaderCircle size={18} className="animate-spin motion-reduce:animate-none" aria-hidden /> Checking your account…</p> : <div className="panel p-4 sm:p-6"><Entry key={user?.id ?? "anonymous"} {...props} ownerId={user?.id ?? null} /></div>}</div></main>;
}
function Entry({ eventId, postcardId, source, ownerId }: { eventId: string; postcardId: string; source: PostcardSource; ownerId: string | null }) {
  const alive = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const assertSourceActive = (signal?: AbortSignal) => { if (!alive.current || signal?.aborted) throw new EventClientError("cancelled"); };
  return <EventPostcardComposer source={source} initialEventId={eventId} initialPostcardId={postcardId} assertSourceActive={assertSourceActive} sourceAccessToken={async () => { assertSourceActive(); if (!ownerId) return null; const result = await createClient().auth.getSession(); assertSourceActive(); return !result.error && result.data.session?.user.id === ownerId ? result.data.session.access_token : null; }} />;
}
