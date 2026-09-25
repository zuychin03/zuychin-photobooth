import { createHash, timingSafeEqual } from "node:crypto";

export type CronEnvironment = Record<string, string | undefined>;
export interface CronConfig {
  supabaseUrl: string;
  serviceRoleKey: string;
}

export function privateJson(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export function supabaseServiceOrigin(value: string | undefined): string | null {
  if (!value || value !== value.trim()) return null;
  try {
    const url = new URL(value);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return null;
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function canonicalPublicOrigin(value: string | undefined): string | null {
  const origin = supabaseServiceOrigin(value);
  return origin?.startsWith("https://") ? origin : null;
}

export function authorizeCron(
  request: Request,
  env: CronEnvironment = process.env,
): { ok: true; config: CronConfig } | { ok: false; response: Response } {
  const secret = env.CRON_SECRET;
  const supabaseUrl = supabaseServiceOrigin(env.NEXT_PUBLIC_SUPABASE_URL);
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret?.trim() || !supabaseUrl || !serviceRoleKey?.trim()) {
    return { ok: false, response: privateJson({ error: "maintenance unavailable" }, 503) };
  }
  const provided = /^Bearer ([^\s]+)$/i.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
  const hash = (value: string) => createHash("sha256").update(value).digest();
  const matches = timingSafeEqual(hash(provided), hash(secret));
  if (!provided || !matches || new URL(request.url).searchParams.has("secret")) {
    return { ok: false, response: privateJson({ error: "unauthorized" }, 401) };
  }
  return { ok: true, config: { supabaseUrl, serviceRoleKey } };
}
