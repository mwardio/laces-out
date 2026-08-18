/**
 * Real PostgreSQL coverage for Yahoo automation authorization and due-target selection.
 *
 * Safety: this suite creates a fresh, randomly named container with a random password and a
 * Docker-assigned loopback port. It never reads DATABASE_URL or an operator environment file and
 * force-removes the disposable container in afterAll.
 */
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createDatabase,
  leagueMemberships,
  leagues,
  leagueSeasons,
  providerConnections,
  providerLeagueLinks,
  users,
  type ConnectionHealth,
  type Database,
} from "@laces-out/db";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DrizzleLeagueSyncTargetReader } from "./league-sync-service.js";
import {
  DrizzleProviderSyncSweepTargetReader,
  YAHOO_ACTIVE_SYNC_INTERVAL_MS,
  YAHOO_OFFSEASON_SYNC_INTERVAL_MS,
  yahooSyncJitterMs,
} from "./provider-sync-sweep.js";

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
  const containerName = `laces-out-yahoo-sweep-pg-${randomUUID().slice(0, 8)}`;
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

const NOW = new Date("2026-09-24T15:00:00.000Z");
const id = (value: number): string => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;

const USER_OWNER = id(1);
const USER_FALLBACK = id(2);
const USER_OUTSIDER = id(3);
const CONNECTION_PRIMARY = id(101);
const CONNECTION_FALLBACK = id(102);
const CONNECTION_UNLINKED_ACCOUNT = id(103);
const CONNECTION_DEGRADED = id(104);
const CONNECTION_REAUTHORIZE = id(105);
const CONNECTION_CIRCUIT = id(106);
const CONNECTION_COOLED = id(107);
const CONNECTION_OUTSIDER = id(108);

const SEASONS = {
  activeDue: id(201),
  activeNotDue: id(202),
  preseasonDue: id(203),
  preseasonNotDue: id(204),
  offseasonDue: id(205),
  offseasonNotDue: id(206),
  completed: id(207),
  archived: id(208),
  degraded: id(209),
  reauthorize: id(210),
  circuit: id(211),
  cooled: id(212),
  sharedFallback: id(213),
  outsiderLink: id(214),
  accountIsolation: id(215),
  deterministic: id(216),
} as const;

function boundaryFreshness(
  leagueSeasonId: string,
  intervalMs: number,
  offsetFromDueMs: number,
): Date {
  return new Date(NOW.getTime() - intervalMs - yahooSyncJitterMs(leagueSeasonId) + offsetFromDueMs);
}

describe.skipIf(!dockerAvailable)("Yahoo provider sweep against real PostgreSQL", () => {
  let container: DisposablePostgres;
  let handle: ReturnType<typeof createDatabase>;
  let db: Database;
  let sweepTargets: DrizzleProviderSyncSweepTargetReader;
  let leagueTargets: DrizzleLeagueSyncTargetReader;

  async function addConnection(input: {
    readonly id: string;
    readonly userId: string;
    readonly health?: ConnectionHealth;
    readonly createdAt?: Date;
    readonly circuitOpenUntil?: Date | null;
  }): Promise<void> {
    await db.insert(providerConnections).values({
      id: input.id,
      userId: input.userId,
      provider: "yahoo",
      externalAccountId: `account-${input.id}`,
      encryptedCredential: { version: 1, ciphertext: "sanitized-test-envelope" },
      health: input.health ?? "healthy",
      consecutiveFailures: input.circuitOpenUntil ? 5 : 0,
      circuitOpenUntil: input.circuitOpenUntil ?? null,
      createdAt: input.createdAt ?? new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: NOW,
    });
  }

  async function addSeason(input: {
    readonly id: string;
    readonly status: string;
    readonly lastSyncedAt: Date;
    readonly primaryConnectionId: string;
    readonly linkedConnectionIds: readonly string[];
    readonly archived?: boolean;
    readonly additionalMemberIds?: readonly string[];
  }): Promise<void> {
    const leagueId = id(1_000 + Number(input.id.slice(-3)));
    await db.insert(leagues).values({
      id: leagueId,
      ownerUserId: USER_OWNER,
      name: `Yahoo test league ${input.id}`,
      archived: input.archived ?? false,
    });
    await db.insert(leagueSeasons).values({
      id: input.id,
      leagueId,
      connectionId: input.primaryConnectionId,
      provider: "yahoo",
      externalKey: `449.l.${Number(input.id.slice(-3))}`,
      season: 2026,
      status: input.status,
      teamCount: 10,
      draftType: "snake",
      lastSyncedAt: input.lastSyncedAt,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: NOW,
    });
    await db
      .insert(leagueMemberships)
      .values([
        { leagueId, userId: USER_OWNER, role: "owner" },
        ...(input.additionalMemberIds ?? []).map((userId) => ({
          leagueId,
          userId,
          role: "manager" as const,
        })),
      ])
      // Current migrations create the owner membership from the leagues row. Keeping this insert
      // idempotent lets the fixture also exercise deployments created before that trigger existed.
      .onConflictDoNothing({
        target: [leagueMemberships.leagueId, leagueMemberships.userId],
      });
    await db.insert(providerLeagueLinks).values(
      input.linkedConnectionIds.map((connectionId) => ({
        connectionId,
        leagueSeasonId: input.id,
        lastSyncedAt: input.lastSyncedAt,
      })),
    );
  }

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
    sweepTargets = new DrizzleProviderSyncSweepTargetReader(db);
    leagueTargets = new DrizzleLeagueSyncTargetReader(db);

    await db.insert(users).values([
      { id: USER_OWNER, email: "owner@example.test", displayName: "Owner" },
      { id: USER_FALLBACK, email: "fallback@example.test", displayName: "Fallback" },
      { id: USER_OUTSIDER, email: "outsider@example.test", displayName: "Outsider" },
    ]);
    await addConnection({ id: CONNECTION_PRIMARY, userId: USER_OWNER });
    await addConnection({
      id: CONNECTION_FALLBACK,
      userId: USER_FALLBACK,
      createdAt: new Date("2025-12-01T00:00:00.000Z"),
    });
    await addConnection({ id: CONNECTION_UNLINKED_ACCOUNT, userId: USER_OWNER });
    await addConnection({
      id: CONNECTION_DEGRADED,
      userId: USER_OWNER,
      health: "degraded",
    });
    await addConnection({
      id: CONNECTION_REAUTHORIZE,
      userId: USER_OWNER,
      health: "reauthorize",
    });
    await addConnection({
      id: CONNECTION_CIRCUIT,
      userId: USER_OWNER,
      circuitOpenUntil: new Date(NOW.getTime() + 60_000),
    });
    await addConnection({
      id: CONNECTION_COOLED,
      userId: USER_OWNER,
      circuitOpenUntil: new Date(NOW.getTime() - 1_000),
    });
    await addConnection({ id: CONNECTION_OUTSIDER, userId: USER_OUTSIDER });

    await addSeason({
      id: SEASONS.activeDue,
      status: "active",
      lastSyncedAt: boundaryFreshness(SEASONS.activeDue, YAHOO_ACTIVE_SYNC_INTERVAL_MS, 0),
      primaryConnectionId: CONNECTION_PRIMARY,
      linkedConnectionIds: [CONNECTION_PRIMARY],
    });
    await addSeason({
      id: SEASONS.activeNotDue,
      status: "active",
      lastSyncedAt: boundaryFreshness(SEASONS.activeNotDue, YAHOO_ACTIVE_SYNC_INTERVAL_MS, 1),
      primaryConnectionId: CONNECTION_PRIMARY,
      linkedConnectionIds: [CONNECTION_PRIMARY],
    });
    await addSeason({
      id: SEASONS.preseasonDue,
      status: "preseason",
      lastSyncedAt: boundaryFreshness(SEASONS.preseasonDue, YAHOO_OFFSEASON_SYNC_INTERVAL_MS, 0),
      primaryConnectionId: CONNECTION_PRIMARY,
      linkedConnectionIds: [CONNECTION_PRIMARY],
    });
    await addSeason({
      id: SEASONS.preseasonNotDue,
      status: "preseason",
      lastSyncedAt: boundaryFreshness(SEASONS.preseasonNotDue, YAHOO_OFFSEASON_SYNC_INTERVAL_MS, 1),
      primaryConnectionId: CONNECTION_PRIMARY,
      linkedConnectionIds: [CONNECTION_PRIMARY],
    });
    await addSeason({
      id: SEASONS.offseasonDue,
      status: "offseason",
      lastSyncedAt: boundaryFreshness(SEASONS.offseasonDue, YAHOO_OFFSEASON_SYNC_INTERVAL_MS, 0),
      primaryConnectionId: CONNECTION_PRIMARY,
      linkedConnectionIds: [CONNECTION_PRIMARY],
    });
    await addSeason({
      id: SEASONS.offseasonNotDue,
      status: "offseason",
      lastSyncedAt: boundaryFreshness(SEASONS.offseasonNotDue, YAHOO_OFFSEASON_SYNC_INTERVAL_MS, 1),
      primaryConnectionId: CONNECTION_PRIMARY,
      linkedConnectionIds: [CONNECTION_PRIMARY],
    });
    for (const candidate of [
      { id: SEASONS.completed, status: "completed", connectionId: CONNECTION_PRIMARY },
      { id: SEASONS.degraded, status: "active", connectionId: CONNECTION_DEGRADED },
      { id: SEASONS.reauthorize, status: "active", connectionId: CONNECTION_REAUTHORIZE },
      { id: SEASONS.circuit, status: "active", connectionId: CONNECTION_CIRCUIT },
      { id: SEASONS.cooled, status: "active", connectionId: CONNECTION_COOLED },
    ]) {
      await addSeason({
        id: candidate.id,
        status: candidate.status,
        lastSyncedAt: new Date(NOW.getTime() - 24 * 60 * 60 * 1_000),
        primaryConnectionId: candidate.connectionId,
        linkedConnectionIds: [candidate.connectionId],
      });
    }
    await addSeason({
      id: SEASONS.archived,
      status: "active",
      archived: true,
      lastSyncedAt: new Date(NOW.getTime() - 24 * 60 * 60 * 1_000),
      primaryConnectionId: CONNECTION_PRIMARY,
      linkedConnectionIds: [CONNECTION_PRIMARY],
    });
    await addSeason({
      id: SEASONS.sharedFallback,
      status: "active",
      lastSyncedAt: new Date(NOW.getTime() - 24 * 60 * 60 * 1_000),
      primaryConnectionId: CONNECTION_DEGRADED,
      linkedConnectionIds: [CONNECTION_DEGRADED, CONNECTION_FALLBACK],
      additionalMemberIds: [USER_FALLBACK],
    });
    await addSeason({
      id: SEASONS.outsiderLink,
      status: "active",
      lastSyncedAt: new Date(NOW.getTime() - 24 * 60 * 60 * 1_000),
      primaryConnectionId: CONNECTION_OUTSIDER,
      linkedConnectionIds: [CONNECTION_OUTSIDER],
    });
    await addSeason({
      id: SEASONS.accountIsolation,
      status: "active",
      lastSyncedAt: new Date(NOW.getTime() - 24 * 60 * 60 * 1_000),
      primaryConnectionId: CONNECTION_PRIMARY,
      linkedConnectionIds: [CONNECTION_PRIMARY],
    });
    await addSeason({
      id: SEASONS.deterministic,
      status: "active",
      lastSyncedAt: new Date(NOW.getTime() - 24 * 60 * 60 * 1_000),
      primaryConnectionId: CONNECTION_DEGRADED,
      linkedConnectionIds: [CONNECTION_DEGRADED, CONNECTION_PRIMARY, CONNECTION_FALLBACK],
      additionalMemberIds: [USER_FALLBACK],
    });
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
  }, 30_000);

  it("applies exact active and offseason due boundaries and excludes terminal seasons", async () => {
    const targets = await sweepTargets.listDueYahoo(NOW, 100);
    const selected = new Map(targets.map((target) => [target.leagueSeasonId, target]));

    expect(selected.get(SEASONS.activeDue)?.dueAt.toISOString()).toBe(NOW.toISOString());
    expect(selected.get(SEASONS.preseasonDue)?.dueAt.toISOString()).toBe(NOW.toISOString());
    expect(selected.get(SEASONS.offseasonDue)?.dueAt.toISOString()).toBe(NOW.toISOString());
    expect(selected.has(SEASONS.activeNotDue)).toBe(false);
    expect(selected.has(SEASONS.preseasonNotDue)).toBe(false);
    expect(selected.has(SEASONS.offseasonNotDue)).toBe(false);
    expect(selected.has(SEASONS.completed)).toBe(false);
    expect(selected.has(SEASONS.archived)).toBe(false);
  });

  it("filters unhealthy and open-circuit accounts but resumes after cooldown", async () => {
    const selected = new Map(
      (await sweepTargets.listDueYahoo(NOW, 100)).map((target) => [target.leagueSeasonId, target]),
    );

    expect(selected.has(SEASONS.degraded)).toBe(false);
    expect(selected.has(SEASONS.reauthorize)).toBe(false);
    expect(selected.has(SEASONS.circuit)).toBe(false);
    expect(selected.get(SEASONS.cooled)?.connectionId).toBe(CONNECTION_COOLED);
  });

  it("chooses the healthy linked member fallback deterministically", async () => {
    const targets = await sweepTargets.listDueYahoo(NOW, 100);
    const shared = targets.find((target) => target.leagueSeasonId === SEASONS.sharedFallback);

    expect(shared?.connectionId).toBe(CONNECTION_FALLBACK);
    await expect(
      leagueTargets.findSyncTarget({
        connectionId: CONNECTION_FALLBACK,
        leagueSeasonId: SEASONS.sharedFallback,
      }),
    ).resolves.toMatchObject({ userId: USER_FALLBACK, provider: "yahoo" });

    const first = targets.find((target) => target.leagueSeasonId === SEASONS.deterministic);
    const second = (await sweepTargets.listDueYahoo(NOW, 100)).find(
      (target) => target.leagueSeasonId === SEASONS.deterministic,
    );
    expect(first?.connectionId).toBe(CONNECTION_FALLBACK);
    expect(second).toEqual(first);
  });

  it("rejects unlinked accounts and linked accounts whose owner is not a league member", async () => {
    const targets = await sweepTargets.listDueYahoo(NOW, 100);
    expect(targets.some((target) => target.leagueSeasonId === SEASONS.outsiderLink)).toBe(false);
    expect(
      targets.find((target) => target.leagueSeasonId === SEASONS.accountIsolation)?.connectionId,
    ).toBe(CONNECTION_PRIMARY);

    await expect(
      leagueTargets.findSyncTarget({
        connectionId: CONNECTION_UNLINKED_ACCOUNT,
        leagueSeasonId: SEASONS.accountIsolation,
      }),
    ).resolves.toBeUndefined();
    await expect(
      leagueTargets.findSyncTarget({
        connectionId: CONNECTION_OUTSIDER,
        leagueSeasonId: SEASONS.outsiderLink,
      }),
    ).resolves.toBeUndefined();
    await expect(
      leagueTargets.findSyncTarget({
        connectionId: CONNECTION_PRIMARY,
        leagueSeasonId: SEASONS.sharedFallback,
      }),
    ).resolves.toBeUndefined();
  });
});
