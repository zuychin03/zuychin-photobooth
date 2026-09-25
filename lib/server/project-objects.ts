import { CLOUD_PROJECT_LIMITS, PROJECT_BUCKET, cloudTimestamp, cloudUuid, projectAssetPath, type ProjectAssetAccess, type ProjectUploadAuthorisation } from "../projects/cloud-contract";
import { supabaseServiceOrigin } from "./cron-auth";
import { isStorageObjectAbsent } from "./storage-absence";

export interface ProjectObjectDescriptor { bucket: typeof PROJECT_BUCKET; path: string }
export interface ProjectObjectDownload extends ProjectObjectDescriptor { bytes?: number }
export interface ProjectObjects {
  mintUpload(authorisation: ProjectUploadAuthorisation): Promise<{ signedUrl: string; token: string; path: string }>;
  download(object: ProjectObjectDownload): Promise<Uint8Array>;
  signRead(access: ProjectAssetAccess): Promise<{ signedUrl: string }>;
  removeAndConfirmAbsent(object: ProjectObjectDescriptor): Promise<boolean>;
}
export interface ProjectObjectPorts { fetch?: typeof fetch; now?: () => number }
export class ProjectObjectError extends Error {
  constructor(readonly code: "invalid_descriptor" | "provider_failure" | "deadline" | "mint_expired" | "object_too_large" | "size_mismatch") { super(code); this.name = "ProjectObjectError"; }
}
const fail = (code: ProjectObjectError["code"]): never => { throw new ProjectObjectError(code); };
const DEADLINE_MS = 10_000, JSON_LIMIT = 64 * 1024;
function descriptor(value: ProjectObjectDescriptor): string {
  try {
    const parts = typeof value?.path === "string" ? value.path.split("/") : [];
    if (value.bucket !== PROJECT_BUCKET || parts.length !== 3 || projectAssetPath(parts[0], parts[1], parts[2]) !== value.path) return fail("invalid_descriptor");
    return value.path;
  } catch { return fail("invalid_descriptor"); }
}
function bytes(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > CLOUD_PROJECT_LIMITS.assetBytes) return fail("invalid_descriptor");
  return value;
}
function discard(response: Response): void { void response.body?.cancel().catch(() => {}); }
async function boundedBody(response: Response, limit: number, signal: AbortSignal): Promise<Uint8Array> {
  if (signal.aborted) { discard(response); return fail("deadline"); }
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) { discard(response); return fail("provider_failure"); }
  if (length !== null && Number(length) > limit) { discard(response); return fail("object_too_large"); }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  let size = 0, count = 0, complete = false;
  try {
    for (;;) {
      const next = await reader.read();
      if (signal.aborted) return fail("deadline");
      if (next.done) { complete = true; break; }
      if (!(next.value instanceof Uint8Array) || !next.value.byteLength || ++count > 4096) return fail("provider_failure");
      size += next.value.byteLength;
      if (size > limit) return fail("object_too_large");
      chunks.push(next.value);
    }
    if (length !== null && Number(length) !== size) return fail("size_mismatch");
    const output = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
    return output;
  } finally {
    signal.removeEventListener("abort", cancel);
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
function signedUrl(value: unknown, origin: string, path: string): { signedUrl: string; token: string } {
  try {
    if (typeof value !== "string" || value.length > 20_000) return fail("provider_failure");
    const url = new URL(value.startsWith("/object/") ? `${origin}/storage/v1${value}` : value);
    const token = url.searchParams.get("token");
    if (url.origin !== origin || url.pathname !== path || url.username || url.password || url.hash || [...url.searchParams.keys()].length !== 1 || !token || token.length > 16_384 || !/^[!-~]+$/.test(token)) return fail("provider_failure");
    return { signedUrl: url.href, token };
  } catch { return fail("provider_failure"); }
}

export function createProjectObjects(config: { origin: string; serviceRoleKey: string }, ports: ProjectObjectPorts = {}): ProjectObjects {
  const origin = supabaseServiceOrigin(config.origin), key = config.serviceRoleKey;
  if (!origin || typeof key !== "string" || !key || key.length > 16_384 || !/^[!-~]+$/.test(key)) return fail("invalid_descriptor");
  const transport = ports.fetch ?? fetch, now = ports.now ?? Date.now;
  async function request<T>(path: string, method: string, consume: (response: Response, signal: AbortSignal) => Promise<T>, body?: unknown, preflight?: () => void): Promise<T> {
    const url = `${origin}/storage/v1${path}`, abort = new AbortController();
    let expired = false, timer: ReturnType<typeof setTimeout> | undefined;
    const work = (async () => {
      preflight?.();
      const response = await transport(url, { method, headers: { Authorization: `Bearer ${key}`, apikey: key, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body), redirect: "error", cache: "no-store", signal: abort.signal });
      if (expired || response.redirected || response.url !== url || (response.status >= 300 && response.status < 400)) { discard(response); return fail(expired ? "deadline" : "provider_failure"); }
      return consume(response, abort.signal);
    })();
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { expired = true; abort.abort(); reject(new ProjectObjectError("deadline")); }, DEADLINE_MS); });
    try { return await Promise.race([work, timeout]); }
    catch (error) { if (error instanceof ProjectObjectError) throw error; return fail(expired ? "deadline" : "provider_failure"); }
    finally { clearTimeout(timer); abort.abort(); }
  }
  const json = async (response: Response, signal: AbortSignal): Promise<Record<string, unknown>> => {
    if (response.status !== 200) { discard(response); return fail("provider_failure"); }
    try {
      const data: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await boundedBody(response, JSON_LIMIT, signal)));
      if (!data || typeof data !== "object" || Array.isArray(data)) return fail("provider_failure");
      return data as Record<string, unknown>;
    } catch (error) { if (error instanceof ProjectObjectError) throw error; return fail("provider_failure"); }
  };
  return {
    async mintUpload(authorisation) {
      const path = descriptor(authorisation); bytes(authorisation.maxBytes);
      let mint: number, until: number, cleanup: number;
      try { mint = Date.parse(cloudTimestamp(authorisation.mintBefore)); until = Date.parse(cloudTimestamp(authorisation.uploadUntil)); cleanup = Date.parse(cloudTimestamp(authorisation.cleanupAfter)); }
      catch { return fail("invalid_descriptor"); }
      if (authorisation.overwrite !== false || until - mint !== CLOUD_PROJECT_LIMITS.uploadSeconds * 1000 || cleanup - until !== CLOUD_PROJECT_LIMITS.cleanupMarginSeconds * 1000 || mint > now() + 61_000) return fail("invalid_descriptor");
      const fence = () => { if (now() >= mint) return fail("mint_expired"); };
      const endpoint = `/object/upload/sign/${PROJECT_BUCKET}/${path}`;
      // Omitting x-upsert is the installed SDK's upsert:false protocol.
      const data = await request(endpoint, "POST", json, {}, fence);
      fence();
      return { ...signedUrl(data.url, origin, `/storage/v1${endpoint}`), path };
    },
    async download(object) {
      const path = descriptor(object), expectedBytes = object.bytes, limit = expectedBytes === undefined ? CLOUD_PROJECT_LIMITS.assetBytes : bytes(expectedBytes);
      return request(`/object/${PROJECT_BUCKET}/${path}`, "GET", async (response, signal) => {
        if (response.status !== 200) { discard(response); return fail("provider_failure"); }
        const content = await boundedBody(response, limit, signal);
        if (!content.byteLength || (expectedBytes !== undefined && content.byteLength !== expectedBytes)) return fail("size_mismatch");
        return content;
      });
    },
    async signRead(access) {
      const path = descriptor(access); bytes(access.bytes);
      try { if (cloudUuid(access.assetId) !== path.split("/")[2]) return fail("invalid_descriptor"); } catch { return fail("invalid_descriptor"); }
      if (access.expiresIn !== CLOUD_PROJECT_LIMITS.readSeconds || !["image/jpeg", "image/png", "image/webp"].includes(access.mime) || !/^[a-f0-9]{64}$/.test(access.sha256)) return fail("invalid_descriptor");
      const endpoint = `/object/sign/${PROJECT_BUCKET}/${path}`;
      const data = await request(endpoint, "POST", json, { expiresIn: CLOUD_PROJECT_LIMITS.readSeconds });
      return { signedUrl: signedUrl(data.signedURL, origin, `/storage/v1${endpoint}`).signedUrl };
    },
    async removeAndConfirmAbsent(object) {
      const path = descriptor(object);
      await request(`/object/${PROJECT_BUCKET}`, "DELETE", async (response, signal) => {
        if (response.status !== 200) { discard(response); return fail("provider_failure"); }
        await boundedBody(response, JSON_LIMIT, signal);
      }, { prefixes: [path] });
      const status = await request(`/object/${PROJECT_BUCKET}/${path}`, "HEAD", async head => {
        discard(head);
        return head.status;
      });
      if (status === 404) return true;
      if (status === 200) return false;
      if (status !== 400) return fail("provider_failure");
      return request(`/object/authenticated/${PROJECT_BUCKET}/${path}`, "GET", async (response, signal) => {
        try { if (response.status === 200) return false; if (await isStorageObjectAbsent(response, signal)) return true; }
        finally { discard(response); }
        return fail("provider_failure");
      });
    },
  };
}
