import { cloudUuid } from "../projects/cloud-contract";

export const RETAINED_STRIP_LIMITS = Object.freeze({ bytes: 16 * 1024 * 1024, edge: 4096, pixels: 12 * 1024 * 1024, chunks: 4096, timeoutMs: 30000 });
export type RetainedAvailability = "available" | "archive_pending" | "archived";
export interface RetainedStripResolution { version: 1; id: string; availability: RetainedAvailability; bytesLimit: number }
export interface RetainedStripDownload extends RetainedStripResolution { blob: Blob; sha256: string; width: number; height: number }
export class RetainedStripError extends Error {
  constructor(readonly code: string, readonly status = 503, readonly retryAfterSeconds?: number) { super(code); }
}
export function retainedObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).length !== keys.length || Reflect.ownKeys(value).some(k => typeof k !== "string" || !keys.includes(k) || !("value" in Object.getOwnPropertyDescriptor(value, k)!))) throw new RetainedStripError("invalid_response");
  return value as Record<string, unknown>;
}
export function parseRetainedResolution(value: unknown, id: string): RetainedStripResolution {
  const v = retainedObject(value, ["version", "id", "availability", "bytesLimit"]);
  if (v.version !== 1 || cloudUuid(v.id) !== id || !["available", "archive_pending", "archived"].includes(v.availability as string) || v.bytesLimit !== RETAINED_STRIP_LIMITS.bytes) throw new RetainedStripError("invalid_response");
  return v as unknown as RetainedStripResolution;
}
export async function readRetainedBody(response: Response, maximum: number, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const declared = response.headers.get("content-length");
  if (signal.aborted || declared !== null && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > maximum)) { void response.body?.cancel().catch(() => {}); throw new RetainedStripError(signal.aborted ? "cancelled" : "response_too_large"); }
  if (!response.body) throw new RetainedStripError("invalid_response");
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); }; signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      if (signal.aborted) throw new RetainedStripError("cancelled");
      const item = await reader.read();
      if (signal.aborted) throw new RetainedStripError("cancelled");
      if (item.done) break;
      if (!(item.value instanceof Uint8Array) || !item.value.length || chunks.length >= RETAINED_STRIP_LIMITS.chunks || (size += item.value.length) > maximum) throw new RetainedStripError("response_too_large");
      chunks.push(item.value);
    }
    if (!size || declared !== null && Number(declared) !== size) throw new RetainedStripError("invalid_response");
    const output = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; } return output;
  } finally { signal.removeEventListener("abort", cancel); void reader.cancel().catch(() => {}); reader.releaseLock(); }
}
