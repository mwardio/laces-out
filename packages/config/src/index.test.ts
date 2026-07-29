import { describe, expect, it } from "vitest";

import { loadEnvironment } from "./index.js";

describe("loadEnvironment", () => {
  it("provides safe local defaults", () => {
    const environment = loadEnvironment({});

    expect(environment.PORT).toBe(4000);
    expect(environment.NODE_ENV).toBe("development");
    expect(environment.CREDENTIAL_ENCRYPTION_KEY).toBeUndefined();
    expect(environment.GEMINI_API_KEY).toBeUndefined();
    expect(environment.MANAGED_AI_DAILY_REQUEST_LIMIT).toBe(50);
    expect(environment.MANAGED_AI_MAX_OUTPUT_TOKENS).toBe(2000);
    expect(environment.REGISTRATION_INVITE_CODE).toBeUndefined();
  });

  it("requires secrets in production", () => {
    expect(() => loadEnvironment({ NODE_ENV: "production" })).toThrow("Missing production secrets");
  });

  it("rejects copied example placeholders and the default database password in production", () => {
    expect(() =>
      loadEnvironment({
        NODE_ENV: "production",
        SESSION_SECRET: "replace-with-at-least-32-random-characters",
        CREDENTIAL_ENCRYPTION_KEY: "base64:replace-with-32-random-bytes",
        DATABASE_URL: "postgresql://fantasy:fantasy@postgres:5432/fantasy",
      }),
    ).toThrow("Unsafe production placeholder configuration");
  });

  it("requires HTTPS for a non-loopback production web origin", () => {
    expect(() =>
      loadEnvironment({
        NODE_ENV: "production",
        SESSION_SECRET: "s".repeat(32),
        CREDENTIAL_ENCRYPTION_KEY: "k".repeat(32),
        DATABASE_URL: "postgresql://fantasy:a-strong-password@postgres:5432/fantasy",
        WEB_URL: "http://laces.example.com",
      }),
    ).toThrow("Production WEB_URL must use HTTPS");
  });

  it("requires the production web URL to be a bare origin", () => {
    expect(() =>
      loadEnvironment({
        NODE_ENV: "production",
        SESSION_SECRET: "s".repeat(32),
        CREDENTIAL_ENCRYPTION_KEY: "k".repeat(32),
        DATABASE_URL: "postgresql://fantasy:a-strong-password@postgres:5432/fantasy",
        WEB_URL: "https://laces.example.com/app?mode=production",
      }),
    ).toThrow("bare origin");
  });

  it("parses additional web origins and normalizes trailing slashes", () => {
    expect(loadEnvironment({}).ADDITIONAL_WEB_ORIGINS).toEqual([]);
    expect(loadEnvironment({ ADDITIONAL_WEB_ORIGINS: "" }).ADDITIONAL_WEB_ORIGINS).toEqual([]);
    expect(
      loadEnvironment({
        ADDITIONAL_WEB_ORIGINS: "https://second.example.com/, https://third.example.com",
      }).ADDITIONAL_WEB_ORIGINS,
    ).toEqual(["https://second.example.com", "https://third.example.com"]);
  });

  it("holds additional production web origins to the WEB_URL rules", () => {
    const production = {
      NODE_ENV: "production",
      SESSION_SECRET: "s".repeat(32),
      CREDENTIAL_ENCRYPTION_KEY: "k".repeat(32),
      DATABASE_URL: "postgresql://fantasy:a-strong-password@postgres:5432/fantasy",
      WEB_URL: "https://laces.example.com",
    };

    expect(() =>
      loadEnvironment({ ...production, ADDITIONAL_WEB_ORIGINS: "http://second.example.com" }),
    ).toThrow("Production ADDITIONAL_WEB_ORIGINS must use HTTPS");
    expect(() =>
      loadEnvironment({ ...production, ADDITIONAL_WEB_ORIGINS: "https://second.example.com/app" }),
    ).toThrow("bare origin");
    expect(() => loadEnvironment({ ...production, ADDITIONAL_WEB_ORIGINS: "not-a-url" })).toThrow();
    expect(
      loadEnvironment({ ...production, ADDITIONAL_WEB_ORIGINS: "https://second.example.com" })
        .ADDITIONAL_WEB_ORIGINS,
    ).toEqual(["https://second.example.com"]);
  });

  it("coerces a valid port", () => {
    expect(loadEnvironment({ PORT: "4321" }).PORT).toBe(4321);
  });

  it("accepts an optional managed Gemini key and bounded usage controls", () => {
    const environment = loadEnvironment({
      GEMINI_API_KEY: "managed-gemini-key",
      MANAGED_AI_DAILY_REQUEST_LIMIT: "14",
      MANAGED_AI_MAX_OUTPUT_TOKENS: "1200",
    });

    expect(environment.GEMINI_API_KEY).toBe("managed-gemini-key");
    expect(environment.MANAGED_AI_DAILY_REQUEST_LIMIT).toBe(14);
    expect(environment.MANAGED_AI_MAX_OUTPUT_TOKENS).toBe(1200);
  });

  it("enables shared-code registration only with a session secret", () => {
    expect(() => loadEnvironment({ REGISTRATION_INVITE_CODE: "a-long-shared-code" })).toThrow(
      "REGISTRATION_INVITE_CODE requires SESSION_SECRET",
    );

    expect(
      loadEnvironment({
        SESSION_SECRET: "s".repeat(32),
        REGISTRATION_INVITE_CODE: "a-long-shared-code",
      }).REGISTRATION_INVITE_CODE,
    ).toBe("a-long-shared-code");
  });

  it("accepts a twelve-character registration code", () => {
    expect(
      loadEnvironment({
        SESSION_SECRET: "s".repeat(32),
        REGISTRATION_INVITE_CODE: "twelve-chars",
      }).REGISTRATION_INVITE_CODE,
    ).toBe("twelve-chars");
    expect(() =>
      loadEnvironment({
        SESSION_SECRET: "s".repeat(32),
        REGISTRATION_INVITE_CODE: "too-short",
      }),
    ).toThrow("Too small");
  });

  it("treats a blank registration code as disabled", () => {
    expect(
      loadEnvironment({ REGISTRATION_INVITE_CODE: "" }).REGISTRATION_INVITE_CODE,
    ).toBeUndefined();
  });

  it("allows credential encryption without enabling optional Yahoo connectivity", () => {
    expect(
      loadEnvironment({
        CREDENTIAL_ENCRYPTION_KEY: "base64:MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
      }).YAHOO_CLIENT_ID,
    ).toBeUndefined();
  });

  it("rejects a partially configured Yahoo connection", () => {
    expect(() =>
      loadEnvironment({
        CREDENTIAL_ENCRYPTION_KEY: "base64:MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        YAHOO_CLIENT_ID: "client-id",
      }),
    ).toThrow(
      "Yahoo requires YAHOO_CLIENT_ID, YAHOO_CLIENT_SECRET, and CREDENTIAL_ENCRYPTION_KEY together",
    );
  });
  it("leaves web push unconfigured by default", () => {
    const environment = loadEnvironment({});
    expect(environment.VAPID_PUBLIC_KEY).toBeUndefined();
    expect(environment.VAPID_PRIVATE_KEY).toBeUndefined();
    expect(environment.VAPID_SUBJECT).toBeUndefined();
  });

  it("accepts a complete VAPID identity and rejects a partial one", () => {
    const complete = {
      VAPID_PUBLIC_KEY: "B".repeat(87),
      VAPID_PRIVATE_KEY: "k".repeat(43),
      VAPID_SUBJECT: "mailto:commish@example.com",
    };
    expect(loadEnvironment(complete).VAPID_SUBJECT).toBe("mailto:commish@example.com");
    expect(() => loadEnvironment({ VAPID_PUBLIC_KEY: complete.VAPID_PUBLIC_KEY })).toThrow(
      "Web push requires VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, and VAPID_SUBJECT together",
    );
  });

  it("rejects a VAPID subject that is neither mailto nor https", () => {
    expect(() =>
      loadEnvironment({
        VAPID_PUBLIC_KEY: "B".repeat(87),
        VAPID_PRIVATE_KEY: "k".repeat(43),
        VAPID_SUBJECT: "http://example.com",
      }),
    ).toThrow();
  });

  it("rejects malformed VAPID key lengths before the sender starts", () => {
    expect(() =>
      loadEnvironment({
        VAPID_PUBLIC_KEY: "B".repeat(86),
        VAPID_PRIVATE_KEY: "k".repeat(43),
        VAPID_SUBJECT: "https://laces.mward.io",
      }),
    ).toThrow();
    expect(() =>
      loadEnvironment({
        VAPID_PUBLIC_KEY: "B".repeat(87),
        VAPID_PRIVATE_KEY: "k".repeat(44),
        VAPID_SUBJECT: "https://laces.mward.io",
      }),
    ).toThrow();
  });
});
