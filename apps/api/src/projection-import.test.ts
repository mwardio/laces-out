import { describe, expect, it } from "vitest";
import { projectionSetListResponseSchema, projectionSetSummarySchema } from "@laces-out/contracts";

import {
  managedRunWithholdingScope,
  ProjectionImportService,
  type CommitProjectionSetInput,
  type ProjectionImportRepository,
  type ProjectionImportRequestError,
  type ProjectionLeagueScope,
  type ProjectionResolverPlayer,
  type StoredProjectionPlayer,
  type StoredProjectionSet,
} from "./projection-import.js";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_USER_ID = "10000000-0000-4000-8000-000000000002";
const LEAGUE_ID = "20000000-0000-4000-8000-000000000001";
const SEASON_ID = "30000000-0000-4000-8000-000000000001";
const PLAYER_ONE = "40000000-0000-4000-8000-000000000001";
const PLAYER_TWO = "40000000-0000-4000-8000-000000000002";
const SET_ID = "50000000-0000-4000-8000-000000000001";
const CHECKSUM = `sha256:${"a".repeat(64)}`;
const NOW = new Date("2026-09-10T12:00:00.000Z");
const SOURCE_OBSERVED_AT = "2026-09-10T11:55:00.000Z";

const scope: ProjectionLeagueScope = {
  leagueSeasonId: SEASON_ID,
  leagueId: LEAGUE_ID,
  leagueName: "Friends League",
  provider: "espn",
  season: 2026,
  currentWeek: 2,
  membershipRole: "manager",
  applicationRole: "member",
};

const catalog: readonly ProjectionResolverPlayer[] = [
  { id: PLAYER_ONE, gsisId: "00-0039999", fullName: "Exact Runner" },
  { id: PLAYER_TWO, gsisId: "00-0040000", fullName: "Clear Receiver" },
];

class FakeRepository implements ProjectionImportRepository {
  scope: ProjectionLeagueScope | undefined = scope;
  catalog: readonly ProjectionResolverPlayer[] = catalog;
  sets: readonly StoredProjectionSet[] = [];
  projectionPlayers: readonly StoredProjectionPlayer[] = [];
  committed: CommitProjectionSetInput | undefined;
  resolverCalls = 0;
  managedRun:
    | {
        readonly evaluatedAt: Date;
        readonly qualityState: "publishable" | "degraded" | "rejected";
        readonly scope: "league" | "positions";
        readonly reasons: readonly string[];
      }
    | undefined;

  findScope(actorUserId: string, leagueSeasonId: string) {
    return Promise.resolve(
      actorUserId === USER_ID && leagueSeasonId === SEASON_ID ? this.scope : undefined,
    );
  }

  listResolverPlayers() {
    this.resolverCalls += 1;
    return Promise.resolve(this.catalog);
  }

  listAccessibleSets() {
    return Promise.resolve(this.sets);
  }

  listProjectionPlayers() {
    return Promise.resolve(this.projectionPlayers);
  }

  latestManagedRunStatus() {
    return Promise.resolve(this.managedRun);
  }

  commitProjectionSet(input: CommitProjectionSetInput) {
    this.committed = input;
    return Promise.resolve({
      deduplicated: false,
      row: {
        id: SET_ID,
        leagueSeasonId: input.leagueSeasonId,
        creatorUserId: input.actorUserId,
        creatorDisplayName: "League Guru",
        visibility: input.visibility,
        source: "user-csv",
        season: input.normalized.metadata.season,
        week: input.normalized.metadata.week,
        horizon: input.normalized.metadata.horizon,
        inputChecksum: input.normalized.checksum,
        metadata: {
          schemaVersion: 2,
          importKind: "user-csv",
          sourceLabel: input.normalized.metadata.sourceLabel,
          sourceObservedAt: input.normalized.metadata.sourceObservedAt,
          sourceChecksum: input.normalized.sourceChecksum,
          sourceFileName: input.sourceFileName,
          rowCount: input.normalized.playerProjections.length,
        },
        fetchedAt: new Date(input.normalized.metadata.sourceObservedAt),
        createdAt: input.importedAt,
        playerCount: input.normalized.playerProjections.length,
      },
    });
  }
}

const MANAGED_COMPUTED_AT = "2026-09-10T11:59:00.000Z";

/** The league's own managed weekly set for `scope.currentWeek`. */
function managedWeeklySet(): StoredProjectionSet {
  return {
    id: SET_ID,
    leagueSeasonId: SEASON_ID,
    creatorUserId: null,
    creatorDisplayName: null,
    visibility: "league",
    source: "laces-out-first-party",
    season: 2026,
    week: 2,
    horizon: "week",
    inputChecksum: CHECKSUM,
    metadata: {
      sourceLabel: "Laces Out Week 2 forecast",
      modelVersion: "first-party-v1",
      computedAt: MANAGED_COMPUTED_AT,
      qualityState: "publishable",
      supportedPositions: ["QB", "RB", "WR", "TE", "K"],
      publishedPositions: ["QB", "RB", "WR", "TE", "K"],
    },
    fetchedAt: new Date("2026-09-10T11:45:00.000Z"),
    createdAt: new Date(MANAGED_COMPUTED_AT),
    playerCount: 213,
  };
}

function request(csv: string, visibility: "private" | "league" = "private") {
  return {
    csv,
    metadata: {
      season: 2026,
      week: 2,
      horizon: "week" as const,
      sourceLabel: "Personal model",
      sourceObservedAt: SOURCE_OBSERVED_AT,
    },
    visibility,
    sourceFileName: "week-2.csv",
  };
}

describe("ProjectionImportService", () => {
  it("previews a bounded CSV with exact canonical-ID and exact-name resolution", async () => {
    const repository = new FakeRepository();
    const service = new ProjectionImportService(repository, () => NOW);
    const preview = await service.preview(
      USER_ID,
      SEASON_ID,
      request(
        `player_id,player_name,mean_points,floor_points,ceiling_points,confidence\n${PLAYER_ONE},,18.25,11,27,0.8\n,Clear Receiver,14.5,8,22,0.7`,
      ),
    );

    expect(preview).toMatchObject({
      metadata: { horizon: "week", sourceObservedAt: SOURCE_OBSERVED_AT },
      rowCount: 2,
      resolvedRowCount: 2,
      canCommit: true,
      diagnostics: [],
      visibility: "private",
    });
    expect(preview.importChecksum).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(repository.resolverCalls).toBe(1);
  });

  it("never falls back to a name when a supplied player ID is wrong", async () => {
    const repository = new FakeRepository();
    const service = new ProjectionImportService(repository, () => NOW);
    const preview = await service.preview(
      USER_ID,
      SEASON_ID,
      request("player_id,player_name,mean_points\nnot-a-real-id,Exact Runner,18"),
    );

    expect(preview.canCommit).toBe(false);
    expect(preview.importChecksum).toBeNull();
    expect(preview.diagnostics).toContainEqual(
      expect.objectContaining({ code: "player_unresolved", rowNumber: 2 }),
    );
  });

  it("reports malformed CSV as a client error instead of an internal failure", async () => {
    const repository = new FakeRepository();
    const service = new ProjectionImportService(repository, () => NOW);
    await expect(
      service.preview(USER_ID, SEASON_ID, request('player_name,mean_points\n"unterminated,18')),
    ).rejects.toMatchObject({ statusCode: 400, code: "invalid_import" });
    expect(repository.resolverCalls).toBe(0);
  });

  it("requires owner, commissioner, or application-admin authority before shared preview work", async () => {
    const repository = new FakeRepository();
    const service = new ProjectionImportService(repository, () => NOW);

    await expect(
      service.preview(
        USER_ID,
        SEASON_ID,
        request("player_name,mean_points\nExact Runner,18", "league"),
      ),
    ).rejects.toMatchObject({ statusCode: 403, code: "forbidden" });
    expect(repository.resolverCalls).toBe(0);

    repository.scope = { ...scope, membershipRole: "commissioner" };
    await expect(
      service.preview(
        USER_ID,
        SEASON_ID,
        request("player_name,mean_points\nExact Runner,18", "league"),
      ),
    ).resolves.toMatchObject({ canCommit: true, visibility: "league" });
  });

  it("reparses on commit and rejects a stale preview checksum", async () => {
    const repository = new FakeRepository();
    const service = new ProjectionImportService(repository, () => NOW);
    const input = request("player_name,mean_points\nExact Runner,18");
    const preview = await service.preview(USER_ID, SEASON_ID, input);
    expect(preview.importChecksum).not.toBeNull();

    await expect(
      service.commit(USER_ID, SEASON_ID, {
        ...input,
        expectedImportChecksum: CHECKSUM,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "preview_mismatch" });
    expect(repository.committed).toBeUndefined();

    const result = await service.commit(USER_ID, SEASON_ID, {
      ...input,
      expectedImportChecksum: preview.importChecksum!,
    });
    expect(repository.resolverCalls).toBe(3);
    expect(repository.committed).toMatchObject({
      actorUserId: USER_ID,
      leagueSeasonId: SEASON_ID,
      visibility: "private",
      sourceFileName: "week-2.csv",
      importedAt: NOW,
      normalized: { metadata: { sourceObservedAt: SOURCE_OBSERVED_AT } },
    });
    expect(result).toMatchObject({
      deduplicated: false,
      projectionSet: {
        id: SET_ID,
        playerCount: 1,
        isOwnedByCurrentUser: true,
        sourceObservedAt: SOURCE_OBSERVED_AT,
        sourceObservedAtStatus: "verified",
        importedAt: NOW.toISOString(),
      },
    });
  });

  it("fails closed for non-members and defensively filters repository rows", async () => {
    const repository = new FakeRepository();
    const service = new ProjectionImportService(repository, () => NOW);
    await expect(service.list(OTHER_USER_ID, SEASON_ID)).rejects.toEqual(
      expect.objectContaining<Partial<ProjectionImportRequestError>>({
        statusCode: 404,
        code: "not_found",
      }),
    );

    const baseSet: StoredProjectionSet = {
      id: SET_ID,
      leagueSeasonId: SEASON_ID,
      creatorUserId: USER_ID,
      creatorDisplayName: "League Guru",
      visibility: "private",
      source: "user-csv",
      season: 2026,
      week: 2,
      horizon: "week",
      inputChecksum: CHECKSUM,
      metadata: { sourceLabel: "My model", sourceChecksum: CHECKSUM, rowCount: 1 },
      fetchedAt: NOW,
      createdAt: NOW,
      playerCount: 1,
    };
    repository.sets = [
      baseSet,
      { ...baseSet, id: "50000000-0000-4000-8000-000000000002", creatorUserId: OTHER_USER_ID },
      {
        ...baseSet,
        id: "50000000-0000-4000-8000-000000000003",
        creatorUserId: OTHER_USER_ID,
        visibility: "league",
      },
      {
        ...baseSet,
        id: "50000000-0000-4000-8000-000000000004",
        leagueSeasonId: "30000000-0000-4000-8000-000000000099",
        visibility: "league",
      },
    ];
    const list = await service.list(USER_ID, SEASON_ID);
    expect(list.projectionSets.map((set) => set.id)).toEqual([
      SET_ID,
      "50000000-0000-4000-8000-000000000003",
    ]);
    expect(list.projectionSets[0]).toMatchObject({
      sourceObservedAt: null,
      sourceObservedAtStatus: "unverified",
      importedAt: NOW.toISOString(),
    });
  });

  it("returns player-level rows only from an accessible projection set", async () => {
    const repository = new FakeRepository();
    const service = new ProjectionImportService(repository, () => NOW);
    repository.sets = [
      {
        id: SET_ID,
        leagueSeasonId: SEASON_ID,
        creatorUserId: null,
        creatorDisplayName: null,
        visibility: "league",
        source: "laces-out-first-party-ros",
        season: 2026,
        week: null,
        horizon: "rest-of-season",
        inputChecksum: "b".repeat(64),
        metadata: { sourceLabel: "Laces Out ROS forecast" },
        fetchedAt: NOW,
        createdAt: NOW,
        playerCount: 2,
      },
    ];
    repository.projectionPlayers = [
      {
        playerId: PLAYER_ONE,
        fullName: "Exact Runner",
        nflTeam: "CHI",
        primaryPosition: "RB",
        eligiblePositions: ["RB", "FLEX"],
        status: "ACTIVE",
        meanPoints: "201.250",
        floorPoints: "150.000",
        ceilingPoints: "255.500",
        confidence: null,
        rosWindowStartWeek: 3,
        rosWindowEndWeek: 17,
        rosAsOfWeek: 2,
        rosAsOfAt: NOW,
        rosScheduledGames: 15,
        rosExpectedGames: "14.250000",
        rosMedianPoints: "198.500",
        rosMeanPointsPerExpectedGame: "14.122807",
        rosPointsStddev: "31.400",
      },
      {
        playerId: PLAYER_TWO,
        fullName: "Clear Receiver",
        nflTeam: "DET",
        primaryPosition: "WR",
        eligiblePositions: ["WR", "FLEX"],
        status: null,
        meanPoints: "180.000",
        floorPoints: "132.000",
        ceilingPoints: "229.000",
        confidence: null,
        rosWindowStartWeek: 3,
        rosWindowEndWeek: 17,
        rosAsOfWeek: 2,
        rosAsOfAt: NOW,
        rosScheduledGames: 15,
        rosExpectedGames: "14.000000",
        rosMedianPoints: "176.000",
        rosMeanPointsPerExpectedGame: "12.857143",
        rosPointsStddev: "28.100",
      },
    ];

    await expect(service.getPlayers(OTHER_USER_ID, SEASON_ID, SET_ID)).rejects.toMatchObject({
      statusCode: 404,
      code: "not_found",
    });
    await expect(service.getPlayers(USER_ID, SEASON_ID, SET_ID)).resolves.toMatchObject({
      projectionSet: {
        id: SET_ID,
        week: null,
        horizon: "rest-of-season",
        inputChecksum: `sha256:${"b".repeat(64)}`,
        sourceChecksum: `sha256:${"b".repeat(64)}`,
      },
      players: [
        {
          playerId: PLAYER_ONE,
          overallRank: 1,
          positionRank: 1,
          meanPoints: 201.25,
          ros: {
            windowStartWeek: 3,
            windowEndWeek: 17,
            expectedGames: 14.25,
            medianPoints: 198.5,
          },
        },
        {
          playerId: PLAYER_TWO,
          overallRank: 2,
          positionRank: 1,
        },
      ],
    });
  });

  it("lists a managed forecast without a synthetic user and separates input freshness from compute time", async () => {
    const repository = new FakeRepository();
    const service = new ProjectionImportService(repository, () => NOW);
    repository.sets = [
      {
        id: SET_ID,
        leagueSeasonId: SEASON_ID,
        creatorUserId: null,
        creatorDisplayName: null,
        visibility: "league",
        source: "laces-out-first-party",
        season: 2026,
        week: 2,
        horizon: "week",
        inputChecksum: CHECKSUM,
        metadata: {
          sourceLabel: "Laces Out Week 2 forecast",
          modelVersion: "first-party-v1",
          computedAt: "2026-09-10T11:59:00.000Z",
          // This conflicting value must not override the persisted input check anchor.
          inputCheckedAt: "2026-09-10T11:58:00.000Z",
          trainingCutoff: { season: 2026, week: 1 },
          statsThrough: { season: 2026, week: 1 },
          qualityState: "publishable",
          coverage: { projected: 213, eligible: 214, ratio: 213 / 214 },
          warnings: ["One eligible player was withheld because current-team identity was missing."],
          backtest: {
            samples: 1840,
            mae: 4.18,
            baselineMae: 4.62,
            intervalCoverage: 0.79,
          },
        },
        fetchedAt: new Date("2026-09-10T11:45:00.000Z"),
        createdAt: new Date("2026-09-10T12:00:00.000Z"),
        playerCount: 213,
      },
    ];

    const [managed] = (await service.list(USER_ID, SEASON_ID)).projectionSets;
    expect(() => projectionSetSummarySchema.parse(managed)).not.toThrow();
    expect(managed).toMatchObject({
      creatorUserId: null,
      creatorDisplayName: null,
      origin: "laces-out",
      isOwnedByCurrentUser: false,
      sourceObservedAt: "2026-09-10T11:45:00.000Z",
      importedAt: "2026-09-10T12:00:00.000Z",
      managed: {
        modelVersion: "first-party-v1",
        computedAt: "2026-09-10T11:59:00.000Z",
        inputCheckedAt: "2026-09-10T11:45:00.000Z",
        trainingCutoff: { season: 2026, week: 1 },
        qualityState: "publishable",
        coverage: { projected: 213, eligible: 214 },
        backtest: { samples: 1840, mae: 4.18, baselineMae: 4.62 },
      },
    });
  });

  // The weekly rail can now withhold single positions of an otherwise published league
  // (`scope: "positions"`). `projection-import-workbench.tsx` hides the managed forecast entirely
  // when this status reads "withheld", so mistaking a partial withholding for a whole-league one
  // would delete a league's QB/RB/WR/TE/K from the UI because its D/ST could not be priced.
  describe("managed forecast status", () => {
    it("reads a per-position withholding as published, with the withheld positions as a note", async () => {
      const repository = new FakeRepository();
      repository.sets = [managedWeeklySet()];
      repository.managedRun = {
        // Deliberately AFTER the set's computedAt, so the newer-run timestamp predicate would fire
        // if scope were ignored. Scope, not the clock, must decide this.
        evaluatedAt: new Date("2026-09-10T12:05:00.000Z"),
        qualityState: "publishable",
        scope: "positions",
        reasons: ["DST withheld: NONLINEAR_RULE: ESPN stat 132 has no per-unit component."],
      };
      const service = new ProjectionImportService(repository, () => NOW);

      const response = await service.list(USER_ID, SEASON_ID);

      expect(() => projectionSetListResponseSchema.parse(response)).not.toThrow();
      expect(response.managedForecastStatus).toEqual({
        state: "published",
        evaluatedAt: MANAGED_COMPUTED_AT,
        qualityState: "publishable",
        reasons: ["DST withheld: NONLINEAR_RULE: ESPN stat 132 has no per-unit component."],
      });
      // The published forecast stays listed — this is the outcome the workbench would otherwise
      // discard.
      expect(response.projectionSets.map((set) => set.id)).toContain(SET_ID);
    });

    it("still reports a whole-league withholding from a newer run as withheld", async () => {
      const repository = new FakeRepository();
      repository.sets = [managedWeeklySet()];
      repository.managedRun = {
        evaluatedAt: new Date("2026-09-10T12:05:00.000Z"),
        qualityState: "rejected",
        scope: "league",
        reasons: ["League roster snapshots are incomplete."],
      };
      const service = new ProjectionImportService(repository, () => NOW);

      const response = await service.list(USER_ID, SEASON_ID);

      expect(response.managedForecastStatus).toEqual({
        state: "withheld",
        evaluatedAt: "2026-09-10T12:05:00.000Z",
        qualityState: "rejected",
        reasons: ["League roster snapshots are incomplete."],
      });
    });

    it("reports a clean published run with no notes", async () => {
      const repository = new FakeRepository();
      repository.sets = [managedWeeklySet()];
      repository.managedRun = {
        evaluatedAt: new Date("2026-09-10T12:05:00.000Z"),
        qualityState: "publishable",
        scope: "league",
        reasons: [],
      };
      const service = new ProjectionImportService(repository, () => NOW);

      expect((await service.list(USER_ID, SEASON_ID)).managedForecastStatus).toMatchObject({
        state: "published",
        reasons: [],
      });
    });

    it("fails closed to a whole-league scope for entries this build does not recognise", () => {
      expect(managedRunWithholdingScope({ scope: "positions" })).toBe("positions");
      expect(managedRunWithholdingScope({ scope: "league" })).toBe("league");
      // A run written before per-position withholding existed carries no scope at all.
      expect(managedRunWithholdingScope({ leagueSeasonId: SEASON_ID })).toBe("league");
      expect(managedRunWithholdingScope({ scope: "something-new" })).toBe("league");
      expect(managedRunWithholdingScope(undefined)).toBe("league");
    });
  });

  it("rejects rest-of-season imports before player resolution", async () => {
    const repository = new FakeRepository();
    const service = new ProjectionImportService(repository, () => NOW);

    await expect(
      service.preview(USER_ID, SEASON_ID, {
        ...request("player_name,mean_points\nExact Runner,18"),
        metadata: {
          ...request("").metadata,
          horizon: "rest-of-season",
        },
      }),
    ).rejects.toMatchObject({ statusCode: 422, code: "unsupported_horizon" });
    expect(repository.resolverCalls).toBe(0);
  });

  it("accepts the five-minute future tolerance and rejects anything later", async () => {
    const repository = new FakeRepository();
    const service = new ProjectionImportService(repository, () => NOW);
    const csv = "player_name,mean_points\nExact Runner,18";

    await expect(
      service.preview(USER_ID, SEASON_ID, {
        ...request(csv),
        metadata: { ...request("").metadata, sourceObservedAt: "2026-09-10T12:05:00.000Z" },
      }),
    ).resolves.toMatchObject({ canCommit: true });
    const callsAtBoundary = repository.resolverCalls;

    await expect(
      service.preview(USER_ID, SEASON_ID, {
        ...request(csv),
        metadata: { ...request("").metadata, sourceObservedAt: "2026-09-10T12:05:00.001Z" },
      }),
    ).rejects.toMatchObject({ statusCode: 422, code: "source_observed_at_future" });
    expect(repository.resolverCalls).toBe(callsAtBoundary);
  });

  it("rejects cross-season metadata before resolving any player", async () => {
    const repository = new FakeRepository();
    const service = new ProjectionImportService(repository, () => NOW);
    await expect(
      service.preview(USER_ID, SEASON_ID, {
        ...request("player_name,mean_points\nExact Runner,18"),
        metadata: {
          season: 2025,
          week: 2,
          horizon: "week",
          sourceLabel: "Old model",
          sourceObservedAt: SOURCE_OBSERVED_AT,
        },
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "season_mismatch" });
    expect(repository.resolverCalls).toBe(0);
  });
});
