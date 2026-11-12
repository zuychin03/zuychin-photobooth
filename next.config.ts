import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-hosted origin: ship the traced server bundle, not the repo.
  output: "standalone",
  poweredByHeader: false,
  // Page-data collection defaults to one worker per core; at this route count
  // that exhausts RAM on a 16 GB machine. Raise on a dedicated build runner.
  experimental: { cpus: Number(process.env.NEXT_BUILD_CPUS ?? 2) },
  async headers() {
    return [
      {
        // First, so the event routes below keep their no-referrer: Next keeps the later entry.
        source: "/:path*",
        headers: [
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(self), microphone=(self), geolocation=()" },
        ],
      },
      {
        // Revalidate so an old worker cannot pin the app to a stale build.
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
        ],
      },
      ...["/events/:id/join", "/receipt/:submissionId", "/e/:slug/gallery", "/e/:slug/wall", "/e/:slug/postcard", "/e/:slug/kiosk", "/kiosk-locked"].map(source => ({
        source,
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cache-Control", value: "private, no-store, max-age=0" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      })),
    ];
  },
};

export default nextConfig;
