const RETURN_ORIGIN = "https://return-path.invalid";

export function safeAuthReturnPath(value: unknown): string {
  if (typeof value !== "string" || value.length > 4096 || !value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u001f\u007f-\u009f]/.test(value)) return "/";
  try {
    let path = value.split(/[?#]/, 1)[0];
    for (let depth = 0; depth < 4; depth++) {
      if (!path.startsWith("/") || path.startsWith("//") || /[\\\u0000-\u001f\u007f-\u009f]/.test(path)) return "/";
      const decoded = decodeURIComponent(path);
      if (decoded === path) break;
      path = decoded;
      if (depth === 3) return "/";
    }
    const target = new URL(value, RETURN_ORIGIN);
    if (target.origin !== RETURN_ORIGIN || target.username || target.password || target.pathname.startsWith("//")) return "/";
    return `${target.pathname}${target.search}${target.hash}`;
  } catch { return "/"; }
}
