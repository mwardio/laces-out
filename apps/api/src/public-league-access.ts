import type { LeagueAccessRole } from "@laces-out/contracts";
import { leagueSeasons, type LeagueMembershipRole } from "@laces-out/db";
import { desc, sql, type SQL, type SQLWrapper } from "drizzle-orm";

/** Legacy values remain readable during rollout, but never cross a public API boundary. */
export type StoredLeagueAccessRole = LeagueMembershipRole | "member" | "manager" | "viewer";

export interface LeagueCommissionerAuthority {
  readonly role: StoredLeagueAccessRole;
  readonly explicitCommissioner?: boolean | null | undefined;
  readonly providerCommissioner?: boolean | null | undefined;
}

/** Internal ownership is deliberately absent from this product-authority decision. */
export function hasCommissionerAuthority(input: LeagueCommissionerAuthority): boolean {
  return (
    input.role === "commissioner" ||
    input.explicitCommissioner === true ||
    input.providerCommissioner === true
  );
}

/**
 * Collapses durable product authority into the stable two-value public contract. Canonical owner
 * is only a database lifecycle role, so an owner without an explicit or provider grant is a member.
 */
export function publicLeagueAccessRole(input: LeagueCommissionerAuthority): LeagueAccessRole {
  return hasCommissionerAuthority(input) ? "commissioner" : "member";
}

/** Exact provider evidence for one authenticated user and provider league-season scope. */
export function providerCommissionerAuthoritySql(
  userId: string,
  leagueSeasonId: SQLWrapper,
): SQL<boolean> {
  return sql<boolean>`exists (
    select 1
    from "provider_league_links" as provider_authority_link
    inner join "provider_connections" as provider_authority_connection
      on provider_authority_connection."id" = provider_authority_link."connection_id"
    inner join "league_seasons" as provider_authority_season
      on provider_authority_season."id" = provider_authority_link."league_season_id"
    where provider_authority_link."league_season_id" = ${leagueSeasonId}
      and provider_authority_connection."user_id" = ${userId}
      and provider_authority_connection."provider" in ('espn', 'yahoo')
      and provider_authority_connection."provider" = provider_authority_season."provider"
      and provider_authority_link."provider_commissioner" = true
  )`;
}

/** Provider authority for the latest season represented by a league-level public/API action. */
export function latestProviderCommissionerAuthoritySql(
  userId: string,
  leagueId: SQLWrapper,
): SQL<boolean> {
  const latestSeasonId = sql`(
    select ${leagueSeasons.id}
    from ${leagueSeasons}
    where ${leagueSeasons.leagueId} = ${leagueId}
    order by ${desc(leagueSeasons.season)},
      ${desc(leagueSeasons.updatedAt)},
      ${desc(leagueSeasons.id)}
    limit 1
  )`;
  return providerCommissionerAuthoritySql(userId, latestSeasonId);
}
