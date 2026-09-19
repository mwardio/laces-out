/**
 * Real disposable-PostgreSQL transaction tests for the weekly first-party projection publisher.
 *
 * `first-party-projection-service.test.ts` exercises `FirstPartyProjectionService` against an
 * in-memory Drizzle-shaped harness: every `select`/`insert`/`update` is a hand-written fake, and
 * its fake `transaction()` never rolls back and its fake unique-index conflicts are just flags the
 * test sets (`publishConflict: true`). That harness cannot prove the persist function's actual
 * safety contract - that `sync_runs_idempotency_unique`, the `projection_model_runs` target/
 * checksum unique index, and the surrounding `database.transaction(...)` really enforce
 * idempotency and atomicity once they hit real PostgreSQL.
 *
 * This file starts a disposable, single-use PostgreSQL 17 container (never the ambient/default
 * `DATABASE_URL`), applies every migration in `packages/db/migrations` with Drizzle's own
 * postgres-js migrator, and then exercises the same service against the real database:
 *
 *  - sequential idempotent re-publication with exact row-count verification;
 *  - a genuine mid-transaction failure (a real BEFORE INSERT trigger raising an exception) rolling
 *    back every row the transaction had already written;
 *  - two concurrent workers racing the same publish attempt, which resolves through the real
 *    `sync_runs_idempotency_unique` index instead of any fixture flag;
 *  - migration `0016_familiar_firebrand.sql` applying cleanly on top of 0001-0015 and creating the
 *    rest-of-season invariants it introduces.
 *
 * Safety: the container is created with an explicit, freshly generated, task-specific connection
 * string on a docker-assigned host port. No code here reads `process.env.DATABASE_URL` or any
 * `.env` file, and the container is force-removed in `afterAll` even if setup or a test throws.
 * The suite skips itself cleanly (via `describe.skipIf`) when docker is unavailable, so CI
 * environments without docker still pass.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { serialize } from "node:v8";

import {
  createDatabase,
  dataSources,
  leagues,
  leagueSeasons,
  nflScheduleObservations,
  playerProjections,
  players,
  projectionModelRuns,
  projectionObservations,
  projectionSets,
  syncRuns,
  users,
} from "@laces-out/db";
import type { Database } from "@laces-out/db";
import {
  applyFirstPartyProjectionChampionPolicy,
  runFirstPartyProjectionBacktest,
  runFirstPartyTeamDefenseBacktest,
} from "@laces-out/projections";
import { and, count, eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../../../packages/db/src/schema.js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NFLVERSE_WEEKLY_STATS_COMPONENT_SCHEMA } from "@laces-out/source-nflverse";
import { databaseFirstPartyRosCandidateProvider } from "./first-party-ros-candidate-provider.js";
import { FirstPartyProjectionProcess } from "./first-party-projection-process.js";

import {
  FIRST_PARTY_PROJECTION_SOURCE_KEY,
  FirstPartyProjectionService,
  requiredFirstPartyProjectionSourceKeys,
} from "./first-party-projections.js";

function dockerIsAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const dockerAvailable = dockerIsAvailable();

if (!dockerAvailable) {
  console.warn(
    "[first-party-projection-service.pg.test] Skipping disposable-PostgreSQL transaction tests: " +
      "docker is not available in this environment.",
  );
}

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

// A fixed, never-real season keeps this suite's data isolated from anything else that might ever
// touch a shared fixture database, and each test below uses a distinct week within it.
const TEST_SEASON = 2031;
const FIXED_NOW = new Date("2031-09-01T12:00:00.000Z");

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

function checksumFor(key: string): string {
  return createHash("sha256").update(`pg-test:${key}`, "utf8").digest("hex");
}

interface DisposablePostgres {
  readonly containerName: string;
  readonly url: string;
}

async function startDisposablePostgres(): Promise<DisposablePostgres> {
  const containerName = `laces-out-pg-test-${randomUUID().slice(0, 8)}`;
  const user = "laces_test";
  const password = randomBytes(16).toString("hex");
  const databaseName = "laces_test";

  execFileSync(
    "docker",
    [
      "run",
      "-d",
      "--rm",
      "--name",
      containerName,
      "--tmpfs",
      "/var/lib/postgresql/data",
      "-e",
      `POSTGRES_USER=${user}`,
      "-e",
      `POSTGRES_PASSWORD=${password}`,
      "-e",
      `POSTGRES_DB=${databaseName}`,
      "-p",
      "127.0.0.1::5432",
      "postgres:17-alpine",
    ],
    { stdio: "ignore" },
  );

  // Wait for the server process itself to report ready inside the container.
  const readyDeadline = Date.now() + 30_000;
  for (;;) {
    try {
      execFileSync(
        "docker",
        ["exec", containerName, "pg_isready", "-U", user, "-d", databaseName],
        {
          stdio: "ignore",
        },
      );
      break;
    } catch {
      if (Date.now() > readyDeadline) {
        throw new Error(
          `Disposable PostgreSQL container ${containerName} did not become ready in time`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }

  const portMapping = execFileSync("docker", ["port", containerName, "5432/tcp"], {
    encoding: "utf8",
  }).trim();
  const port = Number(portMapping.split(":").pop());
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Could not determine the published host port for ${containerName}`);
  }

  const url = `postgres://${user}:${password}@127.0.0.1:${port}/${databaseName}`;

  // The host TCP listener can lag slightly behind pg_isready inside the container.
  const connectDeadline = Date.now() + 20_000;
  for (;;) {
    const probe = postgres(url, { max: 1, prepare: false, connect_timeout: 2 });
    try {
      await probe`select 1`;
      await probe.end({ timeout: 1 });
      break;
    } catch (error) {
      await probe.end({ timeout: 1 }).catch(() => {});
      if (Date.now() > connectDeadline) {
        throw new Error(
          `Could not connect to ${containerName} via its published port: ${String(error)}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }

  return { containerName, url };
}

function jobContext() {
  return { jobId: `pg-test-${randomUUID()}`, signal: new AbortController().signal } as const;
}

async function seedRequiredSources(db: Database, season: number, now: Date): Promise<void> {
  const keys = requiredFirstPartyProjectionSourceKeys(season).required;
  await db
    .insert(dataSources)
    .values(
      keys.map((key) => ({
        key,
        name: `pg-test source ${key}`,
        kind: "pg-test-source",
        checkIntervalMinutes: 60,
        lastChecksum: checksumFor(key),
        lastSuccessfulAt: new Date(now.getTime() - 5 * 60_000),
        lastCheckedAt: new Date(now.getTime() - 5 * 60_000),
        consecutiveFailures: 0,
        metadata: { availability: "available", publishable: true },
      })),
    )
    .onConflictDoNothing({ target: dataSources.key });
}

async function seedWeekSchedule(
  db: Database,
  input: { readonly season: number; readonly week: number; readonly now: Date },
): Promise<void> {
  const [scheduleSource] = await db
    .select({ id: dataSources.id })
    .from(dataSources)
    .where(eq(dataSources.key, `nflverse.schedules.${input.season}`))
    .limit(1);
  if (!scheduleSource) throw new Error("Schedule source was not seeded before the schedule rows");

  const [ingestRun] = await db
    .insert(syncRuns)
    .values({
      kind: "pg-test-schedule-ingest",
      state: "complete",
      idempotencyKey: `pg-test-schedule-ingest:${input.season}:${input.week}:${randomUUID()}`,
      startedAt: input.now,
      finishedAt: input.now,
    })
    .returning({ id: syncRuns.id });
  if (!ingestRun) throw new Error("Failed to seed the schedule ingest sync run");

  const kickoffAt = new Date(input.now.getTime() + 4 * 24 * 60 * 60 * 1000);
  const gameDate = kickoffAt.toISOString().slice(0, 10);
  const inputChecksum = checksumFor(`nflverse.schedules.${input.season}`);
  const games = Array.from({ length: nflTeams.length / 2 }, (_, index) => ({
    externalGameId:
      `${input.season}_${String(input.week).padStart(2, "0")}_` +
      `${nflTeams[index * 2]}_${nflTeams[index * 2 + 1]}_${randomUUID().slice(0, 8)}`,
    awayTeam: nflTeams[index * 2] as string,
    homeTeam: nflTeams[index * 2 + 1] as string,
  }));

  await db.insert(nflScheduleObservations).values(
    games.map((game) => ({
      sourceId: scheduleSource.id,
      sourceSyncRunId: ingestRun.id,
      externalGameId: game.externalGameId,
      season: input.season,
      week: input.week,
      seasonType: "REG" as const,
      gameDate,
      startTimeEastern: "13:00",
      timeTbd: false,
      kickoffAt,
      awayTeam: game.awayTeam,
      homeTeam: game.homeTeam,
      status: "scheduled" as const,
      neutralSite: false,
      awayRestDays: 7,
      homeRestDays: 7,
      awayScore: null,
      homeScore: null,
      sourceAsOf: input.now,
      fetchedAt: input.now,
      inputChecksum,
    })),
  );
}

async function modelRunCount(db: Database, season: number, week: number): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(projectionModelRuns)
    .where(and(eq(projectionModelRuns.season, season), eq(projectionModelRuns.targetWeek, week)));
  return row?.value ?? 0;
}

async function modelRunRow(db: Database, season: number, week: number) {
  const [row] = await db
    .select()
    .from(projectionModelRuns)
    .where(and(eq(projectionModelRuns.season, season), eq(projectionModelRuns.targetWeek, week)))
    .limit(1);
  return row;
}

async function preparedScoredWeek(db: Database) {
  const season = TEST_SEASON + 10;
  const now = new Date("2041-09-01T12:00:00.000Z");
  const [owner] = await db
    .insert(users)
    .values({ email: `weekly-gate-${randomUUID()}@example.test`, displayName: "Weekly test" })
    .returning();
  const [league] = await db
    .insert(leagues)
    .values({ ownerUserId: owner!.id, name: "Receiving yards league" })
    .returning();
  const [leagueSeason] = await db
    .insert(leagueSeasons)
    .values({
      leagueId: league!.id,
      provider: "espn",
      externalKey: randomUUID(),
      season,
      teamCount: 12,
      draftType: "snake",
      currentWeek: 1,
    })
    .returning();
  const [player] = await db
    .insert(players)
    .values({
      gsisId: `pg-${randomUUID()}`,
      fullName: "Weekly Receiver",
      nflTeam: "BUF",
      primaryPosition: "WR",
      eligiblePositions: ["WR"],
      lastSeason: season,
    })
    .returning();
  const [source] = await db
    .insert(dataSources)
    .values({
      key: `weekly-publication-${randomUUID()}`,
      name: "Weekly publication",
      kind: "projection",
    })
    .returning();
  const profile = { id: "yards", rules: [{ statId: "receiving_yards", points: 0.1 }] };
  // Locked component predictions with a stable, symmetric error distribution and a weaker
  // recency challenger. No database test injects a passing gate or bypasses the league scorer.
  const backtest = {
    ...runFirstPartyProjectionBacktest([]),
    predictions: Array.from({ length: 20 }, (_, batch) => {
      let state = 4 + batch * 5;
      const rawErrors = Array.from({ length: 12 }, () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return (((value ^ (value >>> 14)) >>> 0) / 4294967296 - 0.5) * 12;
      });
      const center = rawErrors.reduce((sum, value) => sum + value, 0) / rawErrors.length;
      return rawErrors.map((rawError, index) => {
        const error = rawError - center;
        // Distinct player roles preserve a useful signal beneath the forecast noise; otherwise
        // affine calibration correctly learns the artificial constant eight-point outcome.
        const actual = 80 + index * 15;
        return {
          playerId: `held-out-${index}`,
          position: "WR" as const,
          season: season - 2 + Math.floor(batch / 10),
          week: (batch % 10) + 1,
          actual: { receiving_yards: actual },
          predicted: { receiving_yards: actual - error * 10 },
          baseline: { receiving_yards: actual - error * 12.5 },
          floor: { receiving_yards: actual - 80 },
          ceiling: { receiving_yards: actual + 80 },
          trainingRows: 48,
          calibrationRows: 48,
        };
      });
    }).flat(),
  };
  const input = {
    sourceId: source!.id,
    season,
    week: 1,
    now,
    sourceAsOf: now,
    inputChecksum: checksumFor(randomUUID()),
    inputEpoch: checksumFor("pinned-input-epoch"),
    gate: { state: "rejected" as const, reasons: ["defense_backtest_sample_too_small"] },
    playerHistory: [
      {
        playerId: player!.id,
        position: "WR",
        team: "BUF",
        season: season - 1,
        week: 18,
        played: true,
        components: { targets: 7, receptions: 5, receiving_yards: 80, receiving_touchdowns: 0.3 },
      },
    ],
    defenseHistory: [],
    playerBacktest: backtest,
    basePlayerBacktest: backtest,
    playerChampionPolicy: applyFirstPartyProjectionChampionPolicy(backtest, profile).policy,
    defenseBacktest: runFirstPartyTeamDefenseBacktest([]),
    players: [player!],
    statusByPlayer: new Map<string, readonly string[]>(),
    schedules: [
      {
        season,
        week: 1,
        gameId: `weekly-${randomUUID()}`,
        awayTeam: "BUF",
        homeTeam: "NYJ",
        awayScore: null,
        homeScore: null,
        kickoffAt: new Date("2041-09-05T17:00:00.000Z"),
        status: "scheduled" as const,
      },
    ],
    leagues: [leagueSeason!],
    rules: [
      {
        leagueSeasonId: leagueSeason!.id,
        statKey: "receiving_yards",
        providerStatId: "42",
        operation: "multiply",
        points: "0.1",
        thresholdLow: null,
        thresholdHigh: null,
        positionTypes: [],
      },
    ],
    rosters: [],
    leagueSeasonScopesByPlayer: new Map<string, readonly string[]>(),
    canonicalMatchByPlayer: new Map<string, string>(),
  } satisfies Parameters<FirstPartyProjectionService["publishPreparedWeek"]>[0];
  return { input, leagueSeason: leagueSeason!, player: player! };
}

// A bare JS `Date` interpolated into a raw Drizzle `sql` fragment is never routed through
// Drizzle's column-aware value mapping (which is what normally turns a `Date` into an ISO string
// for a plain `.set({ column: date })`), so postgres-js's parameter binder receives a raw `Date`
// object where it requires an already-serialized string/Buffer/ArrayBuffer and throws. This suite
// originally surfaced exactly that defect inside `#recordSourceSuccess`; the production fragment
// now serializes with `now.toISOString()`. The standalone reproduction below stays as a
// regression guard documenting why the explicit serialization is required — the in-memory harness
// can never see this class of failure because its fake `update()` just records the `.set()`
// values object without ever serializing or sending it.
const rawDateSqlFragmentBugPattern =
  /must be of type string or an instance of Buffer or ArrayBuffer/u;

// postgres-js/Drizzle wrap the underlying `TypeError` in a `DrizzleQueryError` whose own
// `.message` is just "Failed query: ...<sql text>..."; the informative message lives on `.cause`.
function deepestErrorMessage(error: unknown): string {
  let current: unknown = error;
  let message = error instanceof Error ? error.message : String(error);
  while (current instanceof Error && current.cause !== undefined) {
    current = current.cause;
    message = current instanceof Error ? current.message : String(current);
  }
  return message;
}

describe.skipIf(!dockerAvailable)(
  "FirstPartyProjectionService against a disposable PostgreSQL 17 database",
  () => {
    let container: DisposablePostgres;
    let mainHandle: ReturnType<typeof createDatabase>;
    let workerAHandle: ReturnType<typeof createDatabase>;
    let workerBHandle: ReturnType<typeof createDatabase>;

    beforeAll(async () => {
      container = await startDisposablePostgres();

      const migrationHandle = createDatabase(container.url, 1);
      try {
        await migrate(migrationHandle.db, { migrationsFolder });
      } finally {
        await migrationHandle.close();
      }

      mainHandle = createDatabase(container.url, 10);
      workerAHandle = createDatabase(container.url, 5);
      workerBHandle = createDatabase(container.url, 5);

      await seedRequiredSources(mainHandle.db, TEST_SEASON, FIXED_NOW);
    }, 60_000);

    afterAll(async () => {
      await Promise.allSettled([
        mainHandle?.close(),
        workerAHandle?.close(),
        workerBHandle?.close(),
      ]);
      if (container?.containerName) {
        try {
          execFileSync("docker", ["rm", "-f", "-v", container.containerName], {
            stdio: "ignore",
          });
        } catch {
          // Best-effort cleanup; the container was started with --rm, so it is unlikely to
          // linger even if this explicit removal fails for some reason.
        }
      }
    }, 30_000);

    it("applies migration 0016 cleanly on top of 0001-0015 and creates the ROS invariants it introduces", async () => {
      const columnRows = await mainHandle.db.execute<{ column_name: string }>(sql`
          select column_name
          from information_schema.columns
          where table_schema = 'public' and table_name = 'player_ros_projection_summaries'
        `);
      const columnNames = new Set(columnRows.map((row) => row.column_name));
      expect(columnNames.has("window_start_week")).toBe(true);
      expect(columnNames.has("scenario_count")).toBe(true);
      expect(columnNames.has("availability")).toBe(true);

      const indexRows = await mainHandle.db.execute<{ indexname: string }>(sql`
          select indexname
          from pg_indexes
          where tablename = 'player_ros_projection_summaries'
        `);
      const indexNames = new Set(indexRows.map((row) => row.indexname));
      expect(indexNames.has("player_ros_projection_summaries_identity_unique")).toBe(true);

      const triggerRows = await mainHandle.db.execute<{ tgname: string }>(sql`
          select tgname
          from pg_trigger
          where not tgisinternal and tgrelid = 'player_ros_projection_summaries'::regclass
        `);
      const triggerNames = new Set(triggerRows.map((row) => row.tgname));
      expect(triggerNames.has("player_ros_projection_summaries_scope_trigger")).toBe(true);
      expect(triggerNames.has("player_ros_projection_summaries_append_only_trigger")).toBe(true);

      const modelRunIndexRows = await mainHandle.db.execute<{ indexname: string }>(sql`
          select indexname from pg_indexes where tablename = 'projection_model_runs'
        `);
      const modelRunIndexNames = new Set(modelRunIndexRows.map((row) => row.indexname));
      expect(modelRunIndexNames.has("projection_model_runs_target_checksum_unique")).toBe(true);

      // Regression for migration 0018: a champion-artifact scoring-profile key is the full
      // canonical scoring-rules JSON (kilobytes, not a short identifier). The 0017 identity
      // check capped it at 256 characters and rejected the first real admission.
      const longScoringKey = JSON.stringify(
        Array.from({ length: 30 }, (_, index) => ({
          statId: `pg-test-stat-${index}`,
          points: index * 0.1,
          bonuses: [],
        })),
      );
      expect(longScoringKey.length).toBeGreaterThan(256);
      await mainHandle.db.execute(sql`
          insert into first_party_ros_champion_artifacts
            (season, scoring_profile_key, model_version, policy_version, calibration_version,
             evidence_through_season, source_checksums, policy, release_gate, artifact_checksum,
             admitted_at)
          values
            (2031, ${longScoringKey}, 'pg-test-model-v1', 'pg-test-policy-v1', 'pg-test-cal-v1',
             2030, ${'[{"key":"pg-test","checksum":"' + "a".repeat(64) + '"}]'}::jsonb,
             '{}'::jsonb, '{}'::jsonb, ${"b".repeat(64)}, ${FIXED_NOW.toISOString()})
        `);
      const artifactRows = await mainHandle.db.execute<{ count: string }>(sql`
          select count(*)::text as count from first_party_ros_champion_artifacts
          where season = 2031
        `);
      expect(artifactRows[0]?.count).toBe("1");
    }, 20_000);

    it("documents why raw sql fragments must serialize Dates explicitly (regression guard for the fixed #recordSourceSuccess defect)", async () => {
      // Minimal, standalone reproduction of the pattern that used to live in
      // `#recordSourceSuccess`: a raw `sql` CASE expression interpolating a bare JS `Date`
      // instead of `date.toISOString()`. The driver still rejects it — which is exactly why the
      // production fragment now serializes explicitly.
      const now = FIXED_NOW;
      await expect(
        mainHandle.db
          .update(dataSources)
          .set({
            lastChangedAt: sql`case when ${dataSources.lastChecksum} is distinct from ${"probe-checksum"} then ${now} else ${dataSources.lastChangedAt} end`,
          })
          .where(eq(dataSources.key, "nflverse.players")),
      ).rejects.toSatisfy((error: unknown) =>
        rawDateSqlFragmentBugPattern.test(deepestErrorMessage(error)),
      );

      // The fixed form — identical fragment with an explicit ISO serialization — succeeds.
      // `lastCheckedAt` moves together with it, as in the real service, to satisfy the
      // `data_sources_changed_at_check` ordering constraint.
      await mainHandle.db
        .update(dataSources)
        .set({
          lastCheckedAt: now,
          lastChangedAt: sql`case when ${dataSources.lastChecksum} is distinct from ${"probe-checksum"} then ${now.toISOString()} else ${dataSources.lastChangedAt} end`,
        })
        .where(eq(dataSources.key, "nflverse.players"));
    }, 10_000);

    it("rejects mixed play-by-play captures before either weekly or ROS can publish", async () => {
      const season = TEST_SEASON - 1;
      const sourceKey = `nflverse.stats-player-week.${season}`;
      const [original] = await mainHandle.db
        .select({ metadata: dataSources.metadata })
        .from(dataSources)
        .where(eq(dataSources.key, sourceKey));
      if (!original) throw new Error("Expected historical player source");
      const before = await modelRunCount(mainHandle.db, TEST_SEASON, 1);
      try {
        await mainHandle.db
          .update(dataSources)
          .set({
            metadata: {
              ...original.metadata,
              playerWeeklyComponentSchema: NFLVERSE_WEEKLY_STATS_COMPONENT_SCHEMA,
              playByPlayChecksumSha256: "a".repeat(64),
            },
          })
          .where(eq(dataSources.key, sourceKey));
        const service = new FirstPartyProjectionService({
          database: mainHandle.db,
          now: () => FIXED_NOW,
        });
        await expect(
          service.refreshProjections({ season: TEST_SEASON, week: 1 }, jobContext()),
        ).rejects.toThrow(/do not share a verified play-by-play capture/);
        const provider = databaseFirstPartyRosCandidateProvider({ database: mainHandle.db });
        await expect(
          provider.sourceChecksum({
            season: TEST_SEASON,
            window: {
              asOfWeek: 0,
              currentWeek: 1,
              windowStartWeek: 1,
              windowEndWeek: 18,
              currentWeekStarted: false,
            },
          }),
        ).rejects.toThrow(/do not share a verified play-by-play capture/);
        expect(await modelRunCount(mainHandle.db, TEST_SEASON, 1)).toBe(before);
      } finally {
        await mainHandle.db
          .update(dataSources)
          .set({ metadata: original.metadata })
          .where(eq(dataSources.key, sourceKey));
      }
    }, 20_000);

    it("persists an immutable audit run once and is idempotent on an exact rerun (real unique-index-backed count verification)", async () => {
      const week = 1;
      await seedWeekSchedule(mainHandle.db, { season: TEST_SEASON, week, now: FIXED_NOW });
      const service = new FirstPartyProjectionService({
        database: mainHandle.db,
        now: () => FIXED_NOW,
      });

      await service.refreshProjections({ season: TEST_SEASON, week }, jobContext());

      expect(await modelRunCount(mainHandle.db, TEST_SEASON, week)).toBe(1);
      const firstRun = await modelRunRow(mainHandle.db, TEST_SEASON, week);
      expect(firstRun).toBeDefined();
      // With no historical stat/roster/snap/injury observations seeded, the release gate has
      // zero backtest samples and must fail closed - the same "rejected, nothing published"
      // outcome the in-memory harness asserts for its equivalent no-history scenarios.
      expect(firstRun?.qualityState).toBe("rejected");
      expect(firstRun?.playersEvaluated).toBe(32); // one row per scheduled NFL team defense
      expect(firstRun?.playersPublished).toBe(0);
      const firstMetrics = firstRun?.metrics as { readonly leagues?: unknown } | undefined;
      expect(firstMetrics?.leagues).toMatchObject({
        eligible: 0,
        published: 0,
        rowsPublished: 0,
      });

      // With the serialization fix in place, `#recordSourceSuccess` completes against real
      // PostgreSQL and the managed source's health bookkeeping reflects a clean run.
      const [managedSourceAfterFirstRun] = await mainHandle.db
        .select({
          consecutiveFailures: dataSources.consecutiveFailures,
          lastErrorCode: dataSources.lastErrorCode,
          lastSuccessfulAt: dataSources.lastSuccessfulAt,
        })
        .from(dataSources)
        .where(eq(dataSources.key, FIRST_PARTY_PROJECTION_SOURCE_KEY))
        .limit(1);
      expect(managedSourceAfterFirstRun?.consecutiveFailures).toBe(0);
      expect(managedSourceAfterFirstRun?.lastErrorCode).toBeNull();
      expect(managedSourceAfterFirstRun?.lastSuccessfulAt).not.toBeNull();

      // Rerunning the exact same job must not create a second sync_runs/projection_model_runs
      // row: the service's own checksum-matched fast path takes over before it ever attempts a
      // second insert - real row-count verification, not a fixture flag.
      await service.refreshProjections({ season: TEST_SEASON, week }, jobContext());

      expect(await modelRunCount(mainHandle.db, TEST_SEASON, week)).toBe(1);
      const [managedSourceAfterSecondRun] = await mainHandle.db
        .select({ consecutiveFailures: dataSources.consecutiveFailures })
        .from(dataSources)
        .where(eq(dataSources.key, FIRST_PARTY_PROJECTION_SOURCE_KEY))
        .limit(1);
      expect(managedSourceAfterSecondRun?.consecutiveFailures).toBe(0);
    }, 20_000);

    it("rolls back every row a mid-transaction failure wrote, leaving no partial rows", async () => {
      const idempotencyKey = `pg-test-rollback:${randomUUID()}`;
      const [playersSource] = await mainHandle.db
        .select({ id: dataSources.id })
        .from(dataSources)
        .where(eq(dataSources.key, "nflverse.players"))
        .limit(1);
      if (!playersSource) throw new Error("Expected the nflverse.players source to be seeded");
      const sourceId = playersSource.id;

      const beforeSyncRuns = await mainHandle.db
        .select({ value: count() })
        .from(syncRuns)
        .where(eq(syncRuns.idempotencyKey, idempotencyKey));
      expect(beforeSyncRuns[0]?.value ?? 0).toBe(0);

      // This mirrors the exact insert order `#publishWeek` uses (sync_runs, then
      // projection_model_runs, inside one `database.transaction(...)` call), but the second
      // insert deliberately omits `target_week` while leaving `horizon` at its default `week`.
      // The real `normalize_weekly_projection_model_run_identity` BEFORE INSERT trigger raises
      // an exception for that combination, so this proves genuine PostgreSQL rollback of the
      // already-succeeded sync_runs insert - something the in-memory harness's fake
      // `transaction()` (which just invokes the callback and never undoes anything) cannot
      // verify at all.
      await expect(
        mainHandle.db.transaction(async (transaction) => {
          const [run] = await transaction
            .insert(syncRuns)
            .values({
              kind: "pg-test-rollback",
              state: "running",
              idempotencyKey,
              startedAt: FIXED_NOW,
            })
            .returning({ id: syncRuns.id });
          if (!run) throw new Error("Expected the rollback-probe sync run to be inserted");

          await transaction.insert(projectionModelRuns).values({
            sourceSyncRunId: run.id,
            sourceId,
            season: TEST_SEASON,
            // targetWeek intentionally omitted (null) while horizon stays 'week': the database
            // trigger must reject this, not the application.
            modelVersion: "pg-test-rollback-v1",
            trainingWindowStartSeason: TEST_SEASON - 3,
            trainedThroughSeason: TEST_SEASON - 1,
            trainedThroughWeek: null,
            qualityState: "rejected",
            playersEvaluated: 0,
            playersPublished: 0,
            inputChecksum: checksumFor("pg-test-rollback"),
            configuration: {},
            calibration: {},
            metrics: {},
            sourceAsOf: FIXED_NOW,
          });
        }),
      ).rejects.toThrow();

      const afterSyncRuns = await mainHandle.db
        .select({ value: count() })
        .from(syncRuns)
        .where(eq(syncRuns.idempotencyKey, idempotencyKey));
      expect(afterSyncRuns[0]?.value ?? 0).toBe(0);
    }, 20_000);

    it("leaves exactly one consistent result set when two concurrent workers race the same publish attempt", async () => {
      const week = 2;
      await seedWeekSchedule(mainHandle.db, { season: TEST_SEASON, week, now: FIXED_NOW });

      const serviceA = new FirstPartyProjectionService({
        database: workerAHandle.db,
        now: () => FIXED_NOW,
      });
      const serviceB = new FirstPartyProjectionService({
        database: workerBHandle.db,
        now: () => FIXED_NOW,
      });

      // Both workers observe the same, not-yet-published state and race to publish it. Real
      // PostgreSQL serializes the two `insert into sync_runs ... on conflict do nothing`
      // attempts on `sync_runs_idempotency_unique`: exactly one wins the row, the other sees the
      // conflict and no-ops - a genuine unique-index race, not a fixture flag.
      const results = await Promise.allSettled([
        serviceA.refreshProjections({ season: TEST_SEASON, week }, jobContext()),
        serviceB.refreshProjections({ season: TEST_SEASON, week }, jobContext()),
      ]);
      expect(results).toHaveLength(2);
      for (const result of results) {
        expect(result.status).toBe("fulfilled");
      }

      expect(await modelRunCount(mainHandle.db, TEST_SEASON, week)).toBe(1);
      const run = await modelRunRow(mainHandle.db, TEST_SEASON, week);
      expect(run?.qualityState).toBe("rejected");
      expect(run?.playersPublished).toBe(0);
    }, 20_000);

    it("atomically publishes an exact league's passing position despite a rejected reference profile", async () => {
      const fixture = await preparedScoredWeek(mainHandle.db);
      const service = new FirstPartyProjectionService({
        database: mainHandle.db,
        now: () => fixture.input.now,
      });
      const first = await service.publishPreparedWeek(fixture.input);
      const [run] = await mainHandle.db
        .select()
        .from(projectionModelRuns)
        .where(eq(projectionModelRuns.inputChecksum, fixture.input.inputChecksum));
      expect(first, JSON.stringify(run!.metrics.leagues)).toMatchObject({
        committed: true,
        published: true,
        gate: { state: "rejected" },
      });
      const sets = await mainHandle.db
        .select()
        .from(projectionSets)
        .where(eq(projectionSets.leagueSeasonId, fixture.leagueSeason.id));
      expect(sets).toHaveLength(1);
      expect(sets[0]!.metadata.publishedPositions).toEqual(["WR"]);
      const rows = await mainHandle.db
        .select()
        .from(playerProjections)
        .where(eq(playerProjections.projectionSetId, sets[0]!.id));
      expect(rows.map((row) => row.playerId)).toEqual([fixture.player.id]);
      expect(run!.qualityState).toBe("rejected");
      expect(run!.playersPublished).toBe(0);
      expect(run!.metrics.leagues).toMatchObject({ published: 1, rowsPublished: 1 });
      const raw = await mainHandle.db
        .select()
        .from(projectionObservations)
        .where(eq(projectionObservations.sourceSyncRunId, run!.sourceSyncRunId));
      expect(raw).toHaveLength(0);
      const second = await service.publishPreparedWeek(fixture.input);
      expect(second).toMatchObject({ committed: false, published: false });
      const repeatSets = await mainHandle.db
        .select()
        .from(projectionSets)
        .where(eq(projectionSets.leagueSeasonId, fixture.leagueSeason.id));
      expect(repeatSets).toHaveLength(1);
    }, 20_000);

    it("isolates a cold prepared publication without changing scored rows and keeps exact replay idempotent", async () => {
      // Distinct fixture source/league/player/checksum identities ensure the child cannot take
      // the direct invocation's completed-output fast path. Both actually compute and publish.
      const direct = await preparedScoredWeek(mainHandle.db);
      const isolated = await preparedScoredWeek(mainHandle.db);
      const service = new FirstPartyProjectionService({
        database: mainHandle.db,
        now: () => direct.input.now,
      });
      await service.publishPreparedWeek(direct.input);
      const directory = await mkdtemp(path.join(tmpdir(), "weekly-process-pg-"));
      const inputPath = path.join(directory, "input.bin");
      const entryPath = path.join(directory, "worker.mts");
      await writeFile(inputPath, serialize(isolated.input));
      const runtimeUrl = new URL("./first-party-projection-process-runtime.ts", import.meta.url)
        .href;
      const serviceUrl = new URL("./first-party-projections.ts", import.meta.url).href;
      await writeFile(
        entryPath,
        `
        import { readFileSync } from 'node:fs';
        import { deserialize } from 'node:v8';
        import { startWeeklyProjectionProcess } from ${JSON.stringify(runtimeUrl)};
        import { FirstPartyProjectionService } from ${JSON.stringify(serviceUrl)};
        const input = deserialize(readFileSync(${JSON.stringify(inputPath)}));
        startWeeklyProjectionProcess({connectionString:process.env.DATABASE_URL,createService(database) {
          const service = new FirstPartyProjectionService({database,now:()=>input.now});
          return {async refreshProjections(_job,context) {
            context.signal.throwIfAborted();
            await service.publishPreparedWeek(input);
          }};
        }});
      `,
      );
      const events: Readonly<Record<string, unknown>>[] = [];
      const child = new FirstPartyProjectionProcess({
        connectionString: container.url,
        workerEntry: pathToFileURL(entryPath),
        onEvent: (event) => events.push(event),
      });
      try {
        const before = await mainHandle.db
          .select()
          .from(projectionModelRuns)
          .where(eq(projectionModelRuns.inputChecksum, isolated.input.inputChecksum));
        expect(before).toHaveLength(0);
        await child.refreshProjections(
          { season: isolated.input.season, week: isolated.input.week, horizon: "weekly" },
          jobContext(),
        );
        const read = async (leagueId: string) => {
          const [set] = await mainHandle.db
            .select()
            .from(projectionSets)
            .where(eq(projectionSets.leagueSeasonId, leagueId));
          expect(set).toBeDefined();
          const rows = await mainHandle.db
            .select({
              meanPoints: playerProjections.meanPoints,
              floorPoints: playerProjections.floorPoints,
              ceilingPoints: playerProjections.ceilingPoints,
              confidence: playerProjections.confidence,
              components: playerProjections.components,
            })
            .from(playerProjections)
            .where(eq(playerProjections.projectionSetId, set!.id));
          return {
            rows,
            publishedPositions: set!.metadata.publishedPositions,
            livePointCalibration: set!.metadata.livePointCalibration,
          };
        };
        const directRows = await read(direct.leagueSeason.id);
        const childRows = await read(isolated.leagueSeason.id);
        expect(childRows.rows).toHaveLength(1);
        expect(childRows).toEqual(directRows);
        expect((childRows.rows[0]!.components.receiving_yards ?? 0) > 0).toBe(true);
        await child.refreshProjections(
          { season: isolated.input.season, week: isolated.input.week, horizon: "weekly" },
          jobContext(),
        );
        expect(await read(isolated.leagueSeason.id)).toEqual(childRows);
        const runs = await mainHandle.db
          .select()
          .from(projectionModelRuns)
          .where(eq(projectionModelRuns.inputChecksum, isolated.input.inputChecksum));
        const sets = await mainHandle.db
          .select()
          .from(projectionSets)
          .where(eq(projectionSets.leagueSeasonId, isolated.leagueSeason.id));
        expect(runs).toHaveLength(1);
        expect(sets).toHaveLength(1);
        expect(
          events.filter((event) => event.event === "weekly-projection-process-ready"),
        ).toHaveLength(1);
      } finally {
        await child.close();
        await rm(directory, { recursive: true, force: true });
      }
    }, 30_000);

    it("runs the full cold source-selection service in the child with the same immutable rejected audit as direct invocation", async () => {
      const week = 5;
      await seedWeekSchedule(mainHandle.db, { season: TEST_SEASON, week, now: FIXED_NOW });
      // Independent databases preserve every source/player/game identity without removing or
      // disabling the immutable model-audit constraints. Both runs start without this output.
      const cloneName = `weekly_process_${randomBytes(8).toString("hex")}`;
      await mainHandle.db.execute(sql.raw(`create database "${cloneName}"`));
      const cloneUrl = new URL(container.url);
      cloneUrl.pathname = `/${cloneName}`;
      const directHandle = createDatabase(cloneUrl.href, 2);
      await migrate(directHandle.db, { migrationsFolder });
      for (const table of [
        "data_sources",
        "players",
        "player_external_ids",
        "sync_runs",
        "nfl_schedule_observations",
      ] as const) {
        const where = table === "sync_runs" ? " where kind='pg-test-schedule-ingest'" : "";
        const rows = await mainHandle.db.execute(sql.raw(`select * from ${table}${where}`));
        if (rows.length > 0) {
          await directHandle.db.execute(
            sql`insert into ${sql.identifier(table)} select * from jsonb_populate_recordset(null::${sql.identifier(table)}, ${JSON.stringify(rows)}::jsonb)`,
          );
        }
      }
      const directory = await mkdtemp(path.join(tmpdir(), "weekly-full-process-pg-"));
      const entry = path.join(directory, "worker.mts");
      await writeFile(
        entry,
        `
        import {startWeeklyProjectionProcess} from ${JSON.stringify(new URL("./first-party-projection-process-runtime.ts", import.meta.url).href)};
        import {FirstPartyProjectionService} from ${JSON.stringify(new URL("./first-party-projections.ts", import.meta.url).href)};
        startWeeklyProjectionProcess({connectionString:process.env.DATABASE_URL,createService:database=>new FirstPartyProjectionService({database,now:()=>new Date(${JSON.stringify(FIXED_NOW.toISOString())})})});
      `,
      );
      const child = new FirstPartyProjectionProcess({
        connectionString: container.url,
        workerEntry: pathToFileURL(entry),
      });
      try {
        expect(await modelRunCount(mainHandle.db, TEST_SEASON, week)).toBe(0);
        await child.refreshProjections({ season: TEST_SEASON, week }, jobContext());
        const isolated = await modelRunRow(mainHandle.db, TEST_SEASON, week);
        expect(isolated).toMatchObject({
          qualityState: "rejected",
          playersPublished: 0,
        });
        expect(isolated!.playersEvaluated).toBeGreaterThanOrEqual(32);
        expect(await modelRunCount(directHandle.db, TEST_SEASON, week)).toBe(0);
        const direct = new FirstPartyProjectionService({
          database: directHandle.db,
          now: () => FIXED_NOW,
        });
        await direct.refreshProjections({ season: TEST_SEASON, week }, jobContext());
        const directRun = await modelRunRow(directHandle.db, TEST_SEASON, week);
        expect(directRun).toBeDefined();
        const {
          sourceSyncRunId: _isolatedId,
          sourceId: _isolatedSourceId,
          createdAt: _isolatedAt,
          ...isolatedValues
        } = isolated!;
        const {
          sourceSyncRunId: _directId,
          sourceId: _directSourceId,
          createdAt: _directAt,
          ...directValues
        } = directRun!;
        void [_isolatedId, _isolatedSourceId, _isolatedAt, _directId, _directSourceId, _directAt];
        expect(directValues).toEqual(isolatedValues);
        await child.refreshProjections({ season: TEST_SEASON, week }, jobContext());
        expect(await modelRunCount(mainHandle.db, TEST_SEASON, week)).toBe(1);
      } finally {
        await child.close();
        await directHandle.close();
        await mainHandle.db.execute(sql.raw(`drop database "${cloneName}"`));
        await rm(directory, { recursive: true, force: true });
      }
    }, 30_000);

    it("rolls back a kickoff-crossing write and preserves the prior published set exactly", async () => {
      const fixture = await preparedScoredWeek(mainHandle.db);
      await new FirstPartyProjectionService({
        database: mainHandle.db,
        now: () => fixture.input.now,
      }).publishPreparedWeek(fixture.input);
      const previousSets = await mainHandle.db
        .select()
        .from(projectionSets)
        .where(eq(projectionSets.leagueSeasonId, fixture.leagueSeason.id));
      expect(previousSets).toHaveLength(1);
      const previousRows = await mainHandle.db
        .select()
        .from(playerProjections)
        .where(eq(playerProjections.projectionSetId, previousSets[0]!.id));
      expect(previousRows).toHaveLength(1);

      let now = fixture.input.now;
      let crossedDuringWrite = false;
      const client = postgres(container.url, { max: 1, prepare: false });
      const database = drizzle(client, {
        schema,
        logger: {
          logQuery(query) {
            // The real row insert executes after the pre-query clock check. Its post-query
            // check must abort the complete transaction, including its earlier set/run rows.
            if (query.startsWith('insert into "player_projections"')) {
              now = fixture.input.schedules[0]!.kickoffAt;
              crossedDuringWrite = true;
            }
          },
        },
      });
      const inputChecksum = checksumFor(randomUUID());
      try {
        await expect(
          new FirstPartyProjectionService({ database, now: () => now }).publishPreparedWeek({
            ...fixture.input,
            inputChecksum,
          }),
        ).rejects.toMatchObject({ code: "PROJECTION_INPUT_EPOCH_CHANGED" });
      } finally {
        await client.end({ timeout: 5 });
      }
      expect(crossedDuringWrite).toBe(true);
      expect(
        await mainHandle.db
          .select()
          .from(projectionSets)
          .where(eq(projectionSets.leagueSeasonId, fixture.leagueSeason.id)),
      ).toEqual(previousSets);
      expect(
        await mainHandle.db
          .select()
          .from(playerProjections)
          .where(eq(playerProjections.projectionSetId, previousSets[0]!.id)),
      ).toEqual(previousRows);
      expect(
        await mainHandle.db
          .select()
          .from(projectionModelRuns)
          .where(eq(projectionModelRuns.inputChecksum, inputChecksum)),
      ).toEqual([]);
      expect(
        await mainHandle.db
          .select()
          .from(syncRuns)
          .where(eq(syncRuns.artifactChecksum, inputChecksum)),
      ).toEqual([]);
    }, 20_000);

    it("rolls back the run and entire league set if a scored player insert fails", async () => {
      const fixture = await preparedScoredWeek(mainHandle.db);
      const service = new FirstPartyProjectionService({
        database: mainHandle.db,
        now: () => fixture.input.now,
      });
      await mainHandle.db.execute(
        sql.raw(`
        CREATE FUNCTION fail_weekly_player_insert() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.player_id = '${fixture.player.id}'::uuid THEN
            RAISE EXCEPTION 'deliberate weekly player insert failure';
          END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER fail_weekly_player_insert BEFORE INSERT ON player_projections
          FOR EACH ROW EXECUTE FUNCTION fail_weekly_player_insert();
      `),
      );
      try {
        await expect(service.publishPreparedWeek(fixture.input)).rejects.toThrow();
      } finally {
        await mainHandle.db.execute(
          sql.raw(`
          DROP TRIGGER fail_weekly_player_insert ON player_projections;
          DROP FUNCTION fail_weekly_player_insert();
        `),
        );
      }
      const sets = await mainHandle.db
        .select()
        .from(projectionSets)
        .where(eq(projectionSets.leagueSeasonId, fixture.leagueSeason.id));
      const runs = await mainHandle.db
        .select()
        .from(projectionModelRuns)
        .where(eq(projectionModelRuns.inputChecksum, fixture.input.inputChecksum));
      const sync = await mainHandle.db
        .select()
        .from(syncRuns)
        .where(eq(syncRuns.artifactChecksum, fixture.input.inputChecksum));
      expect(sets).toHaveLength(0);
      expect(runs).toHaveLength(0);
      expect(sync).toHaveLength(0);
    }, 20_000);
  },
);
