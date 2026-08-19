import { createHash } from "node:crypto";

import {
  parseLeagueRules,
  type ScheduleEdgeAvailability,
  type ScheduleEdgeMatrixResponse,
  type ScheduleEdgeResponse,
  type ScheduleEdgeSource,
  type ScheduleEdgeWindow,
} from "@laces-out/contracts";
import {
  fantasyTeams,
  leagueMemberships,
  leagues,
  leagueSeasons,
  nflScheduleObservations,
  playerProjections,
  playerWeeklyRosterObservations,
  playerWeeklyStatObservations,
  players,
  projectionSets,
  rosterEntries,
  rosterSlotRules,
  rosterSnapshots,
  scoringRules,
  type Database,
  type LeagueMembershipRole,
  type ProjectionVisibility,
  type ProviderName,
} from "@laces-out/db";
import {
  NFL_POSITIONS,
  NFL_TEAMS,
  playerId,
  rosterSlotId,
  type NflTeam,
  type Player,
  type Position,
  type RosterSlot,
  type RosterSlotKind,
  type RosterSlotType,
} from "@laces-out/domain";
import {
  SCHEDULE_EDGE_DESCRIPTIVE_POLICY,
  SCHEDULE_EDGE_EVALUATION_ARTIFACT,
  SCHEDULE_EDGE_POSITIONS,
  buildScheduleEdgeGamePositionTotals,
  calculateScheduleEdgeDefenseRatings,
  deriveByeWeekFeasibility,
  deriveScheduleStrength,
  deriveTeamScheduleWeeks,
  type ByeWeekFeasibilityResult,
  type ScheduleCoverage,
  type ScheduleEdgeDefenseRating,
  type ScheduleEdgeDefenseRatingsResult,
  type ScheduleGameObservation,
  type ScheduleStrengthEntry,
  type ScheduleStrengthResult,
  type TeamScheduleResult,
} from "@laces-out/league-analytics";
import {
  LEAGUE_SCORING_NORMALIZATION_VERSION,
  normalizeLeagueScoringProfile,
  projectionScoringProfileKey,
  type LeagueScoringNormalizationResult,
  type ProjectionScoringProfile,
} from "@laces-out/projections";
import { and, asc, desc, eq, inArray, ne, or, sql } from "drizzle-orm";

import {
  admittedSourceContract,
  metadataCoveredTeams,
  selectAdmittedSource,
  type AdmittedSourceRow,
} from "./admitted-source.js";
import {
  currentManagedProjectionProfile,
  currentManagedProjectionProfileKey,
  type ManagedProjectionProfile,
} from "./managed-projection-profile.js";
import { canonicalNflTeamCode } from "./nfl-team-code.js";
import { projectionTimestampProvenance } from "./projection-provenance.js";
import type { ScheduleEdgeMatrixQuery, ScheduleEdgeMemberQuery } from "./schedule-edge-routes.js";

export const SCHEDULE_EDGE_ALGORITHM_VERSION = "schedule-edge-v1" as const;

export const SCHEDULE_EDGE_LIMITS = {
  scheduleRows: 401,
  weeklyStatRows: 25_001,
  weeklyRosterRows: 50_001,
  rosterEntries: 81,
  slotRules: 65,
  scoringRules: 257,
  projectionSets: 16,
  projectionRows: 161,
} as const;

const SUPPORTED_POSITIONS = ["QB", "RB", "WR", "TE"] as const;
type SupportedPosition = (typeof SUPPORTED_POSITIONS)[number];
const SUPPORTED_POSITION_SET = new Set<string>(SUPPORTED_POSITIONS);
const DOMAIN_POSITION_SET = new Set<string>(NFL_POSITIONS);
const NFL_TEAM_SET = new Set<string>(NFL_TEAMS);
const EVALUATION_RELEASE_STATE: string = SCHEDULE_EDGE_EVALUATION_ARTIFACT.releaseState;

function directionalLabelsEnabled(position: SupportedPosition): boolean {
  return (
    EVALUATION_RELEASE_STATE === "validated" &&
    SCHEDULE_EDGE_DESCRIPTIVE_POLICY.labelsEnabled &&
    SCHEDULE_EDGE_DESCRIPTIVE_POLICY.validatedPositions.includes(position)
  );
}

function releaseHasDirectionalLabels(): boolean {
  return SUPPORTED_POSITIONS.some(directionalLabelsEnabled);
}

/**
 * Exact component vocabulary persisted by the nflverse weekly-player source, plus the aggregates
 * this service derives deterministically before scoring.
 */
const WEEKLY_SCORING_COMPONENTS = [
  "passing_completions",
  "passing_attempts",
  "passing_yards",
  "passing_touchdowns",
  "passing_interceptions",
  "passing_two_point_conversions",
  "passing_first_downs",
  "sacks_suffered",
  "sack_yards_lost",
  "sack_fumbles_lost",
  "carries",
  "rushing_yards",
  "rushing_touchdowns",
  "rushing_fumbles",
  "rushing_fumbles_lost",
  "rushing_two_point_conversions",
  "rushing_first_downs",
  "receptions",
  "targets",
  "receiving_yards",
  "receiving_touchdowns",
  "receiving_fumbles",
  "receiving_fumbles_lost",
  "fumbles_lost_total",
  "receiving_two_point_conversions",
  "receiving_first_downs",
  "special_teams_touchdowns",
  "fumble_recovery_touchdowns",
  "punt_return_yards",
  "kickoff_return_yards",
  "two_point_conversions",
  "fumbles_lost",
  "turnovers",
  "return_yards",
] as const;

export interface ScheduleEdgeMembershipRow {
  readonly leagueId: string;
  readonly leagueName: string;
  readonly role: LeagueMembershipRole;
  readonly claimedFantasyTeamId: string | null;
}

export interface ScheduleEdgeSeasonRow {
  readonly id: string;
  readonly provider: ProviderName;
  readonly season: number;
  readonly currentWeek: number | null;
  readonly settings: Record<string, unknown>;
  readonly lastSyncedAt: Date | null;
}

export interface ScheduleEdgeTeamRow {
  readonly id: string;
  readonly name: string;
}

export interface ScheduleEdgeRosterSnapshotRow {
  readonly id: string;
  readonly effectiveAt: Date;
}

export interface ScheduleEdgeRosterEntryRow {
  readonly playerId: string;
  readonly name: string;
  readonly primaryPosition: string;
  readonly eligiblePositions: string[];
  readonly nflTeam: string | null;
  readonly status: string | null;
  readonly slotCode: string;
  readonly isStarter: boolean;
}

export interface ScheduleEdgeSlotRuleRow {
  readonly id: string;
  readonly slotCode: string;
  readonly count: number;
  readonly eligiblePositions: string[];
  readonly isStarter: boolean;
}

export interface ScheduleEdgeScoringRuleRow {
  readonly statKey: string;
  readonly operation: string;
  readonly points: string;
  readonly thresholdLow: string | null;
  readonly thresholdHigh: string | null;
  readonly providerStatId: string | null;
}

export type ScheduleEdgeSourceRow = AdmittedSourceRow;

export interface ScheduleEdgeScheduleRow {
  readonly gameId: string;
  readonly season: number;
  readonly week: number;
  readonly gameDate: string;
  readonly startTimeEastern: string | null;
  readonly timeTbd: boolean;
  readonly kickoffAt: Date | null;
  readonly awayTeam: string;
  readonly homeTeam: string;
  readonly status: ScheduleGameObservation["status"];
  readonly neutralSite: boolean;
  readonly awayRestDays: number | null;
  readonly homeRestDays: number | null;
  readonly awayScore: number | null;
  readonly homeScore: number | null;
}

export interface ScheduleEdgeWeeklyStatRow {
  readonly externalPlayerId: string;
  readonly playerId: string | null;
  readonly season: number;
  readonly week: number;
  readonly gameId: string;
  readonly team: string;
  readonly opponentTeam: string;
  readonly components: Record<string, number>;
}

export interface ScheduleEdgeWeeklyRosterRow {
  readonly externalPlayerId: string;
  readonly playerId: string | null;
  readonly season: number;
  readonly week: number;
  readonly team: string;
  /** Historical position from this exact weekly artifact, never the current player record. */
  readonly position: string;
  readonly rosterStatus: string | null;
  readonly statusDescription: string | null;
}

export interface ScheduleEdgeProjectionSetRow {
  readonly id: string;
  readonly createdByUserId: string | null;
  readonly visibility: ProjectionVisibility;
  readonly source: string;
  readonly version: string;
  readonly season: number;
  readonly week: number | null;
  readonly horizon: string;
  readonly windowStartWeek: number;
  readonly windowEndWeek: number;
  readonly fetchedAt: Date;
  readonly createdAt: Date;
  readonly inputChecksum: string;
  readonly metadata: Record<string, unknown>;
}

export interface ScheduleEdgeProjectionRow {
  readonly projectionSetId: string;
  readonly playerId: string;
  readonly meanPoints: string;
}

export interface ScheduleEdgeRepository {
  findMembership(userId: string, leagueId: string): Promise<ScheduleEdgeMembershipRow | undefined>;
  findLatestSeason(leagueId: string): Promise<ScheduleEdgeSeasonRow | undefined>;
  findTeam(leagueSeasonId: string, teamId: string): Promise<ScheduleEdgeTeamRow | undefined>;
  findLatestRosterSnapshot(
    teamId: string,
    season: number,
  ): Promise<ScheduleEdgeRosterSnapshotRow | undefined>;
  listRosterEntries(
    snapshotId: string,
    limit: number,
  ): Promise<readonly ScheduleEdgeRosterEntryRow[]>;
  listSlotRules(leagueSeasonId: string, limit: number): Promise<readonly ScheduleEdgeSlotRuleRow[]>;
  listScoringRules(
    leagueSeasonId: string,
    limit: number,
  ): Promise<readonly ScheduleEdgeScoringRuleRow[]>;
  findSource(key: string): Promise<ScheduleEdgeSourceRow | undefined>;
  listScheduleGames(
    sourceId: string,
    checksum: string,
    season: number,
    limit: number,
  ): Promise<readonly ScheduleEdgeScheduleRow[]>;
  listWeeklyStats(
    sourceId: string,
    checksum: string,
    season: number,
    throughWeek: number,
    limit: number,
  ): Promise<readonly ScheduleEdgeWeeklyStatRow[]>;
  listWeeklyRosters(
    sourceId: string,
    checksum: string,
    season: number,
    throughWeek: number,
    limit: number,
  ): Promise<readonly ScheduleEdgeWeeklyRosterRow[]>;
  listProjectionSets(
    userId: string,
    leagueSeasonId: string,
    season: number,
    week: number | null,
    limit: number,
  ): Promise<readonly ScheduleEdgeProjectionSetRow[]>;
  listProjectionRows(
    projectionSetIds: readonly string[],
    playerIds: readonly string[],
    limit: number,
  ): Promise<readonly ScheduleEdgeProjectionRow[]>;
  /**
   * The managed (`laces-out-first-party`) weekly projection profile for this league, so an empty
   * `listProjectionSets` result can explain WHY managed sets were withheld instead of leaving that
   * silent. Optional so existing repository implementations and test doubles are unaffected.
   */
  findManagedProjectionProfile?(leagueSeasonId: string): Promise<ManagedProjectionProfile>;
}

export class DrizzleScheduleEdgeRepository implements ScheduleEdgeRepository {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  async findMembership(
    userId: string,
    leagueId: string,
  ): Promise<ScheduleEdgeMembershipRow | undefined> {
    const [row] = await this.#database
      .select({
        leagueId: leagues.id,
        leagueName: leagues.name,
        role: leagueMemberships.role,
        claimedFantasyTeamId: leagueMemberships.claimedFantasyTeamId,
      })
      .from(leagueMemberships)
      .innerJoin(leagues, eq(leagueMemberships.leagueId, leagues.id))
      .where(and(eq(leagueMemberships.userId, userId), eq(leagues.id, leagueId)))
      .limit(1);
    return row;
  }

  async findLatestSeason(leagueId: string): Promise<ScheduleEdgeSeasonRow | undefined> {
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

  async findTeam(leagueSeasonId: string, teamId: string): Promise<ScheduleEdgeTeamRow | undefined> {
    const [row] = await this.#database
      .select({ id: fantasyTeams.id, name: fantasyTeams.name })
      .from(fantasyTeams)
      .where(and(eq(fantasyTeams.id, teamId), eq(fantasyTeams.leagueSeasonId, leagueSeasonId)))
      .limit(1);
    return row;
  }

  async findLatestRosterSnapshot(
    teamId: string,
    season: number,
  ): Promise<ScheduleEdgeRosterSnapshotRow | undefined> {
    const [row] = await this.#database
      .select({ id: rosterSnapshots.id, effectiveAt: rosterSnapshots.effectiveAt })
      .from(rosterSnapshots)
      .where(and(eq(rosterSnapshots.teamId, teamId), eq(rosterSnapshots.season, season)))
      .orderBy(desc(rosterSnapshots.effectiveAt), desc(rosterSnapshots.id))
      .limit(1);
    return row;
  }

  listRosterEntries(
    snapshotId: string,
    limit: number,
  ): Promise<readonly ScheduleEdgeRosterEntryRow[]> {
    return this.#database
      .select({
        playerId: players.id,
        name: players.fullName,
        primaryPosition: players.primaryPosition,
        eligiblePositions: players.eligiblePositions,
        nflTeam: players.nflTeam,
        status: players.status,
        slotCode: rosterEntries.slotCode,
        isStarter: rosterEntries.isStarter,
      })
      .from(rosterEntries)
      .innerJoin(players, eq(rosterEntries.playerId, players.id))
      .where(eq(rosterEntries.snapshotId, snapshotId))
      .orderBy(desc(rosterEntries.isStarter), asc(rosterEntries.slotCode), asc(players.id))
      .limit(limit);
  }

  listSlotRules(
    leagueSeasonId: string,
    limit: number,
  ): Promise<readonly ScheduleEdgeSlotRuleRow[]> {
    return this.#database
      .select({
        id: rosterSlotRules.id,
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

  listScoringRules(
    leagueSeasonId: string,
    limit: number,
  ): Promise<readonly ScheduleEdgeScoringRuleRow[]> {
    return this.#database
      .select({
        statKey: scoringRules.statKey,
        operation: scoringRules.operation,
        points: scoringRules.points,
        thresholdLow: scoringRules.thresholdLow,
        thresholdHigh: scoringRules.thresholdHigh,
        providerStatId: scoringRules.providerStatId,
      })
      .from(scoringRules)
      .where(eq(scoringRules.leagueSeasonId, leagueSeasonId))
      .orderBy(asc(scoringRules.providerStatId), asc(scoringRules.statKey), asc(scoringRules.id))
      .limit(limit);
  }

  findSource(key: string): Promise<ScheduleEdgeSourceRow | undefined> {
    return selectAdmittedSource(this.#database, key);
  }

  async listScheduleGames(
    sourceId: string,
    checksum: string,
    season: number,
    limit: number,
  ): Promise<readonly ScheduleEdgeScheduleRow[]> {
    const rows = await this.#database
      .select({
        gameId: nflScheduleObservations.externalGameId,
        season: nflScheduleObservations.season,
        week: nflScheduleObservations.week,
        gameDate: nflScheduleObservations.gameDate,
        startTimeEastern: nflScheduleObservations.startTimeEastern,
        timeTbd: nflScheduleObservations.timeTbd,
        kickoffAt: nflScheduleObservations.kickoffAt,
        awayTeam: nflScheduleObservations.awayTeam,
        homeTeam: nflScheduleObservations.homeTeam,
        status: nflScheduleObservations.status,
        neutralSite: nflScheduleObservations.neutralSite,
        awayRestDays: nflScheduleObservations.awayRestDays,
        homeRestDays: nflScheduleObservations.homeRestDays,
        awayScore: nflScheduleObservations.awayScore,
        homeScore: nflScheduleObservations.homeScore,
      })
      .from(nflScheduleObservations)
      .where(
        and(
          eq(nflScheduleObservations.sourceId, sourceId),
          eq(nflScheduleObservations.inputChecksum, checksum),
          eq(nflScheduleObservations.season, season),
          eq(nflScheduleObservations.seasonType, "REG"),
        ),
      )
      .orderBy(
        asc(nflScheduleObservations.week),
        asc(nflScheduleObservations.gameDate),
        asc(nflScheduleObservations.externalGameId),
      )
      .limit(limit);
    return rows.map((row) => ({
      ...row,
      awayTeam: canonicalNflTeamCode(row.awayTeam),
      homeTeam: canonicalNflTeamCode(row.homeTeam),
    }));
  }

  async listWeeklyStats(
    sourceId: string,
    checksum: string,
    season: number,
    throughWeek: number,
    limit: number,
  ): Promise<readonly ScheduleEdgeWeeklyStatRow[]> {
    const rows = await this.#database
      .select({
        externalPlayerId: playerWeeklyStatObservations.externalPlayerId,
        playerId: playerWeeklyStatObservations.playerId,
        season: playerWeeklyStatObservations.season,
        week: playerWeeklyStatObservations.week,
        gameId: playerWeeklyStatObservations.gameId,
        team: playerWeeklyStatObservations.team,
        opponentTeam: playerWeeklyStatObservations.opponentTeam,
        components: playerWeeklyStatObservations.components,
      })
      .from(playerWeeklyStatObservations)
      .where(
        and(
          eq(playerWeeklyStatObservations.sourceId, sourceId),
          eq(playerWeeklyStatObservations.inputChecksum, checksum),
          eq(playerWeeklyStatObservations.season, season),
          eq(playerWeeklyStatObservations.seasonType, "REG"),
          sql`${playerWeeklyStatObservations.week} <= ${throughWeek}`,
        ),
      )
      .orderBy(
        asc(playerWeeklyStatObservations.week),
        asc(playerWeeklyStatObservations.gameId),
        asc(playerWeeklyStatObservations.externalPlayerId),
      )
      .limit(limit);
    return rows.map((row) => ({
      ...row,
      team: canonicalNflTeamCode(row.team),
      opponentTeam: canonicalNflTeamCode(row.opponentTeam),
    }));
  }

  async listWeeklyRosters(
    sourceId: string,
    checksum: string,
    season: number,
    throughWeek: number,
    limit: number,
  ): Promise<readonly ScheduleEdgeWeeklyRosterRow[]> {
    const rows = await this.#database
      .select({
        externalPlayerId: playerWeeklyRosterObservations.externalPlayerId,
        playerId: playerWeeklyRosterObservations.playerId,
        season: playerWeeklyRosterObservations.season,
        week: playerWeeklyRosterObservations.week,
        team: playerWeeklyRosterObservations.team,
        position: playerWeeklyRosterObservations.position,
        rosterStatus: playerWeeklyRosterObservations.rosterStatus,
        statusDescription: playerWeeklyRosterObservations.statusDescription,
      })
      .from(playerWeeklyRosterObservations)
      .where(
        and(
          eq(playerWeeklyRosterObservations.sourceId, sourceId),
          eq(playerWeeklyRosterObservations.inputChecksum, checksum),
          eq(playerWeeklyRosterObservations.season, season),
          sql`${playerWeeklyRosterObservations.week} <= ${throughWeek}`,
        ),
      )
      .orderBy(
        asc(playerWeeklyRosterObservations.week),
        asc(playerWeeklyRosterObservations.team),
        asc(playerWeeklyRosterObservations.externalPlayerId),
        asc(playerWeeklyRosterObservations.rosterStatus),
      )
      .limit(limit);
    return rows.map((row) => ({ ...row, team: canonicalNflTeamCode(row.team) }));
  }

  async listProjectionSets(
    userId: string,
    leagueSeasonId: string,
    season: number,
    week: number | null,
    limit: number,
  ): Promise<readonly ScheduleEdgeProjectionSetRow[]> {
    // A null key silently excludes every `laces-out-first-party` set below with no reason attached
    // to this result. `loadProjectionContext`'s zero-candidates branch recovers that reason via
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
    const read = (horizon: "week" | "rest-of-season") =>
      this.#database
        .select({
          id: projectionSets.id,
          createdByUserId: projectionSets.createdByUserId,
          visibility: projectionSets.visibility,
          source: projectionSets.source,
          version: projectionSets.version,
          season: projectionSets.season,
          week: projectionSets.week,
          horizon: projectionSets.horizon,
          windowStartWeek: projectionSets.windowStartWeek,
          windowEndWeek: projectionSets.windowEndWeek,
          fetchedAt: projectionSets.fetchedAt,
          createdAt: projectionSets.createdAt,
          inputChecksum: projectionSets.inputChecksum,
          metadata: projectionSets.metadata,
        })
        .from(projectionSets)
        .where(
          and(
            eq(projectionSets.leagueSeasonId, leagueSeasonId),
            eq(projectionSets.season, season),
            eq(projectionSets.horizon, horizon),
            ...(horizon === "week"
              ? [week === null ? sql`false` : eq(projectionSets.week, week)]
              : []),
            compatibleManagedSet,
            or(
              eq(projectionSets.visibility, "league"),
              and(
                eq(projectionSets.visibility, "private"),
                eq(projectionSets.createdByUserId, userId),
              ),
            ),
          ),
        )
        .orderBy(
          sql`case
            when ${projectionSets.visibility} = 'private' and ${projectionSets.createdByUserId} = ${userId} then 0
            when ${projectionSets.createdByUserId} is not null then 1
            else 2
          end`,
          desc(projectionSets.fetchedAt),
          desc(projectionSets.createdAt),
          desc(projectionSets.id),
        )
        .limit(Math.max(1, Math.floor(limit / 2)));
    const [weekly, restOfSeason] = await Promise.all([read("week"), read("rest-of-season")]);
    return [...weekly, ...restOfSeason];
  }

  listProjectionRows(
    projectionSetIds: readonly string[],
    playerIds: readonly string[],
    limit: number,
  ): Promise<readonly ScheduleEdgeProjectionRow[]> {
    if (projectionSetIds.length === 0 || playerIds.length === 0) return Promise.resolve([]);
    return this.#database
      .select({
        projectionSetId: playerProjections.projectionSetId,
        playerId: playerProjections.playerId,
        meanPoints: playerProjections.meanPoints,
      })
      .from(playerProjections)
      .where(
        and(
          inArray(playerProjections.projectionSetId, [...projectionSetIds]),
          inArray(playerProjections.playerId, [...playerIds]),
        ),
      )
      .orderBy(asc(playerProjections.projectionSetId), asc(playerProjections.playerId))
      .limit(limit);
  }

  findManagedProjectionProfile(leagueSeasonId: string): Promise<ManagedProjectionProfile> {
    return currentManagedProjectionProfile(this.#database, leagueSeasonId);
  }
}

const DEFINITIONS = {
  matchup:
    "Matchup percentile compares an opponent's adjusted fantasy points allowed with every admitted NFL defense for the same position. Higher is more favorable to the offensive player. Raw and adjusted league-scored points remain visible with the sample counts.",
  scheduleStrength:
    "Schedule strength is the simple mean of available position-matchup percentiles in the selected weeks. Confirmed byes are counted but omitted from the mean; weeks without affirmed schedule or matchup coverage remain unknown.",
  confidence:
    "Confidence measures the amount and completeness of current- and prior-season evidence. It does not predict an individual player's performance. Directional labels remain descriptive until the versioned historical validation gate passes.",
  byeFeasibility:
    "Bye feasibility removes players on an affirmed NFL bye and applies this league's exact starter-slot eligibility. Covered means a legal lineup remains, Thin means one more relevant absence can break it, Gap means no legal lineup remains, and Unknown means the inputs cannot support a safe answer.",
} as const;

const unavailableMatchup = (reason: string): ScheduleEdgeResponse["roster"][number]["matchup"] => ({
  state: "unavailable",
  percentile: null,
  label: "unavailable",
  confidence: "unavailable",
  rawPointsAllowed: null,
  adjustedPointsAllowed: null,
  leagueAveragePoints: null,
  pointDifferential: null,
  currentGames: 0,
  priorGames: 0,
  incompleteGames: 0,
  reason: boundedText(reason, 700),
});

function boundedText(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1).trimEnd()}…`;
}

function hash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
    .join(",")}}`;
}

function integerInRange(value: unknown, minimum: number, maximum: number): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : null;
}

function normalizedCurrentWeek(value: number | null): number | null {
  return integerInRange(value, 1, 18);
}

function completedThroughWeek(value: number | null): number {
  const currentWeek = normalizedCurrentWeek(value);
  return currentWeek === null ? 0 : currentWeek - 1;
}

function labelForWindow(startWeek: number, endWeek: number): string {
  return startWeek === endWeek ? `Week ${startWeek}` : `Weeks ${startWeek}–${endWeek}`;
}

export interface ResolvedScheduleEdgeWindows {
  readonly selected: ScheduleEdgeWindow;
  readonly playoff: ScheduleEdgeWindow;
}

/**
 * Reads only the persisted provider fields whose meaning is stable across the normalized sync
 * boundary. Malformed or incomplete provider data falls back to the explicitly labeled Weeks
 * 15–17 window rather than being guessed into "your playoffs."
 */
export function resolveScheduleEdgeWindows(
  currentWeek: number | null,
  settings: Record<string, unknown>,
  query: ScheduleEdgeMemberQuery,
): ResolvedScheduleEdgeWindows {
  const admittedCurrentWeek = normalizedCurrentWeek(currentWeek);
  const safeCurrentWeek = admittedCurrentWeek ?? 1;
  const selectedStart = query.startWeek ?? safeCurrentWeek;
  const selectedEnd = query.endWeek ?? Math.min(18, selectedStart + 3);
  const selected: ScheduleEdgeWindow = {
    startWeek: selectedStart,
    endWeek: Math.max(selectedStart, selectedEnd),
    label: labelForWindow(selectedStart, Math.max(selectedStart, selectedEnd)),
    source:
      query.startWeek !== null || query.endWeek !== null
        ? "request"
        : admittedCurrentWeek === null
          ? "fallback"
          : "current-week",
  };

  if (query.playoffStartWeek !== null || query.playoffEndWeek !== null) {
    const playoffStart = query.playoffStartWeek ?? Math.min(query.playoffEndWeek ?? 15, 15);
    const playoffEnd = Math.max(
      playoffStart,
      query.playoffEndWeek ?? Math.min(18, playoffStart + 2),
    );
    return {
      selected,
      playoff: {
        startWeek: playoffStart,
        endWeek: playoffEnd,
        label: labelForWindow(playoffStart, playoffEnd),
        source: "request",
      },
    };
  }

  const rules = parseLeagueRules(settings);
  const regularSeasonPeriods = rules.regularSeasonMatchupPeriods;
  const playoffPeriodLength = rules.playoffMatchupPeriodLength;
  const playoffTeamCount = rules.playoffTeamCount;
  if (regularSeasonPeriods !== null && playoffPeriodLength !== null && playoffTeamCount !== null) {
    const playoffStart = regularSeasonPeriods + 1;
    const rounds = Math.ceil(Math.log2(playoffTeamCount));
    const playoffEnd = playoffStart + playoffPeriodLength * rounds - 1;
    if (playoffStart <= 18 && playoffEnd >= playoffStart && playoffEnd <= 18) {
      return {
        selected,
        playoff: {
          startWeek: playoffStart,
          endWeek: playoffEnd,
          label: labelForWindow(playoffStart, playoffEnd),
          source: "provider",
        },
      };
    }
  }

  return {
    selected,
    playoff: {
      startWeek: 15,
      endWeek: 17,
      label: "Weeks 15–17",
      source: "fallback",
    },
  };
}

function availability(
  state: ScheduleEdgeAvailability["state"],
  reason: string | null,
): ScheduleEdgeAvailability {
  return { state, reason };
}

/**
 * Why managed (`laces-out-first-party`) sets are invisible to `listProjectionSets`' compatibility
 * filter for this league. Mirrors the equivalent text in `in-season-decisions.ts`; kept separate
 * rather than shared because the two surfaces' wire contracts are independent.
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

function scoringWarnings(result: LeagueScoringNormalizationResult): string[] {
  const warnings = result.warnings.map((warning) => boundedText(warning.message, 500));
  if (result.state === "unavailable") {
    warnings.push(...result.reasons.map((reason) => boundedText(reason.message, 500)));
  }
  return [...new Set(warnings)].slice(0, 40);
}

function normalizeScoring(
  season: ScheduleEdgeSeasonRow,
  rows: readonly ScheduleEdgeScoringRuleRow[],
): LeagueScoringNormalizationResult {
  return normalizeLeagueScoringProfile({
    id: `league:${season.id}`,
    label: "League scoring",
    version: LEAGUE_SCORING_NORMALIZATION_VERSION,
    rows: rows.map((row) => ({ provider: season.provider, ...row })),
    availableStatIds: WEEKLY_SCORING_COMPONENTS,
  });
}

/**
 * Schedule Edge only ever scores QB/RB/WR/TE (`SCHEDULE_EDGE_POSITIONS` has no K or D/ST), so this
 * narrows `normalizeLeagueScoringProfile`'s always-six-position `positions` array down to the
 * four this surface can ever use. `state === "available"` on the whole result does NOT imply any
 * of these four are supported (a league scoring only K normalizes to "available" with all four
 * withheld) — every availability derivation in this file must read this, not `result.state`.
 */
function scheduleEdgeSupportedPositions(
  normalized: LeagueScoringNormalizationResult | null,
): readonly SupportedPosition[] {
  if (!normalized) return [];
  return SUPPORTED_POSITIONS.filter(
    (position) =>
      normalized.positions.find((entry) => entry.position === position)?.supported === true,
  );
}

/**
 * Names the withheld positions and summarizes the underlying per-position fatal reasons (deduped
 * across positions that failed for the same cause). The full per-rule detail continues to flow
 * through `scoringWarnings` — this is a bounded, human-scannable summary, not a second warnings
 * list.
 */
function withheldPositionsReason(
  normalized: LeagueScoringNormalizationResult,
  withheld: readonly SupportedPosition[],
): string {
  const messages = [
    ...new Set(
      withheld.flatMap(
        (position) =>
          normalized.positions
            .find((entry) => entry.position === position)
            ?.reasons.map((reason) => reason.message) ?? [],
      ),
    ),
  ];
  const summary =
    messages.length > 0
      ? messages.join(" ")
      : "these positions' scoring rules do not normalize to a supported profile.";
  return boundedText(`${withheld.join(", ")} withheld: ${summary}`, 700);
}

function checksumOrNull(value: string): string | null {
  const normalized = value.startsWith("sha256:") ? value.slice("sha256:".length) : value;
  return /^[a-f0-9]{64}$/u.test(normalized) ? normalized : null;
}

function scheduleSource(
  season: number,
  source: ScheduleEdgeSourceRow | undefined,
): ScheduleEdgeSource {
  return admittedSourceContract(
    "schedule",
    `nflverse.schedules.${season}`,
    `NFL schedule ${season}`,
    source,
  );
}

function weeklyStatSource(
  season: number,
  source: ScheduleEdgeSourceRow | undefined,
): ScheduleEdgeSource {
  return admittedSourceContract(
    "weekly-stats",
    `nflverse.stats-player-week.${season}`,
    `NFL weekly player stats ${season}`,
    source,
  );
}

function weeklyRosterSource(
  season: number,
  source: ScheduleEdgeSourceRow | undefined,
): ScheduleEdgeSource {
  return admittedSourceContract(
    "weekly-rosters",
    `nflverse.weekly-rosters.${season}`,
    `NFL weekly rosters ${season}`,
    source,
  );
}

function boundedSource(
  source: ScheduleEdgeSource,
  rowsRead: number,
  limit: number,
): ScheduleEdgeSource {
  if (rowsRead < limit) return source;
  return {
    ...source,
    state: "quarantined",
    checksumSha256: null,
    reason: `The bounded read reached its ${limit - 1} row safety limit, so this dataset was withheld.`,
  };
}

function emptySource(source: ScheduleEdgeSource, reason: string): ScheduleEdgeSource {
  return source.state === "available"
    ? {
        ...source,
        state: "quarantined",
        checksumSha256: null,
        reason,
      }
    : source;
}

function scheduleObservation(row: ScheduleEdgeScheduleRow): ScheduleGameObservation {
  return {
    externalGameId: row.gameId,
    season: row.season,
    week: row.week,
    gameDate: row.gameDate,
    startTimeEastern: row.startTimeEastern,
    timeTbd: row.timeTbd,
    kickoffAt: row.kickoffAt,
    awayTeam: row.awayTeam,
    homeTeam: row.homeTeam,
    status: row.status,
    neutralSite: row.neutralSite,
    awayRestDays: row.awayRestDays,
    homeRestDays: row.homeRestDays,
    awayScore: row.awayScore,
    homeScore: row.homeScore,
  };
}

function scheduleCoverage(
  source: ScheduleEdgeSource,
  row: ScheduleEdgeSourceRow | undefined,
): ScheduleCoverage {
  return {
    publishable: source.state === "available",
    coveredWeeks: source.coveredWeeks,
    coveredTeams: row ? metadataCoveredTeams(row.metadata) : [],
    rowsRejected: source.quality.rowsRejected,
  };
}

function validPosition(value: string): value is Position {
  return DOMAIN_POSITION_SET.has(value);
}

function validNflTeam(value: string | null): value is NflTeam {
  return value !== null && NFL_TEAM_SET.has(value);
}

function playerStatus(value: string | null): NonNullable<Player["status"]> {
  switch (value?.toUpperCase()) {
    case "ACTIVE":
    case "QUESTIONABLE":
    case "DOUBTFUL":
    case "OUT":
    case "IR":
    case "PUP":
    case "SUSPENDED":
    case "NA":
      return value.toUpperCase() as NonNullable<Player["status"]>;
    default:
      return "UNKNOWN";
  }
}

function domainPlayer(row: ScheduleEdgeRosterEntryRow): Player | null {
  const positions = [
    ...new Set(
      [row.primaryPosition, ...row.eligiblePositions]
        .map((position) => position.toUpperCase())
        .filter(validPosition),
    ),
  ];
  if (positions.length === 0) return null;
  return {
    id: playerId(row.playerId),
    name: row.name,
    positions,
    ...(validNflTeam(row.nflTeam) ? { nflTeam: row.nflTeam } : {}),
    status: playerStatus(row.status),
  };
}

const SLOT_TYPES = new Set<RosterSlotType>([
  "QB",
  "RB",
  "WR",
  "TE",
  "FLEX",
  "REC_FLEX",
  "SUPER_FLEX",
  "OP",
  "K",
  "DST",
  "DL",
  "LB",
  "DB",
  "IDP_FLEX",
  "BENCH",
  "IR",
  "TAXI",
]);

function normalizedSlotType(slotCode: string): RosterSlotType | null {
  const normalized = slotCode.trim().toUpperCase().replaceAll("-", "_");
  if (normalized === "BE") return "BENCH";
  if (normalized === "RES" || normalized === "INJURED_RESERVE") return "IR";
  if (normalized === "TS") return "TAXI";
  if (normalized === "W/R/T") return "FLEX";
  if (normalized === "W/T") return "REC_FLEX";
  if (normalized === "Q/W/R/T") return "SUPER_FLEX";
  return SLOT_TYPES.has(normalized as RosterSlotType) ? (normalized as RosterSlotType) : null;
}

function slotKind(type: RosterSlotType): RosterSlotKind {
  if (type === "BENCH") return "BENCH";
  if (type === "IR") return "INJURED_RESERVE";
  if (type === "TAXI") return "TAXI";
  return "STARTER";
}

function starterSlots(rows: readonly ScheduleEdgeSlotRuleRow[]): readonly RosterSlot[] | null {
  const slots: RosterSlot[] = [];
  for (const row of rows) {
    if (!row.isStarter) continue;
    const type = normalizedSlotType(row.slotCode);
    if (!type || !Number.isSafeInteger(row.count) || row.count < 0) return null;
    const positions = [
      ...new Set(row.eligiblePositions.map((value) => value.toUpperCase())),
    ].filter(validPosition);
    if (positions.length === 0) return null;
    for (let index = 1; index <= row.count; index += 1) {
      slots.push({
        id: rosterSlotId(`${type}-${index}`),
        type,
        label: row.count === 1 ? type : `${type} ${index}`,
        kind: slotKind(type),
        eligiblePositions: positions,
      });
    }
  }
  return slots.length > 0 && slots.length <= 30 ? slots : null;
}

function rosterState(
  row: ScheduleEdgeRosterEntryRow,
): "available" | "injured-reserve" | "taxi" | "unknown" {
  const slot = normalizedSlotType(row.slotCode);
  if (slot === "IR") return "injured-reserve";
  if (slot === "TAXI") return "taxi";
  return slot ? "available" : "unknown";
}

function sourceForProjectionSet(
  set: ScheduleEdgeProjectionSetRow,
  rowsRead: number,
): ScheduleEdgeSource {
  const checksum = checksumOrNull(set.inputChecksum);
  return {
    dataset: "projections",
    state: checksum ? "available" : "quarantined",
    key: `projection.${set.id}`,
    name: boundedText(`${set.source} ${set.horizon} projections`, 200),
    attribution: null,
    attributionUrl: null,
    fetchedAt: set.fetchedAt.toISOString(),
    checksumSha256: checksum,
    coveredWeeks: Array.from(
      { length: set.windowEndWeek - set.windowStartWeek + 1 },
      (_, index) => set.windowStartWeek + index,
    ).filter((week) => week >= 1 && week <= 18),
    quality: {
      rowsRead,
      rowsRejected: null,
      rowsUnmatched: null,
      matchRate: null,
    },
    reason: checksum ? null : "This projection set does not have a valid checksum.",
  };
}

function selectProjectionSets(rows: readonly ScheduleEdgeProjectionSetRow[]): {
  readonly weekly: ScheduleEdgeProjectionSetRow | null;
  readonly ros: ScheduleEdgeProjectionSetRow | null;
} {
  return {
    weekly: rows.find((row) => row.horizon === "week") ?? null,
    ros: rows.find((row) => row.horizon === "rest-of-season") ?? null,
  };
}

interface LoadedScheduleEvidence {
  readonly scheduleSource: ScheduleEdgeSource;
  readonly scheduleSourceRow: ScheduleEdgeSourceRow | undefined;
  readonly games: readonly ScheduleEdgeScheduleRow[];
  readonly statsSource: ScheduleEdgeSource;
  readonly stats: readonly ScheduleEdgeWeeklyStatRow[];
  readonly rostersSource: ScheduleEdgeSource;
  readonly weeklyRosters: readonly ScheduleEdgeWeeklyRosterRow[];
}

async function loadSeasonEvidence(
  repository: ScheduleEdgeRepository,
  season: number,
  throughWeek: number,
): Promise<LoadedScheduleEvidence> {
  const scheduleKey = `nflverse.schedules.${season}`;
  const statsKey = `nflverse.stats-player-week.${season}`;
  const rostersKey = `nflverse.weekly-rosters.${season}`;
  const [scheduleRow, statsRow, rostersRow] = await Promise.all([
    repository.findSource(scheduleKey),
    repository.findSource(statsKey),
    repository.findSource(rostersKey),
  ]);
  let scheduleContract = scheduleSource(season, scheduleRow);
  let statsContract = weeklyStatSource(season, statsRow);
  let rostersContract = weeklyRosterSource(season, rostersRow);

  const [gamesRead, statsRead, rostersRead] = await Promise.all([
    scheduleContract.state === "available" &&
    scheduleRow?.lastChecksum &&
    scheduleRow.lastChecksum === scheduleContract.checksumSha256
      ? repository.listScheduleGames(
          scheduleRow.id,
          scheduleRow.lastChecksum,
          season,
          SCHEDULE_EDGE_LIMITS.scheduleRows,
        )
      : Promise.resolve([]),
    throughWeek >= 1 &&
    statsContract.state === "available" &&
    statsRow?.lastChecksum &&
    statsRow.lastChecksum === statsContract.checksumSha256
      ? repository.listWeeklyStats(
          statsRow.id,
          statsRow.lastChecksum,
          season,
          throughWeek,
          SCHEDULE_EDGE_LIMITS.weeklyStatRows,
        )
      : Promise.resolve([]),
    throughWeek >= 1 &&
    rostersContract.state === "available" &&
    rostersRow?.lastChecksum &&
    rostersRow.lastChecksum === rostersContract.checksumSha256
      ? repository.listWeeklyRosters(
          rostersRow.id,
          rostersRow.lastChecksum,
          season,
          throughWeek,
          SCHEDULE_EDGE_LIMITS.weeklyRosterRows,
        )
      : Promise.resolve([]),
  ]);

  scheduleContract = boundedSource(
    scheduleContract,
    gamesRead.length,
    SCHEDULE_EDGE_LIMITS.scheduleRows,
  );
  statsContract = boundedSource(
    statsContract,
    statsRead.length,
    SCHEDULE_EDGE_LIMITS.weeklyStatRows,
  );
  rostersContract = boundedSource(
    rostersContract,
    rostersRead.length,
    SCHEDULE_EDGE_LIMITS.weeklyRosterRows,
  );
  if (gamesRead.length === 0) {
    scheduleContract = emptySource(
      scheduleContract,
      "The admitted schedule read returned no regular-season games.",
    );
  }
  if (throughWeek >= 1 && statsRead.length === 0) {
    statsContract = emptySource(
      statsContract,
      "The admitted weekly-stat read returned no rows in the completed-week window.",
    );
  }
  if (throughWeek >= 1 && rostersRead.length === 0) {
    rostersContract = emptySource(
      rostersContract,
      "The admitted weekly-roster read returned no rows in the completed-week window.",
    );
  }
  return {
    scheduleSource: scheduleContract,
    scheduleSourceRow: scheduleRow,
    games:
      scheduleContract.state === "available"
        ? gamesRead.slice(0, SCHEDULE_EDGE_LIMITS.scheduleRows - 1)
        : [],
    statsSource: statsContract,
    stats:
      statsContract.state === "available"
        ? statsRead.slice(0, SCHEDULE_EDGE_LIMITS.weeklyStatRows - 1)
        : [],
    rostersSource: rostersContract,
    weeklyRosters:
      rostersContract.state === "available"
        ? rostersRead.slice(0, SCHEDULE_EDGE_LIMITS.weeklyRosterRows - 1)
        : [],
  };
}

function teamSchedule(evidence: LoadedScheduleEvidence, season: number): TeamScheduleResult {
  return deriveTeamScheduleWeeks({
    season,
    games: evidence.games.map(scheduleObservation),
    coverage: scheduleCoverage(evidence.scheduleSource, evidence.scheduleSourceRow),
    teams: [...NFL_TEAMS],
  });
}

interface ProjectionContext {
  readonly weekly: ScheduleEdgeProjectionSetRow | null;
  readonly ros: ScheduleEdgeProjectionSetRow | null;
  readonly points: ReadonlyMap<string, ReadonlyMap<string, number>>;
  readonly sources: readonly ScheduleEdgeSource[];
  readonly availability: ScheduleEdgeAvailability;
}

function projectionForPlayer(
  playerIdValue: string,
  context: ProjectionContext,
): ScheduleEdgeResponse["roster"][number]["projection"] {
  const weeklySource = context.sources.find(
    (source) => source.key === `projection.${context.weekly?.id ?? ""}`,
  );
  const rosSource = context.sources.find(
    (source) => source.key === `projection.${context.ros?.id ?? ""}`,
  );
  const weeklyPoints =
    context.weekly && weeklySource?.state === "available"
      ? (context.points.get(context.weekly.id)?.get(playerIdValue) ?? null)
      : null;
  const rosPoints =
    context.ros && rosSource?.state === "available"
      ? (context.points.get(context.ros.id)?.get(playerIdValue) ?? null)
      : null;
  if (weeklyPoints === null && rosPoints === null) return null;
  const selectedSets = [
    weeklyPoints === null ? null : context.weekly,
    rosPoints === null ? null : context.ros,
  ].filter((set): set is ScheduleEdgeProjectionSetRow => set !== null);
  const observed = selectedSets
    .map((set) => projectionTimestampProvenance(set).sourceObservedAt)
    .filter((value): value is Date => value !== null)
    .sort((left, right) => right.getTime() - left.getTime())[0];
  return {
    weeklyPoints,
    rosPoints,
    source: boundedText([...new Set(selectedSets.map((set) => set.source))].join(" / "), 160),
    sourceObservedAt: observed?.toISOString() ?? null,
  };
}

function projectionInput(set: ScheduleEdgeProjectionSetRow | null): unknown {
  if (!set) return null;
  return {
    id: set.id,
    checksum: checksumOrNull(set.inputChecksum),
    source: set.source,
    horizon: set.horizon,
    fetchedAt: set.fetchedAt,
  };
}

async function loadProjectionContext(
  repository: ScheduleEdgeRepository,
  actorUserId: string,
  season: ScheduleEdgeSeasonRow,
  rosterPlayerIds: readonly string[],
): Promise<ProjectionContext> {
  const currentWeek = normalizedCurrentWeek(season.currentWeek);
  if (currentWeek === null || rosterPlayerIds.length === 0) {
    return {
      weekly: null,
      ros: null,
      points: new Map(),
      sources: [],
      availability: availability(
        "unavailable",
        rosterPlayerIds.length === 0
          ? "A selected roster is required before projection context can be loaded."
          : "The current league week is not available.",
      ),
    };
  }
  const candidates = await repository.listProjectionSets(
    actorUserId,
    season.id,
    season.season,
    currentWeek,
    SCHEDULE_EDGE_LIMITS.projectionSets,
  );
  const selected = selectProjectionSets(candidates);
  const selectedSets = [selected.weekly, selected.ros].filter(
    (set): set is ScheduleEdgeProjectionSetRow => set !== null,
  );
  if (selectedSets.length === 0) {
    const managedProfile = repository.findManagedProjectionProfile
      ? await repository.findManagedProjectionProfile(season.id)
      : undefined;
    const reasonText = managedProfile
      ? `No compatible weekly or rest-of-season projection set is available. Managed weekly projections are withheld: ${managedProjectionsWithheldReason(managedProfile)}.`
      : "No compatible weekly or rest-of-season projection set is available.";
    return {
      ...selected,
      points: new Map(),
      sources: [],
      availability: availability("unavailable", reasonText),
    };
  }
  const rows = await repository.listProjectionRows(
    selectedSets.map((set) => set.id),
    rosterPlayerIds,
    SCHEDULE_EDGE_LIMITS.projectionRows,
  );
  if (rows.length >= SCHEDULE_EDGE_LIMITS.projectionRows) {
    return {
      ...selected,
      points: new Map(),
      sources: selectedSets.map((set) => ({
        ...sourceForProjectionSet(set, rows.length),
        state: "quarantined" as const,
        checksumSha256: null,
        reason: "Projection rows exceeded the bounded roster read.",
      })),
      availability: availability(
        "unavailable",
        "Projection rows exceeded the bounded roster read.",
      ),
    };
  }
  const points = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const value = Number(row.meanPoints);
    if (!Number.isFinite(value)) continue;
    const byPlayer = points.get(row.projectionSetId) ?? new Map<string, number>();
    byPlayer.set(row.playerId, value);
    points.set(row.projectionSetId, byPlayer);
  }
  const sources = selectedSets.map((set) =>
    sourceForProjectionSet(set, points.get(set.id)?.size ?? 0),
  );
  const validSources = sources.filter((source) => source.state === "available").length;
  const projectedPlayers = new Set([...points.values()].flatMap((byPlayer) => [...byPlayer.keys()]))
    .size;
  return {
    ...selected,
    points,
    sources,
    availability:
      validSources === 0
        ? availability("unavailable", "The selected projection sets failed provenance checks.")
        : projectedPlayers === 0
          ? availability(
              "unavailable",
              "The selected projection sets contain no rows for this roster.",
            )
          : projectedPlayers < rosterPlayerIds.length
            ? availability(
                "partial",
                "Projection context is missing for one or more roster players.",
              )
            : validSources < selectedSets.length
              ? availability("partial", "Only one projection horizon cleared provenance checks.")
              : availability("available", null),
  };
}

interface ComputedScheduleEdgeAnalysis {
  readonly schedule: TeamScheduleResult;
  readonly ratings: ScheduleEdgeDefenseRatingsResult | null;
  readonly selectedStrength: ScheduleStrengthResult | null;
  readonly playoffStrength: ScheduleStrengthResult | null;
  readonly completeSlices: number;
  readonly incompleteSlices: number;
}

function computeAnalysis(input: {
  readonly season: ScheduleEdgeSeasonRow;
  readonly windows: ResolvedScheduleEdgeWindows;
  readonly current: LoadedScheduleEvidence;
  readonly prior: LoadedScheduleEvidence;
  readonly scoringProfile: ProjectionScoringProfile | null;
  /**
   * The subset of QB/RB/WR/TE this league's scoring rules support. Ratings and schedule strength
   * are computed only for these positions; a withheld position simply never gets a totals row, so
   * every downstream per-position lookup (`findCurrentRating`, `findStrength`) misses and falls
   * back to its own existing "unavailable" + reason contract — never a fabricated approximation.
   */
  readonly supportedPositions: readonly SupportedPosition[];
}): ComputedScheduleEdgeAnalysis {
  const schedule = teamSchedule(input.current, input.season.season);
  if (!input.scoringProfile || input.supportedPositions.length === 0) {
    return {
      schedule,
      ratings: null,
      selectedStrength: null,
      playoffStrength: null,
      completeSlices: 0,
      incompleteSlices: 0,
    };
  }
  const games = [...input.prior.games, ...input.current.games].map((game) => ({
    season: game.season,
    week: game.week,
    gameId: game.gameId,
    awayTeam: game.awayTeam,
    homeTeam: game.homeTeam,
    status: game.status,
  }));
  const stats = [...input.prior.stats, ...input.current.stats];
  const weeklyRosters = [...input.prior.weeklyRosters, ...input.current.weeklyRosters].map(
    (row) => ({
      externalPlayerId: row.externalPlayerId,
      playerId: row.playerId,
      season: row.season,
      week: row.week,
      team: row.team,
      position: row.position,
      status: row.rosterStatus ?? row.statusDescription,
    }),
  );
  const totals = buildScheduleEdgeGamePositionTotals({
    games,
    weeklyStats: stats,
    weeklyRosters,
    scoringProfile: input.scoringProfile,
    positions: input.supportedPositions,
  });
  const ratings = calculateScheduleEdgeDefenseRatings({
    targetSeason: input.season.season,
    throughWeek: Math.max(1, completedThroughWeek(input.season.currentWeek)),
    totals,
    policy: SCHEDULE_EDGE_DESCRIPTIVE_POLICY,
  });
  return {
    schedule,
    ratings,
    selectedStrength: deriveScheduleStrength({
      season: input.season.season,
      startWeek: input.windows.selected.startWeek,
      endWeek: input.windows.selected.endWeek,
      schedule,
      ratings,
      positions: input.supportedPositions,
    }),
    playoffStrength: deriveScheduleStrength({
      season: input.season.season,
      startWeek: input.windows.playoff.startWeek,
      endWeek: input.windows.playoff.endWeek,
      schedule,
      ratings,
      positions: input.supportedPositions,
    }),
    completeSlices: totals.completeSlices,
    incompleteSlices: totals.incompleteSlices,
  };
}

function confidenceForStrength(
  entry: ScheduleStrengthEntry,
): ScheduleEdgeResponse["roster"][number]["selectedWindow"]["confidence"] {
  const available = entry.weeks
    .filter((week) => week.percentile !== null)
    .map((week) => week.confidence);
  if (available.length === 0) return "unavailable";
  if (available.some((value) => value === "low")) return "low";
  if (available.some((value) => value === "medium")) return "medium";
  return "high";
}

function strengthContract(
  entry: ScheduleStrengthEntry | undefined,
  result: ScheduleStrengthResult | null,
): ScheduleEdgeResponse["roster"][number]["selectedWindow"] {
  if (!entry || !result) {
    return {
      state: "unavailable",
      averagePercentile: null,
      rank: null,
      teamsRanked: 0,
      favorableWeeks: 0,
      neutralWeeks: 0,
      difficultWeeks: 0,
      byeWeeks: 0,
      unknownWeeks: 0,
      confidence: "unavailable",
      weeks: [],
      reason: "League-scored schedule strength is not available.",
    };
  }
  const teamsRanked = result.entries.filter(
    (candidate) => candidate.position === entry.position && candidate.averagePercentile !== null,
  ).length;
  const labelsEnabled = directionalLabelsEnabled(entry.position);
  const withheldReason =
    "Directional labels remain withheld because this position has not cleared the historical validation gate.";
  return {
    state:
      entry.averagePercentile === null
        ? "unavailable"
        : entry.unknownWeeks > 0
          ? "partial"
          : "available",
    averagePercentile: entry.averagePercentile,
    rank: entry.rank,
    teamsRanked,
    favorableWeeks: labelsEnabled ? entry.favorableWeeks : 0,
    neutralWeeks: labelsEnabled ? entry.neutralWeeks : 0,
    difficultWeeks: labelsEnabled ? entry.difficultWeeks : 0,
    byeWeeks: entry.byeWeeks,
    unknownWeeks: entry.unknownWeeks,
    confidence: confidenceForStrength(entry),
    weeks: entry.weeks.map((week) => ({
      week: week.week,
      state: week.state === "bye" ? "bye" : week.state === "unknown" ? "unknown" : "game",
      opponent: week.opponent,
      percentile: week.percentile,
      label: labelsEnabled ? week.label : "unavailable",
      confidence: week.confidence,
      reason: week.reason
        ? boundedText(week.reason, 700)
        : !labelsEnabled && week.percentile !== null
          ? withheldReason
          : null,
    })),
    reason: entry.reason
      ? boundedText(entry.reason, 700)
      : entry.unknownWeeks > 0
        ? "One or more weeks lack complete schedule or matchup evidence."
        : !labelsEnabled && entry.averagePercentile !== null
          ? withheldReason
          : null,
  };
}

function ratingContract(
  rating: ScheduleEdgeDefenseRating | undefined,
): ScheduleEdgeResponse["roster"][number]["matchup"] {
  if (!rating || rating.status === "unavailable" || rating.percentile === null) {
    return unavailableMatchup(
      rating?.reason ?? "No admitted opponent-position rating is available.",
    );
  }
  const labelsEnabled = directionalLabelsEnabled(rating.position);
  return {
    state: "available",
    percentile: rating.percentile,
    label: labelsEnabled ? rating.label : "unavailable",
    confidence: rating.confidence,
    rawPointsAllowed: rating.rawPointsPerGame,
    adjustedPointsAllowed: rating.adjustedPointsPerGame,
    leagueAveragePoints: rating.leagueMeanPointsPerGame,
    pointDifferential: rating.pointDifferential,
    currentGames: rating.currentGames,
    priorGames: rating.priorGames,
    incompleteGames: rating.incompleteGames,
    reason: rating.reason
      ? boundedText(rating.reason, 700)
      : labelsEnabled
        ? null
        : "Directional labels remain withheld because this position has not cleared the historical validation gate.",
  };
}

function nextGameContract(
  schedule: TeamScheduleResult,
  nflTeam: NflTeam | null,
  week: number,
): ScheduleEdgeResponse["roster"][number]["next"] {
  if (!nflTeam) {
    return {
      week,
      state: "unknown",
      opponent: null,
      kickoffAt: null,
      reason: "The player's NFL team is not mapped.",
    };
  }
  const scheduleWeek = schedule.teams
    .find((team) => team.team === nflTeam)
    ?.weeks.find((candidate) => candidate.week === week);
  if (!scheduleWeek || scheduleWeek.state === "unknown") {
    return {
      week,
      state: "unknown",
      opponent: null,
      kickoffAt: null,
      reason:
        scheduleWeek?.state === "unknown"
          ? boundedText(scheduleWeek.reason, 700)
          : "This week is outside admitted schedule coverage.",
    };
  }
  if (scheduleWeek.state === "bye") {
    return { week, state: "bye", opponent: null, kickoffAt: null, reason: null };
  }
  return {
    week,
    state: "game",
    opponent: scheduleWeek.game.opponent,
    kickoffAt: scheduleWeek.game.kickoffAt?.toISOString() ?? null,
    reason: null,
  };
}

function supportedRosterPosition(row: ScheduleEdgeRosterEntryRow): SupportedPosition | null {
  const primary = row.primaryPosition.toUpperCase();
  return SUPPORTED_POSITION_SET.has(primary) ? (primary as SupportedPosition) : null;
}

function findStrength(
  result: ScheduleStrengthResult | null,
  team: NflTeam | null,
  position: SupportedPosition | null,
): ScheduleStrengthEntry | undefined {
  if (!result || !team || !position) return undefined;
  return result.entries.find((entry) => entry.team === team && entry.position === position);
}

function findCurrentRating(
  ratings: ScheduleEdgeDefenseRatingsResult | null,
  next: ScheduleEdgeResponse["roster"][number]["next"],
  position: SupportedPosition | null,
): ScheduleEdgeDefenseRating | undefined {
  if (!ratings || next.state !== "game" || !next.opponent || !position) return undefined;
  return ratings.ratings.find(
    (rating) => rating.defenseTeam === next.opponent && rating.position === position,
  );
}

function byeWeekContracts(
  result: ByeWeekFeasibilityResult | null,
  rosterRows: readonly ScheduleEdgeRosterEntryRow[],
  slots: readonly RosterSlot[] | null,
): ScheduleEdgeResponse["byeWeeks"] {
  if (!result) return [];
  const rosterById = new Map(rosterRows.map((row) => [row.playerId, row]));
  const slotById = new Map((slots ?? []).map((slot) => [slot.id, slot]));
  return result.weeks
    .filter(
      (week) => week.byePlayerIds.length > 0 || week.status === "gap" || week.status === "unknown",
    )
    .map((week) => {
      const affectedPlayers = week.byePlayerIds.flatMap((id) => {
        const row = rosterById.get(id);
        if (!row) return [];
        return [
          {
            playerId: row.playerId,
            name: row.name,
            position: row.primaryPosition,
            nflTeam: validNflTeam(row.nflTeam) ? row.nflTeam : null,
          },
        ];
      });
      const unfilledSlotLabels = week.unfilledSlotIds.map(
        (slotId) => slotById.get(slotId)?.label ?? String(slotId),
      );
      const detail =
        week.status === "gap"
          ? `Week ${week.week} has no legal complete lineup after confirmed byes.`
          : week.status === "thin"
            ? `Week ${week.week} remains legal, but one more relevant absence would create a gap.`
            : week.status === "covered"
              ? `Week ${week.week} retains a legal lineup after confirmed byes.`
              : boundedText(
                  `Week ${week.week} cannot be checked safely: ${week.reasons.join(" ")}`,
                  700,
                );
      return {
        week: week.week,
        status: week.status,
        affectedPlayers,
        fragilePlayerIds: [...week.criticalPlayerIds],
        unfilledSlotLabels,
        detail,
      };
    });
}

function prioritizedFindings(
  leagueId: string,
  byeWeeks: ScheduleEdgeResponse["byeWeeks"],
  rosterRows: readonly ScheduleEdgeRosterEntryRow[],
  roster: ScheduleEdgeResponse["roster"],
): ScheduleEdgeResponse["findings"] {
  const likelyStarterIds = new Set(
    rosterRows.filter((row) => row.isStarter).map((row) => row.playerId),
  );
  const findings: ScheduleEdgeResponse["findings"] = [];
  for (const week of byeWeeks) {
    if (week.status === "gap") {
      findings.push({
        id: `bye-gap:${week.week}`,
        kind: "bye-gap",
        severity: "critical",
        title: `Week ${week.week} lineup gap`,
        detail: week.detail,
        week: week.week,
        playerId: null,
        href: `/decisions?league=${encodeURIComponent(leagueId)}`,
        factors: [
          `${week.affectedPlayers.length} rostered player${week.affectedPlayers.length === 1 ? "" : "s"} on bye`,
          ...week.unfilledSlotLabels.map((label) => `Unfilled ${label}`),
        ].slice(0, 12),
      });
      continue;
    }
    if (week.status === "thin") {
      findings.push({
        id: `bye-thin:${week.week}`,
        kind: "bye-thin",
        severity: "watch",
        title: `Week ${week.week} has little margin`,
        detail: week.detail,
        week: week.week,
        playerId: null,
        href: `/decisions?league=${encodeURIComponent(leagueId)}`,
        factors: [
          `${week.fragilePlayerIds.length} essential available player${week.fragilePlayerIds.length === 1 ? "" : "s"}`,
        ],
      });
      continue;
    }
    if (week.status === "unknown") {
      findings.push({
        id: `bye-unknown:${week.week}`,
        kind: "bye-unknown",
        severity: "info",
        title: `Week ${week.week} needs another look`,
        detail: week.detail,
        week: week.week,
        playerId: null,
        href: null,
        factors: ["Roster, slot, or admitted schedule coverage is incomplete."],
      });
      continue;
    }
    const starter = week.affectedPlayers.find((player) => likelyStarterIds.has(player.playerId));
    if (starter) {
      findings.push({
        id: `upcoming-bye:${week.week}:${starter.playerId}`,
        kind: "upcoming-bye",
        severity: "watch",
        title: boundedText(`${starter.name} is off in Week ${week.week}`, 160),
        detail: boundedText(
          `${starter.name} is currently marked as a starter. The league's slot rules still produce a legal lineup, but the open decision is worth planning now.`,
          700,
        ),
        week: week.week,
        playerId: starter.playerId,
        href: `/decisions?league=${encodeURIComponent(leagueId)}`,
        factors: [
          boundedText(`${starter.position} · ${starter.nflTeam ?? "NFL team unavailable"}`, 300),
        ],
      });
    }
  }
  for (const player of roster) {
    const normalizedPosition = player.primaryPosition.toUpperCase();
    const position = SUPPORTED_POSITION_SET.has(normalizedPosition)
      ? (normalizedPosition as SupportedPosition)
      : null;
    if (!position || !directionalLabelsEnabled(position)) continue;
    if (
      player.selectedWindow.state !== "unavailable" &&
      player.selectedWindow.averagePercentile !== null &&
      player.selectedWindow.favorableWeeks > 0 &&
      player.selectedWindow.averagePercentile >= 67
    ) {
      findings.push({
        id: `favorable-window:${player.playerId}`,
        kind: "favorable-window",
        severity: "edge",
        title: boundedText(`${player.name} has a favorable window`, 160),
        detail: boundedText(
          `${player.name}'s ${player.primaryPosition} schedule averages the ${Math.round(player.selectedWindow.averagePercentile)}th matchup percentile across the selected weeks.`,
          700,
        ),
        week: null,
        playerId: player.playerId,
        href: `/stats/players/${encodeURIComponent(player.playerId)}`,
        factors: [
          `${player.selectedWindow.favorableWeeks} favorable week${player.selectedWindow.favorableWeeks === 1 ? "" : "s"}`,
          `Rank ${player.selectedWindow.rank ?? "—"} of ${player.selectedWindow.teamsRanked}`,
        ],
      });
    } else if (
      player.selectedWindow.state !== "unavailable" &&
      player.selectedWindow.averagePercentile !== null &&
      player.selectedWindow.difficultWeeks > 0 &&
      player.selectedWindow.averagePercentile <= 33
    ) {
      findings.push({
        id: `difficult-window:${player.playerId}`,
        kind: "difficult-window",
        severity: "watch",
        title: boundedText(`${player.name} has a difficult window`, 160),
        detail: boundedText(
          `${player.name}'s ${player.primaryPosition} schedule averages the ${Math.round(player.selectedWindow.averagePercentile)}th matchup percentile across the selected weeks.`,
          700,
        ),
        week: null,
        playerId: player.playerId,
        href: `/stats/players/${encodeURIComponent(player.playerId)}`,
        factors: [
          `${player.selectedWindow.difficultWeeks} difficult week${player.selectedWindow.difficultWeeks === 1 ? "" : "s"}`,
          `Rank ${player.selectedWindow.rank ?? "—"} of ${player.selectedWindow.teamsRanked}`,
        ],
      });
    }
  }
  const priority = { critical: 0, watch: 1, edge: 2, info: 3 } as const;
  return [...findings]
    .sort(
      (left, right) =>
        priority[left.severity] - priority[right.severity] ||
        (left.week ?? 99) - (right.week ?? 99) ||
        left.id.localeCompare(right.id),
    )
    .slice(0, 3);
}

function scheduleAvailability(source: ScheduleEdgeSource): ScheduleEdgeAvailability {
  return source.state === "available"
    ? availability("available", null)
    : availability("unavailable", source.reason ?? "The current-season schedule is not available.");
}

function matchupAvailability(
  scoring: LeagueScoringNormalizationResult | null,
  analysis: ComputedScheduleEdgeAnalysis,
): ScheduleEdgeAvailability {
  if (!scoring) {
    return availability(
      "unavailable",
      "The league's scoring rules cannot be normalized safely for this analysis.",
    );
  }
  // Gate on the schedule-edge-relevant positions, not the whole-league `state` — a league scoring
  // only kicking (state "available") still withholds every QB/RB/WR/TE matchup.
  const supported = scheduleEdgeSupportedPositions(scoring);
  if (supported.length === 0) {
    return availability("unavailable", withheldPositionsReason(scoring, SUPPORTED_POSITIONS));
  }
  if (!analysis.ratings || analysis.completeSlices === 0) {
    return availability(
      "unavailable",
      "No complete league-scored defense-position observations are available.",
    );
  }
  const availableRatings = analysis.ratings.ratings.filter(
    (rating) => rating.status === "available" && rating.percentile !== null,
  );
  if (availableRatings.length === 0) {
    return availability(
      "unavailable",
      "Current and prior evidence do not support a defense-position comparison.",
    );
  }
  const withheld = SUPPORTED_POSITIONS.filter((position) => !supported.includes(position));
  const positionsReason = withheld.length > 0 ? withheldPositionsReason(scoring, withheld) : null;
  if (releaseHasDirectionalLabels()) {
    return availability(
      "partial",
      analysis.incompleteSlices > 0
        ? "Some game-position observations were withheld because their evidence was incomplete."
        : positionsReason,
    );
  }
  return availability(
    "partial",
    positionsReason ??
      "League-scored values are available, but directional labels remain disabled until historical validation admits a production policy.",
  );
}

function validationStatus(
  matchups: ScheduleEdgeAvailability,
): ScheduleEdgeResponse["algorithm"]["validationStatus"] {
  if (matchups.state === "unavailable") return "withheld";
  return releaseHasDirectionalLabels() ? "validated" : "descriptive-only";
}

function scoringAvailability(
  normalized: LeagueScoringNormalizationResult | null,
  limited: boolean,
): ScheduleEdgeAvailability {
  if (limited) {
    return availability(
      "unavailable",
      "Scoring rules exceeded the bounded read, so no partial profile was used.",
    );
  }
  if (!normalized) {
    return availability(
      "unavailable",
      "The stored league scoring rules cannot be reconstructed safely for these positions.",
    );
  }
  const supported = scheduleEdgeSupportedPositions(normalized);
  const withheld = SUPPORTED_POSITIONS.filter((position) => !supported.includes(position));
  if (withheld.length === 0) return availability("available", null);
  if (supported.length === 0) {
    return availability("unavailable", withheldPositionsReason(normalized, withheld));
  }
  return availability("partial", withheldPositionsReason(normalized, withheld));
}

function rosterAvailability(
  claimedTeam: ScheduleEdgeTeamRow | undefined,
  snapshot: ScheduleEdgeRosterSnapshotRow | undefined,
  rows: readonly ScheduleEdgeRosterEntryRow[],
  limited: boolean,
): ScheduleEdgeAvailability {
  if (!claimedTeam) {
    return availability(
      "unavailable",
      "Select your fantasy team in Settings to see a personalized roster outlook.",
    );
  }
  if (!snapshot) {
    return availability("unavailable", "The selected team has no synchronized roster snapshot.");
  }
  if (limited) {
    return availability(
      "unavailable",
      "The roster exceeded the bounded read, so no partial roster was analyzed.",
    );
  }
  if (rows.length === 0) {
    return availability("unavailable", "The latest roster snapshot is empty.");
  }
  if (rows.some((row) => domainPlayer(row) === null || !validNflTeam(row.nflTeam))) {
    return availability(
      "partial",
      "One or more roster players lack supported position or NFL-team identity.",
    );
  }
  return availability("available", null);
}

function byeAvailability(
  claimedTeam: ScheduleEdgeTeamRow | undefined,
  slots: readonly RosterSlot[] | null,
  result: ByeWeekFeasibilityResult | null,
): ScheduleEdgeAvailability {
  if (!claimedTeam) {
    return availability(
      "unavailable",
      "Select your fantasy team in Settings to check bye-week lineup coverage.",
    );
  }
  if (!slots) {
    return availability(
      "unavailable",
      "The league's starter slots are missing, invalid, or exceed the supported bound.",
    );
  }
  if (!result) {
    return availability(
      "unavailable",
      "Roster or schedule evidence is not available for bye-week analysis.",
    );
  }
  if (result.weeks.some((week) => week.status === "unknown")) {
    return availability(
      "partial",
      "At least one selected week has incomplete roster or schedule coverage.",
    );
  }
  return availability("available", null);
}

function evidenceSources(
  current: LoadedScheduleEvidence,
  prior: LoadedScheduleEvidence,
): ScheduleEdgeSource[] {
  return [
    current.scheduleSource,
    current.statsSource,
    current.rostersSource,
    prior.scheduleSource,
    prior.statsSource,
    prior.rostersSource,
  ];
}

export class ScheduleEdgeService {
  readonly #repository: ScheduleEdgeRepository;
  readonly #clock: () => Date;

  constructor(repository: ScheduleEdgeRepository, clock: () => Date = () => new Date()) {
    this.#repository = repository;
    this.#clock = clock;
  }

  async getRosterEdge(
    actorUserId: string,
    leagueIdValue: string,
    query: ScheduleEdgeMemberQuery,
  ): Promise<ScheduleEdgeResponse | undefined> {
    const membership = await this.#repository.findMembership(actorUserId, leagueIdValue);
    if (!membership) return undefined;
    const season = await this.#repository.findLatestSeason(leagueIdValue);
    if (!season) return undefined;
    const windows = resolveScheduleEdgeWindows(season.currentWeek, season.settings, query);
    const throughWeek = completedThroughWeek(season.currentWeek);
    const [scoringRowsRead, current, prior, claimedTeam] = await Promise.all([
      this.#repository.listScoringRules(season.id, SCHEDULE_EDGE_LIMITS.scoringRules),
      loadSeasonEvidence(this.#repository, season.season, throughWeek),
      loadSeasonEvidence(this.#repository, season.season - 1, 18),
      membership.claimedFantasyTeamId
        ? this.#repository.findTeam(season.id, membership.claimedFantasyTeamId)
        : Promise.resolve(undefined),
    ]);
    const scoringLimited = scoringRowsRead.length >= SCHEDULE_EDGE_LIMITS.scoringRules;
    const scoring = scoringLimited ? null : normalizeScoring(season, scoringRowsRead);
    const profile = scoring?.state === "available" ? scoring.profile : null;
    const supportedPositions = scheduleEdgeSupportedPositions(scoring);
    const analysis = computeAnalysis({
      season,
      windows,
      current,
      prior,
      scoringProfile: profile,
      supportedPositions,
    });

    const snapshot = claimedTeam
      ? await this.#repository.findLatestRosterSnapshot(claimedTeam.id, season.season)
      : undefined;
    const [rosterRowsRead, slotRowsRead] = await Promise.all([
      snapshot
        ? this.#repository.listRosterEntries(snapshot.id, SCHEDULE_EDGE_LIMITS.rosterEntries)
        : Promise.resolve([]),
      claimedTeam
        ? this.#repository.listSlotRules(season.id, SCHEDULE_EDGE_LIMITS.slotRules)
        : Promise.resolve([]),
    ]);
    const rosterLimited = rosterRowsRead.length >= SCHEDULE_EDGE_LIMITS.rosterEntries;
    const slotsLimited = slotRowsRead.length >= SCHEDULE_EDGE_LIMITS.slotRules;
    const rosterRows = rosterLimited
      ? []
      : rosterRowsRead.slice(0, SCHEDULE_EDGE_LIMITS.rosterEntries - 1);
    const slots = slotsLimited ? null : starterSlots(slotRowsRead);
    const projectionContext = await loadProjectionContext(
      this.#repository,
      actorUserId,
      season,
      rosterRows.map((row) => row.playerId),
    );

    const byeRoster = rosterRows.map((row) => {
      const player =
        domainPlayer(row) ??
        ({
          id: playerId(row.playerId),
          name: row.name,
          positions: ["IDP"],
          ...(validNflTeam(row.nflTeam) ? { nflTeam: row.nflTeam } : {}),
          status: playerStatus(row.status),
        } satisfies Player);
      return {
        player,
        rosterState:
          domainPlayer(row) && validNflTeam(row.nflTeam) ? rosterState(row) : ("unknown" as const),
      };
    });
    const byeResult =
      claimedTeam && snapshot && slots && !rosterLimited && rosterRows.length > 0
        ? deriveByeWeekFeasibility({
            season: season.season,
            startWeek: windows.selected.startWeek,
            endWeek: windows.selected.endWeek,
            schedule: analysis.schedule,
            roster: byeRoster,
            slots,
          })
        : null;
    const byeWeeks = byeWeekContracts(byeResult, rosterRows, slots);
    const nextWeek = normalizedCurrentWeek(season.currentWeek) ?? windows.selected.startWeek;
    const roster = rosterRows
      .map((row): ScheduleEdgeResponse["roster"][number] => {
        const team = validNflTeam(row.nflTeam) ? row.nflTeam : null;
        const position = supportedRosterPosition(row);
        const next = nextGameContract(analysis.schedule, team, nextWeek);
        const eligiblePositions = [
          ...new Set([row.primaryPosition, ...row.eligiblePositions].filter(Boolean)),
        ];
        return {
          playerId: row.playerId,
          name: row.name,
          primaryPosition: row.primaryPosition || "Unknown",
          eligiblePositions: eligiblePositions.length > 0 ? eligiblePositions : ["Unknown"],
          nflTeam: team,
          status: row.status,
          isLikelyStarter: row.isStarter,
          currentSlot: row.slotCode || null,
          next,
          matchup:
            next.state === "bye"
              ? unavailableMatchup("An affirmed bye has no defensive matchup.")
              : ratingContract(findCurrentRating(analysis.ratings, next, position)),
          selectedWindow: strengthContract(
            findStrength(analysis.selectedStrength, team, position),
            analysis.selectedStrength,
          ),
          playoffWindow: strengthContract(
            findStrength(analysis.playoffStrength, team, position),
            analysis.playoffStrength,
          ),
          projection: projectionForPlayer(row.playerId, projectionContext),
        };
      })
      .sort(
        (left, right) =>
          Number(right.next.state === "bye") - Number(left.next.state === "bye") ||
          Number(right.isLikelyStarter) - Number(left.isLikelyStarter) ||
          left.name.localeCompare(right.name) ||
          left.playerId.localeCompare(right.playerId),
      );
    const profileKeyHash = profile === null ? null : hash(projectionScoringProfileKey(profile));
    const sources = [...evidenceSources(current, prior), ...projectionContext.sources].slice(0, 12);
    const inputHash = hash({
      algorithm: SCHEDULE_EDGE_ALGORITHM_VERSION,
      policy: SCHEDULE_EDGE_DESCRIPTIVE_POLICY,
      evaluation: {
        version: SCHEDULE_EDGE_EVALUATION_ARTIFACT.version,
        evidenceChecksum: SCHEDULE_EDGE_EVALUATION_ARTIFACT.evidenceChecksum,
        releaseState: SCHEDULE_EDGE_EVALUATION_ARTIFACT.releaseState,
      },
      leagueSeasonId: season.id,
      claimedTeamId: claimedTeam?.id ?? null,
      currentWeek: season.currentWeek,
      windows,
      profileKeyHash,
      sources: sources.map((source) => ({
        key: source.key,
        state: source.state,
        checksum: source.checksumSha256,
      })),
      rosterSnapshotId: snapshot?.id ?? null,
      starterSlots:
        slots?.map((slot) => ({
          id: slot.id,
          type: slot.type,
          eligiblePositions: slot.eligiblePositions,
        })) ?? null,
      projectionSets: {
        weekly: projectionInput(projectionContext.weekly),
        ros: projectionInput(projectionContext.ros),
      },
    });
    const matchups = matchupAvailability(scoring, analysis);
    const response: ScheduleEdgeResponse = {
      generatedAt: this.#clock().toISOString(),
      algorithm: {
        version: `${SCHEDULE_EDGE_ALGORITHM_VERSION}/${SCHEDULE_EDGE_DESCRIPTIVE_POLICY.version}`,
        inputHash,
        evidenceChecksum: SCHEDULE_EDGE_EVALUATION_ARTIFACT.evidenceChecksum,
        validationStatus: validationStatus(matchups),
      },
      league: {
        id: membership.leagueId,
        leagueSeasonId: season.id,
        name: membership.leagueName,
        provider: season.provider,
        season: season.season,
        currentWeek: normalizedCurrentWeek(season.currentWeek),
        claimedTeam: claimedTeam ? { id: claimedTeam.id, name: claimedTeam.name } : null,
      },
      windows,
      availability: {
        schedule: scheduleAvailability(current.scheduleSource),
        scoring: scoringAvailability(scoring, scoringLimited),
        matchups,
        roster: rosterAvailability(claimedTeam, snapshot, rosterRows, rosterLimited),
        projections: projectionContext.availability,
        byeFeasibility: byeAvailability(claimedTeam, slots, byeResult),
      },
      scoring: {
        profileKeyHash,
        warnings: scoring ? scoringWarnings(scoring) : [],
      },
      findings: prioritizedFindings(leagueIdValue, byeWeeks, rosterRows, roster),
      roster,
      byeWeeks,
      sources,
      definitions: DEFINITIONS,
    };
    return response;
  }

  async getMatrix(
    actorUserId: string,
    leagueIdValue: string,
    query: ScheduleEdgeMatrixQuery,
  ): Promise<ScheduleEdgeMatrixResponse | undefined> {
    const membership = await this.#repository.findMembership(actorUserId, leagueIdValue);
    if (!membership) return undefined;
    const season = await this.#repository.findLatestSeason(leagueIdValue);
    if (!season) return undefined;
    const windows = resolveScheduleEdgeWindows(season.currentWeek, season.settings, query);
    const throughWeek = completedThroughWeek(season.currentWeek);
    const [scoringRowsRead, current, prior] = await Promise.all([
      this.#repository.listScoringRules(season.id, SCHEDULE_EDGE_LIMITS.scoringRules),
      loadSeasonEvidence(this.#repository, season.season, throughWeek),
      loadSeasonEvidence(this.#repository, season.season - 1, 18),
    ]);
    const scoringLimited = scoringRowsRead.length >= SCHEDULE_EDGE_LIMITS.scoringRules;
    const scoring = scoringLimited ? null : normalizeScoring(season, scoringRowsRead);
    const profile = scoring?.state === "available" ? scoring.profile : null;
    const supportedPositions = scheduleEdgeSupportedPositions(scoring);
    const analysis = computeAnalysis({
      season,
      windows,
      current,
      prior,
      scoringProfile: profile,
      supportedPositions,
    });
    const profileKeyHash = profile === null ? null : hash(projectionScoringProfileKey(profile));
    const teams = [...NFL_TEAMS].map((team) => ({
      team,
      positions: SCHEDULE_EDGE_POSITIONS.map((position) => ({
        position,
        selectedWindow: strengthContract(
          findStrength(analysis.selectedStrength, team, position),
          analysis.selectedStrength,
        ),
        playoffWindow: strengthContract(
          findStrength(analysis.playoffStrength, team, position),
          analysis.playoffStrength,
        ),
      })),
    }));
    const sources = evidenceSources(current, prior);
    const inputHash = hash({
      algorithm: SCHEDULE_EDGE_ALGORITHM_VERSION,
      policy: SCHEDULE_EDGE_DESCRIPTIVE_POLICY,
      evaluation: {
        version: SCHEDULE_EDGE_EVALUATION_ARTIFACT.version,
        evidenceChecksum: SCHEDULE_EDGE_EVALUATION_ARTIFACT.evidenceChecksum,
        releaseState: SCHEDULE_EDGE_EVALUATION_ARTIFACT.releaseState,
      },
      leagueSeasonId: season.id,
      currentWeek: season.currentWeek,
      windows,
      profileKeyHash,
      sources: sources.map((source) => ({
        key: source.key,
        state: source.state,
        checksum: source.checksumSha256,
      })),
    });
    const matchups = matchupAvailability(scoring, analysis);
    return {
      generatedAt: this.#clock().toISOString(),
      algorithm: {
        version: `${SCHEDULE_EDGE_ALGORITHM_VERSION}/${SCHEDULE_EDGE_DESCRIPTIVE_POLICY.version}`,
        inputHash,
        evidenceChecksum: SCHEDULE_EDGE_EVALUATION_ARTIFACT.evidenceChecksum,
        validationStatus: validationStatus(matchups),
      },
      league: {
        id: membership.leagueId,
        leagueSeasonId: season.id,
        name: membership.leagueName,
        season: season.season,
      },
      windows,
      availability: {
        schedule: scheduleAvailability(current.scheduleSource),
        scoring: scoringAvailability(scoring, scoringLimited),
        matchups,
      },
      scoring: {
        profileKeyHash,
        warnings: scoring ? scoringWarnings(scoring) : [],
      },
      teams,
      sources,
      definitions: DEFINITIONS,
    };
  }
}
