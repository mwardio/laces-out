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
 * This file starts a disposable, single-use PostgreSQL 16 container (never the ambient/default
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
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createDatabase,
  dataSources,
  nflScheduleObservations,
  projectionModelRuns,
  syncRuns,
} from "@laces-out/db";
import type { Database } from "@laces-out/db";
import { and, count, eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
      "postgres:16",
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
  "FirstPartyProjectionService against a disposable PostgreSQL 16 database",
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
  },
);
