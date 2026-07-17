import type { MetadataRoute } from "next";

import { publicSiteUrl } from "../lib/public-site";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: ["/", "/privacy", "/terms"],
      disallow: [
        "/app",
        "/admin",
        "/analytics",
        "/connections",
        "/decisions",
        "/draft",
        "/invite",
        "/login",
        "/projections",
        "/rankings",
        "/register",
        "/v1",
      ],
    },
    sitemap: new URL("/sitemap.xml", publicSiteUrl).toString(),
  };
}
