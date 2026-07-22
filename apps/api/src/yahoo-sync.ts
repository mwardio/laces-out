import {
  parseYahooLeaguePageXml,
  parseYahooLeagueSyncArtifacts,
  YahooFantasyReadClient,
  YahooReadClientError,
  type YahooXmlArtifact,
} from "@fantasy/connector-yahoo";
import type { ExternalLeagueRef, LeagueSyncBundle } from "@fantasy/connectors";
import {
  auditEvents,
  fantasyTeams,
  leagueMemberships,
  leagues,
  leagueSeasons,
  matchupSnapshots,
  playerExternalIds,
  players,
  providerConnections,
  providerLeagueLinks,
  rosterEntries,
  rosterSlotRules,
  rosterSnapshots,
  scoringRules,
  standingsEntries,
  standingsSnapshots,
  syncRuns,
  weeklyMatchups,
  type ConnectionHealth,
  type Database,
} from "@fantasy/db";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";

import { YahooConnectionError } from "./yahoo-connection.js";

const DEFAULT_PAGE_SIZE = 25;
const MAX_DISCOVERY_PAGES = 40;
const MAX_DISCOVERED_LEAGUES = 500;

export interface YahooConnectionLeagueStatus {
  readonly leagueId: string;
  readonly leagueSeasonId: string;
  readonly name: string;
  readonly externalKey: string;
  readonly season: number;
  readonly currentWeek: number | null;
  readonly lastSyncedAt: string | null;
  readonly currentUserTeamExternalKey: string | null;
}

export interface YahooConnectionStatus {
  readonly connectionId: string;
  readonly displayName: string;
  readonly health: ConnectionHealth;
  readonly credentialExpiresAt: string | null;
  readonly lastSuccessfulAt: string | null;
  readonly lastErrorCode: string | null;
  readonly lastErrorAt: string | null;
  readonly leagues: readonly YahooConnectionLeagueStatus[];
}

export interface YahooSyncReceipt {
  readonly syncRunId: string;
  readonly leagueId: string;
  readonly leagueSeasonId: string;
  readonly externalLeagueKey: string;
  readonly season: number;
  readonly state: "accepted" | "unchanged";
  readonly recordsWritten: number;
  readonly syncedAt: string;
}

export interface YahooDiscoveryResult {
  readonly connectionId: string;
  readonly discovered: readonly ExternalLeagueRef[];
  readonly syncs: readonly YahooSyncReceipt[];
  readonly generatedAt: string;
}

export class YahooSyncError extends Error {
  readonly code:
    | "CONNECTION_NOT_FOUND"
    | "DISCOVERY_LIMIT"
    | "DUPLICATE_LEAGUE"
    | "LOCAL_DISCONNECT_FAILED"
    | "PROVIDER_READ_FAILED"
    | "PERSISTENCE_FAILED";
  readonly statusCode: number;

  constructor(code: YahooSyncError["code"], message: string) {
    super(message);
    this.name = "YahooSyncError";
    this.code = code;
    this.statusCode =
      code === "CONNECTION_NOT_FOUND"
        ? 404
        : code === "DISCOVERY_LIMIT"
          ? 422
          : code === "LOCAL_DISCONNECT_FAILED"
            ? 500
            : 502;
  }
}

interface OwnedConnection {
  readonly id: string;
  readonly health: ConnectionHealth;
}

export interface YahooSyncRepository {
  findOwnedConnection(userId: string, connectionId: string): Promise<OwnedConnection | undefined>;
  listConnectionStatus(userId: string): Promise<readonly YahooConnectionStatus[]>;
  disconnectOwnedConnection(input: {
    readonly userId: string;
    readonly connectionId: string;
    readonly correlationId: string;
    readonly disconnectedAt: Date;
  }): Promise<boolean>;
  persistBundle(
    userId: string,
    connectionId: string,
    bundle: LeagueSyncBundle,
  ): Promise<YahooSyncReceipt>;
  markFailure(userId: string, connectionId: string, errorCode: string, at: Date): Promise<void>;
}

export interface YahooAccessTokenPort {
  getAccessToken(
    userId: string,
    connectionId: string,
    options?: { readonly forceRefresh?: boolean; readonly minimumValiditySeconds?: number },
  ): Promise<string>;
}

export interface YahooReadPort {
  getUserLeagues(
    request: { readonly accessToken: string },
    options: {
      readonly gameKeys: readonly string[];
      readonly start: number;
      readonly count: number;
    },
  ): Promise<YahooXmlArtifact>;
  getLeagueSettings(
    request: { readonly accessToken: string },
    leagueKey: string,
  ): Promise<YahooXmlArtifact>;
  getLeagueTeams(
    request: { readonly accessToken: string },
    leagueKey: string,
  ): Promise<YahooXmlArtifact>;
  getLeagueRosters(
    request: { readonly accessToken: string },
    leagueKey: string,
  ): Promise<YahooXmlArtifact>;
  getLeagueStandings(
    request: { readonly accessToken: string },
    leagueKey: string,
  ): Promise<YahooXmlArtifact>;
  getLeagueMatchups(
    request: { readonly accessToken: string },
    leagueKey: string,
  ): Promise<YahooXmlArtifact>;
}

function slotEligibility(slotCode: string): string[] {
  const normalized = slotCode.toUpperCase();
  if (["FLEX", "W/R/T", "RB/WR/TE"].includes(normalized)) return ["RB", "WR", "TE"];
  if (["OP", "SUPER_FLEX", "Q/W/R/T", "QB/RB/WR/TE"].includes(normalized)) {
    return ["QB", "RB", "WR", "TE"];
  }
  if (["W/R", "RB/WR"].includes(normalized)) return ["RB", "WR"];
  if (["W/T", "WR/TE"].includes(normalized)) return ["WR", "TE"];
  return [slotCode];
}

function plainRecord(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "23505"
  );
}

function failureCode(error: unknown): string {
  if (error instanceof YahooReadClientError) return `read_${error.code.toLowerCase()}`;
  if (error instanceof YahooConnectionError) return error.code.toLowerCase();
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = String((error as { readonly code: unknown }).code).toLowerCase();
    if (/^[a-z0-9_-]{1,80}$/u.test(code)) return code;
  }
  return "yahoo_sync_failed";
}

function clientFacingSyncError(error: unknown): YahooSyncError {
  if (error instanceof YahooSyncError) return error;
  return new YahooSyncError(
    "PROVIDER_READ_FAILED",
    "Yahoo did not return a valid, complete league response",
  );
}

export class DrizzleYahooSyncRepository implements YahooSyncRepository {
  readonly #database: Database;
  readonly #now: () => Date;

  constructor(database: Database, now: () => Date = () => new Date()) {
    this.#database = database;
    this.#now = now;
  }

  async findOwnedConnection(
    userId: string,
    connectionId: string,
  ): Promise<OwnedConnection | undefined> {
    const [connection] = await this.#database
      .select({ id: providerConnections.id, health: providerConnections.health })
      .from(providerConnections)
      .where(
        and(
          eq(providerConnections.id, connectionId),
          eq(providerConnections.userId, userId),
          eq(providerConnections.provider, "yahoo"),
        ),
      )
      .limit(1);
    return connection;
  }

  async listConnectionStatus(userId: string): Promise<readonly YahooConnectionStatus[]> {
    const connectionRows = await this.#database
      .select({
        id: providerConnections.id,
        displayName: providerConnections.displayName,
        health: providerConnections.health,
        credentialExpiresAt: providerConnections.credentialExpiresAt,
        lastSuccessfulAt: providerConnections.lastSuccessfulAt,
        lastErrorCode: providerConnections.lastErrorCode,
        lastErrorAt: providerConnections.lastErrorAt,
      })
      .from(providerConnections)
      .where(and(eq(providerConnections.userId, userId), eq(providerConnections.provider, "yahoo")))
      .orderBy(asc(providerConnections.createdAt));
    if (connectionRows.length === 0) return [];

    const linkRows = await this.#database
      .select({
        connectionId: providerLeagueLinks.connectionId,
        leagueId: leagues.id,
        leagueSeasonId: leagueSeasons.id,
        name: leagues.name,
        externalKey: leagueSeasons.externalKey,
        season: leagueSeasons.season,
        currentWeek: leagueSeasons.currentWeek,
        seasonLastSyncedAt: leagueSeasons.lastSyncedAt,
        linkLastSyncedAt: providerLeagueLinks.lastSyncedAt,
        currentUserTeamExternalKey: providerLeagueLinks.currentUserTeamExternalKey,
      })
      .from(providerLeagueLinks)
      .innerJoin(leagueSeasons, eq(providerLeagueLinks.leagueSeasonId, leagueSeasons.id))
      .innerJoin(leagues, eq(leagueSeasons.leagueId, leagues.id))
      .where(
        inArray(
          providerLeagueLinks.connectionId,
          connectionRows.map((row) => row.id),
        ),
      )
      .orderBy(asc(leagues.name), asc(leagueSeasons.season));

    const links = new Map<string, YahooConnectionLeagueStatus[]>();
    for (const row of linkRows) {
      const list = links.get(row.connectionId) ?? [];
      const lastSyncedAt = row.linkLastSyncedAt ?? row.seasonLastSyncedAt;
      list.push({
        leagueId: row.leagueId,
        leagueSeasonId: row.leagueSeasonId,
        name: row.name,
        externalKey: row.externalKey,
        season: row.season,
        currentWeek: row.currentWeek,
        lastSyncedAt: lastSyncedAt?.toISOString() ?? null,
        currentUserTeamExternalKey: row.currentUserTeamExternalKey,
      });
      links.set(row.connectionId, list);
    }
    return connectionRows.map((row) => ({
      connectionId: row.id,
      displayName: row.displayName ?? "Yahoo Fantasy",
      health: row.health,
      credentialExpiresAt: row.credentialExpiresAt?.toISOString() ?? null,
      lastSuccessfulAt: row.lastSuccessfulAt?.toISOString() ?? null,
      lastErrorCode: row.lastErrorCode,
      lastErrorAt: row.lastErrorAt?.toISOString() ?? null,
      leagues: links.get(row.id) ?? [],
    }));
  }

  async disconnectOwnedConnection(input: {
    readonly userId: string;
    readonly connectionId: string;
    readonly correlationId: string;
    readonly disconnectedAt: Date;
  }): Promise<boolean> {
    return this.#database.transaction(async (transaction) => {
      const [connection] = await transaction
        .select({ id: providerConnections.id })
        .from(providerConnections)
        .where(
          and(
            eq(providerConnections.id, input.connectionId),
            eq(providerConnections.userId, input.userId),
            eq(providerConnections.provider, "yahoo"),
          ),
        )
        .limit(1)
        .for("update");
      if (!connection) return false;

      const linkedSeasons = await transaction
        .select({ id: leagueSeasons.id })
        .from(leagueSeasons)
        .where(eq(leagueSeasons.connectionId, connection.id));
      await transaction
        .update(leagueSeasons)
        .set({ connectionId: null, updatedAt: input.disconnectedAt })
        .where(eq(leagueSeasons.connectionId, connection.id));
      const deleted = await transaction
        .delete(providerConnections)
        .where(
          and(
            eq(providerConnections.id, connection.id),
            eq(providerConnections.userId, input.userId),
            eq(providerConnections.provider, "yahoo"),
          ),
        )
        .returning({ id: providerConnections.id });
      if (deleted.length !== 1) {
        throw new Error("Owned Yahoo connection disappeared during local disconnect");
      }

      await transaction.insert(auditEvents).values({
        userId: input.userId,
        action: "yahoo.connection.local_authorization_removed",
        targetType: "provider_connection",
        targetId: connection.id,
        correlationId: input.correlationId.slice(0, 128),
        metadata: {
          provider: "yahoo",
          providerRevocationAttempted: false,
          localCredentialRemoved: true,
          linkedLeagueSeasonCount: linkedSeasons.length,
          synchronizedLeagueData: "preserved_last_known",
        },
        occurredAt: input.disconnectedAt,
      });
      return true;
    });
  }

  async markFailure(
    userId: string,
    connectionId: string,
    errorCode: string,
    at: Date,
  ): Promise<void> {
    await this.#database
      .update(providerConnections)
      .set({
        health: sql<ConnectionHealth>`case when ${providerConnections.health} = 'reauthorize' then 'reauthorize' else 'degraded' end`,
        lastErrorCode: errorCode.slice(0, 120),
        lastErrorAt: at,
        updatedAt: at,
      })
      .where(
        and(
          eq(providerConnections.id, connectionId),
          eq(providerConnections.userId, userId),
          eq(providerConnections.provider, "yahoo"),
        ),
      );
  }

  async persistBundle(
    userId: string,
    connectionId: string,
    bundle: LeagueSyncBundle,
  ): Promise<YahooSyncReceipt> {
    if (bundle.provider !== "yahoo" || bundle.provenance.mode !== "official-api") {
      throw new YahooSyncError("PERSISTENCE_FAILED", "Yahoo sync rejected non-official provenance");
    }
    const checksum = bundle.provenance.artifactChecksumSha256;
    if (!checksum || !/^[a-f0-9]{64}$/u.test(checksum)) {
      throw new YahooSyncError("PERSISTENCE_FAILED", "Yahoo sync artifact checksum is invalid");
    }
    const fetchedAt = new Date(bundle.provenance.fetchedAt);
    if (!Number.isFinite(fetchedAt.getTime())) {
      throw new YahooSyncError("PERSISTENCE_FAILED", "Yahoo sync fetch timestamp is invalid");
    }
    const idempotencyKey = `yahoo:${connectionId}:${bundle.league.externalId}:${bundle.league.season}:${checksum}`;
    const now = this.#now();
    const currentUserTeams = bundle.teams.filter((team) => team.isCurrentUser);
    if (currentUserTeams.length > 1) {
      throw new Error("Yahoo marked more than one team as owned by the current login");
    }

    return this.#database.transaction(async (transaction) => {
      const [connection] = await transaction
        .select({ id: providerConnections.id, health: providerConnections.health })
        .from(providerConnections)
        .where(
          and(
            eq(providerConnections.id, connectionId),
            eq(providerConnections.userId, userId),
            eq(providerConnections.provider, "yahoo"),
          ),
        )
        .limit(1)
        .for("update");
      if (!connection) {
        throw new YahooSyncError("CONNECTION_NOT_FOUND", "Yahoo connection was not found");
      }

      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`yahoo:${bundle.league.externalId}:${bundle.league.season}`}, 0))`,
      );
      const [prior] = await transaction
        .select({
          id: syncRuns.id,
          leagueSeasonId: syncRuns.leagueSeasonId,
          recordsWritten: syncRuns.recordsWritten,
        })
        .from(syncRuns)
        .where(eq(syncRuns.idempotencyKey, idempotencyKey))
        .limit(1);
      if (prior?.leagueSeasonId) {
        const [season] = await transaction
          .select({ id: leagueSeasons.id, leagueId: leagueSeasons.leagueId })
          .from(leagueSeasons)
          .where(eq(leagueSeasons.id, prior.leagueSeasonId))
          .limit(1);
        if (!season) throw new Error("Yahoo idempotent sync referenced a missing league season");
        await transaction
          .update(leagueSeasons)
          .set({ lastSyncedAt: fetchedAt, updatedAt: now })
          .where(eq(leagueSeasons.id, season.id));
        await transaction
          .insert(providerLeagueLinks)
          .values({
            connectionId,
            leagueSeasonId: season.id,
            currentUserTeamExternalKey:
              bundle.teams.find((team) => team.isCurrentUser)?.externalId ?? null,
            lastSyncedAt: fetchedAt,
          })
          .onConflictDoUpdate({
            target: [providerLeagueLinks.connectionId, providerLeagueLinks.leagueSeasonId],
            set: {
              currentUserTeamExternalKey: currentUserTeams[0]?.externalId ?? null,
              lastSyncedAt: fetchedAt,
              updatedAt: now,
            },
          });
        const mappedExternalKey = currentUserTeams[0]?.externalId;
        if (mappedExternalKey) {
          const [mappedTeam] = await transaction
            .select({ id: fantasyTeams.id })
            .from(fantasyTeams)
            .where(
              and(
                eq(fantasyTeams.leagueSeasonId, season.id),
                eq(fantasyTeams.externalKey, mappedExternalKey),
              ),
            )
            .limit(1);
          if (mappedTeam) {
            const [conflict] = await transaction
              .select({ userId: leagueMemberships.userId })
              .from(leagueMemberships)
              .where(eq(leagueMemberships.claimedFantasyTeamId, mappedTeam.id))
              .limit(1);
            if (!conflict || conflict.userId === userId) {
              try {
                await transaction.transaction(async (savepoint) => {
                  await savepoint
                    .update(leagueMemberships)
                    .set({ claimedFantasyTeamId: mappedTeam.id, claimedAt: now, updatedAt: now })
                    .where(
                      and(
                        eq(leagueMemberships.leagueId, season.leagueId),
                        eq(leagueMemberships.userId, userId),
                        isNull(leagueMemberships.claimedFantasyTeamId),
                      ),
                    );
                });
              } catch (error) {
                // A historical or concurrent claim conflict must not invalidate a read sync.
                if (!isUniqueViolation(error)) throw error;
              }
            }
          }
        }
        await transaction
          .update(providerConnections)
          .set({
            health: "healthy",
            lastSuccessfulAt: now,
            lastErrorCode: null,
            lastErrorAt: null,
            updatedAt: now,
          })
          .where(eq(providerConnections.id, connectionId));
        return {
          syncRunId: prior.id,
          leagueId: season.leagueId,
          leagueSeasonId: season.id,
          externalLeagueKey: bundle.league.externalId,
          season: bundle.league.season,
          state: "unchanged",
          recordsWritten: prior.recordsWritten,
          syncedAt: fetchedAt.toISOString(),
        };
      }

      const recordsRead =
        bundle.teams.length +
        bundle.teams.reduce((total, team) => total + team.roster.length, 0) +
        (bundle.standings?.entries.length ?? 0) +
        (bundle.matchups?.matchups.length ?? 0);
      const [run] = await transaction
        .insert(syncRuns)
        .values({
          connectionId,
          kind: "yahoo-official-read",
          state: "processing",
          idempotencyKey,
          startedAt: now,
          recordsRead,
          artifactChecksum: checksum,
        })
        .returning({ id: syncRuns.id });
      if (!run) throw new Error("Yahoo sync run could not be created");

      const [existingSeason] = await transaction
        .select()
        .from(leagueSeasons)
        .where(
          and(
            eq(leagueSeasons.provider, "yahoo"),
            eq(leagueSeasons.externalKey, bundle.league.externalId),
            eq(leagueSeasons.season, bundle.league.season),
          ),
        )
        .limit(1);
      let leagueId: string;
      let leagueSeasonId: string;
      let createdLeague = false;
      if (existingSeason) {
        leagueId = existingSeason.leagueId;
        leagueSeasonId = existingSeason.id;
        await transaction
          .update(leagues)
          .set({ name: bundle.league.name, updatedAt: now })
          .where(eq(leagues.id, leagueId));
        await transaction
          .update(leagueSeasons)
          .set({
            connectionId: existingSeason.connectionId ?? connectionId,
            status: bundle.league.currentWeek ? "active" : "preseason",
            teamCount: bundle.league.settings.teamCount,
            draftType: bundle.league.settings.draftType,
            waiverType: bundle.league.settings.waiverType,
            currentWeek: bundle.league.currentWeek,
            settings: plainRecord(bundle.league.settings),
            lastSyncedAt: fetchedAt,
            updatedAt: now,
          })
          .where(eq(leagueSeasons.id, leagueSeasonId));
      } else {
        const [created] = await transaction
          .insert(leagues)
          .values({ ownerUserId: userId, name: bundle.league.name })
          .returning({ id: leagues.id });
        if (!created) throw new Error("Yahoo league could not be created");
        leagueId = created.id;
        createdLeague = true;
        const [season] = await transaction
          .insert(leagueSeasons)
          .values({
            leagueId,
            connectionId,
            provider: "yahoo",
            externalKey: bundle.league.externalId,
            season: bundle.league.season,
            status: bundle.league.currentWeek ? "active" : "preseason",
            teamCount: bundle.league.settings.teamCount,
            draftType: bundle.league.settings.draftType,
            waiverType: bundle.league.settings.waiverType,
            currentWeek: bundle.league.currentWeek,
            settings: plainRecord(bundle.league.settings),
            lastSyncedAt: fetchedAt,
          })
          .returning({ id: leagueSeasons.id });
        if (!season) throw new Error("Yahoo league season could not be created");
        leagueSeasonId = season.id;
      }

      await transaction
        .insert(leagueMemberships)
        .values({ leagueId, userId, role: createdLeague ? "owner" : "manager" })
        .onConflictDoNothing({ target: [leagueMemberships.leagueId, leagueMemberships.userId] });

      await transaction
        .insert(providerLeagueLinks)
        .values({
          connectionId,
          leagueSeasonId,
          currentUserTeamExternalKey: currentUserTeams[0]?.externalId ?? null,
          lastSyncedAt: fetchedAt,
        })
        .onConflictDoUpdate({
          target: [providerLeagueLinks.connectionId, providerLeagueLinks.leagueSeasonId],
          set: {
            currentUserTeamExternalKey: currentUserTeams[0]?.externalId ?? null,
            lastSyncedAt: fetchedAt,
            updatedAt: now,
          },
        });

      await transaction.delete(scoringRules).where(eq(scoringRules.leagueSeasonId, leagueSeasonId));
      if (bundle.league.settings.scoringRules.length > 0) {
        await transaction.insert(scoringRules).values(
          bundle.league.settings.scoringRules.map((rule) => ({
            leagueSeasonId,
            statKey: rule.name ?? rule.statId,
            operation: "multiply",
            points: String(rule.points),
            providerStatId: rule.statId,
          })),
        );
      }
      await transaction
        .delete(rosterSlotRules)
        .where(eq(rosterSlotRules.leagueSeasonId, leagueSeasonId));
      if (bundle.league.settings.rosterSlots.length > 0) {
        await transaction.insert(rosterSlotRules).values(
          bundle.league.settings.rosterSlots.map((slot) => ({
            leagueSeasonId,
            slotCode: slot.position,
            count: slot.count,
            eligiblePositions: slotEligibility(slot.position),
            isStarter: slot.starting,
          })),
        );
      }

      let recordsWritten = 2;
      const teamIds = new Map<string, string>();
      for (const team of bundle.teams) {
        const [storedTeam] = await transaction
          .insert(fantasyTeams)
          .values({
            leagueSeasonId,
            externalKey: team.externalId,
            name: team.name,
            abbreviation: team.abbreviation,
            isUserTeam: false,
            managerDisplayName: team.managers[0]?.displayName ?? null,
          })
          .onConflictDoUpdate({
            target: [fantasyTeams.leagueSeasonId, fantasyTeams.externalKey],
            set: {
              name: team.name,
              abbreviation: team.abbreviation,
              managerDisplayName: team.managers[0]?.displayName ?? null,
              updatedAt: now,
            },
          })
          .returning({ id: fantasyTeams.id });
        if (!storedTeam) throw new Error("Yahoo fantasy team could not be stored");
        teamIds.set(team.externalId, storedTeam.id);
        const [snapshot] = await transaction
          .insert(rosterSnapshots)
          .values({
            teamId: storedTeam.id,
            season: bundle.league.season,
            week: bundle.league.currentWeek,
            effectiveAt: fetchedAt,
            sourceSyncRunId: run.id,
          })
          .returning({ id: rosterSnapshots.id });
        if (!snapshot) throw new Error("Yahoo roster snapshot could not be stored");

        const entries: Array<{
          snapshotId: string;
          playerId: string;
          slotCode: string;
          isStarter: boolean;
        }> = [];
        for (const player of team.roster) {
          const [external] = await transaction
            .select({ playerId: playerExternalIds.playerId })
            .from(playerExternalIds)
            .where(
              and(
                eq(playerExternalIds.source, "yahoo"),
                eq(playerExternalIds.externalId, player.externalId),
              ),
            )
            .limit(1);
          let playerId = external?.playerId;
          if (playerId) {
            await transaction
              .update(players)
              .set({
                fullName: player.fullName,
                nflTeam: player.proTeamAbbreviation,
                primaryPosition: player.primaryPosition,
                eligiblePositions: [...new Set(player.eligiblePositions)],
                status: player.status,
                updatedAt: now,
              })
              .where(eq(players.id, playerId));
          } else {
            const [storedPlayer] = await transaction
              .insert(players)
              .values({
                fullName: player.fullName,
                nflTeam: player.proTeamAbbreviation,
                primaryPosition: player.primaryPosition,
                eligiblePositions: [...new Set(player.eligiblePositions)],
                status: player.status,
              })
              .returning({ id: players.id });
            if (!storedPlayer) throw new Error("Yahoo player could not be stored");
            playerId = storedPlayer.id;
            await transaction.insert(playerExternalIds).values({
              playerId,
              source: "yahoo",
              externalId: player.externalId,
              season: bundle.league.season,
              confidence: "1",
              verified: true,
            });
          }
          entries.push({
            snapshotId: snapshot.id,
            playerId,
            slotCode: player.lineupSlot,
            isStarter: !["BN", "IR", "IR+", "IL", "IL+", "NA"].includes(
              player.lineupSlot.toUpperCase(),
            ),
          });
        }
        if (entries.length > 0) await transaction.insert(rosterEntries).values(entries);
        recordsWritten += 2 + entries.length;
      }

      const mappedTeamId = currentUserTeams[0]
        ? teamIds.get(currentUserTeams[0].externalId)
        : undefined;
      if (mappedTeamId) {
        const [conflict] = await transaction
          .select({ userId: leagueMemberships.userId })
          .from(leagueMemberships)
          .where(eq(leagueMemberships.claimedFantasyTeamId, mappedTeamId))
          .limit(1);
        if (!conflict || conflict.userId === userId) {
          try {
            await transaction.transaction(async (savepoint) => {
              await savepoint
                .update(leagueMemberships)
                .set({ claimedFantasyTeamId: mappedTeamId, claimedAt: now, updatedAt: now })
                .where(
                  and(
                    eq(leagueMemberships.leagueId, leagueId),
                    eq(leagueMemberships.userId, userId),
                    isNull(leagueMemberships.claimedFantasyTeamId),
                  ),
                );
            });
          } catch (error) {
            // Preserve the provider mirror even if an older self-asserted claim owns this team.
            if (!isUniqueViolation(error)) throw error;
          }
        }
      }

      if (bundle.standings) {
        const [snapshot] = await transaction
          .insert(standingsSnapshots)
          .values({
            leagueSeasonId,
            asOfWeek: bundle.standings.asOfWeek,
            effectiveAt: fetchedAt,
            sourceSyncRunId: run.id,
          })
          .returning({ id: standingsSnapshots.id });
        if (!snapshot) throw new Error("Yahoo standings snapshot could not be stored");
        const entries = bundle.standings.entries.map((entry) => {
          const teamId = teamIds.get(entry.teamExternalId);
          if (!teamId) throw new Error("Yahoo standings referenced an unstored team");
          return {
            snapshotId: snapshot.id,
            teamId,
            providerTeamId: entry.providerTeamId,
            rank: entry.rank,
            playoffSeed: entry.playoffSeed,
            wins: entry.wins,
            losses: entry.losses,
            ties: entry.ties,
            pointsFor: String(entry.pointsFor),
            pointsAgainst: String(entry.pointsAgainst),
            streakType: entry.streakType,
            streakLength: entry.streakLength,
          };
        });
        if (entries.length > 0) await transaction.insert(standingsEntries).values(entries);
        recordsWritten += 1 + entries.length;
      }

      if (bundle.matchups) {
        const [snapshot] = await transaction
          .insert(matchupSnapshots)
          .values({
            leagueSeasonId,
            asOfWeek: bundle.matchups.asOfWeek,
            effectiveAt: fetchedAt,
            sourceSyncRunId: run.id,
          })
          .returning({ id: matchupSnapshots.id });
        if (!snapshot) throw new Error("Yahoo matchup snapshot could not be stored");
        const matchups = bundle.matchups.matchups.map((matchup) => {
          const homeTeamId = teamIds.get(matchup.home.teamExternalId);
          const awayTeamId = teamIds.get(matchup.away.teamExternalId);
          const winnerTeamId = matchup.winnerTeamExternalId
            ? teamIds.get(matchup.winnerTeamExternalId)
            : undefined;
          if (!homeTeamId || !awayTeamId || (matchup.winnerTeamExternalId && !winnerTeamId)) {
            throw new Error("Yahoo matchup referenced an unstored team");
          }
          return {
            snapshotId: snapshot.id,
            externalKey: matchup.externalId,
            providerMatchupId: matchup.providerMatchupId,
            week: matchup.week,
            status: matchup.status,
            homeTeamId,
            awayTeamId,
            homeProviderTeamId: matchup.home.providerTeamId,
            awayProviderTeamId: matchup.away.providerTeamId,
            homeScore: matchup.home.score === null ? null : String(matchup.home.score),
            awayScore: matchup.away.score === null ? null : String(matchup.away.score),
            winnerTeamId: winnerTeamId ?? null,
            tied: matchup.tied,
          };
        });
        if (matchups.length > 0) await transaction.insert(weeklyMatchups).values(matchups);
        recordsWritten += 1 + matchups.length;
      }

      await transaction
        .update(syncRuns)
        .set({
          leagueSeasonId,
          state: "succeeded",
          finishedAt: now,
          recordsWritten,
        })
        .where(eq(syncRuns.id, run.id));
      await transaction
        .update(providerConnections)
        .set({
          health: "healthy",
          lastSuccessfulAt: now,
          lastErrorCode: null,
          lastErrorAt: null,
          updatedAt: now,
        })
        .where(eq(providerConnections.id, connectionId));

      return {
        syncRunId: run.id,
        leagueId,
        leagueSeasonId,
        externalLeagueKey: bundle.league.externalId,
        season: bundle.league.season,
        state: "accepted",
        recordsWritten,
        syncedAt: fetchedAt.toISOString(),
      };
    });
  }
}

export class YahooSyncService {
  readonly #repository: YahooSyncRepository;
  readonly #tokens: YahooAccessTokenPort;
  readonly #client: YahooReadPort;
  readonly #now: () => Date;
  readonly #pageSize: number;

  constructor(input: {
    readonly repository: YahooSyncRepository;
    readonly tokens: YahooAccessTokenPort;
    readonly client?: YahooReadPort;
    readonly now?: () => Date;
    readonly pageSize?: number;
  }) {
    this.#repository = input.repository;
    this.#tokens = input.tokens;
    this.#client = input.client ?? new YahooFantasyReadClient();
    this.#now = input.now ?? (() => new Date());
    this.#pageSize = input.pageSize ?? DEFAULT_PAGE_SIZE;
    if (!Number.isSafeInteger(this.#pageSize) || this.#pageSize < 1 || this.#pageSize > 100) {
      throw new TypeError("Yahoo discovery page size must be between 1 and 100");
    }
  }

  listConnections(userId: string): Promise<readonly YahooConnectionStatus[]> {
    return this.#repository.listConnectionStatus(userId);
  }

  async disconnectConnection(
    userId: string,
    connectionId: string,
    correlationId: string,
  ): Promise<void> {
    try {
      await this.#repository.disconnectOwnedConnection({
        userId,
        connectionId,
        correlationId,
        disconnectedAt: this.#now(),
      });
    } catch {
      throw new YahooSyncError(
        "LOCAL_DISCONNECT_FAILED",
        "The stored Yahoo authorization could not be removed from Laces Out",
      );
    }
  }

  async discoverAndSync(userId: string, connectionId: string): Promise<YahooDiscoveryResult> {
    const connection = await this.#repository.findOwnedConnection(userId, connectionId);
    if (!connection) {
      throw new YahooSyncError("CONNECTION_NOT_FOUND", "Yahoo connection was not found");
    }
    try {
      const discovered = await this.#discover(userId, connectionId);
      const syncs: YahooSyncReceipt[] = [];
      for (const league of discovered) {
        syncs.push(await this.#syncLeague(userId, connectionId, league.externalId, league));
      }
      return {
        connectionId,
        discovered,
        syncs,
        generatedAt: this.#now().toISOString(),
      };
    } catch (error) {
      await this.#repository.markFailure(userId, connectionId, failureCode(error), this.#now());
      throw clientFacingSyncError(error);
    }
  }

  async syncLeague(
    userId: string,
    connectionId: string,
    leagueKey: string,
  ): Promise<YahooSyncReceipt> {
    const connection = await this.#repository.findOwnedConnection(userId, connectionId);
    if (!connection) {
      throw new YahooSyncError("CONNECTION_NOT_FOUND", "Yahoo connection was not found");
    }
    if (!/^(?:[a-z][a-z0-9-]{0,15}|[0-9]{1,10})\.l\.[0-9]{1,20}$/u.test(leagueKey)) {
      throw new TypeError("Yahoo league key is invalid");
    }
    try {
      return await this.#syncLeague(userId, connectionId, leagueKey);
    } catch (error) {
      await this.#repository.markFailure(userId, connectionId, failureCode(error), this.#now());
      throw clientFacingSyncError(error);
    }
  }

  async #withToken<T>(
    userId: string,
    connectionId: string,
    read: (accessToken: string) => Promise<T>,
  ): Promise<T> {
    let accessToken = await this.#tokens.getAccessToken(userId, connectionId);
    try {
      return await read(accessToken);
    } catch (error) {
      if (!(error instanceof YahooReadClientError) || !error.refreshAccessToken) throw error;
      accessToken = await this.#tokens.getAccessToken(userId, connectionId, {
        forceRefresh: true,
      });
      return read(accessToken);
    }
  }

  async #discover(userId: string, connectionId: string): Promise<readonly ExternalLeagueRef[]> {
    const leagues = new Map<string, ExternalLeagueRef>();
    let start = 0;
    for (let pageNumber = 0; pageNumber < MAX_DISCOVERY_PAGES; pageNumber += 1) {
      const artifact = await this.#withToken(userId, connectionId, (accessToken) =>
        this.#client.getUserLeagues(
          { accessToken },
          { gameKeys: ["nfl"], start, count: this.#pageSize },
        ),
      );
      const page = parseYahooLeaguePageXml(artifact.xml);
      for (const league of page.leagues) {
        const existing = leagues.get(league.externalId);
        if (existing && JSON.stringify(existing) !== JSON.stringify(league)) {
          throw new YahooSyncError("DUPLICATE_LEAGUE", "Yahoo returned conflicting league records");
        }
        leagues.set(league.externalId, league);
      }
      if (leagues.size > MAX_DISCOVERED_LEAGUES) {
        throw new YahooSyncError(
          "DISCOVERY_LIMIT",
          "Yahoo league discovery exceeded its safety limit",
        );
      }
      if (page.returned < this.#pageSize) return [...leagues.values()];
      start += page.returned;
    }
    throw new YahooSyncError("DISCOVERY_LIMIT", "Yahoo league discovery did not terminate");
  }

  async #syncLeague(
    userId: string,
    connectionId: string,
    leagueKey: string,
    expectedLeague?: ExternalLeagueRef,
  ): Promise<YahooSyncReceipt> {
    const artifacts = await this.#withToken(userId, connectionId, async (accessToken) => {
      const request = { accessToken };
      const [settings, teams, rosters, standings, matchups] = await Promise.all([
        this.#client.getLeagueSettings(request, leagueKey),
        this.#client.getLeagueTeams(request, leagueKey),
        this.#client.getLeagueRosters(request, leagueKey),
        this.#client.getLeagueStandings(request, leagueKey),
        this.#client.getLeagueMatchups(request, leagueKey),
      ]);
      return { settings, teams, rosters, standings, matchups };
    });
    const fetchedAt = this.#now();
    const bundle = parseYahooLeagueSyncArtifacts({
      settingsXml: artifacts.settings.xml,
      teamsXml: artifacts.teams.xml,
      rostersXml: artifacts.rosters.xml,
      standingsXml: artifacts.standings.xml,
      matchupsXml: artifacts.matchups.xml,
      fetchedAt,
      endpoint: `https://fantasysports.yahooapis.com/fantasy/v2/league/${leagueKey}`,
    });
    if (
      bundle.league.externalId !== leagueKey ||
      (expectedLeague !== undefined && bundle.league.season !== expectedLeague.season)
    ) {
      throw new YahooSyncError("PROVIDER_READ_FAILED", "Yahoo league metadata changed during sync");
    }
    try {
      return await this.#repository.persistBundle(userId, connectionId, bundle);
    } catch (error) {
      if (error instanceof YahooSyncError) throw error;
      throw new YahooSyncError("PERSISTENCE_FAILED", "Yahoo league data could not be committed");
    }
  }
}

export type YahooSyncPort = Pick<
  YahooSyncService,
  "listConnections" | "disconnectConnection" | "discoverAndSync" | "syncLeague"
>;
