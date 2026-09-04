import type { MetadataRoute } from "next";

import { publicSiteUrl } from "../lib/public-site";

export default function sitemap(): MetadataRoute.Sitemap {
  const landingUpdatedAt = new Date("2026-09-04T00:00:00.000Z");
  const legalUpdatedAt = new Date("2026-07-17T00:00:00.000Z");
  return [
    {
      url: new URL("/", publicSiteUrl).toString(),
      lastModified: landingUpdatedAt,
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: new URL("/privacy", publicSiteUrl).toString(),
      lastModified: legalUpdatedAt,
      changeFrequency: "monthly",
      priority: 0.4,
    },
    {
      url: new URL("/terms", publicSiteUrl).toString(),
      lastModified: legalUpdatedAt,
      changeFrequency: "monthly",
      priority: 0.4,
    },
    {
      // The receipt behind the landing page's proof claims. It is indexable on purpose: an
      // unfindable receipt does not support the claim it exists to back.
      url: new URL("/methodology", publicSiteUrl).toString(),
      lastModified: new Date("2026-07-27T00:00:00.000Z"),
      changeFrequency: "monthly",
      priority: 0.5,
    },
  ];
}
