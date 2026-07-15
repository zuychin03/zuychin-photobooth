import type { CookieOptionsWithName } from "@supabase/ssr";

// When Photobooth and a sibling app are served under one shared parent domain
// (e.g. booth.example.com + photos.example.com), scoping the auth cookie to that
// parent shares one session across both — sign into either, signed into both.
// Set NEXT_PUBLIC_COOKIE_DOMAIN to the parent with a leading dot (".example.com").
// Leave it unset on localhost or a single-domain deploy: host-only cookies are
// correct there, and a mismatched domain would be rejected by the browser.
export function authCookieOptions(): CookieOptionsWithName | undefined {
  const domain = process.env.NEXT_PUBLIC_COOKIE_DOMAIN;
  return domain ? { domain } : undefined;
}
