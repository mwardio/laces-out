import type { Metadata, MetadataRoute } from "next";

import { publicSiteUrl } from "./public-site";

type SitemapEntry = MetadataRoute.Sitemap[number];

/** One page this deployment asks search engines to index. */
export interface PublicPage {
  /** The route Next renders, e.g. `/privacy`. The landing page is `/`. */
  readonly path: string;
  /** Hand-set ISO calendar date, `YYYY-MM-DD`. */
  readonly lastModified: string;
  readonly changeFrequency: NonNullable<SitemapEntry["changeFrequency"]>;
  readonly priority: number;
}

/**
 * The single list of indexable pages. `sitemap.ts` publishes it and `robots.ts` builds its page
 * allow list from it, so the two can no longer drift; `public-pages.test.ts` holds the list against
 * the `metadata` each page file exports, so a page that opts into indexing without an entry here
 * (or the reverse) fails the suite.
 *
 * `lastModified` is hand-set on purpose. Git is excluded from the Docker build context, so commit
 * dates are unavailable at build time, and a build timestamp is a freshness signal search engines
 * learn to ignore. Updating a page is a one-line diff next to its path.
 */
export const publicPages: readonly PublicPage[] = [
  {
    // apps/web/src/app/page.tsx
    path: "/",
    lastModified: "2026-09-09",
    changeFrequency: "weekly",
    priority: 1,
  },
  {
    // apps/web/src/app/privacy/page.tsx — "Effective August 5, 2026".
    path: "/privacy",
    lastModified: "2026-08-05",
    changeFrequency: "monthly",
    priority: 0.4,
  },
  {
    // apps/web/src/app/terms/page.tsx — "Effective July 31, 2026".
    path: "/terms",
    lastModified: "2026-07-31",
    changeFrequency: "monthly",
    priority: 0.4,
  },
  {
    // apps/web/src/app/methodology/page.tsx — the receipt behind the landing page's proof claims.
    // It is indexable on purpose: an unfindable receipt does not support the claim it exists to back.
    path: "/methodology",
    lastModified: "2026-07-27",
    changeFrequency: "monthly",
    priority: 0.5,
  },
];

/**
 * The absolute URL of a public page.
 *
 * The root renders as the bare origin with no trailing slash because that is how Next's metadata
 * resolver renders `/` for the canonical link and `og:url`. Emitting `<origin>/` in the sitemap
 * would describe the same page with a second spelling.
 */
export function publicPageUrl(path: string): string {
  const url = new URL(path, publicSiteUrl);
  return path === "/" ? url.origin : url.toString();
}

/**
 * The Open Graph fields every public page shares.
 *
 * Next replaces the layout's `openGraph` object wholesale when a page declares one of its own, so a
 * page that set only `url` would lose `siteName`, `locale`, and `type`. The landing page spreads
 * this constant directly, `publicPageOpenGraph` folds it into every nested public page, and the
 * root layout declares it as well for the routes that set no `openGraph` at all.
 */
export const siteOpenGraph = {
  type: "website",
  siteName: "Laces Out",
  locale: "en_US",
} as const satisfies Metadata["openGraph"];

/**
 * The social card every public page shares, naming the `app/opengraph-image.tsx` route by its
 * unhashed path. `public-pages.test.ts` holds these values against that file.
 */
export const socialImage = {
  url: "/opengraph-image",
  width: 1200,
  height: 630,
  alt: "Laces Out: Connect your leagues. Get the next move.",
  type: "image/png",
} as const;

/**
 * Open Graph for a public page nested below the app root.
 *
 * Next merges the `opengraph-image` file into a page's Open Graph only while resolving the segment
 * that holds the file, and a page that declares `openGraph` replaces the object it inherited. A
 * nested page that names its `url` therefore has to name the image too, or it ships with none. The
 * landing page shares the root segment with the image route, so Next re-merges the content-hashed
 * image URL after the replacement — that page uses `siteOpenGraph` directly and must not declare
 * `images` here, or it would trade the hashed URL for this unhashed one.
 */
export function publicPageOpenGraph(path: string): NonNullable<Metadata["openGraph"]> {
  return { ...siteOpenGraph, url: path, images: [socialImage] };
}
