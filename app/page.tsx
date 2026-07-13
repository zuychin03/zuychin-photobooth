"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Camera, Heart, Users, ArrowRight, Clock, LogIn } from "lucide-react";
import { StripMockup } from "@/components/StripMockup";
import { newRoomCode, normalizeRoomCode, isValidRoomCode } from "@/lib/room-code";
import { useAuth } from "@/lib/auth";

export default function Home() {
  const router = useRouter();
  const { user, enabled: authEnabled } = useAuth();
  const [joinCode, setJoinCode] = useState("");
  const [joinError, setJoinError] = useState(false);

  const createRoom = () => router.push(`/room/${newRoomCode()}?host=1`);

  const joinRoom = () => {
    if (!isValidRoomCode(joinCode)) {
      setJoinError(true);
      return;
    }
    router.push(`/room/${joinCode}`);
  };

  return (
    <main className="relative flex-1 overflow-hidden">
      {authEnabled && (
        <div className="absolute top-4 right-4 z-20">
          <button
            onClick={() => router.push(user ? "/timeline" : "/login?next=/timeline")}
            className="glass-card flex min-h-11 items-center gap-2 rounded-full px-4 text-sm font-medium"
          >
            {user ? (
              <>
                <Clock size={16} className="text-accent" /> Our timeline
              </>
            ) : (
              <>
                <LogIn size={16} /> Sign in
              </>
            )}
          </button>
        </div>
      )}

      {/* Fluid orbs */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="fluid-orb absolute -top-24 -left-24 h-96 w-96 rounded-full bg-accent/20 blur-3xl" />
        <div className="fluid-orb--slow fluid-orb absolute top-1/3 -right-32 h-[28rem] w-[28rem] rounded-full bg-partner/20 blur-3xl" />
        <div className="fluid-orb absolute bottom-0 left-1/4 h-80 w-80 rounded-full bg-warning/10 blur-3xl" />
      </div>

      <div className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col items-center justify-center gap-10 px-6 py-16 lg:flex-row lg:gap-16">
        {/* Hero copy + actions */}
        <div className="flex max-w-md flex-col items-center text-center lg:items-start lg:text-left">
          <p className="hero-animate hero-animate-delay-1 mb-3 text-sm font-medium tracking-widest text-accent uppercase">
            Zuychin Photobooth
          </p>
          <h1
            className="hero-animate hero-animate-delay-2 text-5xl leading-tight font-semibold sm:text-6xl"
            style={{ fontFamily: "var(--font-fraunces)" }}
          >
            A booth for two,
            <br />
            any distance.
          </h1>
          <p className="hero-animate hero-animate-delay-3 mt-4 text-muted-foreground">
            Snap photo strips together from anywhere: same countdown, same
            strip, two cameras. Your photos never touch a server.
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
                className={`min-w-0 flex-1 bg-transparent font-mono text-lg tracking-[0.3em] uppercase outline-none placeholder:font-sans placeholder:text-base placeholder:tracking-normal placeholder:text-muted-foreground ${
                  joinError ? "text-destructive" : ""
                }`}
              />
              <button
                onClick={joinRoom}
                className="min-h-10 rounded-xl bg-partner/15 px-4 font-semibold text-partner transition hover:bg-partner/25"
              >
                Join
              </button>
            </div>
            {joinError && (
              <p className="text-sm text-destructive">
                Room codes are 6 letters or numbers. Check with your partner.
              </p>
            )}
          </div>
        </div>

        {/* Tilted strip mockups */}
        <div className="hero-animate hero-animate-delay-3 relative flex items-center justify-center">
          <StripMockup tilt={-8} className="translate-x-6 translate-y-4" />
          <StripMockup tilt={4} className="-translate-x-2 -translate-y-2" />
          <StripMockup tilt={12} className="-translate-x-10 translate-y-6 hidden sm:block" />
        </div>
      </div>

      <footer className="absolute bottom-4 w-full text-center text-xs text-muted-foreground">
        Part of the Zuychin ecosystem
      </footer>
    </main>
  );
}
