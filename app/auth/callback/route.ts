import { NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { safeAuthReturnPath } from "@/lib/auth-return-path";
import { cookies } from "next/headers";
import { authCookieOptions } from "@/lib/supabase/cookie-options";
import { authCallbackOrigin } from "@/lib/auth-callback-origin";

// Handles redirects from magic-link and email confirmations (PKCE code or token_hash).
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  let origin: string;
  try { origin = authCallbackOrigin(request); }
  catch { return new Response("Sign-in is temporarily unavailable.", { status: 503, headers: { "Cache-Control": "private, no-store" } }); }
  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type");
  const next = safeAuthReturnPath(searchParams.get("next"));
  const failure = new URL("/login", origin);
  failure.searchParams.set("error", "auth_callback_failed");
  failure.searchParams.set("next", next);
  const redirect = (target: URL) => NextResponse.redirect(target, { headers: { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" } });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const otpType = type === "signup" || type === "email" || type === "magiclink" || type === "invite" || type === "recovery" || type === "email_change" ? type : null;
  if (!url || !key || (!code && !(tokenHash && otpType))) return redirect(failure);

  try {
    const cookieStore = await cookies();
    const supabase = createServerClient(
      url,
      key,
      {
        cookieOptions: authCookieOptions(),
        cookies: {
          getAll() {
            return cookieStore.getAll();
          },
          setAll(cookiesToSet) {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          },
        },
      },
    );

    if (code) {
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      if (!error) return redirect(new URL(next, origin));
    }

    if (tokenHash && otpType) {
      const { error } = await supabase.auth.verifyOtp({
        token_hash: tokenHash,
        type: otpType,
      });
      if (!error) return redirect(new URL(next, origin));
    }
  } catch { /* Provider failures return to sign-in without echoing credentials. */ }
  return redirect(failure);
}
