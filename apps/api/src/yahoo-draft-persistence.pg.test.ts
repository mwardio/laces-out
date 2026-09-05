/**
 * Real PostgreSQL coverage for Yahoo's cumulative draft-poll ledger fence.
 *
 * These regressions depend on PostgreSQL conditional updates, row locks, transaction rollback,
 * and cascading foreign keys. A repository fake cannot prove those properties. The suite starts a
 * fresh disposable PostgreSQL container, never reads DATABASE_URL, and removes the container when
 * it finishes. It skips cleanly when Docker is unavailable.
 */
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { YahooDraftResultsSnapshot } from "@laces-out/connector-yahoo";
import {
  createDatabase,
  draftEvents,
  drafts,
  leagueMemberships,
  leagueSeasons,
  leagues,
  providerConnections,
  users,
  yahooDraftPollFeeds,
  yahooDraftPollObservations,
  type Database,
} from "@laces-out/db";
import { draftEventId, playerId, teamId } from "@laces-out/domain";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DrizzleDraftSessionRepository } from "./draft-session.js";
import type { YahooDraftReconciliationResult } from "./yahoo-draft-reconciler.js";
import { DrizzleYahooDraftPollRepository } from "./yahoo-draft-service.js";
import { DrizzleYahooSyncRepository } from "./yahoo-sync.js";

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
    "[yahoo-draft-persistence.pg.test] Skipping disposable-PostgreSQL tests: Docker is unavailable.",
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
  const containerName = `laces-out-yahoo-draft-pg-${randomUUID().slice(0, 8)}`;
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
const CREATED_AT = new Date("2031-08-24T17:00:00.000Z");
const USER_ID = "10000000-0000-4000-8000-000000000001";
const CONNECTION_ID = "20000000-0000-4000-8000-000000000001";
const LEAGUE_ID = "30000000-0000-4000-8000-000000000001";
const LEAGUE_SEASON_ID = "40000000-0000-4000-8000-000000000001";
const DRAFT_ID = "50000000-0000-4000-8000-000000000001";
const DRAFT_ID_2 = "50000000-0000-4000-8000-000000000002";
const FEED_ID = "60000000-0000-4000-8000-000000000001";
const TEAM_ID = "70000000-0000-4000-8000-000000000001";
const PLAYER_ID = "80000000-0000-4000-8000-000000000001";
const EVENT_ID = "90000000-0000-4000-8000-000000000001";
const LEAGUE_KEY = "449.l.12345";
const CHECKSUM = "a".repeat(64);

function snapshot(overrides: Partial<YahooDraftResultsSnapshot> = {}): YahooDraftResultsSnapshot {
  return {
    leagueKey: LEAGUE_KEY,
    leagueId: "12345",
    status: "drafting",
    providerStatus: "drafting",
    declaredCount: 1,
    observedCount: 1,
    collectionComplete: true,
    refreshRateSeconds: 60,
    picks: [
      {
        pick: 1,
        round: 1,
        teamKey: `${LEAGUE_KEY}.t.1`,
        teamId: "1",
        playerKey: "449.p.101",
        playerId: "101",
        cost: null,
        keeper: null,
      },
    ],
    checksumSha256: CHECKSUM,
    ...overrides,
  };
}

function appendReconciliation(): YahooDraftReconciliationResult {
  return {
    kind: "append",
    append: [
      {
        idempotencyKey: "yahoo-draft:pick-one",
        source: "yahoo",
        revertsSequence: null,
        event: {
          id: draftEventId(EVENT_ID),
          type: "SNAKE_PLAYER_SELECTED",
          teamId: teamId(TEAM_ID),
          playerId: playerId(PLAYER_ID),
          overallPick: 1,
          occurredAt: NOW.toISOString(),
        },
      },
    ],
  };
}

function heldReconciliation(
  issue: Extract<YahooDraftReconciliationResult, { kind: "held" }>["issue"],
): YahooDraftReconciliationResult {
  return { kind: "held", issue, detail: "Sanitized integration-test hold.", append: [] };
}

describe.skipIf(!dockerAvailable)("Yahoo draft polling persistence against real PostgreSQL", () => {
  let container: DisposablePostgres;
  let handle: ReturnType<typeof createDatabase>;
  let db: Database;
  let repository: DrizzleYahooDraftPollRepository;
  let secondRepository: DrizzleYahooDraftPollRepository;
  let draftRepository: DrizzleDraftSessionRepository;

  async function seedFixture(): Promise<void> {
    await db.insert(users).values({
      id: USER_ID,
      email: "yahoo-draft-persistence@example.test",
      displayName: "Yahoo Draft Persistence",
    });
    await db.insert(providerConnections).values({
      id: CONNECTION_ID,
      userId: USER_ID,
      provider: "yahoo",
      externalAccountId: "yahoo-draft-persistence-account",
      health: "healthy",
    });
    await db.insert(leagues).values({
      id: LEAGUE_ID,
      ownerUserId: USER_ID,
      name: "Yahoo Draft Persistence League",
    });
    // League insertion creates the canonical owner membership through a database trigger. The
    // product's shared-state write authority is deliberately separate from lifecycle ownership.
    await db
      .update(leagueMemberships)
      .set({ explicitCommissioner: true })
      .where(eq(leagueMemberships.leagueId, LEAGUE_ID));
    await db.insert(leagueSeasons).values({
      id: LEAGUE_SEASON_ID,
      leagueId: LEAGUE_ID,
      connectionId: CONNECTION_ID,
      provider: "yahoo",
      externalKey: LEAGUE_KEY,
      season: 2031,
      status: "preseason",
      teamCount: 2,
      draftType: "snake",
    });
    await db.insert(drafts).values({
      id: DRAFT_ID,
      leagueSeasonId: LEAGUE_SEASON_ID,
      type: "snake",
      state: "created",
      settings: {},
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    });
    await db.insert(yahooDraftPollFeeds).values({
      id: FEED_ID,
      leagueSeasonId: LEAGUE_SEASON_ID,
      draftId: DRAFT_ID,
      providerLeagueKey: LEAGUE_KEY,
      season: 2031,
      format: "snake",
      applicationMode: "append",
      releaseArtifactChecksum: CHECKSUM,
      standardScopeConfirmed: true,
      state: "waiting",
      nextPollAt: NOW,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    });
  }

  async function resetFixture(): Promise<void> {
    await db.delete(yahooDraftPollObservations);
    await db.delete(draftEvents);
    await db.delete(yahooDraftPollFeeds);
    await db.delete(drafts);
    await db.delete(leagueSeasons);
    await db.delete(leagues);
    await db.delete(providerConnections);
    await db.delete(users);
    await seedFixture();
  }

  async function requireClaim(
    source: DrizzleYahooDraftPollRepository = repository,
    at: Date = NOW,
  ) {
    const claim = await source.claimPoll(DRAFT_ID, at);
    expect(claim).toBeDefined();
    if (!claim) throw new Error("Expected Yahoo poll claim");
    return claim;
  }

  beforeAll(async () => {
    container = await startDisposablePostgres();
    const migrationHandle = createDatabase(container.url, 1);
    try {
      await migrate(migrationHandle.db, { migrationsFolder });
    } finally {
      await migrationHandle.close();
    }

    handle = createDatabase(container.url, 8);
    db = handle.db;
    repository = new DrizzleYahooDraftPollRepository(db, () => NOW);
    secondRepository = new DrizzleYahooDraftPollRepository(db, () => NOW);
    draftRepository = new DrizzleDraftSessionRepository(db, repository);
  }, 90_000);

  beforeEach(resetFixture);

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

  it("coalesces concurrent due claims into one generation and one shared lease", async () => {
    const claims = await Promise.all([
      repository.claimPoll(DRAFT_ID, NOW),
      secondRepository.claimPoll(DRAFT_ID, NOW),
    ]);

    expect(claims.filter((claim) => claim !== undefined)).toHaveLength(1);
    expect(claims.find((claim) => claim !== undefined)).toMatchObject({
      feedId: FEED_ID,
      draftId: DRAFT_ID,
      generation: 1,
    });
    const [feed] = await db.select().from(yahooDraftPollFeeds);
    expect(feed).toMatchObject({ pollGeneration: 1, state: "waiting" });
    expect(feed?.pollLeaseExpiresAt).toEqual(new Date(NOW.getTime() + 45_000));
    expect(feed?.nextPollAt).toEqual(new Date(NOW.getTime() + 15_000));
  });

  it("serializes simultaneous first assisted-room creation for one league season", async () => {
    await db.delete(yahooDraftPollFeeds);
    await db.delete(drafts);
    const secondDraftRepository = new DrizzleDraftSessionRepository(db, secondRepository);
    const input = (draftId: string) => ({
      id: draftId,
      actorUserId: USER_ID,
      leagueSeasonId: LEAGUE_SEASON_ID,
      type: "snake" as const,
      budgetPerTeam: null,
      minimumBid: null,
      settings: {},
      yahooFeed: {
        providerLeagueKey: LEAGUE_KEY,
        season: 2031,
        format: "snake" as const,
        applicationMode: "shadow" as const,
        releaseArtifactChecksum: CHECKSUM,
        standardScopeConfirmed: true,
      },
      now: NOW,
    });

    const results = await Promise.all([
      draftRepository.createDraft(input(DRAFT_ID)),
      secondDraftRepository.createDraft(input(DRAFT_ID_2)),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual([
      "provider-feed-conflict",
      "saved",
    ]);
    expect(await db.select().from(drafts)).toHaveLength(1);
    expect(await db.select().from(yahooDraftPollFeeds)).toHaveLength(1);
  });

  it("does not let a stale generation commit over a newer lease", async () => {
    const staleClaim = await requireClaim();
    const newerAt = new Date(NOW.getTime() + 60_000);
    const currentClaim = await requireClaim(secondRepository, newerAt);

    await repository.commitObservation({
      claim: staleClaim,
      connectionId: CONNECTION_ID,
      expectedSequence: 0,
      resultingDraftState: "live",
      snapshot: snapshot(),
      reconciliation: heldReconciliation("INCOMPLETE_SNAPSHOT"),
      checkedAt: new Date(newerAt.getTime() + 1_000),
      pollIntervalSeconds: 15,
    });

    expect(currentClaim.generation).toBe(2);
    expect(await db.select().from(yahooDraftPollObservations)).toHaveLength(0);
    const [feed] = await db.select().from(yahooDraftPollFeeds);
    expect(feed).toMatchObject({
      pollGeneration: 2,
      lastChecksum: null,
      lastIssueCode: null,
    });
    expect(feed?.pollLeaseExpiresAt).toEqual(new Date(newerAt.getTime() + 45_000));
  });

  it("preserves a reconciliation hold reason even when the feed is shadow-only", async () => {
    await db
      .update(yahooDraftPollFeeds)
      .set({ applicationMode: "shadow" })
      .where(eq(yahooDraftPollFeeds.id, FEED_ID));
    // Provider-only status still needs a strictly newer public room revision when the existing
    // timestamp equals (or slightly leads) this poll's timestamp.
    await db.update(drafts).set({ updatedAt: NOW }).where(eq(drafts.id, DRAFT_ID));
    const claim = await requireClaim();

    await repository.commitObservation({
      claim,
      connectionId: CONNECTION_ID,
      expectedSequence: 0,
      resultingDraftState: "live",
      snapshot: snapshot(),
      reconciliation: heldReconciliation("HISTORY_DIVERGED"),
      checkedAt: NOW,
      pollIntervalSeconds: 15,
    });

    expect(await db.select().from(yahooDraftPollObservations)).toMatchObject([
      { result: "held", issueCode: "HISTORY_DIVERGED", appliedEvents: 0 },
    ]);
    const [feed] = await db.select().from(yahooDraftPollFeeds);
    expect(feed).toMatchObject({
      state: "attention",
      verification: "mismatched",
      lastIssueCode: "HISTORY_DIVERGED",
    });
    expect(await db.select().from(draftEvents)).toHaveLength(0);
  });

  it("does not label a status-only shadow observation as an observed pick", async () => {
    await db
      .update(yahooDraftPollFeeds)
      .set({ applicationMode: "shadow" })
      .where(eq(yahooDraftPollFeeds.id, FEED_ID));
    // Equal (and clock-skewed future) revisions must still advance when only feed state changes.
    await db.update(drafts).set({ updatedAt: NOW }).where(eq(drafts.id, DRAFT_ID));
    const claim = await requireClaim();

    await repository.commitObservation({
      claim,
      connectionId: CONNECTION_ID,
      expectedSequence: 0,
      resultingDraftState: "live",
      snapshot: snapshot({
        status: "predraft",
        providerStatus: "predraft",
        declaredCount: 0,
        observedCount: 0,
        picks: [],
        checksumSha256: "b".repeat(64),
      }),
      reconciliation: { kind: "idempotent", append: [] },
      checkedAt: NOW,
      pollIntervalSeconds: 900,
    });

    const [feed] = await db.select().from(yahooDraftPollFeeds);
    expect(feed).toMatchObject({
      lastChangedAt: NOW,
      lastMaterialEventAt: null,
      lastObservedCount: 0,
    });
    expect(feed?.nextPollAt).toEqual(new Date(NOW.getTime() + 900_000));
    const status = await new DrizzleYahooDraftPollRepository(
      db,
      () => new Date(NOW.getTime() + 300_000),
    ).loadFeedStatus(DRAFT_ID);
    expect(status).toMatchObject({
      provider: "yahoo",
      state: "waiting",
      ageSeconds: 300,
      fresh: true,
      pollIntervalSeconds: 900,
    });
    const [draft] = await db.select().from(drafts).where(eq(drafts.id, DRAFT_ID));
    expect(draft?.updatedAt).toEqual(new Date(NOW.getTime() + 1));
  });

  it("stores sanitized throttle telemetry and opens a connection-scoped cooldown", async () => {
    await db.update(drafts).set({ updatedAt: NOW }).where(eq(drafts.id, DRAFT_ID));
    const claim = await requireClaim();

    await repository.recordFailure({
      claim,
      connectionId: CONNECTION_ID,
      issue: "POLL_FAILED",
      failureClass: "rate-limited",
      checkedAt: NOW,
      retryAfterMs: 120_000,
    });

    const [observation] = await db.select().from(yahooDraftPollObservations);
    expect(observation).toMatchObject({
      result: "failed",
      issueCode: "POLL_FAILED",
      normalizedPayload: {
        schemaVersion: 1,
        provider: "yahoo",
        outcome: "failed",
        failureClass: "rate-limited",
        retryAfterSeconds: 120,
        effectiveBackoffSeconds: 120,
      },
    });
    const [feed] = await db.select().from(yahooDraftPollFeeds);
    expect(feed?.nextPollAt).toEqual(new Date(NOW.getTime() + 120_000));
    const [draft] = await db.select().from(drafts).where(eq(drafts.id, DRAFT_ID));
    expect(draft?.updatedAt).toEqual(new Date(NOW.getTime() + 1));
    const [connection] = await db.select().from(providerConnections);
    expect(connection).toMatchObject({
      circuitOpenUntil: new Date(NOW.getTime() + 120_000),
      lastErrorCode: "YAHOO_DRAFT_RATE_LIMITED",
      lastErrorAt: NOW,
    });
  });

  it("caps an extreme provider Retry-After before scheduling or opening the circuit", async () => {
    const claim = await requireClaim();

    await repository.recordFailure({
      claim,
      connectionId: CONNECTION_ID,
      issue: "POLL_FAILED",
      failureClass: "rate-limited",
      checkedAt: NOW,
      retryAfterMs: Number.MAX_SAFE_INTEGER,
    });

    const [observation] = await db.select().from(yahooDraftPollObservations);
    expect(observation?.normalizedPayload).toMatchObject({
      retryAfterSeconds: 15 * 60,
      effectiveBackoffSeconds: 15 * 60,
    });
    const [feed] = await db.select().from(yahooDraftPollFeeds);
    expect(feed?.nextPollAt).toEqual(new Date(NOW.getTime() + 15 * 60 * 1_000));
    const [connection] = await db.select().from(providerConnections);
    expect(connection?.circuitOpenUntil).toEqual(new Date(NOW.getTime() + 15 * 60 * 1_000));
  });

  it("opens the shared circuit for an ordinary Yahoo throttle without degrading health", async () => {
    const yahooSync = new DrizzleYahooSyncRepository(db, () => NOW);
    const cooldownUntil = new Date(NOW.getTime() + 120_000);

    await yahooSync.markFailure(USER_ID, CONNECTION_ID, "read_rate_limited", NOW, {
      cooldownUntil,
    });

    const [connection] = await db.select().from(providerConnections);
    expect(connection).toMatchObject({
      health: "healthy",
      circuitOpenUntil: cooldownUntil,
      lastErrorCode: "read_rate_limited",
      lastErrorAt: NOW,
    });
    await expect(yahooSync.findOwnedConnection(USER_ID, CONNECTION_ID)).resolves.toMatchObject({
      circuitOpenUntil: cooldownUntil,
    });
  });

  it("does not revive a disabled Yahoo authorization while recording a sync failure", async () => {
    await db
      .update(providerConnections)
      .set({ health: "disabled" })
      .where(eq(providerConnections.id, CONNECTION_ID));
    const yahooSync = new DrizzleYahooSyncRepository(db, () => NOW);

    await yahooSync.markFailure(USER_ID, CONNECTION_ID, "reauthorization_required", NOW);

    const [connection] = await db.select().from(providerConnections);
    expect(connection).toMatchObject({
      health: "disabled",
      lastErrorCode: "reauthorization_required",
      lastErrorAt: NOW,
    });
  });

  it("holds a stale plan after a manual ledger mutation and never marks it verified", async () => {
    const claim = await requireClaim();
    await db.insert(draftEvents).values({
      draftId: DRAFT_ID,
      sequence: 1,
      idempotencyKey: "manual:pick-one",
      type: "SNAKE_PLAYER_SELECTED",
      occurredAt: NOW,
      source: "manual",
      payload: {
        id: EVENT_ID,
        type: "SNAKE_PLAYER_SELECTED",
        teamId: TEAM_ID,
        playerId: PLAYER_ID,
        overallPick: 1,
      },
      revertsSequence: null,
    });

    await repository.commitObservation({
      claim,
      connectionId: CONNECTION_ID,
      expectedSequence: 0,
      resultingDraftState: "complete",
      snapshot: snapshot({ status: "postdraft", providerStatus: "postdraft" }),
      reconciliation: appendReconciliation(),
      checkedAt: NOW,
      pollIntervalSeconds: 60,
    });

    expect(await db.select().from(yahooDraftPollObservations)).toMatchObject([
      { result: "held", issueCode: "CONCURRENT_LEDGER_CHANGE", appliedEvents: 0 },
    ]);
    expect(await db.select().from(draftEvents)).toMatchObject([
      { sequence: 1, source: "manual", idempotencyKey: "manual:pick-one" },
    ]);
    const [feed] = await db.select().from(yahooDraftPollFeeds);
    expect(feed).toMatchObject({
      state: "attention",
      verification: "pending",
      lastIssueCode: "CONCURRENT_LEDGER_CHANGE",
    });
  });

  it("disables an archived league before an admitted observation can append", async () => {
    const claim = await requireClaim();
    await db.update(leagues).set({ archived: true }).where(eq(leagues.id, LEAGUE_ID));

    await repository.commitObservation({
      claim,
      connectionId: CONNECTION_ID,
      expectedSequence: 0,
      resultingDraftState: "live",
      snapshot: snapshot(),
      reconciliation: appendReconciliation(),
      checkedAt: NOW,
      pollIntervalSeconds: 15,
    });

    expect(await db.select().from(draftEvents)).toHaveLength(0);
    expect(await db.select().from(yahooDraftPollObservations)).toMatchObject([
      { result: "held", appliedEvents: 0 },
    ]);
    const [feed] = await db.select().from(yahooDraftPollFeeds);
    expect(feed).toMatchObject({ state: "disabled", verification: "pending" });
  });

  it("reopens a complete verified Yahoo feed after a manual session mutation", async () => {
    const previousNextPollAt = new Date(NOW.getTime() + 3_600_000);
    await db
      .update(yahooDraftPollFeeds)
      .set({
        state: "complete",
        verification: "verified",
        lastIssueCode: null,
        nextPollAt: previousNextPollAt,
      })
      .where(eq(yahooDraftPollFeeds.id, FEED_ID));

    await expect(
      draftRepository.appendEvents({
        actorUserId: USER_ID,
        draftId: DRAFT_ID,
        expectedSequence: 0,
        events: [
          {
            sequence: 1,
            idempotencyKey: "manual:reopen-yahoo-feed",
            type: "SNAKE_PLAYER_SELECTED",
            occurredAt: NOW,
            source: "manual",
            payload: {
              id: EVENT_ID,
              type: "SNAKE_PLAYER_SELECTED",
              teamId: TEAM_ID,
              playerId: PLAYER_ID,
              overallPick: 1,
            },
            revertsSequence: null,
          },
        ],
        resultingState: "live",
        now: NOW,
      }),
    ).resolves.toMatchObject({ status: "saved" });

    const [feed] = await db.select().from(yahooDraftPollFeeds);
    expect(feed).toMatchObject({
      state: "attention",
      verification: "pending",
      lastIssueCode: "CONCURRENT_LEDGER_CHANGE",
    });
    expect(feed?.nextPollAt).toEqual(NOW);
    expect(feed?.pollLeaseExpiresAt).toBeNull();
  });

  it("does not release a poll lease or bypass backoff for an ordinary manual pick", async () => {
    const leaseExpiresAt = new Date(NOW.getTime() + 45_000);
    const nextPollAt = new Date(NOW.getTime() + 120_000);
    await db
      .update(yahooDraftPollFeeds)
      .set({
        state: "delayed",
        verification: "pending",
        lastIssueCode: "POLL_FAILED",
        pollLeaseExpiresAt: leaseExpiresAt,
        nextPollAt,
      })
      .where(eq(yahooDraftPollFeeds.id, FEED_ID));

    await expect(
      draftRepository.appendEvents({
        actorUserId: USER_ID,
        draftId: DRAFT_ID,
        expectedSequence: 0,
        events: [
          {
            sequence: 1,
            idempotencyKey: "manual:preserve-yahoo-cadence",
            type: "SNAKE_PLAYER_SELECTED",
            occurredAt: NOW,
            source: "manual",
            payload: {
              id: EVENT_ID,
              type: "SNAKE_PLAYER_SELECTED",
              teamId: TEAM_ID,
              playerId: PLAYER_ID,
              overallPick: 1,
            },
            revertsSequence: null,
          },
        ],
        resultingState: "live",
        now: NOW,
      }),
    ).resolves.toMatchObject({ status: "saved" });

    const [feed] = await db.select().from(yahooDraftPollFeeds);
    expect(feed).toMatchObject({
      state: "delayed",
      verification: "pending",
      lastIssueCode: "POLL_FAILED",
      pollLeaseExpiresAt: leaseExpiresAt,
      nextPollAt,
    });
  });

  it("commits an admitted append, observation, feed cursor, and draft state together", async () => {
    await db
      .update(providerConnections)
      .set({
        consecutiveFailures: 2,
        circuitOpenUntil: new Date(NOW.getTime() - 1_000),
        lastErrorCode: "YAHOO_DRAFT_RATE_LIMITED",
        lastErrorAt: CREATED_AT,
      })
      .where(eq(providerConnections.id, CONNECTION_ID));
    const claim = await requireClaim();

    await repository.commitObservation({
      claim,
      connectionId: CONNECTION_ID,
      expectedSequence: 0,
      resultingDraftState: "live",
      snapshot: snapshot(),
      reconciliation: appendReconciliation(),
      checkedAt: NOW,
      pollIntervalSeconds: 15,
    });

    expect(await db.select().from(draftEvents)).toMatchObject([
      {
        sequence: 1,
        source: "yahoo",
        idempotencyKey: "yahoo-draft:pick-one",
        type: "SNAKE_PLAYER_SELECTED",
      },
    ]);
    expect(await db.select().from(yahooDraftPollObservations)).toMatchObject([
      { pollGeneration: 1, result: "appended", issueCode: null, appliedEvents: 1 },
    ]);
    const [feed] = await db.select().from(yahooDraftPollFeeds);
    expect(feed).toMatchObject({
      state: "drafting",
      pollGeneration: 1,
      lastChecksum: CHECKSUM,
      lastObservedCount: 1,
      verification: "pending",
      lastIssueCode: null,
    });
    expect(feed?.pollLeaseExpiresAt).toBeNull();
    expect(feed?.nextPollAt).toEqual(new Date(NOW.getTime() + 15_000));
    expect(await db.select().from(drafts)).toMatchObject([{ id: DRAFT_ID, state: "live" }]);
    expect(await db.select().from(providerConnections)).toMatchObject([
      {
        consecutiveFailures: 0,
        circuitOpenUntil: null,
        lastSuccessfulAt: NOW,
        lastErrorCode: null,
        lastErrorAt: null,
      },
    ]);
  });

  it("rolls back an appended event when the same transaction cannot persist its observation", async () => {
    const claim = await requireClaim();

    await expect(
      repository.commitObservation({
        claim,
        connectionId: CONNECTION_ID,
        expectedSequence: 0,
        resultingDraftState: "live",
        snapshot: snapshot({ checksumSha256: "invalid-checksum" }),
        reconciliation: appendReconciliation(),
        checkedAt: NOW,
        pollIntervalSeconds: 15,
      }),
    ).rejects.toBeDefined();

    expect(await db.select().from(draftEvents)).toHaveLength(0);
    expect(await db.select().from(yahooDraftPollObservations)).toHaveLength(0);
    expect(await db.select().from(drafts)).toMatchObject([{ id: DRAFT_ID, state: "created" }]);
    const [feed] = await db.select().from(yahooDraftPollFeeds);
    expect(feed).toMatchObject({
      pollGeneration: 1,
      lastChecksum: null,
      lastObservedCount: 0,
      state: "waiting",
    });
    // The claim happened before the failed commit transaction, so its protective lease remains.
    expect(feed?.pollLeaseExpiresAt).toEqual(new Date(NOW.getTime() + 45_000));
  });

  it("deletes a Yahoo-backed draft and cascades its feed, observations, and events", async () => {
    const claim = await requireClaim();
    await repository.commitObservation({
      claim,
      connectionId: CONNECTION_ID,
      expectedSequence: 0,
      resultingDraftState: "live",
      snapshot: snapshot(),
      reconciliation: appendReconciliation(),
      checkedAt: NOW,
      pollIntervalSeconds: 15,
    });

    await expect(
      db.delete(drafts).where(eq(drafts.id, DRAFT_ID)).returning({ id: drafts.id }),
    ).resolves.toEqual([{ id: DRAFT_ID }]);

    expect(await db.select().from(drafts)).toHaveLength(0);
    expect(await db.select().from(yahooDraftPollFeeds)).toHaveLength(0);
    expect(await db.select().from(yahooDraftPollObservations)).toHaveLength(0);
    expect(await db.select().from(draftEvents)).toHaveLength(0);
    expect(await db.select().from(leagueSeasons)).toHaveLength(1);
  });
});
