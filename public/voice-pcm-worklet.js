class VoicePcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super(); this.total = 0; this.used = 0; this.sequence = 0; this.done = false; this.block = new Int16Array(4096);
    this.port.onmessage = event => { if (event.data === "stop") this.finish(); };
  }
  flush() {
    if (!this.used) return;
    const block = this.block.slice(0, this.used);
    this.port.postMessage({ sequence: this.sequence++, samples: block }, [block.buffer]); this.used = 0;
  }
  finish() {
    if (this.done) return;
    this.done = true; this.flush(); this.port.postMessage({ done: true, samples: this.total });
  }
  process(inputs) {
    if (this.done) return false;
    const channel = inputs[0]?.[0];
    if (channel) for (let i = 0; i < channel.length && this.total < 1440000; i++) {
      const value = Math.max(-1, Math.min(1, Number.isFinite(channel[i]) ? channel[i] : 0));
      this.block[this.used++] = Math.round(value * (value < 0 ? 32768 : 32767)); this.total++;
      if (this.used === this.block.length) this.flush();
    }
    if (this.total >= 1440000) this.finish();
    return !this.done;
  }
}
registerProcessor("pb-voice-pcm", VoicePcmProcessor);
