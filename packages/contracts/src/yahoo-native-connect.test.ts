import { describe, expect, it } from "vitest";

import {
  browserHandoffDestinationSchema,
  mobileCapabilitySchema,
  YAHOO_IOS_COMPLETION_URLS,
  yahooAuthorizeRequestSchema,
  yahooIosCompletionStatusSchema,
} from "./index.js";

describe("native Yahoo connection contracts", () => {
  it("keeps the Yahoo setup handoff destination exact and closed", () => {
    expect(browserHandoffDestinationSchema.parse("/connections/yahoo/connect")).toBe(
      "/connections/yahoo/connect",
    );

    for (const destination of [
      "/connections/yahoo/connect?callback=https://attacker.example",
      "/connections/yahoo/connect/extra",
      "https://lacesout.app/connections/yahoo/connect",
      "lacesout://connections/yahoo",
    ]) {
      expect(browserHandoffDestinationSchema.safeParse(destination).success).toBe(false);
    }
  });

  it("preserves browser authorization requests and admits only the closed iOS mode", () => {
    expect(yahooAuthorizeRequestSchema.parse({})).toEqual({
      returnMode: "browser",
      returnTo: "/connections",
    });
    expect(yahooAuthorizeRequestSchema.parse({ returnTo: "/connections?from=settings" })).toEqual({
      returnMode: "browser",
      returnTo: "/connections?from=settings",
    });
    expect(yahooAuthorizeRequestSchema.parse({ returnMode: "ios-app" })).toEqual({
      returnMode: "ios-app",
      returnTo: "/connections",
    });
  });

  it("rejects extra fields, caller callbacks, and native return-path overrides", () => {
    for (const request of [
      { returnMode: "ios-app", callbackUrl: "lacesout://attacker" },
      { returnMode: "ios-app", redirectUri: "https://attacker.example/callback" },
      { returnMode: "ios-app", returnTo: "/settings" },
      { returnTo: "/connections", extra: true },
      { returnMode: "other" },
    ]) {
      expect(yahooAuthorizeRequestSchema.safeParse(request).success).toBe(false);
    }
  });

  it("publishes only the four exact, credential-free iOS completion URLs", () => {
    expect(YAHOO_IOS_COMPLETION_URLS).toEqual({
      connected: "lacesout://connections/yahoo?status=connected",
      denied: "lacesout://connections/yahoo?status=denied",
      unavailable: "lacesout://connections/yahoo?status=unavailable",
      failed: "lacesout://connections/yahoo?status=failed",
    });

    for (const [status, callback] of Object.entries(YAHOO_IOS_COMPLETION_URLS)) {
      expect(yahooIosCompletionStatusSchema.parse(status)).toBe(status);
      const url = new URL(callback);
      expect(url.protocol).toBe("lacesout:");
      expect(url.hostname).toBe("connections");
      expect(url.pathname).toBe("/yahoo");
      expect([...url.searchParams]).toEqual([["status", status]]);
      expect(url.username).toBe("");
      expect(url.password).toBe("");
      expect(url.hash).toBe("");
    }
  });

  it("adds Yahoo native connect to the closed mobile capability vocabulary", () => {
    expect(mobileCapabilitySchema.parse("yahoo-native-connect-v1")).toBe("yahoo-native-connect-v1");
    expect(mobileCapabilitySchema.parse("yahoo-automated-sync")).toBe("yahoo-automated-sync");
    expect(mobileCapabilitySchema.safeParse("yahoo-native-connect-v2").success).toBe(false);
    expect(mobileCapabilitySchema.safeParse("yahoo-automated-sync-v2").success).toBe(false);
  });
});
