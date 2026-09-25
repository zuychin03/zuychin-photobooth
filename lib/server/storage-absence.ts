const MAX_ERROR_BYTES = 4096;

// Call only after verifying the service-authenticated response's exact origin and path.
export async function isStorageObjectAbsent(response: Response, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted();
  if (response.status === 404) return true;
  if (response.status !== 400 || response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json" || !response.body) return false;
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_ERROR_BYTES)) return false;
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); }; signal?.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted(); const next = await reader.read(); signal?.throwIfAborted(); if (next.done) break;
      size += next.value.byteLength; if (size > MAX_ERROR_BYTES || chunks.length >= 64) return false; chunks.push(next.value);
    }
    if (length !== null && Number(length) !== size) return false;
    const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const error = value as Record<string, unknown>;
    return Object.keys(error).sort().join(",") === "code,error,message,statusCode" && error.code === "NoSuchKey" && error.error === "not_found" && error.message === "Object not found" && error.statusCode === "404";
  } catch { signal?.throwIfAborted(); return false; }
  finally { signal?.removeEventListener("abort", cancel); void reader.cancel().catch(() => {}); reader.releaseLock(); }
}
