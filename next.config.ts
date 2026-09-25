import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async headers() {
    return [
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
