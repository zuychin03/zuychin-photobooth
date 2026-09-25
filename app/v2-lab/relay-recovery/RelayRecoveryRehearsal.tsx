"use client";
import { useEffect, useRef, useState } from "react";
import { RoleCapture } from "@/components/RoleCapture";
import { RelayOriginalRecovery } from "@/components/RelayOriginalRecovery";
import { loadRelayOriginals, relayFrameOriginal, saveRelayOriginals } from "@/lib/relay-recovery";
import { openProjectRepository } from "@/lib/projects/storage";
import { projectBlobHash } from "@/lib/projects/bundle";

const button = "min-h-11 rounded-xl border px-4 disabled:opacity-40";
export default function RelayRecoveryRehearsal() {
  const [files, setFiles] = useState<File[] | null>(null), [originals, setOriginals] = useState<Blob[]>([]), [initial, setInitial] = useState<Blob[]>([]), [mount, setMount] = useState(0);
  const [failSave, setFailSave] = useState(true), [failSecond, setFailSecond] = useState(false), [busy, setBusy] = useState(false), [status, setStatus] = useState("Not started.");
  const database = useRef(""), generation = useRef(0), frames = useRef<HTMLCanvasElement[]>([]);
  const release = () => { for (const frame of frames.current) frame.width = frame.height = 0; frames.current = []; };
  useEffect(() => () => { generation.current++; release(); if (database.current) indexedDB.deleteDatabase(database.current); }, []);
  const open: typeof openProjectRepository = (scope, options) => openProjectRepository(scope, { ...options, databaseName: database.current });
  const checkpoint = async (blobs: Blob[]) => {
    const expected = generation.current; setBusy(true);
    try {
      await saveRelayOriginals({ id: "synthetic", ownerId: "synthetic-owner-a", layoutId: "duo-split", filterId: "none", role: "A", shots: 4, originals: blobs, active: () => generation.current === expected }, async (scope, options) => {
        const repository = await open(scope, options);
        return { ...repository, save: failSave || (failSecond && blobs.length === 2) ? async () => { throw new Error("Synthetic local quota refusal. No cloud request was made."); } : repository.save };
      });
      if (generation.current === expected) setStatus(`${blobs.length} exact originals saved locally before the next photo. No cloud request was made.`);
    } catch (error) { if (generation.current === expected) setStatus(String(error)); throw error; }
    finally { if (generation.current === expected) setBusy(false); }
  };
  const start = async () => {
    setBusy(true); const expected = ++generation.current; database.current = `relay-recovery-${crypto.randomUUID()}`;
    const canvas = document.createElement("canvas"); canvas.width = 320; canvas.height = 240;
    try { const result: File[] = []; for (const colour of ["#ee6677", "#4488ee", "#44aa77", "#ddaa33"]) { canvas.getContext("2d")!.fillStyle = colour; canvas.getContext("2d")!.fillRect(0, 0, 320, 240); result.push(new File([await relayFrameOriginal(canvas)], `synthetic-${result.length + 1}.png`, { type: "image/png" })); } if (generation.current === expected) { setFiles(result); setStatus("Synthetic camera denied. Import four synthetic photos below."); } }
    finally { canvas.width = canvas.height = 0; if (generation.current === expected) setBusy(false); }
  };
  const verify = async (remount: boolean) => {
    setBusy(true); const expected = generation.current;
    try {
      const loaded = await loadRelayOriginals({ id: "synthetic", ownerId: "synthetic-owner-a", role: "A", active: () => expected === generation.current }, open);
      if (!loaded) throw new Error("No checkpoint exists yet.");
      for (const [index, blob] of loaded.originals.entries()) if (await projectBlobHash(blob) !== await projectBlobHash(files![index])) throw new Error("Original changed");
      const foreign = await open({ kind: "account", ownerId: "synthetic-owner-b" }); try { if (await foreign.load("relay-synthetic-A")) throw new Error("Account isolation failed"); } finally { foreign.close(); }
      if (expected !== generation.current) return;
      if (remount) { release(); setOriginals([]); setInitial(loaded.originals); setMount(value => value + 1); }
      setStatus(`PASS: ${loaded.originals.length} byte-exact original(s) reopened; the other account cannot read them.${remount ? " Capture remounted from the durable prefix. Any unsaved synthetic image was discarded." : ""}`);
    } catch (error) { if (expected === generation.current) setStatus(String(error)); } finally { if (expected === generation.current) setBusy(false); }
  };
  const stop = async () => { generation.current++; release(); setFiles(null); setOriginals([]); setInitial([]); setBusy(true); const request = indexedDB.deleteDatabase(database.current); request.onsuccess = () => { database.current = ""; setStatus("Stopped and cleared the isolated database."); setBusy(false); }; request.onerror = request.onblocked = () => { setStatus("Cleanup could not finish. Close other rehearsal tabs."); setBusy(false); }; };
  return <main className="mx-auto max-w-3xl space-y-5 p-6"><h1 className="font-display text-3xl">Synthetic relay recovery</h1><p>No account, provider or camera request. Originals use one isolated database. To test interruption: allow saving, refuse the second checkpoint, import, then remount the saved prefix. Restore saving and import the remaining photos.</p><p role="status">{status}</p>{!files ? <button disabled={busy} className={button} onClick={() => void start()}>Start isolated rehearsal</button> : <><label className="flex min-h-11 gap-2"><input type="checkbox" checked={failSave} disabled={busy} onChange={event => setFailSave(event.target.checked)} />Refuse local saving</label><label className="flex min-h-11 gap-2"><input type="checkbox" checked={failSecond} disabled={busy} onChange={event => setFailSecond(event.target.checked)} />Refuse only the second checkpoint</label>{!originals.length ? <RoleCapture key={mount} shots={4} filterId="none" initialOriginals={initial} rehearsalPhotos={files} onCheckpoint={checkpoint} onDone={(captured, blobs) => { frames.current = captured; setOriginals(blobs); setStatus("All four originals saved before continuation. No cloud upload."); }} /> : <RelayOriginalRecovery originals={originals} saved />}<div className="flex flex-wrap gap-2"><button disabled={busy} className={button} onClick={() => void verify(false)}>Reopen and check account isolation</button><button disabled={busy} className={button} onClick={() => void verify(true)}>Remount saved prefix, discarding unsaved synthetic photo</button><button disabled={busy} className={button} onClick={() => void stop()}>Stop and clear</button></div></>}</main>;
}
