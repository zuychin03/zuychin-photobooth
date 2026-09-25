"use client";

import { useEffect, useRef, useState, type ComponentType, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Camera, LoaderCircle, RefreshCw } from "lucide-react";
import { createRoomEntryApi, forgetRememberedRoom, rememberedRoomId, rememberRoom, roomDisplayName, roomEntryError, roomV2Url, type V2RoomTarget } from "@/lib/rtc/entry-v2";
import { createRoomApi, RoomApiError } from "@/lib/rtc/signaling-v2";
import type { RoomState } from "@/lib/server/room-contract";

const control = "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-wait disabled:opacity-50";

export default function RoomEntry({ target, ownerScope, Workspace }: { target: V2RoomTarget; ownerScope: string; Workspace: ComponentType<{ initial: RoomState }> }) {
  const router = useRouter(), controller = useRef<AbortController | null>(null), submitting = useRef(false);
  const [phase, setPhase] = useState<"loading" | "form" | "joining" | "failed" | "unavailable" | "resume-offer">("loading");
  const [state, setState] = useState<RoomState | null>(null), [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null), [denied, setDenied] = useState(false), [retry, setRetry] = useState(0);
  const [nameError, setNameError] = useState(false);
  const [remembered, setRemembered] = useState<RoomState | null>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const submitButton = useRef<HTMLButtonElement>(null), restoreSubmitFocus = useRef(false);
  const kind = target.kind, code = target.kind === "join" || target.kind === "resume" ? target.code : "", roomId = target.kind === "resume" ? target.roomId : null;

  useEffect(() => {
    const request = new AbortController(); controller.current = request;
    const load = async () => {
      if (kind === "invalid") return;
      setPhase("loading"); setError(null); setDenied(false); setState(null); setRemembered(null);
      try {
        await createRoomEntryApi({ signal: request.signal }).capabilities();
        if (roomId) {
          const next = await createRoomApi(roomId, { signal: request.signal }).state();
          if (next.roomId !== roomId || next.code !== code) throw new RoomApiError("invalid_response", 503);
          if (!request.signal.aborted) { rememberRoom(ownerScope, next); setState(next); }
        } else {
          const rememberedId = kind === "join" ? rememberedRoomId(ownerScope, code) : null;
          if (rememberedId) {
            try {
              const existing = await createRoomApi(rememberedId, { signal: request.signal }).state();
              if (existing.roomId !== rememberedId || existing.code !== code) throw new RoomApiError("invalid_response", 503);
              if (!request.signal.aborted) { rememberRoom(ownerScope, existing); setRemembered(existing); setPhase("resume-offer"); }
              return;
            } catch (failure) {
              if (!(failure instanceof RoomApiError) || failure.code !== "access_denied") throw failure;
              forgetRememberedRoom(ownerScope, code, rememberedId);
            }
          }
          if (!request.signal.aborted) setPhase("form");
        }
      } catch (failure) {
        if (request.signal.aborted) return;
        setError(roomEntryError(failure, Boolean(roomId)));
        setDenied(failure instanceof RoomApiError && failure.code === "access_denied" && Boolean(roomId));
        if (roomId && failure instanceof RoomApiError && failure.code === "access_denied") forgetRememberedRoom(ownerScope, code, roomId);
        setPhase(failure instanceof RoomApiError && failure.code === "unavailable" ? "unavailable" : "failed");
      }
    };
    void load();
    return () => { request.abort(); controller.current?.abort(); };
  }, [kind, code, roomId, retry, ownerScope]);

  useEffect(() => {
    if (phase !== "form" || !restoreSubmitFocus.current) return;
    restoreSubmitFocus.current = false;
    if (document.activeElement === document.body) submitButton.current?.focus();
  }, [phase]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting.current || phase !== "form" || (target.kind !== "create" && target.kind !== "join")) return;
    let displayName: string;
    try { displayName = roomDisplayName(name); }
    catch (failure) { setNameError(true); setError(roomEntryError(failure)); nameInput.current?.focus(); return; }
    submitting.current = true; const request = new AbortController(); controller.current = request;
    setPhase("joining"); setError(null); setNameError(false);
    try {
      const next = await createRoomEntryApi({ signal: request.signal }).enter(target, displayName);
      if (!request.signal.aborted) { rememberRoom(ownerScope, next); router.replace(roomV2Url(next.code, next.roomId)); }
    } catch (failure) {
      if (request.signal.aborted) return;
      setError(roomEntryError(failure));
      restoreSubmitFocus.current = true;
      setPhase(failure instanceof RoomApiError && failure.code === "unavailable" ? "unavailable" : "form");
    } finally { submitting.current = false; }
  };

  if (state) return <Workspace key={`${state.roomId}:${state.selfId}`} initial={state} />;
  const invalid = kind === "invalid", checking = !invalid && phase === "loading", busy = phase === "joining";
  const title = invalid ? "Check the room link" : phase === "unavailable" ? "Live rooms are unavailable" : roomId || phase === "resume-offer" ? "Return to your room" : kind === "create" ? "Start a room together" : "Join your friends";
  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col px-5 py-6 sm:px-6 sm:py-10">
      <section aria-labelledby="room-entry-title" className="my-auto py-12">
        <h1 id="room-entry-title" className="text-balance font-display text-3xl font-semibold sm:text-4xl">{title}</h1>
        {!invalid && phase !== "unavailable" && <p className="mt-4 leading-relaxed text-muted-foreground">{roomId ? "We’ll check this browser’s access before opening the room." : phase === "resume-offer" ? <>This browser already has access to room <strong className="font-mono text-foreground">{code}</strong>.</> : kind === "create" ? "Choose a name your friends will recognise. You’ll decide who joins your room." : <>You’re asking to join room <strong className="font-mono text-foreground">{code}</strong>. The host will let you in.</>}</p>}
        {invalid && <p role="alert" className="mt-4 leading-relaxed">This room link is incomplete or invalid. Ask the host to share a new link, or enter the six-character code on the home page.</p>}
        {checking && <p role="status" className="mt-8 flex items-center gap-3 text-sm"><LoaderCircle size={18} className="motion-safe:animate-spin" aria-hidden /> {roomId ? "Checking room access…" : "Checking live room availability…"}</p>}
        {phase === "resume-offer" && remembered && <div className="mt-8 space-y-5">
          <Link href={roomV2Url(remembered.code, remembered.roomId)} replace className={`${control} w-full bg-accent text-accent-foreground`}>Continue as {remembered.members.find(member => member.id === remembered.selfId)?.displayName ?? "yourself"}<ArrowRight size={18} aria-hidden /></Link>
          <p className="text-sm leading-relaxed text-muted-foreground">Joining again with a different name replaces this browser’s current access{remembered.hostId === remembered.selfId ? ", including host controls" : ""}. Other open tabs may disconnect.</p>
          <button onClick={() => setPhase("form")} className={`${control} w-full bg-muted`}>Use a different name</button>
        </div>}
        {(phase === "form" || busy) && !invalid && <form onSubmit={event => void submit(event)} className="mt-8 space-y-5" aria-busy={busy} noValidate>
          <div>
            <label htmlFor="room-display-name" className="block text-sm font-semibold">Your display name</label>
            <input ref={nameInput} id="room-display-name" name="displayName" autoComplete="nickname" maxLength={40} value={name} disabled={busy} onChange={event => { setName(event.target.value); setNameError(false); setError(null); }} aria-invalid={nameError} aria-describedby={`room-name-help${nameError ? " room-entry-error" : ""}`} className="mt-2 min-h-12 w-full rounded-xl border border-border bg-card px-4 text-base outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50" />
            <p id="room-name-help" className="mt-2 text-sm text-muted-foreground">Visible to people in this room. Up to 40 characters.</p>
          </div>
          {kind === "join" && <p className="text-sm leading-relaxed">{remembered ? "This request replaces your current room access in this browser, including any host controls. Other open tabs may disconnect." : "If you have already joined this room in this browser, a new request replaces that access. Use your existing room tab to keep it."}</p>}
          <button ref={submitButton} type="submit" disabled={busy} className={`${control} min-h-12 w-full bg-accent text-accent-foreground hover:brightness-105`}>{busy ? <><LoaderCircle size={18} className="motion-safe:animate-spin" aria-hidden /> {kind === "create" ? "Creating room…" : "Requesting to join…"}</> : <>{kind === "create" ? "Create room" : "Ask to join"}<ArrowRight size={18} aria-hidden /></>}</button>
          <p className="text-sm leading-relaxed text-muted-foreground">Your camera and microphone stay off until you choose to use them.</p>
        </form>}
        {error && <p id="room-entry-error" role="alert" className="mt-5 text-sm leading-relaxed">{error}</p>}
        {!invalid && (phase === "failed" || phase === "unavailable") && <div className="mt-6 flex flex-wrap gap-3">
          <button onClick={() => setRetry(value => value + 1)} className={`${control} bg-muted hover:bg-border`}><RefreshCw size={16} aria-hidden /> Try again</button>
          {denied && code && <Link href={roomV2Url(code)} replace className={`${control} bg-accent text-accent-foreground`}>Ask to join again</Link>}
        </div>}
        {(invalid || phase === "failed" || phase === "unavailable") && <div className="mt-8 flex flex-wrap gap-3 border-t border-border pt-5">
          <Link href="/booth" className={`${control} bg-accent text-accent-foreground`}><Camera size={17} aria-hidden /> Use solo booth</Link>
          <Link href="/projects" className={`${control} hover:bg-muted`}>My projects</Link>
        </div>}
      </section>
    </main>
  );
}
