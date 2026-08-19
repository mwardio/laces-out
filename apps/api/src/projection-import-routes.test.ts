import { loadEnvironment } from "@laces-out/config";
import type {
  ProjectionPlayerListResponse,
  ProjectionImportCommitResponse,
  ProjectionImportPreviewResponse,
  ProjectionSetListResponse,
} from "@laces-out/contracts";
import { describe, expect, it, vi } from "vitest";

import { buildApp } from "./app.js";
import { AuthService, type AuthRepository } from "./auth.js";
import type { ProjectionImportPort } from "./projection-import-routes.js";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const LEAGUE_ID = "20000000-0000-4000-8000-000000000001";
const SEASON_ID = "30000000-0000-4000-8000-000000000001";
const SET_ID = "40000000-0000-4000-8000-000000000001";
const CHECKSUM = `sha256:${"a".repeat(64)}`;
const COOKIE = `fantasy_session=${"p".repeat(32)}`;
const SOURCE_OBSERVED_AT = "2026-09-10T11:55:00.000Z";

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

const setSummary = {
  id: SET_ID,
  leagueSeasonId: SEASON_ID,
  creatorUserId: USER_ID,
  creatorDisplayName: "League Guru",
  origin: "custom" as const,
  managed: null,
  visibility: "private" as const,
  sourceLabel: "Personal model",
  sourceFileName: "week-2.csv",
  season: 2026,
  week: 2,
  horizon: "week" as const,
  playerCount: 1,
  inputChecksum: CHECKSUM,
  sourceChecksum: CHECKSUM,
  sourceObservedAt: SOURCE_OBSERVED_AT,
  sourceObservedAtStatus: "verified" as const,
  importedAt: "2026-09-10T12:00:00.000Z",
  isOwnedByCurrentUser: true,
};

const listResponse: ProjectionSetListResponse = {
  league: {
    id: LEAGUE_ID,
    name: "Friends League",
    leagueSeasonId: SEASON_ID,
    provider: "espn",
    season: 2026,
    currentWeek: 2,
    membershipRole: "member",
    canShareLeague: false,
  },
  managedForecastStatus: {
    state: "pending",
    evaluatedAt: null,
    qualityState: null,
    reasons: [],
  },
  projectionSets: [setSummary],
};

const previewResponse: ProjectionImportPreviewResponse = {
  metadata: {
    season: 2026,
    week: 2,
    horizon: "week",
    sourceLabel: "Personal model",
    sourceObservedAt: SOURCE_OBSERVED_AT,
  },
  visibility: "private",
  sourceChecksum: CHECKSUM,
  importChecksum: CHECKSUM,
  rowCount: 1,
  resolvedRowCount: 1,
  diagnostics: [],
  canCommit: true,
};

const commitResponse: ProjectionImportCommitResponse = {
  projectionSet: setSummary,
  deduplicated: false,
};

const playerListResponse: ProjectionPlayerListResponse = {
  projectionSet: setSummary,
  players: [
    {
      playerId: "50000000-0000-4000-8000-000000000001",
      fullName: "Exact Runner",
      nflTeam: "CHI",
      primaryPosition: "RB",
      eligiblePositions: ["RB", "FLEX"],
      status: "ACTIVE",
      overallRank: 1,
      positionRank: 1,
      meanPoints: 18.25,
      floorPoints: 11,
      ceilingPoints: 27,
      confidence: 0.8,
      ros: null,
    },
  ],
};

function projectionPort(): ProjectionImportPort {
  return {
    list: vi.fn(() => Promise.resolve(listResponse)),
    getPlayers: vi.fn(() => Promise.resolve(playerListResponse)),
    preview: vi.fn(() => Promise.resolve(previewResponse)),
    commit: vi.fn(() => Promise.resolve(commitResponse)),
  };
}

describe("projection import routes", () => {
  it("requires authentication before any league-season projection read", async () => {
    const projections = projectionPort();
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authenticatedService(),
      projectionImports: projections,
    });

    const denied = await app.inject({
      method: "GET",
      url: `/v1/league-seasons/${SEASON_ID}/projections`,
    });
    expect(denied.statusCode).toBe(401);
    expect(projections.list).not.toHaveBeenCalled();

    const allowed = await app.inject({
      method: "GET",
      url: `/v1/league-seasons/${SEASON_ID}/projections`,
      headers: { cookie: COOKIE },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toMatchObject({ projectionSets: [{ id: SET_ID }] });
    expect(projections.list).toHaveBeenCalledWith(USER_ID, SEASON_ID);
    await app.close();
  });

  it("requires authentication and validated IDs for player-level projection rows", async () => {
    const projections = projectionPort();
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authenticatedService(),
      projectionImports: projections,
    });

    const denied = await app.inject({
      method: "GET",
      url: `/v1/league-seasons/${SEASON_ID}/projections/${SET_ID}/players`,
    });
    expect(denied.statusCode).toBe(401);
    expect(projections.getPlayers).not.toHaveBeenCalled();

    const allowed = await app.inject({
      method: "GET",
      url: `/v1/league-seasons/${SEASON_ID}/projections/${SET_ID}/players`,
      headers: { cookie: COOKIE },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toMatchObject({
      projectionSet: { id: SET_ID },
      players: [{ fullName: "Exact Runner", meanPoints: 18.25 }],
    });
    expect(projections.getPlayers).toHaveBeenCalledWith(USER_ID, SEASON_ID, SET_ID);

    const invalid = await app.inject({
      method: "GET",
      url: `/v1/league-seasons/${SEASON_ID}/projections/not-a-uuid/players`,
      headers: { cookie: COOKIE },
    });
    expect(invalid.statusCode).toBe(400);
    expect(projections.getPlayers).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("passes only validated bounded preview input and the authenticated actor", async () => {
    const projections = projectionPort();
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authenticatedService(),
      projectionImports: projections,
    });
    const body = {
      csv: "player_name,mean_points\nExact Runner,18",
      metadata: {
        season: 2026,
        week: 2,
        horizon: "week",
        sourceLabel: "Personal model",
        sourceObservedAt: SOURCE_OBSERVED_AT,
      },
      visibility: "private",
      sourceFileName: "week-2.csv",
    };
    const response = await app.inject({
      method: "POST",
      url: `/v1/league-seasons/${SEASON_ID}/projections/preview`,
      headers: { cookie: COOKIE },
      payload: body,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ canCommit: true, importChecksum: CHECKSUM });
    expect(projections.preview).toHaveBeenCalledWith(USER_ID, SEASON_ID, body);

    const invalid = await app.inject({
      method: "POST",
      url: `/v1/league-seasons/${SEASON_ID}/projections/preview`,
      headers: { cookie: COOKIE },
      payload: { ...body, untrustedNormalizedRows: [{ playerId: SET_ID }] },
    });
    expect(invalid.statusCode).toBe(400);
    expect(projections.preview).toHaveBeenCalledTimes(1);

    for (const metadata of [
      { ...body.metadata, horizon: "rest-of-season" },
      { ...body.metadata, sourceObservedAt: "2026-02-29T12:00:00.000Z" },
      { ...body.metadata, sourceObservedAt: undefined },
    ]) {
      const rejected = await app.inject({
        method: "POST",
        url: `/v1/league-seasons/${SEASON_ID}/projections/preview`,
        headers: { cookie: COOKIE },
        payload: { ...body, metadata },
      });
      expect(rejected.statusCode).toBe(400);
    }
    expect(projections.preview).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("requires a checksummed preview and returns create versus deduplicated status", async () => {
    const projections = projectionPort();
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authenticatedService(),
      projectionImports: projections,
    });
    const body = {
      csv: "player_name,mean_points\nExact Runner,18",
      metadata: {
        season: 2026,
        week: 2,
        horizon: "week",
        sourceLabel: "Personal model",
        sourceObservedAt: SOURCE_OBSERVED_AT,
      },
      visibility: "private",
      sourceFileName: null,
      expectedImportChecksum: CHECKSUM,
    };
    const created = await app.inject({
      method: "POST",
      url: `/v1/league-seasons/${SEASON_ID}/projections`,
      headers: { cookie: COOKIE },
      payload: body,
    });
    expect(created.statusCode).toBe(201);
    expect(projections.commit).toHaveBeenCalledWith(USER_ID, SEASON_ID, body);

    const deduplicatedPort = projectionPort();
    deduplicatedPort.commit = vi.fn(() =>
      Promise.resolve({ ...commitResponse, deduplicated: true }),
    );
    const deduplicatedApp = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authenticatedService(),
      projectionImports: deduplicatedPort,
    });
    const repeated = await deduplicatedApp.inject({
      method: "POST",
      url: `/v1/league-seasons/${SEASON_ID}/projections`,
      headers: { cookie: COOKIE },
      payload: body,
    });
    expect(repeated.statusCode).toBe(200);
    await app.close();
    await deduplicatedApp.close();
  });
});
