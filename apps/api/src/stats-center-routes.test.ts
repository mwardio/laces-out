import { loadEnvironment } from "@fantasy/config";
import type { StatsCenterPlayerDetailResponse, StatsCenterResponse } from "@fantasy/contracts";
import { describe, expect, it, vi } from "vitest";

import { buildApp } from "./app.js";
import { AuthService, type AuthRepository } from "./auth.js";
import { resolveWeekRange } from "./stats-center-routes.js";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const PLAYER_ID = "10000000-0000-4000-8000-00000000000a";
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
    weekFrom: 4,
    weekTo: 4,
    position: "WR",
    team: null,
    search: "brown",
    sort: "targets",
    scoring: "ppr",
    recentWindow: 4,
    recentWeightDecay: 0.75,
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
  metrics: [
    {
      id: "recYards",
      label: "Receiving yards",
      family: "production",
      kind: "additive",
      definition: "Sum of stored receiving yards across the included games.",
      state: "available",
      reason: null,
    },
  ],
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
    recentTrend: "Recent trend weights the newest weeks most heavily.",
    boomBust: "Boom and bust use the source dataset's own PPR points.",
  },
};

const emptyMetricValues = {
  passCompletions: null,
  passAttempts: null,
  passYards: null,
  passTouchdowns: null,
  passInterceptions: null,
  rushYards: null,
  rushTouchdowns: null,
  receptions: null,
  recYards: null,
  recTouchdowns: null,
  fumblesLost: null,
  pointsStandard: null,
  pointsPpr: null,
  passAirYards: null,
  passYardsAfterCatch: null,
  passEpa: null,
  rushEpa: null,
  recAirYards: null,
  recYardsAfterCatch: null,
  recEpa: null,
} as const;

const withheldTrend = {
  status: "unavailable",
  seasonAverage: null,
  recentWeightedAverage: null,
  absoluteChange: null,
  sampleSize: 0,
  recentSampleSize: 0,
  reason: "No rows.",
} as const;

const detailResponse: StatsCenterPlayerDetailResponse = {
  generatedAt: "2026-07-21T12:00:00.000Z",
  filters: { ...response.filters, weekFrom: null, weekTo: null, position: null, search: "" },
  player: {
    playerId: PLAYER_ID,
    name: "Steady Runner",
    position: "RB",
    team: "AAA",
    status: "active",
    rookieSeason: 2023,
  },
  availability: response.availability,
  metrics: response.metrics,
  summary: {
    playerId: PLAYER_ID,
    name: "Steady Runner",
    position: "RB",
    team: "AAA",
    games: 0,
    snapGames: 0,
    targets: null,
    carries: null,
    opportunities: null,
    targetsPerGame: null,
    carriesPerGame: null,
    opportunitiesPerGame: null,
    targetShare: null,
    offensiveSnaps: null,
    offensiveSnapShare: null,
    totals: { ...emptyMetricValues },
    perGame: { ...emptyMetricValues },
    ratios: {
      passAirConversionRatio: null,
      airYardsShare: null,
      weightedOpportunityRating: null,
      completionPercentageOverExpected: null,
    },
    trend: {
      targetsPerGame: withheldTrend,
      carriesPerGame: withheldTrend,
      opportunitiesPerGame: withheldTrend,
      targetShare: withheldTrend,
      offensiveSnapShare: withheldTrend,
      fantasyPoints: withheldTrend,
    },
    boomBust: {
      status: "unavailable",
      games: 0,
      missingGames: 0,
      booms: null,
      busts: null,
      neutral: null,
      boomRate: null,
      bustRate: null,
      averagePoints: null,
      standardDeviation: null,
      threshold: null,
      reason: "No rows.",
    },
  },
  gameLog: [],
  sources: response.sources,
  definitions: response.definitions,
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

  it("orders a reversed week range instead of returning nothing", () => {
    expect(resolveWeekRange({ weekFrom: 9, weekTo: 4 })).toEqual({ weekFrom: 4, weekTo: 9 });
    expect(resolveWeekRange({ week: 6 })).toEqual({ weekFrom: 6, weekTo: 6 });
    expect(resolveWeekRange({ weekFrom: 5 })).toEqual({ weekFrom: 5, weekTo: null });
    expect(resolveWeekRange({})).toEqual({ weekFrom: null, weekTo: null });
  });

  it("forwards a week range, team, scoring, and trend window to the service", async () => {
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
      url: "/v1/stats/players?season=2025&weekFrom=5&weekTo=9&team=det&scoring=standard&recentWindow=3&recentWeightDecay=0.5&sort=recEpa",
      headers: { cookie: COOKIE },
    });

    expect(result.statusCode).toBe(200);
    expect(getPlayers).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({
        weekFrom: 5,
        weekTo: 9,
        team: "DET",
        scoring: "standard",
        recentWindow: 3,
        recentWeightDecay: 0.5,
        sort: "recEpa",
      }),
    );
    await app.close();
  });

  it("rejects a team filter that is not a team abbreviation", async () => {
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
      url: "/v1/stats/players?team=not-a-team",
      headers: { cookie: COOKIE },
    });

    expect(result.statusCode).toBe(400);
    expect(getPlayers).not.toHaveBeenCalled();
    await app.close();
  });

  it("serves a player profile and 404s an unknown identity", async () => {
    const getPlayers = vi.fn(() => Promise.resolve(response));
    const getPlayer = vi.fn((_userId: string, playerId: string) =>
      Promise.resolve(playerId === PLAYER_ID ? detailResponse : undefined),
    );
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authenticatedService(),
      statsCenter: { getPlayers, getPlayer },
    });

    const found = await app.inject({
      method: "GET",
      url: `/v1/stats/players/${PLAYER_ID}?season=2025`,
      headers: { cookie: COOKIE },
    });
    expect(found.statusCode).toBe(200);
    expect(found.json()).toMatchObject({ player: { playerId: PLAYER_ID } });

    const missing = await app.inject({
      method: "GET",
      url: "/v1/stats/players/10000000-0000-4000-8000-0000000000ff",
      headers: { cookie: COOKIE },
    });
    expect(missing.statusCode).toBe(404);

    const malformed = await app.inject({
      method: "GET",
      url: "/v1/stats/players/not-a-uuid",
      headers: { cookie: COOKIE },
    });
    expect(malformed.statusCode).toBe(400);
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
