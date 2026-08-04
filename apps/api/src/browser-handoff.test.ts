import { createHash } from "node:crypto";

import { loadEnvironment } from "@fantasy/config";
import { healthResponseSchema } from "@fantasy/contracts";
import { describe, expect, it, vi } from "vitest";

import { buildApp, type BuildAppOptions, type YahooConnectionPort } from "./app.js";
import { AuthService, sessionCookieName, type AuthRepository } from "./auth.js";
import {
  browserHandoffConfirmPath,
  browserHandoffConsumePath,
  browserHandoffCookieName,
  browserHandoffLandingPath,
  browserHandoffStagePath,
} from "./browser-handoff-routes.js";
import {
  browserHandoffOriginsCompatible,
  BrowserHandoffService,
  maskBrowserHandoffAccount,
  type BrowserHandoffPort,
  type BrowserHandoffStore,
} from "./browser-handoff.js";
import type { YahooSyncPort } from "./yahoo-sync.js";

const userId = "10000000-0000-4000-8000-0000000000b1";
const nativeSessionToken = "n".repeat(43);
const creationToken = "C".repeat(43);
const redemptionToken = "R".repeat(43);
const browserSessionToken = "B".repeat(43);
const now = new Date("2031-07-31T12:00:00.000Z");

function digest(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("base64url");
}

function productionEnvironment() {
  return loadEnvironment({
    NODE_ENV: "production",
    WEB_URL: "https://laces.example",
    API_URL: "https://laces.example:4443",
    SESSION_SECRET: "s".repeat(32),
    CREDENTIAL_ENCRYPTION_KEY: "k".repeat(32),
    DATABASE_URL: "postgresql://fantasy:a-strong-password@postgres:5432/fantasy",
  });
}

function authRepository(
  findSession: AuthRepository["findSession"] = () =>
    Promise.resolve({
      user: {
        id: userId,
        email: "mobile@example.test",
        displayName: "Mobile Manager",
        role: "member",
      },
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      lastSeenAt: now,
    }),
): AuthRepository {
  return {
    findUserByEmail: () => Promise.resolve(undefined),
    createSession: () => Promise.resolve(),
    findSession,
    touchSession: () => Promise.resolve(),
    deleteSession: () => Promise.resolve(),
    deleteExpiredSessions: () => Promise.resolve(),
  };
}

function handoffPort(overrides: Partial<BrowserHandoffPort> = {}): BrowserHandoffPort {
  return {
    create: () => Promise.resolve(undefined),
    stage: () => Promise.resolve(undefined),
    confirm: () => Promise.resolve(false),
    consume: () => Promise.resolve(undefined),
    ...overrides,
  };
}

function yahooConnectionPort(): YahooConnectionPort {
  return {
    start: () => Promise.reject(new Error("not used")),
    deny: () => Promise.reject(new Error("not used")),
    complete: () => Promise.reject(new Error("not used")),
  };
}

function yahooSyncPort(): YahooSyncPort {
  return {
    listConnections: () => Promise.resolve([]),
    disconnectConnection: () => Promise.resolve(),
    discoverAndSync: () => Promise.reject(new Error("not used")),
    syncLeague: () => Promise.reject(new Error("not used")),
  };
}

describe("BrowserHandoffService", () => {
  it("allows different ports but rejects a split hostname or scheme", () => {
    expect(
      browserHandoffOriginsCompatible("https://laces.example:4443", "https://laces.example"),
    ).toBe(true);
    expect(
      browserHandoffOriginsCompatible("https://api.laces.example", "https://laces.example"),
    ).toBe(false);
    expect(browserHandoffOriginsCompatible("http://laces.example", "https://laces.example")).toBe(
      false,
    );
  });

  it("masks the target account without disclosing its full email", () => {
    expect(maskBrowserHandoffAccount("mobile@example.test")).toBe("m***@example.test");
    expect(maskBrowserHandoffAccount("invalid-address")).toBe("your Laces Out account");
  });

  it("binds the source session hash, rotates bearers, confirms, and creates a session", async () => {
    const create = vi.fn<BrowserHandoffStore["create"]>(() => Promise.resolve(true));
    const stage = vi.fn<BrowserHandoffStore["stage"]>(() =>
      Promise.resolve({ accountEmail: "mobile@example.test" }),
    );
    const confirm = vi.fn<BrowserHandoffStore["confirm"]>(() => Promise.resolve(true));
    const consume = vi.fn<BrowserHandoffStore["consume"]>(() =>
      Promise.resolve({
        outcome: "session-created",
        userId,
        destination: "/connections/yahoo/connect",
      }),
    );
    const generated = [creationToken, redemptionToken, browserSessionToken];
    const service = new BrowserHandoffService(
      { create, stage, confirm, consume },
      "https://self-host.example",
      () => now,
      () => generated.shift() ?? "X".repeat(43),
    );

    const created = await service.create(userId, nativeSessionToken, "/connections/yahoo/connect");
    const url = new URL(created?.handoffUrl ?? "https://invalid.example");
    expect(url.origin).toBe("https://self-host.example");
    expect(url.pathname).toBe(browserHandoffLandingPath);
    expect(url.search).toBe("");
    expect(url.hash).toBe(`#${creationToken}`);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId,
        sourceSessionTokenHash: digest(nativeSessionToken),
        tokenHash: digest(creationToken),
        destination: "/connections/yahoo/connect",
      }),
    );
    expect(JSON.stringify(create.mock.calls)).not.toContain(nativeSessionToken);
    expect(JSON.stringify(create.mock.calls)).not.toContain(creationToken);

    expect(await service.stage(creationToken)).toEqual({
      redemptionToken,
      expiresAt: new Date("2031-07-31T12:01:00.000Z"),
      accountHint: "m***@example.test",
    });
    expect(stage).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenHash: digest(creationToken),
        replacementTokenHash: digest(redemptionToken),
      }),
    );

    await expect(service.confirm(redemptionToken)).resolves.toBe(true);
    expect(confirm).toHaveBeenCalledWith({
      tokenHash: digest(redemptionToken),
      confirmedAt: now,
    });

    await expect(service.consume(redemptionToken, nativeSessionToken)).resolves.toEqual({
      outcome: "session-created",
      userId,
      destination: "/connections/yahoo/connect",
      session: {
        token: browserSessionToken,
        expiresAt: new Date("2031-08-30T12:00:00.000Z"),
      },
    });
    expect(consume).toHaveBeenCalledWith({
      tokenHash: digest(redemptionToken),
      ambientSessionTokenHash: digest(nativeSessionToken),
      newSessionTokenHash: digest(browserSessionToken),
      newSessionExpiresAt: new Date("2031-08-30T12:00:00.000Z"),
      now,
    });
    expect(JSON.stringify(consume.mock.calls)).not.toContain(redemptionToken);
    expect(JSON.stringify(consume.mock.calls)).not.toContain(browserSessionToken);
  });

  it("fails closed when the source session is absent or no longer current", async () => {
    const create = vi.fn<BrowserHandoffStore["create"]>(() => Promise.resolve(false));
    const store: BrowserHandoffStore = {
      create,
      stage: () => Promise.resolve(undefined),
      confirm: () => Promise.resolve(false),
      consume: () => Promise.resolve(undefined),
    };
    const service = new BrowserHandoffService(store, "https://self-host.example", () => now);
    await expect(service.create(userId, undefined, "/stats")).resolves.toBeUndefined();
    expect(create).not.toHaveBeenCalled();
    await expect(service.create(userId, nativeSessionToken, "/stats")).resolves.toBeUndefined();
    expect(create).toHaveBeenCalledOnce();
  });

  it("rejects malformed bearers before touching persistence", async () => {
    const stage = vi.fn<BrowserHandoffStore["stage"]>(() =>
      Promise.resolve({ accountEmail: "mobile@example.test" }),
    );
    const confirm = vi.fn<BrowserHandoffStore["confirm"]>(() => Promise.resolve(true));
    const consume = vi.fn<BrowserHandoffStore["consume"]>(() => Promise.resolve(undefined));
    const store: BrowserHandoffStore = {
      create: vi.fn(() => Promise.resolve(true)),
      stage,
      confirm,
      consume,
    };
    const service = new BrowserHandoffService(store, "https://self-host.example", () => now);
    await expect(service.stage("not-a-token")).resolves.toBeUndefined();
    await expect(service.confirm("not-a-token")).resolves.toBe(false);
    await expect(service.consume("not-a-token")).resolves.toBeUndefined();
    expect(stage).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
  });
});

describe("browser handoff routes", () => {
  it("creates only authenticated, allowlisted handoffs from the exact session cookie", async () => {
    const create = vi.fn<BrowserHandoffPort["create"]>(() =>
      Promise.resolve({
        handoffUrl: `https://api.laces.example${browserHandoffLandingPath}#${creationToken}`,
        expiresAt: new Date("2031-07-31T12:02:00.000Z"),
      }),
    );
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: new AuthService(authRepository()),
      browserHandoffs: handoffPort({ create }),
    });

    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/auth/browser-handoffs",
          payload: { destination: "/stats" },
        })
      ).statusCode,
    ).toBe(401);
    for (const destination of [
      "https://attacker.example/steal",
      "/connections/yahoo/connect?next=https://attacker.example",
      "/connections/yahoo/connect/extra",
    ]) {
      const invalid = await app.inject({
        method: "POST",
        url: "/v1/auth/browser-handoffs",
        headers: { cookie: `${sessionCookieName}=${nativeSessionToken}` },
        payload: { destination },
      });
      expect(invalid.statusCode).toBe(400);
    }
    expect(create).not.toHaveBeenCalled();

    const result = await app.inject({
      method: "POST",
      url: "/v1/auth/browser-handoffs",
      headers: { cookie: `${sessionCookieName}=${nativeSessionToken}` },
      payload: { destination: "/stats" },
    });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({
      handoffUrl: `https://api.laces.example${browserHandoffLandingPath}#${creationToken}`,
      expiresAt: "2031-07-31T12:02:00.000Z",
    });
    expect(create).toHaveBeenCalledWith(userId, nativeSessionToken, "/stats");

    const yahoo = await app.inject({
      method: "POST",
      url: "/v1/auth/browser-handoffs",
      headers: { cookie: `${sessionCookieName}=${nativeSessionToken}` },
      payload: { destination: "/connections/yahoo/connect" },
    });
    expect(yahoo.statusCode).toBe(200);
    expect(create).toHaveBeenLastCalledWith(
      userId,
      nativeSessionToken,
      "/connections/yahoo/connect",
    );
    await app.close();
  });

  it("stages a masked hint but waits for an explicit server confirmation before consumption", async () => {
    let confirmed = false;
    let spent = false;
    const confirm = vi.fn<BrowserHandoffPort["confirm"]>((token) => {
      confirmed = token === redemptionToken;
      return Promise.resolve(confirmed);
    });
    const consume = vi.fn<BrowserHandoffPort["consume"]>((token) => {
      if (!confirmed || spent || token !== redemptionToken) return Promise.resolve(undefined);
      spent = true;
      return Promise.resolve({
        outcome: "session-created",
        userId,
        destination: "/stats",
        session: {
          token: browserSessionToken,
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        },
      });
    });
    const app = await buildApp({
      environment: productionEnvironment(),
      logger: false,
      requireAuthentication: true,
      authService: new AuthService(authRepository()),
      browserHandoffs: handoffPort({
        stage: (token) =>
          Promise.resolve(
            token === creationToken
              ? {
                  redemptionToken,
                  expiresAt: new Date(Date.now() + 60_000),
                  accountHint: "m***@example.test",
                }
              : undefined,
          ),
        confirm,
        consume,
      }),
    });

    const health = await app.inject({ method: "GET", url: "/health/ready" });
    expect(healthResponseSchema.parse(health.json()).mobileCapabilities).toContain(
      "authenticated-browser-handoff",
    );

    const landing = await app.inject({ method: "GET", url: browserHandoffLandingPath });
    expect(landing.statusCode).toBe(200);
    expect(landing.headers["cache-control"]).toBe("no-store");
    expect(landing.headers["referrer-policy"]).toBe("no-referrer");
    expect(landing.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(landing.body).toContain("location.hash");
    expect(landing.body).toContain("history.replaceState");
    expect(landing.body).toContain('continueButton.addEventListener("click"');
    expect(landing.body).toContain(
      'continueButton.textContent = "Continue as " + staged.accountHint',
    );
    expect(
      landing.body.indexOf(`location.replace("${browserHandoffConsumePath}")`),
    ).toBeGreaterThan(landing.body.indexOf('continueButton.addEventListener("click"'));
    expect(landing.body).not.toContain(creationToken);
    expect(consume).not.toHaveBeenCalled();

    // Staging is bearer-only, works on a same-host API port, and reveals only a masked account.
    const staged = await app.inject({
      method: "POST",
      url: browserHandoffStagePath,
      headers: { origin: "https://laces.example:4443" },
      payload: { token: creationToken },
    });
    expect(staged.statusCode).toBe(200);
    expect(staged.json()).toEqual({ accountHint: "m***@example.test" });
    expect(String(staged.headers["set-cookie"])).toContain(
      `${browserHandoffCookieName}=${redemptionToken}`,
    );
    expect(String(staged.headers["set-cookie"])).toContain("HttpOnly");
    expect(String(staged.headers["set-cookie"])).toContain(`Path=${browserHandoffLandingPath}`);
    expect(String(staged.headers["set-cookie"])).toContain("SameSite=Strict");
    expect(confirm).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();

    const crossSiteConfirmation = await app.inject({
      method: "POST",
      url: browserHandoffConfirmPath,
      headers: {
        origin: "https://attacker.example",
        cookie: `${browserHandoffCookieName}=${redemptionToken}`,
      },
    });
    expect(crossSiteConfirmation.statusCode).toBe(403);
    expect(confirm).not.toHaveBeenCalled();

    const confirmation = await app.inject({
      method: "POST",
      url: browserHandoffConfirmPath,
      headers: {
        origin: "https://laces.example:4443",
        cookie: `${browserHandoffCookieName}=${redemptionToken}`,
      },
    });
    expect(confirmation.statusCode).toBe(204);
    expect(confirm).toHaveBeenCalledWith(redemptionToken);
    expect(consume).not.toHaveBeenCalled();

    const consumed = await app.inject({
      method: "GET",
      url: browserHandoffConsumePath,
      headers: { cookie: `${browserHandoffCookieName}=${redemptionToken}` },
    });
    expect(consumed.statusCode).toBe(303);
    expect(consumed.headers.location).toBe("https://laces.example/stats");
    expect(consumed.headers["referrer-policy"]).toBe("no-referrer");
    const cookies = String(consumed.headers["set-cookie"]);
    expect(cookies).toContain(`${browserHandoffCookieName}=;`);
    expect(cookies).toContain(`${sessionCookieName}=${browserSessionToken}`);
    expect(consume).toHaveBeenCalledWith(redemptionToken, undefined);

    const replay = await app.inject({
      method: "GET",
      url: browserHandoffConsumePath,
      headers: { cookie: `${browserHandoffCookieName}=${redemptionToken}` },
    });
    expect(replay.statusCode).toBe(303);
    expect(replay.headers.location).toBe("https://laces.example/login?handoff=expired");
    expect(consume).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it("rejects malformed staging and confirmation without a capability cookie", async () => {
    const stage = vi.fn<BrowserHandoffPort["stage"]>(() => Promise.resolve(undefined));
    const confirm = vi.fn<BrowserHandoffPort["confirm"]>(() => Promise.resolve(false));
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      browserHandoffs: handoffPort({ stage, confirm }),
    });

    const malformed = await app.inject({
      method: "POST",
      url: browserHandoffStagePath,
      payload: { token: "not-a-token" },
    });
    expect(malformed.statusCode).toBe(400);
    expect(stage).not.toHaveBeenCalled();

    const missingCookie = await app.inject({ method: "POST", url: browserHandoffConfirmPath });
    expect(missingCookie.statusCode).toBe(401);
    expect(confirm).not.toHaveBeenCalled();
    expect(String(missingCookie.headers["set-cookie"])).toContain(`${browserHandoffCookieName}=;`);
    await app.close();
  });

  it("atomically reuses a same-user ambient session without replacing it", async () => {
    const consume = vi.fn<BrowserHandoffPort["consume"]>(() =>
      Promise.resolve({ outcome: "session-reused", userId, destination: "/stats" }),
    );
    const app = await buildApp({
      environment: productionEnvironment(),
      logger: false,
      requireAuthentication: true,
      authService: new AuthService(authRepository()),
      browserHandoffs: handoffPort({ consume }),
    });

    const result = await app.inject({
      method: "GET",
      url: browserHandoffConsumePath,
      headers: {
        cookie: `${sessionCookieName}=${nativeSessionToken}; ${browserHandoffCookieName}=${redemptionToken}`,
      },
    });
    expect(result.statusCode).toBe(303);
    expect(result.headers.location).toBe("https://laces.example/stats");
    expect(String(result.headers["set-cookie"])).toContain(`${browserHandoffCookieName}=;`);
    expect(String(result.headers["set-cookie"])).not.toContain(`${sessionCookieName}=`);
    expect(consume).toHaveBeenCalledWith(redemptionToken, nativeSessionToken);
    await app.close();
  });

  it("burns a confirmed handoff but preserves a different user's ambient session", async () => {
    const victimSessionToken = "v".repeat(43);
    const consume = vi
      .fn<BrowserHandoffPort["consume"]>()
      .mockResolvedValueOnce({ outcome: "account-mismatch" })
      .mockResolvedValue(undefined);
    const app = await buildApp({
      environment: productionEnvironment(),
      logger: false,
      requireAuthentication: true,
      authService: new AuthService(authRepository()),
      browserHandoffs: handoffPort({ consume }),
    });

    const refused = await app.inject({
      method: "GET",
      url: browserHandoffConsumePath,
      headers: {
        cookie: `${sessionCookieName}=${victimSessionToken}; ${browserHandoffCookieName}=${redemptionToken}`,
      },
    });
    expect(refused.statusCode).toBe(303);
    expect(refused.headers.location).toBe("https://laces.example/login?handoff=expired");
    expect(String(refused.headers["set-cookie"])).toContain(`${browserHandoffCookieName}=;`);
    expect(String(refused.headers["set-cookie"])).not.toContain(`${sessionCookieName}=`);
    expect(consume).toHaveBeenCalledWith(redemptionToken, victimSessionToken);

    const replay = await app.inject({
      method: "GET",
      url: browserHandoffConsumePath,
      headers: { cookie: `${browserHandoffCookieName}=${redemptionToken}` },
    });
    expect(replay.statusCode).toBe(303);
    expect(replay.headers.location).toBe("https://laces.example/login?handoff=expired");
    expect(consume).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it("does not advertise or create handoffs for split-host deployments", async () => {
    const create = vi.fn<BrowserHandoffPort["create"]>(() =>
      Promise.resolve({
        handoffUrl: `https://api.laces.example${browserHandoffLandingPath}#${creationToken}`,
        expiresAt: new Date(Date.now() + 120_000),
      }),
    );
    const environment = loadEnvironment({
      NODE_ENV: "production",
      WEB_URL: "https://web.laces.example",
      API_URL: "https://api.laces.example",
      SESSION_SECRET: "s".repeat(32),
      CREDENTIAL_ENCRYPTION_KEY: "k".repeat(32),
      DATABASE_URL: "postgresql://fantasy:a-strong-password@postgres:5432/fantasy",
    });
    const app = await buildApp({
      environment,
      logger: false,
      requireAuthentication: true,
      authService: new AuthService(authRepository()),
      browserHandoffs: handoffPort({ create }),
    });

    const health = await app.inject({ method: "GET", url: "/health/ready" });
    expect(healthResponseSchema.parse(health.json()).mobileCapabilities).not.toContain(
      "authenticated-browser-handoff",
    );
    expect(healthResponseSchema.parse(health.json()).mobileCapabilities).not.toContain(
      "yahoo-native-connect-v1",
    );
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/browser-handoffs",
      headers: {
        cookie: `${sessionCookieName}=${nativeSessionToken}`,
        origin: "https://web.laces.example",
      },
      payload: { destination: "/stats" },
    });
    expect(response.statusCode).toBe(503);
    expect(create).not.toHaveBeenCalled();
    await app.close();
  });

  it("advertises Yahoo native connect only when the complete deployment flow is available", async () => {
    const complete: BuildAppOptions = {
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      authService: new AuthService(authRepository()),
      browserHandoffs: handoffPort(),
      yahooConnection: yahooConnectionPort(),
      yahooSync: yahooSyncPort(),
      yahooNativeConnectLandingAvailable: true,
    };
    const configured = await buildApp(complete);
    const configuredHealth = healthResponseSchema.parse(
      (await configured.inject({ method: "GET", url: "/health/ready" })).json(),
    );
    expect(configuredHealth.mobileCapabilities).toContain("authenticated-browser-handoff");
    expect(configuredHealth.mobileCapabilities).toContain("yahoo-native-connect-v1");
    await configured.close();

    for (const missing of [
      "authService",
      "browserHandoffs",
      "yahooConnection",
      "yahooSync",
      "yahooNativeConnectLandingAvailable",
    ] as const) {
      const unavailable = { ...complete };
      delete unavailable[missing];
      const app = await buildApp(unavailable);
      const health = healthResponseSchema.parse(
        (await app.inject({ method: "GET", url: "/health/ready" })).json(),
      );
      expect(health.mobileCapabilities, missing).not.toContain("yahoo-native-connect-v1");
      await app.close();
    }
  });

  it("advertises Yahoo automation only when its flag, services, worker, and schedule are available", async () => {
    const enabledEnvironment = loadEnvironment({
      NODE_ENV: "test",
      YAHOO_AUTOMATED_SYNC_ENABLED: "true",
      YAHOO_CLIENT_ID: "client-id",
      YAHOO_CLIENT_SECRET: "client-secret",
      CREDENTIAL_ENCRYPTION_KEY: "base64:MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
    });
    const complete: BuildAppOptions = {
      environment: enabledEnvironment,
      logger: false,
      yahooConnection: yahooConnectionPort(),
      yahooSync: yahooSyncPort(),
      yahooAutomatedSyncAvailable: true,
    };
    const configured = await buildApp(complete);
    const configuredCapabilities = healthResponseSchema.parse(
      (await configured.inject({ method: "GET", url: "/health/ready" })).json(),
    ).mobileCapabilities;
    expect(configuredCapabilities).toContain("yahoo-automated-sync");
    expect(configuredCapabilities).not.toContain("yahoo-native-connect-v1");
    await configured.close();

    for (const missing of [
      "yahooConnection",
      "yahooSync",
      "yahooAutomatedSyncAvailable",
    ] as const) {
      const unavailable = { ...complete };
      delete unavailable[missing];
      const app = await buildApp(unavailable);
      const capabilities = healthResponseSchema.parse(
        (await app.inject({ method: "GET", url: "/health/ready" })).json(),
      ).mobileCapabilities;
      expect(capabilities, missing).not.toContain("yahoo-automated-sync");
      await app.close();
    }

    const disabled = await buildApp({
      ...complete,
      environment: loadEnvironment({ NODE_ENV: "test" }),
    });
    const disabledCapabilities = healthResponseSchema.parse(
      (await disabled.inject({ method: "GET", url: "/health/ready" })).json(),
    ).mobileCapabilities;
    expect(disabledCapabilities).not.toContain("yahoo-automated-sync");
    await disabled.close();
  });
});
