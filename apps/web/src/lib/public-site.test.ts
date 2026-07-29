import { afterEach, describe, expect, it, vi } from "vitest";

const originalAnalyticsStatus = process.env.NEXT_PUBLIC_CLOUDFLARE_ANALYTICS;

afterEach(() => {
  if (originalAnalyticsStatus === undefined) {
    delete process.env.NEXT_PUBLIC_CLOUDFLARE_ANALYTICS;
  } else {
    process.env.NEXT_PUBLIC_CLOUDFLARE_ANALYTICS = originalAnalyticsStatus;
  }
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
