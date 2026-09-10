import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createLeagueSyncObserver, sanitizeAnalyticsEvent } from "./product-analytics-policy";

const sdk = vi.hoisted(() => ({
  init: vi.fn(),
  capture: vi.fn(),
  identify: vi.fn(),
  reset: vi.fn(),
  opt_out_capturing: vi.fn(),
  get_property: vi.fn(),
}));
vi.mock("posthog-js/dist/module.no-external", () => ({ default: sdk }));
const member = {
  id: "member-uuid",
  email: "private@example.com",
  displayName: "Private",
  role: "member",
};

describe("product analytics data boundary", () => {
  it("removes secrets and private paths from page, referrer, and person properties", () => {
    const event = sanitizeAnalyticsEvent({
      uuid: "event-id",
      event: "$identify",
      properties: {
        distinct_id: "member-uuid",
        $current_url: "https://lacesout.app/invite?email=private@example.com#secret-token",
        $pathname: "/stats/players/private-player-id",
        $referrer: "https://example.com/private/document?token=secret",
        $set_once: {
          $initial_current_url: "https://lacesout.app/register?code=secret#secret",
          email: "private@example.com",
        },
        question: "Private league question",
        $elements: [{ text: "password" }],
        utm_source: "newsletter",
      },
      $set: {
        email: "private@example.com",
        $initial_current_url: "https://lacesout.app/reset-password#secret",
      },
      $set_once: { $initial_referrer: "https://example.com/private#secret" },
    });
    expect(event?.properties).toEqual({
      distinct_id: "member-uuid",
      $current_url: "https://lacesout.app/invite",
      $pathname: "/stats/players/:playerId",
      $referrer: "https://example.com",
      $set_once: { $initial_current_url: "https://lacesout.app/register" },
      utm_source: "newsletter",
    });
    expect(event?.$set).toEqual({ $initial_current_url: "https://lacesout.app/reset-password" });
    expect(JSON.stringify(event)).not.toMatch(/secret|private|question/u);
  });

  it("drops unexpected SDK events and collapses unknown paths", () => {
    expect(
      sanitizeAnalyticsEvent({ uuid: "id", event: "$autocapture", properties: {} }),
    ).toBeNull();
    expect(
      sanitizeAnalyticsEvent({
        uuid: "id",
        event: "$pageview",
        properties: {
          $current_url: "https://lacesout.app/private/share-token#secret",
          $referrer: "javascript:secret",
          $pathname: "/private/share-token",
        },
      })?.properties,
    ).toEqual({ $current_url: "https://lacesout.app/other", $pathname: "/other" });
  });

  it("counts only new sync receipts, including newly connected leagues, despite polling races", () => {
    const observe = createLeagueSyncObserver();
    expect(observe([{ id: "old", observedAt: "2026-09-01T00:00:00Z" }])).toBe(0);
    expect(
      observe([
        { id: "old", observedAt: "2026-09-01T00:00:00Z" },
        { id: "new", observedAt: null },
      ]),
    ).toBe(0);
    expect(observe([{ id: "new", observedAt: "2026-09-02T00:00:00Z" }])).toBe(1);
    expect(observe([{ id: "new", observedAt: "2026-09-01T00:00:00Z" }])).toBe(0);
    expect(observe([{ id: "new", observedAt: "2026-09-02T00:00:00Z" }])).toBe(0);
  });
});

describe("product analytics lifecycle", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://lacesout.app");
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_REGION", "us");
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN", "phc_test");
    const values = new Map<string, string>();
    vi.stubGlobal("window", {
      location: new URL("https://lacesout.app/"),
      localStorage: {
        getItem: (key: string) => values.get(key),
        setItem: (key: string, value: string) => values.set(key, value),
      },
    });
    vi.stubGlobal("navigator", { doNotTrack: "0" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 401 })));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it.each(["development", "test"])("sends nothing in %s", async (environment) => {
    vi.stubEnv("NODE_ENV", environment);
    await (await import("./product-analytics")).captureProductPage("/");
    expect(fetch).not.toHaveBeenCalled();
    expect(sdk.init).not.toHaveBeenCalled();
  });

  it.each(["disabled", "invalid"])("sends nothing with region %s", async (region) => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_REGION", region);
    await (await import("./product-analytics")).captureProductPage("/");
    expect(sdk.init).not.toHaveBeenCalled();
  });

  it("does not initialize on a preview origin or without a project token", async () => {
    window.location.href = "https://preview.example.com/";
    const analytics = await import("./product-analytics");
    await analytics.captureProductPage("/");
    expect(fetch).not.toHaveBeenCalled();
    vi.resetModules();
    window.location.href = "https://lacesout.app/";
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN", "");
    await (await import("./product-analytics")).captureProductPage("/");
    expect(sdk.init).not.toHaveBeenCalled();
  });

  it("excludes admins before loading the SDK and remembers the browser exclusion", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ authenticated: true, user: { ...member, role: "admin" } })),
    );
    await (await import("./product-analytics")).captureProductPage("/");
    expect(sdk.init).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("laces-out:analytics-excluded")).toBe("true");
  });

  it("respects browser exclusion and Do Not Track", async () => {
    window.localStorage.setItem("laces-out:analytics-excluded", "true");
    await (await import("./product-analytics")).captureProductPage("/");
    expect(fetch).not.toHaveBeenCalled();
    vi.resetModules();
    window.localStorage.setItem("laces-out:analytics-excluded", "false");
    vi.stubGlobal("navigator", { doNotTrack: "1" });
    await (await import("./product-analytics")).captureProductPage("/");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("deduplicates route effects, records real navigation, and starts a guest tour once", async () => {
    const analytics = await import("./product-analytics");
    await Promise.all([analytics.captureProductPage("/app"), analytics.captureProductPage("/app")]);
    await analytics.captureProductPage("/draft");
    await analytics.captureProductPage("/app");
    const events = sdk.capture.mock.calls.map(([name]) => name as string);
    expect(events.filter((event) => event === "$pageview")).toHaveLength(3);
    expect(events.filter((event) => event === "tour_started")).toHaveLength(1);
    expect(sdk.init).toHaveBeenCalledWith(
      "phc_test",
      expect.objectContaining({
        api_host: "https://us.i.posthog.com",
        autocapture: false,
        disable_session_recording: true,
        capture_pageview: false,
        disable_external_dependency_loading: true,
        advanced_disable_flags: true,
      }),
    );
  });

  it("links anonymous signup activity using only the member ID, then stops at logout", async () => {
    const analytics = await import("./product-analytics");
    await analytics.captureProductPage("/register");
    await analytics.captureAuthenticationEvent({ user: member }, "signup_completed", {
      method: "open",
    });
    expect(sdk.identify).toHaveBeenCalledWith("member-uuid");
    expect(sdk.capture).toHaveBeenLastCalledWith(
      "signup_completed",
      { method: "open", mode: "member" },
      expect.any(Object),
    );
    const count = sdk.capture.mock.calls.length;
    analytics.resetProductAnalytics();
    await analytics.captureProductEvent("film_room_analysis_completed");
    expect(sdk.capture).toHaveBeenCalledTimes(count);
    expect(sdk.reset).toHaveBeenCalledOnce();
  });

  it("does not initialize after logout while a session check is pending", async () => {
    let resolve!: (response: Response) => void;
    vi.mocked(fetch).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const analytics = await import("./product-analytics");
    const page = analytics.captureProductPage("/");
    analytics.resetProductAnalytics();
    resolve(new Response(null, { status: 401 }));
    await page;
    expect(sdk.init).not.toHaveBeenCalled();
  });

  it("fails closed when session lookup fails", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("offline"));
    await expect(
      (await import("./product-analytics")).captureProductPage("/"),
    ).resolves.toBeUndefined();
    expect(sdk.init).not.toHaveBeenCalled();
  });
});
