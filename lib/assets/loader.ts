import { inspectImageHeader } from "../projects/images";
import { ASSET_LIMITS, getCuratedAsset, type AssetVariant, type CuratedAsset } from "./registry";

export interface DecodedAsset { image: CanvasImageSource; width: number; height: number; close(): void }
export interface ReadyAsset { kind: "ready"; asset: CuratedAsset; image: CanvasImageSource; width: number; height: number; release(): void }
export interface FallbackAsset { kind: "fallback"; asset: CuratedAsset; fallback: CuratedAsset["fallback"]; reason: "unavailable" | "invalid" | "timeout" | "capacity" | "disposed" }
export type AssetLoadResult = ReadyAsset | FallbackAsset;
export interface AssetLoaderOptions {
  fetch?: typeof fetch;
  decode?: (blob: Blob) => Promise<DecodedAsset>;
  timeoutMs?: number;
}

async function browserDecode(blob: Blob): Promise<DecodedAsset> {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(blob);
    return { image: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
  }
  const url = URL.createObjectURL(blob), image = new Image();
  try {
    image.src = url;
    await image.decode();
    return { image, width: image.naturalWidth, height: image.naturalHeight, close: () => { image.src = ""; } };
  } finally { URL.revokeObjectURL(url); }
}

async function readBounded(response: Response, bytes: number): Promise<Uint8Array<ArrayBuffer>> {
  if (!response.ok || response.redirected || response.headers.get("content-type")?.split(";")[0].trim() !== "image/webp" || !response.body) throw new Error("unavailable");
  const length = response.headers.get("content-length");
  if (length !== null && Number(length) !== bytes) throw new Error("invalid");
  const output = new Uint8Array(bytes), reader = response.body.getReader();
  let offset = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (offset + chunk.value.byteLength > bytes) throw new Error("invalid");
      output.set(chunk.value, offset); offset += chunk.value.byteLength;
    }
    if (offset !== bytes) throw new Error("invalid");
    return output;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export function createAssetLoader(options: AssetLoaderOptions = {}) {
  const fetchAsset = options.fetch ?? fetch, decode = options.decode ?? browserDecode;
  const timeoutMs = Math.max(1, Math.min(ASSET_LIMITS.timeoutMs, options.timeoutMs ?? ASSET_LIMITS.timeoutMs));
  const ready = new Set<() => void>(), active = new Set<AbortController>();
  type Job = { asset: CuratedAsset; variant: AssetVariant; resolve: (result: AssetLoadResult) => void; timer: ReturnType<typeof setTimeout> };
  const pending: Job[] = [];
  let disposed = false, decoding = 0;
  const fallback = (asset: CuratedAsset, reason: FallbackAsset["reason"]): FallbackAsset => ({ kind: "fallback", asset, fallback: asset.fallback, reason });

  const pump = () => {
    while (!disposed && pending.length && active.size < ASSET_LIMITS.concurrentLoads && decoding < ASSET_LIMITS.concurrentLoads && active.size + ready.size < ASSET_LIMITS.liveHandles) {
      const job = pending.shift()!;
      clearTimeout(job.timer);
      const controller = new AbortController(); active.add(controller);
      void run(job, controller);
    }
  };
  const run = async (job: Job, controller: AbortController) => {
    const { asset, variant } = job, file = asset[variant];
    let timer: ReturnType<typeof setTimeout> | undefined, abandoned = false, decoded: DecodedAsset | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { abandoned = true; controller.abort(); reject(new Error("timeout")); }, timeoutMs);
      controller.signal.addEventListener("abort", () => { abandoned = true; reject(new Error(disposed ? "disposed" : "timeout")); }, { once: true });
    });
    const work = async () => {
      const bytes = await readBounded(await fetchAsset(file.path, { signal: controller.signal, credentials: "omit", redirect: "error", cache: "default" }), file.bytes);
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      if (Array.from(digest, value => value.toString(16).padStart(2, "0")).join("") !== file.sha256) throw new Error("invalid");
      const header = inspectImageHeader(bytes);
      if (header.mime !== "image/webp" || header.width !== file.width || header.height !== file.height) throw new Error("invalid");
      if (abandoned || disposed) throw new Error("disposed");
      decoding++;
      try {
        const result = await decode(new Blob([bytes], { type: "image/webp" }));
        if (abandoned || disposed) { result.close(); throw new Error("disposed"); }
        decoded = result;
      } finally { decoding--; pump(); }
      if (decoded.width !== file.width || decoded.height !== file.height) throw new Error("invalid");
      return decoded;
    };
    try {
      const resource = await Promise.race([work(), deadline]);
      let released = false;
      const release = () => { if (!released) { released = true; resource.close(); ready.delete(release); pump(); } };
      ready.add(release);
      job.resolve({ kind: "ready", asset, image: resource.image, width: resource.width, height: resource.height, release });
    } catch (error) {
      decoded?.close();
      const reason = error instanceof Error && ["invalid", "timeout", "disposed"].includes(error.message) ? error.message as FallbackAsset["reason"] : "unavailable";
      job.resolve(fallback(asset, reason));
    } finally { clearTimeout(timer); active.delete(controller); pump(); }
  };

  return {
    preload(id: string, variant: AssetVariant = "full"): Promise<AssetLoadResult> {
      const asset = getCuratedAsset(id);
      if (!asset || !["full", "thumbnail"].includes(variant)) return Promise.reject(new Error("Unknown curated asset or variant"));
      if (disposed) return Promise.resolve(fallback(asset, "disposed"));
      if (pending.length >= ASSET_LIMITS.pendingLoads) return Promise.resolve(fallback(asset, "capacity"));
      return new Promise(resolve => {
        const job: Job = { asset, variant, resolve, timer: setTimeout(() => {
          const index = pending.indexOf(job);
          if (index >= 0) { pending.splice(index, 1); resolve(fallback(asset, "capacity")); }
        }, timeoutMs) };
        pending.push(job); pump();
      });
    },
    dispose() {
      disposed = true;
      for (const job of pending.splice(0)) { clearTimeout(job.timer); job.resolve(fallback(job.asset, "disposed")); }
      for (const controller of active) controller.abort();
      for (const release of ready) release();
    },
  };
}
