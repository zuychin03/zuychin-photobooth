"use client";

import { useEffect, useRef, useState, type ComponentType, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Camera, CameraOff, LoaderCircle, RefreshCw } from "lucide-react";
import { createRoomEntryApi, forgetRememberedRoom, rememberedRoomId, rememberRoom, roomDisplayName, roomEntryError, roomV2Url, type V2RoomTarget } from "@/lib/rtc/entry-v2";
import { createRoomApi, RoomApiError } from "@/lib/rtc/signaling-v2";
import type { RoomState } from "@/lib/server/room-contract";

const codeChip = "rounded-full bg-muted px-3 py-0.5 font-black tracking-[0.24em] text-foreground uppercase";

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
  const title = invalid ? "Check the room link" : phase === "unavailable" ? "Live rooms aren't available" : roomId || phase === "resume-offer" ? "Back to your room" : kind === "create" ? "Start a room together" : "Join your friends";
  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col px-4 pt-4 pb-10 sm:px-6 sm:pt-10">
      <section aria-labelledby="room-entry-title" className="panel page-body my-auto p-5 sm:p-8">
        <h1 id="room-entry-title" className="font-display text-[2rem] leading-[1.12] sm:text-4xl">{title}</h1>
        {!invalid && phase !== "unavailable" && !roomId && <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground">{phase === "resume-offer" ? <>You&apos;re already in room <strong className={codeChip}>{code}</strong> on this browser.</> : kind === "create" ? "You'll choose who gets in." : <><strong className={codeChip}>{code}</strong> The host will let you in.</>}</p>}
        {invalid && <p role="alert" className="mt-3 text-muted-foreground">This room link doesn&apos;t look right. Ask the host for a new one, or enter the room code on the home page.</p>}
        {checking && <p role="status" className="mt-6 flex items-center gap-3 text-sm font-bold text-muted-foreground"><LoaderCircle size={18} className="motion-safe:animate-spin" aria-hidden /> {roomId ? "Checking room access…" : "Checking if live rooms are up…"}</p>}
        {phase === "resume-offer" && remembered && <div className="mt-6 flex flex-col gap-3">
          <Link href={roomV2Url(remembered.code, remembered.roomId)} replace className="btn btn-primary min-h-12 w-full">Continue as {remembered.members.find(member => member.id === remembered.selfId)?.displayName ?? "yourself"}<ArrowRight size={18} aria-hidden /></Link>
          <p className="notice">Rejoining with a different name gives up your current spot{remembered.hostId === remembered.selfId ? ", including host controls" : ""}. Other tabs with this room open might disconnect.</p>
          <button onClick={() => setPhase("form")} className="btn btn-quiet w-full">Use a different name</button>
        </div>}
        {(phase === "form" || busy) && !invalid && <form onSubmit={event => void submit(event)} className="mt-6 flex flex-col gap-4" aria-busy={busy} noValidate>
          <div>
            <label htmlFor="room-display-name" className="block text-sm font-bold">Your name</label>
            <input ref={nameInput} id="room-display-name" name="displayName" autoComplete="nickname" maxLength={40} value={name} disabled={busy} onChange={event => { setName(event.target.value); setNameError(false); setError(null); }} aria-invalid={nameError} aria-describedby={`room-name-help${nameError ? " room-entry-error" : ""}`} className="field mt-2 min-h-12 text-base" />
            <p id="room-name-help" className="mt-2 text-sm text-muted-foreground">Everyone in the room will see this. Up to 40 characters.</p>
          </div>
          {kind === "join" && <p className="text-sm">{remembered ? "Asking again gives up your current spot, including any host controls." : "Already in this room in another tab? Use that tab instead."}</p>}
          <button ref={submitButton} type="submit" disabled={busy} className="btn btn-primary min-h-12 w-full disabled:cursor-wait">{busy ? <><LoaderCircle size={18} className="motion-safe:animate-spin" aria-hidden /> {kind === "create" ? "Creating room…" : "Asking to join…"}</> : <>{kind === "create" ? "Create room" : "Ask to join"}<ArrowRight size={18} aria-hidden /></>}</button>
          <p className="flex items-center justify-center gap-2 text-center text-sm text-muted-foreground"><CameraOff size={15} className="shrink-0" aria-hidden />Your camera and mic stay off until you turn them on.</p>
        </form>}
        {error && <p id="room-entry-error" role="alert" className="notice mt-5 border border-destructive/25 bg-destructive/8">{error}</p>}
        {!invalid && (phase === "failed" || phase === "unavailable") && <div className="mt-5 flex flex-wrap gap-2">
          <button onClick={() => setRetry(value => value + 1)} className="btn btn-quiet disabled:cursor-wait"><RefreshCw size={16} aria-hidden /> Try again</button>
          {denied && code && <Link href={roomV2Url(code)} replace className="btn btn-primary">Ask to join again</Link>}
        </div>}
        {(invalid || phase === "failed" || phase === "unavailable") && <div className="mt-6 flex flex-wrap gap-2 border-t border-border pt-5">
          <Link href="/booth" className="btn btn-tinted"><Camera size={17} aria-hidden /> Use solo booth</Link>
          <Link href="/projects" className="btn btn-plain">My projects</Link>
        </div>}
      </section>
    </main>
  );
}
