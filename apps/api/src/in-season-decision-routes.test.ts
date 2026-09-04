import { loadEnvironment } from "@laces-out/config";
import {
  inSeasonDecisionSnapshotSchema,
  type InSeasonDecisionSnapshot,
  type TradeEvaluationResponse,
} from "@laces-out/contracts";
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
    algorithmVersion: "in-season-decisions-v1",
    inputChecksum: "a".repeat(64),
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

const availableWaiverSnapshot: InSeasonDecisionSnapshot = {
  ...unavailableSnapshot,
  team: {
    id: "40000000-0000-4000-8000-000000000001",
    name: "The Snowflakes",
    faabRemaining: 82,
  },
  waivers: {
    state: "available",
    candidateCount: 24,
    evaluatedMoveCount: 312,
    recommendations: [
      {
        add: {
          id: "70000000-0000-4000-8000-000000000001",
          name: "Incoming Player",
          positions: ["WR"],
          nflTeam: "CHI",
          status: "ACTIVE",
          projectedPoints: 12.4,
        },
        drop: {
          id: "70000000-0000-4000-8000-000000000002",
          name: "Outgoing Player",
          positions: ["WR"],
          nflTeam: "DET",
          status: "ACTIVE",
          projectedPoints: 8.1,
        },
        weightedGain: 3.49,
        lineupGain: 1.2,
        faab: null,
        market: null,
        rationale: "Incoming Player for Outgoing Player improves the modeled roster.",
      },
    ],
    execution: {
      mode: "provider-required",
      provider: "espn",
      label: "Open ESPN to verify and apply manually",
      url: "https://fantasy.espn.com/football/league?leagueId=24681012",
    },
    notes: [],
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
    const decisions: InSeasonDecisionPort = {
      getSnapshot,
      evaluateBuiltTrade: () => Promise.resolve({ outcome: "not-found" as const }),
    };
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
      evaluateBuiltTrade: () => Promise.resolve({ outcome: "not-found" as const }),
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

  it("serializes the modeled drop and transaction-aware gains", async () => {
    const decisions: InSeasonDecisionPort = {
      getSnapshot: () => Promise.resolve(availableWaiverSnapshot),
      evaluateBuiltTrade: () => Promise.resolve({ outcome: "not-found" as const }),
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

    expect(response.statusCode).toBe(200);
    const body = inSeasonDecisionSnapshotSchema.parse(response.json());
    if (body.waivers.state !== "available") throw new Error("expected available waivers");
    expect(body.waivers.recommendations[0]).toMatchObject({
      add: { name: "Incoming Player", projectedPoints: 12.4 },
      drop: { name: "Outgoing Player", projectedPoints: 8.1 },
      weightedGain: 3.49,
      lineupGain: 1.2,
    });
    await app.close();
  });
});

const BUILDER_URL = `/v1/leagues/${LEAGUE_ID}/trade-evaluations`;
const TEAM_B_ID = "40000000-0000-4000-8000-000000000002";
const SEND_ID = "70000000-0000-4000-8000-000000000003";
const RECEIVE_ID = "70000000-0000-4000-8000-000000000004";
const validBody = {
  opponentTeamId: TEAM_B_ID,
  sendsPlayerIds: [SEND_ID],
  receivesPlayerIds: [RECEIVE_ID],
};

const illegalTradeEvaluationResponse: TradeEvaluationResponse = {
  state: "available",
  generatedAt: NOW,
  league: { id: LEAGUE_ID, name: "Fourth and Long" },
  algorithmVersion: "trade-builder-v1",
  inputChecksum: "b".repeat(64),
  legal: false,
  package: null,
  diagnostics: [
    {
      code: "NO_LEGAL_FORCED_DROP",
      message: "Team cannot make the required legal forced drops",
      teamId: "40000000-0000-4000-8000-000000000001",
      playerId: null,
    },
  ],
  horizons: [{ id: "60000000-0000-4000-8000-000000000001", label: "Week 2", weight: 1 }],
  rosUnavailable: null,
  provenance: {
    leagueLastSyncedAt: null,
    rosterEffectiveAt: null,
    projectionSet: {
      id: "60000000-0000-4000-8000-000000000001",
      source: "trusted-weekly-model",
      version: "2026-w02-v1",
      horizon: "Week 2",
      sourceObservedAt: null,
      sourceObservedAtStatus: "unverified",
      importedAt: "2026-09-15T11:00:00.000Z",
    },
    projectionFreshness: { state: "missing", observedAt: null, label: "No projection set" },
  },
  execution: {
    mode: "provider-required",
    provider: "manual",
    label: "Verify and apply manually in your league host",
    url: null,
  },
  notes: [],
};

async function builderApp(evaluateBuiltTrade: InSeasonDecisionPort["evaluateBuiltTrade"]) {
  return buildApp({
    environment: loadEnvironment({ NODE_ENV: "test" }),
    logger: false,
    requireAuthentication: true,
    authService: authenticatedService(),
    decisions: { getSnapshot: () => Promise.resolve(unavailableSnapshot), evaluateBuiltTrade },
  });
}

describe("trade builder route", () => {
  it("requires authentication before touching the service", async () => {
    const evaluateBuiltTrade = vi.fn(() => Promise.resolve({ outcome: "not-found" as const }));
    const app = await builderApp(evaluateBuiltTrade);

    const denied = await app.inject({ method: "POST", url: BUILDER_URL, payload: validBody });
    expect(denied.statusCode).toBe(401);
    expect(evaluateBuiltTrade).not.toHaveBeenCalled();
    await app.close();
  });

  it("gives a nonmember the same 404 as an unknown league", async () => {
    const app = await builderApp(() => Promise.resolve({ outcome: "not-found" as const }));
    const response = await app.inject({
      method: "POST",
      url: BUILDER_URL,
      headers: { cookie: COOKIE },
      payload: validBody,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      type: "https://fantasy.local/problems/league-not-found",
      title: "League not found",
      status: 404,
    });
    await app.close();
  });

  it("passes only the authenticated identity and the parsed body to the service", async () => {
    const evaluateBuiltTrade = vi.fn(() => Promise.resolve({ outcome: "not-found" as const }));
    const app = await builderApp(evaluateBuiltTrade);
    await app.inject({
      method: "POST",
      url: BUILDER_URL,
      headers: { cookie: COOKIE },
      payload: validBody,
    });

    expect(evaluateBuiltTrade).toHaveBeenCalledWith(USER_ID, LEAGUE_ID, validBody);
    await app.close();
  });

  it("rejects more than four players on a side without calling the service", async () => {
    const evaluateBuiltTrade = vi.fn(() => Promise.resolve({ outcome: "not-found" as const }));
    const app = await builderApp(evaluateBuiltTrade);
    const response = await app.inject({
      method: "POST",
      url: BUILDER_URL,
      headers: { cookie: COOKIE },
      payload: {
        ...validBody,
        sendsPlayerIds: [
          "70000000-0000-4000-8000-000000000001",
          "70000000-0000-4000-8000-000000000002",
          "70000000-0000-4000-8000-000000000003",
          "70000000-0000-4000-8000-000000000004",
          "70000000-0000-4000-8000-000000000005",
        ],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ title: "Request validation failed" });
    expect(evaluateBuiltTrade).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects an unknown body field", async () => {
    const app = await builderApp(() => Promise.resolve({ outcome: "not-found" as const }));
    const response = await app.inject({
      method: "POST",
      url: BUILDER_URL,
      headers: { cookie: COOKIE },
      payload: { ...validBody, leagueId: LEAGUE_ID },
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("turns a rejected package into a 400 that names no player or roster", async () => {
    const app = await builderApp(() =>
      Promise.resolve({ outcome: "rejected" as const, code: "PLAYER_NOT_ON_ROSTER" as const }),
    );
    const response = await app.inject({
      method: "POST",
      url: BUILDER_URL,
      headers: { cookie: COOKIE },
      payload: validBody,
    });

    expect(response.statusCode).toBe(400);
    const body: unknown = response.json();
    expect(body).toMatchObject({
      type: "https://fantasy.local/problems/trade-package-invalid",
      title: "Trade package rejected",
      status: 400,
    });
    expect(JSON.stringify(body)).not.toContain(SEND_ID);
    expect(JSON.stringify(body)).not.toContain(RECEIVE_ID);
    await app.close();
  });

  it("returns 200 with the NO_LEGAL_FORCED_DROP diagnostic rather than an HTTP error", async () => {
    const app = await builderApp(() =>
      Promise.resolve({
        outcome: "evaluated" as const,
        response: illegalTradeEvaluationResponse,
      }),
    );
    const response = await app.inject({
      method: "POST",
      url: BUILDER_URL,
      headers: { cookie: COOKIE },
      payload: validBody,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      state: "available",
      legal: false,
      package: null,
      diagnostics: [{ code: "NO_LEGAL_FORCED_DROP" }],
    });
    await app.close();
  });
});
