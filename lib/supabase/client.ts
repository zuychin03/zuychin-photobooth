import { createBrowserClient } from "@supabase/ssr";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { authCookieOptions } from "./cookie-options";

// Shares the same Supabase project (and auth.users/profiles) as zuychin-gallery,
// so a Gallery account signs into Photobooth as the same identity.
export function createClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    // placeholder keeps build/prerender working when env is absent
    return createSupabaseClient(
      "https://placeholder.supabase.co",
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.placeholder",
    );
  }
  return createBrowserClient(url, anonKey, { cookieOptions: authCookieOptions() });
}

export function hasSupabase(): boolean {
  return !!(
    process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );
}
