"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { createEventExportFixture } from "@/lib/events/export-fixture";
import { createEventExportClient, type EventExportClient } from "@/lib/events/export-client";
import { EventExportPanel } from "@/components/events/EventExportPanel";
import { eventControl } from "@/components/events/EventHostControls";

type Session = { fixture: Awaited<ReturnType<typeof createEventExportFixture>>; client: EventExportClient; eventId: string; appOrigin: string; storageOrigin: string };
export default function EventExportRehearsal() {
  const [session, setSession] = useState<Session | null>(null), [version, setVersion] = useState(0), [starting, setStarting] = useState(false), [busy, setBusy] = useState(false), [dirty, setDirty] = useState(false), [dark, setDark] = useState(true), [notice, setNotice] = useState("");
  const current = useRef<Session | null>(null), lifetime = useRef(0);
  const stop = () => { lifetime.current++; current.current?.client.close(); current.current?.fixture.close(); current.current = null; setSession(null); setBusy(false); setDirty(false); setStarting(false); setNotice("Stopped. Synthetic server records and local image bytes were cleared."); };
  useEffect(() => () => { lifetime.current++; current.current?.client.close(); current.current?.fixture.close(); }, []);
  const start = async () => {
    const generation = ++lifetime.current; setStarting(true); setNotice("");
    try {
      const canvas = document.createElement("canvas"); canvas.width = 160; canvas.height = 120;
      const context = canvas.getContext("2d"); if (!context) throw new Error("Canvas unavailable");
      context.fillStyle = "#c54d6d"; context.fillRect(0, 0, 160, 120); context.fillStyle = "#fff0e7"; context.font = "18px serif"; context.fillText("Event rehearsal", 15, 65);
      const image = await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("JPEG unavailable")), "image/jpeg", 0.8)); canvas.width = canvas.height = 1;
      if (generation !== lifetime.current) return;
      const eventId = crypto.randomUUID(), ownerId = crypto.randomUUID(), appOrigin = location.origin, storageOrigin = "https://synthetic-event-export.invalid";
      const fixture = await createEventExportFixture({ eventId, ownerId, appOrigin, storageOrigin, image });
      if (generation !== lifetime.current) { fixture.close(); return; }
      const client = createEventExportClient({ appOrigin, storageOrigin, ...fixture }), next = { fixture, client, eventId, appOrigin, storageOrigin }; current.current = next; setSession(next);
    } catch { if (generation === lifetime.current) setNotice("The synthetic JPEG fixture could not start."); }
    finally { if (generation === lifetime.current) setStarting(false); }
  };
  const remount = () => { if (!session) return; session.client.close(); const next = { ...session, client: createEventExportClient({ appOrigin: session.appOrigin, storageOrigin: session.storageOrigin, ...session.fixture }) }; current.current = next; setSession(next); setVersion(value => value + 1); setNotice("Panel remounted. Server snapshots and checkpoints remain; prepared ZIPs and local retry identities were discarded."); };
  return <main className={`${dark ? "dark" : "light"} min-h-dvh bg-background px-5 py-6 text-foreground`}><div className="mx-auto max-w-5xl">
    <Link href="/v2-lab" className="text-sm underline">Back to development lab</Link><h1 className="mt-6 font-display text-4xl">Event export rehearsal</h1>
    <p className="mt-3 max-w-3xl text-sm leading-relaxed">Real export panel, client, JPEG decoding and ZIP creation against an in-memory server. Twelve submissions span two batches; one is unavailable. No accounts or network services are used. Download creates a real local ZIP. A full page reload resets this synthetic server.</p>
    <div className="my-5 flex flex-wrap gap-2"><button className={`${eventControl} border border-border`} onClick={() => setDark(value => !value)}>{dark ? "Inspect light theme" : "Inspect dark theme"}</button>
      {!session ? <button className={`${eventControl} bg-accent text-accent-foreground`} disabled={starting} onClick={() => void start()}>{starting ? "Starting…" : "Start export rehearsal"}</button> : <>
        <button className={`${eventControl} border border-border`} onClick={stop}>Stop and clear rehearsal</button>
        <button className={`${eventControl} border border-border`} disabled={busy} onClick={remount}>Remount panel, keep server</button>
        <button className={`${eventControl} border border-border`} disabled={busy} onClick={() => { session.fixture.loseCreate(); setNotice("The next snapshot creation commits, then loses its response. Retry the exact request or remount and refresh the snapshot list."); }}>Lose next create response</button>
        <button className={`${eventControl} border border-border`} disabled={busy} onClick={() => { session.fixture.loseCheckpoint(); setNotice("The next checkpoint commits, then loses its response. Read current progress and prepare or confirm again."); }}>Lose next checkpoint response</button>
        <button className={`${eventControl} border border-border`} onClick={() => { session.fixture.revoke(); setNotice("Server access revoked. Download ZIP must recheck authority and refuse. Restore then refresh to continue."); }}>Revoke export access</button>
        <button className={`${eventControl} border border-border`} onClick={() => { session.fixture.restore(); setNotice("Server access restored. Refresh the export list."); }}>Restore export access</button>
        <button className={`${eventControl} border border-border`} onClick={() => { session.fixture.expire(); setNotice("Server expiry is now enforced. All further requests refuse; stop and start for a new event."); }}>Expire synthetic event</button>
      </>}
    </div>{notice && <p role="status" className="my-4 text-sm">{notice}</p>}
    {session && <><p className="mb-5 text-sm text-foreground/70">{busy ? "Panel request in progress." : "Panel idle."} {dirty ? "A prepared ZIP or exact retry is held in this panel." : "No prepared ZIP or retry is held."} Use the panel’s retirement confirmation to release a snapshot slot, then reuse that slot at its next generation.</p><EventExportPanel key={version} client={session.client} eventId={session.eventId} onBusyChange={setBusy} onDirtyChange={setDirty} /></>}
  </div></main>;
}
