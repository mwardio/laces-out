import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import sitemap from "../app/sitemap.js";
import {
  publicPageOpenGraph,
  publicPageUrl,
  publicPages,
  siteOpenGraph,
  socialImage,
} from "./public-pages.js";
import { publicSiteUrl } from "./public-site.js";

const appDirectory = fileURLToPath(new URL("../app", import.meta.url));
/**
 * A floor that catches a mistyped year. It is the oldest date the sitemap ever published, so no
 * real page can legitimately be older.
 */
const oldestAllowedDate = "2026-07-17";

interface PageFile {
  /** The route the file renders, e.g. `/privacy`; the app root renders `/`. */
  readonly routePath: string;
  readonly file: string;
  /**
   * The exported `metadata` object, whitespace-collapsed. Vitest cannot import a `page.tsx`
   * (`jsx: "preserve"` leaves the JSX in place), so the declarations are read as text — the same
   * approach `app/methodology/evidence.test.ts` takes.
   */
  readonly metadata: string;
}

function metadataSource(source: string): string {
  const start = source.indexOf("export const metadata");
  if (start === -1) return "";
  const end = source.indexOf("\n};", start);
  return source.slice(start, end === -1 ? undefined : end).replace(/\s+/gu, " ");
}

function collectPageFiles(directory: string, routePath: string, found: PageFile[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      collectPageFiles(join(directory, entry.name), `${routePath}/${entry.name}`, found);
    } else if (entry.name === "page.tsx") {
      const file = join(directory, entry.name);
      found.push({
        routePath: routePath === "" ? "/" : routePath,
        file,
        metadata: metadataSource(readFileSync(file, "utf8")),
      });
    }
  }
}

const pageFiles: PageFile[] = [];
collectPageFiles(appDirectory, "", pageFiles);

function pageFor(routePath: string): PageFile {
  const page = pageFiles.find((candidate) => candidate.routePath === routePath);
  if (!page) throw new Error(`no page.tsx renders ${routePath}`);
  return page;
}

function declaresIndexable(metadata: string): boolean {
  return /robots: \{[^}]*index: true/u.test(metadata);
}

function declaresNoindex(metadata: string): boolean {
  return /robots: \{[^}]*index: false/u.test(metadata);
}

function canonicalPath(metadata: string): string | undefined {
  return /alternates: \{[^}]*canonical: "([^"]*)"/u.exec(metadata)?.[1];
}

describe("public page registry", () => {
  it("finds the page files it is supposed to describe", () => {
    expect(pageFiles.length).toBeGreaterThan(publicPages.length);
    expect(pageFiles.map((page) => page.routePath)).toContain("/");
  });

  it("lists only paths that a page.tsx opts into indexing with a matching canonical", () => {
    for (const page of publicPages) {
      const file = pageFor(page.path);
      expect(declaresIndexable(file.metadata), `${file.file} does not set robots.index`).toBe(true);
      expect(canonicalPath(file.metadata), `${file.file} canonical`).toBe(page.path);
    }
  });

  it("never lists a route that also declares itself noindex", () => {
    for (const page of publicPages) {
      expect(declaresNoindex(pageFor(page.path).metadata), `${page.path} is noindex`).toBe(false);
    }
  });

  it("registers every page.tsx that opts into indexing", () => {
    const indexable = pageFiles
      .filter((page) => declaresIndexable(page.metadata))
      .map((page) => page.routePath)
      .sort();
    expect(indexable).toEqual([...publicPages.map((page) => page.path)].sort());
  });

  it("uses each path once and anchors it at the site root", () => {
    const paths = publicPages.map((page) => page.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const path of paths) expect(path.startsWith("/")).toBe(true);
  });
});

describe("lastModified discipline", () => {
  const oldestAllowed = Date.parse(`${oldestAllowedDate}T00:00:00.000Z`);

  it("hand-sets a real calendar date that is neither in the future nor implausibly old", () => {
    for (const page of publicPages) {
      const label = `${page.path} lastModified`;
      expect(page.lastModified, label).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
      const parsed = new Date(`${page.lastModified}T00:00:00.000Z`);
      // A round-trip rejects a date that parses but does not exist, such as 2026-02-31.
      expect(parsed.toISOString().slice(0, 10), label).toBe(page.lastModified);
      expect(parsed.getTime(), label).toBeLessThanOrEqual(Date.now());
      expect(parsed.getTime(), label).toBeGreaterThanOrEqual(oldestAllowed);
    }
  });

  it("gives each page a priority and change frequency the sitemap can publish", () => {
    for (const page of publicPages) {
      expect(page.priority, page.path).toBeGreaterThan(0);
      expect(page.priority, page.path).toBeLessThanOrEqual(1);
      expect(page.changeFrequency.length, page.path).toBeGreaterThan(0);
    }
  });
});

describe("public page URLs", () => {
  it("renders the root as the bare origin so the canonical and the sitemap agree", () => {
    expect(publicPageUrl("/")).toBe(publicSiteUrl.origin);
    expect(publicPageUrl("/").endsWith("/")).toBe(false);
  });

  it("renders every other page as an absolute URL on the public origin", () => {
    expect(publicPageUrl("/privacy")).toBe(`${publicSiteUrl.origin}/privacy`);
  });
});

describe("public page Open Graph", () => {
  const socialImageSource = readFileSync(
    fileURLToPath(new URL("../app/opengraph-image.tsx", import.meta.url)),
    "utf8",
  );

  it("carries the site defaults, the page's own URL, and the social image", () => {
    // Next drops the inherited image once a page declares its own openGraph, so it is named here.
    expect(publicPageOpenGraph("/privacy")).toEqual({
      ...siteOpenGraph,
      url: "/privacy",
      images: [socialImage],
    });
  });

  it("describes the social image the way app/opengraph-image.tsx renders it", () => {
    expect(socialImageSource).toContain(`export const alt = ${JSON.stringify(socialImage.alt)};`);
    expect(socialImageSource).toContain(
      `export const size = { width: ${socialImage.width}, height: ${socialImage.height} };`,
    );
    expect(socialImageSource).toContain(
      `export const contentType = ${JSON.stringify(socialImage.type)};`,
    );
  });
});

describe("sitemap", () => {
  it("publishes exactly the registry, in order", () => {
    expect(sitemap()).toEqual(
      publicPages.map((page) => ({
        url: publicPageUrl(page.path),
        lastModified: new Date(`${page.lastModified}T00:00:00.000Z`),
        changeFrequency: page.changeFrequency,
        priority: page.priority,
      })),
    );
  });
});
