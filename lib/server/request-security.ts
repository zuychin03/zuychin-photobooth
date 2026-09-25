import { canonicalPublicOrigin } from "./cron-auth";
import { authCallbackOrigin } from "../auth-callback-origin";

export class RequestValidationError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export function requireSameOrigin(request: Request, env: Record<string, string | undefined> = process.env): void {
  let expected = canonicalPublicOrigin(env.PB_PUBLIC_ORIGIN);
  if (!expected && env.NODE_ENV === "development") {
    const local = new URL(request.url);
    if (["localhost", "127.0.0.1", "[::1]"].includes(local.hostname)) {
      try { expected = authCallbackOrigin(request, env); }
      catch { throw new RequestValidationError(503, "Application origin is not configured"); }
      if (request.headers.has("host") && request.headers.get("host") !== new URL(expected).host) {
        throw new RequestValidationError(403, "Request origin is not allowed");
      }
    }
  }
  if (!expected) throw new RequestValidationError(503, "Application origin is not configured");
  if (request.headers.get("origin") !== expected || request.headers.get("sec-fetch-site") === "cross-site") {
    throw new RequestValidationError(403, "Request origin is not allowed");
  }
}

export async function readSmallJson(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") throw new RequestValidationError(415, "JSON is required");
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (!Number.isSafeInteger(declared) || declared < 0 || declared > 8192) throw new RequestValidationError(413, "Request is too large");
  if (!request.body) throw new RequestValidationError(400, "Request body is missing");
  const reader = request.body.getReader();
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; void reader.cancel().catch(() => {}); }, 5000);
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (timedOut) throw new RequestValidationError(408, "Request body timed out");
      if (done) break;
      bytes += value.length;
      if (bytes > 8192 || chunks.length >= 4096) { void reader.cancel().catch(() => {}); throw new RequestValidationError(413, "Request is too large"); }
      chunks.push(value);
    }
  } finally { clearTimeout(timeout); reader.releaseLock(); }
  const combined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.length; }
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(combined));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object required");
    return value as Record<string, unknown>;
  } catch { throw new RequestValidationError(400, "Invalid JSON object"); }
}
