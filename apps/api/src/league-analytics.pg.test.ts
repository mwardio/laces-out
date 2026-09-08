/**
 * Real PostgreSQL coverage for the matchup-history bound. Provider syncs append immutable
 * full-schedule snapshots, so deduplication must happen in SQL before LIMIT is applied.
 */
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createDatabase,
  fantasyTeams,
  leagues,
  leagueSeasons,
  matchupSnapshots,
  users,
  weeklyMatchups,
  type Database,
} from "@laces-out/db";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DrizzleLeagueAnalyticsRepository } from "./league-analytics.js";

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
    "[league-analytics.pg.test] Skipping disposable-PostgreSQL analytics tests: docker is unavailable.",
  );
}

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

interface DisposablePostgres {
  readonly containerName: string;
  readonly url: string;
}

async function startDisposablePostgres(): Promise<DisposablePostgres> {
  const containerName = `laces-out-analytics-pg-${randomUUID().slice(0, 8)}`;
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

  const readyDeadline = Date.now() + 30_000;
  for (;;) {
    try {
      execFileSync(
        "docker",
        ["exec", containerName, "pg_isready", "-U", user, "-d", databaseName],
        { stdio: "ignore" },
      );
      break;
    } catch {
      if (Date.now() > readyDeadline) {
        throw new Error(`Disposable PostgreSQL container ${containerName} did not become ready`);
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
        throw new Error(`Could not connect to ${containerName}: ${String(error)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }

  return { containerName, url };
}

const ownerId = "10000000-0000-4000-8000-000000000001";
const leagueId = "20000000-0000-4000-8000-000000000001";
const seasonId = "30000000-0000-4000-8000-000000000001";
const homeTeamId = "40000000-0000-4000-8000-000000000001";
const awayTeamId = "40000000-0000-4000-8000-000000000002";
const oldestSnapshotId = "50000000-0000-4000-8000-000000000001";
const middleSnapshotId = "50000000-0000-4000-8000-000000000002";
const newestSnapshotId = "50000000-0000-4000-8000-000000000003";

describe.skipIf(!dockerAvailable)("league analytics repository against real PostgreSQL", () => {
  let container: DisposablePostgres;
  let handle: ReturnType<typeof createDatabase>;
  let db: Database;
  let repository: DrizzleLeagueAnalyticsRepository;

  beforeAll(async () => {
    container = await startDisposablePostgres();
    const migrationHandle = createDatabase(container.url, 1);
    try {
      await migrate(migrationHandle.db, { migrationsFolder });
    } finally {
      await migrationHandle.close();
    }

    handle = createDatabase(container.url, 5);
    db = handle.db;
    repository = new DrizzleLeagueAnalyticsRepository(db);

    await db.insert(users).values({
      id: ownerId,
      email: "analytics-owner@example.test",
      displayName: "Analytics Owner",
    });
    await db
      .insert(leagues)
      .values({ id: leagueId, ownerUserId: ownerId, name: "Analytics League" });
    await db.insert(leagueSeasons).values({
      id: seasonId,
      leagueId,
      provider: "espn",
      externalKey: "analytics-league-2026",
      season: 2026,
      teamCount: 2,
      draftType: "snake",
    });
    await db.insert(fantasyTeams).values([
      { id: homeTeamId, leagueSeasonId: seasonId, externalKey: "1", name: "Home" },
      { id: awayTeamId, leagueSeasonId: seasonId, externalKey: "2", name: "Away" },
    ]);
    await db.insert(matchupSnapshots).values([
      {
        id: oldestSnapshotId,
        leagueSeasonId: seasonId,
        asOfWeek: 1,
        effectiveAt: new Date("2026-09-01T12:00:00.000Z"),
      },
      {
        id: middleSnapshotId,
        leagueSeasonId: seasonId,
        asOfWeek: 1,
        effectiveAt: new Date("2026-09-02T12:00:00.000Z"),
      },
      {
        id: newestSnapshotId,
        leagueSeasonId: seasonId,
        asOfWeek: 1,
        effectiveAt: new Date("2026-09-03T12:00:00.000Z"),
      },
    ]);
    await db.insert(weeklyMatchups).values([
      {
        id: "60000000-0000-4000-8000-000000000001",
        snapshotId: oldestSnapshotId,
        externalKey: "week-1-game-1",
        providerMatchupId: "game-1",
        week: 1,
        status: "scheduled",
        homeTeamId,
        awayTeamId,
        homeProviderTeamId: "1",
        awayProviderTeamId: "2",
      },
      {
        id: "60000000-0000-4000-8000-000000000002",
        snapshotId: oldestSnapshotId,
        externalKey: "week-2-game-1",
        providerMatchupId: "game-2",
        week: 2,
        status: "scheduled",
        homeTeamId,
        awayTeamId,
        homeProviderTeamId: "1",
        awayProviderTeamId: "2",
      },
      {
        id: "60000000-0000-4000-8000-000000000003",
        snapshotId: middleSnapshotId,
        externalKey: "week-1-game-1",
        providerMatchupId: "game-1",
        week: 1,
        status: "scheduled",
        homeTeamId,
        awayTeamId,
        homeProviderTeamId: "1",
        awayProviderTeamId: "2",
      },
      {
        id: "60000000-0000-4000-8000-000000000004",
        snapshotId: newestSnapshotId,
        externalKey: "week-1-game-1",
        providerMatchupId: "game-1",
        week: 1,
        status: "scheduled",
        homeTeamId,
        awayTeamId,
        homeProviderTeamId: "1",
        awayProviderTeamId: "2",
      },
    ]);
  }, 90_000);

  afterAll(async () => {
    await handle?.close();
    if (container?.containerName) {
      try {
        execFileSync("docker", ["rm", "-f", "-v", container.containerName], {
          stdio: "ignore",
        });
      } catch {
        // Best-effort; the container was started with --rm.
      }
    }
  });

  it("deduplicates immutable snapshot history before applying the read limit", async () => {
    const rows = await repository.listMatchupObservations(seasonId, 2);

    expect(rows.map((row) => [row.week, row.providerMatchupId, row.snapshotId])).toEqual([
      [1, "game-1", newestSnapshotId],
      [2, "game-2", oldestSnapshotId],
    ]);
  });
});
