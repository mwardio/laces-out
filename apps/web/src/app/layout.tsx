import type { Metadata, Viewport } from "next";
import { Sora } from "next/font/google";
import type { ReactNode } from "react";

import { publicSiteUrl } from "../lib/public-site";

import "./globals.css";
import "./polish.css";

const brandFont = Sora({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-brand",
});

export const metadata: Metadata = {
  metadataBase: publicSiteUrl,
  title: {
    default: "Laces Out — Fantasy Football Intelligence",
    template: "%s · Laces Out",
  },
  description:
    "Draft, lineup, waiver, and trade decisions grounded in your fantasy football leagues.",
  applicationName: "Laces Out",
  manifest: "/manifest.webmanifest",
  category: "sports",
  keywords: ["fantasy football", "draft assistant", "lineup", "waivers", "trades"],
  robots: { index: false, follow: false },
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Laces Out",
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
      <body>{children}</body>
    </html>
  );
}
