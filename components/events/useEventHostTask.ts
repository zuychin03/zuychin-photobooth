"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { EventHostClient } from "@/lib/events/client";
import { eventError } from "./EventHostControls";

export function useEventHostTask(client: EventHostClient) {
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [lost, setLost] = useState(false);
  const active = useRef<AbortController | null>(null), live = useRef(false);
  useEffect(() => {
    live.current = true;
    const suspend = () => { active.current?.abort(); active.current = null; setBusy(false); };
    window.addEventListener("pagehide", suspend);
    return () => { live.current = false; active.current?.abort(); active.current = null; window.removeEventListener("pagehide", suspend); };
  }, [client]);
  const run = useCallback(async (work: (signal: AbortSignal, check: () => void) => Promise<void>) => {
    if (active.current || !live.current) return false;
    const abort = new AbortController(); active.current = abort; setBusy(true); setError(null);
    const check = () => { client.assertActive(abort.signal); if (!live.current || active.current !== abort) throw new Error("cancelled"); };
    try { check(); await work(abort.signal, check); check(); return true; }
    catch (error) {
      if (live.current && active.current === abort) {
        setError(eventError(error));
        if (error && typeof error === "object" && "code" in error && ["access_denied", "identity_changed"].includes(String(error.code))) setLost(true);
      }
      return false;
    } finally { if (active.current === abort) { active.current = null; if (live.current) setBusy(false); } }
  }, [client]);
  return { busy, error, lost, run, setError, isBusy: () => active.current !== null };
}
