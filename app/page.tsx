"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Camera, Heart, ArrowRight } from "lucide-react";
import { StripMockup } from "@/components/StripMockup";
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
      <div className="mx-auto grid w-full max-w-6xl flex-1 content-center items-center gap-8 px-4 pt-10 pb-10 sm:px-8 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)] lg:gap-12 lg:pt-8">
        <div className="@container flex w-full min-w-0 max-w-xl flex-col justify-self-center lg:max-w-2xl lg:justify-self-start">
          {/* "your photo stories" is ~9.4em wide in Mochiy, so this keeps each clause on one line. */}
          <h1 className="hero-animate hero-animate-delay-1 font-display text-[min(4.5rem,calc(100cqi/9.6))] leading-[1.1]">
            Your memories,<br /> your photo stories
          </h1>

          <div className="hero-animate hero-animate-delay-2 mt-8 flex w-full flex-col gap-3 lg:mt-10">
            <button
              type="button"
              onClick={() => router.push("/booth")}
              className="btn btn-primary group min-h-16 justify-between px-6 text-lg"
            >
              <span className="flex items-center gap-3">
                <Camera size={22} strokeWidth={2.25} aria-hidden /> Solo booth
              </span>
              <ArrowRight size={20} aria-hidden className="transition-transform group-hover:translate-x-1" />
            </button>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <button type="button" onClick={createRoom} className="btn btn-glass min-h-14 justify-start px-5">
                <Heart size={20} strokeWidth={2.25} aria-hidden className="text-accent" /> Create a room
              </button>

              <div className={`glass flex min-h-14 items-center gap-2 rounded-full py-1.5 pr-1.5 pl-5 ${joinError ? "ring-2 ring-destructive" : ""}`}>
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
                  autoComplete="off"
                  spellCheck={false}
                  autoCapitalize="characters"
                  className={`min-h-11 w-0 min-w-0 flex-1 rounded-md bg-transparent text-lg font-black tracking-[0.24em] uppercase outline-none placeholder-shown:text-base placeholder:font-bold placeholder:tracking-normal placeholder:normal-case placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring ${joinError ? "text-destructive" : ""}`}
                />
                <button type="button" onClick={joinRoom} className="btn btn-partner min-h-11 px-4">
                  Join
                </button>
              </div>
            </div>
            {joinError && (
              <p id="room-code-error" role="alert" className="pl-5 text-sm font-bold text-destructive">
                Room codes are 6 letters or numbers. Check with your host.
              </p>
            )}
          </div>
        </div>

        <div aria-hidden className="hero-animate hero-animate-delay-3 relative flex items-center justify-center">
          <StripMockup tilt={-8} className="translate-x-6 translate-y-4" />
          <StripMockup tilt={4} className="-translate-x-2 -translate-y-2" />
          <StripMockup tilt={12} className="-translate-x-10 translate-y-6 hidden sm:block" />
        </div>
      </div>

      <RecentProjects />
      <footer className="relative z-10 flex w-full flex-col items-center gap-3 px-6 pb-6 text-center text-xs text-muted-foreground">
        <InstallPrompt />
        Part of the Zuychin ecosystem
      </footer>
    </main>
  );
}
