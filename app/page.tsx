"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Camera, Heart, Users, ArrowRight } from "lucide-react";
import { StripMockup } from "@/components/StripMockup";
import { HelpTooltip } from "@/components/HelpTooltip";
import { InstallPrompt } from "@/components/InstallPrompt";
import { RecentProjects } from "@/components/RecentProjects";
import { isValidRoomCode, newRoomCode, normalizeRoomCode } from "@/lib/room-code";
import { isV2RoomCode, roomV2Url } from "@/lib/rtc/entry-v2";
import { useLocalRelease } from "@/components/ReleaseMode";

export default function Home() {
  const router = useRouter();
  const localOnly = useLocalRelease();
  const [joinCode, setJoinCode] = useState("");
  const [joinError, setJoinError] = useState(false);

  const createRoom = () => router.push(localOnly ? `/room/${newRoomCode()}?host=1` : "/room/new?v=2");

  const joinRoom = () => {
    if (!(localOnly ? isValidRoomCode(joinCode) : isV2RoomCode(joinCode))) {
      setJoinError(true);
      return;
    }
    router.push(localOnly ? `/room/${joinCode}` : roomV2Url(joinCode));
  };

  return (
    <main className="relative flex min-h-dvh flex-1 flex-col">
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-[calc(-1*var(--app-nav-height,0px))] bottom-0 -z-10 overflow-hidden">
        <div className="fluid-orb absolute -top-24 -left-24 h-96 w-96 rounded-full bg-accent/20 blur-3xl" />
        <div className="fluid-orb--slow fluid-orb absolute top-1/3 -right-32 h-[28rem] w-[28rem] rounded-full bg-partner/20 blur-3xl" />
        <div className="fluid-orb absolute bottom-0 left-1/4 h-80 w-80 rounded-full bg-warning/10 blur-3xl" />
      </div>

      <div className="mx-auto grid w-full max-w-5xl flex-1 items-center justify-items-center gap-10 px-6 pt-5 pb-12 sm:pt-8 lg:grid-cols-[1.25fr_1fr] lg:gap-16 lg:pt-12">
        <div className="flex w-full min-w-0 max-w-lg flex-col items-center text-center lg:items-start lg:text-left">
          <h1
            className="hero-animate hero-animate-delay-2 text-4xl leading-tight font-semibold sm:text-6xl"
            style={{ fontFamily: "var(--font-fraunces)" }}
          >
            Your memories,
            <br />
            your photo stories
          </h1>
          <p className="hero-animate hero-animate-delay-3 mt-4 text-muted-foreground">
            Make photo strips solo or with your group of friends{" "}
            <span className="inline-block whitespace-nowrap">from anywhere.<HelpTooltip label="About getting started">Solo photos need no account. Share a live booth with up to four people, or collect photos at an event when online features are available.</HelpTooltip></span>
          </p>

          <div className="hero-animate hero-animate-delay-4 mt-8 flex w-full flex-col gap-3">
            <button
              onClick={() => router.push("/booth")}
              className="group flex min-h-14 items-center justify-between rounded-2xl bg-accent px-5 text-accent-foreground shadow-lg shadow-accent/25 transition hover:brightness-105 active:scale-[0.99]"
            >
              <span className="flex items-center gap-3 font-semibold">
                <Camera size={20} /> Solo booth
              </span>
              <ArrowRight size={18} className="transition group-hover:translate-x-0.5" />
            </button>

            <button
              onClick={createRoom}
              className="group glass-card flex min-h-14 items-center justify-between rounded-2xl px-5 transition hover:border-accent/40 active:scale-[0.99]"
            >
              <span className="flex items-center gap-3 font-semibold">
                <Heart size={20} className="text-accent" /> Create a room
              </span>
              <ArrowRight size={18} className="transition group-hover:translate-x-0.5" />
            </button>

            <div className="glass-card flex min-h-14 items-center gap-2 rounded-2xl px-4">
              <Users size={20} className="shrink-0 text-partner" />
              <input
                value={joinCode}
                onChange={(e) => {
                  setJoinCode(normalizeRoomCode(e.target.value));
                  setJoinError(false);
                }}
                onKeyDown={(e) => e.key === "Enter" && joinRoom()}
                placeholder="Room code"
                aria-label="Room code"
                aria-invalid={joinError}
                aria-describedby={joinError ? "room-code-error" : undefined}
                className={`min-h-11 min-w-0 flex-1 rounded-md bg-transparent font-mono text-lg tracking-[0.3em] uppercase outline-none focus-visible:ring-2 focus-visible:ring-ring placeholder:font-sans placeholder:text-base placeholder:tracking-normal placeholder:text-muted-foreground ${
                  joinError ? "text-destructive" : ""
                }`}
              />
              <button
                onClick={joinRoom}
                className="min-h-11 rounded-xl bg-partner/15 px-4 font-semibold text-partner transition hover:bg-partner/25 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                Join
              </button>
            </div>
            {joinError && (
              <p id="room-code-error" role="alert" className="text-sm text-destructive">
                Room codes are 6 letters or numbers. Check with your host.
              </p>
            )}
          </div>
        </div>

          <div className="hero-animate hero-animate-delay-3 relative flex items-center justify-center">
          <StripMockup tilt={-8} className="translate-x-6 translate-y-4" />
          <StripMockup tilt={4} className="-translate-x-2 -translate-y-2" />
          <StripMockup tilt={12} className="-translate-x-10 translate-y-6 hidden sm:block" />
        </div>
      </div>

      <RecentProjects />
      <footer className="relative z-10 flex w-full flex-col items-center gap-3 px-6 pb-4 text-center text-xs text-muted-foreground">
        <InstallPrompt />
        Part of the Zuychin ecosystem
      </footer>
    </main>
  );
}
