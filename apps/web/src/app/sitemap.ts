import type { MetadataRoute } from "next";

import { publicSiteUrl } from "../lib/public-site";

export default function sitemap(): MetadataRoute.Sitemap {
  const updatedAt = new Date("2026-07-17T00:00:00.000Z");
  return [
    {
      url: new URL("/", publicSiteUrl).toString(),
      lastModified: updatedAt,
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: new URL("/privacy", publicSiteUrl).toString(),
      lastModified: updatedAt,
      changeFrequency: "monthly",
      priority: 0.4,
    },
    {
      url: new URL("/terms", publicSiteUrl).toString(),
      lastModified: updatedAt,
      changeFrequency: "monthly",
      priority: 0.4,
    },
  ];
}
