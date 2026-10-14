/** Destructive retention tests run only in a disposable, fully migrated PostgreSQL database. */
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDatabase,
  users,
  leagues,
  leagueSeasons,
  players,
  projectionSets,
  playerProjections,
  recommendationRuns,
  type Database,
} from "@laces-out/db";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  inspectProjectionRetention,
  pruneProjectionHistory,
  PROJECTION_RETENTION_LOCK,
} from "./projection-retention.js";
function dockerIsAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const dockerAvailable = dockerIsAvailable();
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

interface DisposablePostgres {
  readonly containerName: string;
  readonly url: string;
}

async function startDisposablePostgres(): Promise<DisposablePostgres> {
  const containerName = `laces-retention-test-${randomUUID().slice(0, 8)}`;
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

const owner = randomUUID(),
  league = randomUUID(),
  season = randomUUID(),
  player = randomUUID();
const old = new Date(Date.now() - 30 * 86_400_000);
let container: DisposablePostgres | undefined;
let handle: ReturnType<typeof createDatabase> | undefined;
let db: Database;

describe.skipIf(!dockerAvailable)("projection retention", () => {
  beforeAll(async () => {
    container = await startDisposablePostgres();
    handle = createDatabase(container.url, 4);
    db = handle.db;
    await migrate(db, { migrationsFolder });
    await db
      .insert(users)
      .values({ id: owner, email: "retention@example.test", displayName: "Retention" });
    await db.insert(leagues).values({ id: league, ownerUserId: owner, name: "Retention" });
    await db.insert(leagueSeasons).values({
      id: season,
      leagueId: league,
      provider: "manual",
      externalKey: "retention",
      season: 2026,
      teamCount: 12,
      draftType: "snake",
    });
    await db.insert(players).values({
      id: player,
      fullName: "Retention Test",
      primaryPosition: "QB",
      eligiblePositions: ["QB"],
    });
  }, 60_000);
  afterAll(async () => {
    await handle?.close();
    if (container)
      execFileSync("docker", ["rm", "-f", container.containerName], { stdio: "ignore" });
  });
  beforeEach(async () => {
    await db.delete(recommendationRuns);
    await db.delete(projectionSets);
  });
  function row(index: number, overrides: Partial<typeof projectionSets.$inferInsert> = {}) {
    return {
      leagueSeasonId: season,
      visibility: "league" as const,
      source: "laces-out-first-party",
      version: randomUUID(),
      season: 2026,
      week: 2,
      horizon: "week" as const,
      fetchedAt: new Date(old.getTime() + index * 1000),
      createdAt: new Date(old.getTime() + index * 1000),
      inputChecksum: randomBytes(32).toString("hex"),
      metadata: { scoringProfileKey: "profile-a" },
      ...overrides,
      id: randomUUID(),
    };
  }
  async function seed(count: number) {
    const rows = Array.from({ length: count }, (_, i) => row(i));
    await db.insert(projectionSets).values(rows);
    await db
      .insert(playerProjections)
      .values(rows.map((r) => ({ projectionSetId: r.id, playerId: player, meanPoints: "10" })));
    return rows;
  }
  it("prunes superseded payloads but preserves pinned, recent, imported, ROS, and per-profile/week fallback sets", async () => {
    const rows = await seed(150);
    const special = [
      row(-1, { createdAt: new Date() }),
      row(-2, { fetchedAt: new Date() }),
      row(-3, { createdByUserId: owner }),
      row(-4, { source: "custom-import" }),
      row(-5, { week: 1 }),
      row(-6, { metadata: { scoringProfileKey: "other-profile" } }),
      row(-7, {
        source: "laces-out-first-party-ros",
        horizon: "rest-of-season",
        week: null,
        windowStartWeek: 2,
        windowEndWeek: 18,
        asOfWeek: 1,
        asOfAt: old,
      }),
    ];
    await db.insert(projectionSets).values(special);
    await db.insert(recommendationRuns).values({
      leagueSeasonId: season,
      kind: "lineup",
      algorithmVersion: "test",
      inputHash: "test",
      inputs: { projectionSetIds: [rows[0]!.id] },
    });
    // Recent rows replace old rows within the last-100 history, but are never themselves deleted.
    expect((await inspectProjectionRetention(db)).eligibleSets).toBe(50);
    expect(await pruneProjectionHistory(db)).toEqual({ deletedSets: 50 });
    const remaining = new Set(
      (await db.select({ id: projectionSets.id }).from(projectionSets)).map((r) => r.id),
    );
    for (const r of special) expect(remaining.has(r.id)).toBe(true);
    expect(remaining.has(rows[0]!.id)).toBe(true);
    expect(remaining.has(rows[1]!.id)).toBe(false);
    expect(
      await db
        .select()
        .from(playerProjections)
        .where(eq(playerProjections.projectionSetId, rows[1]!.id)),
    ).toEqual([]);
    expect(await pruneProjectionHistory(db)).toEqual({ deletedSets: 0 });
  });
  it("keeps 32 fetched-time candidates for an older target even outside browser history", async () => {
    const rows = await seed(150);
    await db
      .insert(projectionSets)
      .values(Array.from({ length: 150 }, (_, i) => row(200 + i, { week: 3 })));
    expect(await pruneProjectionHistory(db)).toEqual({ deletedSets: 168 });
    const remaining = new Set(
      (await db.select({ id: projectionSets.id }).from(projectionSets)).map((r) => r.id),
    );
    expect(remaining.has(rows[117]!.id)).toBe(false);
    for (const r of rows.slice(118)) expect(remaining.has(r.id)).toBe(true);
  });
  it("bounds catch-up to 500 sets and resumes on the next sweep", async () => {
    await seed(650);
    expect(await pruneProjectionHistory(db)).toEqual({ deletedSets: 500 });
    expect((await inspectProjectionRetention(db)).eligibleSets).toBe(50);
    expect(await pruneProjectionHistory(db)).toEqual({ deletedSets: 50 });
  });
  it("defers to concurrent recommendation persistence and observes the committed pin", async () => {
    const rows = await seed(150);
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock_shared(hashtextextended(${PROJECTION_RETENTION_LOCK}, 0))`,
      );
      expect(await pruneProjectionHistory(db)).toEqual({ deletedSets: 0 });
      await tx.insert(recommendationRuns).values({
        leagueSeasonId: season,
        kind: "lineup",
        algorithmVersion: "test",
        inputHash: "test",
        inputs: { projectionSetIds: [rows[0]!.id] },
      });
    });
    expect(await pruneProjectionHistory(db)).toEqual({ deletedSets: 49 });
    expect(
      await db.select().from(projectionSets).where(eq(projectionSets.id, rows[0]!.id)),
    ).toHaveLength(1);
  });
  it("does no work for an already cancelled job", async () => {
    await seed(150);
    await expect(pruneProjectionHistory(db, AbortSignal.abort())).rejects.toThrow();
    expect((await inspectProjectionRetention(db)).eligibleSets).toBe(50);
  });
});
