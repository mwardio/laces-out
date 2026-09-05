import { afterEach, describe, expect, it, vi } from "vitest";

const originalAnalyticsStatus = process.env.NEXT_PUBLIC_CLOUDFLARE_ANALYTICS;
const originalGoogleVerification = process.env.NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION;
const originalBingVerification = process.env.NEXT_PUBLIC_BING_SITE_VERIFICATION;

function restore(name: string, original: string | undefined): void {
  if (original === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = original;
  }
}

afterEach(() => {
  restore("NEXT_PUBLIC_CLOUDFLARE_ANALYTICS", originalAnalyticsStatus);
  restore("NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION", originalGoogleVerification);
  restore("NEXT_PUBLIC_BING_SITE_VERIFICATION", originalBingVerification);
  vi.resetModules();
});

describe("hosted analytics disclosure", () => {
  it("is disabled by default", async () => {
    delete process.env.NEXT_PUBLIC_CLOUDFLARE_ANALYTICS;
    vi.resetModules();

    const { cloudflareWebAnalyticsEnabled } = await import("./public-site.js");

    expect(cloudflareWebAnalyticsEnabled).toBe(false);
  });

  it("enables only the explicit hosted value", async () => {
    process.env.NEXT_PUBLIC_CLOUDFLARE_ANALYTICS = "enabled";
    vi.resetModules();

    const { cloudflareWebAnalyticsEnabled } = await import("./public-site.js");

    expect(cloudflareWebAnalyticsEnabled).toBe(true);
  });
});

describe("search-console verification tokens", () => {
  it("stays unset when no deployment configured one", async () => {
    delete process.env.NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION;
    delete process.env.NEXT_PUBLIC_BING_SITE_VERIFICATION;
    vi.resetModules();

    const { bingSiteVerification, googleSiteVerification } = await import("./public-site.js");

    expect(googleSiteVerification).toBeNull();
    expect(bingSiteVerification).toBeNull();
  });

  it("reads and trims a configured token", async () => {
    process.env.NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION = "  google-token  ";
    process.env.NEXT_PUBLIC_BING_SITE_VERIFICATION = "  bing-token  ";
    vi.resetModules();

    const { bingSiteVerification, googleSiteVerification } = await import("./public-site.js");

    expect(googleSiteVerification).toBe("google-token");
    expect(bingSiteVerification).toBe("bing-token");
  });

  it("treats a blank value as unset, so no empty meta tag renders", async () => {
    process.env.NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION = "   ";
    process.env.NEXT_PUBLIC_BING_SITE_VERIFICATION = "";
    vi.resetModules();

    const { bingSiteVerification, googleSiteVerification } = await import("./public-site.js");

    expect(googleSiteVerification).toBeNull();
    expect(bingSiteVerification).toBeNull();
  });
});
