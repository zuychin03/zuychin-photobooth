import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { authCookieOptions } from "@/lib/supabase/cookie-options";
import { kioskAllowsPath, kioskCookieValue, kioskLock } from "@/lib/events/kiosk-lock";
import { incomingFeature, isLocalRelease, localReleaseApiAllowed } from "@/lib/release-mode";

// Refreshes the Supabase session cookie on every request so Server Components
// read a valid session. Next.js 16 renamed the `middleware` convention to `proxy`.
export async function proxy(request: NextRequest) {
  const lock = kioskLock(kioskCookieValue(request.headers.get("cookie") ?? ""));
  if (lock) {
    if (!kioskAllowsPath(request.nextUrl.pathname,lock)) {
      if (request.nextUrl.pathname.startsWith("/api/")) return NextResponse.json({ error: "kiosk_locked" },{status:403,headers:{"Cache-Control":"private, no-store"}});
      return NextResponse.redirect(new URL(lock.path,request.url),{headers:{"Cache-Control":"private, no-store"}});
    }
    return NextResponse.next({headers:{"Cache-Control":"private, no-store"}});
  }
  // Reject before streamed layouts can turn a notFound result into HTTP 200.
  if (process.env.NODE_ENV === "production" && (request.nextUrl.pathname === "/v2-lab" || request.nextUrl.pathname.startsWith("/v2-lab/"))) {
    return new NextResponse("Not found", { status: 404, headers: { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow" } });
  }
  if (isLocalRelease()) {
    const pathname = request.nextUrl.pathname;
    const headers = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow" };
    if (pathname.startsWith("/api/")) {
      return localReleaseApiAllowed(pathname, request.method) ? NextResponse.next({ headers }) : NextResponse.json({ error: "feature_incoming" }, { status: 503, headers });
    }
    const feature = incomingFeature(pathname);
    if (feature) {
      const destination = new URL("/incoming", request.url);
      destination.searchParams.set("feature", feature);
      return NextResponse.rewrite(destination, { headers });
    }
    return NextResponse.next();
  }
  if (
    !process.env.NEXT_PUBLIC_SUPABASE_URL ||
    !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  ) {
    return NextResponse.next();
  }

  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookieOptions: authCookieOptions(),
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // Do not remove: refreshing here keeps cookies from going stale.
  await supabase.auth.getUser();

  return supabaseResponse;
}

export const config = {
  matcher: [
    "/api/:path*", "/events/:path*", "/e/:path*", "/room/:path*", "/relay/:path*",
    "/projects/cloud/:path*", "/challenges/:path*", "/memories/:path*", "/timeline/:path*",
    "/login/:path*", "/auth/:path*", "/together/:path*",
    "/((?!_next/static|_next/image|favicon.ico|mediapipe|models|stickers|.*\\.(?:svg|png|jpg|jpeg|gif|webp|tflite|wasm)$).*)",
  ],
};
