/**
 * Real PostgreSQL coverage for authenticated ESPN team-identity persistence.
 *
 * The conflict-safe auto-claim depends on a partial unique index and a nested transaction
 * savepoint, so an in-memory Drizzle fake cannot prove the behavior that matters here. The suite
 * uses a disposable container and never reads DATABASE_URL or an environment file.
 */
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { LeagueSyncBundle, NormalizedTeam } from "@laces-out/connectors";
import {
  auditEvents,
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
import { and, eq, inArray, sql } from "drizzle-orm";
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

async function migrationsThrough(index: number): Promise<string> {
  const temporaryFolder = await mkdtemp(path.join(tmpdir(), "laces-out-migrations-"));
  const metadataFolder = path.join(temporaryFolder, "meta");
  await mkdir(metadataFolder);
  const journalPath = path.join(migrationsFolder, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
    entries: Array<{ idx: number }>;
  };
  journal.entries = journal.entries.filter((entry) => entry.idx <= index);
  await writeFile(
    path.join(metadataFolder, "_journal.json"),
    `${JSON.stringify(journal, null, 2)}\n`,
    "utf8",
  );
  for (const filename of await readdir(migrationsFolder)) {
    const migrationIndex = /^(\d{4})_.+\.sql$/u.exec(filename)?.[1];
    if (!migrationIndex || Number(migrationIndex) > index) continue;
    await copyFile(path.join(migrationsFolder, filename), path.join(temporaryFolder, filename));
  }
  return temporaryFolder;
}

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
  currentUserIsCommissioner: boolean | null | undefined,
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
    ...(isCurrentUser && currentUserIsCommissioner !== undefined
      ? { currentUserIsCommissioner }
      : {}),
    managers: [],
    roster: [],
  };
}

function bundle(
  providerLeagueId: string,
  currentProviderTeamId: "1" | "2" | null,
  currentUserIsCommissioner?: boolean | null,
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
      team(
        providerLeagueId,
        providerTeamId,
        currentProviderTeamId === providerTeamId,
        currentUserIsCommissioner,
      ),
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
  type LegacyMembershipState = {
    explicitCommissioner: boolean;
    role: "owner" | "commissioner" | "member";
  };
  let legacyMigrationState:
    | {
        acceptedInvitationMember: LegacyMembershipState;
        malformedAudit: LegacyMembershipState;
        invitationGrant: LegacyMembershipState;
        manualGrant: LegacyMembershipState;
        ownerInvitationGrant: LegacyMembershipState;
        providerOnly: LegacyMembershipState;
        touchedAfterPromotion: LegacyMembershipState;
      }
    | undefined;
  let scenarioCounter = 10_000;

  async function createScenario(
    currentUserTeamExternalKey: string | null = null,
    actorRole: "owner" | "member" = "owner",
  ): Promise<Scenario> {
    scenarioCounter += 1;
    const actorUserId = randomUUID();
    const connectionId = randomUUID();
    const leagueId = randomUUID();
    const leagueSeasonId = randomUUID();
    const providerLeagueId = String(scenarioCounter);
    const ownerUserId = actorRole === "owner" ? actorUserId : randomUUID();

    await db.insert(users).values([
      {
        id: actorUserId,
        email: `espn-identity-${providerLeagueId}@example.test`,
        displayName: `ESPN User ${providerLeagueId}`,
      },
      ...(ownerUserId === actorUserId
        ? []
        : [
            {
              id: ownerUserId,
              email: `espn-owner-${providerLeagueId}@example.test`,
              displayName: `ESPN Owner ${providerLeagueId}`,
            },
          ]),
    ]);
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
      ownerUserId,
      name: `ESPN League ${providerLeagueId}`,
    });
    if (actorRole === "member") {
      await db.insert(leagueMemberships).values({
        leagueId,
        userId: actorUserId,
        role: "member",
      });
    }
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
        providerCommissioner: providerLeagueLinks.providerCommissioner,
        providerCommissionerObservedAt: providerLeagueLinks.providerCommissionerObservedAt,
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
        role: leagueMemberships.role,
        explicitCommissioner: leagueMemberships.explicitCommissioner,
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
      const partialMigrations = await migrationsThrough(39);
      try {
        await migrate(migrationHandle.db, { migrationsFolder: partialMigrations });
      } finally {
        await rm(partialMigrations, { recursive: true, force: true });
      }

      const historicalAt = "2031-08-31T18:00:00.000Z";
      const laterGrantAt = "2031-09-01T18:00:00.000Z";
      const ownerUserId = randomUUID();
      const acceptedInvitationMemberUserId = randomUUID();
      const providerOnlyUserId = randomUUID();
      const manualGrantUserId = randomUUID();
      const invitationGrantUserId = randomUUID();
      const touchedAfterPromotionUserId = randomUUID();
      const malformedAuditUserId = randomUUID();
      const legacyLeagueId = randomUUID();
      const acceptedInvitationMemberMembershipId = randomUUID();
      const providerOnlyMembershipId = randomUUID();
      const manualGrantMembershipId = randomUUID();
      const invitationGrantMembershipId = randomUUID();
      const touchedMembershipId = randomUUID();
      const malformedMembershipId = randomUUID();
      await migrationHandle.db.execute(sql`
        insert into users (id, email, display_name) values
          (${ownerUserId}, ${`${ownerUserId}@example.test`}, 'Legacy Owner'),
          (${acceptedInvitationMemberUserId}, ${`${acceptedInvitationMemberUserId}@example.test`}, 'Previously Invited Member'),
          (${providerOnlyUserId}, ${`${providerOnlyUserId}@example.test`}, 'Provider Only'),
          (${manualGrantUserId}, ${`${manualGrantUserId}@example.test`}, 'Manual Commissioner'),
          (${invitationGrantUserId}, ${`${invitationGrantUserId}@example.test`}, 'Invited Commissioner'),
          (${touchedAfterPromotionUserId}, ${`${touchedAfterPromotionUserId}@example.test`}, 'Later Grant'),
          (${malformedAuditUserId}, ${`${malformedAuditUserId}@example.test`}, 'Malformed Audit')
      `);
      await migrationHandle.db.execute(sql`
        insert into leagues (id, user_id, name)
        values (${legacyLeagueId}, ${ownerUserId}, 'Legacy Commissioner Migration')
      `);
      await migrationHandle.db.execute(sql`
        insert into league_memberships (id, league_id, user_id, role, updated_at) values
          (${acceptedInvitationMemberMembershipId}, ${legacyLeagueId}, ${acceptedInvitationMemberUserId}, 'member', ${laterGrantAt}),
          (${providerOnlyMembershipId}, ${legacyLeagueId}, ${providerOnlyUserId}, 'commissioner', ${historicalAt}),
          (${manualGrantMembershipId}, ${legacyLeagueId}, ${manualGrantUserId}, 'commissioner', ${historicalAt}),
          (${touchedMembershipId}, ${legacyLeagueId}, ${touchedAfterPromotionUserId}, 'commissioner', ${laterGrantAt}),
          (${malformedMembershipId}, ${legacyLeagueId}, ${malformedAuditUserId}, 'commissioner', ${historicalAt})
      `);
      await migrationHandle.db.execute(sql`
        insert into invitations (
          token_hash, email, email_hash, invited_by_user_id, league_id, league_role,
          expires_at, accepted_at, accepted_by_user_id
        ) values
          (
            ${"a".repeat(64)}, ${`${invitationGrantUserId}@example.test`}, ${"b".repeat(64)},
            ${ownerUserId}, ${legacyLeagueId}, 'commissioner', '2032-01-01T00:00:00.000Z',
            ${historicalAt}, ${invitationGrantUserId}
          ),
          (
            ${"c".repeat(64)}, ${`${ownerUserId}@example.test`}, ${"d".repeat(64)},
            ${ownerUserId}, ${legacyLeagueId}, 'commissioner', '2032-01-01T00:00:00.000Z',
            ${historicalAt}, ${ownerUserId}
          ),
          (
            ${"e".repeat(64)}, ${`${acceptedInvitationMemberUserId}@example.test`}, ${"f".repeat(64)},
            ${ownerUserId}, ${legacyLeagueId}, 'commissioner', '2032-01-01T00:00:00.000Z',
            ${historicalAt}, ${acceptedInvitationMemberUserId}
          )
      `);
      await migrationHandle.db.execute(sql`
        insert into league_memberships (
          id, league_id, user_id, role, invited_by_user_id, updated_at
        ) values (
          ${invitationGrantMembershipId}, ${legacyLeagueId}, ${invitationGrantUserId},
          'commissioner', ${ownerUserId}, ${historicalAt}
        )
      `);
      await migrationHandle.db.execute(sql`
        insert into audit_events (
          user_id, action, target_type, target_id, correlation_id, metadata, occurred_at
        ) values
          (
            ${providerOnlyUserId}, 'espn.membership.commissioner_promoted',
            'league_membership', ${providerOnlyMembershipId}, 'legacy-provider-only',
            ${JSON.stringify({
              provider: "espn",
              signal: "league-manager",
              previousRole: "member",
              role: "commissioner",
            })}::jsonb, ${historicalAt}
          ),
          (
            ${touchedAfterPromotionUserId}, 'espn.membership.commissioner_promoted',
            'league_membership', ${touchedMembershipId}, 'legacy-later-grant',
            ${JSON.stringify({
              provider: "espn",
              signal: "league-manager",
              previousRole: "member",
              role: "commissioner",
            })}::jsonb, ${historicalAt}
          ),
          (
            ${invitationGrantUserId}, 'espn.membership.commissioner_promoted',
            'league_membership', ${invitationGrantMembershipId}, 'legacy-invitation-grant',
            ${JSON.stringify({
              provider: "espn",
              signal: "league-manager",
              previousRole: "member",
              role: "commissioner",
            })}::jsonb, ${historicalAt}
          ),
          (
            ${malformedAuditUserId}, 'espn.membership.commissioner_promoted',
            'league_membership', ${malformedMembershipId}, 'legacy-malformed',
            ${JSON.stringify({
              provider: "espn",
              signal: "unrelated-inference",
              previousRole: "member",
              role: "commissioner",
            })}::jsonb, ${historicalAt}
          )
      `);
      await migrate(migrationHandle.db, { migrationsFolder });
      const migratedMemberships = await migrationHandle.db
        .select({
          explicitCommissioner: leagueMemberships.explicitCommissioner,
          role: leagueMemberships.role,
          userId: leagueMemberships.userId,
        })
        .from(leagueMemberships)
        .where(
          inArray(leagueMemberships.userId, [
            acceptedInvitationMemberUserId,
            providerOnlyUserId,
            manualGrantUserId,
            invitationGrantUserId,
            touchedAfterPromotionUserId,
            malformedAuditUserId,
            ownerUserId,
          ]),
        );
      const byUserId = new Map(
        migratedMemberships.map(({ userId, ...state }) => [userId, state] as const),
      );
      const stateFor = (userId: string): LegacyMembershipState => {
        const state = byUserId.get(userId);
        if (!state) throw new Error(`Missing migrated legacy membership ${userId}`);
        return state;
      };
      legacyMigrationState = {
        acceptedInvitationMember: stateFor(acceptedInvitationMemberUserId),
        malformedAudit: stateFor(malformedAuditUserId),
        invitationGrant: stateFor(invitationGrantUserId),
        manualGrant: stateFor(manualGrantUserId),
        ownerInvitationGrant: stateFor(ownerUserId),
        providerOnly: stateFor(providerOnlyUserId),
        touchedAfterPromotion: stateFor(touchedAfterPromotionUserId),
      };
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

  it("migrates exact provider promotions while retaining durable or unclassified grants", () => {
    expect(legacyMigrationState).toEqual({
      acceptedInvitationMember: { role: "commissioner", explicitCommissioner: true },
      malformedAudit: { role: "commissioner", explicitCommissioner: true },
      invitationGrant: { role: "commissioner", explicitCommissioner: true },
      manualGrant: { role: "commissioner", explicitCommissioner: true },
      ownerInvitationGrant: { role: "owner", explicitCommissioner: true },
      providerOnly: { role: "member", explicitCommissioner: false },
      touchedAfterPromotion: { role: "member", explicitCommissioner: false },
    });
  });

  it("enforces commissioner evidence and explicit-role invariants while preserving owner grants", async () => {
    const memberScenario = await createScenario(null, "member");

    await expect(
      db
        .update(providerLeagueLinks)
        .set({ providerCommissioner: true, providerCommissionerObservedAt: FIRST_CAPTURE })
        .where(
          and(
            eq(providerLeagueLinks.connectionId, memberScenario.connectionId),
            eq(providerLeagueLinks.leagueSeasonId, memberScenario.leagueSeasonId),
          ),
        ),
    ).rejects.toThrow();
    await expect(
      db
        .update(leagueMemberships)
        .set({ role: "commissioner" })
        .where(
          and(
            eq(leagueMemberships.leagueId, memberScenario.leagueId),
            eq(leagueMemberships.userId, memberScenario.actorUserId),
          ),
        ),
    ).rejects.toThrow();
    await expect(
      db
        .update(leagueMemberships)
        .set({ explicitCommissioner: true })
        .where(
          and(
            eq(leagueMemberships.leagueId, memberScenario.leagueId),
            eq(leagueMemberships.userId, memberScenario.actorUserId),
          ),
        ),
    ).rejects.toThrow();

    const currentUserTeamExternalKey = `espn:${SEASON}:${memberScenario.providerLeagueId}:team:1`;
    await db
      .update(providerLeagueLinks)
      .set({
        currentUserTeamExternalKey,
        providerCommissioner: false,
        providerCommissionerObservedAt: FIRST_CAPTURE,
      })
      .where(
        and(
          eq(providerLeagueLinks.connectionId, memberScenario.connectionId),
          eq(providerLeagueLinks.leagueSeasonId, memberScenario.leagueSeasonId),
        ),
      );
    await db
      .update(leagueMemberships)
      .set({ role: "commissioner", explicitCommissioner: true })
      .where(
        and(
          eq(leagueMemberships.leagueId, memberScenario.leagueId),
          eq(leagueMemberships.userId, memberScenario.actorUserId),
        ),
      );

    const ownerScenario = await createScenario();
    await db
      .update(leagueMemberships)
      .set({ explicitCommissioner: true })
      .where(
        and(
          eq(leagueMemberships.leagueId, ownerScenario.leagueId),
          eq(leagueMemberships.userId, ownerScenario.actorUserId),
        ),
      );
    expect((await identityState(ownerScenario)).membership).toMatchObject({
      role: "owner",
      explicitCommissioner: true,
    });
  });

  it("stores exact mapping, auto-claim, and provider commissioner evidence without replacing role", async () => {
    const scenario = await createScenario(null, "member");
    const teamOneExternalKey = `espn:${SEASON}:${scenario.providerLeagueId}:team:1`;

    const receipt = await persistence.persist(
      persistenceInput(scenario, bundle(scenario.providerLeagueId, "1", true), FIRST_CAPTURE),
    );

    expect(receipt).toMatchObject({ state: "accepted", identityChanged: true });
    const teamOne = await storedTeam(scenario, "1");
    const state = await identityState(scenario);
    expect(state.link.currentUserTeamExternalKey).toBe(teamOneExternalKey);
    expect(state.link.providerCommissioner).toBe(true);
    expect(state.link.providerCommissionerObservedAt).toEqual(FIRST_CAPTURE);
    expect(state.link.lastSyncedAt).toEqual(FIRST_CAPTURE);
    expect(state.membership.claimedFantasyTeamId).toBe(teamOne.id);
    expect(state.membership.claimedAt).toEqual(new Date(FIRST_CAPTURE.getTime() + 1_000));
    expect(state.membership.role).toBe("member");
    expect(state.membership.explicitCommissioner).toBe(false);

    const unchangedReceipt = await persistence.persist(
      persistenceInput(scenario, bundle(scenario.providerLeagueId, "1", true), SECOND_CAPTURE),
    );
    expect(unchangedReceipt).toMatchObject({ state: "unchanged", identityChanged: false });
    const evidenceEvents = await db
      .select({
        action: auditEvents.action,
        targetId: auditEvents.targetId,
        targetType: auditEvents.targetType,
        metadata: auditEvents.metadata,
      })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.userId, scenario.actorUserId),
          eq(auditEvents.action, "espn.membership.provider_commissioner_evidence_updated"),
        ),
      );
    expect(evidenceEvents).toEqual([
      {
        action: "espn.membership.provider_commissioner_evidence_updated",
        targetId: `${scenario.connectionId}:${scenario.leagueSeasonId}`,
        targetType: "provider_league_link",
        metadata: {
          provider: "espn",
          signal: "league-manager",
          previous: null,
          current: true,
        },
      },
    ]);
  });

  it("clears a stale mapping and backfills identity plus evidence on an unchanged sync", async () => {
    const scenario = await createScenario("espn:2031:stale:team:99", "member");

    const firstReceipt = await persistence.persist(
      persistenceInput(scenario, bundle(scenario.providerLeagueId, null), FIRST_CAPTURE),
    );
    expect(firstReceipt).toMatchObject({ state: "accepted", identityChanged: true });
    expect((await identityState(scenario)).link.currentUserTeamExternalKey).toBeNull();
    expect((await identityState(scenario)).link.providerCommissioner).toBeNull();
    expect((await identityState(scenario)).membership.claimedFantasyTeamId).toBeNull();
    expect((await identityState(scenario)).membership.role).toBe("member");

    const secondReceipt = await persistence.persist(
      persistenceInput(scenario, bundle(scenario.providerLeagueId, "2", true), SECOND_CAPTURE),
    );

    expect(secondReceipt).toMatchObject({ state: "unchanged", identityChanged: true });
    expect(secondReceipt.receiptId).toBe(firstReceipt.receiptId);
    const teamTwo = await storedTeam(scenario, "2");
    const state = await identityState(scenario);
    expect(state.link.currentUserTeamExternalKey).toBe(teamTwo.externalKey);
    expect(state.link.providerCommissioner).toBe(true);
    expect(state.link.providerCommissionerObservedAt).toEqual(SECOND_CAPTURE);
    expect(state.link.lastSyncedAt).toEqual(SECOND_CAPTURE);
    expect(state.membership.claimedFantasyTeamId).toBe(teamTwo.id);
    expect(state.membership.role).toBe("member");
  });

  it("reports a newly won claim without treating later freshness timestamps as identity changes", async () => {
    const scenario = await createScenario(null, "member");
    const currentUserTeamExternalKey = `espn:${SEASON}:${scenario.providerLeagueId}:team:1`;
    await db
      .update(providerLeagueLinks)
      .set({ currentUserTeamExternalKey })
      .where(
        and(
          eq(providerLeagueLinks.connectionId, scenario.connectionId),
          eq(providerLeagueLinks.leagueSeasonId, scenario.leagueSeasonId),
        ),
      );

    const claimedReceipt = await persistence.persist(
      persistenceInput(scenario, bundle(scenario.providerLeagueId, "1"), FIRST_CAPTURE),
    );
    expect(claimedReceipt).toMatchObject({ state: "accepted", identityChanged: true });
    expect((await identityState(scenario)).membership.claimedFantasyTeamId).not.toBeNull();

    const freshnessOnlyReceipt = await persistence.persist(
      persistenceInput(scenario, bundle(scenario.providerLeagueId, "1"), SECOND_CAPTURE),
    );
    expect(freshnessOnlyReceipt).toMatchObject({
      state: "unchanged",
      identityChanged: false,
    });
  });

  it.each([
    ["false", false],
    ["missing", null],
  ] as const)("keeps an ordinary member ordinary when the flag is %s", async (_label, flag) => {
    const scenario = await createScenario(null, "member");

    await persistence.persist(
      persistenceInput(scenario, bundle(scenario.providerLeagueId, "1", flag), FIRST_CAPTURE),
    );

    const state = await identityState(scenario);
    expect(state.membership.role).toBe("member");
    expect(state.link.providerCommissioner).toBe(flag);
    expect(state.link.providerCommissionerObservedAt).toEqual(flag === null ? null : FIRST_CAPTURE);
  });

  it.each([
    ["false", false],
    ["missing", null],
  ] as const)(
    "never demotes an existing commissioner when the flag is %s",
    async (_label, flag) => {
      const scenario = await createScenario(null, "member");
      await db
        .update(leagueMemberships)
        .set({ role: "commissioner", explicitCommissioner: true })
        .where(
          and(
            eq(leagueMemberships.leagueId, scenario.leagueId),
            eq(leagueMemberships.userId, scenario.actorUserId),
          ),
        );

      await persistence.persist(
        persistenceInput(scenario, bundle(scenario.providerLeagueId, "1", flag), FIRST_CAPTURE),
      );

      expect((await identityState(scenario)).membership).toMatchObject({
        role: "commissioner",
        explicitCommissioner: true,
      });
    },
  );

  it("lets a later exact false remove only provider-derived commissioner authority", async () => {
    const scenario = await createScenario(null, "member");

    await persistence.persist(
      persistenceInput(scenario, bundle(scenario.providerLeagueId, "1", true), FIRST_CAPTURE),
    );
    await persistence.persist(
      persistenceInput(scenario, bundle(scenario.providerLeagueId, "1", false), SECOND_CAPTURE),
    );

    const state = await identityState(scenario);
    expect(state.link.providerCommissioner).toBe(false);
    expect(state.link.providerCommissionerObservedAt).toEqual(SECOND_CAPTURE);
    expect(state.membership.role).toBe("member");
    expect(state.membership.explicitCommissioner).toBe(false);
  });

  it("never replaces the canonical owner role", async () => {
    const scenario = await createScenario();

    await persistence.persist(
      persistenceInput(scenario, bundle(scenario.providerLeagueId, "1", true), FIRST_CAPTURE),
    );

    const state = await identityState(scenario);
    expect(state.membership.role).toBe("owner");
    expect(state.membership.explicitCommissioner).toBe(false);
    expect(state.link.providerCommissioner).toBe(true);
  });

  it("rejects a commissioner signal from an actor who does not own the provider link", async () => {
    const scenario = await createScenario(null, "member");
    const unauthorizedUserId = randomUUID();
    await db.insert(users).values({
      id: unauthorizedUserId,
      email: `espn-unauthorized-${scenario.providerLeagueId}@example.test`,
      displayName: "Unauthorized ESPN User",
    });
    await db.insert(leagueMemberships).values({
      leagueId: scenario.leagueId,
      userId: unauthorizedUserId,
      role: "member",
    });
    const input = persistenceInput(
      scenario,
      bundle(scenario.providerLeagueId, "1", true),
      FIRST_CAPTURE,
    );

    await expect(
      persistence.persist({
        ...input,
        authority: {
          mode: "server-session",
          actorUserId: unauthorizedUserId,
          connectionId: scenario.connectionId,
          leagueSeasonId: scenario.leagueSeasonId,
        },
      }),
    ).rejects.toThrow("authorized provider link");

    const [membership] = await db
      .select({ role: leagueMemberships.role })
      .from(leagueMemberships)
      .where(
        and(
          eq(leagueMemberships.leagueId, scenario.leagueId),
          eq(leagueMemberships.userId, unauthorizedUserId),
        ),
      )
      .limit(1);
    expect(membership?.role).toBe("member");
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
      role: "member",
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
