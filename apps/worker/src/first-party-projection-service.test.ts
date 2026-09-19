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
} from "@laces-out/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

import { WEEKLY_INPUT_SNAPSHOT_VERSION } from "./weekly-input-snapshot.js";
import * as projectionInputs from "./first-party-projection-inputs.js";
import * as projectionModel from "@laces-out/projections";
import {
  FIRST_PARTY_PROJECTION_SOURCE_KEY,
  FirstPartyPublicationEvidenceMemo,
  FirstPartyProjectionService,
  requiredFirstPartyProjectionSourceKeys,
} from "./first-party-projections.js";

afterEach(() => vi.restoreAllMocks());

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
  readonly priorRuns?: readonly PriorRunFixture[];
  readonly reuseRecordedRuns?: boolean;
  readonly publishConflict?: boolean;
  readonly leagues?: readonly Row[];
  readonly optionalSources?: readonly string[];
  readonly driftSourceAfterRead?: {
    readonly key: string;
    readonly minimumRead: number;
    readonly patch: Row;
  };
  readonly driftMutableChecksumAfterSnapshot?: boolean;
  readonly onInsert?: (table: unknown) => void;
  readonly onSelect?: (table: unknown) => void;
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
  #predicate: SQL | undefined;

  constructor(
    private readonly selection: Row,
    private readonly resolveRows: (
      table: unknown,
      selection: Row,
      predicate?: SQL,
    ) => readonly Row[],
  ) {}

  from(table: unknown): this {
    this.#table = table;
    return this;
  }

  innerJoin(): this {
    return this;
  }

  where(predicate?: SQL): this {
    this.#predicate = predicate;
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
    return Promise.resolve(this.resolveRows(this.#table, this.selection, this.#predicate)).then(
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
  readonly syncRunUpdates: Row[] = [];
  syncRunInsertAttempts = 0;
  readonly transactionEvents: {
    readonly kind: string;
    readonly isolationLevel?: unknown;
    readonly depth: number;
  }[] = [];
  #transactionDepth = 0;
  #mutableChecksumReads = 0;

  readonly #database: Database;
  readonly #defensePlayers: Row[] = [];
  readonly #sources: readonly Row[];
  #priorRunReads = 0;
  #requiredSourceKeySelects = 0;
  #driftAtSourceRead: { key: string; checksum: string; read: number } | undefined;

  constructor(private readonly fixture: ProjectionDatabaseFixture) {
    const sourceKeys = [
      ...requiredFirstPartyProjectionSourceKeys(2026).required,
      ...(fixture.optionalSources ?? []),
    ];
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
        new SelectQuery(selection, (table, selected, predicate) =>
          this.#selectRows(table, selected, predicate),
        ),
      insert: (table: unknown) =>
        new MutationQuery(table, (target, values) => this.#insertRows(target, values)),
      update: (table: unknown) =>
        new MutationQuery(table, (target, values) => this.#updateRows(target, values)),
      execute: async (statement: SQL) => {
        const query = new PgDialect().sqlToQuery(statement).sql;
        const kind = query.includes("lock table")
          ? "lock"
          : query.includes("as checksum")
            ? "mutable-checksum"
            : "transaction-timeout";
        this.transactionEvents.push({ kind, depth: this.#transactionDepth });
        if (kind !== "mutable-checksum") return [];
        this.#mutableChecksumReads += 1;
        return [
          {
            checksum:
              this.fixture.driftMutableChecksumAfterSnapshot && this.#mutableChecksumReads > 1
                ? "b".repeat(64)
                : "a".repeat(64),
          },
        ];
      },
      transaction: async <T>(
        callback: (transaction: Database) => Promise<T>,
        config?: { isolationLevel?: unknown },
      ) => {
        this.#transactionDepth += 1;
        this.transactionEvents.push({
          kind: "begin",
          depth: this.#transactionDepth,
          isolationLevel: config?.isolationLevel,
        });
        try {
          return await callback(this.#database);
        } finally {
          this.transactionEvents.push({ kind: "end", depth: this.#transactionDepth });
          this.#transactionDepth -= 1;
        }
      },
    };
    this.#database = facade as unknown as Database;
  }

  get database(): Database {
    return this.#database;
  }

  setSourceChecksum(key: string, checksum: string): string {
    const source = this.#sources.find((row) => row.key === key);
    if (!source) throw new Error("Missing fixture source");
    const previous = String(source.lastChecksum);
    source.lastChecksum = checksum;
    return previous;
  }

  driftOnNextSourceRecheck(key: string, checksum: string): void {
    this.#driftAtSourceRead = { key, checksum, read: this.#requiredSourceKeySelects + 2 };
  }

  #selectRows(table: unknown, selection: Row, predicate?: SQL): readonly Row[] {
    this.fixture.onSelect?.(table);
    if (table === dataSources) {
      if (!Object.hasOwn(selection, "key")) {
        return [{ metadata: { modelVersion: "retained-version" } }];
      }
      this.#requiredSourceKeySelects += 1;
      const scheduledDrift = this.#driftAtSourceRead;
      if (scheduledDrift && this.#requiredSourceKeySelects >= scheduledDrift.read) {
        return this.#sources.map((row) =>
          row.key === scheduledDrift.key ? { ...row, lastChecksum: scheduledDrift.checksum } : row,
        );
      }
      // `#selectSources` performs the first read (at the start of the refresh, once sources are
      // validated); the service's own end-of-assembly epoch recheck performs every read after
      // that. Drifting only from the second read onward reproduces a source that changes
      // concurrently after this run already captured its start epoch.
      const patch = this.fixture.driftSourceAfterRead;
      if (patch && this.#requiredSourceKeySelects >= patch.minimumRead) {
        return this.#sources.map((row) =>
          row.key === patch.key ? { ...row, ...patch.patch } : row,
        );
      }
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
      if (this.fixture.reuseRecordedRuns) {
        const params = predicate ? new PgDialect().sqlToQuery(predicate).params : [];
        const recorded = this.modelRuns.findLast((run) => params.includes(run.inputChecksum));
        return recorded ? [recorded] : [];
      }
      const run = (this.fixture.priorRuns ??
        (this.fixture.priorRun ? [this.fixture.priorRun] : []))[this.#priorRunReads++];
      return run ? [{ ...run }] : [];
    }
    const priorRun = this.fixture.priorRuns?.[this.#priorRunReads - 1] ?? this.fixture.priorRun;
    if (table === projectionObservations) {
      return [{ count: priorRun?.rawRows ?? 0 }];
    }
    if (table === projectionSets) {
      return (priorRun?.leagueSetIds ?? []).map((id) => ({ id }));
    }
    if (table === playerProjections) {
      return Object.hasOwn(selection, "count") ? [{ count: priorRun?.leagueRows ?? 0 }] : [];
    }
    throw new Error(`Unexpected projection test select: ${Object.keys(selection).join(",")}`);
  }

  #insertRows(table: unknown, values: unknown): readonly Row[] {
    this.fixture.onInsert?.(table);
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
    if (table === syncRuns) this.syncRunUpdates.push(values as Row);
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
  const update = harness.sourceUpdates.filter((row) => Object.hasOwn(row, "metadata")).at(-1);
  if (!update || typeof update.metadata !== "object" || update.metadata === null) {
    throw new Error("Projection service did not record source metadata");
  }
  return update.metadata as Row;
}

describe("first-party projection service release safety", () => {
  it("rejects a refresh that crosses kickoff during training before it can publish", async () => {
    let now = new Date("2026-09-13T16:59:00Z");
    const harness = new ProjectionDatabaseHarness({ now, schedule: scheduleFixture() });
    const originalBacktest = projectionModel.runFirstPartyProjectionBacktest;
    vi.spyOn(projectionModel, "runFirstPartyProjectionBacktest").mockImplementation((...args) => {
      const result = originalBacktest(...args);
      now = new Date("2026-09-13T17:00:01Z");
      return result;
    });
    const service = new FirstPartyProjectionService({ database: harness.database, now: () => now });
    await expect(
      service.refreshProjections({ season: 2026, week: 1 }, jobContext()),
    ).rejects.toMatchObject({ code: "PROJECTION_INPUT_EPOCH_CHANGED" });
    expect(harness.syncRunInsertAttempts).toBe(0);
    expect(harness.modelRuns).toHaveLength(0);
    expect(harness.sourceUpdates.at(-1)?.lastCheckedAt).toEqual(now);
  });

  it("rejects a clock boundary crossed after the fresh planning clock", async () => {
    let now = new Date("2026-09-13T16:59:00Z");
    const harness = new ProjectionDatabaseHarness({ now, schedule: scheduleFixture() });
    const originalProjection = projectionModel.projectFirstPartyTeamDefenseComponents;
    vi.spyOn(projectionModel, "projectFirstPartyTeamDefenseComponents").mockImplementation(
      (...args) => {
        const result = originalProjection(...args);
        now = new Date("2026-09-13T17:00:01Z");
        return result;
      },
    );
    await expect(
      new FirstPartyProjectionService({
        database: harness.database,
        now: () => now,
      }).refreshProjections({ season: 2026, week: 1 }, jobContext()),
    ).rejects.toMatchObject({ code: "PROJECTION_INPUT_EPOCH_CHANGED" });
    expect(harness.syncRunInsertAttempts).toBe(0);
    expect(harness.modelRuns).toHaveLength(0);
  });

  it("checks the clock again after a database write instead of completing a stale plan", async () => {
    let now = new Date("2026-09-13T16:59:00Z");
    const harness = new ProjectionDatabaseHarness({
      now,
      schedule: scheduleFixture(),
      onInsert: (table) => {
        if (table === syncRuns) now = new Date("2026-09-13T17:00:01Z");
      },
    });
    const service = new FirstPartyProjectionService({ database: harness.database, now: () => now });
    await expect(
      service.refreshProjections({ season: 2026, week: 1 }, jobContext()),
    ).rejects.toMatchObject({ code: "PROJECTION_INPUT_EPOCH_CHANGED" });
    expect(harness.syncRunInsertAttempts).toBe(1);
    expect(harness.modelRuns).toHaveLength(0);
    expect(harness.syncRunUpdates).toHaveLength(0);
    // This fake proves the thrown fence. The PostgreSQL suite proves transactional rollback.
  });

  it("records the fresh planning/publication time separately from refresh start", async () => {
    const evaluationStartedAt = new Date("2026-09-01T12:00:00Z");
    let now = evaluationStartedAt;
    const plannedAt = new Date("2026-09-01T12:01:00Z");
    const harness = new ProjectionDatabaseHarness({ now, schedule: scheduleFixture() });
    const originalBacktest = projectionModel.runFirstPartyProjectionBacktest;
    vi.spyOn(projectionModel, "runFirstPartyProjectionBacktest").mockImplementation((...args) => {
      const result = originalBacktest(...args);
      now = plannedAt;
      return result;
    });
    await new FirstPartyProjectionService({
      database: harness.database,
      now: () => now,
    }).refreshProjections({ season: 2026, week: 1 }, jobContext());
    expect(harness.modelRuns[0]?.createdAt).toEqual(plannedAt);
    expect(harness.modelRuns[0]?.configuration).toMatchObject({
      publicationClock: {
        evaluationStartedAt: evaluationStartedAt.toISOString(),
        plannedAt: plannedAt.toISOString(),
        publicationStartedAt: plannedAt.toISOString(),
      },
    });
    expect(harness.syncRunUpdates.at(-1)?.finishedAt).toEqual(plannedAt);
    expect(latestSourceMetadata(harness).lastEvaluationAt).toBe(plannedAt.toISOString());
  });

  it("records a coverage failure when a completed prior week is missing from training", async () => {
    const now = new Date("2026-09-16T12:00:00Z");
    const prior = scheduleFixture().map((row) => ({
      ...row,
      status: "final",
      awayScore: 10,
      homeScore: 17,
    }));
    const next = scheduleFixture().map((row) => ({
      ...row,
      week: 2,
      gameId: String(row.gameId).replace("_01_", "_02_"),
      kickoffAt: new Date("2026-09-20T17:00:00Z"),
    }));
    const harness = new ProjectionDatabaseHarness({ now, schedule: [...prior, ...next] });
    await new FirstPartyProjectionService({
      database: harness.database,
      now: () => now,
    }).refreshProjections({ season: 2026, week: 2 }, jobContext());
    const metrics = harness.modelRuns[0]?.metrics as { gate?: { reasons?: string[] } };
    expect(metrics.gate?.reasons?.join(" ")).toContain(
      "Forecast history has not advanced through 2026 Week 1",
    );
    expect(harness.modelRuns[0]?.playersPublished).toBe(0);
  });
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

  it.each(["publishable", "rejected"] as const)(
    "preserves the publication timestamp when complete league output has a %s reference gate",
    async (qualityState) => {
      const now = new Date("2026-09-01T12:00:00.000Z");
      const publishedAt = new Date("2026-09-01T10:15:00.000Z");
      const harness = new ProjectionDatabaseHarness({
        now,
        schedule: scheduleFixture(),
        priorRun: {
          sourceSyncRunId: "prior-sync-run",
          playersPublished: 0,
          qualityState,
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
      const service = new FirstPartyProjectionService({
        database: harness.database,
        now: () => now,
      });

      await service.refreshProjections({ season: 2026, week: 1 }, jobContext());

      expect(harness.syncRunInsertAttempts).toBe(0);
      expect(latestSourceMetadata(harness)).toMatchObject({
        lastPublishedAt: publishedAt.toISOString(),
        lastEvaluationAt: now.toISOString(),
        publishedWeeks: 0,
        result: "unchanged",
      });
    },
  );

  it("reuses complete adjacent weeks with different gates without treating them as corruption", async () => {
    const now = new Date("2026-09-01T12:00:00.000Z");
    const publishedAt = new Date("2026-09-01T10:15:00.000Z");
    const harness = new ProjectionDatabaseHarness({
      now,
      schedule: [
        ...scheduleFixture(),
        ...scheduleFixture().map((row) => ({
          ...row,
          week: 2,
          gameId: `${String(row.gameId)}-week-2`,
        })),
      ],
      priorRuns: [
        {
          sourceSyncRunId: "degraded-week-one",
          playersPublished: 0,
          qualityState: "degraded",
          createdAt: publishedAt,
          metrics: {
            gate: { reasons: ["scheduled_game_kickoff_unknown"] },
            leagues: { published: 0, rowsPublished: 0 },
          },
          rawRows: 0,
        },
        {
          sourceSyncRunId: "complete-week-two",
          playersPublished: 0,
          qualityState: "publishable",
          createdAt: publishedAt,
          metrics: { gate: { reasons: [] }, leagues: { published: 1, rowsPublished: 1 } },
          rawRows: 0,
          leagueSetIds: ["complete-week-two-set"],
          leagueRows: 1,
        },
      ],
    });
    const service = new FirstPartyProjectionService({ database: harness.database, now: () => now });

    await service.refreshProjections({ season: 2026 }, jobContext());

    expect(harness.syncRunInsertAttempts).toBe(0);
    expect(latestSourceMetadata(harness)).toMatchObject({
      qualityState: "degraded",
      qualityReasons: "scheduled_game_kickoff_unknown",
      lastPublishedAt: publishedAt.toISOString(),
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
    expect(firstConfiguration?.inputEpoch?.version).toBe(WEEKLY_INPUT_SNAPSHOT_VERSION);
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

  it("closes repeatable-read assembly before acquiring publication input locks", async () => {
    const now = new Date("2026-09-01T12:00:00.000Z");
    const harness = new ProjectionDatabaseHarness({ now, schedule: scheduleFixture() });
    await new FirstPartyProjectionService({
      database: harness.database,
      now: () => now,
    }).refreshProjections({ season: 2026, week: 1 }, jobContext());
    expect(harness.transactionEvents[0]).toMatchObject({
      kind: "begin",
      isolationLevel: "repeatable read",
    });
    const firstEnd = harness.transactionEvents.findIndex((event) => event.kind === "end");
    const firstLock = harness.transactionEvents.findIndex((event) => event.kind === "lock");
    expect(firstLock).toBeGreaterThan(firstEnd);
    expect(
      harness.transactionEvents
        .filter((event) => event.kind === "lock")
        .every((event) => event.depth === 1),
    ).toBe(true);
    expect(harness.modelRuns[0]?.configuration).toMatchObject({
      inputSnapshot: {
        version: WEEKLY_INPUT_SNAPSHOT_VERSION,
        sourceManifest: {
          sources: expect.arrayContaining([
            {
              key: "nflverse.injuries.2026",
              required: false,
              selected: false,
              id: null,
              checksum: null,
              asOf: null,
            },
          ]) as unknown,
        },
      },
    });
  });

  it.each(["nflverse.weekly-rosters.2026", "nflverse.injuries.2026", "nflverse.snap-counts.2026"])(
    "retries an optional source changed after the early check: %s",
    async (key) => {
      const now = new Date("2026-09-01T12:00:00.000Z");
      const harness = new ProjectionDatabaseHarness({
        now,
        schedule: scheduleFixture(),
        optionalSources: [key],
        driftSourceAfterRead: { key, minimumRead: 3, patch: { lastChecksum: "f".repeat(64) } },
      });
      await expect(
        new FirstPartyProjectionService({
          database: harness.database,
          now: () => now,
        }).refreshProjections({ season: 2026, week: 1 }, jobContext()),
      ).rejects.toMatchObject({ code: "PROJECTION_INPUT_EPOCH_CHANGED" });
      expect(harness.syncRunInsertAttempts).toBe(0);
    },
  );

  it("retries a health-only source rejection at the publication fence", async () => {
    const now = new Date("2026-09-01T12:00:00.000Z");
    const key = "nflverse.injuries.2026";
    const harness = new ProjectionDatabaseHarness({
      now,
      schedule: scheduleFixture(),
      optionalSources: [key],
      driftSourceAfterRead: {
        key,
        minimumRead: 3,
        patch: { metadata: { availability: "not-published" } },
      },
    });
    await expect(
      new FirstPartyProjectionService({
        database: harness.database,
        now: () => now,
      }).refreshProjections({ season: 2026, week: 1 }, jobContext()),
    ).rejects.toMatchObject({ code: "PROJECTION_INPUT_EPOCH_CHANGED" });
    expect(harness.syncRunInsertAttempts).toBe(0);
  });

  it("retries a mutable catalog change that leaves source checksums unchanged", async () => {
    const now = new Date("2026-09-01T12:00:00.000Z");
    const harness = new ProjectionDatabaseHarness({
      now,
      schedule: scheduleFixture(),
      driftMutableChecksumAfterSnapshot: true,
    });
    await expect(
      new FirstPartyProjectionService({
        database: harness.database,
        now: () => now,
      }).refreshProjections({ season: 2026, week: 1 }, jobContext()),
    ).rejects.toMatchObject({ code: "PROJECTION_INPUT_EPOCH_CHANGED" });
    expect(harness.syncRunInsertAttempts).toBe(0);
  });

  it("allows refreshed check timestamps when admitted facts and mutable semantics stay equal", async () => {
    const now = new Date("2026-09-01T12:00:00.000Z");
    const harness = new ProjectionDatabaseHarness({
      now,
      schedule: scheduleFixture(),
      driftSourceAfterRead: {
        key: "nflverse.schedules.2026",
        minimumRead: 2,
        patch: { lastSuccessfulAt: now, lastCheckedAt: now },
      },
    });
    await expect(
      new FirstPartyProjectionService({
        database: harness.database,
        now: () => now,
      }).refreshProjections({ season: 2026, week: 1 }, jobContext()),
    ).resolves.toBeUndefined();
    expect(harness.modelRuns).toHaveLength(1);
  });

  it("rejects changed inputs without publishing and allows a stable retry to evaluate normally", async () => {
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

    await expect(
      service.refreshProjections({ season: 2026, week: 1 }, jobContext()),
    ).rejects.toMatchObject({
      message: "Weekly projection inputs changed during refresh",
      code: "PROJECTION_INPUT_EPOCH_CHANGED",
    });

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
    expect(harness.sourceUpdates.at(-1)?.lastErrorCode).toBe("PROJECTION_REFRESH_FAILED");

    // The replacement source remains stable on redelivery. A completed statistical evaluation
    // may genuinely withhold forecasts, but that is a normal result rather than a transient retry.
    await expect(
      service.refreshProjections({ season: 2026, week: 1 }, jobContext()),
    ).resolves.toBeUndefined();
    expect(harness.modelRuns).toHaveLength(1);
    expect(harness.modelRuns[0]?.qualityState).toBe("rejected");
    expect(latestSourceMetadata(harness).result).toBe("prior_good_output_preserved");
  });

  it("releases obsolete training before replacement allocation and cannot reuse it after a failed rebuild", async () => {
    const now = new Date("2026-09-01T12:00:00.000Z");
    const past = {
      ...scheduleFixture()[0]!,
      season: 2025,
      week: 18,
      gameId: "past-game",
      kickoffAt: new Date("2025-12-28T17:00:00Z"),
      status: "final",
      awayScore: 10,
      homeScore: 20,
    };
    const harness = new ProjectionDatabaseHarness({ now, schedule: [past, ...scheduleFixture()] });
    const service = new FirstPartyProjectionService({ database: harness.database, now: () => now });
    let yards = 80;
    vi.spyOn(projectionInputs, "buildFirstPartyPlayerHistory").mockImplementation(() => [
      {
        playerId: "receiver",
        position: "WR",
        season: 2025,
        week: 18,
        team: "BUF",
        components: { receiving_yards: yards },
      },
    ]);
    const build = vi.spyOn(projectionModel, "runFirstPartyProjectionBacktest");
    const clear = vi.spyOn(FirstPartyPublicationEvidenceMemo.prototype, "clear");
    const refresh = () => service.refreshProjections({ season: 2026, week: 1 }, jobContext());
    await refresh();
    const coldBuilds = build.mock.calls.length;
    const coldClears = clear.mock.calls.length;
    await refresh();
    expect(build).toHaveBeenCalledTimes(coldBuilds);
    expect(clear).toHaveBeenCalledTimes(coldClears);

    yards = 81;
    build.mockImplementationOnce(() => {
      expect(clear).toHaveBeenCalledTimes(coldClears + 1);
      throw new Error("Replacement allocation failed");
    });
    await expect(refresh()).rejects.toThrow("Replacement allocation failed");
    yards = 80;
    await refresh();
    // A failed cold replacement must not leave the old training object pinned or reusable.
    expect(build).toHaveBeenCalledTimes(coldBuilds + 2);
    const rebuilt = harness.modelRuns.at(-1);
    await refresh();
    expect(build).toHaveBeenCalledTimes(coldBuilds + 2);
    expect(harness.modelRuns.at(-1)).toStrictEqual(rebuilt);
  });

  it("reuses identical prior fits after source turnover but passes newly assembled completed histories to every publication", async () => {
    const now = new Date("2026-09-15T12:00:00Z");
    const week = (number: number, final: boolean) =>
      scheduleFixture().map((row) => ({
        ...row,
        week: number,
        gameId: `${String(row.gameId)}-${number}`,
        kickoffAt: new Date(final ? "2026-09-13T17:00:00Z" : "2026-09-27T17:00:00Z"),
        status: final ? "final" : "scheduled",
        awayScore: final ? 10 : null,
        homeScore: final ? 20 : null,
      }));
    const harness = new ProjectionDatabaseHarness({
      now,
      schedule: [...week(1, true), ...week(2, false), ...week(3, true), ...week(4, false)],
      optionalSources: [
        "nflverse.injuries.2026",
        "nflverse.weekly-rosters.2026",
        "nflverse.stats-player-week.2026",
        "nflverse.stats-team-week.2026",
      ],
    });
    let laterYards = 80;
    let laterPointsAllowed = 20;
    let priorEspnPointsAllowed = 23;
    const observedDefenseZeros = Object.fromEntries(
      projectionModel
        .firstPartyTeamDefenseProjectionComponents()
        .map((component) => [component, 0]),
    );
    vi.spyOn(projectionInputs, "buildFirstPartyPlayerHistory").mockImplementation(() => [
      {
        playerId: "receiver",
        position: "WR",
        season: 2026,
        week: 1,
        team: "BUF",
        components: { receiving_yards: 70 },
      },
      {
        playerId: "receiver",
        position: "WR",
        season: 2026,
        week: 3,
        team: "BUF",
        components: { receiving_yards: laterYards },
      },
    ]);
    const assembleDefense = vi
      .spyOn(projectionInputs, "buildFirstPartyDefenseHistory")
      .mockImplementation((_rows, _schedule, definition) => [
        {
          team: "BUF",
          opponent: "MIA",
          season: 2026,
          week: 1,
          pointsAllowedDefinition: definition,
          components: {
            ...observedDefenseZeros,
            points_allowed: definition === "espn-2019-v1" ? priorEspnPointsAllowed : 17,
          },
        },
        {
          team: "BUF",
          opponent: "MIA",
          season: 2026,
          week: 3,
          pointsAllowedDefinition: definition,
          components: {
            ...observedDefenseZeros,
            points_allowed: laterPointsAllowed + (definition === "espn-2019-v1" ? 6 : 0),
          },
        },
      ]);
    const fit = vi.spyOn(projectionModel, "runFirstPartyProjectionBacktest");
    const defenseFit = vi.spyOn(projectionModel, "runFirstPartyTeamDefenseBacktest");
    const service = new FirstPartyProjectionService({ database: harness.database, now: () => now });
    const publish = vi.spyOn(service, "publishPreparedWeek").mockResolvedValue({
      committed: true,
      published: true,
      gate: { state: "publishable", reasons: [] },
    });
    await service.refreshProjections({ season: 2026 }, jobContext());
    const first = publish.mock.calls.at(-1)![0];
    expect(first.week).toBe(4);
    expect(fit).toHaveBeenCalledTimes(1);
    for (const key of [
      "nflverse.injuries.2026",
      "nflverse.weekly-rosters.2026",
      "nflverse.stats-player-week.2026",
    ])
      harness.setSourceChecksum(key, "f".repeat(64));
    laterYards = 100;
    laterPointsAllowed = 30;
    await service.refreshProjections({ season: 2026 }, jobContext());
    const second = publish.mock.calls.at(-1)![0];
    expect(fit).toHaveBeenCalledTimes(1);
    expect(defenseFit).toHaveBeenCalledTimes(2);
    expect(assembleDefense.mock.calls.map((args) => args[2])).toEqual([
      "yahoo-2022-v1",
      "espn-2019-v1",
      "yahoo-2022-v1",
      "espn-2019-v1",
    ]);
    expect(
      second.defenseVariants?.["espn-2019-v1"]?.history.at(-1)?.components.points_allowed,
    ).toBe(36);
    expect(first.defenseVariants?.["espn-2019-v1"]?.history.at(-1)?.components.points_allowed).toBe(
      26,
    );
    expect(second.defenseVariants?.["espn-2019-v1"]?.backtest).toBe(
      first.defenseVariants?.["espn-2019-v1"]?.backtest,
    );
    expect(second.basePlayerBacktest).toBe(first.basePlayerBacktest);
    expect(second.playerHistory).not.toBe(first.playerHistory);
    expect(second.playerHistory.at(-1)?.components.receiving_yards).toBe(100);
    expect(first.playerHistory.at(-1)?.components.receiving_yards).toBe(80);
    expect(second.defenseHistory.at(-1)?.components.points_allowed).toBe(30);
    expect(first.defenseHistory.at(-1)?.components.points_allowed).toBe(20);
    expect(second.inputChecksum).not.toBe(first.inputChecksum);
    expect(second.inputSnapshot?.sourceManifest.checksum).not.toBe(
      first.inputSnapshot?.sourceManifest.checksum,
    );
    priorEspnPointsAllowed = 24;
    harness.setSourceChecksum("nflverse.stats-team-week.2026", "e".repeat(64));
    await service.refreshProjections({ season: 2026 }, jobContext());
    const third = publish.mock.calls.at(-1)![0];
    expect(fit).toHaveBeenCalledTimes(1);
    expect(defenseFit).toHaveBeenCalledTimes(3);
    expect(third.basePlayerBacktest).toBe(second.basePlayerBacktest);
    expect(third.defenseBacktest).toBe(second.defenseBacktest);
    expect(third.defenseVariants?.["espn-2019-v1"]?.backtest).not.toBe(
      second.defenseVariants?.["espn-2019-v1"]?.backtest,
    );
    expect(defenseFit.mock.calls[2]?.[0][0]?.pointsAllowedDefinition).toBe("espn-2019-v1");
    expect(defenseFit.mock.calls[2]?.[0][0]?.components.points_allowed).toBe(24);
  });

  it("still rejects source drift during a warm fit before publishing", async () => {
    const now = new Date("2026-09-01T12:00:00Z");
    const harness = new ProjectionDatabaseHarness({ now, schedule: scheduleFixture() });
    const service = new FirstPartyProjectionService({ database: harness.database, now: () => now });
    const fit = vi.spyOn(projectionModel, "runFirstPartyProjectionBacktest");
    await service.refreshProjections({ season: 2026, week: 1 }, jobContext());
    expect(harness.modelRuns).toHaveLength(1);
    harness.driftOnNextSourceRecheck("nflverse.stats-player-week.2025", "f".repeat(64));
    await expect(
      service.refreshProjections({ season: 2026, week: 1 }, jobContext()),
    ).rejects.toMatchObject({ code: "PROJECTION_INPUT_EPOCH_CHANGED" });
    expect(fit).toHaveBeenCalledTimes(1);
    expect(harness.modelRuns).toHaveLength(1);
  });

  it("invalidates completed output reuse at the prior-week coverage deadline", async () => {
    let now = new Date("2026-09-14T00:59:00Z");
    const next = scheduleFixture().map((row) => ({
      ...row,
      week: 2,
      gameId: `${String(row.gameId)}-2`,
      kickoffAt: new Date("2026-09-20T17:00:00Z"),
    }));
    const harness = new ProjectionDatabaseHarness({
      now,
      reuseRecordedRuns: true,
      schedule: [...scheduleFixture(), ...next],
    });
    const service = new FirstPartyProjectionService({ database: harness.database, now: () => now });
    await service.refreshProjections({ season: 2026, week: 2 }, jobContext());
    await service.refreshProjections({ season: 2026, week: 2 }, jobContext());
    expect(harness.modelRuns).toHaveLength(1);
    now = new Date("2026-09-14T01:01:00Z");
    await service.refreshProjections({ season: 2026, week: 2 }, jobContext());
    expect(harness.modelRuns).toHaveLength(2);
    expect(harness.modelRuns[1]?.inputChecksum).not.toBe(harness.modelRuns[0]?.inputChecksum);
    expect(harness.modelRuns[1]?.metrics).toMatchObject({
      gate: {
        reasons: expect.arrayContaining([
          expect.stringContaining("status is unresolved"),
        ]) as unknown,
      },
    });
  });

  it("rejects a coverage deadline crossed while rechecking reusable output", async () => {
    let now = new Date("2026-09-14T00:59:00Z");
    let crossDuringReuse = false;
    const next = scheduleFixture().map((row) => ({
      ...row,
      week: 2,
      gameId: `${String(row.gameId)}-2`,
      kickoffAt: new Date("2026-09-20T17:00:00Z"),
    }));
    const harness = new ProjectionDatabaseHarness({
      now,
      reuseRecordedRuns: true,
      schedule: [...scheduleFixture(), ...next],
      onSelect: (table) => {
        if (crossDuringReuse && table === projectionModelRuns)
          now = new Date("2026-09-14T01:01:00Z");
      },
    });
    const service = new FirstPartyProjectionService({ database: harness.database, now: () => now });
    await service.refreshProjections({ season: 2026, week: 2 }, jobContext());
    crossDuringReuse = true;
    await expect(
      service.refreshProjections({ season: 2026, week: 2 }, jobContext()),
    ).rejects.toMatchObject({ code: "PROJECTION_INPUT_EPOCH_CHANGED" });
    expect(harness.modelRuns).toHaveLength(1);
    expect(harness.sourceUpdates.at(-1)?.lastCheckedAt).toEqual(now);
  });

  it("refreshes an explicit future week when prior-week finality advances on the clock alone", async () => {
    let now = new Date("2026-09-13T20:59:00Z");
    const first = scheduleFixture().map((row) => ({
      ...row,
      status: "final",
      awayScore: 10,
      homeScore: 20,
    }));
    const next = scheduleFixture().map((row) => ({
      ...row,
      week: 2,
      gameId: `${String(row.gameId)}-2`,
      kickoffAt: new Date("2026-09-20T17:00:00Z"),
    }));
    const harness = new ProjectionDatabaseHarness({
      now,
      schedule: [...first, ...next],
      reuseRecordedRuns: true,
    });
    vi.spyOn(projectionInputs, "buildFirstPartyPlayerHistory").mockReturnValue([
      {
        playerId: "receiver",
        position: "WR",
        team: "BUF",
        season: 2026,
        week: 1,
        components: { receiving_yards: 80 },
      },
    ]);
    const fit = vi.spyOn(projectionModel, "runFirstPartyProjectionBacktest");
    const service = new FirstPartyProjectionService({ database: harness.database, now: () => now });
    await service.refreshProjections({ season: 2026, week: 2 }, jobContext());
    const before = harness.modelRuns[0];
    expect(fit.mock.calls[0]?.[0]).toEqual([]);
    // With the same complete persisted output and unchanged clock, the early return still works.
    await service.refreshProjections({ season: 2026, week: 2 }, jobContext());
    expect(harness.modelRuns).toHaveLength(1);
    expect(fit).toHaveBeenCalledTimes(1);
    now = new Date("2026-09-13T21:01:00Z");
    await service.refreshProjections({ season: 2026, week: 2 }, jobContext());
    expect(harness.modelRuns).toHaveLength(2);
    expect(harness.modelRuns[1]?.inputChecksum).not.toBe(before?.inputChecksum);
    expect(fit).toHaveBeenCalledTimes(2);
    expect(fit.mock.calls[1]?.[0]).toMatchObject([{ season: 2026, week: 1 }]);
  });
});
