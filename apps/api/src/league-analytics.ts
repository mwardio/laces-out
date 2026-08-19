import type {
  Freshness,
  LeagueAnalyticsSnapshot,
  LeagueAnalyticsTeam,
  LeagueAnalyticsUnavailableReason,
  LeagueOpponentScoutSection,
  LeaguePlayoffOddsSection,
  LeaguePositionalAnalyticsSection,
  LeaguePowerAnalyticsSection,
  LeagueRules,
  LeagueScoreAnalyticsSection,
  LeagueWeeklyAwardsSection,
} from "@laces-out/contracts";
import { parseLeagueRules } from "@laces-out/contracts";
import {
  fantasyTeams,
  leagueMemberships,
  leagues,
  leagueSeasons,
  matchupSnapshots,
  playerProjections,
  players,
  projectionSets,
  rosterEntries,
  rosterSlotRules,
  rosterSnapshots,
  users,
  weeklyMatchups,
  type Database,
  type LeagueMembershipRole,
  type ProjectionVisibility,
  type ProviderName,
  type WeeklyMatchupStatus,
} from "@laces-out/db";
import {
  analyzeLeagueSeason,
  analyzePositionalStrength,
  buildOpponentScout,
  calculatePowerRankings,
  awardableWeeks,
  calculateWeeklyAwards,
  simulatePlayoffOdds,
  type LeagueSeasonAnalyticsResult,
  type LeagueWeekInput,
  type PlayoffOddsResult,
  type PowerFactorDefinition,
} from "@laces-out/league-analytics";
import { and, asc, desc, eq, inArray, ne, or, sql } from "drizzle-orm";

import {
  currentManagedProjectionProfile,
  currentManagedProjectionProfileKey,
  type ManagedProjectionProfile,
} from "./managed-projection-profile.js";
import {
  buildPlayoffOddsInput,
  type PlayoffOddsMatchupRow,
  type PlayoffOddsTeamRow,
} from "./playoff-odds.js";
import { projectionTimestampProvenance } from "./projection-provenance.js";

export const LEAGUE_ANALYTICS_LIMITS = {
  teams: 32,
  matchupObservations: 10_000,
  rosterSnapshots: 32,
  rosterEntries: 1_024,
  projectionSets: 16,
  projectionRows: 1_024,
  slotRules: 64,
} as const;

/**
 * Bounded, disclosed, and replayable. The count travels in the response beside the seed so a
 * reader can reproduce a published number exactly rather than take it on trust.
 */
const PLAYOFF_ODDS_SIMULATIONS = 10_000;

/** Bumped only when the seed recipe changes, so an old seed is never silently reinterpreted. */
const PLAYOFF_ODDS_SEED_VERSION = "v1";

/**
 * The playoff simulator is given each team's own scored-week average as its future weekly mean.
 * That is a degraded, disclosed basis rather than a forecast, and the response says so.
 */
const PLAYOFF_FORECAST_BASIS = {
  id: "current-points-per-scored-week",
  label: "Current points per scored week",
  definition:
    "Each team's future weekly scoring mean is its own average official points across weeks with a stored score. No projection set feeds this simulation, weekly volatility falls back to the engine's configured league default rather than a measured team variance, and a team with no scored week falls back to the league scoring mean.",
} as const;

const CANONICAL_POSITIONS = ["QB", "RB", "WR", "TE", "K", "DST", "DL", "LB", "DB", "IDP"] as const;
type CanonicalPosition = (typeof CANONICAL_POSITIONS)[number];
const CANONICAL_POSITION_SET = new Set<string>(CANONICAL_POSITIONS);

const POWER_FACTORS = {
  actual: {
    id: "actual-win-percentage",
    label: "Actual win percentage",
    definition: "Head-to-head wins plus half-ties divided by completed official matchups.",
    weight: 0.3,
    normalization: "ratio",
    higherIsBetter: true,
  },
  allPlay: {
    id: "all-play-win-percentage",
    label: "All-play win percentage",
    definition: "Weekly all-play wins plus half-ties divided by scored peer comparisons.",
    weight: 0.3,
    normalization: "ratio",
    higherIsBetter: true,
  },
  points: {
    id: "points-for-per-week",
    label: "Points per scored week",
    definition: "Average official points across weeks with a stored score.",
    weight: 0.25,
    normalization: "league-percentile",
    higherIsBetter: true,
  },
  positional: {
    id: "positional-strength-percentile",
    label: "Projected positional strength",
    definition: "Average weekly projection percentile across available dedicated positions.",
    weight: 0.15,
    normalization: "zero-to-hundred",
    higherIsBetter: true,
  },
} as const satisfies Record<string, PowerFactorDefinition>;

export interface AnalyticsMembershipRow {
  readonly leagueId: string;
  readonly leagueName: string;
  readonly role: LeagueMembershipRole;
  readonly claimedFantasyTeamId: string | null;
  readonly claimedTeamName: string | null;
}

export interface AnalyticsSeasonRow {
  readonly id: string;
  readonly provider: ProviderName;
  readonly season: number;
  readonly currentWeek: number | null;
  /** The stored provider-normalized settings blob, read only through `parseLeagueRules`. */
  readonly settings: Record<string, unknown>;
  readonly lastSyncedAt: Date | null;
}

export interface AnalyticsTeamRow {
  readonly id: string;
  readonly name: string;
  readonly abbreviation: string | null;
  readonly managerDisplayName: string | null;
  readonly logoUrl: string | null;
}

export interface AnalyticsMatchupObservationRow {
  readonly matchupId: string;
  readonly snapshotId: string;
  readonly effectiveAt: Date;
  readonly externalKey: string;
  readonly providerMatchupId: string;
  readonly week: number;
  readonly status: WeeklyMatchupStatus;
  readonly homeTeamId: string;
  readonly awayTeamId: string;
  readonly homeScore: string | null;
  readonly awayScore: string | null;
}

export interface AnalyticsSlotRuleRow {
  readonly slotCode: string;
  readonly count: number;
  readonly eligiblePositions: string[];
  readonly isStarter: boolean;
}

export interface AnalyticsRosterSnapshotRow {
  readonly id: string;
  readonly teamId: string;
  readonly effectiveAt: Date;
}

export interface AnalyticsRosterEntryRow {
  readonly snapshotId: string;
  readonly playerId: string;
  readonly primaryPosition: string;
}

export interface AnalyticsProjectionSetRow {
  readonly id: string;
  readonly leagueSeasonId: string | null;
  readonly createdByUserId: string | null;
  readonly creatorDisplayName: string;
  readonly visibility: ProjectionVisibility;
  readonly source: string;
  readonly version: string;
  readonly season: number;
  readonly week: number | null;
  readonly horizon: string;
  readonly fetchedAt: Date;
  readonly createdAt: Date;
  readonly metadata: Record<string, unknown>;
}

export interface AnalyticsProjectionRow {
  readonly playerId: string;
  readonly meanPoints: string;
}

export interface LeagueAnalyticsRepository {
  findMembership(userId: string, leagueId: string): Promise<AnalyticsMembershipRow | undefined>;
  findLatestSeason(leagueId: string): Promise<AnalyticsSeasonRow | undefined>;
  listTeams(leagueSeasonId: string, limit: number): Promise<readonly AnalyticsTeamRow[]>;
  listMatchupObservations(
    leagueSeasonId: string,
    limit: number,
  ): Promise<readonly AnalyticsMatchupObservationRow[]>;
  listSlotRules(leagueSeasonId: string, limit: number): Promise<readonly AnalyticsSlotRuleRow[]>;
  listLatestRosterSnapshots(
    leagueSeasonId: string,
    limit: number,
  ): Promise<readonly AnalyticsRosterSnapshotRow[]>;
  listRosterEntries(
    snapshotIds: readonly string[],
    limit: number,
  ): Promise<readonly AnalyticsRosterEntryRow[]>;
  listProjectionSetCandidates(
    actorUserId: string,
    leagueSeasonId: string,
    season: number,
    week: number,
    limit: number,
  ): Promise<readonly AnalyticsProjectionSetRow[]>;
  listProjectionRows(
    projectionSetId: string,
    playerIds: readonly string[],
    limit: number,
  ): Promise<readonly AnalyticsProjectionRow[]>;
  /**
   * The managed (`laces-out-first-party`) weekly projection profile for this league, so a missing
   * accessible projection set can say WHY managed sets were withheld instead of leaving that
   * silent. Optional so existing repository implementations and test doubles are unaffected.
   */
  findManagedProjectionProfile?(leagueSeasonId: string): Promise<ManagedProjectionProfile>;
}

export class DrizzleLeagueAnalyticsRepository implements LeagueAnalyticsRepository {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  async findMembership(
    userId: string,
    leagueId: string,
  ): Promise<AnalyticsMembershipRow | undefined> {
    const [row] = await this.#database
      .select({
        leagueId: leagues.id,
        leagueName: leagues.name,
        role: leagueMemberships.role,
        claimedFantasyTeamId: leagueMemberships.claimedFantasyTeamId,
        claimedTeamName: fantasyTeams.name,
      })
      .from(leagueMemberships)
      .innerJoin(leagues, eq(leagueMemberships.leagueId, leagues.id))
      .leftJoin(fantasyTeams, eq(leagueMemberships.claimedFantasyTeamId, fantasyTeams.id))
      .where(and(eq(leagueMemberships.userId, userId), eq(leagues.id, leagueId)))
      .limit(1);
    return row;
  }

  async findLatestSeason(leagueId: string): Promise<AnalyticsSeasonRow | undefined> {
    const [row] = await this.#database
      .select({
        id: leagueSeasons.id,
        provider: leagueSeasons.provider,
        season: leagueSeasons.season,
        currentWeek: leagueSeasons.currentWeek,
        settings: leagueSeasons.settings,
        lastSyncedAt: leagueSeasons.lastSyncedAt,
      })
      .from(leagueSeasons)
      .where(eq(leagueSeasons.leagueId, leagueId))
      .orderBy(desc(leagueSeasons.season), desc(leagueSeasons.updatedAt), desc(leagueSeasons.id))
      .limit(1);
    return row;
  }

  listTeams(leagueSeasonId: string, limit: number): Promise<readonly AnalyticsTeamRow[]> {
    return this.#database
      .select({
        id: fantasyTeams.id,
        name: fantasyTeams.name,
        abbreviation: fantasyTeams.abbreviation,
        managerDisplayName: fantasyTeams.managerDisplayName,
        logoUrl: fantasyTeams.logoUrl,
      })
      .from(fantasyTeams)
      .where(eq(fantasyTeams.leagueSeasonId, leagueSeasonId))
      .orderBy(asc(fantasyTeams.name), asc(fantasyTeams.id))
      .limit(limit);
  }

  listMatchupObservations(
    leagueSeasonId: string,
    limit: number,
  ): Promise<readonly AnalyticsMatchupObservationRow[]> {
    return this.#database
      .select({
        matchupId: weeklyMatchups.id,
        snapshotId: matchupSnapshots.id,
        effectiveAt: matchupSnapshots.effectiveAt,
        externalKey: weeklyMatchups.externalKey,
        providerMatchupId: weeklyMatchups.providerMatchupId,
        week: weeklyMatchups.week,
        status: weeklyMatchups.status,
        homeTeamId: weeklyMatchups.homeTeamId,
        awayTeamId: weeklyMatchups.awayTeamId,
        homeScore: weeklyMatchups.homeScore,
        awayScore: weeklyMatchups.awayScore,
      })
      .from(weeklyMatchups)
      .innerJoin(matchupSnapshots, eq(weeklyMatchups.snapshotId, matchupSnapshots.id))
      .where(eq(matchupSnapshots.leagueSeasonId, leagueSeasonId))
      .orderBy(
        desc(matchupSnapshots.effectiveAt),
        desc(matchupSnapshots.id),
        desc(weeklyMatchups.id),
      )
      .limit(limit);
  }

  listSlotRules(leagueSeasonId: string, limit: number): Promise<readonly AnalyticsSlotRuleRow[]> {
    return this.#database
      .select({
        slotCode: rosterSlotRules.slotCode,
        count: rosterSlotRules.count,
        eligiblePositions: rosterSlotRules.eligiblePositions,
        isStarter: rosterSlotRules.isStarter,
      })
      .from(rosterSlotRules)
      .where(eq(rosterSlotRules.leagueSeasonId, leagueSeasonId))
      .orderBy(desc(rosterSlotRules.isStarter), asc(rosterSlotRules.slotCode))
      .limit(limit);
  }

  listLatestRosterSnapshots(
    leagueSeasonId: string,
    limit: number,
  ): Promise<readonly AnalyticsRosterSnapshotRow[]> {
    return this.#database
      .selectDistinctOn([rosterSnapshots.teamId], {
        id: rosterSnapshots.id,
        teamId: rosterSnapshots.teamId,
        effectiveAt: rosterSnapshots.effectiveAt,
      })
      .from(rosterSnapshots)
      .innerJoin(fantasyTeams, eq(rosterSnapshots.teamId, fantasyTeams.id))
      .where(eq(fantasyTeams.leagueSeasonId, leagueSeasonId))
      .orderBy(rosterSnapshots.teamId, desc(rosterSnapshots.effectiveAt), desc(rosterSnapshots.id))
      .limit(limit);
  }

  listRosterEntries(
    snapshotIds: readonly string[],
    limit: number,
  ): Promise<readonly AnalyticsRosterEntryRow[]> {
    if (snapshotIds.length === 0) return Promise.resolve([]);
    return this.#database
      .select({
        snapshotId: rosterEntries.snapshotId,
        playerId: rosterEntries.playerId,
        primaryPosition: players.primaryPosition,
      })
      .from(rosterEntries)
      .innerJoin(players, eq(rosterEntries.playerId, players.id))
      .where(inArray(rosterEntries.snapshotId, [...snapshotIds]))
      .orderBy(asc(rosterEntries.snapshotId), asc(players.primaryPosition), asc(players.id))
      .limit(limit);
  }

  async listProjectionSetCandidates(
    actorUserId: string,
    leagueSeasonId: string,
    season: number,
    week: number,
    limit: number,
  ): Promise<readonly AnalyticsProjectionSetRow[]> {
    // A null key silently excludes every `laces-out-first-party` set below with no reason attached
    // to this result. `buildPositionalAnalytics`'s no-projection-set branch recovers that reason via
    // `findManagedProjectionProfile`; a richer per-position reason is available from
    // `currentManagedProjectionProfile` (`./managed-projection-profile.js`) if a future pass wants
    // to attribute the withholding to specific unsupported positions here too.
    const managedProfileKey = await currentManagedProjectionProfileKey(
      this.#database,
      leagueSeasonId,
    );
    const compatibleManagedSet = managedProfileKey
      ? or(
          ne(projectionSets.source, "laces-out-first-party"),
          sql`${projectionSets.metadata}->>'scoringProfileKey' = ${managedProfileKey}`,
        )
      : ne(projectionSets.source, "laces-out-first-party");
    return this.#database
      .select({
        id: projectionSets.id,
        leagueSeasonId: projectionSets.leagueSeasonId,
        createdByUserId: projectionSets.createdByUserId,
        creatorDisplayName: sql<string>`coalesce(${users.displayName}, 'Laces Out model')`,
        visibility: projectionSets.visibility,
        source: projectionSets.source,
        version: projectionSets.version,
        season: projectionSets.season,
        week: projectionSets.week,
        horizon: projectionSets.horizon,
        fetchedAt: projectionSets.fetchedAt,
        createdAt: projectionSets.createdAt,
        metadata: projectionSets.metadata,
      })
      .from(projectionSets)
      .leftJoin(users, eq(projectionSets.createdByUserId, users.id))
      .where(
        and(
          eq(projectionSets.leagueSeasonId, leagueSeasonId),
          eq(projectionSets.season, season),
          eq(projectionSets.week, week),
          eq(projectionSets.horizon, "week"),
          compatibleManagedSet,
          or(
            eq(projectionSets.visibility, "league"),
            and(
              eq(projectionSets.visibility, "private"),
              eq(projectionSets.createdByUserId, actorUserId),
            ),
          ),
        ),
      )
      .orderBy(
        sql`case
          when ${projectionSets.visibility} = 'private' and ${projectionSets.createdByUserId} = ${actorUserId} then 0
          when ${projectionSets.createdByUserId} is not null then 1
          else 2
        end`,
        desc(projectionSets.fetchedAt),
        desc(projectionSets.createdAt),
        desc(projectionSets.id),
      )
      .limit(limit);
  }

  listProjectionRows(
    projectionSetId: string,
    playerIds: readonly string[],
    limit: number,
  ): Promise<readonly AnalyticsProjectionRow[]> {
    if (playerIds.length === 0) return Promise.resolve([]);
    return this.#database
      .select({
        playerId: playerProjections.playerId,
        meanPoints: playerProjections.meanPoints,
      })
      .from(playerProjections)
      .where(
        and(
          eq(playerProjections.projectionSetId, projectionSetId),
          inArray(playerProjections.playerId, [...playerIds]),
        ),
      )
      .orderBy(asc(playerProjections.playerId))
      .limit(limit);
  }

  findManagedProjectionProfile(leagueSeasonId: string): Promise<ManagedProjectionProfile> {
    return currentManagedProjectionProfile(this.#database, leagueSeasonId);
  }
}

function unavailable(reason: LeagueAnalyticsUnavailableReason) {
  return { state: "unavailable" as const, reasons: [reason] };
}

function reason(
  code: LeagueAnalyticsUnavailableReason["code"],
  message: string,
): LeagueAnalyticsUnavailableReason {
  return { code, message };
}

/**
 * Why managed (`laces-out-first-party`) sets are invisible to `listProjectionSetCandidates`'
 * compatibility filter for this league. Mirrors the equivalent text in `in-season-decisions.ts` and
 * `schedule-edge.ts`; kept separate rather than shared because the three surfaces' wire contracts
 * are independent.
 */
function managedProjectionsWithheldReason(profile: ManagedProjectionProfile): string {
  if (profile.key !== null) {
    return "no managed weekly projection set has been published yet for this league's scoring profile";
  }
  if (profile.positions === null) {
    return "the league's stored scoring rules exceeded the bounded read, so they could not be checked";
  }
  return "this league's scoring rules do not normalize to a position Laces Out's managed weekly projections support";
}

function freshness(
  observedAt: Date | null,
  now: Date,
  label: string,
  freshHours: number,
  agingHours: number,
  missingLabel = `No ${label}`,
): Freshness {
  if (!observedAt) return { state: "missing", observedAt: null, label: missingLabel };
  const ageHours = Math.max(0, now.getTime() - observedAt.getTime()) / 3_600_000;
  const state = ageHours <= freshHours ? "fresh" : ageHours <= agingHours ? "aging" : "stale";
  return {
    state,
    observedAt: observedAt.toISOString(),
    label: `${label} checked ${ageHours < 1 ? "less than an hour" : `${Math.floor(ageHours)}h`} ago`,
  };
}

function laterObservation(
  left: AnalyticsMatchupObservationRow,
  right: AnalyticsMatchupObservationRow,
): AnalyticsMatchupObservationRow {
  const timestamp = left.effectiveAt.getTime() - right.effectiveAt.getTime();
  if (timestamp !== 0) return timestamp > 0 ? left : right;
  const snapshot = left.snapshotId.localeCompare(right.snapshotId);
  if (snapshot !== 0) return snapshot > 0 ? left : right;
  return left.matchupId.localeCompare(right.matchupId) >= 0 ? left : right;
}

/** Latest observation per provider matchup and week, independent of repository row order. */
export function deduplicateMatchupObservations(
  rows: readonly AnalyticsMatchupObservationRow[],
): readonly AnalyticsMatchupObservationRow[] {
  const latest = new Map<string, AnalyticsMatchupObservationRow>();
  for (const row of rows) {
    const key = `${row.week}\u0000${row.providerMatchupId}`;
    const current = latest.get(key);
    latest.set(key, current ? laterObservation(current, row) : row);
  }
  return [...latest.values()].sort(
    (left, right) =>
      left.week - right.week ||
      left.providerMatchupId.localeCompare(right.providerMatchupId) ||
      left.matchupId.localeCompare(right.matchupId),
  );
}

function latestRosterSnapshots(
  rows: readonly AnalyticsRosterSnapshotRow[],
): readonly AnalyticsRosterSnapshotRow[] {
  const latest = new Map<string, AnalyticsRosterSnapshotRow>();
  for (const row of rows) {
    const current = latest.get(row.teamId);
    if (
      !current ||
      row.effectiveAt.getTime() > current.effectiveAt.getTime() ||
      (row.effectiveAt.getTime() === current.effectiveAt.getTime() && row.id > current.id)
    ) {
      latest.set(row.teamId, row);
    }
  }
  return [...latest.values()].sort((left, right) => left.teamId.localeCompare(right.teamId));
}

function numberOrNull(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function identity(team: AnalyticsTeamRow, claimedTeamId: string | null): LeagueAnalyticsTeam {
  return {
    id: team.id,
    name: team.name,
    abbreviation: team.abbreviation,
    managerDisplayName: team.managerDisplayName,
    logoUrl: team.logoUrl,
    isCurrentUser: team.id === claimedTeamId,
  };
}

interface BuiltScoreAnalytics {
  readonly section: LeagueScoreAnalyticsSection;
  readonly engine: LeagueSeasonAnalyticsResult | null;
  /** The admitted per-week inputs, reused by the awards section so both read identical facts. */
  readonly weeks: readonly LeagueWeekInput[];
}

function buildScoreAnalytics(
  teams: readonly AnalyticsTeamRow[],
  observations: readonly AnalyticsMatchupObservationRow[],
  claimedTeamId: string | null,
): BuiltScoreAnalytics {
  if (observations.length === 0) {
    return {
      section: unavailable(
        reason("MATCHUPS_MISSING", "No matchup snapshots have been synchronized for this season."),
      ),
      engine: null,
      weeks: [],
    };
  }

  const teamIds = new Set(teams.map((team) => team.id));
  const valid = observations.filter(
    (row) => teamIds.has(row.homeTeamId) && teamIds.has(row.awayTeamId),
  );
  const unknownRows = observations.length - valid.length;
  const finals = valid.filter((row) => row.status === "final");
  const weeks = [...new Set(finals.map((row) => row.week))].sort((a, b) => a - b);
  const warnings: string[] = [];
  if (unknownRows > 0) {
    warnings.push(
      `${unknownRows} matchup observations referenced teams outside this league season and were excluded.`,
    );
  }

  const weekInputs = weeks.map((week) => {
    const rows = finals.filter((row) => row.week === week);
    const scores = new Map<string, number>();
    const conflicts = new Set<string>();
    const addScore = (teamId: string, score: number | null) => {
      if (score === null || conflicts.has(teamId)) return;
      const existing = scores.get(teamId);
      if (existing !== undefined && existing !== score) {
        scores.delete(teamId);
        conflicts.add(teamId);
        return;
      }
      scores.set(teamId, score);
    };
    for (const row of rows) {
      addScore(row.homeTeamId, numberOrNull(row.homeScore));
      addScore(row.awayTeamId, numberOrNull(row.awayScore));
    }
    if (conflicts.size > 0) {
      warnings.push(
        `Week ${week} had conflicting official scores for ${conflicts.size} team${conflicts.size === 1 ? "" : "s"}; those scores remain missing.`,
      );
    }
    return {
      week,
      performances: [...scores].map(([teamId, points]) => ({ teamId, points })),
      matchups: rows.map((row) => ({ teamAId: row.homeTeamId, teamBId: row.awayTeamId })),
    };
  });

  const engine = analyzeLeagueSeason({
    teams: teams.map((team) => ({ teamId: team.id })),
    weeks: weekInputs,
  });
  const completeFinals = finals.filter(
    (row) => numberOrNull(row.homeScore) !== null && numberOrNull(row.awayScore) !== null,
  ).length;
  const incompleteFinals = finals.length - completeFinals;
  if (incompleteFinals > 0) {
    warnings.push(
      `${incompleteFinals} final matchup${incompleteFinals === 1 ? " has" : "s have"} a missing score; no result was inferred.`,
    );
  }
  const byTeam = new Map(teams.map((team) => [team.id, team]));
  const definitions = engine.definitions.filter(
    (definition) => definition.id !== "lineup-efficiency",
  );
  return {
    engine,
    weeks: weekInputs,
    section: {
      state: "available",
      weeks: [...engine.weeks],
      officialFinalMatchups: completeFinals,
      incompleteFinalMatchups: incompleteFinals,
      teams: engine.teams.flatMap((metrics) => {
        const team = byTeam.get(metrics.teamId);
        return team
          ? [
              {
                team: identity(team, claimedTeamId),
                scoringWeeks: metrics.scoringWeeks,
                missingScoringWeeks: [...metrics.missingScoringWeeks],
                completedMatchups: metrics.completedMatchups,
                incompleteMatchups: metrics.incompleteMatchups,
                pointsFor: {
                  total: metrics.pointsFor.total,
                  average: metrics.pointsFor.average,
                  sampleSize: metrics.pointsFor.sampleSize,
                },
                pointsAgainst: {
                  total: metrics.pointsAgainst.total,
                  average: metrics.pointsAgainst.average,
                  sampleSize: metrics.pointsAgainst.sampleSize,
                },
                actualRecord: {
                  wins: metrics.actualRecord.wins,
                  losses: metrics.actualRecord.losses,
                  ties: metrics.actualRecord.ties,
                  games: metrics.actualRecord.games,
                  winPercentage: metrics.actualRecord.winPercentage,
                },
                allPlay: {
                  wins: metrics.allPlay.wins,
                  losses: metrics.allPlay.losses,
                  ties: metrics.allPlay.ties,
                  games: metrics.allPlay.games,
                  winPercentage: metrics.allPlay.winPercentage,
                },
                expectedWins: metrics.expectedWins.expectedWins,
                actualWinEquivalents: metrics.expectedWins.actualWinEquivalents,
                luckWins: metrics.expectedWins.luckWins,
                eligibleExpectedMatchups: metrics.expectedWins.eligibleMatchups,
              },
            ]
          : [];
      }),
      definitions,
      warnings: warnings.slice(0, 20),
    },
  };
}

function dedicatedStarterCounts(
  rows: readonly AnalyticsSlotRuleRow[],
): Map<CanonicalPosition, number> {
  const counts = new Map<CanonicalPosition, number>();
  for (const row of rows) {
    if (!row.isStarter || row.count <= 0) continue;
    const eligible = [...new Set(row.eligiblePositions.map((item) => item.toUpperCase()))];
    const [only] = eligible;
    if (eligible.length !== 1 || !only || !CANONICAL_POSITION_SET.has(only)) continue;
    const position = only as CanonicalPosition;
    counts.set(position, (counts.get(position) ?? 0) + row.count);
  }
  return counts;
}

function projectionSourceLabel(row: AnalyticsProjectionSetRow): string {
  const value = row.metadata.sourceLabel;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : row.source;
}

export function selectAccessibleProjectionSet(
  candidates: readonly AnalyticsProjectionSetRow[],
  actorUserId: string,
  leagueSeasonId: string,
  season: number,
  week: number,
): AnalyticsProjectionSetRow | undefined {
  const priority = (row: AnalyticsProjectionSetRow): number => {
    if (row.visibility === "private" && row.createdByUserId === actorUserId) return 0;
    if (row.createdByUserId !== null) return 1;
    return 2;
  };
  return candidates
    .filter(
      (row) =>
        row.leagueSeasonId === leagueSeasonId &&
        row.season === season &&
        row.week === week &&
        row.horizon === "week" &&
        (row.visibility === "league" ||
          (row.visibility === "private" && row.createdByUserId === actorUserId)),
    )
    .sort(
      (left, right) =>
        priority(left) - priority(right) ||
        right.fetchedAt.getTime() - left.fetchedAt.getTime() ||
        right.createdAt.getTime() - left.createdAt.getTime() ||
        right.id.localeCompare(left.id),
    )[0];
}

interface BuiltPositionalAnalytics {
  readonly section: LeaguePositionalAnalyticsSection;
  readonly averageByTeam: ReadonlyMap<string, number | null>;
}

function buildPositionalAnalytics(input: {
  readonly teams: readonly AnalyticsTeamRow[];
  readonly claimedTeamId: string | null;
  readonly slotRules: readonly AnalyticsSlotRuleRow[];
  readonly snapshots: readonly AnalyticsRosterSnapshotRow[];
  readonly rosterEntries: readonly AnalyticsRosterEntryRow[];
  readonly projectionRows: readonly AnalyticsProjectionRow[];
  readonly projectionSet: AnalyticsProjectionSetRow | undefined;
  readonly week: number | null;
  /** Present only when `projectionSet` is missing for a known week; explains a managed exclusion. */
  readonly managedProfile?: ManagedProjectionProfile;
}): BuiltPositionalAnalytics {
  const empty = new Map<string, number | null>();
  if (input.week === null) {
    return {
      section: unavailable(
        reason(
          "PROJECTION_WEEK_UNKNOWN",
          "The league has no current week for an exact weekly projection match.",
        ),
      ),
      averageByTeam: empty,
    };
  }
  if (!input.projectionSet) {
    const base = `No accessible Week ${input.week} projection set exists for this exact league season.`;
    return {
      section: unavailable(
        reason(
          "PROJECTIONS_MISSING",
          input.managedProfile
            ? `${base} Laces Out's managed weekly projections are withheld: ${managedProjectionsWithheldReason(input.managedProfile)}.`
            : base,
        ),
      ),
      averageByTeam: empty,
    };
  }
  const counts = dedicatedStarterCounts(input.slotRules);
  if (counts.size === 0) {
    return {
      section: unavailable(
        reason(
          "DEDICATED_STARTERS_MISSING",
          "No single-position starter slots are available; flex slots are deliberately excluded to avoid double-counting.",
        ),
      ),
      averageByTeam: empty,
    };
  }
  if (input.snapshots.length === 0) {
    return {
      section: unavailable(
        reason("ROSTERS_MISSING", "No current team rosters are available for positional analysis."),
      ),
      averageByTeam: empty,
    };
  }

  const snapshotTeam = new Map(input.snapshots.map((snapshot) => [snapshot.id, snapshot.teamId]));
  const entriesByTeam = new Map<string, AnalyticsRosterEntryRow[]>();
  for (const entry of input.rosterEntries) {
    const teamId = snapshotTeam.get(entry.snapshotId);
    if (!teamId) continue;
    entriesByTeam.set(teamId, [...(entriesByTeam.get(teamId) ?? []), entry]);
  }
  const projectionByPlayer = new Map(
    input.projectionRows.flatMap((row) => {
      const points = numberOrNull(row.meanPoints);
      return points === null ? [] : [[row.playerId, points] as const];
    }),
  );
  const positions = [...counts.keys()];
  const values: { teamId: string; position: string; value: number }[] = [];
  const coverage = new Map<
    string,
    { readonly rosterPlayerCount: number; readonly projectedPlayerCount: number }
  >();
  for (const team of input.teams) {
    const entries = entriesByTeam.get(team.id) ?? [];
    for (const position of positions) {
      const roster = entries.filter((entry) => entry.primaryPosition.toUpperCase() === position);
      const projected = roster.flatMap((entry) => {
        const points = projectionByPlayer.get(entry.playerId);
        return points === undefined ? [] : [points];
      });
      coverage.set(`${team.id}\u0000${position}`, {
        rosterPlayerCount: roster.length,
        projectedPlayerCount: projected.length,
      });
      const required = counts.get(position) ?? 0;
      // Missing projections remain unknown. Requiring complete position-level roster coverage
      // avoids assuming an unprojected bench player cannot belong in the top N.
      if (roster.length < required || projected.length !== roster.length) continue;
      const value = [...projected]
        .sort((left, right) => right - left)
        .slice(0, required)
        .reduce((sum, points) => sum + points, 0);
      values.push({ teamId: team.id, position, value });
    }
  }
  if (values.length === 0) {
    return {
      section: unavailable(
        reason(
          "ROSTER_COVERAGE_INCOMPLETE",
          "No team-position has complete roster projection coverage for its dedicated starter count.",
        ),
      ),
      averageByTeam: empty,
    };
  }

  const basisDefinition =
    "For each canonical position, sum the highest N mean weekly projections on the latest team roster. N is the count of starter slots eligible for that position alone. Flex and multi-position slots are excluded. A team-position stays missing unless every rostered player at that primary position has a projection and at least N players are present.";
  const analyzed = analyzePositionalStrength({
    teamIds: input.teams.map((team) => team.id),
    positions,
    values,
    basis: {
      id: "weekly-dedicated-starters",
      label: "Projected dedicated starters",
      definition: basisDefinition,
    },
  });
  const teamById = new Map(input.teams.map((team) => [team.id, team]));
  const averageByTeam = new Map(
    analyzed.teams.map((team) => [team.teamId, team.averagePercentile]),
  );
  return {
    averageByTeam,
    section: {
      state: "available",
      basis: {
        id: "weekly-dedicated-starters",
        label: "Projected dedicated starters",
        definition: basisDefinition,
        starterCounts: Object.fromEntries(counts),
      },
      positions,
      teams: analyzed.teams.flatMap((summary) => {
        const team = teamById.get(summary.teamId);
        if (!team) return [];
        const available = summary.entries.filter(
          (entry) => entry.status === "available" && entry.percentile !== null,
        );
        const strengths = available
          .filter((entry) => (entry.percentile ?? 0) >= 60)
          .sort(
            (left, right) =>
              (right.percentile ?? 0) - (left.percentile ?? 0) ||
              left.position.localeCompare(right.position),
          )
          .slice(0, 2)
          .map((entry) => entry.position as CanonicalPosition);
        const weaknesses = available
          .filter((entry) => (entry.percentile ?? 100) <= 40)
          .sort(
            (left, right) =>
              (left.percentile ?? 100) - (right.percentile ?? 100) ||
              left.position.localeCompare(right.position),
          )
          .slice(0, 2)
          .map((entry) => entry.position as CanonicalPosition);
        return [
          {
            team: identity(team, input.claimedTeamId),
            averagePercentile: summary.averagePercentile,
            coverage: summary.coverage,
            strengths,
            weaknesses,
            entries: summary.entries.map((entry) => {
              const detail = coverage.get(`${team.id}\u0000${entry.position}`) ?? {
                rosterPlayerCount: 0,
                projectedPlayerCount: 0,
              };
              return {
                position: entry.position as CanonicalPosition,
                status: entry.status,
                projectedPoints: entry.value,
                leagueMean: entry.leagueMean,
                strengthPercentile: entry.percentile,
                strengthZScore: entry.strengthZScore,
                rank: entry.rank,
                starterCount: counts.get(entry.position as CanonicalPosition) ?? 1,
                ...detail,
              };
            }),
          },
        ];
      }),
      definition: analyzed.definition.definition,
    },
  };
}

function buildPowerAnalytics(
  teams: readonly AnalyticsTeamRow[],
  claimedTeamId: string | null,
  scores: BuiltScoreAnalytics,
  positional: BuiltPositionalAnalytics,
): LeaguePowerAnalyticsSection {
  const factors: PowerFactorDefinition[] = [];
  if (scores.section.state === "available") {
    factors.push(POWER_FACTORS.actual, POWER_FACTORS.allPlay, POWER_FACTORS.points);
  }
  if (positional.section.state === "available") factors.push(POWER_FACTORS.positional);
  if (factors.length === 0) {
    return unavailable(
      reason(
        "MATCHUPS_MISSING",
        "Power rankings need official score history or an accessible projection-backed positional section.",
      ),
    );
  }
  type AvailableScoreTeam = Extract<
    LeagueScoreAnalyticsSection,
    { state: "available" }
  >["teams"][number];
  const scoreByTeam = new Map<string, AvailableScoreTeam>();
  if (scores.section.state === "available") {
    for (const team of scores.section.teams) scoreByTeam.set(team.team.id, team);
  }
  const calculated = calculatePowerRankings({
    factors,
    teams: teams.map((team) => {
      const score = scoreByTeam.get(team.id);
      return {
        teamId: team.id,
        factorValues: {
          [POWER_FACTORS.actual.id]: score?.actualRecord.winPercentage ?? null,
          [POWER_FACTORS.allPlay.id]: score?.allPlay.winPercentage ?? null,
          [POWER_FACTORS.points.id]: score?.pointsFor.average ?? null,
          [POWER_FACTORS.positional.id]: positional.averageByTeam.get(team.id) ?? null,
        },
      };
    }),
  });
  const teamById = new Map(teams.map((team) => [team.id, team]));
  return {
    state: "available",
    factors: calculated.factors.map((factor) => ({
      id: factor.id,
      label: factor.label,
      definition: factor.definition,
      configuredWeight: factor.weight,
    })),
    rankings: calculated.rankings.flatMap((ranking) => {
      const team = teamById.get(ranking.teamId);
      return team
        ? [
            {
              team: identity(team, claimedTeamId),
              rank: ranking.rank,
              score: ranking.score,
              tiedOnScore: ranking.tiedOnScore,
              dataCoverage: ranking.dataCoverage,
              contributions: ranking.factors.map((factor) => ({
                id: factor.id,
                rawValue: factor.rawValue,
                normalizedScore: factor.normalizedScore,
                effectiveWeight: factor.effectiveWeight,
                contribution: factor.contribution,
                included: factor.included,
              })),
            },
          ]
        : [];
    }),
    definition: calculated.definition,
    tieBreaker: calculated.tieBreaker,
  };
}

function average(values: readonly (number | null)[]): number | null {
  const available = values.filter((value): value is number => value !== null);
  return available.length === 0
    ? null
    : available.reduce((sum, value) => sum + value, 0) / available.length;
}

/**
 * Every week the admitted evidence can award, ascending. Computed once so the snapshot can
 * publish the selectable list and the award builder can validate a requested week against it.
 */
function buildAwardableWeeks(
  teams: readonly AnalyticsTeamRow[],
  scores: BuiltScoreAnalytics,
): readonly number[] {
  if (scores.section.state === "unavailable") return [];
  return awardableWeeks({
    teams: teams.map((team) => ({ teamId: team.id })),
    weeks: scores.weeks,
  });
}

/**
 * The Weekly Reckoning for a requested week, or for the most recent week the admitted evidence
 * can award. Awards the data does not support are withheld individually with their reason; none
 * are ever inferred, and a requested week is never silently swapped for a different one.
 */
function buildWeeklyAwards(
  teams: readonly AnalyticsTeamRow[],
  claimedTeamId: string | null,
  scores: BuiltScoreAnalytics,
  available: readonly number[],
  requestedWeek?: number,
): LeagueWeeklyAwardsSection {
  if (scores.section.state === "unavailable") {
    return { state: "unavailable", reasons: [...scores.section.reasons] };
  }
  const engineInput = {
    teams: teams.map((team) => ({ teamId: team.id })),
    weeks: scores.weeks,
  };
  if (requestedWeek !== undefined && !available.includes(requestedWeek)) {
    return unavailable(
      reason(
        "AWARDS_WEEK_UNAVAILABLE",
        `Week ${requestedWeek} does not carry the final scores an award requires.`,
      ),
    );
  }
  const week = requestedWeek ?? available.at(-1) ?? null;
  if (week === null) {
    return unavailable(
      reason(
        "AWARDS_WEEK_UNAVAILABLE",
        "No completed week yet carries the final scores an award requires.",
      ),
    );
  }
  const result = calculateWeeklyAwards({ ...engineInput, week });
  const byTeam = new Map(teams.map((team) => [team.id, team]));
  const identify = (teamId: string | null) => {
    const team = teamId === null ? undefined : byTeam.get(teamId);
    return team ? identity(team, claimedTeamId) : null;
  };
  return {
    state: "available",
    week: result.week,
    awards: result.awards.flatMap((award) => {
      const team = identify(award.teamId);
      if (!team) return [];
      return [
        {
          id: award.id,
          label: award.label,
          definition: award.definition,
          team,
          value: award.value,
          unit: award.unit,
          detail: {
            opponentTeam: identify(award.detail.opponentTeamId),
            teamPoints: award.detail.teamPoints,
            opponentPoints: award.detail.opponentPoints,
            allPlayWins: award.detail.allPlayWins,
            allPlayGames: award.detail.allPlayGames,
          },
        },
      ];
    }),
    withheld: result.withheld.map((entry) => ({
      id: entry.id,
      label: entry.label,
      reasons: entry.reasons.map((item) => ({ code: item.code, message: item.message })),
    })),
    definitions: result.definitions.map((definition) => ({
      id: definition.id,
      label: definition.label,
      definition: definition.definition,
    })),
  };
}

/**
 * The snapshot the deduplicator's own precedence rule keeps last. Reusing `laterObservation` means
 * the seed is pinned to exactly the evidence the simulation ran on, not to a separately guessed
 * "newest" row.
 */
function effectiveMatchupSnapshotId(
  observations: readonly AnalyticsMatchupObservationRow[],
): string | null {
  const latest = observations.reduce<AnalyticsMatchupObservationRow | null>(
    (current, row) => (current === null ? row : laterObservation(current, row)),
    null,
  );
  return latest === null ? null : latest.snapshotId;
}

/**
 * The deterministic seed required by ADR 0003. It is a pure function of the league season, the
 * week being simulated, and the effective matchup snapshot, so repeating a request against
 * unchanged league state replays an identical result, while a newly synchronized snapshot reseeds
 * the run. Nothing time-varying participates.
 */
function playoffOddsSeed(input: {
  readonly leagueSeasonId: string;
  readonly currentWeek: number | null;
  readonly matchupSnapshotId: string | null;
}): string {
  return [
    "playoff-odds",
    PLAYOFF_ODDS_SEED_VERSION,
    input.leagueSeasonId,
    `week-${input.currentWeek ?? "unknown"}`,
    `snapshot-${input.matchupSnapshotId ?? "none"}`,
  ].join(":");
}

/**
 * Names why the assembler withheld the simulation. `buildPlayoffOddsInput` fails closed with a
 * bare null, so this re-checks its rejection conditions in the same order to report which one
 * fired. "Playoff odds are unavailable" with no cause would not be an answer.
 */
function withheldPlayoffOddsReason(input: {
  readonly playoffTeamCount: number;
  readonly teams: readonly PlayoffOddsTeamRow[];
  readonly matchups: readonly PlayoffOddsMatchupRow[];
}): LeagueAnalyticsUnavailableReason {
  if (input.teams.length < 2) {
    return reason(
      "PLAYOFF_FIELD_UNSUPPORTED",
      `A playoff race needs at least two teams with a stored record; ${input.teams.length} were available.`,
    );
  }
  if (input.playoffTeamCount > input.teams.length) {
    return reason(
      "PLAYOFF_FIELD_UNSUPPORTED",
      `The league host reports a ${input.playoffTeamCount}-team playoff field, but only ${input.teams.length} teams are synchronized for this season.`,
    );
  }
  const remaining = input.matchups.filter((row) => row.status !== "final");
  if (remaining.length === 0) {
    return reason(
      "PLAYOFF_SEASON_COMPLETE",
      "Every stored matchup for this season is final, so no remaining game is left to simulate.",
    );
  }
  const known = new Set(input.teams.map((team) => team.teamId));
  const orphan = remaining.find((row) => !known.has(row.homeTeamId) || !known.has(row.awayTeamId));
  if (orphan) {
    return reason(
      "PLAYOFF_SCHEDULE_INCOMPLETE",
      `The remaining Week ${orphan.week} schedule references a team missing from the standings, so the games left to play could not be read completely.`,
    );
  }
  return reason(
    "PLAYOFF_SCHEDULE_INCOMPLETE",
    "The remaining schedule could not be assembled into a complete simulation input; no partial result was produced.",
  );
}

/**
 * Seeded playoff odds for the remaining schedule. Records, points, and the admitted matchup set
 * are reused from the sections already computed above so the simulation reads exactly the facts
 * the rest of the response reports.
 */
function buildPlayoffOdds(input: {
  readonly teams: readonly AnalyticsTeamRow[];
  readonly claimedTeamId: string | null;
  readonly scores: BuiltScoreAnalytics;
  readonly matchups: readonly AnalyticsMatchupObservationRow[];
  readonly rules: LeagueRules;
  readonly seed: string;
  readonly matchupSnapshotId: string | null;
}): LeaguePlayoffOddsSection {
  if (input.scores.section.state === "unavailable") {
    return { state: "unavailable", reasons: [...input.scores.section.reasons] };
  }
  if (input.rules.playoffTeamCount === null) {
    // Named from `rules.missing` so the response says which rule the provider never supplied.
    const missingRule = input.rules.missing.find((name) => name === "playoffTeamCount");
    return unavailable(
      reason(
        "PLAYOFF_RULES_MISSING",
        `The league host did not supply a usable ${missingRule ?? "playoffTeamCount"} rule, so the playoff field size is unknown; odds are withheld rather than assuming one.`,
      ),
    );
  }

  const scoreByTeam = new Map(input.scores.section.teams.map((team) => [team.team.id, team]));
  const teamRows: PlayoffOddsTeamRow[] = input.teams.flatMap((team) => {
    const metrics = scoreByTeam.get(team.id);
    if (!metrics) return [];
    return [
      {
        teamId: team.id,
        wins: metrics.actualRecord.wins,
        losses: metrics.actualRecord.losses,
        ties: metrics.actualRecord.ties,
        pointsFor: metrics.pointsFor.total,
        // The scored-week average is the honest weekly mean. Letting the engine divide season
        // points by head-to-head games instead would inflate any team whose completed matchup is
        // missing an official score.
        ...(metrics.pointsFor.average === null
          ? {}
          : { projectedPointsPerWeek: metrics.pointsFor.average }),
      },
    ];
  });
  const matchupRows: PlayoffOddsMatchupRow[] = input.matchups.map((row) => ({
    week: row.week,
    status: row.status,
    homeTeamId: row.homeTeamId,
    awayTeamId: row.awayTeamId,
    homeScore: numberOrNull(row.homeScore),
    awayScore: numberOrNull(row.awayScore),
  }));

  const assembled = buildPlayoffOddsInput({
    matchups: matchupRows,
    teams: teamRows,
    playoffTeamCount: input.rules.playoffTeamCount,
    seed: input.seed,
    simulations: PLAYOFF_ODDS_SIMULATIONS,
  });
  if (assembled === null) {
    return unavailable(
      withheldPlayoffOddsReason({
        playoffTeamCount: input.rules.playoffTeamCount,
        teams: teamRows,
        matchups: matchupRows,
      }),
    );
  }

  let result: PlayoffOddsResult;
  try {
    result = simulatePlayoffOdds(assembled);
  } catch (error) {
    // A rejected input degrades this section only; the rest of the response is unaffected.
    const detail = error instanceof Error ? error.message : "unknown validation failure";
    return unavailable(
      reason(
        "PLAYOFF_SIMULATION_UNSUPPORTED",
        `The playoff simulator rejected this league's stored state: ${detail.slice(0, 300)}`,
      ),
    );
  }

  const teamById = new Map(input.teams.map((team) => [team.id, team]));
  return {
    state: "available",
    playoffTeamCount: result.playoffTeamCount,
    seed: input.seed,
    simulations: result.simulations,
    matchupSnapshotId: input.matchupSnapshotId,
    remainingMatchups: assembled.remainingMatchups.length,
    forecastBasis: PLAYOFF_FORECAST_BASIS,
    samplingErrorDefinition: result.teams[0]?.explanation ?? null,
    teams: result.teams.flatMap((odds) => {
      const team = teamById.get(odds.teamId);
      return team
        ? [
            {
              team: identity(team, input.claimedTeamId),
              playoffProbability: odds.playoffProbability,
              monteCarloStandardError: odds.monteCarloStandardError,
              expectedSeed: odds.expectedSeed,
              seedProbabilities: odds.seedProbabilities.map((entry) => ({
                seed: entry.seed,
                probability: entry.probability,
              })),
              averageFinalWins: odds.averageFinalWins,
              averageFinalLosses: odds.averageFinalLosses,
              averageFinalTies: odds.averageFinalTies,
              averageFinalPointsFor: odds.averageFinalPointsFor,
              scoringMean: odds.scoringMean,
              scoringStandardDeviation: odds.scoringStandardDeviation,
            },
          ]
        : [];
    }),
    definition: result.definition,
    factors: [...result.factors],
    tieBreakers: [...result.tieBreakers],
  };
}

function buildOpponentAnalytics(input: {
  readonly teams: readonly AnalyticsTeamRow[];
  readonly claimedTeamId: string | null;
  readonly currentWeek: number | null;
  readonly matchups: readonly AnalyticsMatchupObservationRow[];
  readonly scores: BuiltScoreAnalytics;
  readonly positional: BuiltPositionalAnalytics;
  readonly power: LeaguePowerAnalyticsSection;
}): LeagueOpponentScoutSection {
  if (!input.claimedTeamId) {
    return unavailable(
      reason(
        "TEAM_UNCLAIMED",
        "Select your fantasy team in Settings to receive a current-opponent scout.",
      ),
    );
  }
  const subject = input.teams.find((team) => team.id === input.claimedTeamId);
  if (!subject) {
    return unavailable(
      reason("TEAM_UNCLAIMED", "The selected team is not part of the latest league season."),
    );
  }
  if (input.currentWeek === null) {
    return unavailable(
      reason(
        "OPPONENT_MISSING",
        "The league has no current week from which to identify an opponent.",
      ),
    );
  }
  const matchup = input.matchups
    .filter(
      (row) =>
        row.week === input.currentWeek &&
        (row.homeTeamId === subject.id || row.awayTeamId === subject.id),
    )
    .sort(
      (left, right) =>
        left.providerMatchupId.localeCompare(right.providerMatchupId) ||
        left.matchupId.localeCompare(right.matchupId),
    )[0];
  if (!matchup) {
    return unavailable(
      reason("OPPONENT_MISSING", `No Week ${input.currentWeek} matchup is stored for your team.`),
    );
  }
  const opponentId = matchup.homeTeamId === subject.id ? matchup.awayTeamId : matchup.homeTeamId;
  const opponent = input.teams.find((team) => team.id === opponentId);
  if (!opponent) {
    return unavailable(
      reason("OPPONENT_MISSING", "The stored current matchup references an unknown opponent."),
    );
  }
  const scoreTeams = input.scores.section.state === "available" ? input.scores.section.teams : [];
  const subjectScore = scoreTeams.find((team) => team.team.id === subject.id);
  const opponentScore = scoreTeams.find((team) => team.team.id === opponent.id);
  const powerTeams = input.power.state === "available" ? input.power.rankings : [];
  const subjectPower = powerTeams.find((team) => team.team.id === subject.id)?.score ?? null;
  const opponentPower = powerTeams.find((team) => team.team.id === opponent.id)?.score ?? null;
  const scoreMetric = (
    id: string,
    label: string,
    definition: string,
    subjectValue: number | null,
    opponentValue: number | null,
    peers: readonly (number | null)[],
    unit?: string,
  ) => ({
    id,
    label,
    definition,
    subjectValue,
    opponentValue,
    leagueAverage: average(peers),
    ...(unit ? { unit } : {}),
  });
  const metrics = [
    scoreMetric(
      "points-for-per-week",
      "Points per scored week",
      "Average official points across weeks with a stored score.",
      subjectScore?.pointsFor.average ?? null,
      opponentScore?.pointsFor.average ?? null,
      scoreTeams.map((team) => team.pointsFor.average),
      "pts",
    ),
    scoreMetric(
      "actual-win-percentage",
      "Actual win percentage",
      "Wins plus half-ties divided by completed head-to-head matchups.",
      subjectScore?.actualRecord.winPercentage ?? null,
      opponentScore?.actualRecord.winPercentage ?? null,
      scoreTeams.map((team) => team.actualRecord.winPercentage),
      "%",
    ),
    scoreMetric(
      "all-play-win-percentage",
      "All-play win percentage",
      "Wins plus half-ties across weekly comparisons with every scored league peer.",
      subjectScore?.allPlay.winPercentage ?? null,
      opponentScore?.allPlay.winPercentage ?? null,
      scoreTeams.map((team) => team.allPlay.winPercentage),
      "%",
    ),
    scoreMetric(
      "power-score",
      "Power score",
      "The disclosed, availability-weighted league power composite.",
      subjectPower,
      opponentPower,
      powerTeams.map((team) => team.score),
      "/100",
    ),
    scoreMetric(
      "positional-strength-percentile",
      "Positional strength",
      "Average percentile across projection-backed dedicated positions.",
      input.positional.averageByTeam.get(subject.id) ?? null,
      input.positional.averageByTeam.get(opponent.id) ?? null,
      [...input.positional.averageByTeam.values()],
      "pctile",
    ),
  ];
  const scout = buildOpponentScout({
    subjectTeamId: subject.id,
    opponentTeamId: opponent.id,
    metrics,
  });
  return {
    state: "available",
    week: input.currentWeek,
    matchupStatus: matchup.status,
    subject: identity(subject, input.claimedTeamId),
    opponent: identity(opponent, input.claimedTeamId),
    metrics: scout.metrics.map((metric) => ({
      id: metric.id,
      label: metric.label,
      definition: metric.definition,
      unit: metric.unit,
      subjectValue: metric.subjectValue,
      opponentValue: metric.opponentValue,
      leagueAverage: metric.leagueAverage,
      subjectAdvantage: metric.subjectAdvantage,
      edgeOwner: metric.edgeOwner,
    })),
    subjectAdvantages: [...scout.subjectAdvantages],
    opponentAdvantages: [...scout.opponentAdvantages],
    definition: scout.definition,
  };
}

export class LeagueAnalyticsService {
  readonly #repository: LeagueAnalyticsRepository;
  readonly #clock: () => Date;

  constructor(repository: LeagueAnalyticsRepository, clock: () => Date = () => new Date()) {
    this.#repository = repository;
    this.#clock = clock;
  }

  async getSnapshot(
    actorUserId: string,
    leagueId: string,
    options?: {
      /**
       * Target a specific completed week's awards instead of the latest. Out-of-range or
       * unawardable weeks make the awards section unavailable rather than falling back.
       */
      readonly weeklyAwardsWeek?: number;
    },
  ): Promise<LeagueAnalyticsSnapshot | undefined> {
    const membership = await this.#repository.findMembership(actorUserId, leagueId);
    if (!membership) return undefined;
    const now = this.#clock();
    const season = await this.#repository.findLatestSeason(leagueId);
    if (!season) return this.#noSeason(membership, now);

    const [teamRows, observationRows, slotRuleRows, rosterSnapshotRows, projectionCandidates] =
      await Promise.all([
        this.#repository.listTeams(season.id, LEAGUE_ANALYTICS_LIMITS.teams + 1),
        this.#repository.listMatchupObservations(
          season.id,
          LEAGUE_ANALYTICS_LIMITS.matchupObservations + 1,
        ),
        this.#repository.listSlotRules(season.id, LEAGUE_ANALYTICS_LIMITS.slotRules + 1),
        this.#repository.listLatestRosterSnapshots(
          season.id,
          LEAGUE_ANALYTICS_LIMITS.rosterSnapshots + 1,
        ),
        season.currentWeek === null
          ? Promise.resolve([])
          : this.#repository.listProjectionSetCandidates(
              actorUserId,
              season.id,
              season.season,
              season.currentWeek,
              LEAGUE_ANALYTICS_LIMITS.projectionSets,
            ),
      ]);

    if (teamRows.length === 0) {
      return this.#limitedSnapshot(
        membership,
        season,
        now,
        reason("LEAGUE_EMPTY", "The latest league season has no synchronized teams."),
      );
    }
    if (teamRows.length > LEAGUE_ANALYTICS_LIMITS.teams) {
      return this.#limitedSnapshot(
        membership,
        season,
        now,
        reason(
          "LEAGUE_SIZE_UNSUPPORTED",
          `League analytics support at most ${LEAGUE_ANALYTICS_LIMITS.teams} teams.`,
        ),
      );
    }
    if (observationRows.length > LEAGUE_ANALYTICS_LIMITS.matchupObservations) {
      return this.#limitedSnapshot(
        membership,
        season,
        now,
        reason(
          "MATCHUP_HISTORY_LIMIT",
          "Matchup history exceeded the bounded analytics read; no partial season result was calculated.",
        ),
      );
    }

    const teams = teamRows;
    const matchups = deduplicateMatchupObservations(observationRows);
    const snapshots = latestRosterSnapshots(rosterSnapshotRows).slice(
      0,
      LEAGUE_ANALYTICS_LIMITS.rosterSnapshots,
    );
    const rosterEntries = await this.#repository.listRosterEntries(
      snapshots.map((snapshot) => snapshot.id),
      LEAGUE_ANALYTICS_LIMITS.rosterEntries + 1,
    );
    const projectionSet =
      season.currentWeek === null
        ? undefined
        : selectAccessibleProjectionSet(
            projectionCandidates,
            actorUserId,
            season.id,
            season.season,
            season.currentWeek,
          );
    const projectionTimestamps = projectionSet
      ? projectionTimestampProvenance(projectionSet)
      : null;
    // Only worth the extra bounded read when there is actually a missing-set story to explain: a
    // known week with zero accessible candidates, which may be because managed sets were withheld.
    const managedProfile =
      projectionSet === undefined &&
      season.currentWeek !== null &&
      this.#repository.findManagedProjectionProfile
        ? await this.#repository.findManagedProjectionProfile(season.id)
        : undefined;
    const uniquePlayerIds = [...new Set(rosterEntries.map((entry) => entry.playerId))];
    const projectionRows = projectionSet
      ? await this.#repository.listProjectionRows(
          projectionSet.id,
          uniquePlayerIds,
          LEAGUE_ANALYTICS_LIMITS.projectionRows + 1,
        )
      : [];
    const rosterReadLimited = rosterEntries.length > LEAGUE_ANALYTICS_LIMITS.rosterEntries;
    const projectionReadLimited = projectionRows.length > LEAGUE_ANALYTICS_LIMITS.projectionRows;
    const boundedRosterEntries = rosterEntries.slice(0, LEAGUE_ANALYTICS_LIMITS.rosterEntries);
    const boundedProjectionRows = projectionRows.slice(0, LEAGUE_ANALYTICS_LIMITS.projectionRows);

    const scores = buildScoreAnalytics(teams, matchups, membership.claimedFantasyTeamId);
    const positional =
      rosterReadLimited || projectionReadLimited
        ? {
            section: unavailable(
              reason(
                "ROSTER_COVERAGE_INCOMPLETE",
                "Roster or projection rows exceeded the bounded analytics read; no partial positional values were calculated.",
              ),
            ),
            averageByTeam: new Map<string, number | null>(),
          }
        : buildPositionalAnalytics({
            teams,
            claimedTeamId: membership.claimedFantasyTeamId,
            slotRules: slotRuleRows.slice(0, LEAGUE_ANALYTICS_LIMITS.slotRules),
            snapshots,
            rosterEntries: boundedRosterEntries,
            projectionRows: boundedProjectionRows,
            projectionSet,
            week: season.currentWeek,
            ...(managedProfile === undefined ? {} : { managedProfile }),
          });
    const power = buildPowerAnalytics(teams, membership.claimedFantasyTeamId, scores, positional);
    const weeklyAwardWeeks = buildAwardableWeeks(teams, scores);
    const weeklyAwards = buildWeeklyAwards(
      teams,
      membership.claimedFantasyTeamId,
      scores,
      weeklyAwardWeeks,
      options?.weeklyAwardsWeek,
    );
    const matchupSnapshotId = effectiveMatchupSnapshotId(matchups);
    const playoffOdds = buildPlayoffOdds({
      teams,
      claimedTeamId: membership.claimedFantasyTeamId,
      scores,
      matchups,
      rules: parseLeagueRules(season.settings),
      seed: playoffOddsSeed({
        leagueSeasonId: season.id,
        currentWeek: season.currentWeek,
        matchupSnapshotId,
      }),
      matchupSnapshotId,
    });
    const opponentScout = buildOpponentAnalytics({
      teams,
      claimedTeamId: membership.claimedFantasyTeamId,
      currentWeek: season.currentWeek,
      matchups,
      scores,
      positional,
      power,
    });
    const latestMatchupObservedAt = matchups.reduce<Date | null>(
      (latest, row) => (!latest || row.effectiveAt > latest ? row.effectiveAt : latest),
      null,
    );
    const projectedIds = new Set(boundedProjectionRows.map((row) => row.playerId));

    return {
      generatedAt: now.toISOString(),
      league: {
        id: membership.leagueId,
        name: membership.leagueName,
        season: season.season,
        currentWeek: season.currentWeek,
        provider: season.provider,
      },
      membership: {
        role: membership.role,
        claimedTeamId: membership.claimedFantasyTeamId,
        claimedTeamName: membership.claimedTeamName,
      },
      provenance: {
        leagueLastSyncedAt: season.lastSyncedAt?.toISOString() ?? null,
        latestMatchupObservedAt: latestMatchupObservedAt?.toISOString() ?? null,
        matchupFreshness: freshness(latestMatchupObservedAt, now, "matchup snapshot", 12, 36),
        matchupObservationsRead: observationRows.length,
        deduplicatedMatchups: matchups.length,
        projectionSet: projectionSet
          ? {
              id: projectionSet.id,
              source: projectionSet.source,
              version: projectionSet.version,
              sourceLabel: projectionSourceLabel(projectionSet),
              visibility: projectionSet.visibility as "private" | "league",
              creatorDisplayName: projectionSet.creatorDisplayName,
              season: projectionSet.season,
              week: projectionSet.week ?? season.currentWeek ?? 1,
              horizon: "week",
              sourceObservedAt: projectionTimestamps?.sourceObservedAt?.toISOString() ?? null,
              sourceObservedAtStatus: projectionTimestamps?.sourceObservedAtStatus ?? "unverified",
              importedAt:
                projectionTimestamps?.importedAt.toISOString() ??
                projectionSet.createdAt.toISOString(),
            }
          : null,
        projectionFreshness: freshness(
          projectionTimestamps?.sourceObservedAt ?? null,
          now,
          "projection source",
          24,
          72,
          projectionSet
            ? "Projection source time missing / unverified"
            : "No compatible projection set",
        ),
      },
      coverage: {
        leagueTeams: teams.length,
        teamsWithLatestRoster: snapshots.length,
        rosterPlayers: uniquePlayerIds.length,
        rosterPlayersProjected: uniquePlayerIds.filter((id) => projectedIds.has(id)).length,
        officialScoreWeeks: scores.engine?.weeks.length ?? 0,
      },
      scores: scores.section,
      power,
      positional: positional.section,
      opponentScout,
      weeklyAwards,
      weeklyAwardWeeks: [...weeklyAwardWeeks],
      playoffOdds,
    };
  }

  #noSeason(membership: AnalyticsMembershipRow, now: Date): LeagueAnalyticsSnapshot {
    const section = unavailable(
      reason("NO_SEASON", "Connect and synchronize a league season before running analytics."),
    );
    return {
      generatedAt: now.toISOString(),
      league: {
        id: membership.leagueId,
        name: membership.leagueName,
        season: null,
        currentWeek: null,
        provider: null,
      },
      membership: {
        role: membership.role,
        claimedTeamId: membership.claimedFantasyTeamId,
        claimedTeamName: membership.claimedTeamName,
      },
      provenance: {
        leagueLastSyncedAt: null,
        latestMatchupObservedAt: null,
        matchupFreshness: freshness(null, now, "matchup snapshot", 12, 36),
        matchupObservationsRead: 0,
        deduplicatedMatchups: 0,
        projectionSet: null,
        projectionFreshness: freshness(null, now, "projection source", 24, 72),
      },
      coverage: {
        leagueTeams: 0,
        teamsWithLatestRoster: 0,
        rosterPlayers: 0,
        rosterPlayersProjected: 0,
        officialScoreWeeks: 0,
      },
      scores: section,
      power: section,
      positional: section,
      opponentScout: section,
      weeklyAwards: section,
      weeklyAwardWeeks: [],
      playoffOdds: section,
    };
  }

  #limitedSnapshot(
    membership: AnalyticsMembershipRow,
    season: AnalyticsSeasonRow,
    now: Date,
    limitation: LeagueAnalyticsUnavailableReason,
  ): LeagueAnalyticsSnapshot {
    const section = unavailable(limitation);
    return {
      generatedAt: now.toISOString(),
      league: {
        id: membership.leagueId,
        name: membership.leagueName,
        season: season.season,
        currentWeek: season.currentWeek,
        provider: season.provider,
      },
      membership: {
        role: membership.role,
        claimedTeamId: membership.claimedFantasyTeamId,
        claimedTeamName: membership.claimedTeamName,
      },
      provenance: {
        leagueLastSyncedAt: season.lastSyncedAt?.toISOString() ?? null,
        latestMatchupObservedAt: null,
        matchupFreshness: freshness(null, now, "matchup snapshot", 12, 36),
        matchupObservationsRead: 0,
        deduplicatedMatchups: 0,
        projectionSet: null,
        projectionFreshness: freshness(null, now, "projection source", 24, 72),
      },
      coverage: {
        leagueTeams: 0,
        teamsWithLatestRoster: 0,
        rosterPlayers: 0,
        rosterPlayersProjected: 0,
        officialScoreWeeks: 0,
      },
      scores: section,
      power: section,
      positional: section,
      opponentScout: section,
      weeklyAwards: section,
      weeklyAwardWeeks: [],
      playoffOdds: section,
    };
  }
}
