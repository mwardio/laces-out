const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const fallbackSiteUrl = "http://localhost:3000";

function configuredContactEmail(): string | null {
  const value = process.env.NEXT_PUBLIC_CONTACT_EMAIL?.trim();
  return value && emailPattern.test(value) ? value : null;
}

export const publicContactEmail = configuredContactEmail();

export const publicAppStoreId = "6796755232";
export const publicAppStoreUrl = "https://apps.apple.com/us/app/laces-out-fantasy/id6796755232";

export const yahooComingSoon =
  process.env.NEXT_PUBLIC_YAHOO_ACCESS_STATUS?.trim().toLowerCase() !== "available";

export const cloudflareWebAnalyticsEnabled =
  process.env.NEXT_PUBLIC_CLOUDFLARE_ANALYTICS?.trim().toLowerCase() === "enabled";

function configuredVerificationToken(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Search-console ownership tokens. DNS TXT verification is the first choice; these are the fallback
 * for deployments that cannot edit DNS, and the meta tag renders only when the token is set.
 */
export const googleSiteVerification = configuredVerificationToken(
  process.env.NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION,
);

export const bingSiteVerification = configuredVerificationToken(
  process.env.NEXT_PUBLIC_BING_SITE_VERIFICATION,
);

function configuredSiteUrl(): URL {
  try {
    return new URL(process.env.NEXT_PUBLIC_SITE_URL?.trim() || fallbackSiteUrl);
  } catch {
    return new URL(fallbackSiteUrl);
  }
}

export const publicSiteUrl = configuredSiteUrl();
