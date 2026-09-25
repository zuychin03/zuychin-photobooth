export const VOICE_LIMITS = { milliseconds: 30_000, bytes: 10 * 1024 * 1024, text: 2000 } as const;
const formats = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"];
export function voiceExtension(mime: string): "webm" | "ogg" | "m4a" {
  const base = mime.split(";")[0].trim().toLowerCase();
  if (base === "audio/webm") return "webm";
  if (base === "audio/ogg") return "ogg";
  if (base === "audio/mp4") return "m4a";
  throw new Error("This recording format is not supported. Use a text caption instead.");
}
export type VoiceRecording = { blob: Blob; milliseconds: number; extension: ReturnType<typeof voiceExtension> };
export type VoiceState = "requesting" | "recording" | "finishing" | "idle";
export interface VoiceDependencies {
  getStream(): Promise<MediaStream>;
  supports(mime: string): boolean;
  create(stream: MediaStream, mime: string): MediaRecorder;
  now(): number;
}
const native: VoiceDependencies = {
  getStream: () => navigator.mediaDevices.getUserMedia({ audio: true, video: false }),
  supports: mime => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(mime),
  create: (stream, mimeType) => new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 64_000 }),
  now: () => performance.now(),
};
export function createVoiceRecorder(callbacks: { state(value: VoiceState): void; ready(value: VoiceRecording): void; error(message: string): void }, dependencies: VoiceDependencies = native) {
  let generation = 0, active = false, stream: MediaStream | undefined, recorder: MediaRecorder | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined, stoppedAt: number | undefined;
  function release() {
    clearTimeout(timer);
    stream?.getTracks().forEach(track => track.stop());
    stream = undefined;
  }
  function cancel() {
    generation++; active = false;
    if (recorder) {
      recorder.ondataavailable = recorder.onstop = recorder.onerror = null;
      if (recorder.state !== "inactive") recorder.stop();
    }
    recorder = undefined; release(); callbacks.state("idle");
  }
  function stop() {
    if (recorder?.state === "recording") {
      callbacks.state("finishing");
      stoppedAt = dependencies.now();
      recorder.stop(); release();
    }
  }
  async function start() {
    if (active) return;
    active = true;
    stoppedAt = undefined;
    const ticket = ++generation;
    callbacks.state("requesting");
    try {
      const mime = formats.find(dependencies.supports);
      if (!mime) throw new Error("Voice recording is unavailable here. Use a text caption instead.");
      const acquired = await dependencies.getStream();
      if (ticket !== generation) { acquired.getTracks().forEach(track => track.stop()); return; }
      stream = acquired;
      recorder = dependencies.create(stream, mime);
      const current = recorder, chunks: Blob[] = [];
      let bytes = 0;
      const started = dependencies.now();
      current.ondataavailable = event => {
        if (ticket !== generation || !event.data.size) return;
        bytes += event.data.size;
        if (bytes > VOICE_LIMITS.bytes) { cancel(); callbacks.error("Recording exceeded 10 MB. Please record a shorter caption."); return; }
        chunks.push(event.data);
      };
      current.onerror = () => { if (ticket === generation) { cancel(); callbacks.error("Recording failed. Try again or use a text caption."); } };
      current.onstop = () => {
        if (ticket !== generation) return;
        const elapsed = (stoppedAt ?? dependencies.now()) - started;
        release(); recorder = undefined; active = false; callbacks.state("idle");
        try {
          if (elapsed > VOICE_LIMITS.milliseconds) throw new Error("Recording ran beyond 30 seconds. Please try a shorter caption.");
          const actualMime = current.mimeType || chunks[0]?.type || "";
          const extension = voiceExtension(actualMime), blob = new Blob(chunks, { type: actualMime });
          if (!blob.size) throw new Error("No audio was recorded. Try again or use a text caption.");
          callbacks.ready({ blob, milliseconds: Math.min(elapsed, VOICE_LIMITS.milliseconds), extension });
        } catch (error) { callbacks.error(error instanceof Error ? error.message : "Recording could not be saved."); }
      };
      current.start(250);
      callbacks.state("recording");
      timer = setTimeout(stop, VOICE_LIMITS.milliseconds - 100);
    } catch (error) {
      if (ticket !== generation) return;
      cancel();
      callbacks.error(error instanceof DOMException && error.name === "NotAllowedError" ? "Microphone access was declined. You can still write a caption." : error instanceof Error ? error.message : "Microphone unavailable. Use a text caption instead.");
    }
  }
  return { start, stop, cancel };
}
