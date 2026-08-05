import { describe, expect, it, vi } from "vitest";

import { loadEnvironment } from "@fantasy/config";
import { espnSessionConnectionListSchema, healthResponseSchema } from "@fantasy/contracts";

import { buildApp, type EspnSessionConnectionPort } from "./app.js";
import { AuthService, type AuthRepository } from "./auth.js";

const userId = "00000000-0000-4000-8000-000000000001";
const connectionId = "00000000-0000-4000-8000-000000000002";
const leagueId = "00000000-0000-4000-8000-000000000003";
const leagueSeasonId = "00000000-0000-4000-8000-000000000004";
const sessionCookie = `fantasy_session=${"s".repeat(32)}`;
const deviceToken = `lo_espn_${"b".repeat(43)}`;

function authService(): AuthService {
  const repository: AuthRepository = {
    findUserByEmail: () => Promise.resolve(undefined),
    createSession: () => Promise.resolve(),
    findSession: () =>
      Promise.resolve({
        user: {
          id: userId,
          email: "member@example.com",
          displayName: "Member",
          role: "member",
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

function environment() {
  return loadEnvironment({
    NODE_ENV: "test",
    WEB_URL: "http://localhost:3000",
    API_URL: "http://localhost:4000",
    SESSION_SECRET: "s".repeat(32),
    CREDENTIAL_ENCRYPTION_KEY: "k".repeat(32),
    DATABASE_URL: "postgresql://fantasy:password@localhost:5432/fantasy",
    ESPN_SERVER_SESSION_SYNC_ENABLED: "true",
  });
}

function connectionHarness() {
  const grantFromBridge = vi.fn(async () => ({
    connectionId,
    state: "healthy" as const,
    linkedLeagueCount: 1,
  }));
  const disconnectConnection = vi.fn(async () => true);
  const port: EspnSessionConnectionPort = {
    grantFromBridge,
    listConnections: vi.fn(async () => ({
      available: true,
      connections: [
        {
          connectionId,
          displayName: "ESPN Fantasy",
          health: "healthy" as const,
          lastSuccessfulAt: "2026-09-24T15:00:00.000Z",
          lastErrorCode: null,
          lastErrorAt: null,
          leagues: [
            {
              leagueId,
              leagueSeasonId,
              name: "Friends League",
              externalKey: "123456789",
              season: 2026,
              lastSyncedAt: "2026-09-24T15:00:00.000Z",
            },
          ],
        },
      ],
    })),
    disconnectConnection,
  };
  return { port, grantFromBridge, disconnectConnection };
}

describe("ESPN server-session routes", () => {
  it("accepts a fresh authorization only through an active bridge credential boundary", async () => {
    const { port, grantFromBridge } = connectionHarness();
    const app = await buildApp({
      environment: environment(),
      authService: authService(),
      espnSessionConnections: port,
      requireAuthentication: true,
      logger: false,
    });
    const body = {
      swid: "{123e4567-e89b-42d3-a456-426614174000}",
      espnS2: "session-value-that-is-long-enough-for-validation",
      capturedAt: "2026-09-24T15:00:00.000Z",
    };

    const unauthorized = await app.inject({
      method: "POST",
      url: "/v1/bridge/espn/session-grants",
      payload: body,
    });
    expect(unauthorized.statusCode).toBe(401);

    const accepted = await app.inject({
      method: "POST",
      url: "/v1/bridge/espn/session-grants",
      headers: { authorization: `Bridge ${deviceToken}` },
      payload: body,
    });
    expect(accepted.statusCode).toBe(201);
    expect(accepted.json()).toEqual({ connectionId, state: "healthy", linkedLeagueCount: 1 });
    expect(grantFromBridge).toHaveBeenCalledWith(deviceToken, body, expect.any(String));
    await app.close();
  });

  it("lists and removes only the signed-in member's stored connection", async () => {
    const { port, disconnectConnection } = connectionHarness();
    const app = await buildApp({
      environment: environment(),
      authService: authService(),
      espnSessionConnections: port,
      requireAuthentication: true,
      logger: false,
    });

    const listed = await app.inject({
      method: "GET",
      url: "/v1/connections/espn/sessions",
      headers: { cookie: sessionCookie },
    });
    expect(listed.statusCode).toBe(200);
    expect(espnSessionConnectionListSchema.parse(listed.json()).connections).toHaveLength(1);

    const removed = await app.inject({
      method: "DELETE",
      url: `/v1/connections/espn/sessions/${connectionId}`,
      headers: { cookie: sessionCookie },
    });
    expect(removed.statusCode).toBe(204);
    expect(disconnectConnection).toHaveBeenCalledWith(userId, connectionId, expect.any(String));

    const health = await app.inject({ method: "GET", url: "/health/live" });
    const mobileCapabilities = healthResponseSchema.parse(health.json()).mobileCapabilities;
    expect(mobileCapabilities).toContain("espn-native-session-grant-v1");
    expect(mobileCapabilities).toContain("espn-server-session-v1");
    await app.close();
  });
});
