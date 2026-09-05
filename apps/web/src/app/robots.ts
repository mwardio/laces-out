import type { MetadataRoute } from "next";

import { publicPages } from "../lib/public-pages";
import { publicSiteUrl } from "../lib/public-site";

/**
 * Paths a crawler has to fetch to render or unfurl a public page: the stylesheets, chunks, and font
 * subsets under `/_next/static/`, the generated social image, both icons, the manifest, the brand
 * marks, and the two crawl files themselves. Robots rules resolve by longest matching pattern, so
 * each of these beats the blanket `Disallow: /` below.
 *
 * `/_next/image` stays closed (the edge answers 404 for it) and so does `/api/`.
 */
const crawlableAssetPaths = [
  "/_next/static/",
  "/opengraph-image",
  "/icon.png",
  "/apple-icon.png",
  "/manifest.webmanifest",
  "/brand/",
  "/sitemap.xml",
  "/robots.txt",
];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: [
        // `/$` anchors the landing page so the blanket disallow still covers every product route.
        ...publicPages.map((page) => (page.path === "/" ? "/$" : page.path)),
        ...crawlableAssetPaths,
      ],
      disallow: ["/"],
    },
    sitemap: new URL("/sitemap.xml", publicSiteUrl).toString(),
  };
}
