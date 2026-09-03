import {
  assignPlayersToRosterSlots,
  type Player,
  type PlayerId,
  type RosterAssignment,
  type RosterSlot,
  type RosterSlotId,
} from "@laces-out/domain";
import {
  normalizeHistoricalPlayerStatComponents,
  projectionScoringProfileKey,
  scoreProjectionStatComponents,
  type ProjectionScoringProfile,
  type ProjectionStatComponents,
} from "@laces-out/projections";

import {
  ANALYTICS_EPSILON,
  assertFinite,
  assertNonNegative,
  mean,
  strengthPercentile,
} from "./shared.js";
import type { ScheduleGameStatus, TeamScheduleResult } from "./schedule.js";

export const SCHEDULE_EDGE_POSITIONS = ["QB", "RB", "WR", "TE"] as const;
export type ScheduleEdgePosition = (typeof SCHEDULE_EDGE_POSITIONS)[number];

const POSITION_SET = new Set<string>(SCHEDULE_EDGE_POSITIONS);
const TEAM_PATTERN = /^[A-Z]{2,4}$/u;

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right);
}

function validateSeason(season: number): void {
  if (!Number.isSafeInteger(season) || season < 1999 || season > 2200) {
    throw new RangeError("season must be an integer between 1999 and 2200");
  }
}

function validateWeek(week: number, label = "week"): void {
  if (!Number.isSafeInteger(week) || week < 1 || week > 25) {
    throw new RangeError(`${label} must be an integer between 1 and 25`);
  }
}

function validateWeekRange(startWeek: number, endWeek: number): void {
  validateWeek(startWeek, "startWeek");
  validateWeek(endWeek, "endWeek");
  if (endWeek < startWeek) throw new RangeError("endWeek must not precede startWeek");
}

function normalizedIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new TypeError(`${label} cannot be empty`);
  return normalized;
}

function normalizedTeam(value: string, label: string): string {
  const normalized = value.trim().toUpperCase();
  if (!TEAM_PATTERN.test(normalized)) throw new TypeError(`${label} must be an NFL team code`);
  return normalized;
}

function positionsOrDefault(
  positions: readonly ScheduleEdgePosition[] | undefined,
): readonly ScheduleEdgePosition[] {
  const values = [...(positions ?? SCHEDULE_EDGE_POSITIONS)].sort(compareStrings);
  if (new Set(values).size !== values.length) throw new Error("positions must be unique");
  if (values.some((position) => !POSITION_SET.has(position))) {
    throw new Error("positions contain an unsupported Schedule Edge position");
  }
  return values;
}

export type ByeRosterState = "available" | "injured-reserve" | "taxi" | "unknown";

export interface ByeFeasibilityRosterPlayer {
  readonly player: Player;
  readonly rosterState: ByeRosterState;
}

export interface DeriveByeWeekFeasibilityInput {
  readonly season: number;
  readonly startWeek: number;
  readonly endWeek: number;
  readonly schedule: TeamScheduleResult;
  readonly roster: readonly ByeFeasibilityRosterPlayer[];
  readonly slots: readonly RosterSlot[];
}

export type ByeWeekFeasibilityStatus = "covered" | "thin" | "gap" | "unknown";

export interface ByeWeekFeasibilityWeek {
  readonly week: number;
  readonly status: ByeWeekFeasibilityStatus;
  readonly byePlayerIds: readonly PlayerId[];
  readonly availablePlayerIds: readonly PlayerId[];
  readonly criticalPlayerIds: readonly PlayerId[];
  readonly assignments: readonly RosterAssignment[];
  readonly unfilledSlotIds: readonly RosterSlotId[];
  readonly reasons: readonly string[];
}

export interface ByeWeekFeasibilityResult {
  readonly season: number;
  readonly startWeek: number;
  readonly endWeek: number;
  readonly weeks: readonly ByeWeekFeasibilityWeek[];
  readonly definition: string;
}

const BYE_FEASIBILITY_DEFINITION =
  "Bye feasibility uses exact position-eligibility matching against every starter slot. Bench players remain available as depth, while injured-reserve and taxi players do not. Thin means a legal lineup exists but at least one additional available player's removal would make it infeasible.";

function matching(
  players: readonly Player[],
  slots: readonly RosterSlot[],
): {
  readonly feasible: boolean;
  readonly assignments: readonly RosterAssignment[];
  readonly unfilledSlotIds: readonly RosterSlotId[];
} {
  const result = assignPlayersToRosterSlots(players, slots);
  const filled = new Set(result.assignments.map((assignment) => assignment.slotId));
  const unfilledSlotIds = slots
    .filter((slot) => !filled.has(slot.id))
    .map((slot) => slot.id)
    .sort(compareStrings);
  return {
    feasible: unfilledSlotIds.length === 0,
    assignments: [...result.assignments].sort(
      (left, right) =>
        compareStrings(left.slotId, right.slotId) || compareStrings(left.playerId, right.playerId),
    ),
    unfilledSlotIds,
  };
}

export function deriveByeWeekFeasibility(
  input: DeriveByeWeekFeasibilityInput,
): ByeWeekFeasibilityResult {
  validateSeason(input.season);
  validateWeekRange(input.startWeek, input.endWeek);
  if (input.schedule.season !== input.season) {
    throw new Error("schedule season does not match bye-feasibility season");
  }

  const roster = [...input.roster].sort((left, right) =>
    compareStrings(left.player.id, right.player.id),
  );
  if (new Set(roster.map((entry) => entry.player.id)).size !== roster.length) {
    throw new Error("bye-feasibility roster contains duplicate players");
  }
  const starterSlots = input.slots
    .filter((slot) => slot.kind === "STARTER")
    .sort((left, right) => compareStrings(left.id, right.id));
  const duplicateSlots = new Set(input.slots.map((slot) => slot.id)).size !== input.slots.length;
  const globalReasons = [
    ...(starterSlots.length === 0 ? ["No starter slots are available."] : []),
    ...(starterSlots.length > 30
      ? ["The league exceeds the supported limit of 30 starter slots."]
      : []),
    ...(duplicateSlots ? ["Roster slots do not have unique identities."] : []),
    ...(starterSlots.some((slot) => slot.eligiblePositions.length === 0)
      ? ["At least one starter slot has no supported position eligibility."]
      : []),
    ...(roster.some((entry) => entry.rosterState === "unknown")
      ? ["At least one roster player's active roster state is unknown."]
      : []),
    ...(roster.some(
      (entry) =>
        entry.rosterState === "available" &&
        (entry.player.positions.length === 0 || entry.player.nflTeam === undefined),
    )
      ? ["At least one available roster player lacks position or NFL-team coverage."]
      : []),
  ];
  const teamSchedule = new Map(input.schedule.teams.map((entry) => [entry.team, entry]));
  const weeks = Array.from(
    { length: input.endWeek - input.startWeek + 1 },
    (_, index) => input.startWeek + index,
  ).map((week): ByeWeekFeasibilityWeek => {
    const reasons = [...globalReasons];
    const byePlayerIds: PlayerId[] = [];
    const availablePlayers: Player[] = [];

    if (reasons.length === 0) {
      for (const entry of roster) {
        if (entry.rosterState !== "available") continue;
        const team = entry.player.nflTeam;
        if (!team) continue;
        const scheduleWeek = teamSchedule
          .get(team)
          ?.weeks.find((candidate) => candidate.week === week);
        if (!scheduleWeek || scheduleWeek.state === "unknown") {
          reasons.push(
            scheduleWeek?.state === "unknown"
              ? `${entry.player.name}'s Week ${week} schedule is unknown: ${scheduleWeek.reason}`
              : `${entry.player.name}'s Week ${week} schedule is not covered.`,
          );
          continue;
        }
        if (scheduleWeek.state === "bye") byePlayerIds.push(entry.player.id);
        else availablePlayers.push(entry.player);
      }
    }

    const orderedByeIds = [...byePlayerIds].sort(compareStrings);
    const availablePlayerIds = availablePlayers.map((player) => player.id).sort(compareStrings);
    if (reasons.length > 0) {
      return {
        week,
        status: "unknown",
        byePlayerIds: orderedByeIds,
        availablePlayerIds,
        criticalPlayerIds: [],
        assignments: [],
        unfilledSlotIds: [],
        reasons: [...new Set(reasons)].sort(compareStrings),
      };
    }

    const base = matching(availablePlayers, starterSlots);
    if (!base.feasible) {
      return {
        week,
        status: "gap",
        byePlayerIds: orderedByeIds,
        availablePlayerIds,
        criticalPlayerIds: [],
        assignments: base.assignments,
        unfilledSlotIds: base.unfilledSlotIds,
        reasons: ["No legal complete starting lineup remains after affirmed byes."],
      };
    }

    const criticalPlayerIds = availablePlayers
      .filter(
        (candidate) =>
          !matching(
            availablePlayers.filter((player) => player.id !== candidate.id),
            starterSlots,
          ).feasible,
      )
      .map((player) => player.id)
      .sort(compareStrings);
    const status = criticalPlayerIds.length > 0 ? "thin" : "covered";
    return {
      week,
      status,
      byePlayerIds: orderedByeIds,
      availablePlayerIds,
      criticalPlayerIds,
      assignments: base.assignments,
      unfilledSlotIds: [],
      reasons:
        status === "thin"
          ? ["A legal lineup remains, but at least one available player is essential to it."]
          : [],
    };
  });

  return {
    season: input.season,
    startWeek: input.startWeek,
    endWeek: input.endWeek,
    weeks,
    definition: BYE_FEASIBILITY_DEFINITION,
  };
}

export interface ScheduleEdgeGameFact {
  readonly season: number;
  readonly week: number;
  readonly gameId: string;
  readonly awayTeam: string;
  readonly homeTeam: string;
  readonly status: ScheduleGameStatus;
}

export interface ScheduleEdgeWeeklyStatFact {
  readonly externalPlayerId: string;
  readonly playerId: string | null;
  readonly season: number;
  readonly week: number;
  readonly gameId: string;
  readonly team: string;
  readonly opponentTeam: string;
  readonly components: ProjectionStatComponents;
}

export interface ScheduleEdgeWeeklyRosterFact {
  readonly externalPlayerId: string;
  readonly playerId: string | null;
  readonly season: number;
  readonly week: number;
  readonly team: string;
  readonly position: string;
  readonly status: string | null;
}

export interface BuildScheduleEdgeGamePositionTotalsInput {
  readonly games: readonly ScheduleEdgeGameFact[];
  readonly weeklyStats: readonly ScheduleEdgeWeeklyStatFact[];
  readonly weeklyRosters: readonly ScheduleEdgeWeeklyRosterFact[];
  readonly scoringProfile: ProjectionScoringProfile;
  readonly positions?: readonly ScheduleEdgePosition[];
}

export interface ScheduleEdgeGamePositionTotal {
  readonly season: number;
  readonly week: number;
  readonly gameId: string;
  readonly offenseTeam: string;
  readonly defenseTeam: string;
  readonly position: ScheduleEdgePosition;
  readonly status: "available" | "unavailable";
  readonly points: number | null;
  readonly rosterPlayers: number;
  readonly scoredPlayers: number;
  readonly zeroStatPlayers: number;
  readonly unmatchedRosterRows: number;
  readonly unmatchedStatRows: number;
  readonly reasons: readonly string[];
}

export interface ScheduleEdgeGamePositionTotalsResult {
  readonly positions: readonly ScheduleEdgePosition[];
  readonly scoringProfileKey: string;
  readonly totals: readonly ScheduleEdgeGamePositionTotal[];
  readonly completeSlices: number;
  readonly incompleteSlices: number;
  readonly definition: string;
}

const GAME_POSITION_TOTAL_DEFINITION =
  "A game-position total is the league-scored sum for a scheduled offense against its defensive opponent. Final games come from admitted schedule facts, player positions come from that week's roster, and an empty or unmatched slice is withheld rather than treated as zero.";

function gameKey(season: number, gameId: string): string {
  return `${season}\u0000${gameId}`;
}

function teamWeekKey(season: number, week: number, team: string): string {
  return `${season}\u0000${week}\u0000${team}`;
}

function gameTeamKey(season: number, gameId: string, team: string): string {
  return `${season}\u0000${gameId}\u0000${team}`;
}

function supportedPosition(value: string): ScheduleEdgePosition | null {
  const normalized = value.trim().toUpperCase();
  return POSITION_SET.has(normalized) ? (normalized as ScheduleEdgePosition) : null;
}

function validateComponents(components: ProjectionStatComponents): void {
  for (const [key, value] of Object.entries(components)) {
    normalizedIdentifier(key, "stat component");
    assertFinite(value, `stat component ${key}`);
  }
}

function validateGamePositionInput(input: BuildScheduleEdgeGamePositionTotalsInput): {
  readonly positions: readonly ScheduleEdgePosition[];
  readonly games: readonly ScheduleEdgeGameFact[];
  readonly stats: readonly ScheduleEdgeWeeklyStatFact[];
  readonly rosters: readonly ScheduleEdgeWeeklyRosterFact[];
} {
  const positions = positionsOrDefault(input.positions);
  const gameIds = new Set<string>();
  const games = input.games.map((game) => {
    validateSeason(game.season);
    validateWeek(game.week);
    const gameId = normalizedIdentifier(game.gameId, "gameId");
    const awayTeam = normalizedTeam(game.awayTeam, "awayTeam");
    const homeTeam = normalizedTeam(game.homeTeam, "homeTeam");
    if (awayTeam === homeTeam) throw new Error("a schedule game cannot contain the same team");
    const key = gameKey(game.season, gameId);
    if (gameIds.has(key)) throw new Error(`Duplicate schedule game ${gameId}`);
    gameIds.add(key);
    return { ...game, gameId, awayTeam, homeTeam };
  });
  const statKeys = new Set<string>();
  const stats = input.weeklyStats.map((row) => {
    validateSeason(row.season);
    validateWeek(row.week);
    const externalPlayerId = normalizedIdentifier(row.externalPlayerId, "externalPlayerId");
    const gameId = normalizedIdentifier(row.gameId, "gameId");
    const team = normalizedTeam(row.team, "stat team");
    const opponentTeam = normalizedTeam(row.opponentTeam, "stat opponentTeam");
    if (team === opponentTeam) throw new Error("a stat row cannot list the same team twice");
    if (row.playerId !== null) normalizedIdentifier(row.playerId, "playerId");
    validateComponents(row.components);
    const key = `${gameKey(row.season, gameId)}\u0000${externalPlayerId}`;
    if (statKeys.has(key)) throw new Error(`Duplicate stat row for ${externalPlayerId}/${gameId}`);
    statKeys.add(key);
    return { ...row, externalPlayerId, gameId, team, opponentTeam };
  });
  const rosterKeys = new Set<string>();
  const rosters = input.weeklyRosters.map((row) => {
    validateSeason(row.season);
    validateWeek(row.week);
    const externalPlayerId = normalizedIdentifier(row.externalPlayerId, "externalPlayerId");
    const team = normalizedTeam(row.team, "roster team");
    const position = normalizedIdentifier(row.position, "roster position").toUpperCase();
    if (row.playerId !== null) normalizedIdentifier(row.playerId, "playerId");
    const key = `${teamWeekKey(row.season, row.week, team)}\u0000${externalPlayerId}\u0000${position}\u0000${row.status ?? ""}`;
    if (rosterKeys.has(key)) {
      throw new Error(
        `Duplicate weekly roster row for ${externalPlayerId}/${row.season}/${row.week}`,
      );
    }
    rosterKeys.add(key);
    return { ...row, externalPlayerId, team, position };
  });
  return { positions, games, stats, rosters };
}

export function buildScheduleEdgeGamePositionTotals(
  input: BuildScheduleEdgeGamePositionTotalsInput,
): ScheduleEdgeGamePositionTotalsResult {
  const { positions, games, stats, rosters } = validateGamePositionInput(input);
  const scoringProfileKey = projectionScoringProfileKey(input.scoringProfile);
  const rostersByTeamWeek = new Map<string, ScheduleEdgeWeeklyRosterFact[]>();
  for (const row of rosters) {
    const key = teamWeekKey(row.season, row.week, row.team);
    rostersByTeamWeek.set(key, [...(rostersByTeamWeek.get(key) ?? []), row]);
  }
  const statsByGameTeam = new Map<string, ScheduleEdgeWeeklyStatFact[]>();
  for (const row of stats) {
    const key = gameTeamKey(row.season, row.gameId, row.team);
    statsByGameTeam.set(key, [...(statsByGameTeam.get(key) ?? []), row]);
  }

  const totals: ScheduleEdgeGamePositionTotal[] = [];
  const finalGames = games
    .filter((game) => game.status === "final")
    .sort(
      (left, right) =>
        left.season - right.season ||
        left.week - right.week ||
        compareStrings(left.gameId, right.gameId),
    );
  for (const game of finalGames) {
    for (const [offenseTeam, defenseTeam] of [
      [game.awayTeam, game.homeTeam],
      [game.homeTeam, game.awayTeam],
    ] as const) {
      const rosterRows =
        rostersByTeamWeek.get(teamWeekKey(game.season, game.week, offenseTeam)) ?? [];
      const statRows =
        statsByGameTeam.get(gameTeamKey(game.season, game.gameId, offenseTeam)) ?? [];
      const contextReasons: string[] = [];
      if (rosterRows.length === 0) {
        contextReasons.push("No admitted weekly roster rows cover this offense and week.");
      }
      if (statRows.length === 0) {
        contextReasons.push("No admitted weekly stat rows cover this offense and game.");
      }
      if (
        statRows.some(
          (row) =>
            row.week !== game.week || row.opponentTeam !== defenseTeam || row.playerId === null,
        )
      ) {
        contextReasons.push(
          "At least one weekly stat row has unmatched identity or conflicting game context.",
        );
      }

      const positionsByPlayer = new Map<string, Set<string>>();
      for (const row of rosterRows) {
        if (!row.playerId) continue;
        const existing = positionsByPlayer.get(row.playerId) ?? new Set<string>();
        existing.add(row.position);
        positionsByPlayer.set(row.playerId, existing);
      }
      for (const position of positions) {
        const reasons = [...contextReasons];
        const positionRosterRows = rosterRows.filter(
          (row) => supportedPosition(row.position) === position,
        );
        const unmatchedRosterRows = positionRosterRows.filter(
          (row) => row.playerId === null,
        ).length;
        if (positionRosterRows.length === 0) {
          reasons.push(`No weekly roster player affirms the ${position} slice.`);
        }
        if (unmatchedRosterRows > 0) {
          reasons.push(`The ${position} roster slice contains unmatched player identities.`);
        }
        const conflictingPlayers = [...positionsByPlayer].filter(([, values]) => values.size > 1);
        if (conflictingPlayers.some(([, values]) => values.has(position))) {
          reasons.push(`At least one player has conflicting week-scoped ${position} eligibility.`);
        }

        const rosterPlayerIds = new Set(
          positionRosterRows.flatMap((row) => (row.playerId ? [row.playerId] : [])),
        );
        let unmatchedStatRows = statRows.filter((row) => row.playerId === null).length;
        const positionStatRows: ScheduleEdgeWeeklyStatFact[] = [];
        for (const row of statRows) {
          if (!row.playerId) continue;
          const playerPositions = positionsByPlayer.get(row.playerId);
          if (!playerPositions || playerPositions.size !== 1) {
            unmatchedStatRows += 1;
            continue;
          }
          const [playerPosition] = playerPositions;
          if (!playerPosition || !POSITION_SET.has(playerPosition)) continue;
          if (playerPosition === position) {
            if (!rosterPlayerIds.has(row.playerId)) unmatchedStatRows += 1;
            else positionStatRows.push(row);
          }
        }
        if (unmatchedStatRows > 0) {
          reasons.push("At least one stat row cannot be assigned to one week-scoped position.");
        }

        const uniqueReasons = [...new Set(reasons)].sort(compareStrings);
        const scoredPlayers = new Set(positionStatRows.map((row) => row.playerId)).size;
        const rosterPlayers = rosterPlayerIds.size;
        if (uniqueReasons.length > 0) {
          totals.push({
            season: game.season,
            week: game.week,
            gameId: game.gameId,
            offenseTeam,
            defenseTeam,
            position,
            status: "unavailable",
            points: null,
            rosterPlayers,
            scoredPlayers,
            zeroStatPlayers: Math.max(0, rosterPlayers - scoredPlayers),
            unmatchedRosterRows,
            unmatchedStatRows,
            reasons: uniqueReasons,
          });
          continue;
        }

        const points = positionStatRows.reduce(
          (sum, row) =>
            sum +
            scoreProjectionStatComponents(
              normalizeHistoricalPlayerStatComponents(row.components),
              input.scoringProfile,
            ),
          0,
        );
        totals.push({
          season: game.season,
          week: game.week,
          gameId: game.gameId,
          offenseTeam,
          defenseTeam,
          position,
          status: "available",
          points,
          rosterPlayers,
          scoredPlayers,
          zeroStatPlayers: Math.max(0, rosterPlayers - scoredPlayers),
          unmatchedRosterRows: 0,
          unmatchedStatRows: 0,
          reasons: [],
        });
      }
    }
  }
  const ordered = totals.sort(
    (left, right) =>
      left.season - right.season ||
      left.week - right.week ||
      compareStrings(left.gameId, right.gameId) ||
      compareStrings(left.offenseTeam, right.offenseTeam) ||
      compareStrings(left.position, right.position),
  );
  return {
    positions,
    scoringProfileKey,
    totals: ordered,
    completeSlices: ordered.filter((total) => total.status === "available").length,
    incompleteSlices: ordered.filter((total) => total.status === "unavailable").length,
    definition: GAME_POSITION_TOTAL_DEFINITION,
  };
}

export interface ScheduleEdgePolicy {
  readonly version: string;
  /** Predictive labels stay disabled until the historical gate locks an admitted policy. */
  readonly labelsEnabled: boolean;
  /** Positions whose held-out evidence cleared the gate for directional language. */
  readonly validatedPositions: readonly ScheduleEdgePosition[];
  readonly offenseShrinkageGames: number;
  readonly defenseShrinkageGames: number;
  readonly priorSeasonPseudoGames: number;
  readonly highConfidenceGames: number;
  readonly minimumCurrentSeasonGamesForLabel: number;
  readonly recencyDecay: number | null;
  readonly allowPriorOnlyLabels: boolean;
  readonly minimumPointDifferentialByPosition: Readonly<Record<ScheduleEdgePosition, number>>;
}

/**
 * Safe default for API and UI integration before historical evaluation admits predictive labels.
 * It derives transparent descriptive values while making favorable/difficult language impossible.
 */
export const SCHEDULE_EDGE_DESCRIPTIVE_POLICY: ScheduleEdgePolicy = {
  version: "schedule-edge-descriptive-v2",
  labelsEnabled: false,
  validatedPositions: [],
  offenseShrinkageGames: 4,
  defenseShrinkageGames: 4,
  priorSeasonPseudoGames: 4,
  highConfidenceGames: 8,
  minimumCurrentSeasonGamesForLabel: 6,
  recencyDecay: null,
  allowPriorOnlyLabels: false,
  minimumPointDifferentialByPosition: {
    QB: 1,
    RB: 1,
    WR: 1,
    TE: 1,
  },
};

/**
 * Locked walk-forward result over the admitted 2022–2025 facts. Candidate selection used
 * 2023–2024 and 2025 was held back for confirmation. No position cleared both folds under every
 * representative scoring profile, so the production policy deliberately keeps directional
 * language disabled while retaining the underlying league-scored values as descriptive context.
 */
export const SCHEDULE_EDGE_EVALUATION_ARTIFACT = {
  version: "schedule-edge-walk-forward-v1",
  evidenceChecksum: "db143047024981db6afdf598d7f3eed3585cba62fa57e3f3dfd952d4ad19bdf6",
  candidateSelectionEvidenceChecksum:
    "57127464b705f967389d2bb482394862912475d92db6594b7b9bccc0a1e744a1",
  confirmationEvidenceChecksum: "07e975b9f137e053f59c39f2dbdbf9f87a7e672ba36ac6e65b6befae85f2b3b8",
  evaluatedSeasons: [2023, 2024, 2025],
  selectedCandidateId: "raw-equal",
  selectedEstimator: "raw",
  releaseState: "descriptive-only",
  validatedPositions: [],
  thresholds: {
    minimumSamplesPerCell: 300,
    minimumDirectionalSamplesPerCell: 80,
    minimumOrderedSeasons: 2,
    minimumRankCorrelation: 0.02,
    minimumBucketSpread: 0.35,
  },
  reason:
    "No position cleared candidate selection and the held-out 2025 confirmation under standard, half-PPR, and full-PPR scoring.",
} as const;

export type ScheduleEdgeMatchupLabel = "favorable" | "neutral" | "difficult" | "unavailable";
export type ScheduleEdgeConfidence = "high" | "medium" | "low" | "unavailable";

export interface ScheduleEdgeDefenseRating {
  readonly defenseTeam: string;
  readonly position: ScheduleEdgePosition;
  readonly status: "available" | "unavailable";
  readonly currentGames: number;
  readonly priorGames: number;
  readonly incompleteGames: number;
  readonly rawPointsPerGame: number | null;
  readonly adjustedPointsPerGame: number | null;
  readonly leagueMeanPointsPerGame: number | null;
  readonly pointDifferential: number | null;
  readonly percentile: number | null;
  readonly label: ScheduleEdgeMatchupLabel;
  readonly confidence: ScheduleEdgeConfidence;
  readonly observedWeight: number;
  readonly priorWeight: number;
  readonly residualGames: number;
  readonly reason: string | null;
}

export interface CalculateScheduleEdgeDefenseRatingsInput {
  readonly targetSeason: number;
  readonly throughWeek: number;
  readonly totals: ScheduleEdgeGamePositionTotalsResult;
  readonly policy: ScheduleEdgePolicy;
}

export interface ScheduleEdgeDefenseRatingsResult {
  readonly targetSeason: number;
  readonly throughWeek: number;
  readonly positions: readonly ScheduleEdgePosition[];
  readonly scoringProfileKey: string;
  readonly policyVersion: string;
  readonly ratings: readonly ScheduleEdgeDefenseRating[];
  readonly definition: string;
}

const DEFENSE_RATING_DEFINITION =
  "Adjusted fantasy points allowed equals the positional league mean plus a defense's residual after accounting for the pregame strength of opposing offenses, then applies the disclosed prior/current shrinkage policy. Percentiles are within position and higher means more favorable for the offense.";

interface ResidualObservation {
  readonly total: ScheduleEdgeGamePositionTotal & { readonly points: number };
  readonly expectation: number | null;
  readonly residual: number | null;
}

function weightedMean(
  rows: readonly { readonly value: number; readonly weight: number }[],
): number | null {
  const totalWeight = rows.reduce((sum, row) => sum + row.weight, 0);
  return totalWeight <= 0
    ? null
    : rows.reduce((sum, row) => sum + row.value * row.weight, 0) / totalWeight;
}

function weightedObservationMean(
  rows: readonly ResidualObservation[],
  value: (row: ResidualObservation) => number | null,
  decay: number | null,
): number | null {
  const ordered = [...rows].sort(
    (left, right) =>
      right.total.week - left.total.week || compareStrings(right.total.gameId, left.total.gameId),
  );
  const newestWeek = ordered[0]?.total.week ?? 0;
  return weightedMean(
    ordered.flatMap((row) => {
      const candidate = value(row);
      return candidate === null
        ? []
        : [
            {
              value: candidate,
              weight: decay === null ? 1 : decay ** (newestWeek - row.total.week),
            },
          ];
    }),
  );
}

function validatePolicy(policy: ScheduleEdgePolicy): void {
  normalizedIdentifier(policy.version, "policy version");
  if (new Set(policy.validatedPositions).size !== policy.validatedPositions.length) {
    throw new Error("validatedPositions must be unique");
  }
  if (policy.validatedPositions.some((position) => !POSITION_SET.has(position))) {
    throw new Error("validatedPositions contain an unsupported Schedule Edge position");
  }
  for (const [label, value] of [
    ["offenseShrinkageGames", policy.offenseShrinkageGames],
    ["defenseShrinkageGames", policy.defenseShrinkageGames],
    ["priorSeasonPseudoGames", policy.priorSeasonPseudoGames],
  ] as const) {
    assertNonNegative(value, label);
  }
  if (!Number.isSafeInteger(policy.highConfidenceGames) || policy.highConfidenceGames < 1) {
    throw new RangeError("highConfidenceGames must be a positive integer");
  }
  if (
    !Number.isSafeInteger(policy.minimumCurrentSeasonGamesForLabel) ||
    policy.minimumCurrentSeasonGamesForLabel < 0
  ) {
    throw new RangeError("minimumCurrentSeasonGamesForLabel must be a non-negative integer");
  }
  if (policy.recencyDecay !== null) {
    assertFinite(policy.recencyDecay, "recencyDecay");
    if (policy.recencyDecay <= 0 || policy.recencyDecay > 1) {
      throw new RangeError("recencyDecay must be greater than zero and at most one");
    }
  }
  for (const position of SCHEDULE_EDGE_POSITIONS) {
    assertNonNegative(
      policy.minimumPointDifferentialByPosition[position],
      `minimum point differential for ${position}`,
    );
  }
}

function observationOrder(
  left: ScheduleEdgeGamePositionTotal,
  right: ScheduleEdgeGamePositionTotal,
): number {
  return (
    left.season - right.season ||
    left.week - right.week ||
    compareStrings(left.gameId, right.gameId) ||
    compareStrings(left.offenseTeam, right.offenseTeam) ||
    compareStrings(left.position, right.position)
  );
}

export function calculateScheduleEdgeDefenseRatings(
  input: CalculateScheduleEdgeDefenseRatingsInput,
): ScheduleEdgeDefenseRatingsResult {
  validateSeason(input.targetSeason);
  validateWeek(input.throughWeek, "throughWeek");
  validatePolicy(input.policy);
  const available = input.totals.totals
    .filter(
      (
        total,
      ): total is ScheduleEdgeGamePositionTotal & {
        readonly status: "available";
        readonly points: number;
      } => total.status === "available" && total.points !== null,
    )
    .sort(observationOrder);
  const residuals: ResidualObservation[] = [];
  let activeSeason: number | null = null;
  let leagueHistory = new Map<ScheduleEdgePosition, { sum: number; games: number }>();
  let offenseHistory = new Map<string, { sum: number; games: number }>();
  let currentSeasonLeague = new Map<ScheduleEdgePosition, { sum: number; games: number }>();
  let currentSeasonOffense = new Map<string, { sum: number; games: number }>();
  for (let index = 0; index < available.length;) {
    const first = available[index]!;
    if (first.season !== activeSeason) {
      const followsPreviousSeason = activeSeason !== null && first.season === activeSeason + 1;
      leagueHistory = followsPreviousSeason
        ? currentSeasonLeague
        : new Map<ScheduleEdgePosition, { sum: number; games: number }>();
      offenseHistory = followsPreviousSeason
        ? currentSeasonOffense
        : new Map<string, { sum: number; games: number }>();
      currentSeasonLeague = new Map();
      currentSeasonOffense = new Map();
      activeSeason = first.season;
    }
    let end = index + 1;
    while (
      end < available.length &&
      available[end]!.season === first.season &&
      available[end]!.week === first.week
    ) {
      end += 1;
    }
    const weekRows = available.slice(index, end);
    for (const total of weekRows) {
      const league = leagueHistory.get(total.position);
      const offense = offenseHistory.get(`${total.position}\u0000${total.offenseTeam}`);
      const leagueMean = league && league.games > 0 ? league.sum / league.games : null;
      const offenseMean = offense && offense.games > 0 ? offense.sum / offense.games : null;
      const expectation =
        leagueMean === null
          ? null
          : offenseMean === null
            ? leagueMean
            : (offenseMean * offense!.games + leagueMean * input.policy.offenseShrinkageGames) /
              (offense!.games + input.policy.offenseShrinkageGames);
      residuals.push({
        total,
        expectation,
        residual: expectation === null ? null : total.points - expectation,
      });
    }
    // Update only after the entire week has been evaluated. Without kickoff chronology, using
    // another game from the target week would make results depend on lexical game ordering.
    for (const total of weekRows) {
      const league = leagueHistory.get(total.position) ?? { sum: 0, games: 0 };
      leagueHistory.set(total.position, {
        sum: league.sum + total.points,
        games: league.games + 1,
      });
      const currentLeague = currentSeasonLeague.get(total.position) ?? {
        sum: 0,
        games: 0,
      };
      currentSeasonLeague.set(total.position, {
        sum: currentLeague.sum + total.points,
        games: currentLeague.games + 1,
      });
      const offenseKey = `${total.position}\u0000${total.offenseTeam}`;
      const offense = offenseHistory.get(offenseKey) ?? { sum: 0, games: 0 };
      offenseHistory.set(offenseKey, {
        sum: offense.sum + total.points,
        games: offense.games + 1,
      });
      const currentOffense = currentSeasonOffense.get(offenseKey) ?? {
        sum: 0,
        games: 0,
      };
      currentSeasonOffense.set(offenseKey, {
        sum: currentOffense.sum + total.points,
        games: currentOffense.games + 1,
      });
    }
    index = end;
  }

  const currentSeasonRows = residuals.filter(
    (row) => row.total.season === input.targetSeason && row.total.week <= input.throughWeek,
  );
  const priorSeasonRows = residuals.filter((row) => row.total.season === input.targetSeason - 1);
  const teams = [
    ...new Set(
      input.totals.totals
        .filter(
          (total) => total.season === input.targetSeason || total.season === input.targetSeason - 1,
        )
        .map((total) => total.defenseTeam),
    ),
  ].sort(compareStrings);
  const baseRatings = input.totals.positions.flatMap((position) => {
    const currentLeagueMean = weightedObservationMean(
      currentSeasonRows.filter((row) => row.total.position === position),
      (row) => row.total.points,
      input.policy.recencyDecay,
    );
    const priorLeagueMean = weightedObservationMean(
      priorSeasonRows.filter((row) => row.total.position === position),
      (row) => row.total.points,
      null,
    );
    return teams.map((defenseTeam) => {
      const current = currentSeasonRows.filter(
        (row) => row.total.position === position && row.total.defenseTeam === defenseTeam,
      );
      const prior = priorSeasonRows.filter(
        (row) => row.total.position === position && row.total.defenseTeam === defenseTeam,
      );
      const raw = weightedObservationMean(
        current,
        (row) => row.total.points,
        input.policy.recencyDecay,
      );
      const currentResidual = weightedObservationMean(
        current,
        (row) => row.residual,
        input.policy.recencyDecay,
      );
      const priorResidual = weightedObservationMean(prior, (row) => row.residual, null);
      const currentAdjusted =
        currentLeagueMean === null || currentResidual === null
          ? raw
          : currentLeagueMean + currentResidual;
      const priorAdjusted =
        priorLeagueMean === null
          ? null
          : priorResidual === null
            ? weightedObservationMean(prior, (row) => row.total.points, null)
            : priorLeagueMean + priorResidual;
      const currentWeight = current.length;
      const priorPseudoWeight = priorAdjusted === null ? 0 : input.policy.priorSeasonPseudoGames;
      const adjusted =
        currentAdjusted === null
          ? priorPseudoWeight > 0
            ? priorAdjusted
            : null
          : priorAdjusted === null
            ? currentAdjusted
            : (currentAdjusted * currentWeight + priorAdjusted * priorPseudoWeight) /
              (currentWeight + priorPseudoWeight);
      const defenseShrinkage =
        adjusted === null || (currentLeagueMean ?? priorLeagueMean) === null
          ? adjusted
          : (adjusted * (currentWeight + priorPseudoWeight) +
              (currentLeagueMean ?? priorLeagueMean)! * input.policy.defenseShrinkageGames) /
            (currentWeight + priorPseudoWeight + input.policy.defenseShrinkageGames);
      const baseline = currentLeagueMean ?? priorLeagueMean;
      const incompleteGames = input.totals.totals.filter(
        (total) =>
          total.status === "unavailable" &&
          total.season === input.targetSeason &&
          total.week <= input.throughWeek &&
          total.defenseTeam === defenseTeam &&
          total.position === position,
      ).length;
      const confidence: ScheduleEdgeConfidence =
        defenseShrinkage === null
          ? "unavailable"
          : input.throughWeek < 4
            ? "low"
            : current.length >= input.policy.highConfidenceGames
              ? "high"
              : current.length > 0
                ? prior.length > 0
                  ? "medium"
                  : "low"
                : prior.length > 0
                  ? "low"
                  : "unavailable";
      const totalBlendWeight = currentWeight + priorPseudoWeight;
      return {
        defenseTeam,
        position,
        status: defenseShrinkage === null ? ("unavailable" as const) : ("available" as const),
        currentGames: current.length,
        priorGames: prior.length,
        incompleteGames,
        rawPointsPerGame: raw,
        adjustedPointsPerGame: defenseShrinkage,
        leagueMeanPointsPerGame: baseline,
        pointDifferential:
          defenseShrinkage === null || baseline === null ? null : defenseShrinkage - baseline,
        confidence,
        observedWeight: totalBlendWeight === 0 ? 0 : currentWeight / totalBlendWeight,
        priorWeight: totalBlendWeight === 0 ? 0 : priorPseudoWeight / totalBlendWeight,
        residualGames: current.filter((row) => row.residual !== null).length,
      };
    });
  });

  const ratings: ScheduleEdgeDefenseRating[] = baseRatings
    .map((rating): ScheduleEdgeDefenseRating => {
      if (
        rating.status === "unavailable" ||
        rating.adjustedPointsPerGame === null ||
        rating.pointDifferential === null
      ) {
        return {
          ...rating,
          percentile: null,
          label: "unavailable",
          reason: "No complete current- or prior-season defense sample is available.",
        };
      }
      const peers = baseRatings
        .filter(
          (candidate) =>
            candidate.position === rating.position && candidate.adjustedPointsPerGame !== null,
        )
        .map((candidate) => candidate.adjustedPointsPerGame as number);
      const percentile = strengthPercentile(rating.adjustedPointsPerGame, peers, true);
      const positionValidated =
        input.policy.labelsEnabled && input.policy.validatedPositions.includes(rating.position);
      const supportThresholdMet =
        rating.currentGames >= input.policy.minimumCurrentSeasonGamesForLabel ||
        (rating.currentGames === 0 && input.policy.allowPriorOnlyLabels);
      const labelEligible = positionValidated && supportThresholdMet;
      const minimum = input.policy.minimumPointDifferentialByPosition[rating.position];
      const label: ScheduleEdgeMatchupLabel = !labelEligible
        ? "unavailable"
        : percentile >= 67 && rating.pointDifferential >= minimum
          ? "favorable"
          : percentile <= 33 && rating.pointDifferential <= -minimum
            ? "difficult"
            : "neutral";
      return {
        ...rating,
        percentile,
        label,
        // `reason` describes missing or incomplete evidence, not the release policy. The
        // versioned validation state is published once at the response-algorithm boundary.
        reason:
          positionValidated && !supportThresholdMet
            ? "The versioned policy's current-season support threshold has not been met."
            : null,
      };
    })
    .sort(
      (left, right) =>
        compareStrings(left.position, right.position) ||
        compareStrings(left.defenseTeam, right.defenseTeam),
    );

  return {
    targetSeason: input.targetSeason,
    throughWeek: input.throughWeek,
    positions: input.totals.positions,
    scoringProfileKey: input.totals.scoringProfileKey,
    policyVersion: input.policy.version,
    ratings,
    definition: DEFENSE_RATING_DEFINITION,
  };
}

export type ScheduleStrengthWeekState = "matchup" | "bye" | "unknown" | "rating-unavailable";

export interface ScheduleStrengthWeek {
  readonly week: number;
  readonly state: ScheduleStrengthWeekState;
  readonly opponent: string | null;
  readonly percentile: number | null;
  readonly label: ScheduleEdgeMatchupLabel;
  readonly confidence: ScheduleEdgeConfidence;
  readonly reason: string | null;
}

export interface ScheduleStrengthEntry {
  readonly team: string;
  readonly position: ScheduleEdgePosition;
  readonly status: "available" | "unavailable";
  readonly averagePercentile: number | null;
  readonly rank: number | null;
  readonly tiedTeams: number;
  readonly favorableWeeks: number;
  readonly neutralWeeks: number;
  readonly difficultWeeks: number;
  readonly byeWeeks: number;
  readonly unknownWeeks: number;
  readonly availableWeeks: number;
  readonly expectedWeeks: number;
  readonly coverage: number;
  readonly weeks: readonly ScheduleStrengthWeek[];
  readonly reason: string | null;
}

export interface DeriveScheduleStrengthInput {
  readonly season: number;
  readonly startWeek: number;
  readonly endWeek: number;
  readonly schedule: TeamScheduleResult;
  readonly ratings: ScheduleEdgeDefenseRatingsResult;
  readonly positions?: readonly ScheduleEdgePosition[];
}

export interface ScheduleStrengthResult {
  readonly season: number;
  readonly startWeek: number;
  readonly endWeek: number;
  readonly positions: readonly ScheduleEdgePosition[];
  readonly entries: readonly ScheduleStrengthEntry[];
  readonly definition: string;
}

const SCHEDULE_STRENGTH_DEFINITION =
  "Schedule strength is the equal-weight mean of available opponent matchup percentiles in the selected window. Affirmed byes are counted but omitted, and unknown schedule or matchup inputs are never treated as neutral.";

export function deriveScheduleStrength(input: DeriveScheduleStrengthInput): ScheduleStrengthResult {
  validateSeason(input.season);
  validateWeekRange(input.startWeek, input.endWeek);
  if (input.schedule.season !== input.season || input.ratings.targetSeason !== input.season) {
    throw new Error("schedule-strength season does not match its schedule and ratings");
  }
  const positions = positionsOrDefault(input.positions);
  const ratingByKey = new Map(
    input.ratings.ratings.map((rating) => [
      `${rating.defenseTeam}\u0000${rating.position}`,
      rating,
    ]),
  );
  const base = input.schedule.teams.flatMap((team) =>
    positions.map((position) => {
      const weeks: ScheduleStrengthWeek[] = [];
      for (let week = input.startWeek; week <= input.endWeek; week += 1) {
        const scheduleWeek = team.weeks.find((candidate) => candidate.week === week);
        if (!scheduleWeek || scheduleWeek.state === "unknown") {
          weeks.push({
            week,
            state: "unknown",
            opponent: null,
            percentile: null,
            label: "unavailable",
            confidence: "unavailable",
            reason:
              scheduleWeek?.state === "unknown"
                ? scheduleWeek.reason
                : "This week is outside admitted schedule coverage.",
          });
          continue;
        }
        if (scheduleWeek.state === "bye") {
          weeks.push({
            week,
            state: "bye",
            opponent: null,
            percentile: null,
            label: "unavailable",
            confidence: "unavailable",
            reason: null,
          });
          continue;
        }
        const rating = ratingByKey.get(`${scheduleWeek.game.opponent}\u0000${position}`);
        if (!rating || rating.status === "unavailable" || rating.percentile === null) {
          weeks.push({
            week,
            state: "rating-unavailable",
            opponent: scheduleWeek.game.opponent,
            percentile: null,
            label: "unavailable",
            confidence: "unavailable",
            reason: rating?.reason ?? "No admitted opponent rating is available.",
          });
          continue;
        }
        weeks.push({
          week,
          state: "matchup",
          opponent: scheduleWeek.game.opponent,
          percentile: rating.percentile,
          label: rating.label,
          confidence: rating.confidence,
          reason: rating.reason,
        });
      }
      const percentiles = weeks.flatMap((week) =>
        week.percentile === null ? [] : [week.percentile],
      );
      const averagePercentile = mean(percentiles);
      const byeWeeks = weeks.filter((week) => week.state === "bye").length;
      const matchupWeeks = weeks.length - byeWeeks;
      return {
        team: team.team,
        position,
        status: averagePercentile === null ? ("unavailable" as const) : ("available" as const),
        averagePercentile,
        favorableWeeks: weeks.filter((week) => week.label === "favorable").length,
        neutralWeeks: weeks.filter((week) => week.label === "neutral").length,
        difficultWeeks: weeks.filter((week) => week.label === "difficult").length,
        byeWeeks,
        unknownWeeks: weeks.filter(
          (week) => week.state === "unknown" || week.state === "rating-unavailable",
        ).length,
        availableWeeks: percentiles.length,
        expectedWeeks: input.endWeek - input.startWeek + 1,
        coverage: matchupWeeks === 0 ? 1 : percentiles.length / matchupWeeks,
        weeks,
      };
    }),
  );

  const entries = base
    .map((entry): ScheduleStrengthEntry => {
      if (entry.averagePercentile === null) {
        return {
          ...entry,
          rank: null,
          tiedTeams: 0,
          reason: "No opponent matchup percentile is available in this window.",
        };
      }
      const peers = base.filter(
        (candidate) =>
          candidate.position === entry.position && candidate.averagePercentile !== null,
      );
      const stronger = peers.filter(
        (candidate) =>
          (candidate.averagePercentile as number) > entry.averagePercentile! + ANALYTICS_EPSILON,
      ).length;
      const tiedTeams = peers.filter(
        (candidate) =>
          Math.abs((candidate.averagePercentile as number) - entry.averagePercentile!) <=
          ANALYTICS_EPSILON,
      ).length;
      return {
        ...entry,
        rank: stronger + 1,
        tiedTeams,
        reason: null,
      };
    })
    .sort(
      (left, right) =>
        compareStrings(left.position, right.position) ||
        (left.rank ?? Number.MAX_SAFE_INTEGER) - (right.rank ?? Number.MAX_SAFE_INTEGER) ||
        compareStrings(left.team, right.team),
    );

  return {
    season: input.season,
    startWeek: input.startWeek,
    endWeek: input.endWeek,
    positions,
    entries,
    definition: SCHEDULE_STRENGTH_DEFINITION,
  };
}
