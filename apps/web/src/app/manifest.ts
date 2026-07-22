import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/app",
    name: "Laces Out Fantasy Football",
    short_name: "Laces Out",
    description: "League-aware draft, lineup, waiver, and trade decisions.",
    start_url: "/app",
    scope: "/",
    display: "standalone",
    orientation: "any",
    categories: ["sports", "productivity", "utilities"],
    background_color: "#f3f2ec",
    theme_color: "#f3f2ec",
    icons: [
      {
        src: "/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
    ],
    shortcuts: [
      {
        name: "Draft room",
        short_name: "Draft",
        url: "/draft",
        icons: [{ src: "/icon-192.png", sizes: "192x192", type: "image/png" }],
      },
      {
        name: "Rankings studio",
        short_name: "Rankings",
        url: "/rankings",
        icons: [{ src: "/icon-192.png", sizes: "192x192", type: "image/png" }],
      },
    ],
  };
}
