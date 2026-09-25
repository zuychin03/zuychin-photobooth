"use client";

import { useEffect, useRef, useState } from "react";
import VoiceMemoryCaption from "@/components/memories/VoiceMemoryCaption";
import { createVoiceClient, type VoiceClient } from "@/lib/memories/voice-client";
import { openVoiceDraftJournal, type VoiceDraftJournal } from "@/lib/memories/voice-drafts";
import { parseVoiceSave, type VoiceCaptionSnapshot } from "@/lib/memories/voice-contract";
import { inspectVoiceWav } from "@/lib/memories/voice-wav";
import { cloudSha256 } from "@/lib/projects/cloud-client";
import { removeCloudJournalForOwner } from "@/lib/projects/cloud-journal-db";
import { runVoiceDraftProbe } from "@/lib/memories/voice-draft-probe";

const ownerId = "11111111-1111-4111-8111-111111111118", activityId = "22222222-2222-4222-8222-222222222228", databaseName = "pb-voice-synthetic-rehearsal";
async function acquire() {
  const context = new AudioContext({ sampleRate: 48000 }), target = context.createMediaStreamDestination(), tone = context.createOscillator();
  await context.resume(); tone.frequency.value = 440; tone.connect(target); tone.start();
  const track = target.stream.getAudioTracks()[0], stop = track.stop.bind(track); let stopped = false;
  track.stop = () => { if (stopped) return; stopped = true; stop(); tone.stop(); tone.disconnect(); void context.close(); };
  return target.stream;
}
export default function PcmRehearsal() {
  const [runtime, setRuntime] = useState<{ client: VoiceClient; journal: VoiceDraftJournal } | null>(null), [error, setError] = useState(""), [generation, setGeneration] = useState(0), [notice, setNotice] = useState("");
  const loseAck = useRef(false), failPermission = useRef(false);
  const [probe, setProbe] = useState<string[]>([]), [probing, setProbing] = useState(false);
  const [captionGeneration, setCaptionGeneration] = useState(0);
  const editServer = useRef<(() => void) | null>(null);
  useEffect(() => {
    let closed = false, journal: VoiceDraftJournal | undefined;
    let snapshot: VoiceCaptionSnapshot = { version: 1, activityId, revision: 0, text: "", audio: null }, audio: Uint8Array<ArrayBuffer> | null = null;
    editServer.current = () => { snapshot = { ...snapshot, revision: snapshot.revision + 1, text: "Newer caption from another simulated device" }; };
    const applied = new Set<string>();
    const identity = () => closed ? null : { ownerId, epoch: generation };
    const client = createVoiceClient({ appOrigin: location.origin, identity, accessToken: async () => "synthetic-fixture", fetch: async (_url, init) => {
      if (failPermission.current) return Response.json({ error: "access_denied" }, { status: 403 });
      const body = JSON.parse(String(init?.body));
      if (body.operation === "read") return Response.json(snapshot);
      if (body.operation === "download") return audio && snapshot.audio ? new Response(audio, { headers: { "Content-Type": "audio/wav", "X-Voice-Generation": snapshot.audio.generation, "X-Voice-Sha256": snapshot.audio.sha256 } }) : Response.json({ error: "unavailable" }, { status: 503 });
      if (applied.has(body.requestId)) return Response.json(snapshot);
      if (body.revision !== snapshot.revision) return Response.json({ error: "conflict" }, { status: 409 });
      if (body.operation === "delete") { audio = null; snapshot = { ...snapshot, revision: snapshot.revision + 1, text: "", audio: null }; }
      else {
        const { operation: _, ...input } = body; void _;
        const parsed = parseVoiceSave(input);
        if (parsed.audio.operation === "replace") {
          audio = Uint8Array.from(atob(parsed.audio.wav), value => value.charCodeAt(0));
          const info = inspectVoiceWav(audio);
          snapshot = { ...snapshot, audio: { generation: crypto.randomUUID(), mime: "audio/wav", bytes: audio.length, samples: info.samples, sha256: await cloudSha256(audio.buffer) } };
        } else if (parsed.audio.operation === "remove") { audio = null; snapshot = { ...snapshot, audio: null }; }
        snapshot = { ...snapshot, revision: snapshot.revision + 1, text: parsed.text };
      }
      applied.add(body.requestId);
      if (loseAck.current) { loseAck.current = false; throw new Error("Simulated lost acknowledgement"); }
      return Response.json(snapshot);
    } });
    void openVoiceDraftJournal(ownerId, { databaseName, identity }).then(value => { if (closed) { value.close(); return; } journal = value; setRuntime({ client, journal }); }).catch(failure => { if (!closed) setError(String(failure)); });
    return () => { closed = true; editServer.current = null; client.close(); journal?.close(); };
  }, [generation]);
  return <main className="mx-auto max-w-2xl space-y-6 px-5 py-10"><h1 className="font-display text-3xl">PCM voice and recovery rehearsal</h1><p>Development fixture: native AudioWorklet capture and IndexedDB, with a simulated service that resets on page reload. Synthetic tone only. No microphone permission, real account or hosted upload is used.</p>
    <div className="flex flex-wrap gap-3 text-sm"><button className="rounded border border-border px-3 py-2" onClick={() => { loseAck.current = true; setNotice("The next save or delete acknowledgement will be lost."); }}>Lose next acknowledgement</button><button className="rounded border border-border px-3 py-2" onClick={() => { failPermission.current = true; setNotice("Access now denied. Refresh the caption to verify private content is cleared."); }}>Revoke simulated access</button><button className="rounded border border-border px-3 py-2" onClick={() => { runtime?.client.close(); runtime?.journal.close(); setRuntime(null); void removeCloudJournalForOwner(ownerId, { databaseName }).then(() => { failPermission.current = false; loseAck.current = false; setGeneration(value => value + 1); setNotice("Fixture reset and exact-owner drafts removed."); }); }}>Reset fixture and drafts</button></div>
    <button className="rounded border border-border px-3 py-2 text-sm" disabled={probing} onClick={() => { setProbing(true); setProbe([]); void runVoiceDraftProbe().then(setProbe).catch(failure => setError(String(failure))).finally(() => setProbing(false)); }}>Run native draft lifecycle checks</button>
    <button className="rounded border border-border px-3 py-2 text-sm" disabled={!runtime} onClick={() => { editServer.current?.(); setCaptionGeneration(value => value + 1); setNotice("Another simulated device saved a newer caption. The editor reopened with the same service and existing local draft."); }}>Simulate server edit and reopen caption</button>
    {probe.length > 0 && <ul className="list-disc space-y-1 pl-5 text-sm">{probe.map(check => <li key={check}>PASS: {check}</li>)}</ul>}
    {notice && <p role="status">{notice}</p>}{error && <p role="alert">{error}</p>}
    {runtime && <VoiceMemoryCaption key={`${generation}:${captionGeneration}`} activityId={activityId} client={runtime.client} journal={runtime.journal} acquire={acquire} synthetic />}
  </main>;
}
