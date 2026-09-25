"use client";

import { useEffect, useId, useRef, useState } from "react";
import { cloudControl, cloudInput } from "@/components/cloud/CloudControls";
import { createVoiceRecorder, VOICE_LIMITS, type VoiceDependencies, type VoiceRecording, type VoiceState } from "@/lib/memories/voice-recorder";

export default function VoiceCaption({ dependencies, synthetic = false }: { dependencies?: VoiceDependencies; synthetic?: boolean }) {
  const id = useId(), controller = useRef<ReturnType<typeof createVoiceRecorder> | null>(null);
  const objectUrl = useRef("");
  const [state, setState] = useState<VoiceState>("idle"), [recording, setRecording] = useState<VoiceRecording | null>(null);
  const [url, setUrl] = useState(""), [error, setError] = useState(""), [text, setText] = useState(""), [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const handle = createVoiceRecorder({ state: setState, ready: value => {
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = URL.createObjectURL(value.blob);
      setUrl(objectUrl.current); setRecording(value);
    }, error: setError }, dependencies);
    controller.current = handle;
    const leave = () => handle.cancel();
    window.addEventListener("pagehide", leave);
    return () => { window.removeEventListener("pagehide", leave); handle.cancel(); controller.current = null; if (objectUrl.current) URL.revokeObjectURL(objectUrl.current); };
  }, [dependencies]);
  useEffect(() => {
    if (state !== "recording") return;
    const start = performance.now();
    const interval = setInterval(() => setSeconds(Math.min(30, Math.floor((performance.now() - start) / 1000))), 250);
    return () => clearInterval(interval);
  }, [state]);
  const button = `${cloudControl} border border-border hover:bg-muted`;
  return <section className="space-y-4" aria-labelledby={`${id}-title`}>
    <h2 id={`${id}-title`} className="font-display text-2xl">Optional voice caption</h2>
    <p className="text-sm text-foreground/75">Up to 30 seconds and 10 MB. This rehearsal keeps audio and text in this tab only. Download before leaving. Nothing is attached to a memory.</p>
    <p role="status" className="text-sm">{state === "recording" ? `Recording: ${seconds} / 30 seconds` : state === "requesting" ? synthetic ? "Preparing synthetic audio…" : "Waiting for microphone permission…" : state === "finishing" ? "Finishing recording…" : recording ? `Ready: ${(recording.blob.size / 1024).toFixed(1)} KB` : "Ready when you are."}</p>
    <div className="flex flex-wrap gap-2">
      <button className={button} disabled={state !== "idle" || Boolean(recording)} onClick={() => { setError(""); setSeconds(0); void controller.current?.start(); }}>{synthetic ? "Record synthetic tone" : "Allow microphone and record"}</button>
      {state === "recording" && <button className={button} onClick={() => controller.current?.stop()}>Stop recording</button>}
      {state !== "idle" && <button className={button} onClick={() => controller.current?.cancel()}>Cancel recording</button>}
    </div>
    {error && <p role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</p>}
    {recording && url && <div className="space-y-3"><audio controls preload="metadata" src={url} aria-label="Voice caption playback" /><div className="flex flex-wrap gap-2"><a className={button} href={url} download={`voice-caption.${recording.extension}`}>Download audio</a><button className={button} onClick={() => { URL.revokeObjectURL(objectUrl.current); objectUrl.current = ""; setRecording(null); setUrl(""); }}>Delete audio</button></div></div>}
    <label htmlFor={`${id}-text`} className="block text-sm font-medium">Text alternative</label>
    <textarea id={`${id}-text`} className={cloudInput} rows={4} maxLength={VOICE_LIMITS.text} value={text} onChange={event => setText(event.target.value)} placeholder="Write what the recording says, or use text on its own." />
    <div className="flex flex-wrap gap-2"><button className={button} disabled={!text} onClick={() => {
      const link = document.createElement("a"), value = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
      link.href = value; link.download = "voice-caption.txt"; link.click(); setTimeout(() => URL.revokeObjectURL(value), 1000);
    }}>Download text</button><button className={button} disabled={!text} onClick={() => setText("")}>Delete text</button></div>
  </section>;
}
