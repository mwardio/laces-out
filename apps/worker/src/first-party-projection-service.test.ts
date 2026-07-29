import {
  dataSources,
  fantasyTeams,
  leagueSeasons,
  nflScheduleObservations,
  playerExternalIds,
  playerInjuryReportObservations,
  playerProjections,
  playerSnapCountObservations,
  playerSourceObservations,
  playerWeeklyRosterObservations,
  playerWeeklyStatObservations,
  players,
  projectionModelRuns,
  projectionObservations,
  projectionSets,
  rosterEntries,
  scoringRules,
  syncRuns,
  teamWeeklyStatObservations,
  type Database,
} from "@fantasy/db";
import { describe, expect, it } from "vitest";

import { FIRST_PARTY_INPUT_EPOCH_VERSION } from "./first-party-projection-inputs.js";
import {
  FIRST_PARTY_PROJECTION_SOURCE_KEY,
  FirstPartyProjectionService,
  requiredFirstPartyProjectionSourceKeys,
} from "./first-party-projections.js";

type Row = Record<string, unknown>;

interface PriorRunFixture {
  readonly sourceSyncRunId: string;
  readonly playersPublished: number;
  readonly qualityState: "publishable" | "degraded" | "rejected";
  readonly createdAt: Date;
  readonly metrics: Record<string, unknown>;
  readonly rawRows: number;
  readonly leagueSetIds?: readonly string[];
  readonly leagueRows?: number;
}

interface ProjectionDatabaseFixture {
  readonly now: Date;
  readonly schedule?: readonly Row[];
  readonly unusableSource?: {
    readonly key: string;
    readonly metadata: Record<string, unknown>;
  };
  readonly priorRun?: PriorRunFixture;
  readonly publishConflict?: boolean;
  readonly leagues?: readonly Row[];
  // Simulates a required source (e.g. weekly stats) completing a concurrent refresh with a new
  // checksum after this run already validated sources and captured its start-of-refresh epoch,
  // but before this run reaches its own persist transaction.
  readonly driftRequiredSourceChecksumAfterStart?: {
    readonly key: string;
    readonly newChecksum: string;
  };
}

class SelectQuery implements PromiseLike<readonly Row[]> {
  #table: unknown;

  constructor(
    private readonly selection: Row,
    private readonly resolveRows: (table: unknown, selection: Row) => readonly Row[],
  ) {}

  from(table: unknown): this {
    this.#table = table;
    return this;
  }

  innerJoin(): this {
    return this;
  }

  where(): this {
    return this;
  }

  orderBy(): this {
    return this;
  }

  limit(): this {
    return this;
  }

  then<TResult1 = readonly Row[], TResult2 = never>(
    onfulfilled?: ((value: readonly Row[]) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.resolveRows(this.#table, this.selection)).then(
      onfulfilled,
      onrejected,
    );
  }
}

class MutationQuery implements PromiseLike<readonly Row[]> {
  #values: unknown;
  #executed: Promise<readonly Row[]> | undefined;

  constructor(
    private readonly table: unknown,
    private readonly executeMutation: (table: unknown, values: unknown) => readonly Row[],
  ) {}

  values(values: unknown): this {
    this.#values = values;
    return this;
  }

  set(values: unknown): this {
    this.#values = values;
    return this;
  }

  onConflictDoUpdate(): this {
    return this;
  }

  onConflictDoNothing(): this {
    return this;
  }

  returning(): this {
    return this;
  }

  where(): this {
    return this;
  }

  then<TResult1 = readonly Row[], TResult2 = never>(
    onfulfilled?: ((value: readonly Row[]) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    this.#executed ??= Promise.resolve(this.executeMutation(this.table, this.#values));
    return this.#executed.then(onfulfilled, onrejected);
  }
}

class ProjectionDatabaseHarness {
  readonly modelRuns: Row[] = [];
  readonly sourceUpdates: Row[] = [];
  syncRunInsertAttempts = 0;

  readonly #database: Database;
  readonly #defensePlayers: Row[] = [];
  readonly #sources: readonly Row[];
  #priorRunRead = false;
  #requiredSourceKeySelects = 0;

  constructor(private readonly fixture: ProjectionDatabaseFixture) {
    const sourceKeys = requiredFirstPartyProjectionSourceKeys(2026).required;
    this.#sources = sourceKeys.map((key, index) => ({
      id: `source-${index}`,
      key,
      enabled: true,
      lastChecksum: String(index + 1).padStart(64, "0"),
      lastSuccessfulAt: new Date(fixture.now.getTime() - 5 * 60_000),
      lastCheckedAt: new Date(fixture.now.getTime() - 5 * 60_000),
      consecutiveFailures: 0,
      checkIntervalMinutes: 60,
      metadata:
        fixture.unusableSource?.key === key
          ? fixture.unusableSource.metadata
          : { availability: "available", publishable: true },
    }));
    const facade = {
      select: (selection: Row) =>
        new SelectQuery(selection, (table, selected) => this.#selectRows(table, selected)),
      insert: (table: unknown) =>
        new MutationQuery(table, (target, values) => this.#insertRows(target, values)),
      update: (table: unknown) =>
        new MutationQuery(table, (target, values) => this.#updateRows(target, values)),
      transaction: async <T>(callback: (transaction: Database) => Promise<T>) =>
        callback(this.#database),
    };
    this.#database = facade as unknown as Database;
  }

  get database(): Database {
    return this.#database;
  }

  #selectRows(table: unknown, selection: Row): readonly Row[] {
    if (table === dataSources) {
      if (!Object.hasOwn(selection, "key")) {
        return [{ metadata: { modelVersion: "retained-version" } }];
      }
      this.#requiredSourceKeySelects += 1;
      // `#selectSources` performs the first read (at the start of the refresh, once sources are
      // validated); the service's own end-of-assembly epoch recheck performs every read after
      // that. Drifting only from the second read onward reproduces a source that changes
      // concurrently after this run already captured its start epoch.
      const drift = this.fixture.driftRequiredSourceChecksumAfterStart;
      if (drift && this.#requiredSourceKeySelects > 1) {
        return this.#sources.map((row) =>
          row.key === drift.key ? { ...row, lastChecksum: drift.newChecksum } : row,
        );
      }
      return this.#sources;
    }
    if (table === nflScheduleObservations) return this.fixture.schedule ?? [];
    if (table === players) return this.#defensePlayers;
    if (table === leagueSeasons) return this.fixture.leagues ?? [];
    if (
      table === playerWeeklyStatObservations ||
      table === playerWeeklyRosterObservations ||
      table === playerInjuryReportObservations ||
      table === playerSnapCountObservations ||
      table === teamWeeklyStatObservations ||
      table === scoringRules ||
      table === playerSourceObservations ||
      table === playerExternalIds ||
      table === fantasyTeams ||
      table === rosterEntries ||
      table === syncRuns
    ) {
      return [];
    }
    if (table === projectionModelRuns) {
      if (!this.fixture.priorRun || this.#priorRunRead) return [];
      this.#priorRunRead = true;
      return [{ ...this.fixture.priorRun }];
    }
    if (table === projectionObservations) {
      return [{ count: this.fixture.priorRun?.rawRows ?? 0 }];
    }
    if (table === projectionSets) {
      return (this.fixture.priorRun?.leagueSetIds ?? []).map((id) => ({ id }));
    }
    if (table === playerProjections) {
      return Object.hasOwn(selection, "count")
        ? [{ count: this.fixture.priorRun?.leagueRows ?? 0 }]
        : [];
    }
    throw new Error(`Unexpected projection test select: ${Object.keys(selection).join(",")}`);
  }

  #insertRows(table: unknown, values: unknown): readonly Row[] {
    if (table === dataSources) {
      return [{ id: "managed-projection-source", lastChecksum: null }];
    }
    if (table === players) {
      const rows = Array.isArray(values) ? values : [values];
      this.#defensePlayers.push(
        ...rows.map((candidate) => {
          const row = candidate as Row;
          return {
            id: row.id,
            gsisId: null,
            fullName: row.fullName,
            nflTeam: row.nflTeam,
            primaryPosition: row.primaryPosition,
            status: row.status,
            lastSeason: row.lastSeason,
          };
        }),
      );
      return [];
    }
    if (table === syncRuns) {
      this.syncRunInsertAttempts += 1;
      return this.fixture.publishConflict ? [] : [{ id: "projection-sync-run" }];
    }
    if (table === projectionModelRuns) {
      this.modelRuns.push(values as Row);
      return [];
    }
    if (
      table === projectionObservations ||
      table === projectionSets ||
      table === playerProjections
    ) {
      return [];
    }
    throw new Error("Unexpected projection test insert");
  }

  #updateRows(table: unknown, values: unknown): readonly Row[] {
    if (table === dataSources) this.sourceUpdates.push(values as Row);
    if (table === dataSources || table === syncRuns) return [];
    throw new Error("Unexpected projection test update");
  }
}

const nflTeams = [
  "ARI",
  "ATL",
  "BAL",
  "BUF",
  "CAR",
  "CHI",
  "CIN",
  "CLE",
  "DAL",
  "DEN",
  "DET",
  "GB",
  "HOU",
  "IND",
  "JAX",
  "KC",
  "LAC",
  "LAR",
  "LV",
  "MIA",
  "MIN",
  "NE",
  "NO",
  "NYG",
  "NYJ",
  "PHI",
  "PIT",
  "SEA",
  "SF",
  "TB",
  "TEN",
  "WAS",
] as const;

function scheduleFixture(input: { readonly unknownKickoff?: boolean } = {}): readonly Row[] {
  return Array.from({ length: nflTeams.length / 2 }, (_, index) => ({
    season: 2026,
    week: 1,
    gameId: `2026_01_${nflTeams[index * 2]}_${nflTeams[index * 2 + 1]}`,
    awayTeam: nflTeams[index * 2],
    homeTeam: nflTeams[index * 2 + 1],
    awayScore: null,
    homeScore: null,
    kickoffAt:
      input.unknownKickoff === true && index === 0 ? null : new Date("2026-09-13T17:00:00.000Z"),
    status: "scheduled",
  }));
}

function jobContext() {
  return {
    jobId: "projection-service-test",
    signal: new AbortController().signal,
  } as const;
}

function latestSourceMetadata(harness: ProjectionDatabaseHarness): Row {
  const update = harness.sourceUpdates.at(-1);
  if (!update || typeof update.metadata !== "object" || update.metadata === null) {
    throw new Error("Projection service did not record source metadata");
  }
  return update.metadata as Row;
}

describe("first-party projection service release safety", () => {
  it.each([
    ["source loss", { availability: "not-published", publishable: false }],
    [
      "active refresh claim",
      { availability: "available", refreshClaimedAt: "2026-09-01T12:00:00Z" },
    ],
  ])("fails closed before reading observations during %s", async (_label, metadata) => {
    const now = new Date("2026-09-01T12:00:00.000Z");
    const harness = new ProjectionDatabaseHarness({
      now,
      unusableSource: { key: "nflverse.players", metadata },
    });
    const service = new FirstPartyProjectionService({ database: harness.database, now: () => now });

    await expect(
      service.refreshProjections({ season: 2026, week: 1 }, jobContext()),
    ).rejects.toThrow(
      /Required projection inputs are missing, stale, or degraded: nflverse\.players/u,
    );

    expect(harness.syncRunInsertAttempts).toBe(0);
    expect(harness.modelRuns).toHaveLength(0);
    expect(harness.sourceUpdates.at(-1)).toMatchObject({
      lastErrorCode: "PROJECTION_REFRESH_FAILED",
    });
  });

  it("withholds the entire week at the publisher boundary when one scheduled kickoff is unknown", async () => {
    const now = new Date("2026-09-01T12:00:00.000Z");
    const harness = new ProjectionDatabaseHarness({
      now,
      schedule: scheduleFixture({ unknownKickoff: true }),
    });
    const service = new FirstPartyProjectionService({ database: harness.database, now: () => now });

    await service.refreshProjections({ season: 2026, week: 1 }, jobContext());

    expect(harness.modelRuns).toHaveLength(1);
    const modelRun = harness.modelRuns[0];
    const metrics = modelRun?.metrics as
      { readonly gate?: { readonly reasons?: unknown }; readonly leagues?: unknown } | undefined;
    expect(modelRun?.qualityState).toBe("rejected");
    expect(modelRun?.playersPublished).toBe(0);
    expect(metrics?.gate?.reasons).toContain("scheduled_game_kickoff_unknown");
    expect(metrics?.leagues).toEqual({
      published: 0,
      rowsPublished: 0,
      eligible: 0,
      withheld: [],
      // Leagues that published under a caveat; deliberately separate from `withheld`.
      notes: [],
    });
    const sourceMetadata = latestSourceMetadata(harness);
    expect(sourceMetadata).toMatchObject({
      publishedWeeks: 0,
      qualityState: "rejected",
      result: "prior_good_output_preserved",
    });
    expect(String(sourceMetadata.qualityReasons)).toContain("scheduled_game_kickoff_unknown");
    expect(sourceMetadata).not.toHaveProperty("lastPublishedAt");
  });

  it("persists structured, scoped league withholding in the run metrics", async () => {
    const now = new Date("2026-09-01T12:00:00.000Z");
    const harness = new ProjectionDatabaseHarness({
      now,
      schedule: scheduleFixture(),
      leagues: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          provider: "espn",
          currentWeek: 1,
          teamCount: 12,
        },
      ],
    });
    const service = new FirstPartyProjectionService({ database: harness.database, now: () => now });

    await service.refreshProjections({ season: 2026, week: 1 }, jobContext());

    // With no seeded history the whole-model release gate stays closed, so this league is
    // withheld outright. What matters here is the shape that reaches
    // `projection_model_runs.metrics`: every entry now carries `scope`, so a reader can tell a
    // league that published nothing from one that published only some of its positions.
    const metrics = harness.modelRuns[0]?.metrics as
      { readonly leagues?: { readonly withheld?: readonly Record<string, unknown>[] } } | undefined;
    const withheld = metrics?.leagues?.withheld ?? [];
    expect(withheld).toHaveLength(1);
    expect(withheld[0]).toMatchObject({
      leagueSeasonId: "11111111-1111-4111-8111-111111111111",
      scope: "league",
    });
    expect(Array.isArray(withheld[0]?.reasons)).toBe(true);
  });

  it("preserves the publication timestamp when an exact, complete output is unchanged", async () => {
    const now = new Date("2026-09-01T12:00:00.000Z");
    const publishedAt = new Date("2026-09-01T10:15:00.000Z");
    const harness = new ProjectionDatabaseHarness({
      now,
      schedule: scheduleFixture(),
      priorRun: {
        sourceSyncRunId: "prior-sync-run",
        playersPublished: 0,
        qualityState: "publishable",
        createdAt: publishedAt,
        metrics: {
          gate: { reasons: [] },
          leagues: { published: 1, rowsPublished: 2 },
        },
        rawRows: 0,
        leagueSetIds: ["complete-league-set"],
        leagueRows: 2,
      },
    });
    const service = new FirstPartyProjectionService({ database: harness.database, now: () => now });

    await service.refreshProjections({ season: 2026, week: 1 }, jobContext());

    expect(harness.syncRunInsertAttempts).toBe(0);
    expect(latestSourceMetadata(harness)).toMatchObject({
      lastPublishedAt: publishedAt.toISOString(),
      lastEvaluationAt: now.toISOString(),
      publishedWeeks: 0,
      result: "unchanged",
    });
  });

  it("fails closed instead of overwriting a prior run whose raw observation count is incomplete", async () => {
    const now = new Date("2026-09-01T12:00:00.000Z");
    const harness = new ProjectionDatabaseHarness({
      now,
      schedule: scheduleFixture(),
      priorRun: {
        sourceSyncRunId: "incomplete-sync-run",
        playersPublished: 1,
        qualityState: "publishable",
        createdAt: new Date("2026-09-01T10:15:00.000Z"),
        metrics: {
          gate: { reasons: [] },
          leagues: { published: 0, rowsPublished: 0 },
        },
        rawRows: 0,
      },
    });
    const service = new FirstPartyProjectionService({ database: harness.database, now: () => now });

    await expect(
      service.refreshProjections({ season: 2026, week: 1 }, jobContext()),
    ).rejects.toThrow(/matching immutable projection run is incomplete/u);

    expect(harness.syncRunInsertAttempts).toBe(0);
    expect(harness.modelRuns).toHaveLength(0);
    expect(harness.sourceUpdates.at(-1)).not.toHaveProperty("lastPublishedAt");
    expect(harness.sourceUpdates.at(-1)).toMatchObject({
      lastErrorCode: "PROJECTION_REFRESH_FAILED",
    });
  });

  it("fails closed when a prior league set is missing one of its declared rows", async () => {
    const now = new Date("2026-09-01T12:00:00.000Z");
    const harness = new ProjectionDatabaseHarness({
      now,
      schedule: scheduleFixture(),
      priorRun: {
        sourceSyncRunId: "incomplete-league-sync-run",
        playersPublished: 0,
        qualityState: "publishable",
        createdAt: new Date("2026-09-01T10:15:00.000Z"),
        metrics: {
          gate: { reasons: [] },
          leagues: { published: 1, rowsPublished: 2 },
        },
        rawRows: 0,
        leagueSetIds: ["incomplete-league-set"],
        leagueRows: 1,
      },
    });
    const service = new FirstPartyProjectionService({ database: harness.database, now: () => now });

    await expect(
      service.refreshProjections({ season: 2026, week: 1 }, jobContext()),
    ).rejects.toThrow(/matching immutable projection run is incomplete/u);

    expect(harness.syncRunInsertAttempts).toBe(0);
    expect(harness.modelRuns).toHaveLength(0);
    expect(harness.sourceUpdates.at(-1)).toMatchObject({
      lastErrorCode: "PROJECTION_REFRESH_FAILED",
    });
  });

  it("treats an idempotency conflict as a concurrent no-op without claiming a publication", async () => {
    const now = new Date("2026-09-01T12:00:00.000Z");
    const harness = new ProjectionDatabaseHarness({
      now,
      schedule: scheduleFixture(),
      publishConflict: true,
    });
    const service = new FirstPartyProjectionService({ database: harness.database, now: () => now });

    await service.refreshProjections({ season: 2026, week: 1 }, jobContext());

    expect(harness.syncRunInsertAttempts).toBe(1);
    expect(harness.modelRuns).toHaveLength(0);
    expect(latestSourceMetadata(harness)).toMatchObject({ publishedWeeks: 0 });
    expect(latestSourceMetadata(harness)).not.toHaveProperty("lastPublishedAt");
  });

  it("keeps the managed projection source name stable in the service contract", () => {
    expect(FIRST_PARTY_PROJECTION_SOURCE_KEY).toBe("laces-out.projections.first-party");
  });

  it("stamps a versioned, stable input epoch into the persisted model run configuration", async () => {
    const now = new Date("2026-09-01T12:00:00.000Z");
    const schedule = scheduleFixture();

    const firstHarness = new ProjectionDatabaseHarness({ now, schedule });
    const firstService = new FirstPartyProjectionService({
      database: firstHarness.database,
      now: () => now,
    });
    await firstService.refreshProjections({ season: 2026, week: 1 }, jobContext());

    expect(firstHarness.modelRuns).toHaveLength(1);
    const firstConfiguration = firstHarness.modelRuns[0]?.configuration as
      | { readonly inputEpoch?: { readonly version?: unknown; readonly value?: unknown } }
      | undefined;
    expect(firstConfiguration?.inputEpoch?.version).toBe(FIRST_PARTY_INPUT_EPOCH_VERSION);
    expect(firstConfiguration?.inputEpoch?.value).toMatch(/^[0-9a-f]{64}$/u);

    // A second, independent run against a fresh harness with identical source checksums and
    // as-of stamps must derive the exact same epoch: it is a pure function of the sources, not
    // of anything time- or instance-specific.
    const secondHarness = new ProjectionDatabaseHarness({ now, schedule });
    const secondService = new FirstPartyProjectionService({
      database: secondHarness.database,
      now: () => now,
    });
    await secondService.refreshProjections({ season: 2026, week: 1 }, jobContext());
    const secondConfiguration = secondHarness.modelRuns[0]?.configuration as
      { readonly inputEpoch?: { readonly value?: unknown } } | undefined;
    expect(secondConfiguration?.inputEpoch?.value).toBe(firstConfiguration?.inputEpoch?.value);
  });

  it("withholds the run and preserves prior good output when a required source checksum changes mid-assembly", async () => {
    const now = new Date("2026-09-01T12:00:00.000Z");
    const driftedKey = "nflverse.stats-player-week.2025";
    const harness = new ProjectionDatabaseHarness({
      now,
      schedule: scheduleFixture(),
      // No `priorRun` fixture matches this run's (drift-free) base checksum, so the service
      // proceeds past the fast idempotent-rerun path, loads inputs, and trains before its
      // end-of-assembly epoch recheck observes the drift and withholds.
      driftRequiredSourceChecksumAfterStart: { key: driftedKey, newChecksum: "f".repeat(64) },
    });
    const service = new FirstPartyProjectionService({ database: harness.database, now: () => now });

    await service.refreshProjections({ season: 2026, week: 1 }, jobContext());

    expect(harness.syncRunInsertAttempts).toBe(0);
    expect(harness.modelRuns).toHaveLength(0);
    const sourceMetadata = latestSourceMetadata(harness);
    expect(sourceMetadata).toMatchObject({
      publishedWeeks: 0,
      qualityState: "rejected",
      qualityReasons: "input_epoch_changed",
      result: "input_epoch_changed",
    });
    expect(sourceMetadata).not.toHaveProperty("lastPublishedAt");
  });
});
