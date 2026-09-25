export interface UploadRpc {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}
export interface UploadIntent {
  requestId: string;
  sourceId: string;
  sourceType: "strip" | "relay";
  owner: string;
  paths: string[];
}
export interface UploadIdentity { id?: string; requestId?: string }
export class UploadSaveError extends Error {
  constructor(message: string, readonly restartRequired: boolean) { super(message); this.name = "UploadSaveError"; }
}
export const MAX_UPLOAD_BYTES = 16 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function requireUuid(value: string): void {
  if (!UUID.test(value)) throw new Error("Invalid media identity. Start a new save.");
}

export function cloudWriteError(error: unknown): Error {
  const message = error && typeof error === "object" && "message" in error ? String(error.message) : "";
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (code === "PGRST202" || code === "42883" || message.includes("PB_LIFECYCLE_NOT_CONFIGURED")) {
    return new Error("Cloud saving is unavailable until this deployment's storage setup is complete. Your photos remain in this browser.");
  }
  if (message.includes("PB_WEEKLY_QUOTA_EXCEEDED")) return new Error("The weekly cloud save limit has been reached. Download your photos or try again next week.");
  if (message.includes("PB_UPLOAD_EXPIRED")) return new UploadSaveError("This upload attempt has expired. Start a new save using your retained photos.", true);
  if (message.includes("PB_UPLOAD_CLEANUP_PENDING")) return new Error("The previous upload is being cleaned up. Keep this page open and retry shortly; your photos are still here.");
  if (error instanceof Error) return error;
  return new Error("Cloud saving failed. Your photos remain in this browser; please try again.");
}

function intentState(data: unknown, intent: UploadIntent, generation?: number): "registered" | "complete" | "failed" {
  if (Array.isArray(data)) data = data.length === 1 ? data[0] : null;
  if (!data || typeof data !== "object") throw new Error("Upload registration could not be confirmed.");
  const row = data as Record<string, unknown>;
  if (row.id !== intent.requestId || row.owner !== intent.owner || row.source_id !== intent.sourceId || row.source_type !== intent.sourceType
    || JSON.stringify(row.paths) !== JSON.stringify(intent.paths) || !["registered", "complete", "failed"].includes(String(row.status))
    || !Number.isInteger(row.generation) || Number(row.generation) < 1 || Number(row.generation) > 8 || (generation !== undefined && row.generation !== generation)) {
    throw new Error("Upload registration did not match this save.");
  }
  return row.status as "registered" | "complete" | "failed";
}

export async function withUploadIntent<T>(
  client: UploadRpc,
  intent: UploadIntent,
  recover: () => Promise<T | null>,
  write: () => Promise<T>,
): Promise<T> {
  requireUuid(intent.requestId);
  requireUuid(intent.sourceId);
  requireUuid(intent.owner);
  if (!intent.paths.length || intent.paths.length > 4 || new Set(intent.paths).size !== intent.paths.length
    || intent.paths.some(path => !path.startsWith(`${intent.owner}/`) || path.includes("..") || path.includes("\\"))) {
    throw new Error("Invalid upload paths.");
  }
  const role = intent.paths[0].endsWith("/A-0.jpg") ? "A" : "B";
  if (intent.sourceType === "strip" ? intent.paths.length !== 1 || intent.paths[0] !== `${intent.owner}/${intent.sourceId}.png`
    : intent.paths.some((path, index) => path !== `${intent.owner}/relay-${intent.sourceId}/${role}-${index}.jpg`)) {
    throw new Error("Invalid upload paths.");
  }
  const registration = await client.rpc("pb_register_upload", {
    p_request_id: intent.requestId, p_source_id: intent.sourceId, p_source_type: intent.sourceType, p_paths: intent.paths,
  });
  if (registration.error) throw cloudWriteError(registration.error);
  const state = intentState(registration.data, intent);
  const registered = (Array.isArray(registration.data) ? registration.data[0] : registration.data) as { generation: number };
  if (state === "failed") throw new Error("This upload attempt has expired. Start a new save.");
  const finish = async (success: boolean) => {
    const result = await client.rpc("pb_finish_upload", { p_request_id: intent.requestId, p_success: success, p_generation: registered.generation });
    if (result.error) throw cloudWriteError(result.error);
    return intentState(result.data, intent, registered.generation);
  };
  try {
    const previous = await recover();
    if (previous !== null) {
      if (await finish(true) !== "complete") throw new Error("Cloud save confirmation is pending. Refresh before retrying.");
      return previous;
    }
    if (state === "complete") throw new Error("The saved media is no longer available. Start a new save.");
    const result = await write();
    if (await finish(true) !== "complete") throw new Error("Cloud save confirmation is pending. Refresh before retrying.");
    return result;
  } catch (error) {
    try {
      // The database checks references again before it queues any cleanup.
      const state = await finish(false);
      if (state === "complete") {
        const recovered = await recover();
        if (recovered !== null) return recovered;
        throw new Error("The saved reference could not be read.");
      }
      if (state !== "failed") throw new Error("Upload cleanup was not confirmed.");
    } catch {
      throw new Error("Cloud save could not be confirmed. Keep this page open and check your vault before retrying.");
    }
    throw new UploadSaveError(cloudWriteError(error).message, true);
  }
}

export async function relayUploadRequestId(sourceId: string, owner: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`relay:${sourceId}:${owner}`))).slice(0, 16);
  bytes[6] = (bytes[6] & 15) | 80;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface ImmutableUploadStore {
  upload(path: string, blob: Blob, options: { contentType: string; upsert: false }): PromiseLike<{ error: unknown }>;
  download(path: string): PromiseLike<{ data: Blob | null; error: unknown }>;
}

export async function uploadImmutable(store: ImmutableUploadStore, path: string, blob: Blob, type: string): Promise<void> {
  if (!blob.size || blob.size > MAX_UPLOAD_BYTES || blob.type !== type) throw new Error("The photo format or size is not supported for cloud saving.");
  const result = await store.upload(path, blob, { contentType: type, upsert: false });
  if (!result.error) return;
  const existing = await store.download(path);
  if (!existing.error && existing.data?.size === blob.size) {
    const hash = async (value: Blob) => new Uint8Array(await crypto.subtle.digest("SHA-256", await value.arrayBuffer()));
    const [a, b] = await Promise.all([hash(blob), hash(existing.data)]);
    if (a.every((value, index) => value === b[index])) return;
  }
  throw cloudWriteError(result.error);
}

export async function readBoundedImage(response: Response): Promise<Blob> {
  if (!response.ok) throw new Error("A relay photo could not be downloaded. Please try again.");
  const type = response.headers.get("content-type")?.split(";")[0] ?? "";
  const declaredSize = Number(response.headers.get("content-length"));
  if (!type.startsWith("image/") || declaredSize > MAX_UPLOAD_BYTES || !response.body) {
    await response.body?.cancel();
    throw new Error("A relay photo has an unsupported size or format.");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_UPLOAD_BYTES) throw new Error("A relay photo exceeds the supported size.");
      chunks.push(new Uint8Array(chunk.value));
    }
  } catch (error) {
    await reader.cancel();
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (!size) throw new Error("A relay photo was empty. Please try again.");
  return new Blob(chunks, { type });
}
