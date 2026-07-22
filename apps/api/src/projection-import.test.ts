import { describe, expect, it } from "vitest";
import { projectionSetSummarySchema } from "@fantasy/contracts";

import {
  ProjectionImportService,
  type CommitProjectionSetInput,
  type ProjectionImportRepository,
  type ProjectionImportRequestError,
  type ProjectionLeagueScope,
  type ProjectionResolverPlayer,
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
  committed: CommitProjectionSetInput | undefined;
  resolverCalls = 0;

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
