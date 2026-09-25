"use client";

import { useEffect, useRef, useState } from "react";
import { encodeVoiceWav, inspectVoiceWav } from "@/lib/memories/voice-wav";

export default function WavPlayback() {
  const player = useRef<HTMLAudioElement>(null), objectUrl = useRef("");
  const [url, setUrl] = useState(""), [events, setEvents] = useState<string[]>([]);
  const record = (name: string, audio = player.current) => {
    const state = audio ? `${name}: ready ${audio.readyState}, time ${audio.currentTime.toFixed(3)}, duration ${Number.isFinite(audio.duration) ? audio.duration.toFixed(3) : "unknown"}, paused ${audio.paused}, error ${audio.error?.code ?? "none"}` : name;
    setEvents(previous => [...previous.slice(-11), state]);
  };
  useEffect(() => () => { if (objectUrl.current) URL.revokeObjectURL(objectUrl.current); }, []);
  return <main className="mx-auto max-w-2xl space-y-5 px-5 py-10">
    <h1 className="font-display text-3xl">Isolated WAV playback</h1>
    <p>Development fixture: one second of quiet 440 Hz tone, 48 kHz mono PCM16, exactly 96,044 bytes. It uses the production WAV writer, with no recording, microphone, AudioContext, journal or network service. Playback requires an explicit action.</p>
    <button className="rounded border border-border px-4 py-2" onClick={() => {
      player.current?.pause(); if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
      const samples = new Int16Array(48000);
      for (let i = 0; i < samples.length; i++) samples[i] = Math.round(Math.sin(2 * Math.PI * 440 * i / 48000) * 2000);
      const bytes = encodeVoiceWav(samples), info = inspectVoiceWav(bytes);
      objectUrl.current = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" })); setUrl(objectUrl.current);
      setEvents([`Fixture created: ${info.bytes} bytes, ${info.samples} samples, ${info.milliseconds} ms.`]);
    }}>Create one-second WAV fixture</button>
    {url && <>
      <audio ref={player} controls preload="metadata" src={url} aria-label="One-second WAV playback" onLoadedMetadata={event => record("loadedmetadata", event.currentTarget)} onCanPlayThrough={event => record("canplaythrough", event.currentTarget)} onPlay={event => record("play", event.currentTarget)} onPlaying={event => record("playing", event.currentTarget)} onPause={event => record("pause", event.currentTarget)} onEnded={event => record("ended", event.currentTarget)} onError={event => record("error", event.currentTarget)} />
      <div className="flex flex-wrap gap-3"><button className="rounded border border-border px-4 py-2" onClick={() => {
        const audio = player.current; if (!audio) return;
        audio.currentTime = 0;
        void audio.play().then(() => record("explicit play resolved", audio)).catch(error => record(`explicit play rejected: ${error instanceof Error ? error.name : "unknown"}`, audio));
      }}>Play with app button</button><button className="rounded border border-border px-4 py-2" onClick={() => player.current?.pause()}>Pause with app button</button><a className="rounded border border-border px-4 py-2" href={url} download="one-second-pcm.wav">Download fixture</a></div>
    </>}
    <ol aria-label="Playback event evidence" className="list-decimal space-y-2 pl-5 text-sm">{events.map((event, index) => <li key={`${index}:${event}`}>{event}</li>)}</ol>
    <p className="text-sm text-foreground/70">Compare the native audio Play control with the app Play button in separate fresh tabs if a renderer crashes. A crash alone does not identify whether the cause is the media, output device, browser or accessibility interaction.</p>
  </main>;
}
