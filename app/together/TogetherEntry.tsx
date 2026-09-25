"use client";

import { HelpTooltip } from "@/components/HelpTooltip";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, BookOpen, Camera, Clock, RefreshCw, Users } from "lucide-react";
import { StoryGuide } from "@/components/StoryGuide";
import { useAuth } from "@/lib/auth";
import { normalizeRoomCode } from "@/lib/room-code";
import { createRoomEntryApi, isV2RoomCode, roomV2Url } from "@/lib/rtc/entry-v2";
import { createStoryPlan, type StoryPlan } from "@/lib/stories/model";

const control = "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50";

export default function TogetherEntry({ roomsConfigured, cloudConfigured, challengesConfigured }: { roomsConfigured: boolean; cloudConfigured: boolean; challengesConfigured: boolean }) {
  const router = useRouter(), { enabled: authEnabled } = useAuth();
  const [roomState, setRoomState] = useState<"checking" | "ready" | "unavailable">(roomsConfigured ? "checking" : "unavailable");
  const [retry, setRetry] = useState(0), [code, setCode] = useState(""), [codeError, setCodeError] = useState(false);
  const [story, setStory] = useState<StoryPlan | null>(() => createStoryPlan("little-hello", 0));
  const codeInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!roomsConfigured) return;
    const request = new AbortController();
    void createRoomEntryApi({ signal: request.signal }).capabilities().then(() => {
      if (!request.signal.aborted) setRoomState("ready");
    }).catch(() => { if (!request.signal.aborted) setRoomState("unavailable"); });
    return () => request.abort();
  }, [roomsConfigured, retry]);

  const join = (event: FormEvent) => {
    event.preventDefault();
    if (roomState !== "ready") return;
    if (!isV2RoomCode(code)) { setCodeError(true); codeInput.current?.focus(); return; }
    router.push(roomV2Url(code));
  };

  return <main lang="en" className="mx-auto min-h-dvh w-full max-w-5xl px-5 py-6 sm:px-8 sm:py-8">
    <header className="mt-3 mb-10 max-w-2xl">
      <h1 className="font-display text-4xl font-semibold sm:text-5xl">Make a moment together</h1>
      <p className="mt-4 text-base leading-relaxed text-foreground/70">Capture live, take turns later, or try a photo story.</p>
    </header>

    <section aria-labelledby="live-title" className="grid gap-6 border-t border-border py-8 md:grid-cols-[1fr_1.2fr] md:gap-12">
      <div><Users size={23} aria-hidden className="text-partner" /><h2 id="live-title" className="mt-3 font-display text-2xl font-semibold">In the booth together</h2><p className="mt-3 text-sm leading-relaxed text-foreground/70">A live booth for 2–4 people.</p></div>
      <div className="space-y-4">
        {roomState === "ready" ? <>
          <Link href="/room/new?v=2" className={`${control} bg-accent text-accent-foreground`}><Camera size={18} aria-hidden />Create a room</Link>
          <form onSubmit={join} className="space-y-2">
            <label htmlFor="together-room-code" className="block text-sm font-medium">Have a room code?</label>
            <div className="flex gap-2"><input ref={codeInput} id="together-room-code" value={code} onChange={event => { setCode(normalizeRoomCode(event.target.value)); setCodeError(false); }} autoComplete="off" spellCheck={false} autoCapitalize="characters" maxLength={12} aria-invalid={codeError} aria-describedby={codeError ? "together-code-error" : "together-code-hint"} className="min-h-11 min-w-0 flex-1 rounded-xl border border-border bg-card px-3 font-mono text-lg uppercase focus-visible:outline-2 focus-visible:outline-ring" /><button className={`${control} bg-partner/15 text-partner`} type="submit">Join<ArrowRight size={16} aria-hidden /></button></div>
            {codeError ? <p id="together-code-error" role="alert" className="text-sm text-destructive">Enter the six letters or numbers shared by your host.</p> : <p id="together-code-hint" className="text-xs leading-relaxed text-foreground/70">The host will still need to accept your request to join.</p>}
          </form>
        </> : <div className="space-y-3 rounded-xl bg-muted p-4"><p role="status" className="text-sm leading-relaxed">{roomState === "checking" ? "Checking live-room availability…" : "Live rooms are unavailable here right now. You can still explore the stories and use the booth on this device."}</p>{roomsConfigured && roomState === "unavailable" && <button type="button" onClick={() => { setRoomState("checking"); setRetry(value => value + 1); }} className={`${control} border border-border`}><RefreshCw size={16} aria-hidden />Check again</button>}<Link href="/booth" className={`${control} border border-border`}>Open solo booth</Link></div>}
      </div>
    </section>

    <section aria-labelledby="later-title" className="grid gap-6 border-t border-border py-8 md:grid-cols-[1fr_1.2fr] md:gap-12">
      <div><Clock size={23} aria-hidden className="text-accent" /><h2 id="later-title" className="mt-3 font-display text-2xl font-semibold">Take your turn later</h2><p className="mt-3 text-sm leading-relaxed text-foreground/70">Photo challenges for 2–4 people, at your own pace.</p></div>
      <div className="space-y-4">
        <p className="text-sm leading-relaxed text-foreground/70">{challengesConfigured && authEnabled ? "Open Challenges in a shared cloud project. Photos follow its chosen reveal setting." : "Cloud challenges are unavailable right now."}</p>
        <div className="flex flex-wrap gap-2">{cloudConfigured && authEnabled && <Link href="/projects/cloud" className={`${control} border border-border`}>Open cloud projects<ArrowRight size={16} aria-hidden /></Link>}{authEnabled && <Link href="/relay/new" className={`${control} underline underline-offset-4`}>Paired relay</Link>}</div>
        {authEnabled && <p className="text-xs leading-relaxed text-foreground/70">Paired relay is for you and your linked partner.</p>}
      </div>
    </section>

    <section aria-labelledby="stories-title" className="grid gap-6 border-t border-border py-8 md:grid-cols-[1fr_1.2fr] md:gap-12">
      <div><BookOpen size={23} aria-hidden className="text-accent" /><h2 id="stories-title" className="mt-3 font-display text-2xl font-semibold">Four photos, a little story</h2><p className="mt-3 text-sm leading-relaxed text-foreground/70">Preview prompts for dates, friends and celebrations. <HelpTooltip label="About story previews">Previewing leaves your project unchanged. Choose a story in the booth or live room before capture. Relaxed poses are available.</HelpTooltip></p><Link href="/booth#photo-story" className={`${control} mt-4 border border-border`}>Choose a story in solo booth<ArrowRight size={16} aria-hidden /></Link></div>
      <StoryGuide plan={story} members={[{ id: "preview", name: "You" }]} onChange={setStory} />
    </section>
  </main>;
}
