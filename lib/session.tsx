"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";

export interface ShotStore {
  A: (HTMLCanvasElement | null)[];
  B: (HTMLCanvasElement | null)[];
}

export interface BoothSession {
  mode: "solo" | "duo";
  /** which side this device is in a duo room */
  role: "A" | "B";
  layoutId: string;
  filterId: string;
  shots: ShotStore;
  promptSeed: number | null;
  roomCode: string | null;
}

const EMPTY: BoothSession = {
  mode: "solo",
  role: "A",
  layoutId: "strip4",
  filterId: "none",
  shots: { A: [], B: [] },
  promptSeed: null,
  roomCode: null,
};

interface SessionContextValue {
  session: BoothSession;
  update: (patch: Partial<BoothSession>) => void;
  setShot: (owner: "A" | "B", index: number, shot: HTMLCanvasElement) => void;
  reset: () => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<BoothSession>(EMPTY);

  const update = useCallback((patch: Partial<BoothSession>) => {
    setSession((s) => ({ ...s, ...patch }));
  }, []);

  const setShot = useCallback(
    (owner: "A" | "B", index: number, shot: HTMLCanvasElement) => {
      setSession((s) => {
        const arr = [...s.shots[owner]];
        arr[index] = shot;
        return { ...s, shots: { ...s.shots, [owner]: arr } };
      });
    },
    [],
  );

  const reset = useCallback(() => setSession(EMPTY), []);

  const value = useMemo(
    () => ({ session, update, setShot, reset }),
    [session, update, setShot, reset],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useBoothSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useBoothSession outside SessionProvider");
  return ctx;
}
