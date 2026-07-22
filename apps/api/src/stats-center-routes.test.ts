import { loadEnvironment } from "@fantasy/config";
import type { StatsCenterResponse } from "@fantasy/contracts";
import { describe, expect, it, vi } from "vitest";

import { buildApp } from "./app.js";
import { AuthService, type AuthRepository } from "./auth.js";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const SESSION_TOKEN = "s".repeat(32);
const COOKIE = `fantasy_session=${SESSION_TOKEN}`;

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

const response: StatsCenterResponse = {
  generatedAt: "2026-07-21T12:00:00.000Z",
  filters: {
    season: 2025,
    week: 4,
    position: "WR",
    search: "brown",
    sort: "targets",
    limit: 25,
  },
  availability: {
    targets: { state: "available", reason: null },
    carries: { state: "available", reason: null },
    opportunities: { state: "available", reason: null },
    targetShare: { state: "available", reason: null },
    offensiveSnapShare: { state: "available", reason: null },
    redZone: { state: "unavailable", reason: "Red-zone observations are not stored." },
    boomBust: { state: "unavailable", reason: "Verified league scoring is required." },
    fantasyPointsAllowed: {
      state: "unavailable",
      reason: "Verified league scoring is required.",
    },
  },
  sources: [
    {
      dataset: "weekly-stats",
      state: "available",
      key: "nflverse.stats-player-week.2025",
      name: "Weekly player stats",
      attribution: "nflverse",
      attributionUrl: "https://github.com/nflverse/nflverse-data",
      fetchedAt: "2026-01-01T00:00:00.000Z",
      checksumSha256: "a".repeat(64),
      coveredWeeks: [1, 2, 3, 4],
      quality: { rowsRead: 100, rowsRejected: 0, rowsUnmatched: 0, matchRate: 1 },
      reason: null,
    },
    {
      dataset: "snap-counts",
      state: "available",
      key: "nflverse.snap-counts.2025",
      name: "Snap counts",
      attribution: "nflverse",
      attributionUrl: "https://github.com/nflverse/nflverse-data",
      fetchedAt: "2026-01-01T00:00:00.000Z",
      checksumSha256: "b".repeat(64),
      coveredWeeks: [1, 2, 3, 4],
      quality: { rowsRead: 100, rowsRejected: 0, rowsUnmatched: 0, matchRate: 1 },
      reason: null,
    },
  ],
  players: [],
  totalMatched: 0,
  truncated: false,
  definitions: {
    opportunities: "Opportunities equal carries plus targets.",
    targetShare: "Target share uses complete team-game target totals.",
    offensiveSnapShare: "Snap share is the mean game-level offensive share.",
  },
};

describe("Stats Center route", () => {
  it("requires authentication and forwards bounded filters with the actor", async () => {
    const getPlayers = vi.fn(() => Promise.resolve(response));
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authenticatedService(),
      statsCenter: { getPlayers },
    });

    const denied = await app.inject({ method: "GET", url: "/v1/stats/players?season=2025" });
    expect(denied.statusCode).toBe(401);
    expect(getPlayers).not.toHaveBeenCalled();

    const allowed = await app.inject({
      method: "GET",
      url: "/v1/stats/players?season=2025&week=4&position=wr&search=brown&sort=targets&limit=25",
      headers: { cookie: COOKIE },
    });
    expect(allowed.statusCode).toBe(200);
    expect(getPlayers).toHaveBeenCalledWith(USER_ID, response.filters);
    await app.close();
  });

  it("rejects unbounded result limits before calling the service", async () => {
    const getPlayers = vi.fn(() => Promise.resolve(response));
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authenticatedService(),
      statsCenter: { getPlayers },
    });
    const result = await app.inject({
      method: "GET",
      url: "/v1/stats/players?limit=1000",
      headers: { cookie: COOKIE },
    });
    expect(result.statusCode).toBe(400);
    expect(getPlayers).not.toHaveBeenCalled();
    await app.close();
  });
});
