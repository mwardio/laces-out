import { describe, expect, it } from "vitest";

import { publicPages } from "../lib/public-pages.js";
import { publicSiteUrl } from "../lib/public-site.js";
import robots from "./robots.js";

interface CrawlRule {
  readonly pattern: string;
  readonly allow: boolean;
}

function patternList(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function crawlRules(): CrawlRule[] {
  const { rules } = robots();
  const groups = Array.isArray(rules) ? rules : [rules];
  return groups.flatMap((group) => [
    ...patternList(group.allow).map((pattern) => ({ pattern, allow: true })),
    ...patternList(group.disallow).map((pattern) => ({ pattern, allow: false })),
  ]);
}

/** `*` matches any run of characters and a trailing `$` anchors the end of the path. */
function matchesPattern(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const literal = anchored ? pattern.slice(0, -1) : pattern;
  const source = literal
    .split("*")
    .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}${anchored ? "$" : ""}`, "u").test(path);
}

/**
 * The precedence Google and Bing both document: the rule with the longest matching pattern wins,
 * Allow wins a tie, and a path no rule matches is crawlable. `scripts/runtime-smoke.mjs` repeats
 * this evaluator against the served `robots.txt`; this Node build has no TypeScript support, so the
 * smoke script cannot import it from here.
 */
function isCrawlable(path: string): boolean {
  let winner: CrawlRule | undefined;
  for (const rule of crawlRules()) {
    if (!matchesPattern(rule.pattern, path)) continue;
    if (
      !winner ||
      rule.pattern.length > winner.pattern.length ||
      (rule.pattern.length === winner.pattern.length && rule.allow)
    ) {
      winner = rule;
    }
  }
  return winner ? winner.allow : true;
}

/**
 * One hand-written sample per kind of asset the landing HTML is known to reference: stylesheets,
 * chunks, the preloaded font subset, the social image, both icons, the manifest, the brand mark, and
 * the two crawl files. Blocking any of these makes Googlebot render the page without its styles or
 * scripts. The hashed filenames are shapes copied from one build, not values read back from the
 * current one — this fixture pins the rule evaluator, and `scripts/runtime-smoke.mjs` does the live
 * check by extracting the asset paths out of the served landing HTML.
 */
const landingAssetPaths = [
  "/_next/static/css/af0eb5cffb0463cc.css",
  "/_next/static/chunks/main-app-ead9e7334e90b83d.js",
  "/_next/static/media/f3f7e95f2dbc4fe4-s.p.woff2",
  "/opengraph-image?b1d687b3552702e0",
  "/icon.png?6e96ff3112dba918",
  "/apple-icon.png?2678bdab6fa26793",
  "/manifest.webmanifest",
  "/brand/laces-out-playbook-mark-96.webp",
  "/sitemap.xml",
  "/robots.txt",
];

describe("robots rules", () => {
  it("allows every asset the landing page needs to render and unfurl", () => {
    for (const path of landingAssetPaths) {
      expect(isCrawlable(path), path).toBe(true);
    }
  });

  it("allows every page in the public registry", () => {
    for (const page of publicPages) {
      expect(isCrawlable(page.path), page.path).toBe(true);
    }
  });

  it("keeps the product, the optimizer, and the API closed", () => {
    for (const path of ["/app", "/draft", "/_next/image?url=x", "/api/anything", "/settings"]) {
      expect(isCrawlable(path), path).toBe(false);
    }
  });

  it("anchors the landing allowance so it does not open the whole site", () => {
    expect(crawlRules()).toContainEqual({ pattern: "/$", allow: true });
    expect(isCrawlable("/not-a-public-page")).toBe(false);
  });

  it("points crawlers at the sitemap on the public origin", () => {
    expect(robots().sitemap).toBe(`${publicSiteUrl.origin}/sitemap.xml`);
  });
});
