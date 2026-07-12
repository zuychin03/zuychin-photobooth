"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { Role } from "./layouts";

export type ShotStore = Record<Role, (HTMLCanvasElement | null)[]>;

export interface BoothSession {
  mode: "solo" | "duo" | "group";
  /** which member this device is in a shared room */
  role: Role;
  layoutId: string;
  filterId: string;
  shots: ShotStore;
  /** roles present in the room when the shot plan fired */
  members: Role[];
  promptSeed: number | null;
  roomCode: string | null;
  /** Together scene agreed in the room, applied automatically in the editor */
  sceneId: string | null;
}

export const EMPTY_SHOTS: ShotStore = { A: [], B: [], C: [], D: [] };

const EMPTY: BoothSession = {
  mode: "solo",
  role: "A",
  layoutId: "strip4",
  filterId: "none",
  shots: EMPTY_SHOTS,
  members: ["A"],
  promptSeed: null,
  roomCode: null,
  sceneId: null,
};

interface SessionContextValue {
  session: BoothSession;
  update: (patch: Partial<BoothSession>) => void;
  setShot: (owner: Role, index: number, shot: HTMLCanvasElement) => void;
  reset: () => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<BoothSession>(EMPTY);

  const update = useCallback((patch: Partial<BoothSession>) => {
    setSession((s) => ({ ...s, ...patch }));
  }, []);

  const setShot = useCallback(
    (owner: Role, index: number, shot: HTMLCanvasElement) => {
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
