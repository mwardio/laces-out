/**
 * The JSON-LD the landing page publishes, as one `@graph` so the organization, the website, and the
 * application are linked entities rather than three unrelated blocks.
 *
 * This is not markup for a rich result. Google's Software App rich result requires a real
 * `aggregateRating` or `review`, and this deployment collects neither and will not fabricate one.
 * The graph exists for entity understanding and knowledge-panel linkage: it tells a search engine
 * that this origin, this brand, the App Store listing, and the source repository are the same
 * thing.
 */
import { publicPageUrl } from "./public-pages";
import { publicAppStoreUrl, publicSiteUrl } from "./public-site";

/** The public source repository, one half of the organization's `sameAs` identity. */
export const sourceRepositoryUrl = "https://github.com/mwardio/laces-out";

const landingUrl = publicPageUrl("/");
const organizationId = `${landingUrl}/#organization`;
const websiteId = `${landingUrl}/#website`;
const applicationId = `${landingUrl}/#app`;

/**
 * Section names already printed on the landing page. Page files cannot export constants under
 * Next's page type check, so they are repeated here and `structured-data.test.ts` asserts each one
 * still appears in `app/page.tsx` — the graph can never advertise a feature the page does not name.
 */
export const landingFeatureList = [
  "League sync",
  "Draft Studio",
  "League Analytics",
  "Trade finder",
  "Decision Desk",
  "Film Room",
  "Weekly Reckoning",
];

export const landingStructuredData = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": organizationId,
      name: "Laces Out",
      url: landingUrl,
      logo: {
        "@type": "ImageObject",
        url: new URL("/icon.png", publicSiteUrl).toString(),
        width: 512,
        height: 512,
      },
      sameAs: [publicAppStoreUrl, sourceRepositoryUrl],
    },
    {
      "@type": "WebSite",
      "@id": websiteId,
      name: "Laces Out",
      url: landingUrl,
      publisher: { "@id": organizationId },
      inLanguage: "en",
    },
    {
      "@type": "SoftwareApplication",
      "@id": applicationId,
      name: "Laces Out",
      url: landingUrl,
      image: new URL("/opengraph-image", publicSiteUrl).toString(),
      applicationCategory: "SportsApplication",
      applicationSubCategory: "Fantasy sports",
      operatingSystem: ["iOS", "Web browser"],
      description:
        "A fantasy football companion with league-aware lineup, waiver, trade, analytics, and draft recommendations.",
      featureList: landingFeatureList,
      isAccessibleForFree: true,
      downloadUrl: publicAppStoreUrl,
      installUrl: publicAppStoreUrl,
      publisher: { "@id": organizationId },
      author: { "@id": organizationId },
      offers: {
        "@type": "Offer",
        price: "0",
        priceCurrency: "USD",
      },
    },
  ],
};

/**
 * The graph as it goes into `<script type="application/ld+json">`. Escaping `<` keeps any value
 * from closing the script element early.
 */
export const landingStructuredDataJson = JSON.stringify(landingStructuredData).replaceAll(
  "<",
  "\\u003c",
);
