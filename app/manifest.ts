import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Zuychin Photobooth",
    short_name: "Photobooth",
    description:
      "Create photo strips on your own, capture together from anywhere, and share memories at events.",
    start_url: "/",
    display: "standalone",
    background_color: "#0c0a09",
    theme_color: "#0c0a09",
    icons: [
      { src: "/icon-192-v2.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512-v2.png", sizes: "512x512", type: "image/png", purpose: "any" },
      {
        src: "/icon-512-maskable-v2.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
