import { CLOUD_PROJECT_LIMITS, PROJECT_BUCKET, cloudUuid, parseCloudMember, parseCloudProject, parseCloudProjectList, parseCloudProjectView, parseProjectFinalisationStatus, parseProjectReservation, projectAssetPath, validateCloudAsset, type CloudAssetInput, type CloudProjectAsset } from "./cloud-contract";
import { CLOUD_DESIGN_LIMITS, designObject, designRevision, parseCloudDesignReceipt, parseCloudDesignHead, parseCloudDesignView, validateCloudDesign, type CloudDesignSnapshot } from "./cloud-design";

export interface CloudIdentity { ownerId: string; epoch: number }
export class CloudClientError extends Error {
  constructor(public readonly code: string, public readonly status = 0, public readonly retryAfterSeconds?: number) { super(code); this.name = "CloudClientError"; }
}
export { CloudClientError as CloudProjectClientError };
export interface CloudClientOptions {
  appOrigin: string; storageOrigin: string; identity(): CloudIdentity | null;
  accessToken(): Promise<string | null>; fetch?: typeof fetch; timeoutMs?: number;
}
export interface CloudSignedUpload { signedUrl: string; token: string; path: string }
const fail = (code = "invalid_response"): never => { throw new CloudClientError(code); };
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  return value as Record<string, unknown>;
}
function origin(value: string): string {
  let url: URL; try { url = new URL(value); } catch { return fail("invalid_configuration"); }
  if (url.origin !== value || url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) return fail("invalid_configuration");
  return url.origin;
}
function project(value: unknown) {
  const p = object(value);
  return parseCloudProject({ id: p.id, owner_id: p.ownerId, kind: p.kind, title: p.title, max_bytes: p.maxBytes, status: p.status, created_at: p.createdAt });
}
export async function cloudSha256(bytes: ArrayBuffer): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(v => v.toString(16).padStart(2, "0")).join("");
}
export function createCloudProjectClient(options: CloudClientOptions) {
  const appOrigin = origin(options.appOrigin), storageOrigin = origin(options.storageOrigin), fetcher = options.fetch ?? fetch;
  if (typeof location !== "undefined" && location.origin !== appOrigin) fail("invalid_configuration");
  const initial = options.identity();
  if (!initial) throw new CloudClientError("account_changed");
  const identity = { ownerId: cloudUuid(initial.ownerId), epoch: initial.epoch };
  if (!Number.isSafeInteger(identity.epoch)) fail("invalid_configuration");
  const lifetime = new AbortController(), timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) fail("invalid_configuration");
  function assertActive(signal?: AbortSignal) {
    const current = options.identity();
    if (!current || current.ownerId !== identity.ownerId || current.epoch !== identity.epoch) { lifetime.abort(); fail("account_changed"); }
    if (lifetime.signal.aborted || signal?.aborted) fail("cancelled");
  }
  async function bounded<T>(signal: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    assertActive(signal);
    const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(), timeoutMs);
    const combined = AbortSignal.any([lifetime.signal, deadline.signal, ...(signal ? [signal] : [])]);
    let rejectAbort: (() => void) | undefined;
    const interrupted = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(new CloudClientError(deadline.signal.aborted ? "timeout" : "cancelled"));
      combined.addEventListener("abort", rejectAbort, { once: true });
    });
    try { const result = await Promise.race([work(combined), interrupted]); assertActive(signal); return result; }
    catch (error) { assertActive(signal); if (error instanceof CloudClientError) throw error; throw new CloudClientError("network_error"); }
    finally { clearTimeout(timer); if (rejectAbort) combined.removeEventListener("abort", rejectAbort); }
  }
  async function bytes(response: Response, maximum: number, signal: AbortSignal): Promise<Uint8Array> {
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum)) { await response.body?.cancel(); return fail("response_too_large"); }
    if (!response.body) return new Uint8Array();
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    const cancel = () => { void reader.cancel().catch(() => undefined); };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      while (true) {
        assertActive(signal); const next = await reader.read(); assertActive(signal);
        if (next.done) break;
        size += next.value.byteLength; if (size > maximum || chunks.length >= 4096) return fail("response_too_large"); chunks.push(next.value);
      }
      const result = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; } return result;
    } finally { signal.removeEventListener("abort", cancel); await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  }
  async function request(operation: string, data: Record<string, unknown>, signal?: AbortSignal, design = false): Promise<unknown> {
    return bounded(signal, async active => {
      const token = await options.accessToken(); assertActive(active);
      if (!token || token.length > 16_384 || /[\s,]/.test(token)) fail("access_denied");
      const endpoint = `${appOrigin}/api/projects${design ? "/design" : ""}`;
      const response = await fetcher(endpoint, { method: "POST", credentials: "omit", cache: "no-store", redirect: "error", signal: active, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ operation, ...data }) });
      assertActive(active);
      if (response.redirected || (response.url && response.url !== endpoint)) fail();
      const raw = await bytes(response, 128 * 1024, active); assertActive(active);
      let value: unknown; try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)); } catch { return fail(); }
      if (!response.ok) {
        const code = object(value).error, allowed = ["access_denied", "origin_denied", "invalid_request", "conflict", "expired", "unavailable", "rate_limited", "quota_exceeded", "capacity", "not_found", "update_required"];
        const retry = Number(response.headers.get("retry-after"));
        throw new CloudClientError(typeof code === "string" && allowed.includes(code) ? code : "unavailable", response.status, response.status === 429 && Number.isSafeInteger(retry) && retry >= 1 && retry <= 60 ? retry : undefined);
      }
      return value;
    });
  }
  function signed(value: unknown, mode: "upload" | "read", path: string): string {
    if (typeof value !== "string" || value.length > 16_384) return fail();
    const url = new URL(value), expected = `/storage/v1/object/${mode === "upload" ? "upload/sign" : "sign"}/${PROJECT_BUCKET}/${path}`;
    if (url.origin !== storageOrigin || url.pathname !== expected || url.username || url.password || url.hash || [...url.searchParams.keys()].length !== 1 || !url.searchParams.get("token") || url.searchParams.get("token")!.length > 12_000) return fail();
    return url.href;
  }
  async function statusOperation(operation: "status" | "finalise", assetId: string, signal?: AbortSignal) {
    const result = parseProjectFinalisationStatus(await request(operation, { assetId: cloudUuid(assetId) }, signal));
    assertActive(signal); if (result.assetId !== assetId || (result.assetStatus === "ready" && result.status !== "complete")) fail(); return result;
  }
  const client = {
    ownerId: identity.ownerId, assertActive,
    close() { lifetime.abort(); },
    async designCapabilities(signal?: AbortSignal) {
      const v = designObject(await request("capabilities", {}, signal, true), ["designVersion", "retirementVersion", "limits", "referenceAssets"]);
      if (v.designVersion !== 1 || v.retirementVersion !== 1 || v.referenceAssets !== true || Object.entries(CLOUD_DESIGN_LIMITS).some(([key, value]) => object(v.limits)[key] !== value)) fail();
      return { designVersion: 1 as const, retirementVersion: 1 as const, limits: CLOUD_DESIGN_LIMITS, referenceAssets: true as const };
    },
    async designHead(projectId: string, signal?: AbortSignal) {
      return parseCloudDesignHead(await request("head", { projectId: cloudUuid(projectId) }, signal, true), projectId);
    },
    async readDesign(projectId: string, checkpoint: "current" | "previous" = "current", signal?: AbortSignal) {
      if (!["current", "previous"].includes(checkpoint)) fail("invalid_request");
      return parseCloudDesignView(await request("read", { projectId: cloudUuid(projectId), checkpoint }, signal, true), projectId);
    },
    async saveDesign(projectId: string, expectedRevision: number | null, requestId: string, snapshot: CloudDesignSnapshot, signal?: AbortSignal) {
      const expected = designRevision(expectedRevision), checked = validateCloudDesign(snapshot);
      const receipt = parseCloudDesignReceipt(await request("save", { projectId: cloudUuid(projectId), expectedRevision: expected, requestId: cloudUuid(requestId), snapshot: checked }, signal, true), projectId, requestId);
      if (receipt.revision !== (expected === null ? 0 : expected + 1)) fail(); return receipt;
    },
    async designSaveStatus(projectId: string, requestId: string, signal?: AbortSignal) {
      const v = designObject(await request("status", { projectId: cloudUuid(projectId), requestId: cloudUuid(requestId) }, signal, true), ["receipt"]);
      return v.receipt === null ? null : parseCloudDesignReceipt(v.receipt, projectId, requestId);
    },
    async capabilities(signal?: AbortSignal) {
      const value = object(await request("capabilities", {}, signal));
      const limits = object(value.limits);
      if (value.enabled !== true || value.version !== 1 || Object.entries(CLOUD_PROJECT_LIMITS).some(([key, limit]) => limits[key] !== limit)) fail();
      return { enabled: true as const, version: 1 as const, limits: CLOUD_PROJECT_LIMITS };
    },
    async list(after?: string, limit?: number, signal?: AbortSignal) {
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)) fail("invalid_request");
      const result = parseCloudProjectList(await request("list", { ...(after ? { after: cloudUuid(after) } : {}), ...(limit !== undefined ? { limit } : {}) }, signal));
      if (result.projects.length > (limit ?? 20) || (after && result.projects.some(p => p.id <= after))) fail(); return result;
    },
    async create(input: { id: string; kind: "personal" | "friend"; title: string; maxBytes: number }, signal?: AbortSignal) {
      cloudUuid(input.id); const result = project(await request("create", input, signal));
      if (result.id !== input.id || result.ownerId !== identity.ownerId) fail(); return result;
    },
    async view(projectId: string, signal?: AbortSignal) {
      const value = object(await request("view", { projectId: cloudUuid(projectId) }, signal)), p = project(value.project);
      const result = parseCloudProjectView({ project: { ...p, owner_id: p.ownerId, max_bytes: p.maxBytes, created_at: p.createdAt }, members: value.members, assets: value.assets });
      if (result.project.id !== projectId) fail(); return result;
    },
    async member(projectId: string, userId: string, action: "invite" | "accept" | "revoke", signal?: AbortSignal) {
      const v = object(await request("member", { projectId: cloudUuid(projectId), userId: cloudUuid(userId), action }, signal));
      const result = parseCloudMember({ project_id: v.projectId, user_id: v.userId, status: v.status });
      if (result.projectId !== projectId || result.userId !== userId) fail(); return result;
    },
    async reserve(projectId: string, input: CloudAssetInput, signal?: AbortSignal) {
      const asset = validateCloudAsset(input), v = object(await request("reserve", { projectId: cloudUuid(projectId), asset }, signal));
      const result = parseProjectReservation({ ...v, owner_id: v.ownerId, project_id: v.projectId, request_id: v.requestId, reserved_until: v.reservedUntil });
      if (result.projectId !== projectId || result.ownerId !== identity.ownerId || result.requestId !== asset.requestId || ["id", "kind", "mime", "bytes", "width", "height", "sha256"].some(key => result[key as keyof typeof result] !== asset[key as keyof CloudAssetInput])) fail(); return result;
    },
    async mintUpload(projectId: string, assetId: string, signal?: AbortSignal): Promise<CloudSignedUpload> {
      const path = projectAssetPath(projectId, identity.ownerId, assetId), v = object(await request("upload", { projectId, assetId }, signal));
      const signedUrl = signed(v.signedUrl, "upload", path);
      if (v.path !== path || v.token !== new URL(signedUrl).searchParams.get("token")) fail();
      return { signedUrl, token: v.token as string, path };
    },
    async upload(projectId: string, asset: CloudAssetInput, blob: Blob, grant: CloudSignedUpload, signal?: AbortSignal) {
      validateCloudAsset(asset); const path = projectAssetPath(projectId, identity.ownerId, asset.id), url = signed(grant.signedUrl, "upload", path);
      if (blob.size !== asset.bytes || grant.path !== path || grant.token !== new URL(url).searchParams.get("token")) fail("invalid_request");
      return bounded(signal, async active => {
        const response = await fetcher(url, { method: "PUT", body: blob, signal: active, redirect: "error", credentials: "omit", cache: "no-store", headers: { "Content-Type": asset.mime, "x-upsert": "false" } });
        assertActive(active); if (response.redirected || (response.url && response.url !== url)) fail();
        await bytes(response, 64 * 1024, active); assertActive(active);
        if (!response.ok && response.status !== 409) throw new CloudClientError("upload_uncertain", response.status);
        return { acknowledged: response.ok };
      });
    },
    status: (assetId: string, signal?: AbortSignal) => statusOperation("status", assetId, signal),
    finalise: (assetId: string, signal?: AbortSignal) => statusOperation("finalise", assetId, signal),
    async read(asset: Pick<CloudProjectAsset, "id" | "ownerId"> & { projectId: string }, signal?: AbortSignal) {
      const path = projectAssetPath(asset.projectId, asset.ownerId, asset.id), v = object(await request("read", { assetId: asset.id }, signal));
      if (v.expiresIn !== CLOUD_PROJECT_LIMITS.readSeconds) fail(); return { signedUrl: signed(v.signedUrl, "read", path), expiresIn: CLOUD_PROJECT_LIMITS.readSeconds };
    },
    async download(asset: CloudProjectAsset & { projectId: string }, signal?: AbortSignal): Promise<Blob> {
      validateCloudAsset({ id: asset.id, requestId: asset.id, kind: asset.kind, mime: asset.mime, bytes: asset.bytes, width: asset.width, height: asset.height, sha256: asset.sha256, protection: { kind: "none", id: null } });
      const grant = await client.read(asset, signal); assertActive(signal);
      return bounded(signal, async active => {
        const response = await fetcher(grant.signedUrl, { signal: active, credentials: "omit", redirect: "error", cache: "no-store" }); assertActive(active);
        if (!response.ok || response.redirected || (response.url && response.url !== grant.signedUrl)) fail("download_failed");
        const data = await bytes(response, asset.bytes, active); assertActive(active);
        if (data.byteLength !== asset.bytes || await cloudSha256(data.buffer as ArrayBuffer) !== asset.sha256) fail("integrity_failed"); assertActive(active);
        return new Blob([data as BlobPart], { type: asset.mime });
      });
    },
    async delete(projectId: string, assetId?: string, signal?: AbortSignal) {
      const value = object(await request("delete", { projectId: cloudUuid(projectId), ...(assetId ? { assetId: cloudUuid(assetId) } : {}) }, signal));
      if (typeof value.pending !== "boolean") fail(); return { pending: value.pending as boolean };
    },
  };
  function typed<Args extends unknown[], Result>(method: (...args: Args) => Promise<Result>) {
    return async (...args: Args): Promise<Result> => {
      try { return await method(...args); }
      catch (error) { if (error instanceof CloudClientError) throw error; throw new CloudClientError(error instanceof Error && error.message === "invalid_request" ? "invalid_request" : "invalid_response"); }
    };
  }
  return { ...client, designHead: typed(client.designHead), designCapabilities: typed(client.designCapabilities), readDesign: typed(client.readDesign), saveDesign: typed(client.saveDesign), designSaveStatus: typed(client.designSaveStatus), capabilities: typed(client.capabilities), list: typed(client.list), create: typed(client.create), view: typed(client.view), member: typed(client.member), reserve: typed(client.reserve), mintUpload: typed(client.mintUpload), upload: typed(client.upload), status: typed(client.status), finalise: typed(client.finalise), read: typed(client.read), download: typed(client.download), delete: typed(client.delete) };
}
export type CloudProjectClient = ReturnType<typeof createCloudProjectClient>;
