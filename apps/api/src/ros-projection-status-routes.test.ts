import { loadEnvironment } from "@fantasy/config";
import { FIRST_PARTY_ROS_MODEL_VERSION } from "@fantasy/projections";
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

  it("reports fail-closed shadow state with no artifact and no runs", async () => {
    const status: RosProjectionStatusResponse = {
      season: 2026,
      modelVersion: FIRST_PARTY_ROS_MODEL_VERSION,
      publication: "fail-closed-shadow",
      artifact: { present: false },
      latestRun: null,
      publishedSets: [],
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
      season: 2026,
      publication: "fail-closed-shadow",
      artifact: { present: false },
      latestRun: null,
      publishedSets: [],
    });
    expect(getStatus).toHaveBeenCalledWith(2026);
    await app.close();
  });

  it("defaults the season to the current UTC year", async () => {
    const getStatus = vi.fn(() =>
      Promise.resolve({
        season: 2031,
        modelVersion: FIRST_PARTY_ROS_MODEL_VERSION,
        publication: "fail-closed-shadow",
        artifact: { present: false },
        latestRun: null,
        publishedSets: [],
      } satisfies RosProjectionStatusResponse),
    );
    const app = await appWith(port({ getStatus }));
    const response = await app.inject({
      method: "GET",
      url: "/v1/projections/ros-status",
      headers: { cookie: COOKIE },
    });
    expect(response.statusCode).toBe(200);
    expect(getStatus).toHaveBeenCalledWith(new Date().getUTCFullYear());
    await app.close();
  });

  it("surfaces degraded reasons when an artifact is present but the run is degraded", async () => {
    const status: RosProjectionStatusResponse = {
      season: 2026,
      modelVersion: FIRST_PARTY_ROS_MODEL_VERSION,
      publication: "fail-closed-shadow",
      artifact: {
        present: true,
        season: 2026,
        scoringProfileKey: "ppr-standard",
        modelVersion: FIRST_PARTY_ROS_MODEL_VERSION,
        policyVersion: "policy-v1",
        calibrationVersion: "calibration-v1",
        evidenceThroughSeason: 2025,
        artifactChecksum: "a".repeat(64),
        sourceChecksums: [{ key: "nflverse.schedules.2026", checksum: "b".repeat(64) }],
        admittedAt: "2026-07-01T00:00:00.000Z",
      },
      latestRun: {
        sourceSyncRunId: "20000000-0000-4000-8000-000000000001",
        mode: "shadow",
        qualityState: "degraded",
        canPublish: false,
        season: 2026,
        windowStartWeek: 6,
        windowEndWeek: 18,
        asOfWeek: 5,
        asOfAt: "2026-10-10T00:00:00.000Z",
        playersEvaluated: 0,
        playersPublished: 0,
        reasons: ["weekly_projection_window_incomplete", "shadow_publication_disabled"],
        evidenceGate: { cleared: false },
        inputChecksum: "c".repeat(64),
        sourceAsOf: "2026-10-09T00:00:00.000Z",
        createdAt: "2026-10-10T01:00:00.000Z",
      },
      publishedSets: [],
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
      publication: "fail-closed-shadow",
      artifact: { present: true, artifactChecksum: "a".repeat(64) },
      latestRun: {
        canPublish: false,
        reasons: ["weekly_projection_window_incomplete", "shadow_publication_disabled"],
      },
    });
    await app.close();
  });

  it("reports published set counts and provenance when a release exists", async () => {
    const status: RosProjectionStatusResponse = {
      season: 2026,
      modelVersion: FIRST_PARTY_ROS_MODEL_VERSION,
      publication: "publishable",
      artifact: { present: false },
      latestRun: null,
      publishedSets: [
        {
          projectionSetId: "30000000-0000-4000-8000-000000000001",
          leagueSeasonId: "40000000-0000-4000-8000-000000000001",
          source: "laces-out-first-party-ros",
          version: "v-checksum",
          season: 2026,
          playerCount: 213,
          windowStartWeek: 6,
          windowEndWeek: 18,
          asOfWeek: 5,
          asOfAt: "2026-10-10T00:00:00.000Z",
          fetchedAt: "2026-10-10T01:00:00.000Z",
          inputChecksum: "d".repeat(64),
          championArtifactChecksum: "a".repeat(64),
          scoringProfileKey: "ppr-standard",
          createdAt: "2026-10-10T01:00:00.000Z",
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
      publication: "publishable",
      publishedSets: [
        {
          playerCount: 213,
          championArtifactChecksum: "a".repeat(64),
          scoringProfileKey: "ppr-standard",
        },
      ],
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
});
