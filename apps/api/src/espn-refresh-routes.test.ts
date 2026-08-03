import { describe, expect, it, vi } from "vitest";

import { loadEnvironment } from "@fantasy/config";
import type { EspnLeagueRefreshStatus } from "@fantasy/contracts";

import { buildApp, type EspnRefreshPort } from "./app.js";
import { AuthService, type AuthRepository } from "./auth.js";
import { EspnRefreshError } from "./espn-refresh.js";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const LEAGUE_SEASON_ID = "20000000-0000-4000-8000-000000000001";
const REQUEST_ID = "30000000-0000-4000-8000-000000000001";
const ATTEMPT_ID = "40000000-0000-4000-8000-000000000001";
const DEVICE_TOKEN = `lo_espn_${"a".repeat(43)}`;
const COOKIE = `fantasy_session=${"s".repeat(32)}`;

function authentication(): AuthService {
  const repository: AuthRepository = {
    findUserByEmail: () => Promise.resolve(undefined),
    createSession: () => Promise.resolve(),
    findSession: () =>
      Promise.resolve({
        user: {
          id: USER_ID,
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

function status(): EspnLeagueRefreshStatus {
  return {
    schemaVersion: 1,
    generatedAt: "2026-09-20T17:00:00.000Z",
    leagueSeasonId: LEAGUE_SEASON_ID,
    provider: "espn",
    current: false,
    context: "active",
    artifacts: [{ family: "core", state: "stale", observedAt: null }],
    direct: {
      enabled: false,
      coreState: "disabled",
      preferredMode: "automatic",
      lastProbeAt: null,
      nextProbeAt: null,
      lastSuccessAt: null,
      circuitOpenUntil: null,
    },
    agents: { activeCount: 0, mostRecentSeenAt: null },
    request: {
      id: REQUEST_ID,
      state: "queued",
      fulfillmentMode: null,
      requiredArtifacts: ["core"],
      minimumCaptureAt: "2026-09-20T17:00:00.000Z",
      requestedAt: "2026-09-20T17:00:00.000Z",
      expiresAt: "2026-09-21T17:00:00.000Z",
      finishedAt: null,
      latestAttempt: null,
    },
    display: {
      code: "queued-no-agent",
      label: "Refresh queued · waiting for a paired device",
      actionRequired: true,
    },
  };
}

function refreshPort() {
  const requestRefresh = vi.fn<EspnRefreshPort["requestRefresh"]>(async () => status());
  const getStatus = vi.fn<EspnRefreshPort["getStatus"]>(async () => status());
  const pollAgent = vi.fn<EspnRefreshPort["pollAgent"]>(async () => ({
    schemaVersion: 1 as const,
    generatedAt: "2026-09-20T17:00:00.000Z",
    pollAfterSeconds: 300,
    requests: [
      {
        requestId: REQUEST_ID,
        externalLeagueId: "12345",
        season: 2026,
        minimumCaptureAt: "2026-09-20T17:00:00.000Z",
        expiresAt: "2026-09-21T17:00:00.000Z",
        requiredArtifacts: ["core" as const],
      },
    ],
  }));
  const reportAgentAttempt = vi.fn<EspnRefreshPort["reportAgentAttempt"]>(
    async (_token, _requestId, input) => ({
      attemptId: ATTEMPT_ID,
      state: input.state,
      recordedAt: "2026-09-20T17:01:00.000Z",
    }),
  );
  return { requestRefresh, getStatus, pollAgent, reportAgentAttempt } satisfies EspnRefreshPort;
}

describe("ESPN automated refresh routes", () => {
  it("creates and reads a member-scoped refresh intent", async () => {
    const espnRefresh = refreshPort();
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authentication(),
      espnRefresh,
    });

    const created = await app.inject({
      method: "POST",
      url: `/v1/leagues/${LEAGUE_SEASON_ID}/refresh`,
      headers: { cookie: COOKIE },
    });
    const read = await app.inject({
      method: "GET",
      url: `/v1/leagues/${LEAGUE_SEASON_ID}/refresh/status`,
      headers: { cookie: COOKIE },
    });

    expect(created.statusCode).toBe(202);
    expect(created.json()).toMatchObject({ request: { id: REQUEST_ID, state: "queued" } });
    expect(read.statusCode).toBe(200);
    expect(espnRefresh.requestRefresh).toHaveBeenCalledWith(USER_ID, LEAGUE_SEASON_ID);
    expect(espnRefresh.getStatus).toHaveBeenCalledWith(USER_ID, LEAGUE_SEASON_ID);
    await app.close();
  });

  it("rejects client-provided force and scope controls", async () => {
    const espnRefresh = refreshPort();
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authentication(),
      espnRefresh,
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/leagues/${LEAGUE_SEASON_ID}/refresh`,
      headers: { cookie: COOKIE },
      payload: { force: true, requiredArtifacts: ["core"] },
    });

    expect(response.statusCode).toBe(400);
    expect(espnRefresh.requestRefresh).not.toHaveBeenCalled();
    await app.close();
  });

  it("requires a member session and returns membership failures as a generic 404", async () => {
    const espnRefresh = refreshPort();
    espnRefresh.getStatus.mockRejectedValueOnce(
      new EspnRefreshError("NOT_FOUND", "ESPN league season was not found"),
    );
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authentication(),
      espnRefresh,
    });

    const unauthenticated = await app.inject({
      method: "POST",
      url: `/v1/leagues/${LEAGUE_SEASON_ID}/refresh`,
    });
    const missing = await app.inject({
      method: "GET",
      url: `/v1/leagues/${LEAGUE_SEASON_ID}/refresh/status`,
      headers: { cookie: COOKIE },
    });

    expect(unauthenticated.statusCode).toBe(401);
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ title: "Request rejected", status: 404 });
    await app.close();
  });

  it("polls and reports through the bounded Bridge credential contract without a cookie", async () => {
    const espnRefresh = refreshPort();
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authentication(),
      espnRefresh,
    });

    const polled = await app.inject({
      method: "POST",
      url: "/v1/bridge/espn/refresh-requests/poll",
      headers: { authorization: `Bridge ${DEVICE_TOKEN}` },
      payload: {},
    });
    const reported = await app.inject({
      method: "POST",
      url: `/v1/bridge/espn/refresh-requests/${REQUEST_ID}/attempts`,
      headers: { authorization: `Bridge ${DEVICE_TOKEN}` },
      payload: { state: "login-required", errorCode: "ESPN_LOGIN_REQUIRED" },
    });

    expect(polled.statusCode).toBe(200);
    expect(polled.json()).toMatchObject({
      pollAfterSeconds: 300,
      requests: [{ requestId: REQUEST_ID }],
    });
    expect(reported.statusCode).toBe(200);
    expect(reported.json()).toMatchObject({ attemptId: ATTEMPT_ID, state: "login-required" });
    expect(espnRefresh.pollAgent).toHaveBeenCalledWith(DEVICE_TOKEN);
    expect(espnRefresh.reportAgentAttempt).toHaveBeenCalledWith(DEVICE_TOKEN, REQUEST_ID, {
      state: "login-required",
      errorCode: "ESPN_LOGIN_REQUIRED",
    });
    await app.close();
  });

  it("rejects missing device authorization and unbounded terminal outcomes before dispatch", async () => {
    const espnRefresh = refreshPort();
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authentication(),
      espnRefresh,
    });

    const unauthorized = await app.inject({
      method: "POST",
      url: "/v1/bridge/espn/refresh-requests/poll",
      payload: {},
    });
    const invalid = await app.inject({
      method: "POST",
      url: `/v1/bridge/espn/refresh-requests/${REQUEST_ID}/attempts`,
      headers: { authorization: `Bridge ${DEVICE_TOKEN}` },
      payload: { state: "retryable-error" },
    });

    expect(unauthorized.statusCode).toBe(401);
    expect(invalid.statusCode).toBe(400);
    expect(espnRefresh.pollAgent).not.toHaveBeenCalled();
    expect(espnRefresh.reportAgentAttempt).not.toHaveBeenCalled();
    await app.close();
  });
});
