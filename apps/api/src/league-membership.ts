import type { LeagueRemovalResponse } from "@laces-out/contracts";
import {
  auditEvents,
  bridgeDeviceLeagues,
  bridgeDevices,
  leagueMemberships,
  leagues,
  leagueSeasons,
  leagueSyncExclusions,
  providerConnections,
  providerLeagueLinks,
  userPreferences,
  type Database,
  type LeagueMembershipRole,
} from "@laces-out/db";
import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";

interface LeagueSeasonIdentity {
  readonly id: string;
  readonly provider: "yahoo" | "espn" | "manual";
  readonly externalKey: string;
  readonly season: number;
  readonly connectionId: string | null;
}

export type RemoveLeagueResult =
  | { readonly outcome: "not-found" }
  | { readonly outcome: "confirmation-mismatch" }
  | { readonly outcome: "removed"; readonly response: LeagueRemovalResponse };

function successorRoleOrder(role: LeagueMembershipRole): number {
  if (role === "commissioner") return 0;
  if (role === "member") return 1;
  return 2;
}

/**
 * Removes one member's league access without treating shared provider data as that member's data.
 * Provider links, bridge scopes, membership, default selection, and re-enrollment protection are
 * committed together so a failed request cannot leave a half-detached league behind.
 */
export class LeagueMembershipService {
  readonly #database: Database;
  readonly #now: () => Date;

  constructor(database: Database, now: () => Date = () => new Date()) {
    this.#database = database;
    this.#now = now;
  }

  async removeLeague(input: {
    readonly userId: string;
    readonly leagueId: string;
    readonly confirmation: string;
    readonly correlationId: string;
  }): Promise<RemoveLeagueResult> {
    const removedAt = this.#now();
    return this.#database.transaction(async (transaction) => {
      const [league] = await transaction
        .select({ id: leagues.id, name: leagues.name, ownerUserId: leagues.ownerUserId })
        .from(leagues)
        .innerJoin(
          leagueMemberships,
          and(
            eq(leagueMemberships.leagueId, leagues.id),
            eq(leagueMemberships.userId, input.userId),
          ),
        )
        .where(eq(leagues.id, input.leagueId))
        .limit(1)
        .for("update");
      if (!league) return { outcome: "not-found" };
      if (input.confirmation !== league.name) return { outcome: "confirmation-mismatch" };

      const seasons: readonly LeagueSeasonIdentity[] = await transaction
        .select({
          id: leagueSeasons.id,
          provider: leagueSeasons.provider,
          externalKey: leagueSeasons.externalKey,
          season: leagueSeasons.season,
          connectionId: leagueSeasons.connectionId,
        })
        .from(leagueSeasons)
        .where(eq(leagueSeasons.leagueId, league.id))
        .orderBy(asc(leagueSeasons.season), asc(leagueSeasons.id))
        .for("update");
      const syncedSeasons = seasons.filter(
        (season): season is LeagueSeasonIdentity & { provider: "yahoo" | "espn" } =>
          season.provider === "yahoo" || season.provider === "espn",
      );
      if (syncedSeasons.length > 0) {
        await transaction
          .insert(leagueSyncExclusions)
          .values(
            syncedSeasons.map((season) => ({
              userId: input.userId,
              provider: season.provider,
              externalKey: season.externalKey,
              season: season.season,
              removedAt,
            })),
          )
          .onConflictDoUpdate({
            target: [
              leagueSyncExclusions.userId,
              leagueSyncExclusions.provider,
              leagueSyncExclusions.externalKey,
              leagueSyncExclusions.season,
            ],
            set: { removedAt },
          });
      }

      const connections = await transaction
        .select({ id: providerConnections.id })
        .from(providerConnections)
        .where(eq(providerConnections.userId, input.userId));
      const connectionIds = connections.map((connection) => connection.id);
      const seasonIds = seasons.map((season) => season.id);
      if (connectionIds.length > 0 && seasonIds.length > 0) {
        await transaction
          .delete(providerLeagueLinks)
          .where(
            and(
              inArray(providerLeagueLinks.connectionId, connectionIds),
              inArray(providerLeagueLinks.leagueSeasonId, seasonIds),
            ),
          );

        // `league_seasons.connection_id` is only the preferred source. If it belonged to the
        // departing member, retain another surviving member's linked connection when one exists.
        for (const season of seasons) {
          if (!season.connectionId || !connectionIds.includes(season.connectionId)) continue;
          const [replacement] = await transaction
            .select({ connectionId: providerLeagueLinks.connectionId })
            .from(providerLeagueLinks)
            .where(eq(providerLeagueLinks.leagueSeasonId, season.id))
            .orderBy(asc(providerLeagueLinks.connectionId))
            .limit(1);
          await transaction
            .update(leagueSeasons)
            .set({ connectionId: replacement?.connectionId ?? null, updatedAt: removedAt })
            .where(eq(leagueSeasons.id, season.id));
        }
      }

      const devices = await transaction
        .select({ id: bridgeDevices.id })
        .from(bridgeDevices)
        .where(eq(bridgeDevices.userId, input.userId));
      const deviceIds = devices.map((device) => device.id);
      if (deviceIds.length > 0) {
        // Delete both already-linked scopes and a still-unlinked scope for the same ESPN season.
        // The latter matters when removal races the bridge's first accepted snapshot.
        await transaction
          .delete(bridgeDeviceLeagues)
          .where(
            and(
              inArray(bridgeDeviceLeagues.bridgeDeviceId, deviceIds),
              or(
                eq(bridgeDeviceLeagues.leagueId, league.id),
                ...syncedSeasons
                  .filter((season) => season.provider === "espn")
                  .map((season) =>
                    and(
                      eq(bridgeDeviceLeagues.externalLeagueId, season.externalKey),
                      or(
                        isNull(bridgeDeviceLeagues.season),
                        eq(bridgeDeviceLeagues.season, season.season),
                      ),
                    ),
                  ),
              ),
            ),
          );
      }

      await transaction
        .update(userPreferences)
        .set({ defaultLeagueId: null, updatedAt: removedAt })
        .where(
          and(
            eq(userPreferences.userId, input.userId),
            eq(userPreferences.defaultLeagueId, league.id),
          ),
        );

      let leagueDeleted = false;
      let ownershipTransferred = false;
      if (league.ownerUserId === input.userId) {
        const candidates = await transaction
          .select({
            id: leagueMemberships.id,
            userId: leagueMemberships.userId,
            role: leagueMemberships.role,
            joinedAt: leagueMemberships.joinedAt,
          })
          .from(leagueMemberships)
          .where(eq(leagueMemberships.leagueId, league.id))
          .orderBy(asc(leagueMemberships.joinedAt), asc(leagueMemberships.id))
          .for("update");
        const successor = candidates
          .filter((membership) => membership.userId !== input.userId)
          .sort(
            (left, right) =>
              successorRoleOrder(left.role) - successorRoleOrder(right.role) ||
              left.joinedAt.getTime() - right.joinedAt.getTime() ||
              left.id.localeCompare(right.id),
          )[0];
        if (successor) {
          await transaction
            .update(leagues)
            .set({ ownerUserId: successor.userId, updatedAt: removedAt })
            .where(and(eq(leagues.id, league.id), eq(leagues.ownerUserId, input.userId)));
          ownershipTransferred = true;
          await transaction
            .delete(leagueMemberships)
            .where(
              and(
                eq(leagueMemberships.leagueId, league.id),
                eq(leagueMemberships.userId, input.userId),
              ),
            );
        } else {
          await transaction.delete(leagues).where(eq(leagues.id, league.id));
          leagueDeleted = true;
        }
      } else {
        await transaction
          .delete(leagueMemberships)
          .where(
            and(
              eq(leagueMemberships.leagueId, league.id),
              eq(leagueMemberships.userId, input.userId),
            ),
          );
      }

      await transaction.insert(auditEvents).values({
        userId: input.userId,
        action: "league.membership.removed",
        targetType: "league",
        targetId: league.id,
        correlationId: input.correlationId,
        metadata: {
          leagueDeleted,
          ownershipTransferred,
          detachedProviderSeasonCount: syncedSeasons.length,
        },
        occurredAt: removedAt,
      });

      return {
        outcome: "removed",
        response: {
          leagueId: league.id,
          leagueName: league.name,
          leagueDeleted,
          ownershipTransferred,
          removedAt: removedAt.toISOString(),
        },
      };
    });
  }
}
