import {
  aiProviderCredentials,
  aiUsageLedger,
  auditEvents,
  bridgeDeviceLeagues,
  bridgeDevices,
  bridgePairingSessions,
  changeEventReceipts,
  changeEvents,
  espnRefreshAttempts,
  fantasyTeams,
  importRuns,
  invitations,
  leagueMemberships,
  leagues,
  leagueSyncExclusions,
  notificationDeliveries,
  playerProjections,
  players,
  projectionSets,
  providerConnections,
  pushSubscriptions,
  rankingEntries,
  rankingLists,
  rankingListVersions,
  recapPersonaCards,
  refreshRequests,
  sessions,
  shareLinks,
  userPreferences,
  users,
  weeklyRecaps,
  type Database,
} from "@laces-out/db";
import { and, asc, eq, inArray, ne, or, sql } from "drizzle-orm";

import { verifyOwnerPassword } from "./auth.js";

export interface PortableAccountExport {
  readonly schemaVersion: 2;
  readonly exportedAt: string;
  readonly account: {
    readonly id: string;
    readonly email: string;
    readonly displayName: string;
    readonly role: string;
    readonly createdAt: Date;
    readonly updatedAt: Date;
  };
  /**
   * Sections are deliberately separated so an export stays useful as the application evolves.
   * Every query below is an allowlist. Credential envelopes, password/session/token hashes,
   * push endpoints and keys, OAuth state, pairing codes, and share tokens never enter this value.
   */
  readonly data: Readonly<Record<string, unknown>>;
  readonly omittedSecrets: readonly string[];
}

export interface AccountDeletionResult {
  readonly deleted: true;
  readonly transferredLeagueCount: number;
  readonly deletedSoleMemberLeagueCount: number;
  readonly preservedSharedProjectionSetCount: number;
}

export interface AccountDeletionRejection {
  readonly deleted: false;
  readonly reason: "invalid-current-password";
}

export interface AccountDeletionInput {
  readonly userId: string;
  readonly currentPassword: string;
  readonly correlationId: string;
  readonly deletedAt: Date;
}

export interface AccountDataPort {
  exportData(userId: string): Promise<PortableAccountExport | undefined>;
  deleteAccount(
    input: AccountDeletionInput,
  ): Promise<AccountDeletionResult | AccountDeletionRejection | undefined>;
}

const omittedSecrets = [
  "password hashes",
  "session, browser-handoff, and invitation token hashes",
  "OAuth state and PKCE verifiers",
  "encrypted fantasy-provider credentials",
  "ESPN bridge and pairing credentials",
  "push-service endpoints and encryption keys",
  "AI API keys, encrypted envelopes, fingerprints, and provider request hashes",
  "ranking share-link tokens",
] as const;

/** Valid UUID-shaped sentinel for provenance JSON that is not backed by a users row or account. */
const ANONYMIZED_PROVENANCE_USER_ID = "00000000-0000-4000-8000-000000000000";
const ACCOUNT_DELETION_ATTEMPTS = 3;

function databaseErrorCode(error: unknown): string | undefined {
  let cursor: unknown = error;
  for (let depth = 0; depth < 6 && cursor && typeof cursor === "object"; depth += 1) {
    if ("code" in cursor && typeof cursor.code === "string") return cursor.code;
    cursor = "cause" in cursor ? cursor.cause : undefined;
  }
  return undefined;
}

/**
 * Account portability and erasure live together because they must agree on what belongs to a
 * member. Shared league facts survive an account deletion; account-private artifacts and every
 * credential are removed by the schema's cascades after ownership has been resolved explicitly.
 */
export class DrizzleAccountDataRepository implements AccountDataPort {
  readonly #database: Database;
  readonly #now: () => Date;

  constructor(database: Database, now: () => Date = () => new Date()) {
    this.#database = database;
    this.#now = now;
  }

  async exportData(userId: string): Promise<PortableAccountExport | undefined> {
    const [account] = await this.#database
      .select({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        role: users.role,
        createdAt: users.createdAt,
        updatedAt: users.updatedAt,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!account) return undefined;

    const [
      preferenceRows,
      sessionRows,
      membershipRows,
      leagueSyncExclusionRows,
      providerRows,
      bridgeRows,
      pairingRows,
      pushRows,
      deliveryRows,
      invitationRows,
      rankingListRows,
      importRows,
      shareRows,
      projectionSetRows,
      aiProviderRows,
      aiUsageRows,
      activityRows,
      auditRows,
      personaRows,
      recapRows,
      refreshRows,
    ] = await Promise.all([
      this.#database
        .select({
          defaultLeagueId: userPreferences.defaultLeagueId,
          timezone: userPreferences.timezone,
          theme: userPreferences.theme,
          digestCadence: userPreferences.digestCadence,
          emailNotifications: userPreferences.emailNotifications,
          dashboardSettings: userPreferences.dashboardSettings,
          recommendationSettings: userPreferences.recommendationSettings,
          createdAt: userPreferences.createdAt,
          updatedAt: userPreferences.updatedAt,
        })
        .from(userPreferences)
        .where(eq(userPreferences.userId, userId)),
      this.#database
        .select({
          id: sessions.id,
          expiresAt: sessions.expiresAt,
          lastSeenAt: sessions.lastSeenAt,
          createdAt: sessions.createdAt,
        })
        .from(sessions)
        .where(eq(sessions.userId, userId)),
      this.#database
        .select({
          membershipId: leagueMemberships.id,
          leagueId: leagues.id,
          leagueName: leagues.name,
          leagueArchived: leagues.archived,
          role: leagueMemberships.role,
          claimedFantasyTeamId: leagueMemberships.claimedFantasyTeamId,
          claimedFantasyTeamName: fantasyTeams.name,
          claimedFantasyTeamExternalKey: fantasyTeams.externalKey,
          claimedAt: leagueMemberships.claimedAt,
          joinedAt: leagueMemberships.joinedAt,
        })
        .from(leagueMemberships)
        .innerJoin(leagues, eq(leagueMemberships.leagueId, leagues.id))
        .leftJoin(fantasyTeams, eq(leagueMemberships.claimedFantasyTeamId, fantasyTeams.id))
        .where(eq(leagueMemberships.userId, userId))
        .orderBy(asc(leagues.name)),
      this.#database
        .select({
          provider: leagueSyncExclusions.provider,
          externalKey: leagueSyncExclusions.externalKey,
          season: leagueSyncExclusions.season,
          removedAt: leagueSyncExclusions.removedAt,
        })
        .from(leagueSyncExclusions)
        .where(eq(leagueSyncExclusions.userId, userId))
        .orderBy(asc(leagueSyncExclusions.provider), asc(leagueSyncExclusions.season)),
      this.#database
        .select({
          id: providerConnections.id,
          provider: providerConnections.provider,
          externalAccountId: providerConnections.externalAccountId,
          displayName: providerConnections.displayName,
          capabilities: providerConnections.capabilities,
          health: providerConnections.health,
          credentialExpiresAt: providerConnections.credentialExpiresAt,
          lastSuccessfulAt: providerConnections.lastSuccessfulAt,
          lastErrorCode: providerConnections.lastErrorCode,
          lastErrorAt: providerConnections.lastErrorAt,
          createdAt: providerConnections.createdAt,
          updatedAt: providerConnections.updatedAt,
        })
        .from(providerConnections)
        .where(eq(providerConnections.userId, userId)),
      this.#database
        .select({
          id: bridgeDevices.id,
          provider: bridgeDevices.provider,
          clientKind: bridgeDevices.clientKind,
          agentCapable: bridgeDevices.agentCapable,
          name: bridgeDevices.name,
          expiresAt: bridgeDevices.expiresAt,
          lastSeenAt: bridgeDevices.lastSeenAt,
          revokedAt: bridgeDevices.revokedAt,
          createdAt: bridgeDevices.createdAt,
        })
        .from(bridgeDevices)
        .where(eq(bridgeDevices.userId, userId)),
      this.#database
        .select({
          id: bridgePairingSessions.id,
          deviceName: bridgePairingSessions.deviceName,
          allowedLeagueIds: bridgePairingSessions.allowedLeagueIds,
          season: bridgePairingSessions.season,
          expiresAt: bridgePairingSessions.expiresAt,
          consumedAt: bridgePairingSessions.consumedAt,
          createdAt: bridgePairingSessions.createdAt,
        })
        .from(bridgePairingSessions)
        .where(eq(bridgePairingSessions.userId, userId)),
      this.#database
        .select({
          id: pushSubscriptions.id,
          label: pushSubscriptions.userAgentLabel,
          createdAt: pushSubscriptions.createdAt,
          lastSuccessAt: pushSubscriptions.lastSuccessAt,
          lastFailureAt: pushSubscriptions.lastFailureAt,
        })
        .from(pushSubscriptions)
        .where(eq(pushSubscriptions.userId, userId)),
      this.#database
        .select({
          id: notificationDeliveries.id,
          kind: notificationDeliveries.kind,
          deliveredDeviceCount: notificationDeliveries.deliveredDeviceCount,
          createdAt: notificationDeliveries.createdAt,
        })
        .from(notificationDeliveries)
        .where(eq(notificationDeliveries.userId, userId)),
      this.#database
        .select({
          id: invitations.id,
          email: invitations.email,
          invitedByYou: sql<boolean>`${invitations.invitedByUserId} = ${userId}`,
          role: invitations.role,
          leagueId: invitations.leagueId,
          leagueRole: invitations.leagueRole,
          expiresAt: invitations.expiresAt,
          acceptedAt: invitations.acceptedAt,
          acceptedByYou: sql<boolean>`coalesce(${invitations.acceptedByUserId} = ${userId}, false)`,
          revokedAt: invitations.revokedAt,
          createdAt: invitations.createdAt,
        })
        .from(invitations)
        .where(
          or(
            eq(invitations.invitedByUserId, userId),
            eq(invitations.acceptedByUserId, userId),
            sql`lower(${invitations.email}) = lower(${account.email})`,
          ),
        ),
      this.#database
        .select({
          id: rankingLists.id,
          leagueId: rankingLists.leagueId,
          name: rankingLists.name,
          description: rankingLists.description,
          kind: rankingLists.kind,
          visibility: rankingLists.visibility,
          visibilityConfig: rankingLists.visibilityConfig,
          season: rankingLists.season,
          scoringContext: rankingLists.scoringContext,
          scoringFormat: rankingLists.scoringFormat,
          sourceLabel: rankingLists.sourceLabel,
          settings: rankingLists.settings,
          currentVersionId: rankingLists.currentVersionId,
          latestPublishedVersionId: rankingLists.latestPublishedVersionId,
          archivedAt: rankingLists.archivedAt,
          createdAt: rankingLists.createdAt,
          updatedAt: rankingLists.updatedAt,
        })
        .from(rankingLists)
        .where(eq(rankingLists.ownerUserId, userId)),
      this.#database
        .select({
          id: importRuns.id,
          rankingListId: importRuns.rankingListId,
          state: importRuns.state,
          sourceFormat: importRuns.sourceFormat,
          sourceFileName: importRuns.sourceFileName,
          sourceChecksumSha256: importRuns.sourceChecksumSha256,
          columnMapping: importRuns.columnMapping,
          rowsRead: importRuns.rowsRead,
          rowsAccepted: importRuns.rowsAccepted,
          rowsRejected: importRuns.rowsRejected,
          validationSummary: importRuns.validationSummary,
          diagnostics: importRuns.diagnostics,
          commitDecision: importRuns.commitDecision,
          acceptedRowNumbers: importRuns.acceptedRowNumbers,
          committedAt: importRuns.committedAt,
          errorCode: importRuns.errorCode,
          errorDetail: importRuns.errorDetail,
          startedAt: importRuns.startedAt,
          finishedAt: importRuns.finishedAt,
          createdAt: importRuns.createdAt,
        })
        .from(importRuns)
        .where(eq(importRuns.userId, userId)),
      this.#database
        .select({
          id: shareLinks.id,
          rankingListId: shareLinks.rankingListId,
          leagueId: shareLinks.leagueId,
          label: shareLinks.label,
          permission: shareLinks.permission,
          allowCopy: shareLinks.allowCopy,
          expiresAt: shareLinks.expiresAt,
          maxUses: shareLinks.maxUses,
          useCount: shareLinks.useCount,
          lastUsedAt: shareLinks.lastUsedAt,
          revokedAt: shareLinks.revokedAt,
          createdAt: shareLinks.createdAt,
        })
        .from(shareLinks)
        .where(eq(shareLinks.createdByUserId, userId)),
      this.#database
        .select({
          id: projectionSets.id,
          leagueSeasonId: projectionSets.leagueSeasonId,
          visibility: projectionSets.visibility,
          source: projectionSets.source,
          version: projectionSets.version,
          season: projectionSets.season,
          week: projectionSets.week,
          horizon: projectionSets.horizon,
          windowStartWeek: projectionSets.windowStartWeek,
          windowEndWeek: projectionSets.windowEndWeek,
          asOfWeek: projectionSets.asOfWeek,
          asOfAt: projectionSets.asOfAt,
          fetchedAt: projectionSets.fetchedAt,
          inputChecksum: projectionSets.inputChecksum,
          metadata: projectionSets.metadata,
          createdAt: projectionSets.createdAt,
        })
        .from(projectionSets)
        .where(eq(projectionSets.createdByUserId, userId)),
      this.#database
        .select({
          id: aiProviderCredentials.id,
          provider: aiProviderCredentials.provider,
          label: aiProviderCredentials.label,
          model: aiProviderCredentials.model,
          dailyRequestLimit: aiProviderCredentials.dailyRequestLimit,
          maxOutputTokens: aiProviderCredentials.maxOutputTokens,
          scopes: aiProviderCredentials.scopes,
          status: aiProviderCredentials.status,
          expiresAt: aiProviderCredentials.expiresAt,
          lastValidatedAt: aiProviderCredentials.lastValidatedAt,
          lastErrorCode: aiProviderCredentials.lastErrorCode,
          lastErrorAt: aiProviderCredentials.lastErrorAt,
          revokedAt: aiProviderCredentials.revokedAt,
          createdAt: aiProviderCredentials.createdAt,
          updatedAt: aiProviderCredentials.updatedAt,
        })
        .from(aiProviderCredentials)
        .where(eq(aiProviderCredentials.userId, userId)),
      this.#database
        .select({
          id: aiUsageLedger.id,
          provider: aiUsageLedger.provider,
          model: aiUsageLedger.model,
          operation: aiUsageLedger.operation,
          inputTokens: aiUsageLedger.inputTokens,
          outputTokens: aiUsageLedger.outputTokens,
          cacheReadTokens: aiUsageLedger.cacheReadTokens,
          cacheWriteTokens: aiUsageLedger.cacheWriteTokens,
          cost: aiUsageLedger.cost,
          currency: aiUsageLedger.currency,
          latencyMs: aiUsageLedger.latencyMs,
          succeeded: aiUsageLedger.succeeded,
          errorCode: aiUsageLedger.errorCode,
          metadata: aiUsageLedger.metadata,
          occurredAt: aiUsageLedger.occurredAt,
        })
        .from(aiUsageLedger)
        .where(eq(aiUsageLedger.userId, userId)),
      this.#database
        .select({
          eventId: changeEvents.id,
          source: changeEvents.source,
          eventType: changeEvents.eventType,
          aggregateType: changeEvents.aggregateType,
          aggregateId: changeEvents.aggregateId,
          leagueId: changeEvents.leagueId,
          visibility: changeEvents.visibility,
          severity: changeEvents.severity,
          payload: changeEvents.payload,
          occurredAt: changeEvents.occurredAt,
          deliveredAt: changeEventReceipts.deliveredAt,
          firstSeenAt: changeEventReceipts.firstSeenAt,
          readAt: changeEventReceipts.readAt,
          dismissedAt: changeEventReceipts.dismissedAt,
          deliveryChannels: changeEventReceipts.deliveryChannels,
        })
        .from(changeEventReceipts)
        .innerJoin(changeEvents, eq(changeEventReceipts.eventId, changeEvents.id))
        .where(eq(changeEventReceipts.userId, userId))
        .orderBy(asc(changeEvents.occurredAt)),
      this.#database
        .select({
          id: auditEvents.id,
          action: auditEvents.action,
          targetType: auditEvents.targetType,
          targetId: auditEvents.targetId,
          metadata: auditEvents.metadata,
          occurredAt: auditEvents.occurredAt,
        })
        .from(auditEvents)
        .where(eq(auditEvents.userId, userId)),
      this.#database
        .select({
          id: recapPersonaCards.id,
          leagueSeasonId: recapPersonaCards.leagueSeasonId,
          fantasyTeamId: recapPersonaCards.fantasyTeamId,
          body: recapPersonaCards.body,
          createdAt: recapPersonaCards.createdAt,
          updatedAt: recapPersonaCards.updatedAt,
        })
        .from(recapPersonaCards)
        .where(eq(recapPersonaCards.updatedByUserId, userId)),
      this.#database
        .select({
          id: weeklyRecaps.id,
          leagueSeasonId: weeklyRecaps.leagueSeasonId,
          week: weeklyRecaps.week,
          body: weeklyRecaps.body,
          provider: weeklyRecaps.provider,
          model: weeklyRecaps.model,
          spiceLevel: weeklyRecaps.spiceLevel,
          createdAt: weeklyRecaps.createdAt,
        })
        .from(weeklyRecaps)
        .where(eq(weeklyRecaps.generatedByUserId, userId)),
      this.#database
        .select({
          id: refreshRequests.id,
          connectionId: refreshRequests.connectionId,
          leagueSeasonId: refreshRequests.leagueSeasonId,
          rankingListId: refreshRequests.rankingListId,
          kind: refreshRequests.kind,
          state: refreshRequests.state,
          force: refreshRequests.force,
          priority: refreshRequests.priority,
          notBefore: refreshRequests.notBefore,
          expiresAt: refreshRequests.expiresAt,
          minimumCaptureAt: refreshRequests.minimumCaptureAt,
          requiredArtifacts: refreshRequests.requiredArtifacts,
          fulfillmentMode: refreshRequests.fulfillmentMode,
          startedAt: refreshRequests.startedAt,
          finishedAt: refreshRequests.finishedAt,
          errorCode: refreshRequests.errorCode,
          errorDetail: refreshRequests.errorDetail,
          resultSummary: refreshRequests.resultSummary,
          createdAt: refreshRequests.createdAt,
        })
        .from(refreshRequests)
        .where(eq(refreshRequests.requestedByUserId, userId)),
    ]);

    const bridgeIds = bridgeRows.map((row) => row.id);
    const refreshIds = refreshRows.map((row) => row.id);
    const rankingListIds = rankingListRows.map((row) => row.id);
    const projectionSetIds = projectionSetRows.map((row) => row.id);

    const [bridgeLeagueRows, refreshAttemptRows, rankingVersionRows, projectionRows] =
      await Promise.all([
        bridgeIds.length === 0
          ? Promise.resolve([])
          : this.#database
              .select({
                bridgeDeviceId: bridgeDeviceLeagues.bridgeDeviceId,
                externalLeagueId: bridgeDeviceLeagues.externalLeagueId,
                season: bridgeDeviceLeagues.season,
                leagueId: bridgeDeviceLeagues.leagueId,
                grantedAt: bridgeDeviceLeagues.grantedAt,
              })
              .from(bridgeDeviceLeagues)
              .where(inArray(bridgeDeviceLeagues.bridgeDeviceId, bridgeIds)),
        refreshIds.length === 0
          ? Promise.resolve([])
          : this.#database
              .select({
                id: espnRefreshAttempts.id,
                refreshRequestId: espnRefreshAttempts.refreshRequestId,
                mode: espnRefreshAttempts.mode,
                state: espnRefreshAttempts.state,
                errorCode: espnRefreshAttempts.errorCode,
                errorDetail: espnRefreshAttempts.errorDetail,
                startedAt: espnRefreshAttempts.startedAt,
                finishedAt: espnRefreshAttempts.finishedAt,
              })
              .from(espnRefreshAttempts)
              .where(inArray(espnRefreshAttempts.refreshRequestId, refreshIds)),
        rankingListIds.length === 0
          ? Promise.resolve([])
          : this.#database
              .select({
                id: rankingListVersions.id,
                listId: rankingListVersions.listId,
                versionNumber: rankingListVersions.versionNumber,
                parentVersionId: rankingListVersions.parentVersionId,
                state: rankingListVersions.state,
                importRunId: rankingListVersions.importRunId,
                dataAsOf: rankingListVersions.dataAsOf,
                publishedAt: rankingListVersions.publishedAt,
                entryCount: rankingListVersions.entryCount,
                checksumSha256: rankingListVersions.checksumSha256,
                changeNote: rankingListVersions.changeNote,
                provenance: rankingListVersions.provenance,
                metadata: rankingListVersions.metadata,
                createdAt: rankingListVersions.createdAt,
              })
              .from(rankingListVersions)
              .where(inArray(rankingListVersions.listId, rankingListIds)),
        projectionSetIds.length === 0
          ? Promise.resolve([])
          : this.#database
              .select({
                projectionSetId: playerProjections.projectionSetId,
                playerId: playerProjections.playerId,
                playerName: players.fullName,
                primaryPosition: players.primaryPosition,
                nflTeam: players.nflTeam,
                meanPoints: playerProjections.meanPoints,
                floorPoints: playerProjections.floorPoints,
                ceilingPoints: playerProjections.ceilingPoints,
                confidence: playerProjections.confidence,
                components: playerProjections.components,
              })
              .from(playerProjections)
              .innerJoin(players, eq(playerProjections.playerId, players.id))
              .where(inArray(playerProjections.projectionSetId, projectionSetIds)),
      ]);

    const rankingVersionIds = rankingVersionRows.map((row) => row.id);
    const rankingEntryRows =
      rankingVersionIds.length === 0
        ? []
        : await this.#database
            .select({
              versionId: rankingEntries.versionId,
              playerId: rankingEntries.playerId,
              playerName: players.fullName,
              primaryPosition: players.primaryPosition,
              nflTeam: players.nflTeam,
              position: rankingEntries.position,
              overallRank: rankingEntries.overallRank,
              tier: rankingEntries.tier,
              positionRank: rankingEntries.positionRank,
              adp: rankingEntries.adp,
              aav: rankingEntries.aav,
              floorPrice: rankingEntries.floorPrice,
              targetPrice: rankingEntries.targetPrice,
              ceilingPrice: rankingEntries.ceilingPrice,
              confidence: rankingEntries.confidence,
              tags: rankingEntries.tags,
              userFields: rankingEntries.userFields,
              fieldProvenance: rankingEntries.fieldProvenance,
              notes: rankingEntries.notes,
              target: rankingEntries.target,
              avoid: rankingEntries.avoid,
              createdAt: rankingEntries.createdAt,
              updatedAt: rankingEntries.updatedAt,
            })
            .from(rankingEntries)
            .innerJoin(players, eq(rankingEntries.playerId, players.id))
            .where(inArray(rankingEntries.versionId, rankingVersionIds));

    return {
      schemaVersion: 2,
      exportedAt: this.#now().toISOString(),
      account,
      data: {
        preferences: preferenceRows[0] ?? null,
        sessions: sessionRows,
        leagueMemberships: membershipRows,
        removedLeagueSyncs: leagueSyncExclusionRows,
        providerConnections: providerRows,
        espnBridgeDevices: bridgeRows,
        espnBridgeLeagueGrants: bridgeLeagueRows,
        espnBridgePairingHistory: pairingRows,
        notificationDevices: pushRows,
        notificationDeliveries: deliveryRows,
        invitations: invitationRows,
        rankingLists: rankingListRows,
        rankingVersions: rankingVersionRows,
        rankingEntries: rankingEntryRows,
        rankingImports: importRows,
        rankingShares: shareRows,
        projectionSets: projectionSetRows,
        playerProjections: projectionRows,
        aiProviderConfigurations: aiProviderRows,
        aiUsage: aiUsageRows,
        activityFeed: activityRows,
        securityAuditHistory: auditRows,
        leagueIntelContributions: personaRows,
        weeklyRecapContributions: recapRows,
        refreshHistory: refreshRows,
        espnRefreshAttempts: refreshAttemptRows,
      },
      omittedSecrets,
    };
  }

  async deleteAccount(
    input: AccountDeletionInput,
  ): Promise<AccountDeletionResult | AccountDeletionRejection | undefined> {
    for (let attempt = 1; attempt <= ACCOUNT_DELETION_ATTEMPTS; attempt += 1) {
      try {
        return await this.#deleteAccountOnce(input);
      } catch (error) {
        // Transferring two owners who are each other's selected successor can introduce a hidden
        // user-FK edge after both transactions have locked their own account. PostgreSQL chooses a
        // victim; retrying the fully atomic deletion is safe because the aborted attempt committed
        // no erasure, audit, ownership, or password-verification state.
        if (databaseErrorCode(error) !== "40P01" || attempt === ACCOUNT_DELETION_ATTEMPTS) {
          throw error;
        }
      }
    }
    throw new Error("Account deletion retry loop exhausted unexpectedly");
  }

  async #deleteAccountOnce(
    input: AccountDeletionInput,
  ): Promise<AccountDeletionResult | AccountDeletionRejection | undefined> {
    return this.#database.transaction(async (transaction) => {
      const [account] = await transaction
        .select({ id: users.id, email: users.email, passwordHash: users.passwordHash })
        .from(users)
        .where(eq(users.id, input.userId))
        .limit(1)
        .for("update");
      const passwordVerified = await verifyOwnerPassword(
        account?.passwordHash,
        input.currentPassword,
      );
      if (!account) return undefined;
      if (!passwordVerified) {
        return { deleted: false, reason: "invalid-current-password" };
      }

      // Ranking immutability triggers recognize this transaction-local value and only permit an
      // exact UUID-to-sentinel replacement in provenance JSON. It resets automatically at commit.
      await transaction.execute(
        sql`select set_config('laces_out.account_deletion_user_id', ${input.userId}, true)`,
      );

      const ownedLeagues = await transaction
        .select({ id: leagues.id })
        .from(leagues)
        .where(eq(leagues.ownerUserId, input.userId))
        .orderBy(asc(leagues.id))
        .for("update");
      // Invitation acceptance uses the same parent-to-child order: all known users, then league,
      // then the invitation. Locking the league before its scoped invitation also blocks a new
      // child FK row from appearing between discovery and deletion.
      // Parent league row locks block new membership inserts at their FK check. Locking every
      // existing successor row then stabilizes role/order/removal without taking a table lock that
      // could deadlock against an invitation acceptance already inserting a membership.
      const successorRows =
        ownedLeagues.length === 0
          ? []
          : await transaction
              .select({
                id: leagueMemberships.id,
                leagueId: leagueMemberships.leagueId,
                userId: leagueMemberships.userId,
                role: leagueMemberships.role,
                joinedAt: leagueMemberships.joinedAt,
              })
              .from(leagueMemberships)
              .where(
                and(
                  inArray(
                    leagueMemberships.leagueId,
                    ownedLeagues.map((league) => league.id),
                  ),
                  ne(leagueMemberships.userId, input.userId),
                ),
              )
              .orderBy(
                asc(leagueMemberships.leagueId),
                sql`case ${leagueMemberships.role}
                  when 'commissioner' then 0
                  when 'member' then 1
                  else 2
                end`,
                asc(leagueMemberships.joinedAt),
                asc(leagueMemberships.id),
              )
              .for("update");
      const successorByLeague = new Map<string, string>();
      for (const membership of successorRows) {
        if (!successorByLeague.has(membership.leagueId)) {
          successorByLeague.set(membership.leagueId, membership.userId);
        }
      }

      let transferredLeagueCount = 0;
      let deletedSoleMemberLeagueCount = 0;
      for (const league of ownedLeagues) {
        const successorUserId = successorByLeague.get(league.id);
        if (successorUserId) {
          // The existing schema trigger atomically demotes the departing owner membership and
          // promotes the selected successor to the one canonical owner role.
          await transaction
            .update(leagues)
            .set({ ownerUserId: successorUserId, updatedAt: input.deletedAt })
            .where(and(eq(leagues.id, league.id), eq(leagues.ownerUserId, input.userId)));
          transferredLeagueCount += 1;
        } else {
          // No one else can observe this league. Removing it avoids leaving an ownerless data silo.
          await transaction.delete(leagues).where(eq(leagues.id, league.id));
          deletedSoleMemberLeagueCount += 1;
        }
      }

      // League Intel and generated recap bodies are shared text/UGC, not deterministic league
      // facts. App Store deletion guidance expects content authored or generated by the departing
      // account to disappear rather than survive under a null author.
      const deletedPersonaCards = await transaction
        .delete(recapPersonaCards)
        .where(eq(recapPersonaCards.updatedByUserId, input.userId))
        .returning({ id: recapPersonaCards.id });
      const deletedRecaps = await transaction
        .delete(weeklyRecaps)
        .where(eq(weeklyRecaps.generatedByUserId, input.userId))
        .returning({ id: weeklyRecaps.id });

      // A league-visible imported projection is shared league data. Its nullable creator field may
      // be anonymized without violating the projection scope constraint; private sets still cascade.
      const preservedProjectionSets = await transaction
        .update(projectionSets)
        .set({
          createdByUserId: null,
          metadata: sql`replace(
            ${projectionSets.metadata}::text,
            ${input.userId},
            ${ANONYMIZED_PROVENANCE_USER_ID}
          )::jsonb`,
        })
        .where(
          and(
            eq(projectionSets.createdByUserId, input.userId),
            eq(projectionSets.visibility, "league"),
          ),
        )
        .returning({ id: projectionSets.id });

      // A cloned ranking can outlive its original owner. Its JSON provenance is intentionally not
      // an FK because every field has independent authorship, so scrub the exact UUID while keeping
      // the schema-valid attribution object and the surviving member's copy intact.
      await transaction.execute(sql`
        update ${rankingEntries}
        set field_provenance = replace(
          ${rankingEntries.fieldProvenance}::text,
          ${input.userId},
          ${ANONYMIZED_PROVENANCE_USER_ID}
        )::jsonb
        where ${rankingEntries.fieldProvenance}::text like ${`%${input.userId}%`}
      `);
      await transaction.execute(sql`
        update ${rankingListVersions}
        set provenance = replace(
          ${rankingListVersions.provenance}::text,
          ${input.userId},
          ${ANONYMIZED_PROVENANCE_USER_ID}
        )::jsonb
        where ${rankingListVersions.provenance}::text like ${`%${input.userId}%`}
      `);

      // Invitations are capabilities and carry raw invitee email. Remove every record the account
      // created, accepted, or was addressed by email before the two RESTRICT references are checked.
      await transaction
        .delete(invitations)
        .where(
          or(
            eq(invitations.invitedByUserId, input.userId),
            eq(invitations.acceptedByUserId, input.userId),
            sql`lower(${invitations.email}) = lower(${account.email})`,
          ),
        );

      // The row is intentionally anonymous after the FK's ON DELETE SET NULL action. It records no
      // email, display name, user id, or credential identifier, but lets an operator prove erasure.
      await transaction.insert(auditEvents).values({
        userId: input.userId,
        action: "account.deleted",
        targetType: "account",
        targetId: null,
        correlationId: input.correlationId.slice(0, 128),
        metadata: {
          transferredLeagueCount,
          deletedSoleMemberLeagueCount,
          preservedSharedProjectionSetCount: preservedProjectionSets.length,
          deletedLeagueIntelCount: deletedPersonaCards.length,
          deletedWeeklyRecapCount: deletedRecaps.length,
        },
        occurredAt: input.deletedAt,
      });

      const deleted = await transaction
        .delete(users)
        .where(eq(users.id, input.userId))
        .returning({ id: users.id });
      if (deleted.length !== 1) throw new Error("Account disappeared during deletion");

      return {
        deleted: true,
        transferredLeagueCount,
        deletedSoleMemberLeagueCount,
        preservedSharedProjectionSetCount: preservedProjectionSets.length,
      };
    });
  }
}
