import { createServerClient } from "@supabase/ssr";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { authCookieOptions } from "./cookie-options";

export function fetchWithDeadline(timeoutMs: number): typeof fetch {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("Invalid fetch deadline");
  return (input, init) => {
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (input instanceof Request) signals.push(input.signal);
    if (init?.signal) signals.push(init.signal);
    return fetch(input, { ...init, signal: AbortSignal.any(signals) });
  };
}

// Deadlines apply to each fetch, including its body, rather than a whole workflow.
export async function createClient(options: { fetchTimeoutMs?: number } = {}) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const globalOptions = options.fetchTimeoutMs === undefined ? undefined : { fetch: fetchWithDeadline(options.fetchTimeoutMs) };
  if (!url || !anonKey) {
    return createSupabaseClient(
      "https://placeholder.supabase.co",
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.placeholder",
      { global: globalOptions },
    );
  }

  const cookieStore = await cookies();
  return createServerClient(url, anonKey, {
    global: globalOptions,
    cookieOptions: authCookieOptions(),
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options),
          );
        } catch {
          // called from a Server Component; the proxy refreshes the session
        }
      },
    },
  });
}
