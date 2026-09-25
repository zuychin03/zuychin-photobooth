"use client";
import { useEffect, useRef, useState } from "react";
import { runMediaAcceptanceProbe } from "@/lib/feasibility/media-acceptance-probe";
export default function MediaAcceptance() {
  const [busy, setBusy] = useState(false), [report, setReport] = useState("No checks run."), active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  const run = (repetitions: 6 | 30) => { const abort = new AbortController(); active.current = abort; setBusy(true); void runMediaAcceptanceProbe(setReport, abort.signal, repetitions).then(value => setReport(JSON.stringify(value, null, 2))).catch(error => setReport(String(error))).finally(() => setBusy(false)); };
  return <main className="mx-auto max-w-4xl p-8"><h1 className="font-display text-3xl">Synthetic media acceptance</h1><p className="my-4">Choose six quick rounds or thirty rounds for a longer bounded session (about five minutes). No camera, microphone, account or provider. Unique synthetic project databases are removed after each round. JavaScript heap excludes native and GPU allocations.</p><button className="min-h-11 rounded-xl border px-5" disabled={busy} onClick={() => run(6)}>Run six-round media checks</button><button className="ml-3 min-h-11 rounded-xl border px-5" disabled={busy} onClick={() => run(30)}>Run thirty-round session</button>{busy && <button className="ml-3 min-h-11 rounded-xl border px-5" onClick={() => active.current?.abort()}>Cancel checks</button>}<pre role="status" className="mt-6 whitespace-pre-wrap break-all text-xs">{report}</pre></main>;
}
