import type {
  LeagueSupplementalBundle,
  LeagueSyncBundle,
  NormalizedRosterPlayer,
} from "@fantasy/connectors";
import {
  bridgeDeviceLeagues,
  bridgeDevices,
  fantasyTeams,
  leagueSupplementalSnapshots,
  leagueMemberships,
  leagues,
  leagueSeasons,
  matchupSnapshots,
  playerExternalIds,
  players,
  rosterEntries,
  rosterSlotRules,
  rosterSnapshots,
  scoringRules,
  standingsEntries,
  standingsSnapshots,
  syncRuns,
  weeklyMatchups,
  type Database,
  type LeagueMembershipRole,
} from "@fantasy/db";
import { and, eq, sql } from "drizzle-orm";

export type EspnSyncAuthority = {
  readonly mode: "bridge";
  readonly actorUserId: string;
  readonly bridgeDeviceId: string;
  readonly bridgeScopeId: string;
};

export interface PersistEspnSyncInput {
  readonly authority: EspnSyncAuthority;
  readonly bundle: LeagueSyncBundle;
  readonly checksumSha256: string;
  readonly effectiveAt: Date;
  readonly idempotencyKey: string;
  readonly kind: "espn-bridge";
  readonly now: Date;
}

export interface PersistEspnSyncReceipt {
  readonly receiptId: string;
  readonly leagueId: string;
  readonly leagueSeasonId: string;
  readonly recordsWritten: number;
  readonly state: "accepted" | "unchanged";
}

export interface PersistEspnSupplementalInput {
  readonly authority: EspnSyncAuthority;
  readonly bundle: LeagueSupplementalBundle;
  readonly checksumSha256: string;
  readonly effectiveAt: Date;
  readonly idempotencyKey: string;
  readonly now: Date;
}

export interface PersistEspnSupplementalReceipt {
  readonly receiptId: string;
  readonly leagueSeasonId: string;
  readonly recordsWritten: number;
  readonly state: "accepted" | "unchanged";
}

export const ESPN_SELF_ASSERTED_PLAYER_SOURCE = "espn-self-asserted";

export class EspnSyncPersistenceError extends Error {
  readonly code = "STALE_SNAPSHOT";
  readonly statusCode = 409;

  constructor() {
    super("A newer ESPN snapshot is already stored for this league");
    this.name = "EspnSyncPersistenceError";
  }
}

/**
 * A successful provider connection is the league-join mechanism. The first bridge import
 * bootstraps an owner membership, a later connector joins as a manager, and existing members keep
 * their role. Merely configuring a league ID grants nothing; this policy runs only after the bridge
 * token, scope, freshness, checksum, and strict ESPN payload have all been validated.
 */
export function espnRefreshPolicy(input: {
  readonly createdLeague: boolean;
  readonly actorIsAnchoredOwner: boolean;
  readonly existingMembershipRole: LeagueMembershipRole | null;
}): { readonly membershipGrant: "owner" | "manager" | null } {
  if (input.createdLeague || input.actorIsAnchoredOwner) {
    return { membershipGrant: "owner" };
  }
  return { membershipGrant: input.existingMembershipRole === null ? "manager" : null };
}

/** Self-asserted provider observations are isolated to one internal league season. */
export function espnSelfAssertedPlayerKey(
  leagueSeasonId: string,
  providerPlayerId: string,
): string {
  return `${leagueSeasonId}:${providerPlayerId}`;
}

/** A global ESPN crosswalk is canonical only after a trusted catalog source verifies it. */
export function trustedEspnPlayerId(
  mapping:
    | { readonly playerId: string; readonly verified: boolean; readonly gsisId: string | null }
    | undefined,
): string | undefined {
  return mapping?.verified && mapping.gsisId ? mapping.playerId : undefined;
}

/**
 * The shared player table currently backs roster foreign keys. Self-asserted fields are retained
 * only on a league-season-scoped observation row, which catalog queries must exclude.
 */
export function espnSelfAssertedPlayerIdentity(player: NormalizedRosterPlayer): {
  readonly fullName: string;
  readonly nflTeam: string | null;
  readonly primaryPosition: string;
  readonly eligiblePositions: string[];
  readonly status: string | null;
} {
  return {
    fullName: player.fullName,
    nflTeam: player.proTeamAbbreviation,
    primaryPosition: player.primaryPosition,
    eligiblePositions: [...new Set(player.eligiblePositions)],
    status: player.status,
  };
}

/** Exclude league-scoped ESPN observations from every unscoped player catalog. */
export function unscopedPlayerCatalogFilter() {
  return sql<boolean>`not exists (
    select 1
    from ${playerExternalIds}
    where ${playerExternalIds.playerId} = ${players.id}
      and ${playerExternalIds.source} = ${ESPN_SELF_ASSERTED_PLAYER_SOURCE}
  )`;
}

/** Include self-asserted ESPN observations only inside their own league-season workflow. */
export function leagueScopedPlayerCatalogFilter(leagueSeasonId: string) {
  const observationPrefix = `${leagueSeasonId}:%`;
  return sql<boolean>`(
    ${unscopedPlayerCatalogFilter()}
    or exists (
      select 1
      from ${playerExternalIds}
      where ${playerExternalIds.playerId} = ${players.id}
        and ${playerExternalIds.source} = ${ESPN_SELF_ASSERTED_PLAYER_SOURCE}
        and ${playerExternalIds.externalId} like ${observationPrefix}
    )
  )`;
}

function plainRecord(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function slotEligibility(slotCode: string): string[] {
  const normalized = slotCode.toUpperCase();
  if (["FLEX", "RB/WR/TE"].includes(normalized)) return ["RB", "WR", "TE"];
  if (["OP", "SUPER_FLEX", "QB/RB/WR/TE"].includes(normalized)) {
    return ["QB", "RB", "WR", "TE"];
  }
  if (normalized === "RB/WR") return ["RB", "WR"];
  if (normalized === "WR/TE") return ["WR", "TE"];
  return [slotCode];
}

/**
 * Canonical ESPN persistence for the browser bridge. Every mutation for one snapshot is
 * deliberately enclosed in one database transaction.
 */
export class DrizzleEspnSyncPersistence {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  async persistSupplemental(
    input: PersistEspnSupplementalInput,
  ): Promise<PersistEspnSupplementalReceipt> {
    const { authority, bundle, effectiveAt, now } = input;
    if (bundle.provider !== "espn") {
      throw new Error("Canonical ESPN supplemental persistence received another provider");
    }

    return this.#database.transaction(async (transaction) => {
      const lockKey = `espn:${bundle.providerLeagueId}:${bundle.season}`;
      await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);

      const [season] = await transaction
        .select({ id: leagueSeasons.id, leagueId: leagueSeasons.leagueId })
        .from(leagueSeasons)
        .where(
          and(
            eq(leagueSeasons.provider, "espn"),
            eq(leagueSeasons.externalKey, bundle.providerLeagueId),
            eq(leagueSeasons.season, bundle.season),
          ),
        )
        .limit(1);
      if (!season) {
        throw new Error("The core ESPN league snapshot must be stored before supplemental data");
      }

      const [scope] = await transaction
        .select({ leagueId: bridgeDeviceLeagues.leagueId })
        .from(bridgeDeviceLeagues)
        .where(eq(bridgeDeviceLeagues.id, authority.bridgeScopeId))
        .limit(1);
      if (scope?.leagueId !== season.leagueId) {
        throw new Error("ESPN supplemental data did not match the bridge league scope");
      }

      const [prior] = await transaction
        .select({
          id: syncRuns.id,
          leagueSeasonId: syncRuns.leagueSeasonId,
          recordsWritten: syncRuns.recordsWritten,
          state: syncRuns.state,
        })
        .from(syncRuns)
        .where(eq(syncRuns.idempotencyKey, input.idempotencyKey))
        .limit(1);
      if (prior) {
        if (prior.leagueSeasonId !== season.id || prior.state !== "succeeded") {
          throw new Error("Idempotent ESPN supplemental receipt is not a completed artifact");
        }
        await transaction
          .update(bridgeDevices)
          .set({ lastSeenAt: now })
          .where(eq(bridgeDevices.id, authority.bridgeDeviceId));
        return {
          receiptId: prior.id,
          leagueSeasonId: season.id,
          recordsWritten: prior.recordsWritten,
          state: "unchanged",
        };
      }

      const recordsRead =
        bundle.kind === "available-players"
          ? bundle.players.length
          : bundle.kind === "weekly-box-scores"
            ? bundle.matchups.length + bundle.playerScores.length
            : bundle.kind === "transactions"
              ? bundle.transactions.length +
                bundle.transactions.reduce(
                  (count, transaction) => count + transaction.items.length,
                  0,
                )
              : bundle.picks.length;
      const [run] = await transaction
        .insert(syncRuns)
        .values({
          leagueSeasonId: season.id,
          kind: `espn-supplemental:${bundle.kind}`,
          state: "processing",
          idempotencyKey: input.idempotencyKey,
          startedAt: now,
          recordsRead,
          artifactChecksum: input.checksumSha256,
        })
        .returning({ id: syncRuns.id });
      if (!run) throw new Error("ESPN supplemental sync receipt could not be created");

      const asOfWeek =
        bundle.kind === "available-players"
          ? bundle.asOfWeek
          : bundle.kind === "completed-draft"
            ? null
            : bundle.week;
      await transaction.insert(leagueSupplementalSnapshots).values({
        leagueSeasonId: season.id,
        kind: bundle.kind,
        asOfWeek,
        availability: bundle.kind === "available-players" ? bundle.availability : null,
        effectiveAt,
        sourceSyncRunId: run.id,
        bridgeDeviceId: authority.bridgeDeviceId,
        endpoint: bundle.provenance.endpoint ?? "https://lm-api-reads.fantasy.espn.com",
        artifactChecksum: input.checksumSha256,
        artifact: plainRecord(bundle),
        warnings: [...bundle.warnings],
      });

      const recordsWritten = 2;
      await transaction
        .update(syncRuns)
        .set({
          state: "succeeded",
          finishedAt: now,
          recordsWritten,
        })
        .where(eq(syncRuns.id, run.id));
      await transaction
        .update(bridgeDevices)
        .set({ lastSeenAt: now })
        .where(eq(bridgeDevices.id, authority.bridgeDeviceId));
      return {
        receiptId: run.id,
        leagueSeasonId: season.id,
        recordsWritten,
        state: "accepted",
      };
    });
  }

  async persist(input: PersistEspnSyncInput): Promise<PersistEspnSyncReceipt> {
    const { authority, bundle, effectiveAt, now } = input;
    if (bundle.provider !== "espn" || bundle.league.provider !== "espn") {
      throw new Error("Canonical ESPN persistence received another provider's bundle");
    }

    return this.#database.transaction(async (transaction) => {
      // Serialize all write paths for one provider league/season. This closes the race where
      // two first imports could otherwise both try to create the globally unique season row.
      const lockKey = `espn:${bundle.league.providerLeagueId}:${bundle.league.season}`;
      await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);

      const [existingSeason] = await transaction
        .select()
        .from(leagueSeasons)
        .where(
          and(
            eq(leagueSeasons.provider, "espn"),
            eq(leagueSeasons.externalKey, bundle.league.providerLeagueId),
            eq(leagueSeasons.season, bundle.league.season),
          ),
        )
        .limit(1);

      let actorIsAnchoredOwner = false;
      let actorExistingMembershipRole: LeagueMembershipRole | null = null;
      if (existingSeason) {
        const [access] = await transaction
          .select({
            ownerUserId: leagues.ownerUserId,
            membershipRole: leagueMemberships.role,
          })
          .from(leagues)
          .leftJoin(
            leagueMemberships,
            and(
              eq(leagueMemberships.leagueId, leagues.id),
              eq(leagueMemberships.userId, authority.actorUserId),
            ),
          )
          .where(eq(leagues.id, existingSeason.leagueId))
          .limit(1);
        actorIsAnchoredOwner = access?.ownerUserId === authority.actorUserId;
        actorExistingMembershipRole = access?.membershipRole ?? null;
        if (existingSeason.lastSyncedAt && effectiveAt < existingSeason.lastSyncedAt) {
          throw new EspnSyncPersistenceError();
        }
      }

      const [prior] = await transaction
        .select({
          id: syncRuns.id,
          leagueSeasonId: syncRuns.leagueSeasonId,
          recordsWritten: syncRuns.recordsWritten,
          state: syncRuns.state,
        })
        .from(syncRuns)
        .where(eq(syncRuns.idempotencyKey, input.idempotencyKey))
        .limit(1);
      if (prior) {
        if (!prior.leagueSeasonId || prior.state !== "succeeded") {
          throw new Error("Idempotent ESPN sync receipt is not a completed league snapshot");
        }
        const [season] = await transaction
          .select({ id: leagueSeasons.id, leagueId: leagueSeasons.leagueId })
          .from(leagueSeasons)
          .where(eq(leagueSeasons.id, prior.leagueSeasonId))
          .limit(1);
        if (!season) throw new Error("Idempotent ESPN sync referenced a missing league season");

        // The freshness guard above makes this monotonic. An unchanged recapture still proves that
        // the stored provider data was checked again, so advance freshness without duplicating rows.
        await transaction
          .update(leagueSeasons)
          .set({ lastSyncedAt: effectiveAt, updatedAt: now })
          .where(eq(leagueSeasons.id, season.id));
        await transaction
          .update(bridgeDeviceLeagues)
          .set({ leagueId: season.leagueId, season: bundle.league.season })
          .where(eq(bridgeDeviceLeagues.id, authority.bridgeScopeId));
        await transaction
          .update(bridgeDevices)
          .set({ lastSeenAt: now })
          .where(eq(bridgeDevices.id, authority.bridgeDeviceId));
        return {
          receiptId: prior.id,
          leagueId: season.leagueId,
          leagueSeasonId: season.id,
          recordsWritten: prior.recordsWritten,
          state: "unchanged",
        };
      }

      const recordsRead =
        bundle.teams.length +
        bundle.teams.reduce((count, team) => count + team.roster.length, 0) +
        (bundle.standings?.entries.length ?? 0) +
        (bundle.matchups?.matchups.length ?? 0);
      const [run] = await transaction
        .insert(syncRuns)
        .values({
          kind: input.kind,
          state: "processing",
          idempotencyKey: input.idempotencyKey,
          startedAt: now,
          recordsRead,
          artifactChecksum: input.checksumSha256,
        })
        .returning({ id: syncRuns.id });
      if (!run) throw new Error("ESPN sync receipt could not be created");

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
            status: bundle.league.currentWeek ? "active" : "preseason",
            teamCount: bundle.league.settings.teamCount,
            draftType: bundle.league.settings.draftType,
            waiverType: bundle.league.settings.waiverType,
            currentWeek: bundle.league.currentWeek,
            settings: plainRecord(bundle.league.settings),
            lastSyncedAt: effectiveAt,
            updatedAt: now,
          })
          .where(eq(leagueSeasons.id, leagueSeasonId));
      } else {
        const [created] = await transaction
          .insert(leagues)
          .values({ ownerUserId: authority.actorUserId, name: bundle.league.name })
          .returning({ id: leagues.id });
        if (!created) throw new Error("ESPN league could not be created");
        leagueId = created.id;
        createdLeague = true;
        const [season] = await transaction
          .insert(leagueSeasons)
          .values({
            leagueId,
            provider: "espn",
            externalKey: bundle.league.providerLeagueId,
            season: bundle.league.season,
            status: bundle.league.currentWeek ? "active" : "preseason",
            teamCount: bundle.league.settings.teamCount,
            draftType: bundle.league.settings.draftType,
            waiverType: bundle.league.settings.waiverType,
            currentWeek: bundle.league.currentWeek,
            settings: plainRecord(bundle.league.settings),
            lastSyncedAt: effectiveAt,
          })
          .returning({ id: leagueSeasons.id });
        if (!season) throw new Error("ESPN league season could not be created");
        leagueSeasonId = season.id;
      }

      const membershipGrant = espnRefreshPolicy({
        createdLeague,
        actorIsAnchoredOwner,
        existingMembershipRole: actorExistingMembershipRole,
      }).membershipGrant;
      if (membershipGrant !== null) {
        await transaction
          .insert(leagueMemberships)
          .values({
            leagueId,
            userId: authority.actorUserId,
            role: membershipGrant,
          })
          .onConflictDoNothing({
            target: [leagueMemberships.leagueId, leagueMemberships.userId],
          });
      }
      await transaction
        .update(bridgeDeviceLeagues)
        .set({ leagueId, season: bundle.league.season })
        .where(eq(bridgeDeviceLeagues.id, authority.bridgeScopeId));

      // League settings are a complete snapshot. Delete-and-reinsert is safe because the
      // surrounding transaction preserves the prior rules if any later write fails.
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
      const storedTeamIds = new Map<string, string>();
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
            faabRemaining: team.faabRemaining ?? null,
            waiverPriority: team.waiverPriority ?? null,
          })
          .onConflictDoUpdate({
            target: [fantasyTeams.leagueSeasonId, fantasyTeams.externalKey],
            set: {
              name: team.name,
              abbreviation: team.abbreviation,
              managerDisplayName: team.managers[0]?.displayName ?? null,
              faabRemaining: team.faabRemaining ?? null,
              waiverPriority: team.waiverPriority ?? null,
              updatedAt: now,
            },
          })
          .returning({ id: fantasyTeams.id });
        if (!storedTeam) throw new Error("ESPN fantasy team could not be stored");
        storedTeamIds.set(team.externalId, storedTeam.id);
        const [roster] = await transaction
          .insert(rosterSnapshots)
          .values({
            teamId: storedTeam.id,
            season: bundle.league.season,
            week: bundle.league.currentWeek,
            effectiveAt,
            sourceSyncRunId: run.id,
          })
          .returning({ id: rosterSnapshots.id });
        if (!roster) throw new Error("ESPN roster snapshot could not be stored");

        const entries: Array<{
          snapshotId: string;
          playerId: string;
          slotCode: string;
          isStarter: boolean;
        }> = [];
        for (const player of team.roster) {
          const [external] = await transaction
            .select({
              playerId: playerExternalIds.playerId,
              verified: playerExternalIds.verified,
              gsisId: players.gsisId,
            })
            .from(playerExternalIds)
            .innerJoin(players, eq(playerExternalIds.playerId, players.id))
            .where(
              and(
                eq(playerExternalIds.source, "espn"),
                eq(playerExternalIds.externalId, player.providerPlayerId),
              ),
            )
            .limit(1);
          let playerId = trustedEspnPlayerId(external);
          if (!playerId) {
            const observationKey = espnSelfAssertedPlayerKey(
              leagueSeasonId,
              player.providerPlayerId,
            );
            const [observation] = await transaction
              .select({ playerId: playerExternalIds.playerId })
              .from(playerExternalIds)
              .where(
                and(
                  eq(playerExternalIds.source, ESPN_SELF_ASSERTED_PLAYER_SOURCE),
                  eq(playerExternalIds.externalId, observationKey),
                ),
              )
              .limit(1);
            playerId = observation?.playerId;
            if (playerId) {
              await transaction
                .update(players)
                .set({ ...espnSelfAssertedPlayerIdentity(player), updatedAt: now })
                .where(eq(players.id, playerId));
            } else {
              const [storedPlayer] = await transaction
                .insert(players)
                .values(espnSelfAssertedPlayerIdentity(player))
                .returning({ id: players.id });
              if (!storedPlayer) throw new Error("ESPN player could not be stored");
              playerId = storedPlayer.id;
              await transaction.insert(playerExternalIds).values({
                playerId,
                source: ESPN_SELF_ASSERTED_PLAYER_SOURCE,
                externalId: observationKey,
                season: bundle.league.season,
                confidence: "0",
                verified: false,
              });
            }
          }
          entries.push({
            snapshotId: roster.id,
            playerId,
            slotCode: player.lineupSlot,
            isStarter: !["BE", "BN", "IR", "RES", "TAXI"].includes(player.lineupSlot.toUpperCase()),
          });
        }
        if (entries.length > 0) await transaction.insert(rosterEntries).values(entries);
        recordsWritten += 2 + entries.length;
      }

      if (bundle.standings !== undefined) {
        const [standingsSnapshot] = await transaction
          .insert(standingsSnapshots)
          .values({
            leagueSeasonId,
            asOfWeek: bundle.standings.asOfWeek,
            effectiveAt,
            sourceSyncRunId: run.id,
          })
          .returning({ id: standingsSnapshots.id });
        if (!standingsSnapshot) throw new Error("ESPN standings snapshot could not be stored");
        const rows = bundle.standings.entries.map((entry) => {
          const teamId = storedTeamIds.get(entry.teamExternalId);
          if (!teamId) throw new Error("ESPN standings referenced an unstored fantasy team");
          return {
            snapshotId: standingsSnapshot.id,
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
        if (rows.length > 0) await transaction.insert(standingsEntries).values(rows);
        recordsWritten += 1 + rows.length;
      }

      if (bundle.matchups !== undefined) {
        const [matchupSnapshot] = await transaction
          .insert(matchupSnapshots)
          .values({
            leagueSeasonId,
            asOfWeek: bundle.matchups.asOfWeek,
            effectiveAt,
            sourceSyncRunId: run.id,
          })
          .returning({ id: matchupSnapshots.id });
        if (!matchupSnapshot) throw new Error("ESPN matchup snapshot could not be stored");
        const rows = bundle.matchups.matchups.map((matchup) => {
          const homeTeamId = storedTeamIds.get(matchup.home.teamExternalId);
          const awayTeamId = storedTeamIds.get(matchup.away.teamExternalId);
          const winnerTeamId =
            matchup.winnerTeamExternalId === null
              ? null
              : storedTeamIds.get(matchup.winnerTeamExternalId);
          if (!homeTeamId || !awayTeamId) {
            throw new Error("ESPN matchup referenced an unstored fantasy team");
          }
          if (matchup.winnerTeamExternalId !== null && !winnerTeamId) {
            throw new Error("ESPN matchup winner referenced an unstored fantasy team");
          }
          return {
            snapshotId: matchupSnapshot.id,
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
        if (rows.length > 0) await transaction.insert(weeklyMatchups).values(rows);
        recordsWritten += 1 + rows.length;
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
      if (authority.mode === "bridge") {
        await transaction
          .update(bridgeDevices)
          .set({ lastSeenAt: now })
          .where(eq(bridgeDevices.id, authority.bridgeDeviceId));
      }

      return {
        receiptId: run.id,
        leagueId,
        leagueSeasonId,
        recordsWritten,
        state: "accepted" as const,
      };
    });
  }
}
