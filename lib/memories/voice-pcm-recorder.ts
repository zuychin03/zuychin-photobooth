import { PCM_VOICE, encodeVoiceWav } from "./voice-wav";

export type PcmVoiceState = "idle" | "requesting" | "recording" | "finishing";
export function createPcmVoiceRecorder(callbacks: { state(value: PcmVoiceState): void; ready(blob: Blob): void; error(error: Error): void }, acquire: () => Promise<MediaStream> = () => navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true }, video: false })) {
  let generation = 0, busy = false, stream: MediaStream | undefined, context: AudioContext | undefined, node: AudioWorkletNode | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined, finishTimer: ReturnType<typeof setTimeout> | undefined;
  function release() {
    clearTimeout(timer); clearTimeout(finishTimer);
    stream?.getTracks().forEach(track => track.stop()); stream = undefined;
    if (node) { node.port.onmessage = null; node.port.close(); node.disconnect(); node = undefined; }
    if (context) { void context.close().catch(() => {}); context = undefined; }
  }
  function cancel() { generation++; busy = false; release(); callbacks.state("idle"); }
  function fail(error: unknown) { cancel(); callbacks.error(error instanceof Error ? error : new Error("Audio recording failed. Use a text caption instead.")); }
  function stop() {
    if (!node) return;
    callbacks.state("finishing"); clearTimeout(timer);
    node.port.postMessage("stop");
    stream?.getTracks().forEach(track => track.stop()); stream = undefined;
    clearTimeout(finishTimer); finishTimer = setTimeout(() => fail(new Error("Recording could not finish. Please try again.")), 3000);
  }
  async function start() {
    if (busy) return;
    busy = true; const ticket = ++generation;
    callbacks.state("requesting");
    try {
      const acquired = await acquire();
      if (ticket !== generation) { acquired.getTracks().forEach(track => track.stop()); return; }
      stream = acquired;
      timer = setTimeout(() => { if (ticket === generation) fail(new Error("Audio setup took too long. Use a text caption or try again.")); }, 10_000);
      context = new AudioContext({ sampleRate: PCM_VOICE.rate });
      if (context.sampleRate !== PCM_VOICE.rate || !context.audioWorklet) throw new Error("This browser cannot record this audio format. Use a text caption instead.");
      const current = context;
      await current.audioWorklet.addModule("/voice-pcm-worklet.js");
      if (ticket !== generation) return;
      await current.resume(); if (ticket !== generation) return;
      node = new AudioWorkletNode(current, "pb-voice-pcm", { channelCount: 1, channelCountMode: "explicit", numberOfOutputs: 0 });
      const samples = new Int16Array(PCM_VOICE.samples); let count = 0, sequence = 0;
      node.port.onmessage = event => {
        if (ticket !== generation) return;
        const value = event.data;
        if (value?.done === true) {
          if (value.samples !== count || count < 1) { fail(new Error("No complete audio was recorded.")); return; }
          const bytes = encodeVoiceWav(samples.subarray(0, count));
          cancel(); callbacks.ready(new Blob([bytes], { type: "audio/wav" })); return;
        }
        if (value?.sequence !== sequence++ || !(value.samples instanceof Int16Array) || value.samples.length < 1 || value.samples.length > PCM_VOICE.block || count + value.samples.length > samples.length) { fail(new Error("Recording exceeded its safe limits.")); return; }
        samples.set(value.samples, count); count += value.samples.length;
      };
      node.onprocessorerror = () => { if (ticket === generation) fail(new Error("Recording stopped unexpectedly. Use a text caption instead.")); };
      current.createMediaStreamSource(acquired).connect(node);
      callbacks.state("recording"); clearTimeout(timer); timer = setTimeout(stop, 30_000);
    } catch (error) { if (ticket === generation) fail(error instanceof DOMException && error.name === "NotAllowedError" ? new Error("Microphone access was declined. You can still write a caption.") : error); }
  }
  return { start, stop, cancel };
}
