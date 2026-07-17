import { loadEnvironment } from "@fantasy/config";
import type { InSeasonDecisionSnapshot } from "@fantasy/contracts";
import { describe, expect, it, vi } from "vitest";

import { buildApp } from "./app.js";
import { AuthService, type AuthRepository } from "./auth.js";
import type { InSeasonDecisionPort } from "./in-season-decision-routes.js";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const LEAGUE_ID = "20000000-0000-4000-8000-000000000001";
const SESSION_TOKEN = "d".repeat(32);
const COOKIE = `fantasy_session=${SESSION_TOKEN}`;
const NOW = "2026-09-15T12:00:00.000Z";

const unavailableSnapshot: InSeasonDecisionSnapshot = {
  generatedAt: NOW,
  league: {
    id: LEAGUE_ID,
    name: "Fourth and Long",
    season: 2026,
    week: 2,
    provider: "espn",
  },
  team: null,
  provenance: {
    leagueLastSyncedAt: NOW,
    rosterEffectiveAt: null,
    projectionSet: null,
    projectionFreshness: { state: "missing", observedAt: null, label: "No projection set" },
  },
  providerVerification: {
    lockCoverage: "unavailable",
    storedTrueLocksHonored: true,
    storedFalseMeansUnlocked: false,
    storedLockedPlayerCount: 0,
    actionWarning: "Verify locks and transactions on ESPN. Laces Out cannot execute them.",
  },
  coverage: {
    leagueTeams: 0,
    teamsWithRosters: 0,
    leagueRosteredPlayers: 0,
    claimedRosterPlayers: 0,
    claimedRosterProjected: 0,
    claimedRosterProjectionRatio: 0,
    projectionSetPlayers: 0,
    projectionQueryLimited: false,
  },
  lineup: {
    state: "unavailable",
    reasons: [{ code: "TEAM_UNCLAIMED", message: "Claim your fantasy team first." }],
  },
  waivers: {
    state: "unavailable",
    reasons: [{ code: "TEAM_UNCLAIMED", message: "Claim your fantasy team first." }],
  },
  trades: {
    state: "unavailable",
    reasons: [{ code: "TEAM_UNCLAIMED", message: "Claim your fantasy team first." }],
  },
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

describe("in-season decision route", () => {
  it("requires authentication and passes only the current member identity to the service", async () => {
    const getSnapshot = vi.fn(() => Promise.resolve(unavailableSnapshot));
    const decisions: InSeasonDecisionPort = { getSnapshot };
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authenticatedService(),
      decisions,
    });

    const denied = await app.inject({
      method: "GET",
      url: `/v1/leagues/${LEAGUE_ID}/decisions`,
    });
    expect(denied.statusCode).toBe(401);
    expect(getSnapshot).not.toHaveBeenCalled();

    const response = await app.inject({
      method: "GET",
      url: `/v1/leagues/${LEAGUE_ID}/decisions`,
      headers: { cookie: COOKIE },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      league: { id: LEAGUE_ID },
      lineup: { state: "unavailable", reasons: [{ code: "TEAM_UNCLAIMED" }] },
    });
    expect(getSnapshot).toHaveBeenCalledWith(USER_ID, LEAGUE_ID);
    await app.close();
  });

  it("does not reveal whether an inaccessible league exists", async () => {
    const decisions: InSeasonDecisionPort = {
      getSnapshot: () => Promise.resolve(undefined),
    };
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authenticatedService(),
      decisions,
    });
    const response = await app.inject({
      method: "GET",
      url: `/v1/leagues/${LEAGUE_ID}/decisions`,
      headers: { cookie: COOKIE },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ title: "League not found" });
    await app.close();
  });
});
