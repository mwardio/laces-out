/**
 * Real PostgreSQL coverage for the ESPN live-draft ledger fence.
 *
 * These regressions depend on PostgreSQL row locks, multi-row `ON CONFLICT DO NOTHING`, and
 * transaction rollback. An in-memory repository would only prove that the fake agrees with itself.
 *
 * Safety: the suite uses a fresh disposable PostgreSQL container on a Docker-assigned loopback
 * port. It never reads `DATABASE_URL` or an environment file and force-removes its container when
 * finished. The suite skips cleanly when Docker is unavailable.
 */
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { EspnLiveDraftObservation } from "@laces-out/contracts";
import {
  bridgeDevices,
  createDatabase,
  draftEvents,
  draftProviderFeeds,
  draftProviderObservations,
  drafts,
  leagueSeasons,
  leagues,
  users,
  type Database,
} from "@laces-out/db";
import { draftEventId, playerId, teamId } from "@laces-out/domain";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DrizzleEspnLiveDraftRepository } from "./espn-live-draft-persistence.js";
import type { CommitProviderEventsInput } from "./espn-live-draft-service.js";

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
    "[espn-live-draft-persistence.pg.test] Skipping disposable-PostgreSQL tests: docker is unavailable.",
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
  const containerName = `laces-out-live-draft-pg-${randomUUID().slice(0, 8)}`;
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

const NOW = new Date("2031-08-24T18:05:00.000Z");
const MANUAL_AT = new Date("2031-08-24T18:04:59.000Z");
const USER_ID = "10000000-0000-4000-8000-000000000001";
const LEAGUE_ID = "20000000-0000-4000-8000-000000000001";
const LEAGUE_SEASON_ID = "30000000-0000-4000-8000-000000000001";
const DRAFT_ID = "40000000-0000-4000-8000-000000000001";
const DEVICE_ID = "50000000-0000-4000-8000-000000000001";
const FEED_ID = "60000000-0000-4000-8000-000000000001";
const PAGE_SESSION_ID = "70000000-0000-4000-8000-000000000001";
const TEAM_ID = "80000000-0000-4000-8000-000000000001";
const PLAYER_ONE_ID = "90000000-0000-4000-8000-000000000001";
const PLAYER_TWO_ID = "90000000-0000-4000-8000-000000000002";

function observation(revision = 4): EspnLiveDraftObservation {
  return {
    schemaVersion: 1,
    kind: "espn-live-draft",
    leagueId: "1234567",
    season: 2031,
    pageSessionId: PAGE_SESSION_ID,
    revision,
    capturedAt: "2031-08-24T18:04:58.000Z",
    state: "live",
    draftType: "snake",
    expectedTeamCount: 2,
    expectedRosterSize: 1,
    pickOwnership: [
      { overallPick: 1, providerTeamId: "1", teamName: "Test Team" },
      { overallPick: 2, providerTeamId: "2", teamName: "Other Team" },
    ],
    picks: [
      {
        sequence: 1,
        round: 1,
        roundPick: 1,
        keeper: false,
        providerTeamId: "1",
        teamName: "Test Team",
        providerPlayerId: "101",
        playerName: "Test Player One",
        proTeam: "CHI",
        position: "QB",
        price: null,
        nominatingProviderTeamId: null,
      },
    ],
    currentAuction: null,
    completeness: { contiguousThrough: 1, duplicateSequences: 0, unresolvedRows: 0 },
    checksumSha256: "a".repeat(64),
  };
}

function pendingEvent(
  idempotencyKey: string,
  eventId: string,
  selectedPlayerId: string,
  overallPick: number,
): CommitProviderEventsInput["append"][number] {
  return {
    idempotencyKey,
    source: "espn",
    revertsSequence: null,
    event: {
      id: draftEventId(eventId),
      type: "SNAKE_PLAYER_SELECTED",
      teamId: teamId(TEAM_ID),
      playerId: playerId(selectedPlayerId),
      overallPick,
      occurredAt: NOW.toISOString(),
    },
  };
}

function commitInput(
  overrides: Partial<CommitProviderEventsInput> = {},
): CommitProviderEventsInput {
  return {
    feedId: FEED_ID,
    draftId: DRAFT_ID,
    deviceId: DEVICE_ID,
    expectedSequence: 0,
    expectedLeaseGeneration: 1,
    expectedManualBackupActive: false,
    append: [pendingEvent("espn:pick:1", "espn-pick-1", PLAYER_ONE_ID, 1)],
    observation: observation(),
    result: "accepted",
    issue: null,
    feedState: "live",
    transientAuction: null,
    pendingDestructiveChecksum: null,
    pendingDestructiveSeenCount: 0,
    unresolvedTeams: 0,
    unresolvedPlayers: 0,
    now: NOW,
    ...overrides,
  };
}

describe.skipIf(!dockerAvailable)(
  "ESPN live-draft observation commits against real PostgreSQL",
  () => {
    let container: DisposablePostgres;
    let handle: ReturnType<typeof createDatabase>;
    let db: Database;
    let repository: DrizzleEspnLiveDraftRepository;

    async function feedAndDraftState() {
      const [feed] = await db
        .select({
          state: draftProviderFeeds.state,
          lastPageRevision: draftProviderFeeds.lastPageRevision,
          lastChecksum: draftProviderFeeds.lastChecksum,
          lastObservedAt: draftProviderFeeds.lastObservedAt,
          lastReceivedAt: draftProviderFeeds.lastReceivedAt,
          lastMaterialEventAt: draftProviderFeeds.lastMaterialEventAt,
          lastPickCount: draftProviderFeeds.lastPickCount,
          currentAuctionState: draftProviderFeeds.currentAuctionState,
          lastErrorCode: draftProviderFeeds.lastErrorCode,
          updatedAt: draftProviderFeeds.updatedAt,
        })
        .from(draftProviderFeeds)
        .where(eq(draftProviderFeeds.id, FEED_ID));
      const [draft] = await db
        .select({ state: drafts.state, updatedAt: drafts.updatedAt })
        .from(drafts)
        .where(eq(drafts.id, DRAFT_ID));
      return { feed, draft };
    }

    async function raceWithWinningManualAppend(input: CommitProviderEventsInput) {
      let signalLocked: (() => void) | undefined;
      const locked = new Promise<void>((resolve) => {
        signalLocked = resolve;
      });
      let releaseManual: (() => void) | undefined;
      const release = new Promise<void>((resolve) => {
        releaseManual = resolve;
      });

      const manualAppend = db.transaction(async (transaction) => {
        await transaction.execute(sql`select id from drafts where id = ${DRAFT_ID} for update`);
        signalLocked?.();
        await release;
        await transaction.insert(draftEvents).values({
          draftId: DRAFT_ID,
          sequence: 1,
          idempotencyKey: "manual:pick:1",
          type: "SNAKE_PLAYER_SELECTED",
          occurredAt: MANUAL_AT,
          source: "manual",
          payload: {
            id: "manual-pick-1",
            type: "SNAKE_PLAYER_SELECTED",
            teamId: TEAM_ID,
            playerId: PLAYER_ONE_ID,
            overallPick: 1,
          },
          revertsSequence: null,
        });
        await transaction
          .update(drafts)
          .set({ state: "live", updatedAt: MANUAL_AT })
          .where(eq(drafts.id, DRAFT_ID));
      });

      await locked;
      const providerCommit = repository.commitObservation(input);
      // Give the provider transaction an opportunity to reach the draft-row lock while the manual
      // transaction still owns it. Correctness does not depend on scheduling: the manual commit is
      // guaranteed to become durable before the provider can inspect the ledger.
      await new Promise<void>((resolve) => setImmediate(resolve));
      releaseManual?.();
      await manualAppend;
      return providerCommit;
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
      repository = new DrizzleEspnLiveDraftRepository(db, () => NOW);

      await db.insert(users).values({
        id: USER_ID,
        email: "live-draft-ledger@example.test",
        displayName: "Live Draft Ledger",
      });
      await db.insert(leagues).values({
        id: LEAGUE_ID,
        ownerUserId: USER_ID,
        name: "Ledger Fence League",
      });
      await db.insert(leagueSeasons).values({
        id: LEAGUE_SEASON_ID,
        leagueId: LEAGUE_ID,
        provider: "espn",
        externalKey: "1234567",
        season: 2031,
        status: "preseason",
        teamCount: 2,
        draftType: "snake",
      });
      await db.insert(bridgeDevices).values({
        id: DEVICE_ID,
        userId: USER_ID,
        name: "Live Draft Test Browser",
        tokenHash: "a".repeat(43),
        createdAt: new Date("2031-08-24T17:00:00.000Z"),
      });
      await db.insert(drafts).values({
        id: DRAFT_ID,
        leagueSeasonId: LEAGUE_SEASON_ID,
        type: "snake",
        state: "created",
        settings: {},
        createdAt: new Date("2031-08-24T17:00:00.000Z"),
        updatedAt: new Date("2031-08-24T17:00:00.000Z"),
      });
      await db.insert(draftProviderFeeds).values({
        id: FEED_ID,
        draftId: DRAFT_ID,
        leagueSeasonId: LEAGUE_SEASON_ID,
        provider: "espn",
        providerLeagueId: "1234567",
        season: 2031,
        state: "waiting",
        activeDeviceId: DEVICE_ID,
        activePageSessionId: PAGE_SESSION_ID,
        lastPageRevision: 3,
        leaseGeneration: 1,
        manualBackupActive: false,
        verification: "pending",
        createdAt: new Date("2031-08-24T17:00:00.000Z"),
        updatedAt: new Date("2031-08-24T17:00:00.000Z"),
      });
    }, 90_000);

    beforeEach(async () => {
      await db.delete(draftProviderObservations);
      await db.delete(draftEvents);
      await db
        .update(drafts)
        .set({
          state: "created",
          updatedAt: new Date("2031-08-24T17:00:00.000Z"),
        })
        .where(eq(drafts.id, DRAFT_ID));
      await db
        .update(draftProviderFeeds)
        .set({
          state: "waiting",
          activeDeviceId: DEVICE_ID,
          activePageSessionId: PAGE_SESSION_ID,
          lastPageRevision: 3,
          leaseGeneration: 1,
          leaseExpiresAt: null,
          lastChecksum: null,
          lastObservedAt: null,
          lastReceivedAt: null,
          lastMaterialEventAt: null,
          lastPickCount: 0,
          currentAuctionState: null,
          pendingDestructiveChecksum: null,
          pendingDestructiveSeenCount: 0,
          manualBackupActive: false,
          lastErrorCode: null,
          updatedAt: new Date("2031-08-24T17:00:00.000Z"),
        })
        .where(eq(draftProviderFeeds.id, FEED_ID));
    });

    afterAll(async () => {
      await handle?.close();
      if (container?.containerName) {
        try {
          execFileSync("docker", ["rm", "-f", "-v", container.containerName], {
            stdio: "ignore",
          });
        } catch {
          // Best effort; the disposable container was started with --rm.
        }
      }
    });

    it("rejects a forward plan after a concurrent manual append wins the draft lock", async () => {
      const before = await feedAndDraftState();
      const result = await raceWithWinningManualAppend(commitInput());

      expect(result).toEqual({ sequence: 1, committed: false });
      expect(await db.select().from(draftProviderObservations)).toHaveLength(0);
      expect(await db.select().from(draftEvents)).toMatchObject([
        { sequence: 1, idempotencyKey: "manual:pick:1", source: "manual" },
      ]);
      const after = await feedAndDraftState();
      expect(after.feed).toEqual(before.feed);
      expect(after.draft).toEqual({ state: "live", updatedAt: MANUAL_AT });
    });

    it.each(["idempotent", "held"] as const)(
      "keeps an empty %s plan fenced after a concurrent manual append",
      async (resultKind) => {
        const before = await feedAndDraftState();
        const result = await raceWithWinningManualAppend(
          commitInput({
            append: [],
            result: resultKind,
            issue: resultKind === "held" ? "MANUAL_BACKUP_ACTIVE" : null,
          }),
        );

        expect(result).toEqual({ sequence: 1, committed: false });
        expect(await db.select().from(draftProviderObservations)).toHaveLength(0);
        expect(await db.select().from(draftEvents)).toMatchObject([
          { sequence: 1, idempotencyKey: "manual:pick:1", source: "manual" },
        ]);
        const after = await feedAndDraftState();
        expect(after.feed).toEqual(before.feed);
        expect(after.draft).toEqual({ state: "live", updatedAt: MANUAL_AT });
      },
    );

    it("rolls back its audit row and conflict-free event when a batch only partly inserts", async () => {
      const before = await feedAndDraftState();
      const duplicateKey = "espn:duplicate-within-batch";
      const result = await repository.commitObservation(
        commitInput({
          append: [
            pendingEvent(duplicateKey, "espn-pick-1", PLAYER_ONE_ID, 1),
            pendingEvent(duplicateKey, "espn-pick-2", PLAYER_TWO_ID, 2),
          ],
        }),
      );

      expect(result).toEqual({ sequence: 0, committed: false });
      expect(await db.select().from(draftProviderObservations)).toHaveLength(0);
      expect(await db.select().from(draftEvents)).toHaveLength(0);
      expect(await feedAndDraftState()).toEqual(before);
    });
  },
);
