"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { MemoryWorkspace } from "@/components/memories/MemoryWorkspace";
import { cloudControl } from "@/components/cloud/CloudControls";
import { createMemoryUIFixture, type MemoryFixtureSession } from "@/lib/memories/memory-ui-fixture";

type Fixture = Awaited<ReturnType<typeof createMemoryUIFixture>>;
async function sample() {
  const canvas = document.createElement("canvas"); canvas.width = 256; canvas.height = 384;
  try {
    const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("Canvas unavailable");
    ctx.fillStyle = "#f5e6d8"; ctx.fillRect(0, 0, 256, 384);
    for (let n = 0; n < 3; n++) { ctx.fillStyle = ["#806c85", "#c78789", "#789c95"][n]; ctx.fillRect(16, 16 + n * 112, 224, 100); ctx.fillStyle = "#f5e6d8"; ctx.beginPath(); ctx.arc(128, 51 + n * 112, 20, 0, Math.PI * 2); ctx.fill(); ctx.fillRect(98, 73 + n * 112, 60, 36); }
    ctx.fillStyle = "#503f46"; ctx.font = "12px sans-serif"; ctx.textAlign = "center"; ctx.fillText("SYNTHETIC MEMORY", 128, 371);
    const png = await new Promise<Blob>((resolve, reject) => { const timer = setTimeout(() => reject(new Error("PNG encoding timed out")), 5000); canvas.toBlob(blob => { clearTimeout(timer); if (blob) resolve(blob); else reject(new Error("PNG encoding failed")); }, "image/png"); });
    return { png, width: 256, height: 384 };
  } finally { canvas.width = canvas.height = 0; }
}
export function SyntheticMemories() {
  const fixture = useRef<Fixture | null>(null), session = useRef<MemoryFixtureSession | null>(null), live = useRef(false), opening = useRef(false);
  const [current, setCurrent] = useState<MemoryFixtureSession | null>(null), [person, setPerson] = useState<0 | 1>(0), [theme, setTheme] = useState("dark"), [busy, setBusy] = useState(false), [note, setNote] = useState("");
  useEffect(() => { live.current = true; return () => { live.current = false; session.current?.close(); fixture.current?.close(); }; }, []);
  const start = async () => {
    if (opening.current) return; opening.current = true; setBusy(true); setNote("");
    try { const image = await sample(); if (!live.current) return; const next = await createMemoryUIFixture(location.origin, image); if (!live.current) { next.close(); return; } fixture.current?.close(); fixture.current = next; session.current = next.mount(0); setCurrent(session.current); setPerson(0); }
    catch { if (live.current) setNote("The local rehearsal could not start. Retry without enabling any hosted service."); }
    finally { opening.current = false; if (live.current) setBusy(false); }
  };
  const control = `${cloudControl} border border-border bg-card`;
  return <main className={`${theme} min-h-dvh bg-background px-5 py-7 text-foreground`}><div className="mx-auto max-w-5xl">
    <Link href="/v2-lab" className="text-sm text-accent underline underline-offset-4">Development lab</Link>
    <h1 className="mt-5 font-display text-3xl font-semibold">Memory interface rehearsal</h1>
    <p className="mt-3 max-w-2xl text-sm leading-relaxed text-foreground/75">Synthetic 2026 memories, private labels and a small locally generated PNG use the real browser clients and interface. No account, upload or hosted service is used. Reload clears rehearsal state. This verifies interface behaviour, not SQL permissions, private provider storage or real photographs.</p>
    <div className="mt-5 flex flex-wrap gap-2"><button className={control} disabled={busy} onClick={() => setTheme(value => value === "dark" ? "light" : "dark")}>Inspect {theme === "dark" ? "light" : "dark"} theme</button>
      {!current ? <button className={control} disabled={busy} onClick={() => void start()}>{busy ? "Preparing local fixture…" : "Start memory rehearsal"}</button> : <>
        <button className={control} onClick={() => { session.current?.close(); fixture.current?.close(); session.current = null; fixture.current = null; setCurrent(null); setNote(""); }}>Stop rehearsal</button>
        <button className={control} onClick={() => { session.current?.close(); const next = person === 0 ? 1 : 0; session.current = fixture.current!.mount(next); setCurrent(session.current); setPerson(next); setNote(""); }}>Switch to {person === 0 ? "Bao" : "Alex"}</button>
        <button className={control} onClick={() => { fixture.current!.failNext("before"); setNote("The next request will fail before reaching rehearsal state."); }}>Fail next request</button>
        <button className={control} onClick={() => { fixture.current!.failNext("after"); setNote("The next successful label mutation will commit but lose its acknowledgement. Refresh to reconcile before retrying."); }}>Lose next acknowledgement</button>
        <button className={control} onClick={() => { fixture.current!.revokeAvailable(); setNote("Synthetic originals revoked. Preview or export must recheck and fail; refresh updates the rows."); }}>Revoke synthetic originals</button>
        <button className={control} onClick={() => { fixture.current!.unpair(); setNote("Synthetic pairing removed. Refresh hides partner entries; own participation and private labels remain."); }}>Remove synthetic pairing</button>
      </>}
    </div>
    {current && <p className="mt-4 text-sm font-medium">Synthetic account: {current.name} · choose year 2026</p>}
    {note && <p role="status" className="mt-3 text-sm">{note}</p>}
    {current && <MemoryWorkspace key={current.key} runtime={current.runtime} />}
  </div></main>;
}
