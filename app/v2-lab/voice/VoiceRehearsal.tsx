"use client";

import VoiceCaption from "@/components/memories/VoiceCaption";
import type { VoiceDependencies } from "@/lib/memories/voice-recorder";

const synthetic: VoiceDependencies = {
  async getStream() {
    const context = new AudioContext(), destination = context.createMediaStreamDestination(), oscillator = context.createOscillator();
    try {
      await context.resume(); oscillator.frequency.value = 440; oscillator.connect(destination); oscillator.start();
      const track = destination.stream.getAudioTracks()[0], stop = track.stop.bind(track);
      track.stop = () => { stop(); oscillator.disconnect(); oscillator.stop(); void context.close(); };
      return destination.stream;
    } catch (error) { destination.stream.getTracks().forEach(track => track.stop()); await context.close(); throw error; }
  },
  supports: mime => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(mime),
  create: (stream, mimeType) => new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 64_000 }),
  now: () => performance.now(),
};
export default function VoiceRehearsal() {
  return <main className="mx-auto max-w-2xl space-y-8 px-5 py-10"><h1 className="font-display text-3xl">Voice caption rehearsal</h1><p>Synthetic tone only. This page never requests microphone access. Playback starts only when you press play.</p><VoiceCaption dependencies={synthetic} synthetic /></main>;
}
