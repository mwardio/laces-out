import type { MetadataRoute } from "next";

import { publicPageUrl, publicPages } from "../lib/public-pages";

export default function sitemap(): MetadataRoute.Sitemap {
  return publicPages.map((page) => ({
    url: publicPageUrl(page.path),
    lastModified: new Date(`${page.lastModified}T00:00:00.000Z`),
    changeFrequency: page.changeFrequency,
    priority: page.priority,
  }));
}
