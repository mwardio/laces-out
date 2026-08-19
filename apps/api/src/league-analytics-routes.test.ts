import { loadEnvironment } from "@laces-out/config";
import type { LeagueAnalyticsSnapshot } from "@laces-out/contracts";
import { describe, expect, it, vi } from "vitest";

import { buildApp } from "./app.js";
import { AuthService, type AuthRepository } from "./auth.js";
import type { LeagueAnalyticsPort } from "./league-analytics-routes.js";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const LEAGUE_ID = "20000000-0000-4000-8000-000000000001";
const SESSION_TOKEN = "a".repeat(32);
const COOKIE = `fantasy_session=${SESSION_TOKEN}`;
const NOW = "2026-09-16T12:00:00.000Z";

const noSeasonReason = {
  code: "NO_SEASON" as const,
  message: "Connect and synchronize a league season before running analytics.",
};

const snapshot: LeagueAnalyticsSnapshot = {
  generatedAt: NOW,
  league: {
    id: LEAGUE_ID,
    name: "Laces Out League",
    season: null,
    currentWeek: null,
    provider: null,
  },
  membership: {
    role: "member",
    claimedTeamId: null,
    claimedTeamName: null,
  },
  provenance: {
    leagueLastSyncedAt: null,
    latestMatchupObservedAt: null,
    matchupFreshness: { state: "missing", observedAt: null, label: "No matchup snapshot" },
    matchupObservationsRead: 0,
    deduplicatedMatchups: 0,
    projectionSet: null,
    projectionFreshness: { state: "missing", observedAt: null, label: "No projection import" },
  },
  coverage: {
    leagueTeams: 0,
    teamsWithLatestRoster: 0,
    rosterPlayers: 0,
    rosterPlayersProjected: 0,
    officialScoreWeeks: 0,
  },
  scores: { state: "unavailable", reasons: [noSeasonReason] },
  power: { state: "unavailable", reasons: [noSeasonReason] },
  positional: { state: "unavailable", reasons: [noSeasonReason] },
  opponentScout: { state: "unavailable", reasons: [noSeasonReason] },
  weeklyAwards: { state: "unavailable", reasons: [noSeasonReason] },
  weeklyAwardWeeks: [],
  playoffOdds: { state: "unavailable", reasons: [noSeasonReason] },
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

describe("league analytics route", () => {
  it("requires authentication and scopes the service call to the current user", async () => {
    const getSnapshot = vi.fn(() => Promise.resolve(snapshot));
    const analytics: LeagueAnalyticsPort = { getSnapshot };
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authenticatedService(),
      analytics,
    });

    const denied = await app.inject({
      method: "GET",
      url: `/v1/leagues/${LEAGUE_ID}/analytics`,
    });
    expect(denied.statusCode).toBe(401);
    expect(getSnapshot).not.toHaveBeenCalled();

    const response = await app.inject({
      method: "GET",
      url: `/v1/leagues/${LEAGUE_ID}/analytics`,
      headers: { cookie: COOKIE },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      league: { id: LEAGUE_ID },
      scores: { state: "unavailable", reasons: [{ code: "NO_SEASON" }] },
    });
    expect(getSnapshot).toHaveBeenCalledWith(USER_ID, LEAGUE_ID);
    await app.close();
  });

  it("does not reveal whether an inaccessible league exists", async () => {
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authenticatedService(),
      analytics: { getSnapshot: () => Promise.resolve(undefined) },
    });
    const response = await app.inject({
      method: "GET",
      url: `/v1/leagues/${LEAGUE_ID}/analytics`,
      headers: { cookie: COOKIE },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ title: "League not found" });
    await app.close();
  });
});
