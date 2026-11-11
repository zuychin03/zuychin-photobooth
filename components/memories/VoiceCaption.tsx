"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Mic } from "lucide-react";
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
  const button = "btn btn-quiet min-h-10 text-sm";
  return <section className="panel space-y-4 p-4 sm:p-6" aria-labelledby={`${id}-title`}>
    <div className="flex min-w-0 items-center gap-3"><span className="glyph bg-[#f43f5e]"><Mic size={18} strokeWidth={2.25} aria-hidden /></span><h2 id={`${id}-title`} className="font-display text-xl leading-tight">Optional voice caption</h2></div>
    <p className="text-sm text-muted-foreground">Up to 30 seconds and 10 MB. This rehearsal keeps audio and text in this tab only. Download before leaving. Nothing is attached to a memory.</p>
    <p role="status" className="text-sm font-bold">{state === "recording" ? `Recording: ${seconds} / 30 seconds` : state === "requesting" ? synthetic ? "Preparing synthetic audio…" : "Waiting for microphone permission…" : state === "finishing" ? "Finishing recording…" : recording ? `Ready: ${(recording.blob.size / 1024).toFixed(1)} KB` : "Ready when you are."}</p>
    <div className="flex flex-wrap gap-2">
      <button className="btn btn-tinted min-h-10 text-sm" disabled={state !== "idle" || Boolean(recording)} onClick={() => { setError(""); setSeconds(0); void controller.current?.start(); }}><Mic size={16} aria-hidden />{synthetic ? "Record synthetic tone" : "Allow microphone and record"}</button>
      {state === "recording" && <button className={button} onClick={() => controller.current?.stop()}>Stop recording</button>}
      {state !== "idle" && <button className={button} onClick={() => controller.current?.cancel()}>Cancel recording</button>}
    </div>
    {error && <p role="alert" className="notice border border-destructive/25 bg-destructive/8 font-bold text-destructive">{error}</p>}
    {recording && url && <div className="space-y-3"><audio controls preload="metadata" src={url} aria-label="Voice caption playback" className="w-full max-w-md" /><div className="flex flex-wrap gap-2"><a className={button} href={url} download={`voice-caption.${recording.extension}`}>Download audio</a><button className={button} onClick={() => { URL.revokeObjectURL(objectUrl.current); objectUrl.current = ""; setRecording(null); setUrl(""); }}>Delete audio</button></div></div>}
    <label htmlFor={`${id}-text`} className="block text-sm font-bold">Text alternative</label>
    <textarea id={`${id}-text`} className="field py-2.5 font-medium" rows={4} maxLength={VOICE_LIMITS.text} value={text} onChange={event => setText(event.target.value)} placeholder="Write what the recording says, or use text on its own." />
    <div className="flex flex-wrap gap-2"><button className={button} disabled={!text} onClick={() => {
      const link = document.createElement("a"), value = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
      link.href = value; link.download = "voice-caption.txt"; link.click(); setTimeout(() => URL.revokeObjectURL(value), 1000);
    }}>Download text</button><button className={button} disabled={!text} onClick={() => setText("")}>Delete text</button></div>
  </section>;
}
