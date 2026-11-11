"use client";

import { HelpTooltip } from "@/components/HelpTooltip";
import { useLocalRelease } from "@/components/ReleaseMode";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, BookOpen, Camera, Clock, LoaderCircle, RefreshCw, Users } from "lucide-react";
import { StoryGuide } from "@/components/StoryGuide";
import { PageHeader } from "@/components/ui/PageHeader";
import { Section } from "@/components/ui/Section";
import { useAuth } from "@/lib/auth";
import { isValidRoomCode, newRoomCode, normalizeRoomCode } from "@/lib/room-code";
import { createRoomEntryApi, isV2RoomCode, roomV2Url } from "@/lib/rtc/entry-v2";
import { STORY_CATEGORIES } from "@/lib/stories/catalogue";
import { createStoryPlan, type StoryPlan } from "@/lib/stories/model";

const chip = "inline-flex min-h-7 items-center rounded-full bg-muted px-3 text-xs font-bold text-muted-foreground tabular-nums";

export default function TogetherEntry({ roomsConfigured, cloudConfigured, challengesConfigured }: { roomsConfigured: boolean; cloudConfigured: boolean; challengesConfigured: boolean }) {
  const router = useRouter(), { enabled: authEnabled } = useAuth();
  const legacyRooms = useLocalRelease();
  const [roomState, setRoomState] = useState<"checking" | "ready" | "unavailable">(roomsConfigured ? "checking" : "unavailable");
  const [retry, setRetry] = useState(0), [code, setCode] = useState(""), [codeError, setCodeError] = useState(false);
  const [story, setStory] = useState<StoryPlan | null>(() => createStoryPlan("little-hello", 0));
  const codeInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (legacyRooms || !roomsConfigured) return;
    const request = new AbortController();
    void createRoomEntryApi({ signal: request.signal }).capabilities().then(() => {
      if (!request.signal.aborted) setRoomState("ready");
    }).catch(() => { if (!request.signal.aborted) setRoomState("unavailable"); });
    return () => request.abort();
  }, [legacyRooms, roomsConfigured, retry]);

  const join = (event: FormEvent) => {
    event.preventDefault();
    if (!legacyRooms && roomState !== "ready") return;
    if (!(legacyRooms ? isValidRoomCode(code) : isV2RoomCode(code))) { setCodeError(true); codeInput.current?.focus(); return; }
    router.push(legacyRooms ? `/room/${code}` : roomV2Url(code));
  };

  return <main lang="en" className="mx-auto flex min-h-dvh w-full max-w-5xl flex-1 flex-col gap-6 px-4 pt-4 pb-10 sm:px-8 sm:pt-6">
    <PageHeader title="Make a moment together" />
    <div className="page-body flex flex-col gap-5">
      <div className="grid gap-5 lg:grid-cols-2">
        <Section id="live-title" title="In the booth together" icon={Users} tone="violet" action={<span className={chip}>2–4 people</span>}>
          {legacyRooms || roomState === "ready" ? <div className="flex flex-col gap-4">
            {legacyRooms ? <button type="button" onClick={() => router.push(`/room/${newRoomCode()}?host=1`)} className="btn btn-primary min-h-14 w-full text-base"><Camera size={20} aria-hidden />Create a room</button> : <Link href="/room/new?v=2" className="btn btn-primary min-h-14 w-full text-base"><Camera size={20} aria-hidden />Create a room</Link>}
            <form onSubmit={join} className="flex flex-col gap-2">
              <label htmlFor="together-room-code" className="sr-only">Room code</label>
              <div className={`flex min-h-14 items-center gap-2 rounded-full bg-muted py-1.5 pr-1.5 pl-5 ${codeError ? "shadow-[inset_0_0_0_2px_var(--destructive)]" : "shadow-[inset_0_0_0_1px_var(--border)] focus-within:shadow-[inset_0_0_0_2px_var(--ring)]"}`}>
                <input ref={codeInput} id="together-room-code" value={code} onChange={event => { setCode(normalizeRoomCode(event.target.value)); setCodeError(false); }} placeholder="Room code" autoComplete="off" spellCheck={false} autoCapitalize="characters" maxLength={6} aria-invalid={codeError} aria-describedby={codeError ? "together-code-error" : "together-code-hint"} className={`min-h-11 w-0 min-w-0 flex-1 bg-transparent text-lg font-black tracking-[0.24em] uppercase outline-none placeholder-shown:text-base placeholder:font-bold placeholder:tracking-normal placeholder:normal-case placeholder:text-muted-foreground ${codeError ? "text-destructive" : ""}`} />
                <button className="btn btn-partner min-h-11 px-5" type="submit">Join</button>
              </div>
              {codeError ? <p id="together-code-error" role="alert" className="pl-5 text-sm font-bold text-destructive">Room codes are 6 letters or numbers. Check with your host.</p> : <p id="together-code-hint" className="pl-5 text-sm text-muted-foreground">{legacyRooms ? "Ask your friend for their room code or invite link." : "The host has to let you in."}</p>}
            </form>
          </div> : <div className="flex flex-col gap-3">
            <p role="status" className="notice flex items-center gap-2">{roomState === "checking" && <LoaderCircle size={16} className="shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />}{roomState === "checking" ? "Checking if live rooms are up…" : "Live rooms aren't available right now."}</p>
            <div className="flex flex-wrap gap-2">
              {roomsConfigured && roomState === "unavailable" && <button type="button" onClick={() => { setRoomState("checking"); setRetry(value => value + 1); }} className="btn btn-tinted min-h-10 text-sm"><RefreshCw size={15} aria-hidden />Check again</button>}
              <Link href="/booth" className="btn btn-quiet min-h-10 text-sm"><Camera size={15} aria-hidden />Open solo booth</Link>
            </div>
          </div>}
        </Section>

        <Section id="later-title" title="Take your turn later" icon={Clock} tone="amber" bodyClassName="mt-2">
          <ul className="divide-y divide-border">
            <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 py-4">
              <div className="min-w-0">
                <h3 className="flex flex-wrap items-center gap-2 font-bold">Photo challenges <span className={chip}>2–4 people</span></h3>
                <p className="mt-1 text-sm text-muted-foreground">{legacyRooms ? "Feature incoming" : challengesConfigured && authEnabled ? "Start one from a shared cloud project." : "Challenges aren't available right now."}</p>
              </div>
              {cloudConfigured && authEnabled && <Link href="/projects/cloud" className="btn btn-quiet min-h-10 text-sm">Cloud projects<ArrowRight size={15} aria-hidden /></Link>}
            </li>
            {authEnabled && <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 py-4">
              <div className="min-w-0">
                <h3 className="font-bold">Paired relay</h3>
                <p className="mt-1 text-sm text-muted-foreground">Just you and your partner</p>
              </div>
              <Link href="/relay/new" className="btn btn-quiet min-h-10 text-sm">Start a relay<ArrowRight size={15} aria-hidden /></Link>
            </li>}
          </ul>
        </Section>
      </div>

      <Section id="stories-title" title="Four photos, a little story" icon={BookOpen} tone="rose" action={<HelpTooltip label="About story previews">This is just a preview. To use a story, pick it in the booth or a live room before you start. Every pose has a relaxed version.</HelpTooltip>} bodyClassName="mt-5 grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] lg:gap-8">
        <div className="flex flex-col gap-5">
          <ul aria-label="Story types" className="flex flex-wrap gap-2">{Object.values(STORY_CATEGORIES).map(category => <li key={category} className="rounded-full bg-accent/10 px-3.5 py-1.5 text-sm font-bold text-accent">{category}</li>)}</ul>
          <Link href="/booth#photo-story" className="btn btn-tinted self-start">Pick a story in the solo booth<ArrowRight size={16} aria-hidden /></Link>
        </div>
        <StoryGuide plan={story} members={[{ id: "preview", name: "You" }]} onChange={setStory} />
      </Section>
    </div>
  </main>;
}
