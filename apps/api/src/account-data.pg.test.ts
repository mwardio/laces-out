/**
 * Real PostgreSQL proof for account portability and erasure.
 *
 * Foreign-key actions and the league-owner triggers are the implementation, so an in-memory fake
 * cannot verify this behavior. The suite uses a disposable Docker database or local PostgreSQL
 * cluster, never DATABASE_URL, and skips cleanly where neither option is available.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  aiProviderCredentials,
  aiUsageLedger,
  auditEvents,
  bridgeDeviceLeagues,
  bridgeDevices,
  bridgePairingSessions,
  browserHandoffTokens,
  changeEventReceipts,
  changeEvents,
  createDatabase,
  fantasyTeams,
  invitations,
  leagueMemberships,
  leagues,
  leagueSeasons,
  leagueSyncExclusions,
  notificationDeliveries,
  oauthStates,
  playerProjections,
  players,
  projectionSets,
  providerConnections,
  providerLeagueLinks,
  pushSubscriptions,
  rankingEntries,
  rankingLists,
  rankingListVersions,
  recapPersonaCards,
  sessions,
  shareLinks,
  userPreferences,
  users,
  weeklyRecaps,
  type Database,
} from "@fantasy/db";
import { hashOAuthState } from "@fantasy/connector-yahoo";
import { parseCredentialKey } from "@fantasy/security";
import { and, eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { DrizzleAccountDataRepository } from "./account-data.js";
import { DrizzleAuthRepository } from "./auth-repository.js";
import { AuthService, hashOwnerPassword, hashSessionToken, verifyOwnerPassword } from "./auth.js";
import { BrowserHandoffService, DrizzleBrowserHandoffStore } from "./browser-handoff.js";
import { DrizzleInvitationRepository } from "./invitation-repository.js";
import { LeagueMembershipService } from "./league-membership.js";
import {
  YahooConnectionService,
  type YahooConnectionCallbackError,
  type YahooConnectionError,
} from "./yahoo-connection.js";

function dockerIsAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const dockerAvailable = dockerIsAvailable();

function executable(name: string): string | undefined {
  const searchDirectories = [
    ...(process.env.PATH?.split(path.delimiter) ?? []),
    "/opt/homebrew/opt/postgresql@16/bin",
    "/usr/local/opt/postgresql@16/bin",
  ];
  return searchDirectories.map((directory) => path.join(directory, name)).find(existsSync);
}

const localPostgresTools = (() => {
  const initdb = executable("initdb");
  const pgCtl = executable("pg_ctl");
  return initdb && pgCtl ? { initdb, pgCtl } : undefined;
})();
const postgresAvailable = dockerAvailable || localPostgresTools !== undefined;
if (!postgresAvailable) {
  console.warn(
    "[account-data.pg.test] Skipping disposable-PostgreSQL account tests: Docker and local PostgreSQL are unavailable.",
  );
}

async function rejectionText(operation: Promise<unknown>): Promise<string> {
  try {
    await operation;
  } catch (error) {
    const causeMessage =
      error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
    return `${error instanceof Error ? error.message : String(error)} ${causeMessage}`;
  }
  throw new Error("Expected the statement to be rejected");
}

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

interface DisposablePostgres {
  readonly cleanup: () => void;
  readonly url: string;
}

async function unusedLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => {
        if (error) reject(error);
        else if (port <= 0) reject(new Error("Could not allocate a PostgreSQL test port"));
        else resolve(port);
      });
    });
  });
}

async function startLocalPostgres(): Promise<DisposablePostgres> {
  if (!localPostgresTools) throw new Error("Local PostgreSQL tools are unavailable");
  const dataDirectory = mkdtempSync(path.join(tmpdir(), "laces-out-account-pg-"));
  const logPath = path.join(dataDirectory, "postgres.log");
  const port = await unusedLocalPort();
  try {
    execFileSync(
      localPostgresTools.initdb,
      ["-D", dataDirectory, "--no-locale", "-E", "UTF8", "-A", "trust"],
      { stdio: "ignore", env: { ...process.env, LC_ALL: "C" } },
    );
    execFileSync(
      localPostgresTools.pgCtl,
      ["-D", dataDirectory, "-l", logPath, "-o", `-p ${port} -h 127.0.0.1`, "-w", "start"],
      { stdio: "ignore" },
    );
  } catch (error) {
    rmSync(dataDirectory, { force: true, recursive: true });
    throw error;
  }
  return {
    url: `postgres://127.0.0.1:${port}/postgres`,
    cleanup: () => {
      try {
        execFileSync(
          localPostgresTools.pgCtl,
          ["-D", dataDirectory, "-m", "immediate", "-w", "stop"],
          { stdio: "ignore" },
        );
      } finally {
        rmSync(dataDirectory, { force: true, recursive: true });
      }
    },
  };
}

async function startDisposablePostgres(): Promise<DisposablePostgres> {
  if (!dockerAvailable) return startLocalPostgres();
  const containerName = `laces-out-account-pg-${randomUUID().slice(0, 8)}`;
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
      if (Date.now() > readyDeadline) throw new Error("Disposable PostgreSQL did not become ready");
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
  const portMapping = execFileSync("docker", ["port", containerName, "5432/tcp"], {
    encoding: "utf8",
  }).trim();
  const port = Number(portMapping.split(":").pop());
  if (!Number.isInteger(port) || port <= 0) throw new Error("Could not read PostgreSQL host port");
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
      if (Date.now() > connectDeadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
  return {
    url,
    cleanup: () => {
      execFileSync("docker", ["rm", "-f", containerName], { stdio: "ignore" });
    },
  };
}

const NOW = new Date("2031-11-08T14:30:00.000Z");
const deletingUserId = "10000000-0000-4000-8000-0000000000d1";
const successorUserId = "10000000-0000-4000-8000-0000000000d2";
const sharedLeagueId = "20000000-0000-4000-8000-0000000000d1";
const soloLeagueId = "20000000-0000-4000-8000-0000000000d2";
const sharedSeasonId = "30000000-0000-4000-8000-0000000000d1";
const sharedTeamId = "40000000-0000-4000-8000-0000000000d1";
const playerId = "50000000-0000-4000-8000-0000000000d1";
const connectionId = "60000000-0000-4000-8000-0000000000d1";
const leagueProjectionId = "70000000-0000-4000-8000-0000000000d1";
const privateProjectionId = "70000000-0000-4000-8000-0000000000d2";
const aiCredentialId = "80000000-0000-4000-8000-0000000000d1";
const changeEventId = "90000000-0000-4000-8000-0000000000d1";
const clonedRankingListId = "a0000000-0000-4000-8000-0000000000d2";
const clonedRankingVersionId = "b0000000-0000-4000-8000-0000000000d2";
const anonymizedProvenanceUserId = "00000000-0000-4000-8000-000000000000";
const deletingPassword = "the departing account password";
const concurrentPasswordUserId = "10000000-0000-4000-8000-0000000000e1";
const staleLoginUserId = "10000000-0000-4000-8000-0000000000e2";
const deletionRaceUserId = "10000000-0000-4000-8000-0000000000e3";
const invitationRaceOwnerId = "10000000-0000-4000-8000-0000000000f1";
const invitationRaceInviteeId = "10000000-0000-4000-8000-0000000000f2";
const invitationRaceLeagueId = "20000000-0000-4000-8000-0000000000f1";
const invitationRaceInvitationId = "30000000-0000-4000-8000-0000000000f1";
const crossOwnerAId = "11000000-0000-4000-8000-0000000000f1";
const crossOwnerBId = "11000000-0000-4000-8000-0000000000f2";
const crossLeagueAId = "21000000-0000-4000-8000-0000000000f1";
const crossLeagueBId = "21000000-0000-4000-8000-0000000000f2";
const handoffPasswordUserId = "12000000-0000-4000-8000-0000000000f1";
const nativeYahooUserId = "12000000-0000-4000-8000-0000000000f2";
const nativeYahooOtherUserId = "12000000-0000-4000-8000-0000000000f3";

describe.skipIf(!postgresAvailable)("account data repository against real PostgreSQL", () => {
  let container: DisposablePostgres;
  let handle: ReturnType<typeof createDatabase>;
  let db: Database;
  let repository: DrizzleAccountDataRepository;
  let deletingPasswordHash: string;

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
    repository = new DrizzleAccountDataRepository(db, () => NOW);
    deletingPasswordHash = await hashOwnerPassword(deletingPassword);

    await db.insert(users).values([
      {
        id: deletingUserId,
        email: "departing@example.test",
        displayName: "Departing Manager",
        passwordHash: deletingPasswordHash,
        role: "admin",
      },
      {
        id: successorUserId,
        email: "successor@example.test",
        displayName: "Successor",
      },
      {
        id: nativeYahooUserId,
        email: "native-yahoo@example.test",
        displayName: "Native Yahoo",
      },
      {
        id: nativeYahooOtherUserId,
        email: "native-yahoo-other@example.test",
        displayName: "Other Native Yahoo",
      },
    ]);
    await db.insert(providerConnections).values({
      id: connectionId,
      userId: deletingUserId,
      provider: "yahoo",
      externalAccountId: "portable-yahoo-account",
      displayName: "Yahoo account",
      encryptedCredential: { ciphertext: "SECRET_PROVIDER_CIPHERTEXT" },
      health: "healthy",
    });
    await db.insert(leagues).values([
      { id: sharedLeagueId, ownerUserId: deletingUserId, name: "Shared League" },
      { id: soloLeagueId, ownerUserId: deletingUserId, name: "Private League" },
    ]);
    await db.insert(leagueMemberships).values({
      leagueId: sharedLeagueId,
      userId: successorUserId,
      role: "commissioner",
    });
    await db.insert(leagueSeasons).values({
      id: sharedSeasonId,
      leagueId: sharedLeagueId,
      connectionId,
      provider: "yahoo",
      externalKey: "shared-2031",
      season: 2031,
      teamCount: 2,
      draftType: "snake",
    });
    await db.insert(fantasyTeams).values({
      id: sharedTeamId,
      leagueSeasonId: sharedSeasonId,
      externalKey: "team-1",
      name: "Portable Team",
    });
    await db
      .update(leagueMemberships)
      .set({ claimedFantasyTeamId: sharedTeamId, claimedAt: NOW })
      .where(
        and(
          eq(leagueMemberships.leagueId, sharedLeagueId),
          eq(leagueMemberships.userId, deletingUserId),
        ),
      );
    await db.insert(userPreferences).values({
      userId: deletingUserId,
      defaultLeagueId: sharedLeagueId,
      timezone: "America/Chicago",
      dashboardSettings: { density: "compact" },
    });
    const [deletingSession] = await db
      .insert(sessions)
      .values({
        userId: deletingUserId,
        tokenHash: "SECRET_SESSION_TOKEN_HASH",
        expiresAt: new Date("2032-01-01T00:00:00.000Z"),
      })
      .returning({ id: sessions.id });
    if (!deletingSession) throw new Error("Expected deleting account session");
    await db.insert(browserHandoffTokens).values({
      userId: deletingUserId,
      sourceSessionId: deletingSession.id,
      tokenHash: "H".repeat(43),
      destination: "/connections/yahoo/connect",
      expiresAt: new Date("2031-11-08T14:32:00.000Z"),
      createdAt: NOW,
    });
    await db.insert(oauthStates).values({
      stateHash: "SECRET_OAUTH_STATE_HASH",
      userId: deletingUserId,
      provider: "yahoo",
      encryptedPkceVerifier: { ciphertext: "SECRET_PKCE_CIPHERTEXT" },
      returnTo: "/connections",
      returnMode: "ios-app",
      expiresAt: new Date("2031-11-08T14:40:00.000Z"),
    });
    await db.insert(pushSubscriptions).values({
      userId: deletingUserId,
      endpoint: "https://updates.push.services.mozilla.com/SECRET_PUSH_ENDPOINT",
      p256dh: "SECRET_PUSH_P256DH",
      auth: "SECRET_PUSH_AUTH",
      userAgentLabel: "Safari on iPhone",
    });
    await db.insert(notificationDeliveries).values({
      userId: deletingUserId,
      kind: "lineup-lock",
      idempotencyKey: "account-delete-pg:lineup-lock",
      deliveredDeviceCount: 1,
    });
    const [bridge] = await db
      .insert(bridgeDevices)
      .values({
        userId: deletingUserId,
        name: "Chrome companion",
        tokenHash: "SECRET_BRIDGE_TOKEN_HASH_1234567890",
      })
      .returning({ id: bridgeDevices.id });
    if (!bridge) throw new Error("Expected bridge device");
    await db.insert(bridgeDeviceLeagues).values({
      bridgeDeviceId: bridge.id,
      externalLeagueId: "12345678",
      season: 2031,
    });
    await db.insert(bridgePairingSessions).values({
      userId: deletingUserId,
      codeHash: "SECRET_PAIRING_CODE_HASH_1234567890",
      deviceName: "Pending companion",
      allowedLeagueIds: ["12345678"],
      season: 2031,
      expiresAt: new Date("2031-11-08T15:00:00.000Z"),
    });
    await db.insert(players).values({
      id: playerId,
      fullName: "Portable Player",
      primaryPosition: "WR",
      eligiblePositions: ["WR", "FLEX"],
      nflTeam: "CHI",
    });
    await db.insert(rankingLists).values([
      {
        id: "a0000000-0000-4000-8000-0000000000d1",
        ownerUserId: deletingUserId,
        name: "My portable rankings",
        kind: "rankings",
        visibility: "private",
        visibilityConfig: { scope: "private" },
        season: 2031,
      },
      {
        id: clonedRankingListId,
        ownerUserId: successorUserId,
        name: "Surviving cloned rankings",
        kind: "rankings",
        visibility: "private",
        visibilityConfig: { scope: "private" },
        season: 2031,
      },
    ]);
    await db.insert(rankingListVersions).values({
      id: clonedRankingVersionId,
      listId: clonedRankingListId,
      versionNumber: 1,
      authorUserId: successorUserId,
      provenance: { clonedFromUserId: deletingUserId },
    });
    await db.insert(rankingEntries).values({
      versionId: clonedRankingVersionId,
      playerId,
      overallRank: 1,
      fieldProvenance: {
        overallRank: {
          kind: "user",
          authorUserId: deletingUserId,
          authoredAt: NOW.toISOString(),
        },
      },
    });
    expect(
      await rejectionText(
        db
          .update(rankingListVersions)
          .set({ provenance: { clonedFromUserId: successorUserId } })
          .where(eq(rankingListVersions.id, clonedRankingVersionId)),
      ),
    ).toMatch(/ranking version snapshots are immutable/);
    expect(
      await rejectionText(
        db
          .update(rankingEntries)
          .set({
            fieldProvenance: {
              overallRank: {
                kind: "user",
                authorUserId: successorUserId,
                authoredAt: NOW.toISOString(),
              },
            },
          })
          .where(eq(rankingEntries.versionId, clonedRankingVersionId)),
      ),
    ).toMatch(/ranking entries are immutable/);
    await db.insert(shareLinks).values({
      createdByUserId: deletingUserId,
      rankingListId: "a0000000-0000-4000-8000-0000000000d1",
      tokenHash: "SECRET_SHARE_TOKEN_HASH_123456789012",
    });
    await db.insert(projectionSets).values([
      {
        id: leagueProjectionId,
        leagueSeasonId: sharedSeasonId,
        createdByUserId: deletingUserId,
        visibility: "league",
        source: "member-csv",
        version: "portable-league-v1",
        season: 2031,
        week: 10,
        horizon: "week",
        windowStartWeek: 10,
        windowEndWeek: 10,
        asOfWeek: 9,
        asOfAt: NOW,
        fetchedAt: NOW,
        inputChecksum: "a".repeat(64),
        metadata: { importedByUserId: deletingUserId },
      },
      {
        id: privateProjectionId,
        leagueSeasonId: sharedSeasonId,
        createdByUserId: deletingUserId,
        visibility: "private",
        source: "member-csv",
        version: "portable-private-v1",
        season: 2031,
        week: 10,
        horizon: "week",
        windowStartWeek: 10,
        windowEndWeek: 10,
        asOfWeek: 9,
        asOfAt: NOW,
        fetchedAt: NOW,
        inputChecksum: "b".repeat(64),
      },
    ]);
    await db.insert(playerProjections).values([
      { projectionSetId: leagueProjectionId, playerId, meanPoints: "12.500" },
      { projectionSetId: privateProjectionId, playerId, meanPoints: "11.250" },
    ]);
    await db.insert(aiProviderCredentials).values({
      id: aiCredentialId,
      userId: deletingUserId,
      provider: "openai",
      label: "Personal OpenAI",
      model: "gpt-test",
      credentialFingerprintHash: "SECRET_AI_FINGERPRINT_HASH_1234567890",
      credentialEnvelope: {
        version: 1,
        algorithm: "aes-256-gcm",
        keyId: "test-key",
        purpose: "ai-provider-api-key",
        createdAt: NOW.toISOString(),
        iv: "SECRET_AI_IV",
        ciphertext: "SECRET_AI_CIPHERTEXT",
        authTag: "SECRET_AI_AUTH_TAG",
      },
      envelopeVersion: 1,
      encryptionKeyId: "test-key",
      credentialPurpose: "ai-provider-api-key",
    });
    await db.insert(aiUsageLedger).values({
      userId: deletingUserId,
      credentialId: aiCredentialId,
      provider: "openai",
      model: "gpt-test",
      operation: "film-room",
      requestIdHash: "SECRET_PROVIDER_REQUEST_HASH_1234567890",
      inputTokens: 100,
      outputTokens: 50,
      occurredAt: NOW,
    });
    await db.insert(recapPersonaCards).values({
      leagueSeasonId: sharedSeasonId,
      fantasyTeamId: sharedTeamId,
      body: "Portable league lore",
      updatedByUserId: deletingUserId,
    });
    await db.insert(weeklyRecaps).values({
      leagueSeasonId: sharedSeasonId,
      week: 10,
      body: "Shared weekly recap",
      provider: "openai",
      model: "gpt-test",
      spiceLevel: "mild",
      generatedByUserId: deletingUserId,
    });
    await db.insert(changeEvents).values({
      id: changeEventId,
      source: "account-test",
      deduplicationKey: "account-test:shared-event",
      eventType: "roster.changed",
      aggregateType: "fantasy-team",
      aggregateId: sharedTeamId,
      leagueId: sharedLeagueId,
      actorUserId: deletingUserId,
      visibility: "league",
      payload: { v: 1, teamId: sharedTeamId },
      occurredAt: NOW,
    });
    await db.insert(changeEventReceipts).values({
      eventId: changeEventId,
      userId: deletingUserId,
      firstSeenAt: NOW,
      readAt: NOW,
    });
    await db.insert(auditEvents).values({
      userId: deletingUserId,
      action: "account.test",
      correlationId: "account-test-before-delete",
      metadata: { portable: true },
    });
    await db.insert(invitations).values([
      {
        tokenHash: "SECRET_OUTGOING_INVITATION_HASH_123456",
        email: "successor@example.test",
        emailHash: "outgoing-email-hash-12345678901234567890",
        invitedByUserId: deletingUserId,
        expiresAt: new Date("2032-01-01T00:00:00.000Z"),
      },
      {
        tokenHash: "SECRET_INCOMING_INVITATION_HASH_123456",
        email: "DEPARTING@example.test",
        emailHash: "incoming-email-hash-12345678901234567890",
        invitedByUserId: successorUserId,
        expiresAt: new Date("2032-01-01T00:00:00.000Z"),
      },
    ]);
  }, 90_000);

  afterAll(async () => {
    await handle?.close();
    if (container) {
      try {
        container.cleanup();
      } catch {
        // Best effort; the disposable database contains invented test data only.
      }
    }
  }, 30_000);

  it("exports portable member data through explicit secret-free allowlists", async () => {
    const exported = await repository.exportData(deletingUserId);
    expect(exported).toMatchObject({
      schemaVersion: 1,
      exportedAt: NOW.toISOString(),
      account: { email: "departing@example.test", displayName: "Departing Manager" },
      data: {
        preferences: { timezone: "America/Chicago" },
        leagueMemberships: [
          expect.objectContaining({ leagueName: "Private League" }),
          expect.anything(),
        ],
        providerConnections: [
          expect.objectContaining({
            provider: "yahoo",
            externalAccountId: "portable-yahoo-account",
          }),
        ],
        rankingLists: [expect.objectContaining({ name: "My portable rankings" })],
        leagueIntelContributions: [expect.objectContaining({ body: "Portable league lore" })],
      },
    });
    const exportedData = exported?.data as { readonly playerProjections?: readonly unknown[] };
    expect(exportedData.playerProjections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ playerName: "Portable Player", meanPoints: "12.500" }),
      ]),
    );
    const serialized = JSON.stringify(exported);
    for (const secret of [
      deletingPasswordHash,
      "SECRET_SESSION_TOKEN_HASH",
      "SECRET_PROVIDER_CIPHERTEXT",
      "SECRET_PUSH_ENDPOINT",
      "SECRET_PUSH_P256DH",
      "SECRET_PUSH_AUTH",
      "SECRET_BRIDGE_TOKEN_HASH",
      "SECRET_PAIRING_CODE_HASH",
      "SECRET_SHARE_TOKEN_HASH",
      "SECRET_AI_FINGERPRINT_HASH",
      "SECRET_AI_CIPHERTEXT",
      "SECRET_AI_IV",
      "SECRET_AI_AUTH_TAG",
      "SECRET_PROVIDER_REQUEST_HASH",
      "SECRET_OUTGOING_INVITATION_HASH",
      "SECRET_INCOMING_INVITATION_HASH",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("rejects a wrong deletion password while the locked account remains intact", async () => {
    await expect(
      repository.deleteAccount({
        userId: deletingUserId,
        currentPassword: "not the departing password",
        correlationId: "account-delete-wrong-password",
        deletedAt: NOW,
      }),
    ).resolves.toEqual({ deleted: false, reason: "invalid-current-password" });
    expect(await db.select().from(users).where(eq(users.id, deletingUserId))).toHaveLength(1);
    expect(
      await db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.correlationId, "account-delete-wrong-password")),
    ).toHaveLength(0);
  });

  it("allows exactly one of two concurrent changes from the same current password", async () => {
    const originalPassword = "concurrent original password";
    const firstNewPassword = "concurrent winner password one";
    const secondNewPassword = "concurrent winner password two";
    const currentToken = "c".repeat(32);
    const otherToken = "o".repeat(32);
    await db.insert(users).values({
      id: concurrentPasswordUserId,
      email: "concurrent-password@example.test",
      displayName: "Concurrent Password",
      passwordHash: await hashOwnerPassword(originalPassword),
    });
    await db.insert(sessions).values([
      {
        userId: concurrentPasswordUserId,
        tokenHash: hashSessionToken(currentToken),
        expiresAt: new Date("2032-01-01T00:00:00.000Z"),
      },
      {
        userId: concurrentPasswordUserId,
        tokenHash: hashSessionToken(otherToken),
        expiresAt: new Date("2032-01-01T00:00:00.000Z"),
      },
    ]);
    const auth = new AuthService(new DrizzleAuthRepository(db), () => NOW);

    const results = await Promise.all([
      auth.changePassword(
        concurrentPasswordUserId,
        originalPassword,
        firstNewPassword,
        currentToken,
      ),
      auth.changePassword(
        concurrentPasswordUserId,
        originalPassword,
        secondNewPassword,
        currentToken,
      ),
    ]);

    expect(results.filter((result) => result.outcome === "changed")).toHaveLength(1);
    expect(results.filter((result) => result.outcome === "invalid-current-password")).toHaveLength(
      1,
    );
    const winningPassword =
      results[0]?.outcome === "changed" ? firstNewPassword : secondNewPassword;
    const [account] = await db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, concurrentPasswordUserId));
    expect(await verifyOwnerPassword(account?.passwordHash, winningPassword)).toBe(true);
    expect(
      await db
        .select({ tokenHash: sessions.tokenHash })
        .from(sessions)
        .where(eq(sessions.userId, concurrentPasswordUserId)),
    ).toEqual([{ tokenHash: hashSessionToken(currentToken) }]);
  }, 15_000);

  it("does not let a stale password login escape concurrent session revocation", async () => {
    const originalPassword = "stale login original password";
    const replacementPassword = "stale login replacement password";
    const originalHash = await hashOwnerPassword(originalPassword);
    const replacementHash = await hashOwnerPassword(replacementPassword);
    await db.insert(users).values({
      id: staleLoginUserId,
      email: "stale-login@example.test",
      displayName: "Stale Login",
      passwordHash: originalHash,
    });

    const authRepository = new DrizzleAuthRepository(db);
    let reachedPasswordBoundInsert = () => {};
    const passwordBoundInsertReached = new Promise<void>((resolve) => {
      reachedPasswordBoundInsert = resolve;
    });
    const createSessionForPassword = authRepository.createSessionForPassword.bind(authRepository);
    vi.spyOn(authRepository, "createSessionForPassword").mockImplementation(async (input) => {
      reachedPasswordBoundInsert();
      return createSessionForPassword(input);
    });
    const auth = new AuthService(authRepository, () => NOW);
    const locker = postgres(container.url, { max: 1, prepare: false });
    let staleLogin: ReturnType<AuthService["login"]> = Promise.resolve(undefined);
    try {
      await locker.begin(async (transaction) => {
        await transaction`select id from users where id = ${staleLoginUserId} for update`;
        await transaction`
          update users
          set password_hash = ${replacementHash}, updated_at = ${NOW}
          where id = ${staleLoginUserId}
        `;
        staleLogin = auth.login("stale-login@example.test", originalPassword);
        await passwordBoundInsertReached;
      });
      await expect(staleLogin).resolves.toBeUndefined();
      expect(
        await db.select().from(sessions).where(eq(sessions.userId, staleLoginUserId)),
      ).toHaveLength(0);
    } finally {
      await locker.end({ timeout: 1 });
    }
  }, 15_000);

  it("serializes account deletion against a concurrent password replacement", async () => {
    const originalPassword = "deletion race original password";
    const replacementPassword = "deletion race replacement password";
    await db.insert(users).values({
      id: deletionRaceUserId,
      email: "deletion-race@example.test",
      displayName: "Deletion Race",
      passwordHash: await hashOwnerPassword(originalPassword),
    });
    const auth = new AuthService(new DrizzleAuthRepository(db), () => NOW);

    const [passwordResult, deletionResult] = await Promise.all([
      auth.changePassword(deletionRaceUserId, originalPassword, replacementPassword, undefined),
      repository.deleteAccount({
        userId: deletionRaceUserId,
        currentPassword: originalPassword,
        correlationId: "account-delete-password-race",
        deletedAt: NOW,
      }),
    ]);

    const successfulMutations =
      Number(passwordResult.outcome === "changed") + Number(deletionResult?.deleted === true);
    expect(successfulMutations).toBe(1);
    if (passwordResult.outcome === "changed") {
      expect(deletionResult).toEqual({ deleted: false, reason: "invalid-current-password" });
      const [account] = await db
        .select({ passwordHash: users.passwordHash })
        .from(users)
        .where(eq(users.id, deletionRaceUserId));
      expect(await verifyOwnerPassword(account?.passwordHash, replacementPassword)).toBe(true);
    } else {
      expect(passwordResult).toEqual({ outcome: "invalid-current-password" });
      expect(deletionResult).toMatchObject({ deleted: true });
      expect(await db.select().from(users).where(eq(users.id, deletionRaceUserId))).toHaveLength(0);
    }
  }, 15_000);

  it("completes invitation acceptance and account deletion without a lock-order deadlock", async () => {
    const ownerPassword = "invitation race owner password";
    const invitationTokenHash = "INVITATION_LOCK_ORDER_TOKEN_HASH_1234567890";
    const advisoryKey = 7_310_731;
    await db.insert(users).values([
      {
        id: invitationRaceOwnerId,
        email: "invitation-race-owner@example.test",
        displayName: "Invitation Race Owner",
        passwordHash: await hashOwnerPassword(ownerPassword),
      },
      {
        id: invitationRaceInviteeId,
        email: "invitation-race-invitee@example.test",
        displayName: "Invitation Race Invitee",
        passwordHash: await hashOwnerPassword("invitation race invitee password"),
      },
    ]);
    await db.insert(leagues).values({
      id: invitationRaceLeagueId,
      ownerUserId: invitationRaceOwnerId,
      name: "Invitation Lock Order League",
    });
    await db.insert(invitations).values({
      id: invitationRaceInvitationId,
      tokenHash: invitationTokenHash,
      email: "invitation-race-invitee@example.test",
      emailHash: "INVITATION_LOCK_ORDER_EMAIL_HASH_1234567890",
      invitedByUserId: invitationRaceOwnerId,
      leagueId: invitationRaceLeagueId,
      leagueRole: "manager",
      expiresAt: new Date("2032-01-01T00:00:00.000Z"),
    });

    const control = postgres(container.url, { max: 1, prepare: false });
    const observer = postgres(container.url, { max: 1, prepare: false });
    const invitationRepository = new DrizzleInvitationRepository(db);
    let acceptance: ReturnType<DrizzleInvitationRepository["accept"]> = Promise.resolve({
      status: "unavailable",
    });
    let deletion: ReturnType<DrizzleAccountDataRepository["deleteAccount"]> =
      Promise.resolve(undefined);
    const waitForWaitingLock = async (lockType: "advisory" | "transactionid") => {
      const deadline = Date.now() + 5_000;
      for (;;) {
        const [row] = await observer`
          select count(*)::integer as count
          from pg_locks
          where locktype = ${lockType} and not granted
        `;
        if (Number(row?.count ?? 0) > 0) return;
        if (Date.now() >= deadline) {
          throw new Error(`Timed out waiting for PostgreSQL ${lockType} contention`);
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };

    await control.unsafe(`
      create function account_test_pause_invitation_acceptance() returns trigger
      language plpgsql as $$
      begin
        if new.id = '${invitationRaceInvitationId}'::uuid then
          perform pg_advisory_xact_lock(${advisoryKey});
        end if;
        return new;
      end
      $$;
      create trigger account_test_pause_invitation_acceptance_trigger
      before update of accepted_at on invitations
      for each row execute function account_test_pause_invitation_acceptance();
    `);

    try {
      await control.begin(async (transaction) => {
        await transaction`select pg_advisory_xact_lock(${advisoryKey})`;
        acceptance = invitationRepository.accept({
          tokenHash: invitationTokenHash,
          identity: { kind: "existing_user", userId: invitationRaceInviteeId },
          now: NOW,
        });
        // The trigger runs only after acceptance has acquired its user, league, and invitation
        // locks. Holding it here makes the competing deletion interleaving deterministic.
        await waitForWaitingLock("advisory");
        deletion = repository.deleteAccount({
          userId: invitationRaceOwnerId,
          currentPassword: ownerPassword,
          correlationId: "account-delete-invitation-race",
          deletedAt: NOW,
        });
        // Deletion must wait at the already-held user parent, before it can invert on the child.
        await waitForWaitingLock("transactionid");
      });

      let timeout: ReturnType<typeof setTimeout> | undefined;
      const results = await Promise.race([
        Promise.all([acceptance, deletion]),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Invitation/deletion concurrency did not complete")),
            10_000,
          );
        }),
      ]).finally(() => {
        if (timeout) clearTimeout(timeout);
      });
      expect(results[0]).toMatchObject({ status: "accepted" });
      expect(results[1]).toMatchObject({ deleted: true, transferredLeagueCount: 1 });
      expect(await db.select().from(users).where(eq(users.id, invitationRaceOwnerId))).toHaveLength(
        0,
      );
      expect(
        await db.select().from(invitations).where(eq(invitations.id, invitationRaceInvitationId)),
      ).toHaveLength(0);
      expect(await db.select().from(leagues).where(eq(leagues.id, invitationRaceLeagueId))).toEqual(
        [expect.objectContaining({ ownerUserId: invitationRaceInviteeId })],
      );
    } finally {
      await Promise.allSettled([acceptance, deletion]);
      await control.unsafe(
        "drop trigger if exists account_test_pause_invitation_acceptance_trigger on invitations; drop function if exists account_test_pause_invitation_acceptance();",
      );
      await Promise.all([control.end({ timeout: 1 }), observer.end({ timeout: 1 })]);
    }
  }, 30_000);

  it("retries the hidden successor-user FK deadlock between two owner deletions", async () => {
    const passwordA = "cross owner deletion password a";
    const passwordB = "cross owner deletion password b";
    const advisoryKey = 7_310_732;
    await db.insert(users).values([
      {
        id: crossOwnerAId,
        email: "cross-owner-a@example.test",
        displayName: "Cross Owner A",
        passwordHash: await hashOwnerPassword(passwordA),
      },
      {
        id: crossOwnerBId,
        email: "cross-owner-b@example.test",
        displayName: "Cross Owner B",
        passwordHash: await hashOwnerPassword(passwordB),
      },
    ]);
    await db.insert(leagues).values([
      { id: crossLeagueAId, ownerUserId: crossOwnerAId, name: "Cross League A" },
      { id: crossLeagueBId, ownerUserId: crossOwnerBId, name: "Cross League B" },
    ]);
    await db.insert(leagueMemberships).values([
      { leagueId: crossLeagueAId, userId: crossOwnerBId, role: "commissioner" },
      { leagueId: crossLeagueBId, userId: crossOwnerAId, role: "commissioner" },
    ]);

    const control = postgres(container.url, { max: 1, prepare: false });
    const observer = postgres(container.url, { max: 1, prepare: false });
    let deletionA: ReturnType<DrizzleAccountDataRepository["deleteAccount"]> =
      Promise.resolve(undefined);
    let deletionB: ReturnType<DrizzleAccountDataRepository["deleteAccount"]> =
      Promise.resolve(undefined);
    await control.unsafe(`
      create function account_test_pause_owner_transfer() returns trigger
      language plpgsql as $$
      begin
        if new.id in ('${crossLeagueAId}'::uuid, '${crossLeagueBId}'::uuid) then
          perform pg_advisory_xact_lock_shared(${advisoryKey});
        end if;
        return new;
      end
      $$;
      create trigger account_test_pause_owner_transfer_trigger
      before update of user_id on leagues
      for each row execute function account_test_pause_owner_transfer();
    `);

    try {
      await control.begin(async (transaction) => {
        await transaction`select pg_advisory_xact_lock(${advisoryKey})`;
        deletionA = repository.deleteAccount({
          userId: crossOwnerAId,
          currentPassword: passwordA,
          correlationId: "account-delete-cross-owner-a",
          deletedAt: NOW,
        });
        deletionB = repository.deleteAccount({
          userId: crossOwnerBId,
          currentPassword: passwordB,
          correlationId: "account-delete-cross-owner-b",
          deletedAt: NOW,
        });
        const deadline = Date.now() + 5_000;
        for (;;) {
          const [row] = await observer`
            select count(*)::integer as count
            from pg_locks
            where locktype = 'advisory' and not granted
          `;
          if (Number(row?.count ?? 0) >= 2) break;
          if (Date.now() >= deadline) {
            throw new Error("Timed out arranging the cross-owner transfer deadlock");
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      });

      let timeout: ReturnType<typeof setTimeout> | undefined;
      const results = await Promise.race([
        Promise.all([deletionA, deletionB]),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Cross-owner deletion retries did not complete")),
            15_000,
          );
        }),
      ]).finally(() => {
        if (timeout) clearTimeout(timeout);
      });
      expect(results).toEqual([
        expect.objectContaining({ deleted: true }),
        expect.objectContaining({ deleted: true }),
      ]);
      expect(
        await db
          .select()
          .from(users)
          .where(inArray(users.id, [crossOwnerAId, crossOwnerBId])),
      ).toHaveLength(0);
      expect(
        await db
          .select()
          .from(leagues)
          .where(inArray(leagues.id, [crossLeagueAId, crossLeagueBId])),
      ).toHaveLength(0);
    } finally {
      await Promise.allSettled([deletionA, deletionB]);
      await control.unsafe(
        "drop trigger if exists account_test_pause_owner_transfer_trigger on leagues; drop function if exists account_test_pause_owner_transfer();",
      );
      await Promise.all([control.end({ timeout: 1 }), observer.end({ timeout: 1 })]);
    }
  }, 30_000);

  it("transfers shared ownership, removes UGC/private data, and anonymizes retained facts", async () => {
    const result = await repository.deleteAccount({
      userId: deletingUserId,
      currentPassword: deletingPassword,
      correlationId: "account-delete-correlation",
      deletedAt: NOW,
    });
    expect(result).toEqual({
      deleted: true,
      transferredLeagueCount: 1,
      deletedSoleMemberLeagueCount: 1,
      preservedSharedProjectionSetCount: 1,
    });

    expect(await db.select().from(users).where(eq(users.id, deletingUserId))).toHaveLength(0);
    expect(await db.select().from(leagues).where(eq(leagues.id, soloLeagueId))).toHaveLength(0);
    expect(await db.select().from(leagues).where(eq(leagues.id, sharedLeagueId))).toEqual([
      expect.objectContaining({ ownerUserId: successorUserId }),
    ]);
    expect(
      await db
        .select({ role: leagueMemberships.role })
        .from(leagueMemberships)
        .where(
          and(
            eq(leagueMemberships.leagueId, sharedLeagueId),
            eq(leagueMemberships.userId, successorUserId),
          ),
        ),
    ).toEqual([{ role: "owner" }]);
    expect(
      await db.select().from(leagueSeasons).where(eq(leagueSeasons.id, sharedSeasonId)),
    ).toEqual([expect.objectContaining({ connectionId: null })]);
    expect(
      await db.select().from(fantasyTeams).where(eq(fantasyTeams.id, sharedTeamId)),
    ).toHaveLength(1);

    for (const rows of await Promise.all([
      db.select().from(sessions).where(eq(sessions.userId, deletingUserId)),
      db.select().from(browserHandoffTokens).where(eq(browserHandoffTokens.userId, deletingUserId)),
      db.select().from(oauthStates).where(eq(oauthStates.userId, deletingUserId)),
      db.select().from(providerConnections).where(eq(providerConnections.userId, deletingUserId)),
      db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, deletingUserId)),
      db
        .select()
        .from(notificationDeliveries)
        .where(eq(notificationDeliveries.userId, deletingUserId)),
      db.select().from(bridgeDevices).where(eq(bridgeDevices.userId, deletingUserId)),
      db
        .select()
        .from(bridgePairingSessions)
        .where(eq(bridgePairingSessions.userId, deletingUserId)),
      db.select().from(userPreferences).where(eq(userPreferences.userId, deletingUserId)),
      db.select().from(rankingLists).where(eq(rankingLists.ownerUserId, deletingUserId)),
      db
        .select()
        .from(aiProviderCredentials)
        .where(eq(aiProviderCredentials.userId, deletingUserId)),
      db.select().from(invitations),
      db.select().from(changeEventReceipts).where(eq(changeEventReceipts.userId, deletingUserId)),
    ])) {
      expect(rows).toHaveLength(0);
    }

    expect(
      await db.select().from(projectionSets).where(eq(projectionSets.id, privateProjectionId)),
    ).toHaveLength(0);
    expect(
      await db.select().from(projectionSets).where(eq(projectionSets.id, leagueProjectionId)),
    ).toEqual([
      expect.objectContaining({
        createdByUserId: null,
        visibility: "league",
        metadata: { importedByUserId: anonymizedProvenanceUserId },
      }),
    ]);
    expect(
      await db
        .select()
        .from(playerProjections)
        .where(eq(playerProjections.projectionSetId, leagueProjectionId)),
    ).toHaveLength(1);
    expect(await db.select().from(recapPersonaCards)).toHaveLength(0);
    expect(await db.select().from(weeklyRecaps)).toHaveLength(0);
    expect(await db.select().from(changeEvents).where(eq(changeEvents.id, changeEventId))).toEqual([
      expect.objectContaining({ actorUserId: null, leagueId: sharedLeagueId }),
    ]);
    expect(await db.select().from(aiUsageLedger)).toEqual([
      expect.objectContaining({ userId: null, credentialId: null, inputTokens: 100 }),
    ]);
    const survivingRankingProvenance = await db
      .select({
        version: rankingListVersions.provenance,
        fields: rankingEntries.fieldProvenance,
      })
      .from(rankingListVersions)
      .innerJoin(rankingEntries, eq(rankingEntries.versionId, rankingListVersions.id))
      .where(eq(rankingListVersions.id, clonedRankingVersionId));
    expect(JSON.stringify(survivingRankingProvenance)).not.toContain(deletingUserId);
    expect(JSON.stringify(survivingRankingProvenance)).toContain(anonymizedProvenanceUserId);
    const deletionAudits = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.action, "account.deleted"),
          eq(auditEvents.correlationId, "account-delete-correlation"),
        ),
      );
    expect(deletionAudits).toHaveLength(1);
    expect(deletionAudits[0]).toMatchObject({ userId: null, targetId: null });
    expect(deletionAudits[0]?.metadata).toMatchObject({
      transferredLeagueCount: 1,
      deletedLeagueIntelCount: 1,
      deletedWeeklyRecapCount: 1,
    });
  });

  it("binds, confirms, and atomically exchanges a handoff for a normal session once", async () => {
    const sourceSessionToken = "S".repeat(32);
    const creationToken = "C".repeat(43);
    const redemptionToken = "R".repeat(43);
    const rejectedSessionToken = "N".repeat(43);
    const browserSessionToken = "B".repeat(43);
    const [sourceSession] = await db
      .insert(sessions)
      .values({
        userId: successorUserId,
        tokenHash: hashSessionToken(sourceSessionToken),
        expiresAt: new Date("2032-01-01T00:00:00.000Z"),
      })
      .returning({ id: sessions.id });
    if (!sourceSession) throw new Error("Expected source handoff session");
    const generated = [creationToken, redemptionToken, rejectedSessionToken, browserSessionToken];
    const service = new BrowserHandoffService(
      new DrizzleBrowserHandoffStore(db),
      "https://self-host.example",
      () => NOW,
      () => generated.shift() ?? "X".repeat(43),
    );

    const created = await service.create(successorUserId, sourceSessionToken, "/stats");
    expect(created?.handoffUrl).toContain(`#${creationToken}`);
    expect(await db.select().from(browserHandoffTokens)).toEqual([
      expect.objectContaining({
        userId: successorUserId,
        sourceSessionId: sourceSession.id,
        tokenHash: createHash("sha256").update(creationToken).digest("base64url"),
        destination: "/stats",
        stagedAt: null,
        confirmedAt: null,
      }),
    ]);

    expect(await service.stage(creationToken)).toEqual({
      redemptionToken,
      expiresAt: new Date("2031-11-08T14:31:00.000Z"),
      accountHint: "s***@example.test",
    });
    // A direct consume navigation cannot bypass the explicit Continue-as confirmation.
    await expect(service.consume(redemptionToken)).resolves.toBeUndefined();
    await expect(service.confirm(redemptionToken)).resolves.toBe(true);
    expect(await db.select().from(browserHandoffTokens)).toEqual([
      expect.objectContaining({
        tokenHash: createHash("sha256").update(redemptionToken).digest("base64url"),
        stagedAt: NOW,
        confirmedAt: NOW,
      }),
    ]);

    await expect(service.consume(redemptionToken)).resolves.toEqual({
      outcome: "session-created",
      userId: successorUserId,
      destination: "/stats",
      session: {
        token: browserSessionToken,
        expiresAt: new Date("2031-12-08T14:30:00.000Z"),
      },
    });
    await expect(service.consume(redemptionToken)).resolves.toBeUndefined();
    expect(await db.select().from(browserHandoffTokens)).toHaveLength(0);
    expect(
      await db
        .select({ tokenHash: sessions.tokenHash })
        .from(sessions)
        .where(eq(sessions.tokenHash, hashSessionToken(browserSessionToken))),
    ).toEqual([{ tokenHash: hashSessionToken(browserSessionToken) }]);
  });

  it("invalidates an outstanding confirmed handoff when its source session logs out", async () => {
    const sourceSessionToken = "L".repeat(32);
    const generated = ["D".repeat(43), "E".repeat(43), "F".repeat(43)];
    await db.insert(sessions).values({
      userId: successorUserId,
      tokenHash: hashSessionToken(sourceSessionToken),
      expiresAt: new Date("2032-01-01T00:00:00.000Z"),
    });
    const service = new BrowserHandoffService(
      new DrizzleBrowserHandoffStore(db),
      "https://self-host.example",
      () => NOW,
      () => generated.shift() ?? "X".repeat(43),
    );
    const created = await service.create(
      successorUserId,
      sourceSessionToken,
      "/connections/yahoo/connect",
    );
    expect(created).toBeDefined();
    const staged = await service.stage("D".repeat(43));
    expect(staged?.accountHint).toBe("s***@example.test");
    await expect(service.confirm("E".repeat(43))).resolves.toBe(true);

    await db.delete(sessions).where(eq(sessions.tokenHash, hashSessionToken(sourceSessionToken)));

    expect(await db.select().from(browserHandoffTokens)).toHaveLength(0);
    await expect(service.consume("E".repeat(43))).resolves.toBeUndefined();
  });

  it("invalidates handoffs on password change even when the source session is retained", async () => {
    const originalPassword = "handoff password original value";
    const sourceSessionToken = "P".repeat(32);
    const generated = ["G".repeat(43), "H".repeat(43), "I".repeat(43)];
    await db.insert(users).values({
      id: handoffPasswordUserId,
      email: "handoff-password@example.test",
      displayName: "Handoff Password",
      passwordHash: await hashOwnerPassword(originalPassword),
    });
    await db.insert(sessions).values({
      userId: handoffPasswordUserId,
      tokenHash: hashSessionToken(sourceSessionToken),
      expiresAt: new Date("2032-01-01T00:00:00.000Z"),
    });
    const handoffs = new BrowserHandoffService(
      new DrizzleBrowserHandoffStore(db),
      "https://self-host.example",
      () => NOW,
      () => generated.shift() ?? "X".repeat(43),
    );
    expect(
      await handoffs.create(
        handoffPasswordUserId,
        sourceSessionToken,
        "/connections/yahoo/connect",
      ),
    ).toBeDefined();
    await handoffs.stage("G".repeat(43));
    await handoffs.confirm("H".repeat(43));

    const auth = new AuthService(new DrizzleAuthRepository(db), () => NOW);
    await expect(
      auth.changePassword(
        handoffPasswordUserId,
        originalPassword,
        "handoff password replacement value",
        sourceSessionToken,
      ),
    ).resolves.toEqual({ outcome: "changed", revokedOtherSessions: true });

    expect(
      await db.select().from(sessions).where(eq(sessions.userId, handoffPasswordUserId)),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(browserHandoffTokens)
        .where(eq(browserHandoffTokens.userId, handoffPasswordUserId)),
    ).toHaveLength(0);
    await expect(handoffs.consume("H".repeat(43))).resolves.toBeUndefined();
  });

  it("binds native Yahoo mode to user, expiry, and one-time OAuth state", async () => {
    let currentTime = NOW;
    const credentialKey = parseCredentialKey(`base64:${Buffer.alloc(32, 7).toString("base64")}`);
    const service = new YahooConnectionService({
      database: db,
      credentialKey,
      clientId: "self-host-client",
      clientSecret: "self-host-secret",
      redirectUri: "https://self-host.example/v1/connections/yahoo/callback",
      now: () => currentTime,
      fetch: () => Promise.reject(new Error("token exchange must not run for denial")),
    });
    const started = await service.start(nativeYahooUserId, {
      returnMode: "ios-app",
      returnTo: "/connections",
    });
    const expiredStart = await service.start(nativeYahooUserId, {
      returnMode: "ios-app",
      returnTo: "/connections",
    });
    const browserStart = await service.start(nativeYahooUserId, {
      returnMode: "browser",
      returnTo: "/connections?from=settings",
    });
    const state = new URL(started.authorizationUrl).searchParams.get("state");
    const expiringState = new URL(expiredStart.authorizationUrl).searchParams.get("state");
    const browserState = new URL(browserStart.authorizationUrl).searchParams.get("state");
    if (!state || !expiringState || !browserState) {
      throw new Error("Expected Yahoo authorization state");
    }
    expect(new URL(started.authorizationUrl).searchParams.get("redirect_uri")).toBe(
      "https://self-host.example/v1/connections/yahoo/callback",
    );

    const [stored] = await db
      .select()
      .from(oauthStates)
      .where(eq(oauthStates.stateHash, hashOAuthState(state)));
    expect(stored).toMatchObject({
      userId: nativeYahooUserId,
      returnMode: "ios-app",
      returnTo: "/connections",
      consumedAt: null,
    });
    expect(JSON.stringify(stored?.encryptedPkceVerifier)).not.toContain(state);

    await expect(service.deny(nativeYahooOtherUserId, state)).rejects.toMatchObject({
      code: "INVALID_STATE",
    });
    expect(
      await db
        .select({ consumedAt: oauthStates.consumedAt })
        .from(oauthStates)
        .where(eq(oauthStates.stateHash, hashOAuthState(state))),
    ).toEqual([{ consumedAt: null }]);

    await expect(service.deny(nativeYahooUserId, state)).resolves.toEqual({
      returnMode: "ios-app",
      returnTo: "/connections",
    });
    await expect(service.deny(nativeYahooUserId, browserState)).resolves.toEqual({
      returnMode: "browser",
      returnTo: "/connections?from=settings",
    });
    await expect(service.deny(nativeYahooUserId, state)).rejects.toMatchObject({
      code: "STATE_REPLAYED",
    });
    await expect(service.deny(nativeYahooUserId, "malformed-state")).rejects.toMatchObject({
      code: "INVALID_STATE",
    });

    currentTime = new Date(NOW.getTime() + 11 * 60 * 1000);
    await expect(service.deny(nativeYahooUserId, expiringState)).rejects.toMatchObject({
      code: "STATE_EXPIRED",
    });
  });

  it("stores native Yahoo credentials before completion and burns state on every exchange outcome", async () => {
    const credentialKey = parseCredentialKey(`base64:${Buffer.alloc(32, 8).toString("base64")}`);
    const successful = new YahooConnectionService({
      database: db,
      credentialKey,
      clientId: "self-host-client",
      clientSecret: "self-host-secret",
      redirectUri: "https://self-host.example/v1/connections/yahoo/callback",
      now: () => NOW,
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              access_token: "SECRET_NATIVE_ACCESS_TOKEN",
              refresh_token: "SECRET_NATIVE_REFRESH_TOKEN",
              token_type: "bearer",
              expires_in: 3600,
              xoauth_yahoo_guid: "native-yahoo-guid",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        ),
    });
    const started = await successful.start(nativeYahooUserId, {
      returnMode: "ios-app",
      returnTo: "/connections",
    });
    const state = new URL(started.authorizationUrl).searchParams.get("state");
    if (!state) throw new Error("Expected Yahoo authorization state");
    const result = await successful.complete(nativeYahooUserId, {
      code: "SECRET_NATIVE_AUTHORIZATION_CODE",
      state,
    });
    expect(result).toMatchObject({
      returnMode: "ios-app",
      returnTo: "/connections",
    });
    const [connection] = await db
      .select()
      .from(providerConnections)
      .where(eq(providerConnections.id, result.connectionId));
    const serializedCredential = JSON.stringify(connection?.encryptedCredential);
    expect(serializedCredential).not.toContain("SECRET_NATIVE_ACCESS_TOKEN");
    expect(serializedCredential).not.toContain("SECRET_NATIVE_REFRESH_TOKEN");
    expect(serializedCredential).not.toContain("SECRET_NATIVE_AUTHORIZATION_CODE");
    expect(connection).toMatchObject({
      userId: nativeYahooUserId,
      externalAccountId: "native-yahoo-guid",
      health: "healthy",
    });

    const temporarilyUnavailable = new YahooConnectionService({
      database: db,
      credentialKey,
      clientId: "self-host-client",
      clientSecret: "self-host-secret",
      redirectUri: "https://self-host.example/v1/connections/yahoo/callback",
      now: () => NOW,
      fetch: () => Promise.reject(new Error("upstream offline")),
    });
    const unavailableStart = await temporarilyUnavailable.start(nativeYahooUserId, {
      returnMode: "ios-app",
      returnTo: "/connections",
    });
    const unavailableState = new URL(unavailableStart.authorizationUrl).searchParams.get("state");
    if (!unavailableState) throw new Error("Expected unavailable Yahoo state");
    await expect(
      temporarilyUnavailable.complete(nativeYahooUserId, {
        code: "unavailable-authorization-code",
        state: unavailableState,
      }),
    ).rejects.toMatchObject({
      outcome: "unavailable",
      completion: { returnMode: "ios-app", returnTo: "/connections" },
    } satisfies Partial<YahooConnectionCallbackError>);
    await expect(
      temporarilyUnavailable.complete(nativeYahooUserId, {
        code: "unavailable-authorization-code",
        state: unavailableState,
      }),
    ).rejects.toMatchObject({ code: "STATE_REPLAYED" } satisfies Partial<YahooConnectionError>);

    const failed = new YahooConnectionService({
      database: db,
      credentialKey,
      clientId: "self-host-client",
      clientSecret: "self-host-secret",
      redirectUri: "https://self-host.example/v1/connections/yahoo/callback",
      now: () => NOW,
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              access_token: "SECRET_FAILED_ACCESS_TOKEN",
              refresh_token: "SECRET_FAILED_REFRESH_TOKEN",
              token_type: "bearer",
              expires_in: 3600,
            }),
            { status: 200 },
          ),
        ),
    });
    const failedStart = await failed.start(nativeYahooUserId, {
      returnMode: "ios-app",
      returnTo: "/connections",
    });
    const failedState = new URL(failedStart.authorizationUrl).searchParams.get("state");
    if (!failedState) throw new Error("Expected failed Yahoo state");
    await expect(
      failed.complete(nativeYahooUserId, {
        code: "failed-authorization-code",
        state: failedState,
      }),
    ).rejects.toMatchObject({
      outcome: "failed",
      completion: { returnMode: "ios-app", returnTo: "/connections" },
    } satisfies Partial<YahooConnectionCallbackError>);
  });

  it("atomically leaves a shared league, transfers ownership, and detaches only that member's sync", async () => {
    const ownerId = randomUUID();
    const successorId = randomUUID();
    const leagueId = randomUUID();
    const seasonId = randomUUID();
    const ownerConnectionId = randomUUID();
    const successorConnectionId = randomUUID();
    const bridgeDeviceId = randomUUID();
    await db.insert(users).values([
      {
        id: ownerId,
        email: `${ownerId}@example.test`,
        displayName: "Leaving owner",
      },
      {
        id: successorId,
        email: `${successorId}@example.test`,
        displayName: "Remaining commissioner",
      },
    ]);
    await db.insert(providerConnections).values([
      {
        id: ownerConnectionId,
        userId: ownerId,
        provider: "espn",
        externalAccountId: `owner-${ownerId}`,
        health: "healthy",
      },
      {
        id: successorConnectionId,
        userId: successorId,
        provider: "espn",
        externalAccountId: `successor-${successorId}`,
        health: "healthy",
      },
    ]);
    await db.insert(leagues).values({ id: leagueId, ownerUserId: ownerId, name: "Shared Removal" });
    await db.insert(leagueMemberships).values({
      leagueId,
      userId: successorId,
      role: "commissioner",
    });
    await db.insert(leagueSeasons).values({
      id: seasonId,
      leagueId,
      connectionId: ownerConnectionId,
      provider: "espn",
      externalKey: "24681012",
      season: 2031,
      teamCount: 10,
      draftType: "auction",
    });
    await db.insert(providerLeagueLinks).values([
      { connectionId: ownerConnectionId, leagueSeasonId: seasonId },
      { connectionId: successorConnectionId, leagueSeasonId: seasonId },
    ]);
    await db.insert(bridgeDevices).values({
      id: bridgeDeviceId,
      userId: ownerId,
      provider: "espn",
      clientKind: "chrome-extension",
      agentCapable: true,
      name: "Owner Chrome",
      tokenHash: "owner-bridge-token-hash-that-is-long-enough",
    });
    await db.insert(bridgeDeviceLeagues).values({
      bridgeDeviceId,
      externalLeagueId: "24681012",
      season: 2031,
      leagueId,
    });
    await db.insert(userPreferences).values({ userId: ownerId, defaultLeagueId: leagueId });

    const service = new LeagueMembershipService(db, () => NOW);
    const result = await service.removeLeague({
      userId: ownerId,
      leagueId,
      confirmation: "Shared Removal",
      correlationId: "shared-removal-test",
    });

    expect(result).toMatchObject({
      outcome: "removed",
      response: { leagueDeleted: false, ownershipTransferred: true },
    });
    expect(
      await db
        .select({ ownerUserId: leagues.ownerUserId })
        .from(leagues)
        .where(eq(leagues.id, leagueId)),
    ).toEqual([{ ownerUserId: successorId }]);
    expect(
      await db
        .select({ userId: leagueMemberships.userId, role: leagueMemberships.role })
        .from(leagueMemberships)
        .where(eq(leagueMemberships.leagueId, leagueId)),
    ).toEqual([{ userId: successorId, role: "owner" }]);
    expect(
      await db
        .select({ connectionId: providerLeagueLinks.connectionId })
        .from(providerLeagueLinks)
        .where(eq(providerLeagueLinks.leagueSeasonId, seasonId)),
    ).toEqual([{ connectionId: successorConnectionId }]);
    expect(
      await db
        .select({ connectionId: leagueSeasons.connectionId })
        .from(leagueSeasons)
        .where(eq(leagueSeasons.id, seasonId)),
    ).toEqual([{ connectionId: successorConnectionId }]);
    expect(
      await db
        .select()
        .from(bridgeDeviceLeagues)
        .where(eq(bridgeDeviceLeagues.bridgeDeviceId, bridgeDeviceId)),
    ).toEqual([]);
    expect(
      await db
        .select({ defaultLeagueId: userPreferences.defaultLeagueId })
        .from(userPreferences)
        .where(eq(userPreferences.userId, ownerId)),
    ).toEqual([{ defaultLeagueId: null }]);
    expect(
      await db
        .select({
          provider: leagueSyncExclusions.provider,
          externalKey: leagueSyncExclusions.externalKey,
        })
        .from(leagueSyncExclusions)
        .where(eq(leagueSyncExclusions.userId, ownerId)),
    ).toEqual([{ provider: "espn", externalKey: "24681012" }]);
  });

  it("deletes a sole-member league but retains the provider exclusion", async () => {
    const ownerId = randomUUID();
    const leagueId = randomUUID();
    const seasonId = randomUUID();
    const connectionId = randomUUID();
    await db.insert(users).values({
      id: ownerId,
      email: `${ownerId}@example.test`,
      displayName: "Solo owner",
    });
    await db.insert(providerConnections).values({
      id: connectionId,
      userId: ownerId,
      provider: "yahoo",
      externalAccountId: `solo-${ownerId}`,
      health: "healthy",
    });
    await db.insert(leagues).values({ id: leagueId, ownerUserId: ownerId, name: "Solo Removal" });
    await db.insert(leagueSeasons).values({
      id: seasonId,
      leagueId,
      connectionId,
      provider: "yahoo",
      externalKey: "999.l.123456",
      season: 2031,
      teamCount: 10,
      draftType: "snake",
    });
    await db.insert(providerLeagueLinks).values({ connectionId, leagueSeasonId: seasonId });

    const service = new LeagueMembershipService(db, () => NOW);
    const result = await service.removeLeague({
      userId: ownerId,
      leagueId,
      confirmation: "Solo Removal",
      correlationId: "solo-removal-test",
    });

    expect(result).toMatchObject({
      outcome: "removed",
      response: { leagueDeleted: true, ownershipTransferred: false },
    });
    expect(await db.select().from(leagues).where(eq(leagues.id, leagueId))).toEqual([]);
    expect(
      await db
        .select({
          provider: leagueSyncExclusions.provider,
          externalKey: leagueSyncExclusions.externalKey,
        })
        .from(leagueSyncExclusions)
        .where(eq(leagueSyncExclusions.userId, ownerId)),
    ).toEqual([{ provider: "yahoo", externalKey: "999.l.123456" }]);
  });
});
