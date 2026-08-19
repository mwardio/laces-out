import type {
  DataSourceFreshness,
  Freshness,
  LeagueDashboard,
  LeagueListResponse,
  LeagueMembershipSummary,
  LeagueSeasonSummary,
  LeagueStandingEntry,
  LeagueTeamSnapshot,
  LeagueWeeklyInsights,
  LeagueWeeklyMatchup,
  MemberWeekContext,
  Provider,
  TeamClaimPolicy,
  TeamClaimResponse,
  WeeklyScoreLeader,
} from "@laces-out/contracts";
import {
  dataSources,
  fantasyTeams,
  leagueMemberships,
  leagues,
  leagueSeasons,
  matchupSnapshots,
  players,
  providerConnections,
  providerLeagueLinks,
  rosterEntries,
  rosterSnapshots,
  standingsEntries,
  standingsSnapshots,
  syncRuns,
  weeklyMatchups,
  type Database,
  type LeagueMembershipRole,
  type StandingStreakType,
  type WeeklyMatchupStatus,
} from "@laces-out/db";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { publicLeagueAccessRole } from "./public-league-access.js";

interface MembershipRow {
  readonly membershipId: string;
  readonly role: LeagueMembershipRole;
  readonly claimedFantasyTeamId: string | null;
  readonly claimedTeamName: string | null;
  readonly claimedAt: Date | null;
  readonly leagueId: string;
  readonly leagueName: string;
  readonly archived: boolean;
}

interface SeasonRow {
  readonly id: string;
  readonly leagueId: string;
  readonly provider: Provider;
  readonly season: number;
  readonly status: string;
  readonly teamCount: number;
  readonly draftType: string;
  readonly waiverType: string | null;
  readonly currentWeek: number | null;
  readonly lastSyncedAt: Date | null;
  readonly updatedAt: Date;
}

interface TeamRow {
  readonly id: string;
  readonly name: string;
  readonly abbreviation: string | null;
  readonly managerDisplayName: string | null;
  readonly logoUrl: string | null;
  readonly faabRemaining: number | null;
  readonly waiverPriority: number | null;
}

interface ProviderTeamMappingRow {
  readonly externalKey: string | null;
  readonly teamId: string | null;
  readonly teamName: string | null;
}

interface RosterSnapshotRow {
  readonly id: string;
  readonly teamId: string;
  readonly effectiveAt: Date;
  readonly week: number | null;
}

interface RosterEntryRow {
  readonly snapshotId: string;
  readonly playerId: string;
  readonly name: string;
  readonly position: string;
  readonly eligiblePositions: string[];
  readonly nflTeam: string | null;
  readonly status: string | null;
  readonly slotCode: string;
  readonly isStarter: boolean;
  readonly locked: boolean;
}

interface SyncRunRow {
  readonly kind: string;
  readonly state: string;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
  readonly recordsRead: number;
  readonly recordsWritten: number;
}

interface DataSourceRow {
  readonly key: string;
  readonly name: string;
  readonly kind: string;
  readonly attribution: string | null;
  readonly attributionUrl: string | null;
  readonly lastCheckedAt: Date | null;
  readonly lastSuccessfulAt: Date | null;
  readonly consecutiveFailures: number;
  readonly metadata?: Readonly<Record<string, string | number | boolean | null>>;
}

interface StandingsSnapshotRow {
  readonly id: string;
  readonly asOfWeek: number | null;
  readonly effectiveAt: Date;
}

interface StandingEntryRow {
  readonly teamId: string;
  readonly teamName: string;
  readonly abbreviation: string | null;
  readonly managerDisplayName: string | null;
  readonly logoUrl: string | null;
  readonly rank: number;
  readonly playoffSeed: number | null;
  readonly wins: number;
  readonly losses: number;
  readonly ties: number;
  readonly pointsFor: string;
  readonly pointsAgainst: string;
  readonly streakType: StandingStreakType;
  readonly streakLength: number;
}

interface MatchupSnapshotRow {
  readonly id: string;
  readonly asOfWeek: number | null;
  readonly effectiveAt: Date;
}

interface WeeklyMatchupRow {
  readonly id: string;
  readonly week: number;
  readonly status: WeeklyMatchupStatus;
  readonly homeTeamId: string;
  readonly homeTeamName: string;
  readonly homeAbbreviation: string | null;
  readonly homeManagerDisplayName: string | null;
  readonly homeLogoUrl: string | null;
  readonly awayTeamId: string;
  readonly awayTeamName: string;
  readonly awayAbbreviation: string | null;
  readonly awayManagerDisplayName: string | null;
  readonly awayLogoUrl: string | null;
  readonly homeScore: string | null;
  readonly awayScore: string | null;
  readonly winnerTeamId: string | null;
  readonly tied: boolean;
}

type ClaimResult =
  | { readonly state: "claimed"; readonly teamName: string; readonly claimedAt: Date }
  | {
      readonly state: "not-member" | "no-season" | "invalid-team" | "provider-mismatch" | "taken";
    };

export interface LeagueDashboardRepository {
  listMemberships(userId: string): Promise<readonly MembershipRow[]>;
  listSeasons(leagueIds: readonly string[]): Promise<readonly SeasonRow[]>;
  findMembership(userId: string, leagueId: string): Promise<MembershipRow | undefined>;
  listTeams(leagueSeasonId: string): Promise<readonly TeamRow[]>;
  listProviderTeamMappings(
    userId: string,
    leagueSeasonId: string,
    provider: Extract<Provider, "espn" | "yahoo">,
  ): Promise<readonly ProviderTeamMappingRow[]>;
  listLatestRosterCandidates(leagueSeasonId: string): Promise<readonly RosterSnapshotRow[]>;
  listRosterEntries(snapshotIds: readonly string[]): Promise<readonly RosterEntryRow[]>;
  listClaimedTeamIds(leagueId: string): Promise<readonly string[]>;
  findLatestSyncRun(leagueSeasonId: string): Promise<SyncRunRow | undefined>;
  findLatestStandingsSnapshot(leagueSeasonId: string): Promise<StandingsSnapshotRow | undefined>;
  listStandingsEntries(snapshotId: string): Promise<readonly StandingEntryRow[]>;
  findLatestMatchupSnapshot(leagueSeasonId: string): Promise<MatchupSnapshotRow | undefined>;
  listWeeklyMatchups(snapshotId: string): Promise<readonly WeeklyMatchupRow[]>;
  listDataSources(): Promise<readonly DataSourceRow[]>;
  claimTeam(userId: string, leagueId: string, teamId: string, now: Date): Promise<ClaimResult>;
}

const homeFantasyTeam = alias(fantasyTeams, "weekly_matchup_home_team");
const awayFantasyTeam = alias(fantasyTeams, "weekly_matchup_away_team");

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "23505"
  );
}

function exactProviderTeamMapping(
  mappings: readonly ProviderTeamMappingRow[],
): { readonly teamId: string; readonly teamName: string } | null {
  const externalKeys = new Set(
    mappings.flatMap((mapping) => (mapping.externalKey ? [mapping.externalKey] : [])),
  );
  const mappedTeams = new Map(
    mappings.flatMap((mapping) =>
      mapping.externalKey && mapping.teamId && mapping.teamName
        ? [[mapping.teamId, mapping.teamName] as const]
        : [],
    ),
  );
  if (externalKeys.size !== 1 || mappedTeams.size !== 1) return null;
  const [mapped] = [...mappedTeams];
  return mapped ? { teamId: mapped[0], teamName: mapped[1] } : null;
}

export class DrizzleLeagueDashboardRepository implements LeagueDashboardRepository {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  async listMemberships(userId: string): Promise<readonly MembershipRow[]> {
    return this.#database
      .select({
        membershipId: leagueMemberships.id,
        role: leagueMemberships.role,
        claimedFantasyTeamId: leagueMemberships.claimedFantasyTeamId,
        claimedTeamName: fantasyTeams.name,
        claimedAt: leagueMemberships.claimedAt,
        leagueId: leagues.id,
        leagueName: leagues.name,
        archived: leagues.archived,
      })
      .from(leagueMemberships)
      .innerJoin(leagues, eq(leagueMemberships.leagueId, leagues.id))
      .leftJoin(fantasyTeams, eq(leagueMemberships.claimedFantasyTeamId, fantasyTeams.id))
      .where(eq(leagueMemberships.userId, userId))
      .orderBy(asc(leagues.name));
  }

  async listSeasons(leagueIds: readonly string[]): Promise<readonly SeasonRow[]> {
    if (leagueIds.length === 0) return [];
    return this.#database
      .select({
        id: leagueSeasons.id,
        leagueId: leagueSeasons.leagueId,
        provider: leagueSeasons.provider,
        season: leagueSeasons.season,
        status: leagueSeasons.status,
        teamCount: leagueSeasons.teamCount,
        draftType: leagueSeasons.draftType,
        waiverType: leagueSeasons.waiverType,
        currentWeek: leagueSeasons.currentWeek,
        lastSyncedAt: leagueSeasons.lastSyncedAt,
        updatedAt: leagueSeasons.updatedAt,
      })
      .from(leagueSeasons)
      .where(inArray(leagueSeasons.leagueId, [...leagueIds]))
      .orderBy(desc(leagueSeasons.season), desc(leagueSeasons.updatedAt));
  }

  async findMembership(userId: string, leagueId: string): Promise<MembershipRow | undefined> {
    const [membership] = await this.#database
      .select({
        membershipId: leagueMemberships.id,
        role: leagueMemberships.role,
        claimedFantasyTeamId: leagueMemberships.claimedFantasyTeamId,
        claimedTeamName: fantasyTeams.name,
        claimedAt: leagueMemberships.claimedAt,
        leagueId: leagues.id,
        leagueName: leagues.name,
        archived: leagues.archived,
      })
      .from(leagueMemberships)
      .innerJoin(leagues, eq(leagueMemberships.leagueId, leagues.id))
      .leftJoin(fantasyTeams, eq(leagueMemberships.claimedFantasyTeamId, fantasyTeams.id))
      .where(and(eq(leagueMemberships.userId, userId), eq(leagues.id, leagueId)))
      .limit(1);
    return membership;
  }

  async listTeams(leagueSeasonId: string): Promise<readonly TeamRow[]> {
    return this.#database
      .select({
        id: fantasyTeams.id,
        name: fantasyTeams.name,
        abbreviation: fantasyTeams.abbreviation,
        managerDisplayName: fantasyTeams.managerDisplayName,
        logoUrl: fantasyTeams.logoUrl,
        faabRemaining: fantasyTeams.faabRemaining,
        waiverPriority: fantasyTeams.waiverPriority,
      })
      .from(fantasyTeams)
      .where(eq(fantasyTeams.leagueSeasonId, leagueSeasonId))
      .orderBy(asc(fantasyTeams.name));
  }

  async listProviderTeamMappings(
    userId: string,
    leagueSeasonId: string,
    provider: Extract<Provider, "espn" | "yahoo">,
  ): Promise<readonly ProviderTeamMappingRow[]> {
    return this.#database
      .select({
        externalKey: providerLeagueLinks.currentUserTeamExternalKey,
        teamId: fantasyTeams.id,
        teamName: fantasyTeams.name,
      })
      .from(providerLeagueLinks)
      .innerJoin(providerConnections, eq(providerConnections.id, providerLeagueLinks.connectionId))
      .leftJoin(
        fantasyTeams,
        and(
          eq(fantasyTeams.leagueSeasonId, providerLeagueLinks.leagueSeasonId),
          eq(fantasyTeams.externalKey, providerLeagueLinks.currentUserTeamExternalKey),
        ),
      )
      .where(
        and(
          eq(providerLeagueLinks.leagueSeasonId, leagueSeasonId),
          eq(providerConnections.userId, userId),
          eq(providerConnections.provider, provider),
        ),
      );
  }

  async listLatestRosterCandidates(leagueSeasonId: string): Promise<readonly RosterSnapshotRow[]> {
    return this.#database
      .select({
        id: rosterSnapshots.id,
        teamId: rosterSnapshots.teamId,
        effectiveAt: rosterSnapshots.effectiveAt,
        week: rosterSnapshots.week,
      })
      .from(rosterSnapshots)
      .innerJoin(fantasyTeams, eq(rosterSnapshots.teamId, fantasyTeams.id))
      .where(eq(fantasyTeams.leagueSeasonId, leagueSeasonId))
      .orderBy(desc(rosterSnapshots.effectiveAt), desc(rosterSnapshots.createdAt));
  }

  async listRosterEntries(snapshotIds: readonly string[]): Promise<readonly RosterEntryRow[]> {
    if (snapshotIds.length === 0) return [];
    return this.#database
      .select({
        snapshotId: rosterEntries.snapshotId,
        playerId: players.id,
        name: players.fullName,
        position: players.primaryPosition,
        eligiblePositions: players.eligiblePositions,
        nflTeam: players.nflTeam,
        status: players.status,
        slotCode: rosterEntries.slotCode,
        isStarter: rosterEntries.isStarter,
        locked: rosterEntries.locked,
      })
      .from(rosterEntries)
      .innerJoin(players, eq(rosterEntries.playerId, players.id))
      .where(inArray(rosterEntries.snapshotId, [...snapshotIds]))
      .orderBy(desc(rosterEntries.isStarter), asc(rosterEntries.slotCode), asc(players.fullName));
  }

  async listClaimedTeamIds(leagueId: string): Promise<readonly string[]> {
    const rows = await this.#database
      .select({ teamId: leagueMemberships.claimedFantasyTeamId })
      .from(leagueMemberships)
      .where(eq(leagueMemberships.leagueId, leagueId));
    return rows.flatMap((row) => (row.teamId ? [row.teamId] : []));
  }

  async findLatestSyncRun(leagueSeasonId: string): Promise<SyncRunRow | undefined> {
    const [run] = await this.#database
      .select({
        kind: syncRuns.kind,
        state: syncRuns.state,
        startedAt: syncRuns.startedAt,
        finishedAt: syncRuns.finishedAt,
        recordsRead: syncRuns.recordsRead,
        recordsWritten: syncRuns.recordsWritten,
      })
      .from(syncRuns)
      .where(eq(syncRuns.leagueSeasonId, leagueSeasonId))
      .orderBy(desc(syncRuns.createdAt))
      .limit(1);
    return run;
  }

  async findLatestStandingsSnapshot(
    leagueSeasonId: string,
  ): Promise<StandingsSnapshotRow | undefined> {
    const [snapshot] = await this.#database
      .select({
        id: standingsSnapshots.id,
        asOfWeek: standingsSnapshots.asOfWeek,
        effectiveAt: standingsSnapshots.effectiveAt,
      })
      .from(standingsSnapshots)
      .where(eq(standingsSnapshots.leagueSeasonId, leagueSeasonId))
      .orderBy(desc(standingsSnapshots.effectiveAt), desc(standingsSnapshots.createdAt))
      .limit(1);
    return snapshot;
  }

  async listStandingsEntries(snapshotId: string): Promise<readonly StandingEntryRow[]> {
    return this.#database
      .select({
        teamId: standingsEntries.teamId,
        teamName: fantasyTeams.name,
        abbreviation: fantasyTeams.abbreviation,
        managerDisplayName: fantasyTeams.managerDisplayName,
        logoUrl: fantasyTeams.logoUrl,
        rank: standingsEntries.rank,
        playoffSeed: standingsEntries.playoffSeed,
        wins: standingsEntries.wins,
        losses: standingsEntries.losses,
        ties: standingsEntries.ties,
        pointsFor: standingsEntries.pointsFor,
        pointsAgainst: standingsEntries.pointsAgainst,
        streakType: standingsEntries.streakType,
        streakLength: standingsEntries.streakLength,
      })
      .from(standingsEntries)
      .innerJoin(fantasyTeams, eq(standingsEntries.teamId, fantasyTeams.id))
      .where(eq(standingsEntries.snapshotId, snapshotId))
      .orderBy(asc(standingsEntries.rank), asc(fantasyTeams.name));
  }

  async findLatestMatchupSnapshot(leagueSeasonId: string): Promise<MatchupSnapshotRow | undefined> {
    const [snapshot] = await this.#database
      .select({
        id: matchupSnapshots.id,
        asOfWeek: matchupSnapshots.asOfWeek,
        effectiveAt: matchupSnapshots.effectiveAt,
      })
      .from(matchupSnapshots)
      .where(eq(matchupSnapshots.leagueSeasonId, leagueSeasonId))
      .orderBy(desc(matchupSnapshots.effectiveAt), desc(matchupSnapshots.createdAt))
      .limit(1);
    return snapshot;
  }

  async listWeeklyMatchups(snapshotId: string): Promise<readonly WeeklyMatchupRow[]> {
    return this.#database
      .select({
        id: weeklyMatchups.id,
        week: weeklyMatchups.week,
        status: weeklyMatchups.status,
        homeTeamId: weeklyMatchups.homeTeamId,
        homeTeamName: homeFantasyTeam.name,
        homeAbbreviation: homeFantasyTeam.abbreviation,
        homeManagerDisplayName: homeFantasyTeam.managerDisplayName,
        homeLogoUrl: homeFantasyTeam.logoUrl,
        awayTeamId: weeklyMatchups.awayTeamId,
        awayTeamName: awayFantasyTeam.name,
        awayAbbreviation: awayFantasyTeam.abbreviation,
        awayManagerDisplayName: awayFantasyTeam.managerDisplayName,
        awayLogoUrl: awayFantasyTeam.logoUrl,
        homeScore: weeklyMatchups.homeScore,
        awayScore: weeklyMatchups.awayScore,
        winnerTeamId: weeklyMatchups.winnerTeamId,
        tied: weeklyMatchups.tied,
      })
      .from(weeklyMatchups)
      .innerJoin(homeFantasyTeam, eq(weeklyMatchups.homeTeamId, homeFantasyTeam.id))
      .innerJoin(awayFantasyTeam, eq(weeklyMatchups.awayTeamId, awayFantasyTeam.id))
      .where(eq(weeklyMatchups.snapshotId, snapshotId))
      .orderBy(asc(weeklyMatchups.week), asc(weeklyMatchups.externalKey));
  }

  async listDataSources(): Promise<readonly DataSourceRow[]> {
    return this.#database
      .select({
        key: dataSources.key,
        name: dataSources.name,
        kind: dataSources.kind,
        attribution: dataSources.attribution,
        attributionUrl: dataSources.attributionUrl,
        lastCheckedAt: dataSources.lastCheckedAt,
        lastSuccessfulAt: dataSources.lastSuccessfulAt,
        consecutiveFailures: dataSources.consecutiveFailures,
        metadata: dataSources.metadata,
      })
      .from(dataSources)
      .where(eq(dataSources.enabled, true))
      .orderBy(asc(dataSources.name));
  }

  async claimTeam(
    userId: string,
    leagueId: string,
    teamId: string,
    now: Date,
  ): Promise<ClaimResult> {
    try {
      return await this.#database.transaction(async (transaction) => {
        const [membership] = await transaction
          .select({ id: leagueMemberships.id })
          .from(leagueMemberships)
          .where(
            and(eq(leagueMemberships.userId, userId), eq(leagueMemberships.leagueId, leagueId)),
          )
          .limit(1)
          .for("update");
        if (!membership) return { state: "not-member" } as const;

        const [season] = await transaction
          .select({ id: leagueSeasons.id, provider: leagueSeasons.provider })
          .from(leagueSeasons)
          .where(eq(leagueSeasons.leagueId, leagueId))
          .orderBy(desc(leagueSeasons.season), desc(leagueSeasons.updatedAt))
          .limit(1);
        if (!season) return { state: "no-season" } as const;

        const [team] = await transaction
          .select({
            id: fantasyTeams.id,
            name: fantasyTeams.name,
          })
          .from(fantasyTeams)
          .where(and(eq(fantasyTeams.id, teamId), eq(fantasyTeams.leagueSeasonId, season.id)))
          .limit(1);
        if (!team) return { state: "invalid-team" } as const;

        if (season.provider === "espn" || season.provider === "yahoo") {
          const mappingRows = await transaction
            .select({
              externalKey: providerLeagueLinks.currentUserTeamExternalKey,
              teamId: fantasyTeams.id,
              teamName: fantasyTeams.name,
            })
            .from(providerLeagueLinks)
            .innerJoin(
              providerConnections,
              eq(providerConnections.id, providerLeagueLinks.connectionId),
            )
            .leftJoin(
              fantasyTeams,
              and(
                eq(fantasyTeams.leagueSeasonId, providerLeagueLinks.leagueSeasonId),
                eq(fantasyTeams.externalKey, providerLeagueLinks.currentUserTeamExternalKey),
              ),
            )
            .where(
              and(
                eq(providerLeagueLinks.leagueSeasonId, season.id),
                eq(providerConnections.userId, userId),
                eq(providerConnections.provider, season.provider),
              ),
            );
          const exactMapping = exactProviderTeamMapping(mappingRows);
          const mappingIsRequired = season.provider === "yahoo" || exactMapping !== null;
          if (mappingIsRequired && exactMapping?.teamId !== team.id) {
            return { state: "provider-mismatch" } as const;
          }
        }

        const [existingClaim] = await transaction
          .select({ id: leagueMemberships.id, userId: leagueMemberships.userId })
          .from(leagueMemberships)
          .where(eq(leagueMemberships.claimedFantasyTeamId, teamId))
          .limit(1)
          .for("update");
        if (existingClaim && existingClaim.userId !== userId) {
          return { state: "taken" } as const;
        }

        await transaction
          .update(leagueMemberships)
          .set({ claimedFantasyTeamId: teamId, claimedAt: now, updatedAt: now })
          .where(eq(leagueMemberships.id, membership.id));
        return { state: "claimed", teamName: team.name, claimedAt: now } as const;
      });
    } catch (error) {
      if (isUniqueViolation(error)) return { state: "taken" };
      throw error;
    }
  }
}

export class LeagueDashboardError extends Error {
  readonly statusCode: number;
  readonly code: "NOT_FOUND" | "NO_SEASON" | "TEAM_NOT_CLAIMABLE" | "TEAM_TAKEN";

  constructor(code: LeagueDashboardError["code"], message: string) {
    super(message);
    this.name = "LeagueDashboardError";
    this.code = code;
    this.statusCode = code === "NOT_FOUND" ? 404 : 409;
  }
}

function relativeLabel(observedAt: Date, now: Date, subject: string): string {
  const ageMinutes = Math.max(0, Math.floor((now.getTime() - observedAt.getTime()) / 60_000));
  if (ageMinutes < 1) return `${subject} just now`;
  if (ageMinutes < 60) return `${subject} ${ageMinutes}m ago`;
  const ageHours = Math.floor(ageMinutes / 60);
  if (ageHours < 48) return `${subject} ${ageHours}h ago`;
  return `${subject} ${Math.floor(ageHours / 24)}d ago`;
}

function freshness(observedAt: Date | null, now: Date, subject = "Synced"): Freshness {
  if (!observedAt) return { state: "missing", observedAt: null, label: "Never synced" };
  const ageHours = Math.max(0, (now.getTime() - observedAt.getTime()) / 3_600_000);
  return {
    state: ageHours <= 6 ? "fresh" : ageHours <= 24 ? "aging" : "stale",
    observedAt: observedAt.toISOString(),
    label: relativeLabel(observedAt, now, subject),
  };
}

function nonnegativeMetadataInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function membershipSummary(row: MembershipRow): LeagueMembershipSummary {
  return {
    role: publicLeagueAccessRole(row.role),
    claimedFantasyTeamId: row.claimedFantasyTeamId,
    claimedTeamName: row.claimedTeamName,
    claimedAt: row.claimedAt?.toISOString() ?? null,
  };
}

function seasonSummary(row: SeasonRow, now: Date): LeagueSeasonSummary {
  return {
    id: row.id,
    provider: row.provider,
    season: row.season,
    status: row.status,
    teamCount: row.teamCount,
    draftType: row.draftType,
    waiverType: row.waiverType,
    currentWeek: row.currentWeek,
    lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
    providerFreshness: freshness(row.lastSyncedAt, now),
  };
}

function teamClaimPolicy(
  provider: Provider | null,
  mappings: readonly ProviderTeamMappingRow[],
): TeamClaimPolicy {
  if (provider === "manual") {
    return {
      mode: "self-asserted",
      provider,
      claimableTeamId: null,
      claimableTeamName: null,
      explanation:
        "Laces Out cannot match a provider account for this league. Select your team in Settings.",
    };
  }
  if (provider === "espn" || provider === "yahoo") {
    const mapped = exactProviderTeamMapping(mappings);
    if (mapped) {
      return {
        mode: "provider-mapped",
        provider,
        claimableTeamId: mapped.teamId,
        claimableTeamName: mapped.teamName,
        explanation: `${provider === "espn" ? "ESPN" : "Yahoo"} identifies ${mapped.teamName} as the team owned by this connected account.`,
      };
    }
    if (provider === "espn") {
      return {
        mode: "self-asserted",
        provider,
        claimableTeamId: null,
        claimableTeamName: null,
        explanation:
          "ESPN did not return one exact team for this connected account. Select your own team in Settings.",
      };
    }
    return {
      mode: "unavailable",
      provider,
      claimableTeamId: null,
      claimableTeamName: null,
      explanation:
        "Yahoo did not return one unambiguous current-user team for this connected account. Refresh the Yahoo league before selecting a team.",
    };
  }
  return {
    mode: "unavailable",
    provider: null,
    claimableTeamId: null,
    claimableTeamName: null,
    explanation: "Sync a provider season before selecting a fantasy team.",
  };
}

function decimal(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error("Stored league metric was not a finite number");
  return parsed;
}

function optionalDecimal(value: string | null): number | null {
  return value === null ? null : decimal(value);
}

function rounded(value: number): number {
  return Number(value.toFixed(4));
}

function standingsView(
  snapshot: StandingsSnapshotRow | undefined,
  rows: readonly StandingEntryRow[],
  claimedTeamId: string | null,
  now: Date,
): LeagueDashboard["standings"] {
  const entries: LeagueStandingEntry[] = rows.map((row) => {
    const pointsFor = decimal(row.pointsFor);
    const pointsAgainst = decimal(row.pointsAgainst);
    return {
      teamId: row.teamId,
      teamName: row.teamName,
      abbreviation: row.abbreviation,
      managerDisplayName: row.managerDisplayName,
      logoUrl: row.logoUrl,
      rank: row.rank,
      playoffSeed: row.playoffSeed,
      wins: row.wins,
      losses: row.losses,
      ties: row.ties,
      pointsFor,
      pointsAgainst,
      pointDifferential: rounded(pointsFor - pointsAgainst),
      streakType: row.streakType,
      streakLength: row.streakLength,
      isCurrentUser: row.teamId === claimedTeamId,
    };
  });
  return {
    state: snapshot && entries.length > 0 ? "available" : "unavailable",
    asOfWeek: snapshot?.asOfWeek ?? null,
    effectiveAt: snapshot?.effectiveAt.toISOString() ?? null,
    freshness: freshness(snapshot?.effectiveAt ?? null, now, "Captured"),
    entries,
  };
}

function matchupView(row: WeeklyMatchupRow, claimedTeamId: string | null): LeagueWeeklyMatchup {
  return {
    id: row.id,
    week: row.week,
    status: row.status,
    home: {
      teamId: row.homeTeamId,
      teamName: row.homeTeamName,
      abbreviation: row.homeAbbreviation,
      managerDisplayName: row.homeManagerDisplayName,
      logoUrl: row.homeLogoUrl,
      score: optionalDecimal(row.homeScore),
    },
    away: {
      teamId: row.awayTeamId,
      teamName: row.awayTeamName,
      abbreviation: row.awayAbbreviation,
      managerDisplayName: row.awayManagerDisplayName,
      logoUrl: row.awayLogoUrl,
      score: optionalDecimal(row.awayScore),
    },
    winnerTeamId: row.winnerTeamId,
    tied: row.tied,
    isCurrentUserMatchup:
      claimedTeamId !== null &&
      (row.homeTeamId === claimedTeamId || row.awayTeamId === claimedTeamId),
  };
}

function scoreOutcome(matchup: LeagueWeeklyMatchup, teamId: string): WeeklyScoreLeader["outcome"] {
  const isHome = matchup.home.teamId === teamId;
  const teamScore = isHome ? matchup.home.score : matchup.away.score;
  const opponentScore = isHome ? matchup.away.score : matchup.home.score;
  if (matchup.status === "final") {
    if (matchup.tied) return "tie";
    return matchup.winnerTeamId === teamId ? "win" : "loss";
  }
  if (teamScore === opponentScore) return "level";
  return (teamScore ?? 0) > (opponentScore ?? 0) ? "leading" : "trailing";
}

function weeklyInsightsView(
  snapshot: MatchupSnapshotRow | undefined,
  rows: readonly WeeklyMatchupRow[],
  currentWeek: number | null,
  claimedTeamId: string | null,
  now: Date,
): LeagueWeeklyInsights {
  const week = currentWeek ?? snapshot?.asOfWeek ?? null;
  const selectedRows = week === null ? [] : rows.filter((row) => row.week === week);
  const matchups = selectedRows.map((row) => matchupView(row, claimedTeamId));
  const scoreLeaders: WeeklyScoreLeader[] = matchups.flatMap((matchup) => {
    if (
      matchup.status === "scheduled" ||
      matchup.home.score === null ||
      matchup.away.score === null
    ) {
      return [];
    }
    return [
      {
        rank: 0,
        teamId: matchup.home.teamId,
        teamName: matchup.home.teamName,
        managerDisplayName: matchup.home.managerDisplayName,
        score: matchup.home.score,
        opponentTeamId: matchup.away.teamId,
        opponentTeamName: matchup.away.teamName,
        matchupStatus: matchup.status,
        outcome: scoreOutcome(matchup, matchup.home.teamId),
        isCurrentUser: matchup.home.teamId === claimedTeamId,
      },
      {
        rank: 0,
        teamId: matchup.away.teamId,
        teamName: matchup.away.teamName,
        managerDisplayName: matchup.away.managerDisplayName,
        score: matchup.away.score,
        opponentTeamId: matchup.home.teamId,
        opponentTeamName: matchup.home.teamName,
        matchupStatus: matchup.status,
        outcome: scoreOutcome(matchup, matchup.away.teamId),
        isCurrentUser: matchup.away.teamId === claimedTeamId,
      },
    ];
  });
  scoreLeaders.sort(
    (left, right) =>
      right.score - left.score ||
      left.teamName.localeCompare(right.teamName) ||
      left.teamId.localeCompare(right.teamId),
  );
  scoreLeaders.forEach((leader, index) => {
    leader.rank = index + 1;
  });

  const scores = scoreLeaders.map((leader) => leader.score);
  const totalPoints =
    scores.length > 0 ? rounded(scores.reduce((sum, score) => sum + score, 0)) : null;
  const margins = matchups.flatMap((matchup) =>
    matchup.home.score === null || matchup.away.score === null
      ? []
      : [rounded(Math.abs(matchup.home.score - matchup.away.score))],
  );
  return {
    state: !snapshot
      ? "unavailable"
      : week === null || matchups.length === 0
        ? "week-unavailable"
        : "available",
    week,
    snapshotAsOfWeek: snapshot?.asOfWeek ?? null,
    effectiveAt: snapshot?.effectiveAt.toISOString() ?? null,
    freshness: freshness(snapshot?.effectiveAt ?? null, now, "Captured"),
    matchups,
    metrics: {
      matchupCount: matchups.length,
      completedMatchupCount: matchups.filter((matchup) => matchup.status === "final").length,
      inProgressMatchupCount: matchups.filter((matchup) => matchup.status === "in-progress").length,
      scheduledMatchupCount: matchups.filter((matchup) => matchup.status === "scheduled").length,
      scoredTeamCount: scores.length,
      totalPoints,
      averageTeamScore: totalPoints === null ? null : rounded(totalPoints / scores.length),
      highestTeamScore: scores.length > 0 ? Math.max(...scores) : null,
      lowestTeamScore: scores.length > 0 ? Math.min(...scores) : null,
      smallestScoreMargin: margins.length > 0 ? Math.min(...margins) : null,
      largestScoreMargin: margins.length > 0 ? Math.max(...margins) : null,
    },
    scoreLeaders,
  };
}

function memberScoreState(
  matchup: LeagueWeeklyMatchup,
  claimedTeamId: string,
): MemberWeekContext["scoreState"] {
  const isHome = matchup.home.teamId === claimedTeamId;
  const teamScore = isHome ? matchup.home.score : matchup.away.score;
  const opponentScore = isHome ? matchup.away.score : matchup.home.score;
  if (matchup.status === "scheduled" || teamScore === null || opponentScore === null) {
    return "not-started";
  }
  if (matchup.status === "final") {
    if (matchup.tied) return "tied";
    return matchup.winnerTeamId === claimedTeamId ? "won" : "lost";
  }
  if (teamScore === opponentScore) return "tied";
  return teamScore > opponentScore ? "leading" : "trailing";
}

function memberWeekView(
  membership: MembershipRow,
  teams: readonly TeamRow[],
  standings: LeagueDashboard["standings"],
  weeklyInsights: LeagueWeeklyInsights,
): MemberWeekContext {
  const claimedTeamId = membership.claimedFantasyTeamId;
  const claimedTeam = teams.find((team) => team.id === claimedTeamId);
  const standing = standings.entries.find((entry) => entry.teamId === claimedTeamId);
  const base = {
    week: weeklyInsights.week,
    teamId: claimedTeamId,
    teamName: claimedTeam?.name ?? membership.claimedTeamName,
    teamLogoUrl: claimedTeam?.logoUrl ?? null,
    standingRank: standing?.rank ?? null,
    wins: standing?.wins ?? null,
    losses: standing?.losses ?? null,
    ties: standing?.ties ?? null,
  };
  const emptyOpponent = {
    opponentTeamId: null,
    opponentTeamName: null,
    opponentLogoUrl: null,
    opponentManagerDisplayName: null,
    opponentStandingRank: null,
    opponentWins: null,
    opponentLosses: null,
    opponentTies: null,
    matchupId: null,
    matchupStatus: null,
    isHome: null,
    teamScore: null,
    opponentScore: null,
    scoreState: null,
  };
  if (!claimedTeamId) {
    return { state: "team-unclaimed", ...base, ...emptyOpponent };
  }
  if (weeklyInsights.week === null) {
    return { state: "week-unavailable", ...base, ...emptyOpponent };
  }
  const matchup = weeklyInsights.matchups.find(
    (candidate) =>
      candidate.home.teamId === claimedTeamId || candidate.away.teamId === claimedTeamId,
  );
  if (!matchup) {
    return { state: "matchup-unavailable", ...base, ...emptyOpponent };
  }
  const isHome = matchup.home.teamId === claimedTeamId;
  const teamSide = isHome ? matchup.home : matchup.away;
  const opponentSide = isHome ? matchup.away : matchup.home;
  const opponentStanding = standings.entries.find((entry) => entry.teamId === opponentSide.teamId);
  return {
    state: "available",
    ...base,
    opponentTeamId: opponentSide.teamId,
    opponentTeamName: opponentSide.teamName,
    opponentLogoUrl: opponentSide.logoUrl,
    opponentManagerDisplayName: opponentSide.managerDisplayName,
    opponentStandingRank: opponentStanding?.rank ?? null,
    opponentWins: opponentStanding?.wins ?? null,
    opponentLosses: opponentStanding?.losses ?? null,
    opponentTies: opponentStanding?.ties ?? null,
    matchupId: matchup.id,
    matchupStatus: matchup.status,
    isHome,
    teamScore: teamSide.score,
    opponentScore: opponentSide.score,
    scoreState: memberScoreState(matchup, claimedTeamId),
  };
}

export class LeagueDashboardService {
  readonly #repository: LeagueDashboardRepository;
  readonly #now: () => Date;

  constructor(repository: LeagueDashboardRepository, now: () => Date = () => new Date()) {
    this.#repository = repository;
    this.#now = now;
  }

  async listLeagues(userId: string): Promise<LeagueListResponse> {
    const now = this.#now();
    const memberships = await this.#repository.listMemberships(userId);
    const seasons = await this.#repository.listSeasons(
      memberships.map((membership) => membership.leagueId),
    );
    const latestSeasons = new Map<string, SeasonRow>();
    for (const season of seasons) {
      if (!latestSeasons.has(season.leagueId)) latestSeasons.set(season.leagueId, season);
    }
    return {
      generatedAt: now.toISOString(),
      leagues: memberships.map((membership) => ({
        id: membership.leagueId,
        name: membership.leagueName,
        archived: membership.archived,
        membership: membershipSummary(membership),
        season: latestSeasons.has(membership.leagueId)
          ? seasonSummary(latestSeasons.get(membership.leagueId) as SeasonRow, now)
          : null,
      })),
    };
  }

  async getDashboard(userId: string, leagueId: string): Promise<LeagueDashboard | undefined> {
    const membership = await this.#repository.findMembership(userId, leagueId);
    if (!membership) return undefined;

    const now = this.#now();
    const [season] = await this.#repository.listSeasons([leagueId]);
    const sources = await this.#repository.listDataSources();
    const dataSourceFreshness: DataSourceFreshness[] = sources.map((source) => {
      const rowsRead = nonnegativeMetadataInteger(source.metadata?.rowsRead);
      const rowsRejected = nonnegativeMetadataInteger(source.metadata?.rowsRejected);
      const rowsUnmatched = nonnegativeMetadataInteger(source.metadata?.rowsUnmatched);
      const quality =
        rowsRead === null && rowsRejected === null && rowsUnmatched === null
          ? null
          : {
              rowsRead: rowsRead ?? 0,
              rowsRejected: rowsRejected ?? 0,
              rowsUnmatched: rowsUnmatched ?? 0,
              matchRate:
                rowsRead && rowsRead > 0
                  ? Math.max(0, Math.min(1, (rowsRead - (rowsUnmatched ?? 0)) / rowsRead))
                  : null,
            };
      return {
        key: source.key,
        name: source.name,
        kind: source.kind,
        attribution: source.attribution,
        attributionUrl: source.attributionUrl,
        lastCheckedAt: source.lastCheckedAt?.toISOString() ?? null,
        lastSuccessfulAt: source.lastSuccessfulAt?.toISOString() ?? null,
        consecutiveFailures: source.consecutiveFailures,
        quality,
        freshness: freshness(source.lastSuccessfulAt, now, "Successful check"),
      };
    });
    const notices: string[] = [];

    if (!season) {
      notices.push("No provider season has been synchronized for this league yet.");
      const leagueStandings = standingsView(undefined, [], membership.claimedFantasyTeamId, now);
      const weeklyInsights = weeklyInsightsView(
        undefined,
        [],
        null,
        membership.claimedFantasyTeamId,
        now,
      );
      return {
        generatedAt: now.toISOString(),
        league: {
          id: membership.leagueId,
          name: membership.leagueName,
          archived: membership.archived,
        },
        membership: membershipSummary(membership),
        teamClaim: teamClaimPolicy(null, []),
        season: null,
        latestSyncRun: null,
        overview: {
          configuredTeamCount: 0,
          storedTeamCount: 0,
          teamsWithRosterSnapshots: 0,
          rosteredPlayerCount: 0,
          starterCount: 0,
          availableTeamClaims: 0,
          positionCounts: {},
        },
        teams: [],
        standings: leagueStandings,
        weeklyInsights,
        memberWeek: memberWeekView(membership, [], leagueStandings, weeklyInsights),
        dataSources: dataSourceFreshness,
        notices,
      };
    }

    const [
      teams,
      snapshots,
      claimedTeamIds,
      latestSyncRun,
      latestStandingsSnapshot,
      latestMatchupSnapshot,
      providerTeamMappings,
    ] = await Promise.all([
      this.#repository.listTeams(season.id),
      this.#repository.listLatestRosterCandidates(season.id),
      this.#repository.listClaimedTeamIds(leagueId),
      this.#repository.findLatestSyncRun(season.id),
      this.#repository.findLatestStandingsSnapshot(season.id),
      this.#repository.findLatestMatchupSnapshot(season.id),
      season.provider === "espn" || season.provider === "yahoo"
        ? this.#repository.listProviderTeamMappings(userId, season.id, season.provider)
        : Promise.resolve([]),
    ]);
    const providerPolicy = teamClaimPolicy(season.provider, providerTeamMappings);
    const claimed = new Set(claimedTeamIds);
    const claimPolicy: TeamClaimPolicy =
      providerPolicy.mode === "provider-mapped" &&
      membership.claimedFantasyTeamId !== providerPolicy.claimableTeamId &&
      claimed.has(providerPolicy.claimableTeamId)
        ? {
            mode: "unavailable",
            provider: providerPolicy.provider,
            claimableTeamId: null,
            claimableTeamName: null,
            explanation: `${providerPolicy.claimableTeamName} is already assigned to another member.`,
          }
        : providerPolicy;
    const latestSnapshotByTeam = new Map<string, RosterSnapshotRow>();
    for (const snapshot of snapshots) {
      if (!latestSnapshotByTeam.has(snapshot.teamId)) {
        latestSnapshotByTeam.set(snapshot.teamId, snapshot);
      }
    }
    const latestSnapshots = [...latestSnapshotByTeam.values()];
    const [entries, standingRows, matchupRows] = await Promise.all([
      this.#repository.listRosterEntries(latestSnapshots.map((snapshot) => snapshot.id)),
      latestStandingsSnapshot
        ? this.#repository.listStandingsEntries(latestStandingsSnapshot.id)
        : Promise.resolve([]),
      latestMatchupSnapshot
        ? this.#repository.listWeeklyMatchups(latestMatchupSnapshot.id)
        : Promise.resolve([]),
    ]);
    const entriesBySnapshot = new Map<string, RosterEntryRow[]>();
    for (const entry of entries) {
      const bucket = entriesBySnapshot.get(entry.snapshotId) ?? [];
      bucket.push(entry);
      entriesBySnapshot.set(entry.snapshotId, bucket);
    }

    const teamSnapshots: LeagueTeamSnapshot[] = teams.map((team) => {
      const snapshot = latestSnapshotByTeam.get(team.id);
      const roster = snapshot ? (entriesBySnapshot.get(snapshot.id) ?? []) : [];
      return {
        id: team.id,
        name: team.name,
        abbreviation: team.abbreviation,
        managerDisplayName: team.managerDisplayName,
        faabRemaining: team.faabRemaining,
        waiverPriority: team.waiverPriority,
        claimStatus:
          membership.claimedFantasyTeamId === team.id
            ? "current-user"
            : claimed.has(team.id)
              ? "taken"
              : claimPolicy.mode === "self-asserted" ||
                  (claimPolicy.mode === "provider-mapped" &&
                    claimPolicy.claimableTeamId === team.id)
                ? "available"
                : "not-claimable",
        latestRoster: snapshot
          ? {
              effectiveAt: snapshot.effectiveAt.toISOString(),
              week: snapshot.week,
              players: roster.map((entry) => ({
                id: entry.playerId,
                name: entry.name,
                position: entry.position,
                eligiblePositions: entry.eligiblePositions,
                nflTeam: entry.nflTeam,
                status: entry.status,
                slotCode: entry.slotCode,
                isStarter: entry.isStarter,
                locked: entry.locked,
              })),
            }
          : null,
      };
    });

    const positionCounts: Record<string, number> = {};
    let starterCount = 0;
    for (const entry of entries) {
      positionCounts[entry.position] = (positionCounts[entry.position] ?? 0) + 1;
      if (entry.isStarter) starterCount += 1;
    }
    const leagueStandings = standingsView(
      latestStandingsSnapshot,
      standingRows,
      membership.claimedFantasyTeamId,
      now,
    );
    const weeklyInsights = weeklyInsightsView(
      latestMatchupSnapshot,
      matchupRows,
      season.currentWeek,
      membership.claimedFantasyTeamId,
      now,
    );
    const memberWeek = memberWeekView(membership, teams, leagueStandings, weeklyInsights);
    if (!membership.claimedFantasyTeamId) {
      notices.push(claimPolicy.explanation);
    }
    if (teams.length === 0) notices.push("No teams have been stored for the current season.");
    if (latestSnapshots.length < teams.length) {
      notices.push("One or more teams do not have a roster snapshot yet.");
    }
    if (sources.some((source) => source.consecutiveFailures > 0)) {
      notices.push("At least one supporting data source has a recent refresh failure.");
    }
    if (leagueStandings.state === "unavailable") {
      notices.push("Current standings are not available in the latest stored provider data.");
    }
    if (weeklyInsights.state === "unavailable") {
      notices.push("No matchup snapshot has been stored for this league yet.");
    } else if (weeklyInsights.state === "week-unavailable") {
      notices.push(
        weeklyInsights.week === null
          ? "The provider did not identify a current week for matchup analysis."
          : `No matchup rows were stored for week ${weeklyInsights.week}.`,
      );
    }
    if (memberWeek.state === "matchup-unavailable") {
      notices.push(
        "No current-week matchup was found for your team; this may be a bye or a provider data gap.",
      );
    }

    return {
      generatedAt: now.toISOString(),
      league: {
        id: membership.leagueId,
        name: membership.leagueName,
        archived: membership.archived,
      },
      membership: membershipSummary(membership),
      teamClaim: claimPolicy,
      season: seasonSummary(season, now),
      latestSyncRun: latestSyncRun
        ? {
            kind: latestSyncRun.kind,
            state: latestSyncRun.state,
            startedAt: latestSyncRun.startedAt?.toISOString() ?? null,
            finishedAt: latestSyncRun.finishedAt?.toISOString() ?? null,
            recordsRead: latestSyncRun.recordsRead,
            recordsWritten: latestSyncRun.recordsWritten,
          }
        : null,
      overview: {
        configuredTeamCount: season.teamCount,
        storedTeamCount: teams.length,
        teamsWithRosterSnapshots: latestSnapshots.length,
        rosteredPlayerCount: entries.length,
        starterCount,
        availableTeamClaims: teamSnapshots.filter((team) => team.claimStatus === "available")
          .length,
        positionCounts,
      },
      teams: teamSnapshots,
      standings: leagueStandings,
      weeklyInsights,
      memberWeek,
      dataSources: dataSourceFreshness,
      notices,
    };
  }

  async claimTeam(userId: string, leagueId: string, teamId: string): Promise<TeamClaimResponse> {
    const result = await this.#repository.claimTeam(userId, leagueId, teamId, this.#now());
    switch (result.state) {
      case "not-member":
      case "invalid-team":
        throw new LeagueDashboardError("NOT_FOUND", "League or fantasy team was not found");
      case "no-season":
        throw new LeagueDashboardError("NO_SEASON", "The league has no synchronized season");
      case "provider-mismatch":
        throw new LeagueDashboardError(
          "TEAM_NOT_CLAIMABLE",
          "This connected provider account maps to a different fantasy team",
        );
      case "taken":
        throw new LeagueDashboardError(
          "TEAM_TAKEN",
          "That fantasy team is already assigned to another member",
        );
      case "claimed":
        return {
          leagueId,
          teamId,
          teamName: result.teamName,
          claimedAt: result.claimedAt.toISOString(),
        };
    }
  }
}
