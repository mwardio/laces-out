import { loadEnvironment } from "@fantasy/config";
import { describe, expect, it, vi } from "vitest";

import { buildApp, type YahooConnectionPort } from "./app.js";
import { AuthService, type AuthRepository } from "./auth.js";
import { YahooConnectionCallbackError } from "./yahoo-connection.js";
import { YahooSyncError, type YahooSyncPort } from "./yahoo-sync.js";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const CONNECTION_ID = "20000000-0000-4000-8000-000000000001";
const COOKIE = `fantasy_session=${"s".repeat(32)}`;

function authService(): AuthService {
  const repository: AuthRepository = {
    findUserByEmail: () => Promise.resolve(undefined),
    createSession: () => Promise.resolve(),
    findSession: () =>
      Promise.resolve({
        user: {
          id: USER_ID,
          email: "guru@example.com",
          displayName: "League Guru",
          role: "admin",
        },
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
        lastSeenAt: new Date(),
      }),
    touchSession: () => Promise.resolve(),
    deleteSession: () => Promise.resolve(),
    deleteExpiredSessions: () => Promise.resolve(),
  };
  return new AuthService(repository);
}

function yahooSync(overrides: Partial<YahooSyncPort> = {}): YahooSyncPort {
  return {
    listConnections: () => Promise.resolve([]),
    disconnectConnection: () => Promise.resolve(),
    discoverAndSync: () =>
      Promise.resolve({
        connectionId: CONNECTION_ID,
        discovered: [],
        syncs: [],
        generatedAt: "2026-07-16T12:00:00.000Z",
      }),
    syncLeague: () =>
      Promise.resolve({
        syncRunId: "30000000-0000-4000-8000-000000000001",
        leagueId: "40000000-0000-4000-8000-000000000001",
        leagueSeasonId: "50000000-0000-4000-8000-000000000001",
        externalLeagueKey: "449.l.12345",
        season: 2026,
        state: "accepted",
        recordsWritten: 12,
        syncedAt: "2026-07-16T12:00:00.000Z",
      }),
    ...overrides,
  };
}

function yahooConnection(overrides: Partial<YahooConnectionPort> = {}): YahooConnectionPort {
  return {
    start: () => Promise.reject(new Error("not used")),
    deny: () => Promise.reject(new Error("not used")),
    complete: () => Promise.reject(new Error("not used")),
    ...overrides,
  };
}

describe("Yahoo sync routes", () => {
  it("idempotently removes a Yahoo connection only through the authenticated actor", async () => {
    const disconnectConnection = vi.fn(() => Promise.resolve());
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authService(),
      yahooSync: yahooSync({ disconnectConnection }),
    });
    const url = "/v1/connections/yahoo/" + CONNECTION_ID;

    expect((await app.inject({ method: "DELETE", url })).statusCode).toBe(401);
    for (const requestId of ["disconnect-one", "disconnect-two"]) {
      const response = await app.inject({
        method: "DELETE",
        url,
        headers: { cookie: COOKIE, "x-request-id": requestId },
      });
      expect(response.statusCode).toBe(204);
      expect(response.body).toBe("");
    }
    expect(disconnectConnection).toHaveBeenNthCalledWith(
      1,
      USER_ID,
      CONNECTION_ID,
      "disconnect-one",
    );
    expect(disconnectConnection).toHaveBeenNthCalledWith(
      2,
      USER_ID,
      CONNECTION_ID,
      "disconnect-two",
    );
    await app.close();
  });

  it("returns a sanitized problem when local Yahoo credential removal fails", async () => {
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authService(),
      yahooSync: yahooSync({
        disconnectConnection: () =>
          Promise.reject(
            new YahooSyncError(
              "LOCAL_DISCONNECT_FAILED",
              "The stored Yahoo authorization could not be removed from Laces Out",
            ),
          ),
      }),
    });

    const response = await app.inject({
      method: "DELETE",
      url: "/v1/connections/yahoo/" + CONNECTION_ID,
      headers: { cookie: COOKIE },
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      code: "LOCAL_DISCONNECT_FAILED",
      title: "Yahoo authorization removal failed",
    });
    await app.close();
  });

  it("requires a session and scopes connection status to the authenticated user", async () => {
    const listConnections = vi.fn(() =>
      Promise.resolve([
        {
          connectionId: CONNECTION_ID,
          displayName: "Yahoo Fantasy",
          health: "healthy" as const,
          credentialExpiresAt: "2026-07-16T13:00:00.000Z",
          lastSuccessfulAt: "2026-07-16T12:00:00.000Z",
          lastErrorCode: null,
          lastErrorAt: null,
          leagues: [],
        },
      ]),
    );
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authService(),
      yahooSync: yahooSync({ listConnections }),
    });

    expect((await app.inject({ method: "GET", url: "/v1/connections/yahoo" })).statusCode).toBe(
      401,
    );
    const response = await app.inject({
      method: "GET",
      url: "/v1/connections/yahoo",
      headers: { cookie: COOKIE },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ connections: [{ connectionId: CONNECTION_ID }] });
    expect(listConnections).toHaveBeenCalledWith(USER_ID);
    await app.close();
  });

  it("passes discovery and league sync only through the authenticated actor", async () => {
    const discoverAndSync = vi.fn(yahooSync().discoverAndSync);
    const syncLeague = vi.fn(yahooSync().syncLeague);
    const enqueueProjectionRefresh = vi.fn(() => Promise.resolve("projection-job"));
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authService(),
      yahooSync: yahooSync({ discoverAndSync, syncLeague }),
      enqueueProjectionRefresh,
    });

    const discovery = await app.inject({
      method: "POST",
      url: `/v1/connections/yahoo/${CONNECTION_ID}/discover`,
      headers: { cookie: COOKIE },
    });
    expect(discovery.statusCode).toBe(202);
    expect(discoverAndSync).toHaveBeenCalledWith(USER_ID, CONNECTION_ID);

    const sync = await app.inject({
      method: "POST",
      url: `/v1/connections/yahoo/${CONNECTION_ID}/leagues/449.l.12345/sync`,
      headers: { cookie: COOKIE },
    });
    expect(sync.statusCode).toBe(202);
    expect(syncLeague).toHaveBeenCalledWith(USER_ID, CONNECTION_ID, "449.l.12345");
    expect(enqueueProjectionRefresh).toHaveBeenCalledWith(
      expect.objectContaining({ season: 2026, reason: "league-sync" }),
    );
    await app.close();
  });

  it("returns a membership-safe not-found response for an unowned connection", async () => {
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authService(),
      yahooSync: yahooSync({
        discoverAndSync: () =>
          Promise.reject(
            new YahooSyncError("CONNECTION_NOT_FOUND", "Yahoo connection was not found"),
          ),
      }),
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/connections/yahoo/${CONNECTION_ID}/discover`,
      headers: { cookie: COOKIE },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: "CONNECTION_NOT_FOUND" });
    await app.close();
  });

  it("limits discovery requests to eight per minute", async () => {
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authService(),
      yahooSync: yahooSync(),
    });
    const url = `/v1/connections/yahoo/${CONNECTION_ID}/discover`;

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const response = await app.inject({
        method: "POST",
        url,
        headers: { cookie: COOKIE },
      });
      expect(response.statusCode).toBe(202);
    }
    const limited = await app.inject({
      method: "POST",
      url,
      headers: { cookie: COOKIE },
    });
    expect(limited.statusCode).toBe(429);
    await app.close();
  });

  it("limits league sync requests to ten per minute", async () => {
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authService(),
      yahooSync: yahooSync(),
    });
    const url = `/v1/connections/yahoo/${CONNECTION_ID}/leagues/449.l.12345/sync`;

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await app.inject({
        method: "POST",
        url,
        headers: { cookie: COOKIE },
      });
      expect(response.statusCode).toBe(202);
    }
    const limited = await app.inject({
      method: "POST",
      url,
      headers: { cookie: COOKIE },
    });
    expect(limited.statusCode).toBe(429);
    await app.close();
  });

  it("runs the initial read sync after OAuth but preserves the connection if sync fails", async () => {
    const complete = vi.fn(() =>
      Promise.resolve({
        connectionId: CONNECTION_ID,
        returnMode: "browser" as const,
        returnTo: "/connections",
      }),
    );
    const discoverAndSync = vi.fn(() => Promise.reject(new Error("sanitized provider failure")));
    const yahooConnection: YahooConnectionPort = {
      start: () => Promise.reject(new Error("not used")),
      deny: () => Promise.reject(new Error("not used")),
      complete,
    };
    const app = await buildApp({
      environment: loadEnvironment({
        NODE_ENV: "test",
        WEB_URL: "https://laces.example",
      }),
      logger: false,
      requireAuthentication: true,
      authService: authService(),
      yahooConnection,
      yahooSync: yahooSync({ discoverAndSync }),
    });

    const response = await app.inject({
      method: "GET",
      url: "/v1/connections/yahoo/callback?code=code&state=state",
      headers: { cookie: COOKIE },
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(
      "https://laces.example/connections?provider=yahoo&status=connected&sync=failed",
    );
    expect(discoverAndSync).toHaveBeenCalledWith(USER_ID, CONNECTION_ID);
    await app.close();
  });

  it("starts the closed native authorization mode without a caller completion URL", async () => {
    const start = vi.fn<YahooConnectionPort["start"]>(() =>
      Promise.resolve({
        authorizationUrl: "https://api.login.yahoo.com/oauth2/request_auth?state=opaque",
        expiresAt: "2031-08-04T12:10:00.000Z",
      }),
    );
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authService(),
      yahooConnection: yahooConnection({ start }),
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/connections/yahoo/authorize",
      headers: { cookie: COOKIE },
      payload: { returnMode: "ios-app" },
    });
    expect(response.statusCode).toBe(200);
    expect(start).toHaveBeenCalledWith(USER_ID, {
      returnMode: "ios-app",
      returnTo: "/connections",
    });

    for (const payload of [
      { returnMode: "ios-app", callbackUrl: "lacesout://attacker" },
      { returnMode: "ios-app", redirectUri: "https://attacker.example/callback" },
      { returnMode: "ios-app", returnTo: "/settings" },
      { returnMode: "browser", returnTo: "/connections", unexpected: true },
    ]) {
      const invalid = await app.inject({
        method: "POST",
        url: "/v1/connections/yahoo/authorize",
        headers: { cookie: COOKIE },
        payload,
      });
      expect(invalid.statusCode).toBe(400);
    }
    expect(start).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("returns a successful native flow only through the exact credential-free callback", async () => {
    const complete = vi.fn<YahooConnectionPort["complete"]>(() =>
      Promise.resolve({
        connectionId: CONNECTION_ID,
        returnMode: "ios-app",
        // Deliberately hostile stored browser data must be irrelevant in native mode.
        returnTo: "https://attacker.example/steal",
      }),
    );
    const app = await buildApp({
      environment: loadEnvironment({
        NODE_ENV: "test",
        WEB_URL: "https://self-host.example",
      }),
      logger: false,
      requireAuthentication: true,
      authService: authService(),
      yahooConnection: yahooConnection({ complete }),
      yahooSync: yahooSync(),
    });
    const code = "SECRET_YAHOO_AUTHORIZATION_CODE";
    const state = "S".repeat(43);

    const response = await app.inject({
      method: "GET",
      url:
        `/v1/connections/yahoo/callback?code=${code}&state=${state}` +
        "&xoauth_yahoo_guid=SECRET_YAHOO_GUID&support=SECRET_SUPPORT_DATA",
      headers: { cookie: COOKIE },
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("lacesout://connections/yahoo?status=connected");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    const exposed = JSON.stringify(response.headers) + response.body;
    for (const secret of [
      code,
      state,
      CONNECTION_ID,
      "SECRET_YAHOO_GUID",
      "SECRET_SUPPORT_DATA",
      "access_token",
      "refresh_token",
      "fantasy_session",
      "attacker.example",
    ]) {
      expect(exposed).not.toContain(secret);
    }
    await app.close();
  });

  it("validates and consumes denial state before selecting the native callback", async () => {
    const deny = vi
      .fn<YahooConnectionPort["deny"]>()
      .mockResolvedValueOnce({
        returnMode: "ios-app",
        returnTo: "https://attacker.example/ignored",
      })
      .mockRejectedValueOnce(new Error("STATE_REPLAYED"));
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authService(),
      yahooConnection: yahooConnection({ deny }),
    });
    const state = "D".repeat(43);
    const callback =
      `/v1/connections/yahoo/callback?error=access_denied&state=${state}` +
      "&error_description=SECRET_PROVIDER_DETAIL";

    const denied = await app.inject({ method: "GET", url: callback, headers: { cookie: COOKIE } });
    expect(denied.headers.location).toBe("lacesout://connections/yahoo?status=denied");
    expect(denied.headers["referrer-policy"]).toBe("no-referrer");
    expect(denied.headers.location).not.toContain("SECRET_PROVIDER_DETAIL");
    expect(deny).toHaveBeenNthCalledWith(1, USER_ID, state);

    const replay = await app.inject({ method: "GET", url: callback, headers: { cookie: COOKIE } });
    expect(replay.headers.location).toBe(
      "http://localhost:3000/connections?provider=yahoo&status=denied",
    );
    expect(replay.headers.location).not.toMatch(/^lacesout:/u);
    expect(deny).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it.each([
    ["server_error", "unavailable"],
    ["temporarily_unavailable", "unavailable"],
    ["invalid_request", "failed"],
    [undefined, "failed"],
  ] as const)(
    "maps the verified native provider outcome %s to the fixed %s callback",
    async (providerError, expectedStatus) => {
      const deny = vi.fn<YahooConnectionPort["deny"]>(() =>
        Promise.resolve({ returnMode: "ios-app", returnTo: "/connections" }),
      );
      const app = await buildApp({
        environment: loadEnvironment({ NODE_ENV: "test" }),
        logger: false,
        requireAuthentication: true,
        authService: authService(),
        yahooConnection: yahooConnection({ deny }),
      });
      const query = new URLSearchParams({ state: "P".repeat(43) });
      if (providerError) query.set("error", providerError);

      const response = await app.inject({
        method: "GET",
        url: `/v1/connections/yahoo/callback?${query.toString()}`,
        headers: { cookie: COOKIE },
      });
      expect(response.headers.location).toBe(
        `lacesout://connections/yahoo?status=${expectedStatus}`,
      );
      expect(deny).toHaveBeenCalledWith(USER_ID, "P".repeat(43));
      await app.close();
    },
  );

  it("preserves the existing browser denial fallback for non-code provider outcomes", async () => {
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authService(),
      yahooConnection: yahooConnection({
        deny: () => Promise.resolve({ returnMode: "browser", returnTo: "/connections" }),
      }),
    });

    const response = await app.inject({
      method: "GET",
      url: `/v1/connections/yahoo/callback?error=server_error&state=${"B".repeat(43)}`,
      headers: { cookie: COOKIE },
    });
    expect(response.headers.location).toBe(
      "http://localhost:3000/connections?provider=yahoo&status=denied",
    );
    await app.close();
  });

  it("fails missing or untrusted denial state closed to the browser fallback", async () => {
    const deny = vi.fn<YahooConnectionPort["deny"]>(() =>
      Promise.reject(new Error("invalid, expired, malformed, or wrong-user state")),
    );
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authService(),
      yahooConnection: yahooConnection({ deny }),
    });

    const missing = await app.inject({
      method: "GET",
      url: "/v1/connections/yahoo/callback?error=access_denied",
      headers: { cookie: COOKIE },
    });
    expect(missing.headers.location).toBe(
      "http://localhost:3000/connections?provider=yahoo&status=denied",
    );
    expect(deny).not.toHaveBeenCalled();

    for (const state of ["malformed", "E".repeat(43), "W".repeat(43)]) {
      const rejected = await app.inject({
        method: "GET",
        url: `/v1/connections/yahoo/callback?error=access_denied&state=${state}`,
        headers: { cookie: COOKIE },
      });
      expect(rejected.headers.location).toBe(
        "http://localhost:3000/connections?provider=yahoo&status=denied",
      );
      expect(rejected.headers.location).not.toMatch(/^lacesout:/u);
    }
    await app.close();
  });

  it.each(["unavailable", "failed"] as const)(
    "maps a verified native %s outcome to only its fixed callback",
    async (outcome) => {
      const completion = {
        returnMode: "ios-app" as const,
        returnTo: "https://attacker.example/ignored",
      };
      const app = await buildApp({
        environment: loadEnvironment({ NODE_ENV: "test" }),
        logger: false,
        requireAuthentication: true,
        authService: authService(),
        yahooConnection: yahooConnection({
          complete: () => Promise.reject(new YahooConnectionCallbackError(outcome, completion)),
        }),
      });

      const response = await app.inject({
        method: "GET",
        url: `/v1/connections/yahoo/callback?code=${"C".repeat(43)}&state=${"T".repeat(43)}`,
        headers: { cookie: COOKIE },
      });
      expect(response.headers.location).toBe(`lacesout://connections/yahoo?status=${outcome}`);
      expect(response.headers.location).not.toContain("attacker.example");
      await app.close();
    },
  );

  it("keeps native completion connected when the stored connection's initial sync fails", async () => {
    const discoverAndSync = vi.fn(() =>
      Promise.reject(new Error("provider payload is unavailable")),
    );
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authService(),
      yahooConnection: yahooConnection({
        complete: () =>
          Promise.resolve({
            connectionId: CONNECTION_ID,
            returnMode: "ios-app",
            returnTo: "/connections",
          }),
      }),
      yahooSync: yahooSync({ discoverAndSync }),
    });

    const response = await app.inject({
      method: "GET",
      url: `/v1/connections/yahoo/callback?code=${"C".repeat(43)}&state=${"S".repeat(43)}`,
      headers: { cookie: COOKIE },
    });
    expect(response.headers.location).toBe("lacesout://connections/yahoo?status=connected");
    expect(discoverAndSync).toHaveBeenCalledWith(USER_ID, CONNECTION_ID);
    await app.close();
  });
  it("recomputes recommendations for an accepted Yahoo league sync", async () => {
    const enqueueRecommendationRecompute = vi.fn(() => Promise.resolve("recompute-job"));
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authService(),
      yahooSync: yahooSync(),
      enqueueRecommendationRecompute,
    });

    const sync = await app.inject({
      method: "POST",
      url: `/v1/connections/yahoo/${CONNECTION_ID}/leagues/449.l.12345/sync`,
      headers: { cookie: COOKIE },
    });

    expect(sync.statusCode).toBe(202);
    expect(enqueueRecommendationRecompute).toHaveBeenCalledTimes(1);
    expect(enqueueRecommendationRecompute).toHaveBeenCalledWith(
      expect.objectContaining({
        leagueSeasonId: "50000000-0000-4000-8000-000000000001",
        kinds: ["lineup", "trade", "waiver"],
      }),
    );
    await app.close();
  });

  it("enqueues no recomputation for an unchanged Yahoo payload", async () => {
    const enqueueRecommendationRecompute = vi.fn(() => Promise.resolve("recompute-job"));
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authService(),
      yahooSync: yahooSync({
        syncLeague: () =>
          Promise.resolve({
            syncRunId: "30000000-0000-4000-8000-000000000001",
            leagueId: "40000000-0000-4000-8000-000000000001",
            leagueSeasonId: "50000000-0000-4000-8000-000000000001",
            externalLeagueKey: "449.l.12345",
            season: 2026,
            state: "unchanged" as const,
            recordsWritten: 0,
            syncedAt: "2026-07-16T12:00:00.000Z",
          }),
      }),
      enqueueRecommendationRecompute,
    });

    const sync = await app.inject({
      method: "POST",
      url: `/v1/connections/yahoo/${CONNECTION_ID}/leagues/449.l.12345/sync`,
      headers: { cookie: COOKIE },
    });

    expect(sync.statusCode).toBe(200);
    expect(enqueueRecommendationRecompute).not.toHaveBeenCalled();
    await app.close();
  });

  it("recomputes each discovered league season once and survives an enqueue failure", async () => {
    const enqueueRecommendationRecompute = vi.fn(() => Promise.reject(new Error("queue down")));
    const receipt = (leagueSeasonId: string, state: "accepted" | "unchanged") => ({
      syncRunId: "30000000-0000-4000-8000-000000000001",
      leagueId: "40000000-0000-4000-8000-000000000001",
      leagueSeasonId,
      externalLeagueKey: "449.l.12345",
      season: 2026,
      state,
      recordsWritten: 1,
      syncedAt: "2026-07-16T12:00:00.000Z",
    });
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authService(),
      yahooSync: yahooSync({
        discoverAndSync: () =>
          Promise.resolve({
            connectionId: CONNECTION_ID,
            discovered: [],
            syncs: [
              receipt("50000000-0000-4000-8000-000000000001", "accepted"),
              receipt("50000000-0000-4000-8000-000000000001", "accepted"),
              receipt("50000000-0000-4000-8000-000000000002", "unchanged"),
            ],
            generatedAt: "2026-07-16T12:00:00.000Z",
          }),
      }),
      enqueueRecommendationRecompute,
    });

    const discovery = await app.inject({
      method: "POST",
      url: `/v1/connections/yahoo/${CONNECTION_ID}/discover`,
      headers: { cookie: COOKIE },
    });

    // Two accepted receipts for one league season collapse to one enqueue; the unchanged one adds
    // none. A queue outage is logged rather than failing a sync that already committed.
    expect(discovery.statusCode).toBe(202);
    expect(enqueueRecommendationRecompute).toHaveBeenCalledTimes(1);
    await app.close();
  });
});
