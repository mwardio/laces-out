const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const fallbackSiteUrl = "http://localhost:3000";

function configuredContactEmail(): string | null {
  const value = process.env.NEXT_PUBLIC_CONTACT_EMAIL?.trim();
  return value && emailPattern.test(value) ? value : null;
}

export const publicContactEmail = configuredContactEmail();

export const yahooComingSoon =
  process.env.NEXT_PUBLIC_YAHOO_ACCESS_STATUS?.trim().toLowerCase() !== "available";

export const cloudflareWebAnalyticsEnabled =
  process.env.NEXT_PUBLIC_CLOUDFLARE_ANALYTICS?.trim().toLowerCase() === "enabled";

function configuredSiteUrl(): URL {
  try {
    return new URL(process.env.NEXT_PUBLIC_SITE_URL?.trim() || fallbackSiteUrl);
  } catch {
    return new URL(fallbackSiteUrl);
  }
}

export const publicSiteUrl = configuredSiteUrl();
