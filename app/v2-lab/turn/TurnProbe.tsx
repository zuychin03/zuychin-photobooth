"use client";
import { useEffect, useRef, useState } from "react";
import { checkTurn, type TurnProbeResult } from "@/lib/rtc/turn-probe";
import { roomIceServers } from "@/lib/rtc/workspace-capture";
export default function TurnProbe() {
  const active = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false), [result, setResult] = useState<TurnProbeResult | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => () => { active.current?.abort(); active.current = null; }, []);
  async function run() {
    if (active.current) return;
    const controller = new AbortController(); active.current = controller; setBusy(true); setResult(null); setFailed(false);
    try {
      const value = await checkTurn(roomIceServers(), controller.signal);
      if (active.current === controller) setResult(value);
    } catch { if (active.current === controller) setFailed(true); } finally { if (active.current === controller) { active.current = null; setBusy(false); } }
  }
  return <main className="mx-auto max-w-xl space-y-4 p-6">
    <h1 className="font-display text-3xl">TURN relay check</h1>
    <p>Two local peers use only the configured relay. No camera or microphone is needed. The check stops within 24 seconds.</p>
    <button className="min-h-11 rounded-xl border border-border px-4" disabled={busy} onClick={() => void run()}>Check configured TURN</button>
    {busy && <button className="ml-3 min-h-11 rounded-xl border border-border px-4" onClick={() => active.current?.abort()}>Cancel</button>}
    <p role="status">{busy ? "Checking relay..." : failed ? "Connection check failed." : result ? `${result.category}. Configured: ${result.configured ? "yes" : "no"}. Phase: ${result.phase}. Failure: ${result.failureOrigin ?? "none"}. ICE codes: ${result.iceErrorCodes.join(", ") || "none"}. Relay candidates: ${result.relayCandidates.join(" / ")}. Transport: ${result.transport}. ${result.bytes} bytes, ${result.durationMs} ms.` : "Ready to check."}</p>
    <p className="text-sm">This checks this browser and network only; it does not prove a connection between separate networks.</p>
  </main>;
}
