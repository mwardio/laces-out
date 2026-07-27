import { loadEnvironment } from "@fantasy/config";
import type { ScheduleEdgeMatrixResponse, ScheduleEdgeResponse } from "@fantasy/contracts";
import { describe, expect, it, vi } from "vitest";

import { buildApp } from "./app.js";
import { AuthService, type AuthRepository } from "./auth.js";
import type { ScheduleEdgePort } from "./schedule-edge-routes.js";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const LEAGUE_ID = "20000000-0000-4000-8000-000000000001";
const SEASON_ID = "30000000-0000-4000-8000-000000000001";
const SESSION_TOKEN = "a".repeat(32);
const COOKIE = `fantasy_session=${SESSION_TOKEN}`;
const NOW = "2026-09-16T12:00:00.000Z";
const HASH = "a".repeat(64);

const availability = { state: "available" as const, reason: null };
const definitions = {
  matchup: "Matchup definition.",
  scheduleStrength: "Schedule strength definition.",
  confidence: "Confidence definition.",
  byeFeasibility: "Bye feasibility definition.",
};

const memberResponse: ScheduleEdgeResponse = {
  generatedAt: NOW,
  algorithm: {
    version: "schedule-edge-v1",
    inputHash: HASH,
    evidenceChecksum: HASH,
    validationStatus: "descriptive-only",
  },
  league: {
    id: LEAGUE_ID,
    leagueSeasonId: SEASON_ID,
    name: "Laces Out League",
    provider: "espn",
    season: 2026,
    currentWeek: 3,
    claimedTeam: null,
  },
  windows: {
    selected: { startWeek: 3, endWeek: 6, label: "Weeks 3–6", source: "current-week" },
    playoff: { startWeek: 15, endWeek: 17, label: "Weeks 15–17", source: "fallback" },
  },
  availability: {
    schedule: availability,
    scoring: availability,
    matchups: availability,
    roster: { state: "unavailable", reason: "Claim a team first." },
    projections: { state: "unavailable", reason: "Claim a team first." },
    byeFeasibility: { state: "unavailable", reason: "Claim a team first." },
  },
  scoring: { profileKeyHash: HASH, warnings: [] },
  findings: [],
  roster: [],
  byeWeeks: [],
  sources: [],
  definitions,
};

const matrixResponse: ScheduleEdgeMatrixResponse = {
  generatedAt: NOW,
  algorithm: {
    version: "schedule-edge-v1",
    inputHash: HASH,
    evidenceChecksum: HASH,
    validationStatus: "descriptive-only",
  },
  league: {
    id: LEAGUE_ID,
    leagueSeasonId: SEASON_ID,
    name: "Laces Out League",
    season: 2026,
  },
  windows: memberResponse.windows,
  availability: {
    schedule: availability,
    scoring: availability,
    matchups: availability,
  },
  scoring: { profileKeyHash: HASH, warnings: [] },
  teams: [],
  sources: [],
  definitions,
};

function authenticatedService(): AuthService {
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

describe("schedule edge routes", () => {
  it("requires authentication and passes bounded windows to the member service", async () => {
    const getRosterEdge = vi.fn(() => Promise.resolve(memberResponse));
    const scheduleEdge: ScheduleEdgePort = {
      getRosterEdge,
      getMatrix: () => Promise.resolve(matrixResponse),
    };
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authenticatedService(),
      scheduleEdge,
    });

    const denied = await app.inject({
      method: "GET",
      url: `/v1/leagues/${LEAGUE_ID}/schedule-edge`,
    });
    expect(denied.statusCode).toBe(401);
    expect(getRosterEdge).not.toHaveBeenCalled();

    const response = await app.inject({
      method: "GET",
      url: `/v1/leagues/${LEAGUE_ID}/schedule-edge?startWeek=4&endWeek=8&playoffStartWeek=15&playoffEndWeek=17`,
      headers: { cookie: COOKIE },
    });
    expect(response.statusCode).toBe(200);
    expect(getRosterEdge).toHaveBeenCalledWith(USER_ID, LEAGUE_ID, {
      startWeek: 4,
      endWeek: 8,
      playoffStartWeek: 15,
      playoffEndWeek: 17,
    });
    await app.close();
  });

  it("keeps unknown and inaccessible leagues indistinguishable", async () => {
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authenticatedService(),
      scheduleEdge: {
        getRosterEdge: () => Promise.resolve(undefined),
        getMatrix: () => Promise.resolve(undefined),
      },
    });

    for (const suffix of ["", "/matrix"]) {
      const response = await app.inject({
        method: "GET",
        url: `/v1/leagues/${LEAGUE_ID}/schedule-edge${suffix}`,
        headers: { cookie: COOKIE },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ title: "League not found" });
    }
    await app.close();
  });

  it("rejects inverted and out-of-range windows before calling the service", async () => {
    const getMatrix = vi.fn(() => Promise.resolve(matrixResponse));
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authenticatedService(),
      scheduleEdge: {
        getRosterEdge: () => Promise.resolve(memberResponse),
        getMatrix,
      },
    });

    const inverted = await app.inject({
      method: "GET",
      url: `/v1/leagues/${LEAGUE_ID}/schedule-edge/matrix?startWeek=9&endWeek=4`,
      headers: { cookie: COOKIE },
    });
    expect(inverted.statusCode).toBe(400);

    const outOfRange = await app.inject({
      method: "GET",
      url: `/v1/leagues/${LEAGUE_ID}/schedule-edge/matrix?startWeek=0`,
      headers: { cookie: COOKIE },
    });
    expect(outOfRange.statusCode).toBe(400);
    expect(getMatrix).not.toHaveBeenCalled();
    await app.close();
  });
});
