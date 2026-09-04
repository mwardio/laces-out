import type { Metadata } from "next";

import { publicAppStoreUrl, publicSiteUrl } from "../../lib/public-site";

import { AppStoreRedirect } from "./app-store-redirect";

const pageUrl = new URL("/ios", publicSiteUrl);
const shareImageUrl = new URL("/opengraph-image", publicSiteUrl);
const title = "Laces Out Fantasy for iPhone and iPad";
const description = "Connected leagues. Automatic analysis. Better Sundays.";

export const metadata: Metadata = {
  title,
  description,
  alternates: {
    canonical: pageUrl,
  },
  openGraph: {
    type: "website",
    url: pageUrl,
    siteName: "Laces Out",
    title,
    description,
    images: [
      {
        url: shareImageUrl,
        width: 1200,
        height: 630,
        alt: "Laces Out: Connect your leagues. Get the next move.",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    images: [shareImageUrl],
  },
  robots: { index: false, follow: false },
};

export default function IOSAppStoreRedirectPage() {
  return <AppStoreRedirect destination={publicAppStoreUrl} />;
}
