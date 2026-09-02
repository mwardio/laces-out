import { describe, expect, it } from "vitest";

import { loadEnvironment } from "./index.js";

describe("loadEnvironment", () => {
  it("provides safe local defaults", () => {
    const environment = loadEnvironment({});

    expect(environment.PORT).toBe(4000);
    expect(environment.NODE_ENV).toBe("development");
    expect(environment.CREDENTIAL_ENCRYPTION_KEY).toBeUndefined();
    expect(environment.GEMINI_API_KEY).toBeUndefined();
    expect(environment.OPENROUTER_API_KEY).toBeUndefined();
    expect(environment.MANAGED_AI_DAILY_REQUEST_LIMIT).toBe(50);
    expect(environment.MANAGED_AI_MAX_OUTPUT_TOKENS).toBe(2000);
    expect(environment.REGISTRATION_OPEN).toBe(false);
    expect(environment.REGISTRATION_INVITE_CODE).toBeUndefined();
    expect(environment.ESPN_PUBLIC_DIRECT_SYNC_ENABLED).toBe(false);
    expect(environment.NEXT_PUBLIC_YAHOO_ACCESS_STATUS).toBe("pending");
    expect(environment.YAHOO_AUTOMATED_SYNC_ENABLED).toBe(false);
    expect(environment.EMAIL_VERIFICATION_ENABLED).toBe(false);
  });

  it("parses the ESPN public-direct release gate without enabling it by default", () => {
    expect(
      loadEnvironment({ ESPN_PUBLIC_DIRECT_SYNC_ENABLED: "true" }).ESPN_PUBLIC_DIRECT_SYNC_ENABLED,
    ).toBe(true);
    expect(
      loadEnvironment({ ESPN_PUBLIC_DIRECT_SYNC_ENABLED: "0" }).ESPN_PUBLIC_DIRECT_SYNC_ENABLED,
    ).toBe(false);
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

  it("accepts optional managed AI keys and bounded usage controls", () => {
    const environment = loadEnvironment({
      GEMINI_API_KEY: "managed-gemini-key",
      OPENROUTER_API_KEY: "managed-openrouter-key",
      MANAGED_AI_DAILY_REQUEST_LIMIT: "14",
      MANAGED_AI_MAX_OUTPUT_TOKENS: "1200",
    });

    expect(environment.GEMINI_API_KEY).toBe("managed-gemini-key");
    expect(environment.OPENROUTER_API_KEY).toBe("managed-openrouter-key");
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

  it("enables open registration only with a session secret", () => {
    expect(() => loadEnvironment({ REGISTRATION_OPEN: "true" })).toThrow(
      "REGISTRATION_OPEN requires SESSION_SECRET",
    );
    expect(
      loadEnvironment({ SESSION_SECRET: "s".repeat(32), REGISTRATION_OPEN: "true" })
        .REGISTRATION_OPEN,
    ).toBe(true);
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

  it("keeps Yahoo access and automation separate, fail-closed, and fully configured", () => {
    expect(
      loadEnvironment({ YAHOO_AUTOMATED_SYNC_ENABLED: "0" }).YAHOO_AUTOMATED_SYNC_ENABLED,
    ).toBe(false);
    expect(() => loadEnvironment({ YAHOO_AUTOMATED_SYNC_ENABLED: "true" })).toThrow(
      "YAHOO_AUTOMATED_SYNC_ENABLED requires Yahoo access to be available",
    );

    const credentials = {
      YAHOO_CLIENT_ID: "client-id",
      YAHOO_CLIENT_SECRET: "client-secret",
      CREDENTIAL_ENCRYPTION_KEY: "base64:MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
    };
    expect(loadEnvironment(credentials).NEXT_PUBLIC_YAHOO_ACCESS_STATUS).toBe("pending");
    expect(() =>
      loadEnvironment({
        ...credentials,
        YAHOO_AUTOMATED_SYNC_ENABLED: "true",
      }),
    ).toThrow("YAHOO_AUTOMATED_SYNC_ENABLED requires Yahoo access to be available");
    expect(() => loadEnvironment({ NEXT_PUBLIC_YAHOO_ACCESS_STATUS: "available" })).toThrow(
      "requires complete Yahoo server configuration",
    );

    const environment = loadEnvironment({
      NEXT_PUBLIC_YAHOO_ACCESS_STATUS: "available",
      YAHOO_AUTOMATED_SYNC_ENABLED: "true",
      ...credentials,
    });
    expect(environment.NEXT_PUBLIC_YAHOO_ACCESS_STATUS).toBe("available");
    expect(environment.YAHOO_AUTOMATED_SYNC_ENABLED).toBe(true);
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

  it("binds Yahoo's HTTPS callback to the configured deployment origin", () => {
    const yahoo = {
      CREDENTIAL_ENCRYPTION_KEY: "base64:MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
      YAHOO_CLIENT_ID: "client-id",
      YAHOO_CLIENT_SECRET: "client-secret",
      API_URL: "https://self-host.example",
      YAHOO_REDIRECT_URI: "https://self-host.example/v1/connections/yahoo/callback",
    };
    expect(loadEnvironment(yahoo).YAHOO_REDIRECT_URI).toBe(
      "https://self-host.example/v1/connections/yahoo/callback",
    );
    expect(() =>
      loadEnvironment({
        ...yahoo,
        YAHOO_REDIRECT_URI: "https://lacesout.app/v1/connections/yahoo/callback",
      }),
    ).toThrow("exact configured API origin callback");
    expect(() =>
      loadEnvironment({
        ...yahoo,
        YAHOO_REDIRECT_URI:
          "https://self-host.example/v1/connections/yahoo/callback?return=lacesout",
      }),
    ).toThrow("exact configured API origin callback");
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

  it("leaves outbound email unconfigured by default with the standard submission port", () => {
    const environment = loadEnvironment({});
    expect(environment.SMTP_HOST).toBeUndefined();
    expect(environment.SMTP_USER).toBeUndefined();
    expect(environment.SMTP_PASSWORD).toBeUndefined();
    expect(environment.EMAIL_FROM).toBeUndefined();
    expect(environment.SMTP_PORT).toBe(587);
  });

  it("accepts a complete SMTP identity and rejects a partial one", () => {
    const complete = {
      SMTP_HOST: "smtp.mail.me.com",
      SMTP_USER: "operator@icloud.com",
      SMTP_PASSWORD: "app-specific-password",
      EMAIL_FROM: "Laces Out <noreply@lacesout.app>",
    };
    const environment = loadEnvironment(complete);
    expect(environment.SMTP_HOST).toBe("smtp.mail.me.com");
    expect(environment.EMAIL_FROM).toBe("Laces Out <noreply@lacesout.app>");
    expect(() => loadEnvironment({ SMTP_HOST: complete.SMTP_HOST })).toThrow(
      "Outbound email requires SMTP_HOST, SMTP_USER, SMTP_PASSWORD, and EMAIL_FROM together",
    );
    expect(() => loadEnvironment({ EMAIL_FROM: complete.EMAIL_FROM })).toThrow(
      "Outbound email requires SMTP_HOST, SMTP_USER, SMTP_PASSWORD, and EMAIL_FROM together",
    );
  });

  it("enables email verification only with a complete SMTP identity", () => {
    const complete = {
      SMTP_HOST: "smtp.mail.me.com",
      SMTP_USER: "operator@icloud.com",
      SMTP_PASSWORD: "app-specific-password",
      EMAIL_FROM: "Laces Out <noreply@lacesout.app>",
      EMAIL_VERIFICATION_ENABLED: "true",
    };
    expect(loadEnvironment(complete).EMAIL_VERIFICATION_ENABLED).toBe(true);
    expect(() => loadEnvironment({ EMAIL_VERIFICATION_ENABLED: "true" })).toThrow(
      "EMAIL_VERIFICATION_ENABLED requires complete outbound email configuration",
    );
  });

  it("accepts a bare From address and rejects a malformed one", () => {
    const base = {
      SMTP_HOST: "smtp.mail.me.com",
      SMTP_USER: "operator@icloud.com",
      SMTP_PASSWORD: "app-specific-password",
    };
    expect(loadEnvironment({ ...base, EMAIL_FROM: "noreply@lacesout.app" }).EMAIL_FROM).toBe(
      "noreply@lacesout.app",
    );
    expect(() => loadEnvironment({ ...base, EMAIL_FROM: "not-an-address" })).toThrow();
    expect(() => loadEnvironment({ ...base, EMAIL_FROM: "Laces Out <not-an-address>" })).toThrow();
  });

  it("rejects a placeholder SMTP password in production", () => {
    expect(() =>
      loadEnvironment({
        NODE_ENV: "production",
        WEB_URL: "https://laces.example.app",
        DATABASE_URL: "postgres://owner:distinct-secret@db:5432/fantasy",
        SESSION_SECRET: "s".repeat(48),
        CREDENTIAL_ENCRYPTION_KEY: "c".repeat(48),
        SMTP_HOST: "smtp.mail.me.com",
        SMTP_USER: "operator@icloud.com",
        SMTP_PASSWORD: "replace-with-app-specific-password",
        EMAIL_FROM: "noreply@lacesout.app",
      }),
    ).toThrow("Unsafe production placeholder configuration: SMTP_PASSWORD");
  });
});
