"use client";
import { useEffect, useRef } from "react";
import { useAuth } from "@/lib/auth";
import { createClient } from "@/lib/supabase/client";
import { EventClientError } from "@/lib/events/client";
import type { PostcardSource } from "@/lib/events/postcard-contract";
import { EventPostcardComposer } from "./EventPostcardComposer";

export function EventPostcardEntry(props: { eventId: string; postcardId: string; source: PostcardSource; available: boolean }) {
  const { user, loading } = useAuth();
  return <main className="mx-auto min-h-dvh max-w-3xl px-5 py-7 sm:px-8 sm:py-10"><h1 className="mt-8 font-display text-4xl font-semibold sm:text-5xl">A postcard from everyone.</h1><p className="mb-8 mt-4 max-w-2xl leading-relaxed text-foreground/75">Review, approve or withdraw your shared photo. Return using the same guest session.</p>{!props.available ? <p role="status" className="rounded-xl bg-muted p-5">Event postcards are unavailable here. Keep your shared result and ask the host to check the event.</p> : loading ? <p role="status">Checking your account…</p> : <Entry key={user?.id ?? "anonymous"} {...props} ownerId={user?.id ?? null} />}</main>;
}
function Entry({ eventId, postcardId, source, ownerId }: { eventId: string; postcardId: string; source: PostcardSource; ownerId: string | null }) {
  const alive = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const assertSourceActive = (signal?: AbortSignal) => { if (!alive.current || signal?.aborted) throw new EventClientError("cancelled"); };
  return <EventPostcardComposer source={source} initialEventId={eventId} initialPostcardId={postcardId} assertSourceActive={assertSourceActive} sourceAccessToken={async () => { assertSourceActive(); if (!ownerId) return null; const result = await createClient().auth.getSession(); assertSourceActive(); return !result.error && result.data.session?.user.id === ownerId ? result.data.session.access_token : null; }} />;
}
