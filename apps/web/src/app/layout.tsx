import type { Metadata, Viewport } from "next";
import { Sora } from "next/font/google";
import type { ReactNode } from "react";

import { FinkleCode } from "../components/finkle-code";
import { ProductAnalytics } from "../components/product-analytics";
import { siteOpenGraph } from "../lib/public-pages";
import {
  bingSiteVerification,
  googleSiteVerification,
  publicAppStoreId,
  publicSiteUrl,
} from "../lib/public-site";

import "./base.css";

const brandFont = Sora({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-brand",
});

/**
 * Search-console ownership tags, omitted entirely when no token is configured. DNS TXT verification
 * is the recommended route; these env hooks are the fallback for deployments that cannot edit DNS.
 */
function siteVerification(): NonNullable<Metadata["verification"]> | null {
  const verification: NonNullable<Metadata["verification"]> = {};
  if (googleSiteVerification) verification.google = googleSiteVerification;
  if (bingSiteVerification) verification.other = { "msvalidate.01": bingSiteVerification };
  return Object.keys(verification).length > 0 ? verification : null;
}

const verification = siteVerification();

export const metadata: Metadata = {
  metadataBase: publicSiteUrl,
  title: {
    default: "Laces Out · Fantasy Football Intelligence",
    template: "%s · Laces Out",
  },
  description:
    "Draft, lineup, waiver, and trade decisions grounded in your fantasy football leagues.",
  applicationName: "Laces Out",
  manifest: "/manifest.webmanifest",
  category: "sports",
  keywords: ["fantasy football", "draft assistant", "lineup", "waivers", "trades"],
  robots: { index: false, follow: false },
  // Next replaces this object wholesale for any route that declares its own `openGraph`, so the
  // public pages restate these defaults; declaring them here covers the routes that declare none.
  openGraph: siteOpenGraph,
  ...(verification ? { verification } : {}),
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Laces Out",
  },
  itunes: {
    appId: publicAppStoreId,
  },
  formatDetection: {
    telephone: false,
  },
};

export const viewport: Viewport = {
  themeColor: "#f3f2ec",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html className={brandFont.variable} lang="en">
      <body>
        <ProductAnalytics />
        <FinkleCode>{children}</FinkleCode>
      </body>
    </html>
  );
}
