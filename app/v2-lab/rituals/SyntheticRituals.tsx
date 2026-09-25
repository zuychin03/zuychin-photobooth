"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { RitualWorkspace } from "@/components/memories/RitualWorkspace";
import { cloudControl } from "@/components/cloud/CloudControls";
import { createRitualUIFixture, ritualFixtureCouple } from "@/lib/memories/ritual-ui-fixture";

type Fixture = ReturnType<typeof createRitualUIFixture>;
type Session = ReturnType<Fixture["mount"]>;
export function SyntheticRituals() {
  const fixture = useRef<Fixture | null>(null), session = useRef<Session | null>(null);
  const [current, setCurrent] = useState<Session | null>(null), [person, setPerson] = useState<0 | 1>(0), [theme, setTheme] = useState("dark"), [note, setNote] = useState("");
  useEffect(() => () => { session.current?.close(); }, []);
  const start = () => { session.current?.close(); fixture.current = createRitualUIFixture(location.origin); session.current = fixture.current.mount(0); setCurrent(session.current); setPerson(0); setNote(""); };
  const control = `${cloudControl} border border-border bg-card`;
  return <main className={`${theme} min-h-dvh bg-background px-5 py-7 text-foreground`}><div className="mx-auto max-w-4xl"><Link href="/v2-lab" className="text-sm text-accent underline underline-offset-4">Development lab</Link><h1 className="mt-5 font-display text-3xl font-semibold">Ritual interface rehearsal</h1><p className="mt-3 max-w-2xl text-sm leading-relaxed text-foreground/75">Synthetic in-memory reminders with the real browser client and interface. No account, email, push or hosted service is used. Reload clears all rehearsal data. This does not verify SQL permissions or provider delivery.</p><div className="mt-5 flex flex-wrap gap-2"><button className={control} onClick={() => setTheme(value => value === "dark" ? "light" : "dark")}>Inspect {theme === "dark" ? "light" : "dark"} theme</button>{!current ? <button className={control} onClick={start}>Start ritual rehearsal</button> : <><button className={control} onClick={() => { session.current?.close(); session.current = null; fixture.current = null; setCurrent(null); setNote(""); }}>Stop rehearsal</button><button className={control} onClick={() => { session.current?.close(); const next = person === 0 ? 1 : 0; session.current = fixture.current!.mount(next); setCurrent(session.current); setPerson(next); setNote(""); }}>Switch to {person === 0 ? "Bao" : "Alex"}</button><button className={control} onClick={() => { fixture.current!.failNext("before"); setNote("The next request will fail before it arrives."); }}>Fail next request</button><button className={control} onClick={() => { fixture.current!.failNext("after"); setNote("The next mutation will arrive but its acknowledgement will be lost."); }}>Lose next acknowledgement</button><button className={control} onClick={() => { fixture.current!.unpair(); setNote("Synthetic pairing removed. Refresh or act to recheck access."); }}>Remove synthetic pairing</button></>}</div>{current && <p className="mt-4 text-sm font-medium">Synthetic account: {current.name}</p>}{note && <p role="status" className="mt-3 text-sm">{note}</p>}{current && <RitualWorkspace key={current.ownerId} client={current.client} coupleId={ritualFixtureCouple} />}</div></main>;
}
