import { loadEnvironment } from "@fantasy/config";
import { describe, expect, it, vi } from "vitest";

import { buildApp, type YahooConnectionPort } from "./app.js";
import { AuthService, type AuthRepository } from "./auth.js";
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
      Promise.resolve({ connectionId: CONNECTION_ID, returnTo: "/connections" }),
    );
    const discoverAndSync = vi.fn(() => Promise.reject(new Error("sanitized provider failure")));
    const yahooConnection: YahooConnectionPort = {
      start: () => Promise.reject(new Error("not used")),
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
});
