import { loadEnvironment } from "@fantasy/config";
import { FIRST_PARTY_ROS_MODEL_VERSION, rosScoringProfile } from "@fantasy/projections";
import { describe, expect, it, vi } from "vitest";

import { buildApp } from "./app.js";
import { AuthService, type AuthRepository } from "./auth.js";
import type { RosProjectionStatusPort } from "./ros-projection-status-routes.js";
import type { RosProjectionStatusResponse } from "./ros-projection-status.js";

const SESSION_TOKEN = "s".repeat(32);
const COOKIE = `fantasy_session=${SESSION_TOKEN}`;

function authenticatedService(): AuthService {
  const repository: AuthRepository = {
    findUserByEmail: () => Promise.resolve(undefined),
    createSession: () => Promise.resolve(),
    findSession: () =>
      Promise.resolve({
        user: {
          id: "10000000-0000-4000-8000-000000000001",
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

function port(overrides: Partial<RosProjectionStatusPort>): RosProjectionStatusPort {
  return overrides as RosProjectionStatusPort;
}

async function appWith(rosProjectionStatus?: RosProjectionStatusPort) {
  return buildApp({
    environment: loadEnvironment({ NODE_ENV: "test" }),
    logger: false,
    requireAuthentication: true,
    authService: authenticatedService(),
    ...(rosProjectionStatus ? { rosProjectionStatus } : {}),
  });
}

describe("ROS projection status routes", () => {
  it("requires a session", async () => {
    const getStatus = vi.fn();
    const app = await appWith(port({ getStatus }));
    const denied = await app.inject({ method: "GET", url: "/v1/projections/ros-status" });
    expect(denied.statusCode).toBe(401);
    expect(getStatus).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns 503 when the status port is not configured", async () => {
    const app = await appWith(undefined);
    const response = await app.inject({
      method: "GET",
      url: "/v1/projections/ros-status",
      headers: { cookie: COOKIE },
    });
    expect(response.statusCode).toBe(503);
    await app.close();
  });

  const profile = {
    profileId: "laces-out-historical-ros-full-ppr",
    label: "Full PPR",
    scoringProfileKey: rosScoringProfile("full-ppr").scoringProfileKey,
    digest: rosScoringProfile("full-ppr").digest,
  };

  function emptyStatus(season: number): RosProjectionStatusResponse {
    return {
      season,
      modelVersion: FIRST_PARTY_ROS_MODEL_VERSION,
      admittedArtifacts: { state: "none", artifacts: [] },
      scoringProfiles: { supported: [], unsupported: [] },
      leagueReadiness: [
        {
          leagueSeasonId: null,
          state: "withheld",
          reasons: ["no-league-synced"],
          scoringProfile: null,
          positions: [],
        },
      ],
      cellGates: { state: "none", evaluatedAt: null, cells: [] },
      publishedSets: [],
      shadowAudit: { state: "none", latestRun: null },
    };
  }

  it("reports separated facts with no artifact and no runs", async () => {
    const getStatus = vi.fn(() => Promise.resolve(emptyStatus(2026)));
    const app = await appWith(port({ getStatus }));
    const response = await app.inject({
      method: "GET",
      url: "/v1/projections/ros-status?season=2026",
      headers: { cookie: COOKIE },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      season: 2026,
      admittedArtifacts: { state: "none", artifacts: [] },
      cellGates: { state: "none" },
      shadowAudit: { state: "none" },
      publishedSets: [],
    });
    expect(body).not.toHaveProperty("publication");
    expect(getStatus).toHaveBeenCalledWith({
      season: 2026,
      userId: "10000000-0000-4000-8000-000000000001",
    });
    await app.close();
  });

  it("defaults the season to the current UTC year", async () => {
    const year = new Date().getUTCFullYear();
    const getStatus = vi.fn(() => Promise.resolve(emptyStatus(year)));
    const app = await appWith(port({ getStatus }));
    const response = await app.inject({
      method: "GET",
      url: "/v1/projections/ros-status",
      headers: { cookie: COOKIE },
    });
    expect(response.statusCode).toBe(200);
    expect(getStatus).toHaveBeenCalledWith({
      season: year,
      userId: "10000000-0000-4000-8000-000000000001",
    });
    await app.close();
  });

  it("keeps a degraded shadow audit separate from an admitted, release-capable artifact", async () => {
    const status: RosProjectionStatusResponse = {
      ...emptyStatus(2026),
      admittedArtifacts: {
        state: "admitted",
        artifacts: [
          {
            scoringProfile: profile,
            season: 2026,
            modelVersion: FIRST_PARTY_ROS_MODEL_VERSION,
            policyVersion: "policy-v1",
            calibrationVersion: "calibration-v1",
            evidenceThroughSeason: 2025,
            artifactChecksum: "a".repeat(64),
            admittedAt: "2026-07-01T00:00:00.000Z",
            sourceChecksumCount: 42,
          },
        ],
      },
      scoringProfiles: { supported: [profile], unsupported: [] },
      shadowAudit: {
        state: "recorded",
        latestRun: {
          sourceSyncRunId: "20000000-0000-4000-8000-000000000001",
          mode: "shadow",
          qualityState: "degraded",
          createdAt: "2026-10-10T01:00:00.000Z",
          reasons: ["weekly_projection_window_incomplete", "shadow_publication_disabled"],
        },
      },
    };
    const getStatus = vi.fn(() => Promise.resolve(status));
    const app = await appWith(port({ getStatus }));
    const response = await app.inject({
      method: "GET",
      url: "/v1/projections/ros-status?season=2026",
      headers: { cookie: COOKIE },
    });
    expect(response.statusCode).toBe(200);
    // The degraded audit must not downgrade the admitted artifact: both facts are reported.
    expect(response.json()).toMatchObject({
      admittedArtifacts: { state: "admitted", artifacts: [{ artifactChecksum: "a".repeat(64) }] },
      shadowAudit: { state: "recorded", latestRun: { qualityState: "degraded" } },
    });
    await app.close();
  });

  it("reports mixed cell gates, a retained set, and per-league withholding reasons", async () => {
    const status: RosProjectionStatusResponse = {
      ...emptyStatus(2026),
      leagueReadiness: [
        {
          leagueSeasonId: "40000000-0000-4000-8000-000000000001",
          state: "ready",
          reasons: [],
          scoringProfile: profile,
          positions: [],
        },
        {
          leagueSeasonId: "40000000-0000-4000-8000-000000000002",
          state: "withheld",
          reasons: ["no-admitted-scoring-profile", "incomplete-schedule"],
          scoringProfile: null,
          positions: [],
        },
      ],
      cellGates: {
        state: "evaluated",
        evaluatedAt: "2026-10-10T01:00:00.000Z",
        cells: [
          { position: "RB", bucket: "one-to-four", decision: "released", reasons: [] },
          {
            position: "K",
            bucket: "one-to-four",
            decision: "withheld",
            reasons: ["interval-coverage-gate-failed"],
          },
        ],
      },
      publishedSets: [
        {
          projectionSetId: "30000000-0000-4000-8000-000000000001",
          leagueSeasonId: "40000000-0000-4000-8000-000000000001",
          scoringProfile: profile,
          season: 2026,
          playerCount: 213,
          windowStartWeek: 6,
          windowEndWeek: 18,
          asOfWeek: 5,
          fetchedAt: "2026-10-10T01:00:00.000Z",
          inputChecksum: "d".repeat(64),
          championArtifactChecksum: "a".repeat(64),
          retainedFromEarlierRun: true,
        },
      ],
    };
    const getStatus = vi.fn(() => Promise.resolve(status));
    const app = await appWith(port({ getStatus }));
    const response = await app.inject({
      method: "GET",
      url: "/v1/projections/ros-status?season=2026",
      headers: { cookie: COOKIE },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      leagueReadiness: [
        { state: "ready", reasons: [] },
        { state: "withheld", reasons: ["no-admitted-scoring-profile", "incomplete-schedule"] },
      ],
      cellGates: { cells: [{ decision: "released" }, { decision: "withheld" }] },
      publishedSets: [{ playerCount: 213, retainedFromEarlierRun: true }],
    });
    await app.close();
  });

  it("rejects an out-of-range season", async () => {
    const getStatus = vi.fn();
    const app = await appWith(port({ getStatus }));
    const response = await app.inject({
      method: "GET",
      url: "/v1/projections/ros-status?season=1999",
      headers: { cookie: COOKIE },
    });
    expect(response.statusCode).toBe(400);
    expect(getStatus).not.toHaveBeenCalled();
    await app.close();
  });

  /**
   * This endpoint previously returned every league's projection set to any authenticated user.
   * The fix scopes the read to the caller's own memberships, and these tests pin the half of that
   * fix which lives at the route: the identity comes from the session and a caller cannot name
   * whose leagues to read. The membership join itself is exercised by a PostgreSQL-backed test.
   */
  it("reads for the authenticated session user, not a caller-supplied identity", async () => {
    const getStatus = vi.fn(() => Promise.resolve(emptyStatus(2026)));
    const app = await appWith(port({ getStatus }));
    const response = await app.inject({
      method: "GET",
      url: "/v1/projections/ros-status?season=2026",
      headers: { cookie: COOKIE },
    });

    expect(response.statusCode).toBe(200);
    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(getStatus).toHaveBeenCalledWith({
      season: 2026,
      userId: "10000000-0000-4000-8000-000000000001",
    });
    await app.close();
  });

  it("rejects a client-supplied userId outright rather than ignoring it", async () => {
    const getStatus = vi.fn(() => Promise.resolve(emptyStatus(2026)));
    const app = await appWith(port({ getStatus }));
    const response = await app.inject({
      method: "GET",
      url: "/v1/projections/ros-status?season=2026&userId=10000000-0000-4000-8000-000000000999",
      headers: { cookie: COOKIE },
    });

    // The query schema is strict, so an attempt to name a different user fails the request
    // instead of being silently dropped. That is the stronger of the two behaviors: the caller
    // gets no signal that the parameter was even considered.
    expect(response.statusCode).toBe(400);
    expect(getStatus).not.toHaveBeenCalled();
    await app.close();
  });
});
