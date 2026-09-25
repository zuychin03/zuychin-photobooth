import { v2 as cloudinary } from "cloudinary";
import { RETAINED_STRIP_LIMITS, RetainedStripError, readRetainedBody } from "../memories/retained-strip-contract";
import { supabaseServiceOrigin } from "./cron-auth";
import { parseRetainedDescriptor, type RetainedStripDescriptor } from "./retained-strip-store";

export interface RetainedStripObjects { read(descriptor: RetainedStripDescriptor, download: boolean, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer> | null> }
export function createRetainedStripObjects(env: Record<string, string | undefined>, transport: typeof fetch = fetch): RetainedStripObjects {
  const origin = supabaseServiceOrigin(env.NEXT_PUBLIC_SUPABASE_URL), key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!origin || !key?.trim()) throw new RetainedStripError("unavailable");
  const fail = (): never => { throw new RetainedStripError("source_unavailable", 409); };
  async function request<T>(url: string, init: RequestInit, signal: AbortSignal, consume: (response: Response, active: AbortSignal) => Promise<T>): Promise<T> {
    const timeout = new AbortController(), active = AbortSignal.any([signal, timeout.signal]);
    const timer = setTimeout(() => timeout.abort(), 10000);
    const task = (async () => {
      if (active.aborted) throw new RetainedStripError("cancelled", 408);
      const response = await transport(url, { ...init, cache: "no-store", redirect: "error", signal: active });
      try {
        if (active.aborted || response.redirected || response.url !== url || response.status !== 200) return fail();
        return await consume(response, active);
      } finally { void response.body?.cancel().catch(() => {}); }
    })();
    try { return await task; }
    finally { clearTimeout(timer); timeout.abort(); }
  }
  return {
    async read(raw, download, signal) {
      const d = parseRetainedDescriptor(raw, raw.id); let url: string, headers: HeadersInit | undefined, expectedBytes: number | undefined;
      if (d.archive) {
        const name = env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME, apiKey = env.CLOUDINARY_API_KEY, secret = env.CLOUDINARY_API_SECRET;
        if (!name || !/^[a-zA-Z0-9_-]{1,80}$/.test(name) || !apiKey || !/^\d{1,40}$/.test(apiKey) || !secret?.trim()) return fail();
        const publicId = d.archive.publicId, metadataUrl = `https://api.cloudinary.com/v1_1/${name}/resources/image/authenticated/${encodeURIComponent(publicId)}`;
        const metadata = await request(metadataUrl, { headers: { Authorization: `Basic ${Buffer.from(`${apiKey}:${secret}`).toString("base64")}` } }, signal, async (response, active) => {
          if (response.headers.get("content-type")?.split(";", 1)[0] !== "application/json") return fail();
          return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readRetainedBody(response, 64 * 1024, active))) as Record<string, unknown>;
        });
        if (metadata.public_id !== publicId || metadata.secure_url !== d.archive.url || metadata.type !== "authenticated" || metadata.resource_type !== "image" || metadata.format !== "png" || !Number.isSafeInteger(metadata.bytes) || (metadata.bytes as number) < 1 || (metadata.bytes as number) > RETAINED_STRIP_LIMITS.bytes || !Number.isSafeInteger(metadata.width) || !Number.isSafeInteger(metadata.height) || (metadata.width as number) < 1 || (metadata.height as number) < 1 || (metadata.width as number) > RETAINED_STRIP_LIMITS.edge || (metadata.height as number) > RETAINED_STRIP_LIMITS.edge || (metadata.width as number) * (metadata.height as number) > RETAINED_STRIP_LIMITS.pixels) return fail();
        const persisted = new URL(d.archive.url);
        if (persisted.pathname !== `/${name}/image/authenticated/v${metadata.version}/${publicId}.png` || !Number.isSafeInteger(metadata.version) || (metadata.version as number) < 1) return fail();
        const timestamp = Math.floor(Date.now() / 1000), expires = timestamp + 30;
        const options = { cloud_name: name, api_key: apiKey, api_secret: secret, upload_prefix: "https://api.cloudinary.com", secure: true, resource_type: "image" as const, type: "authenticated" as const, timestamp, expires_at: expires, attachment: false };
        url = cloudinary.utils.private_download_url(publicId, "png", options);
        const signed = new URL(url);
        if (signed.origin !== "https://api.cloudinary.com" || signed.pathname !== `/v1_1/${name}/image/download` || signed.username || signed.password || signed.hash || signed.searchParams.get("public_id") !== publicId || signed.searchParams.get("type") !== "authenticated" || signed.searchParams.get("format") !== "png" || Number(signed.searchParams.get("expires_at")) !== expires) return fail();
        expectedBytes = metadata.bytes as number;
      } else {
        url = `${origin}/storage/v1/object/photobooth-strips/${d.storagePath}`;
        headers = { Authorization: `Bearer ${key}`, apikey: key };
      }
      return request(url, { method: download ? "GET" : "HEAD", headers }, signal, async (response, active) => {
        if (response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "image/png") return fail();
        const length = response.headers.get("content-length");
        if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) < 1 || Number(length) > RETAINED_STRIP_LIMITS.bytes || expectedBytes !== undefined && Number(length) !== expectedBytes)) return fail();
        if (!download) return null;
        const bytes = await readRetainedBody(response, expectedBytes ?? RETAINED_STRIP_LIMITS.bytes, active);
        if (expectedBytes !== undefined && bytes.length !== expectedBytes) return fail();
        return bytes;
      });
    },
  };
}
