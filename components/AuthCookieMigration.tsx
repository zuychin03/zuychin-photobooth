"use client";

import { useEffect } from "react";

const DOMAIN = process.env.NEXT_PUBLIC_COOKIE_DOMAIN;
const MAX_AGE = 400 * 24 * 60 * 60; // @supabase/ssr default cookie lifetime

export default function AuthCookieMigration() {
  useEffect(() => {
    if (!DOMAIN || !document.cookie) return;
    const seen = new Map<string, { value: string; count: number }>();
    for (const part of document.cookie.split("; ")) {
      const eq = part.indexOf("=");
      if (eq < 0) continue;
      const name = part.slice(0, eq);
      if (!name.startsWith("sb-")) continue;
      const entry = seen.get(name);
      if (entry) entry.count += 1;
      else seen.set(name, { value: part.slice(eq + 1), count: 1 });
    }
    for (const [name, { value, count }] of seen) {
      if (count === 1) {
        // Host-only gets promoted; an already-scoped cookie is rewritten in place.
        document.cookie = `${name}=${value}; domain=${DOMAIN}; path=/; max-age=${MAX_AGE}; secure; samesite=lax`;
      }
      // No domain attribute, so this only ever deletes the host-only copy.
      document.cookie = `${name}=; path=/; max-age=0`;
    }
  }, []);
  return null;
}
