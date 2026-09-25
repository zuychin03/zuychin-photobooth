export const PCM_VOICE = { rate: 48_000, samples: 1_440_000, bytes: 2_880_044, text: 2000, block: 4096 } as const;
export function inspectVoiceWav(bytes: Uint8Array): { samples: number; milliseconds: number; bytes: number; mime: "audio/wav" } {
  const fail = (): never => { throw new Error("invalid_audio"); };
  if (bytes.byteLength < 46 || bytes.byteLength > PCM_VOICE.bytes) return fail();
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number, value: string) => [...value].every((c, i) => v.getUint8(offset + i) === c.charCodeAt(0));
  const data = v.getUint32(40, true);
  if (!tag(0, "RIFF") || !tag(8, "WAVE") || !tag(12, "fmt ") || !tag(36, "data") || v.getUint32(4, true) !== bytes.length - 8 || v.getUint32(16, true) !== 16 || v.getUint16(20, true) !== 1 || v.getUint16(22, true) !== 1 || v.getUint32(24, true) !== PCM_VOICE.rate || v.getUint32(28, true) !== PCM_VOICE.rate * 2 || v.getUint16(32, true) !== 2 || v.getUint16(34, true) !== 16 || data !== bytes.length - 44 || data % 2 || data < 2) return fail();
  const samples = data / 2;
  if (samples > PCM_VOICE.samples) return fail();
  return { samples, milliseconds: samples / PCM_VOICE.rate * 1000, bytes: bytes.length, mime: "audio/wav" };
}
export function encodeVoiceWav(samples: Int16Array): Uint8Array<ArrayBuffer> {
  if (!samples.length || samples.length > PCM_VOICE.samples) throw new Error("invalid_audio");
  const bytes = new Uint8Array(44 + samples.length * 2), v = new DataView(bytes.buffer);
  const tag = (offset: number, value: string) => [...value].forEach((c, i) => v.setUint8(offset + i, c.charCodeAt(0)));
  tag(0, "RIFF"); v.setUint32(4, bytes.length - 8, true); tag(8, "WAVE"); tag(12, "fmt "); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, PCM_VOICE.rate, true); v.setUint32(28, PCM_VOICE.rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); tag(36, "data"); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, samples[i], true);
  return bytes;
}
