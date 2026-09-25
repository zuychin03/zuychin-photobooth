import { cloudUuid } from "../projects/cloud-contract";
import { PCM_VOICE, inspectVoiceWav } from "./voice-wav";

export const VOICE_BODY_LIMIT = 3_850_000;
export class VoiceError extends Error { constructor(readonly code: string, readonly status = 503) { super(code); } }
export interface VoiceAudio { generation: string; bytes: number; samples: number; sha256: string; mime: "audio/wav" }
export interface VoiceCaptionSnapshot { version: 1; activityId: string; revision: number; text: string; audio: VoiceAudio | null }
export type VoiceAudioChange = { operation: "keep" | "remove" } | { operation: "replace"; wav: string };
export interface VoiceSave { requestId: string; revision: number; text: string; audio: VoiceAudioChange }
export function voiceObject(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new VoiceError("invalid_request", 400);
  return value as Record<string, unknown>;
}
export function voiceRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new VoiceError("invalid_request", 400);
  return value as number;
}
export function voiceText(value: unknown): string {
  if (typeof value !== "string" || value.length > PCM_VOICE.text || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new VoiceError("invalid_request", 400);
  return value;
}
export function parseVoiceSnapshot(value: unknown, activityId: string): VoiceCaptionSnapshot {
  const v = voiceObject(value, ["version", "activityId", "revision", "text", "audio"]);
  if (v.version !== 1 || cloudUuid(v.activityId) !== cloudUuid(activityId)) throw new VoiceError("invalid_response");
  let audio: VoiceAudio | null = null;
  if (v.audio !== null) {
    const a = voiceObject(v.audio, ["generation", "bytes", "samples", "sha256", "mime"]);
    if (!Number.isSafeInteger(a.samples) || (a.samples as number) < 1 || (a.samples as number) > PCM_VOICE.samples || a.bytes !== 44 + (a.samples as number) * 2 || a.mime !== "audio/wav" || typeof a.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(a.sha256)) throw new VoiceError("invalid_response");
    audio = { generation: cloudUuid(a.generation), bytes: a.bytes as number, samples: a.samples as number, sha256: a.sha256, mime: "audio/wav" };
  }
  return { version: 1, activityId, revision: voiceRevision(v.revision), text: voiceText(v.text), audio };
}
export function parseVoiceSave(value: unknown): VoiceSave {
  const v = voiceObject(value, ["requestId", "revision", "text", "audio"]), a = voiceObject(v.audio, ["operation", "wav"]);
  let audio: VoiceAudioChange;
  if (a.operation === "replace") {
    if (typeof a.wav !== "string" || !a.wav.length || a.wav.length % 4 || a.wav.length > Math.ceil(PCM_VOICE.bytes / 3) * 4 || /[^A-Za-z0-9+/=]/.test(a.wav) || a.wav.indexOf("=") !== -1 && !/^={1,2}$/.test(a.wav.slice(a.wav.indexOf("=")))) throw new VoiceError("invalid_request", 400);
    audio = { operation: "replace", wav: a.wav };
  } else if (["keep", "remove"].includes(a.operation as string) && Object.keys(a).length === 1) audio = { operation: a.operation as "keep" | "remove" };
  else throw new VoiceError("invalid_request", 400);
  return { requestId: cloudUuid(v.requestId), revision: voiceRevision(v.revision), text: voiceText(v.text), audio };
}
export async function voiceBlobBase64(blob: Blob): Promise<string> {
  if (blob.type !== "audio/wav" || blob.size > PCM_VOICE.bytes) throw new VoiceError("invalid_audio", 400);
  const bytes = new Uint8Array(await blob.arrayBuffer()); inspectVoiceWav(bytes);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
