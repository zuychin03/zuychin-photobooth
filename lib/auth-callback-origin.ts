const loopback = (hostname: string) => ["localhost", "127.0.0.1", "[::1]"].includes(hostname);

export function authCallbackOrigin(request: Request, env: Record<string, string | undefined> = process.env): string {
  const incoming = new URL(request.url);
  let configured: URL | null = null;
  if (env.PB_PUBLIC_ORIGIN) {
    configured = new URL(env.PB_PUBLIC_ORIGIN);
    if (configured.origin !== env.PB_PUBLIC_ORIGIN || configured.username || configured.password ||
      (configured.protocol !== "https:" && !(env.NODE_ENV === "development" && configured.protocol === "http:" && loopback(configured.hostname)))) {
      throw new Error("Invalid application origin");
    }
  }
  // Next dev can reconstruct a loopback URL with a different loopback hostname.
  if (env.NODE_ENV === "development" && loopback(incoming.hostname) &&
    (!configured || loopback(configured.hostname) && configured.protocol === incoming.protocol && configured.port === incoming.port)) {
    const host = request.headers.get("host");
    if (host) {
      try {
        const local = new URL(`${incoming.protocol}//${host}`);
        if (local.host === host && loopback(local.hostname) && local.port === incoming.port) return local.origin;
      } catch { /* Malformed Host values never influence the redirect. */ }
    }
  }
  return configured?.origin ?? incoming.origin;
}
