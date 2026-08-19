/**
 * Real PostgreSQL coverage for authenticated ESPN team-identity persistence.
 *
 * The conflict-safe auto-claim depends on a partial unique index and a nested transaction
 * savepoint, so an in-memory Drizzle fake cannot prove the behavior that matters here. The suite
 * uses a disposable container and never reads DATABASE_URL or an environment file.
 */
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { LeagueSyncBundle, NormalizedTeam } from "@laces-out/connectors";
import {
  createDatabase,
  fantasyTeams,
  leagueMemberships,
  leagues,
  leagueSeasons,
  providerConnections,
  providerLeagueLinks,
  users,
  type Database,
} from "@laces-out/db";
import { and, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DrizzleEspnSyncPersistence, type PersistEspnSyncInput } from "./espn-sync-persistence.js";

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
    "[league-sync/espn-sync-persistence.pg.test] Skipping disposable-PostgreSQL tests: docker is unavailable.",
  );
}

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../db/migrations",
);

interface DisposablePostgres {
  readonly containerName: string;
  readonly url: string;
}

async function startDisposablePostgres(): Promise<DisposablePostgres> {
  const containerName = `laces-out-espn-identity-pg-${randomUUID().slice(0, 8)}`;
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

interface Scenario {
  readonly actorUserId: string;
  readonly connectionId: string;
  readonly leagueId: string;
  readonly leagueSeasonId: string;
  readonly providerLeagueId: string;
}

const SEASON = 2031;
const FIRST_CAPTURE = new Date("2031-09-16T12:00:00.000Z");
const SECOND_CAPTURE = new Date("2031-09-16T18:00:00.000Z");

function team(
  providerLeagueId: string,
  providerTeamId: string,
  isCurrentUser: boolean,
): NormalizedTeam {
  const externalId = `espn:${SEASON}:${providerLeagueId}:team:${providerTeamId}`;
  return {
    externalId,
    providerTeamId,
    name: `Team ${providerTeamId}`,
    abbreviation: null,
    url: null,
    logoUrl: null,
    isCurrentUser,
    managers: [],
    roster: [],
  };
}

function bundle(
  providerLeagueId: string,
  currentProviderTeamId: "1" | "2" | null,
): LeagueSyncBundle {
  return {
    schemaVersion: 1,
    provider: "espn",
    league: {
      externalId: `espn:${SEASON}:${providerLeagueId}`,
      providerLeagueId,
      provider: "espn",
      season: SEASON,
      name: "Authenticated ESPN League",
      url: null,
      currentWeek: 1,
      settings: {
        teamCount: 2,
        draftType: "snake",
        auctionBudget: null,
        waiverType: "rolling",
        faabBudget: null,
        playoffTeamCount: 2,
        rosterSlots: [],
        scoringRules: [],
      },
    },
    teams: ["1", "2"].map((providerTeamId) =>
      team(providerLeagueId, providerTeamId, currentProviderTeamId === providerTeamId),
    ),
    provenance: {
      mode: "server-session",
      fetchedAt: FIRST_CAPTURE.toISOString(),
      endpoint: "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/2031",
      artifactChecksumSha256: "a".repeat(64),
    },
    warnings: [],
  };
}

function persistenceInput(
  scenario: Scenario,
  syncBundle: LeagueSyncBundle,
  effectiveAt: Date,
): PersistEspnSyncInput {
  return {
    authority: {
      mode: "server-session",
      actorUserId: scenario.actorUserId,
      connectionId: scenario.connectionId,
      leagueSeasonId: scenario.leagueSeasonId,
    },
    bundle: syncBundle,
    checksumSha256: "a".repeat(64),
    effectiveAt,
    idempotencyKey: `espn-identity-test:${randomUUID()}`,
    kind: "espn-session",
    now: new Date(effectiveAt.getTime() + 1_000),
  };
}

describe.skipIf(!dockerAvailable)("ESPN server-session identity against real PostgreSQL", () => {
  let container: DisposablePostgres;
  let handle: ReturnType<typeof createDatabase>;
  let db: Database;
  let persistence: DrizzleEspnSyncPersistence;
  let scenarioCounter = 10_000;

  async function createScenario(
    currentUserTeamExternalKey: string | null = null,
  ): Promise<Scenario> {
    scenarioCounter += 1;
    const actorUserId = randomUUID();
    const connectionId = randomUUID();
    const leagueId = randomUUID();
    const leagueSeasonId = randomUUID();
    const providerLeagueId = String(scenarioCounter);

    await db.insert(users).values({
      id: actorUserId,
      email: `espn-identity-${providerLeagueId}@example.test`,
      displayName: `ESPN User ${providerLeagueId}`,
    });
    await db.insert(providerConnections).values({
      id: connectionId,
      userId: actorUserId,
      provider: "espn",
      externalAccountId: `espn-account-${providerLeagueId}`,
      encryptedCredential: { version: 1, ciphertext: "sanitized-test-envelope" },
      capabilities: { authentication: ["server-session-cookie"] },
      health: "healthy",
    });
    await db.insert(leagues).values({
      id: leagueId,
      ownerUserId: actorUserId,
      name: `ESPN League ${providerLeagueId}`,
    });
    await db.insert(leagueSeasons).values({
      id: leagueSeasonId,
      leagueId,
      connectionId,
      provider: "espn",
      externalKey: providerLeagueId,
      season: SEASON,
      status: "active",
      teamCount: 2,
      draftType: "snake",
      waiverType: "rolling",
      currentWeek: 1,
    });
    await db.insert(providerLeagueLinks).values({
      connectionId,
      leagueSeasonId,
      currentUserTeamExternalKey,
    });

    return { actorUserId, connectionId, leagueId, leagueSeasonId, providerLeagueId };
  }

  async function storedTeam(scenario: Scenario, providerTeamId: "1" | "2") {
    const externalKey = `espn:${SEASON}:${scenario.providerLeagueId}:team:${providerTeamId}`;
    const [stored] = await db
      .select({ id: fantasyTeams.id, externalKey: fantasyTeams.externalKey })
      .from(fantasyTeams)
      .where(
        and(
          eq(fantasyTeams.leagueSeasonId, scenario.leagueSeasonId),
          eq(fantasyTeams.externalKey, externalKey),
        ),
      )
      .limit(1);
    if (!stored) throw new Error(`Expected ESPN team ${providerTeamId} to be persisted`);
    return stored;
  }

  async function identityState(scenario: Scenario) {
    const [link] = await db
      .select({
        currentUserTeamExternalKey: providerLeagueLinks.currentUserTeamExternalKey,
        lastSyncedAt: providerLeagueLinks.lastSyncedAt,
      })
      .from(providerLeagueLinks)
      .where(
        and(
          eq(providerLeagueLinks.connectionId, scenario.connectionId),
          eq(providerLeagueLinks.leagueSeasonId, scenario.leagueSeasonId),
        ),
      )
      .limit(1);
    const [membership] = await db
      .select({
        claimedFantasyTeamId: leagueMemberships.claimedFantasyTeamId,
        claimedAt: leagueMemberships.claimedAt,
      })
      .from(leagueMemberships)
      .where(
        and(
          eq(leagueMemberships.leagueId, scenario.leagueId),
          eq(leagueMemberships.userId, scenario.actorUserId),
        ),
      )
      .limit(1);
    if (!link || !membership) throw new Error("Expected scenario identity rows to exist");
    return { link, membership };
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
    persistence = new DrizzleEspnSyncPersistence(db);
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

  it("stores the exact verified mapping and auto-claims an unclaimed actor membership", async () => {
    const scenario = await createScenario();
    const teamOneExternalKey = `espn:${SEASON}:${scenario.providerLeagueId}:team:1`;

    const receipt = await persistence.persist(
      persistenceInput(scenario, bundle(scenario.providerLeagueId, "1"), FIRST_CAPTURE),
    );

    expect(receipt.state).toBe("accepted");
    const teamOne = await storedTeam(scenario, "1");
    const state = await identityState(scenario);
    expect(state.link.currentUserTeamExternalKey).toBe(teamOneExternalKey);
    expect(state.link.lastSyncedAt).toEqual(FIRST_CAPTURE);
    expect(state.membership.claimedFantasyTeamId).toBe(teamOne.id);
    expect(state.membership.claimedAt).toEqual(new Date(FIRST_CAPTURE.getTime() + 1_000));
  });

  it("clears a stale mapping on zero matches and backfills identity on an unchanged sync", async () => {
    const scenario = await createScenario("espn:2031:stale:team:99");

    const firstReceipt = await persistence.persist(
      persistenceInput(scenario, bundle(scenario.providerLeagueId, null), FIRST_CAPTURE),
    );
    expect(firstReceipt.state).toBe("accepted");
    expect((await identityState(scenario)).link.currentUserTeamExternalKey).toBeNull();
    expect((await identityState(scenario)).membership.claimedFantasyTeamId).toBeNull();

    const secondReceipt = await persistence.persist(
      persistenceInput(scenario, bundle(scenario.providerLeagueId, "2"), SECOND_CAPTURE),
    );

    expect(secondReceipt.state).toBe("unchanged");
    expect(secondReceipt.receiptId).toBe(firstReceipt.receiptId);
    const teamTwo = await storedTeam(scenario, "2");
    const state = await identityState(scenario);
    expect(state.link.currentUserTeamExternalKey).toBe(teamTwo.externalKey);
    expect(state.link.lastSyncedAt).toEqual(SECOND_CAPTURE);
    expect(state.membership.claimedFantasyTeamId).toBe(teamTwo.id);
  });

  it("keeps a taken mapped team conflict from failing the otherwise valid sync", async () => {
    const scenario = await createScenario();
    const firstReceipt = await persistence.persist(
      persistenceInput(scenario, bundle(scenario.providerLeagueId, null), FIRST_CAPTURE),
    );
    const teamOne = await storedTeam(scenario, "1");
    const otherUserId = randomUUID();
    await db.insert(users).values({
      id: otherUserId,
      email: `espn-conflict-${scenario.providerLeagueId}@example.test`,
      displayName: "Existing Team Manager",
    });
    await db.insert(leagueMemberships).values({
      leagueId: scenario.leagueId,
      userId: otherUserId,
      role: "manager",
      claimedFantasyTeamId: teamOne.id,
      claimedAt: FIRST_CAPTURE,
    });

    const secondReceipt = await persistence.persist(
      persistenceInput(scenario, bundle(scenario.providerLeagueId, "1"), SECOND_CAPTURE),
    );

    expect(firstReceipt.state).toBe("accepted");
    expect(secondReceipt.state).toBe("unchanged");
    const state = await identityState(scenario);
    expect(state.link.currentUserTeamExternalKey).toBe(teamOne.externalKey);
    expect(state.membership.claimedFantasyTeamId).toBeNull();
  });

  it("updates provider identity without overwriting an actor's existing team claim", async () => {
    const scenario = await createScenario();
    await persistence.persist(
      persistenceInput(scenario, bundle(scenario.providerLeagueId, null), FIRST_CAPTURE),
    );
    const teamOne = await storedTeam(scenario, "1");
    const teamTwo = await storedTeam(scenario, "2");
    await db
      .update(leagueMemberships)
      .set({ claimedFantasyTeamId: teamTwo.id, claimedAt: FIRST_CAPTURE })
      .where(
        and(
          eq(leagueMemberships.leagueId, scenario.leagueId),
          eq(leagueMemberships.userId, scenario.actorUserId),
        ),
      );

    const receipt = await persistence.persist(
      persistenceInput(scenario, bundle(scenario.providerLeagueId, "1"), SECOND_CAPTURE),
    );

    expect(receipt.state).toBe("unchanged");
    const state = await identityState(scenario);
    expect(state.link.currentUserTeamExternalKey).toBe(teamOne.externalKey);
    expect(state.membership.claimedFantasyTeamId).toBe(teamTwo.id);
  });
});
