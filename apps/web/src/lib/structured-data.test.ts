import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { publicPageUrl } from "./public-pages.js";
import { publicAppStoreUrl, publicSiteUrl } from "./public-site.js";
import {
  landingFeatureList,
  landingStructuredData,
  landingStructuredDataJson,
  sourceRepositoryUrl,
} from "./structured-data.js";

const landingPageSource = readFileSync(
  fileURLToPath(new URL("../app/page.tsx", import.meta.url)),
  "utf8",
);

/** Keys whose value must be an absolute URL on this deployment's own origin. */
const siteScopedKeys = new Set(["@id", "url", "image", "logo", "contentUrl"]);
/** Keys that point at a known off-site destination instead. */
const externalKeys = new Set(["sameAs", "installUrl", "downloadUrl"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Visits every value in the graph, tagging it with the object key it was reached through. */
function walk(value: unknown, key: string, visit: (key: string, value: unknown) => void): void {
  visit(key, value);
  if (Array.isArray(value)) {
    for (const item of value as unknown[]) walk(item, key, visit);
  } else if (isRecord(value)) {
    for (const [childKey, childValue] of Object.entries(value)) walk(childValue, childKey, visit);
  }
}

function graphNodes(): Record<string, unknown>[] {
  const nodes: unknown = landingStructuredData["@graph"];
  if (!Array.isArray(nodes)) throw new Error("the landing graph is not an array");
  return (nodes as unknown[]).filter(isRecord);
}

describe("landing structured data", () => {
  it("serializes to parseable JSON-LD that cannot close its own script element", () => {
    expect(landingStructuredDataJson).not.toContain("<");
    expect(JSON.parse(landingStructuredDataJson)).toEqual(landingStructuredData);
  });

  it("publishes one graph holding the organization, the site, and the application", () => {
    expect(landingStructuredData["@context"]).toBe("https://schema.org");
    expect(graphNodes().map((node) => node["@type"])).toEqual([
      "Organization",
      "WebSite",
      "SoftwareApplication",
    ]);
  });

  it("resolves every @id reference inside the graph", () => {
    const declared = new Set(graphNodes().map((node) => node["@id"]));
    let references = 0;
    walk(landingStructuredData, "@graph", (_key, value) => {
      if (!isRecord(value)) return;
      const keys = Object.keys(value);
      if (keys.length !== 1 || keys[0] !== "@id") return;
      references += 1;
      expect(declared).toContain(value["@id"]);
    });
    expect(references).toBeGreaterThan(0);
  });

  it("keeps every site-scoped URL absolute and on the public origin", () => {
    let checked = 0;
    walk(landingStructuredData, "@graph", (key, value) => {
      if (typeof value !== "string" || !siteScopedKeys.has(key)) return;
      checked += 1;
      expect(URL.canParse(value), `${key}: ${value}`).toBe(true);
      expect(new URL(value).origin, `${key}: ${value}`).toBe(publicSiteUrl.origin);
    });
    expect(checked).toBeGreaterThan(0);
  });

  it("points every off-site URL at the App Store listing or the source repository", () => {
    const known = new Set([publicAppStoreUrl, sourceRepositoryUrl]);
    let checked = 0;
    walk(landingStructuredData, "@graph", (key, value) => {
      if (typeof value !== "string" || !externalKeys.has(key)) return;
      checked += 1;
      expect(URL.canParse(value), `${key}: ${value}`).toBe(true);
      expect(known, `${key}: ${value}`).toContain(value);
    });
    expect(checked).toBeGreaterThan(0);
  });

  it("names the landing page, its social image, and the App Store install", () => {
    const [organization, website, application] = graphNodes();
    expect(organization?.url).toBe(publicPageUrl("/"));
    expect(website?.url).toBe(publicPageUrl("/"));
    expect(application?.url).toBe(publicPageUrl("/"));
    expect(application?.image).toBe(`${publicSiteUrl.origin}/opengraph-image`);
    expect(application?.downloadUrl).toBe(publicAppStoreUrl);
    expect(application?.installUrl).toBe(publicAppStoreUrl);
  });

  it("advertises only features the landing page already names", () => {
    expect(landingFeatureList.length).toBeGreaterThan(0);
    for (const feature of landingFeatureList) {
      expect(landingPageSource, feature).toContain(`>${feature}<`);
    }
  });

  it("claims no rating or review, because this deployment collects neither", () => {
    expect(landingStructuredDataJson).not.toContain("aggregateRating");
    expect(landingStructuredDataJson).not.toContain("review");
  });
});
