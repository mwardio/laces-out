import { assertFinite, assertNonNegative, mean, safeRate } from "./shared.js";

export type MetricAvailability = "available" | "unavailable";

export type DerivedNumericMetric =
  | {
      readonly status: "available";
      readonly value: number;
      readonly sampleSize: number;
      readonly definition: string;
    }
  | {
      readonly status: "unavailable";
      readonly value: null;
      readonly sampleSize: number;
      readonly reason: string;
      readonly definition: string;
    };

export interface WeeklyPlayerStatObservation {
  readonly playerId: string;
  readonly season: number;
  readonly week: number;
  readonly gameId: string;
  readonly team: string;
  readonly opponentTeam: string;
  readonly position: string;
  readonly targets: number;
  readonly carries: number;
  /** League-scored points, calculated by the caller from raw stat components. */
  readonly fantasyPoints?: number | null;
}

export interface WeeklyPlayerSnapObservation {
  readonly playerId: string;
  readonly season: number;
  readonly week: number;
  readonly gameId: string;
  readonly team: string;
  readonly opponentTeam: string;
  readonly offenseSnaps: number;
  /** Upstream offensive snap share on a zero-to-one scale. */
  readonly offenseSnapShare: number;
}

export interface BoomBustThreshold {
  /** A game at or above this league-scored point total is a boom. */
  readonly boomAtOrAbove: number;
  /** A game at or below this league-scored point total is a bust. */
  readonly bustAtOrBelow: number;
}

export interface DerivePlayerOpportunityMetricsInput {
  readonly season: number;
  readonly weeklyStats: readonly WeeklyPlayerStatObservation[];
  readonly snapCounts?: readonly WeeklyPlayerSnapObservation[];
  /** Include IDs with no observations so callers receive explicit no-data results. */
  readonly playerIds?: readonly string[];
  /**
   * Target share needs every player row for each included team/game. Set this
   * only after the caller has verified complete team-game coverage.
   */
  readonly teamTargetTotalsComplete: boolean;
  readonly throughWeek?: number;
  readonly recentWindow?: number;
  /** Newest week has weight 1; each preceding week is multiplied by this. */
  readonly recentWeightDecay?: number;
  readonly boomBustThresholdsByPosition?: Readonly<Record<string, BoomBustThreshold>>;
}

export interface OpportunityTrendMetric {
  readonly status: MetricAvailability;
  readonly seasonAverage: number | null;
  readonly recentWeightedAverage: number | null;
  readonly absoluteChange: number | null;
  readonly sampleSize: number;
  readonly recentSampleSize: number;
  readonly recentWindow: number;
  readonly decay: number;
  readonly reason: string | null;
  readonly definition: string;
}

export interface WeeklyPlayerOpportunity {
  readonly season: number;
  readonly week: number;
  readonly gameId: string;
  readonly team: string;
  readonly opponentTeam: string;
  readonly position: string | null;
  readonly targets: number | null;
  readonly teamTargets: number | null;
  readonly targetShare: number | null;
  readonly carries: number | null;
  readonly opportunities: number | null;
  readonly offenseSnaps: number | null;
  readonly offenseSnapShare: number | null;
  readonly fantasyPoints: number | null;
}

export type BoomBustSummary =
  | {
      readonly status: "available";
      readonly games: number;
      readonly missingGames: number;
      readonly booms: number;
      readonly busts: number;
      readonly neutral: number;
      readonly boomRate: number;
      readonly bustRate: number;
      readonly averagePoints: number;
      readonly populationStandardDeviation: number;
      readonly thresholdPositions: readonly string[];
      readonly definition: string;
    }
  | {
      readonly status: "unavailable";
      readonly games: number;
      readonly missingGames: number;
      readonly reason: string;
      readonly definition: string;
    };

export interface PlayerOpportunityMetrics {
  readonly playerId: string;
  readonly season: number;
  readonly statGames: number;
  readonly snapGames: number;
  readonly weekly: readonly WeeklyPlayerOpportunity[];
  readonly totals: {
    readonly targets: DerivedNumericMetric;
    readonly carries: DerivedNumericMetric;
    readonly opportunities: DerivedNumericMetric;
    readonly offenseSnaps: DerivedNumericMetric;
  };
  readonly rates: {
    readonly targetsPerGame: DerivedNumericMetric;
    readonly targetShare: DerivedNumericMetric;
    readonly carriesPerGame: DerivedNumericMetric;
    readonly opportunitiesPerGame: DerivedNumericMetric;
    readonly offenseSnapShare: DerivedNumericMetric;
  };
  readonly recentTrend: {
    readonly targetsPerGame: OpportunityTrendMetric;
    readonly targetShare: OpportunityTrendMetric;
    readonly carriesPerGame: OpportunityTrendMetric;
    readonly opportunitiesPerGame: OpportunityTrendMetric;
    readonly offenseSnapShare: OpportunityTrendMetric;
    readonly fantasyPoints: OpportunityTrendMetric;
  };
  readonly boomBust: BoomBustSummary;
  readonly redZone: {
    readonly status: "unavailable";
    readonly reason: string;
  };
}

export interface PlayerOpportunityMetricsResult {
  readonly season: number;
  readonly throughWeek: number | null;
  readonly recentWindow: number;
  readonly recentWeightDecay: number;
  readonly players: readonly PlayerOpportunityMetrics[];
  readonly definitions: {
    readonly opportunities: string;
    readonly targetShare: string;
    readonly snapShare: string;
    readonly recentTrend: string;
    readonly boomBust: string;
    readonly redZone: string;
  };
}

const OPPORTUNITY_DEFINITION = "Opportunities equal carries plus targets from weekly stat rows.";
const TARGET_SHARE_DEFINITION =
  "Target share is player targets divided by all player targets for the same team and games. It is withheld unless complete team-game target coverage is affirmed.";
const SNAP_SHARE_DEFINITION =
  "Season offensive snap share is the unweighted mean of supplied game-level offensive snap shares; total offensive snaps are reported separately.";
const RECENT_TREND_DEFINITION =
  "Recent trend compares the full-sample per-game mean with an exponentially weighted mean of the most recent distinct weeks; the newest week has weight 1.";
const BOOM_BUST_DEFINITION =
  "Boom and bust rates use caller-supplied, position-specific league-scored point thresholds. Missing point rows are disclosed and excluded.";
const RED_ZONE_UNAVAILABLE_REASON =
  "Red-zone opportunities are unavailable because weekly stat and snap observations do not contain red-zone attempts or targets.";

function unavailableMetric(
  reason: string,
  definition: string,
  sampleSize = 0,
): DerivedNumericMetric {
  return { status: "unavailable", value: null, sampleSize, reason, definition };
}

function availableMetric(
  value: number,
  sampleSize: number,
  definition: string,
): DerivedNumericMetric {
  return { status: "available", value, sampleSize, definition };
}

function normalizeIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} cannot be empty`);
  return normalized;
}

function validateSeasonAndWeek(season: number, week: number): void {
  if (!Number.isInteger(season) || season < 1999 || season > 2200) {
    throw new RangeError("season must be an integer between 1999 and 2200");
  }
  if (!Number.isInteger(week) || week < 1 || week > 25) {
    throw new RangeError("week must be an integer between 1 and 25");
  }
}

function statKey(row: WeeklyPlayerStatObservation): string {
  return `${row.season}\u0000${row.gameId}\u0000${row.playerId}`;
}

function snapKey(row: WeeklyPlayerSnapObservation): string {
  return `${row.season}\u0000${row.gameId}\u0000${row.playerId}`;
}

function teamGameKey(row: Pick<WeeklyPlayerStatObservation, "season" | "gameId" | "team">): string {
  return `${row.season}\u0000${row.gameId}\u0000${row.team}`;
}

function validateOpportunityInput(input: DerivePlayerOpportunityMetricsInput): {
  readonly throughWeek: number | null;
  readonly recentWindow: number;
  readonly decay: number;
} {
  validateSeasonAndWeek(input.season, input.throughWeek ?? 1);
  const throughWeek = input.throughWeek ?? null;
  const recentWindow = input.recentWindow ?? 4;
  if (!Number.isInteger(recentWindow) || recentWindow <= 0 || recentWindow > 25) {
    throw new RangeError("recentWindow must be an integer between 1 and 25");
  }
  const decay = input.recentWeightDecay ?? 0.75;
  assertFinite(decay, "recentWeightDecay");
  if (decay <= 0 || decay > 1) {
    throw new RangeError("recentWeightDecay must be greater than zero and at most one");
  }

  const statKeys = new Set<string>();
  for (const row of input.weeklyStats) {
    validateSeasonAndWeek(row.season, row.week);
    if (row.season !== input.season)
      throw new Error("weekly stat season does not match input season");
    normalizeIdentifier(row.playerId, "playerId");
    normalizeIdentifier(row.gameId, "gameId");
    normalizeIdentifier(row.team, "team");
    normalizeIdentifier(row.opponentTeam, "opponentTeam");
    normalizeIdentifier(row.position, "position");
    if (!Number.isInteger(row.targets)) throw new TypeError("targets must be an integer");
    if (!Number.isInteger(row.carries)) throw new TypeError("carries must be an integer");
    assertNonNegative(row.targets, "targets");
    assertNonNegative(row.carries, "carries");
    if (row.fantasyPoints !== undefined && row.fantasyPoints !== null) {
      assertFinite(row.fantasyPoints, "fantasyPoints");
    }
    const key = statKey(row);
    if (statKeys.has(key))
      throw new Error(`Duplicate weekly stat row for ${row.playerId}/${row.gameId}`);
    statKeys.add(key);
  }

  const snapKeys = new Set<string>();
  for (const row of input.snapCounts ?? []) {
    validateSeasonAndWeek(row.season, row.week);
    if (row.season !== input.season)
      throw new Error("snap-count season does not match input season");
    normalizeIdentifier(row.playerId, "playerId");
    normalizeIdentifier(row.gameId, "gameId");
    normalizeIdentifier(row.team, "team");
    normalizeIdentifier(row.opponentTeam, "opponentTeam");
    if (!Number.isInteger(row.offenseSnaps)) throw new TypeError("offenseSnaps must be an integer");
    assertNonNegative(row.offenseSnaps, "offenseSnaps");
    assertFinite(row.offenseSnapShare, "offenseSnapShare");
    if (row.offenseSnapShare < 0 || row.offenseSnapShare > 1) {
      throw new RangeError("offenseSnapShare must be between zero and one");
    }
    const key = snapKey(row);
    if (snapKeys.has(key))
      throw new Error(`Duplicate snap-count row for ${row.playerId}/${row.gameId}`);
    snapKeys.add(key);
  }

  const requested = input.playerIds ?? [];
  if (
    new Set(requested.map((id) => normalizeIdentifier(id, "playerId"))).size !== requested.length
  ) {
    throw new Error("playerIds must be unique");
  }
  for (const [position, threshold] of Object.entries(input.boomBustThresholdsByPosition ?? {})) {
    normalizeIdentifier(position, "boom/bust threshold position");
    assertFinite(threshold.boomAtOrAbove, `boom threshold for ${position}`);
    assertFinite(threshold.bustAtOrBelow, `bust threshold for ${position}`);
    if (threshold.bustAtOrBelow >= threshold.boomAtOrAbove) {
      throw new RangeError(`bust threshold for ${position} must be below its boom threshold`);
    }
  }
  return { throughWeek, recentWindow, decay };
}

function compareWeekly(
  left: Pick<WeeklyPlayerOpportunity, "week" | "gameId">,
  right: Pick<WeeklyPlayerOpportunity, "week" | "gameId">,
): number {
  return left.week - right.week || left.gameId.localeCompare(right.gameId);
}

function trendMetric(
  weekly: readonly WeeklyPlayerOpportunity[],
  value: (row: WeeklyPlayerOpportunity) => number | null,
  recentWindow: number,
  decay: number,
  unavailableReason = "No eligible observations are available.",
): OpportunityTrendMetric {
  const byWeek = new Map<number, number[]>();
  for (const row of weekly) {
    const candidate = value(row);
    if (candidate === null) continue;
    const values = byWeek.get(row.week) ?? [];
    values.push(candidate);
    byWeek.set(row.week, values);
  }
  const weeklyMeans = [...byWeek]
    .map(([week, values]) => ({ week, value: mean(values) ?? 0 }))
    .sort((left, right) => right.week - left.week);
  if (weeklyMeans.length === 0) {
    return {
      status: "unavailable",
      seasonAverage: null,
      recentWeightedAverage: null,
      absoluteChange: null,
      sampleSize: 0,
      recentSampleSize: 0,
      recentWindow,
      decay,
      reason: unavailableReason,
      definition: RECENT_TREND_DEFINITION,
    };
  }
  const seasonAverage = mean(weeklyMeans.map((item) => item.value)) ?? 0;
  const recent = weeklyMeans.slice(0, recentWindow);
  let weightedSum = 0;
  let weightTotal = 0;
  recent.forEach((item, index) => {
    const weight = decay ** index;
    weightedSum += item.value * weight;
    weightTotal += weight;
  });
  const recentWeightedAverage = weightedSum / weightTotal;
  return {
    status: "available",
    seasonAverage,
    recentWeightedAverage,
    absoluteChange: recentWeightedAverage - seasonAverage,
    sampleSize: weeklyMeans.length,
    recentSampleSize: recent.length,
    recentWindow,
    decay,
    reason: null,
    definition: RECENT_TREND_DEFINITION,
  };
}

function populationStandardDeviation(values: readonly number[]): number {
  const average = mean(values) ?? 0;
  return Math.sqrt(
    values.reduce((total, value) => total + (value - average) ** 2, 0) / values.length,
  );
}

function deriveBoomBust(
  statRows: readonly WeeklyPlayerStatObservation[],
  thresholds: Readonly<Record<string, BoomBustThreshold>> | undefined,
): BoomBustSummary {
  if (statRows.length === 0) {
    return {
      status: "unavailable",
      games: 0,
      missingGames: 0,
      reason: "No weekly stat observations are available.",
      definition: BOOM_BUST_DEFINITION,
    };
  }
  if (!thresholds) {
    return {
      status: "unavailable",
      games: 0,
      missingGames: statRows.length,
      reason: "No position-specific boom/bust thresholds were supplied.",
      definition: BOOM_BUST_DEFINITION,
    };
  }

  const eligible = statRows.flatMap((row) => {
    const threshold = thresholds[row.position];
    return row.fantasyPoints === undefined || row.fantasyPoints === null || !threshold
      ? []
      : [{ points: row.fantasyPoints, threshold, position: row.position }];
  });
  if (eligible.length === 0) {
    return {
      status: "unavailable",
      games: 0,
      missingGames: statRows.length,
      reason:
        "No rows contain both league-scored fantasy points and a matching position threshold.",
      definition: BOOM_BUST_DEFINITION,
    };
  }
  const booms = eligible.filter((row) => row.points >= row.threshold.boomAtOrAbove).length;
  const busts = eligible.filter((row) => row.points <= row.threshold.bustAtOrBelow).length;
  const points = eligible.map((row) => row.points);
  return {
    status: "available",
    games: eligible.length,
    missingGames: statRows.length - eligible.length,
    booms,
    busts,
    neutral: eligible.length - booms - busts,
    boomRate: booms / eligible.length,
    bustRate: busts / eligible.length,
    averagePoints: mean(points) ?? 0,
    populationStandardDeviation: populationStandardDeviation(points),
    thresholdPositions: [...new Set(eligible.map((row) => row.position))].sort((a, b) =>
      a.localeCompare(b),
    ),
    definition: BOOM_BUST_DEFINITION,
  };
}

export function derivePlayerOpportunityMetrics(
  input: DerivePlayerOpportunityMetricsInput,
): PlayerOpportunityMetricsResult {
  const { throughWeek, recentWindow, decay } = validateOpportunityInput(input);
  const includedStats = input.weeklyStats.filter(
    (row) => throughWeek === null || row.week <= throughWeek,
  );
  const includedSnaps = (input.snapCounts ?? []).filter(
    (row) => throughWeek === null || row.week <= throughWeek,
  );
  const playerIds = [
    ...new Set([
      ...(input.playerIds ?? []),
      ...includedStats.map((row) => row.playerId),
      ...includedSnaps.map((row) => row.playerId),
    ]),
  ].sort((left, right) => left.localeCompare(right));

  const teamTargets = new Map<string, number>();
  for (const row of includedStats) {
    const key = teamGameKey(row);
    teamTargets.set(key, (teamTargets.get(key) ?? 0) + row.targets);
  }

  const players = playerIds.map((playerId): PlayerOpportunityMetrics => {
    const statRows = includedStats
      .filter((row) => row.playerId === playerId)
      .sort((left, right) => left.week - right.week || left.gameId.localeCompare(right.gameId));
    const snapRows = includedSnaps
      .filter((row) => row.playerId === playerId)
      .sort((left, right) => left.week - right.week || left.gameId.localeCompare(right.gameId));
    const statByGame = new Map(statRows.map((row) => [row.gameId, row]));
    const snapByGame = new Map(snapRows.map((row) => [row.gameId, row]));
    const gameIds = [...new Set([...statByGame.keys(), ...snapByGame.keys()])].sort(
      (left, right) => {
        const leftRow = statByGame.get(left) ?? snapByGame.get(left);
        const rightRow = statByGame.get(right) ?? snapByGame.get(right);
        if (!leftRow || !rightRow) return left.localeCompare(right);
        return leftRow.week - rightRow.week || left.localeCompare(right);
      },
    );
    const weekly = gameIds
      .map((gameId): WeeklyPlayerOpportunity => {
        const stat = statByGame.get(gameId);
        const snap = snapByGame.get(gameId);
        const context = stat ?? snap;
        if (!context) throw new Error("Internal opportunity context error");
        const denominator =
          stat && input.teamTargetTotalsComplete ? teamTargets.get(teamGameKey(stat)) : null;
        return {
          season: input.season,
          week: context.week,
          gameId,
          team: context.team,
          opponentTeam: context.opponentTeam,
          position: stat?.position ?? null,
          targets: stat?.targets ?? null,
          teamTargets: denominator ?? null,
          targetShare:
            stat && denominator !== undefined && denominator !== null
              ? safeRate(stat.targets, denominator)
              : null,
          carries: stat?.carries ?? null,
          opportunities: stat ? stat.targets + stat.carries : null,
          offenseSnaps: snap?.offenseSnaps ?? null,
          offenseSnapShare: snap?.offenseSnapShare ?? null,
          fantasyPoints: stat?.fantasyPoints ?? null,
        };
      })
      .sort(compareWeekly);

    const targets = statRows.reduce((total, row) => total + row.targets, 0);
    const carries = statRows.reduce((total, row) => total + row.carries, 0);
    const offenseSnaps = snapRows.reduce((total, row) => total + row.offenseSnaps, 0);
    const teamTargetDenominator = statRows.reduce(
      (total, row) => total + (teamTargets.get(teamGameKey(row)) ?? 0),
      0,
    );
    const targetShare =
      input.teamTargetTotalsComplete && teamTargetDenominator > 0
        ? availableMetric(targets / teamTargetDenominator, statRows.length, TARGET_SHARE_DEFINITION)
        : unavailableMetric(
            input.teamTargetTotalsComplete
              ? "Team targets total zero, so target share has a zero denominator."
              : "Complete team-game target totals were not affirmed.",
            TARGET_SHARE_DEFINITION,
            statRows.length,
          );
    const averageSnapShare = mean(snapRows.map((row) => row.offenseSnapShare));
    const noStatReason = "No weekly stat observations are available for this player.";
    const noSnapReason = "No offensive snap observations are available for this player.";

    return {
      playerId,
      season: input.season,
      statGames: statRows.length,
      snapGames: snapRows.length,
      weekly,
      totals: {
        targets:
          statRows.length > 0
            ? availableMetric(targets, statRows.length, "Sum of weekly targets.")
            : unavailableMetric(noStatReason, "Sum of weekly targets."),
        carries:
          statRows.length > 0
            ? availableMetric(carries, statRows.length, "Sum of weekly carries.")
            : unavailableMetric(noStatReason, "Sum of weekly carries."),
        opportunities:
          statRows.length > 0
            ? availableMetric(targets + carries, statRows.length, OPPORTUNITY_DEFINITION)
            : unavailableMetric(noStatReason, OPPORTUNITY_DEFINITION),
        offenseSnaps:
          snapRows.length > 0
            ? availableMetric(offenseSnaps, snapRows.length, "Sum of supplied offensive snaps.")
            : unavailableMetric(noSnapReason, "Sum of supplied offensive snaps."),
      },
      rates: {
        targetsPerGame:
          statRows.length > 0
            ? availableMetric(targets / statRows.length, statRows.length, "Targets per stat game.")
            : unavailableMetric(noStatReason, "Targets per stat game."),
        targetShare,
        carriesPerGame:
          statRows.length > 0
            ? availableMetric(carries / statRows.length, statRows.length, "Carries per stat game.")
            : unavailableMetric(noStatReason, "Carries per stat game."),
        opportunitiesPerGame:
          statRows.length > 0
            ? availableMetric(
                (targets + carries) / statRows.length,
                statRows.length,
                "Opportunities per stat game; opportunities equal carries plus targets.",
              )
            : unavailableMetric(noStatReason, OPPORTUNITY_DEFINITION),
        offenseSnapShare:
          averageSnapShare === null
            ? unavailableMetric(noSnapReason, SNAP_SHARE_DEFINITION)
            : availableMetric(averageSnapShare, snapRows.length, SNAP_SHARE_DEFINITION),
      },
      recentTrend: {
        targetsPerGame: trendMetric(weekly, (row) => row.targets, recentWindow, decay),
        targetShare: trendMetric(
          weekly,
          (row) => row.targetShare,
          recentWindow,
          decay,
          input.teamTargetTotalsComplete
            ? "No game has a nonzero team-target denominator."
            : "Complete team-game target totals were not affirmed.",
        ),
        carriesPerGame: trendMetric(weekly, (row) => row.carries, recentWindow, decay),
        opportunitiesPerGame: trendMetric(weekly, (row) => row.opportunities, recentWindow, decay),
        offenseSnapShare: trendMetric(
          weekly,
          (row) => row.offenseSnapShare,
          recentWindow,
          decay,
          noSnapReason,
        ),
        fantasyPoints: trendMetric(
          weekly,
          (row) => row.fantasyPoints,
          recentWindow,
          decay,
          "No league-scored fantasy points were supplied.",
        ),
      },
      boomBust: deriveBoomBust(statRows, input.boomBustThresholdsByPosition),
      redZone: { status: "unavailable", reason: RED_ZONE_UNAVAILABLE_REASON },
    };
  });

  return {
    season: input.season,
    throughWeek,
    recentWindow,
    recentWeightDecay: decay,
    players,
    definitions: {
      opportunities: OPPORTUNITY_DEFINITION,
      targetShare: TARGET_SHARE_DEFINITION,
      snapShare: SNAP_SHARE_DEFINITION,
      recentTrend: RECENT_TREND_DEFINITION,
      boomBust: BOOM_BUST_DEFINITION,
      redZone: RED_ZONE_UNAVAILABLE_REASON,
    },
  };
}

export interface PositionFantasyPointsAllowedInput {
  readonly season: number;
  readonly weeklyStats: readonly WeeklyPlayerStatObservation[];
  /** Explicit positions avoid silently omitting positions with zero observed points. */
  readonly positions?: readonly string[];
  /**
   * FPA is a team/game aggregate and is unsafe on a roster subset. The caller
   * must affirm complete player coverage for all included games.
   */
  readonly datasetCompleteness: "complete" | "partial";
  readonly throughWeek?: number;
  /** Pseudo-games assigned to the prior; defaults to four. */
  readonly shrinkageGames?: number;
  /** Prior-season or other pre-period positional baselines, when available. */
  readonly priorPositionAverages?: Readonly<Record<string, number>>;
}

export interface PositionFantasyPointsAllowedEntry {
  readonly opponentTeam: string;
  readonly position: string;
  readonly status: MetricAvailability;
  readonly games: number;
  readonly incompleteGames: number;
  readonly rawPointsPerGame: number | null;
  readonly shrunkPointsPerGame: number | null;
  readonly baselinePointsPerGame: number | null;
  readonly baselineSource: "provided-prior" | "current-sample-league-average" | "unavailable";
  readonly observedWeight: number;
  readonly shrinkageWeight: number;
  readonly reason: string | null;
  readonly definition: string;
}

export interface PositionFantasyPointsAllowedResult {
  readonly status: MetricAvailability;
  readonly season: number;
  readonly throughWeek: number | null;
  readonly shrinkageGames: number;
  readonly positions: readonly string[];
  readonly opponentTeams: readonly string[];
  readonly entries: readonly PositionFantasyPointsAllowedEntry[];
  readonly reason: string | null;
  readonly definition: string;
}

const FPA_DEFINITION =
  "Fantasy points allowed is league-scored player points summed by defensive opponent and position, then averaged per complete game. The displayed estimate is shrunk toward a supplied pre-period positional prior, or otherwise the current-sample league positional average, using the disclosed pseudo-game weight.";

function validateFpaInput(input: PositionFantasyPointsAllowedInput): {
  readonly positions: readonly string[];
  readonly throughWeek: number | null;
  readonly shrinkageGames: number;
} {
  validateSeasonAndWeek(input.season, input.throughWeek ?? 1);
  const throughWeek = input.throughWeek ?? null;
  const shrinkageGames = input.shrinkageGames ?? 4;
  assertNonNegative(shrinkageGames, "shrinkageGames");
  const inferredPositions = input.weeklyStats.map((row) => row.position);
  const positions = [...new Set(input.positions ?? inferredPositions)]
    .map((position) => normalizeIdentifier(position, "position"))
    .sort((left, right) => left.localeCompare(right));
  if (input.positions && positions.length !== input.positions.length) {
    throw new Error("positions must be unique");
  }
  const keys = new Set<string>();
  for (const row of input.weeklyStats) {
    validateSeasonAndWeek(row.season, row.week);
    if (row.season !== input.season)
      throw new Error("weekly stat season does not match input season");
    normalizeIdentifier(row.playerId, "playerId");
    normalizeIdentifier(row.gameId, "gameId");
    normalizeIdentifier(row.team, "team");
    normalizeIdentifier(row.opponentTeam, "opponentTeam");
    normalizeIdentifier(row.position, "position");
    if (!Number.isInteger(row.targets)) throw new TypeError("targets must be an integer");
    if (!Number.isInteger(row.carries)) throw new TypeError("carries must be an integer");
    assertNonNegative(row.targets, "targets");
    assertNonNegative(row.carries, "carries");
    if (row.fantasyPoints !== undefined && row.fantasyPoints !== null) {
      assertFinite(row.fantasyPoints, "fantasyPoints");
    }
    const key = statKey(row);
    if (keys.has(key))
      throw new Error(`Duplicate weekly stat row for ${row.playerId}/${row.gameId}`);
    keys.add(key);
  }
  for (const [position, prior] of Object.entries(input.priorPositionAverages ?? {})) {
    normalizeIdentifier(position, "prior position");
    assertFinite(prior, `prior average for ${position}`);
  }
  return { positions, throughWeek, shrinkageGames };
}

export function calculatePositionFantasyPointsAllowed(
  input: PositionFantasyPointsAllowedInput,
): PositionFantasyPointsAllowedResult {
  const { positions, throughWeek, shrinkageGames } = validateFpaInput(input);
  const rows = input.weeklyStats
    .filter((row) => throughWeek === null || row.week <= throughWeek)
    .sort(
      (left, right) =>
        left.week - right.week ||
        left.gameId.localeCompare(right.gameId) ||
        left.team.localeCompare(right.team) ||
        left.playerId.localeCompare(right.playerId),
    );
  const opponentTeams = [...new Set(rows.map((row) => row.opponentTeam))].sort((left, right) =>
    left.localeCompare(right),
  );
  if (rows.length === 0) {
    return {
      status: "unavailable",
      season: input.season,
      throughWeek,
      shrinkageGames,
      positions,
      opponentTeams,
      entries: [],
      reason: "No weekly stat observations are available.",
      definition: FPA_DEFINITION,
    };
  }
  if (input.datasetCompleteness === "partial") {
    return {
      status: "unavailable",
      season: input.season,
      throughWeek,
      shrinkageGames,
      positions,
      opponentTeams,
      entries: [],
      reason:
        "Complete game-player coverage was not affirmed; partial rows would understate fantasy points allowed.",
      definition: FPA_DEFINITION,
    };
  }

  const defenseGames = new Map<string, { opponentTeam: string; gameId: string }>();
  for (const row of rows) {
    defenseGames.set(`${row.opponentTeam}\u0000${row.gameId}`, {
      opponentTeam: row.opponentTeam,
      gameId: row.gameId,
    });
  }
  const gameScores = new Map<
    string,
    { opponentTeam: string; position: string; points: number; complete: boolean }
  >();
  for (const game of defenseGames.values()) {
    for (const position of positions) {
      const relevant = rows.filter(
        (row) =>
          row.opponentTeam === game.opponentTeam &&
          row.gameId === game.gameId &&
          row.position === position,
      );
      const complete = relevant.every(
        (row) => row.fantasyPoints !== undefined && row.fantasyPoints !== null,
      );
      const points = complete
        ? relevant.reduce((total, row) => total + (row.fantasyPoints ?? 0), 0)
        : 0;
      gameScores.set(`${game.opponentTeam}\u0000${game.gameId}\u0000${position}`, {
        opponentTeam: game.opponentTeam,
        position,
        points,
        complete,
      });
    }
  }

  const leagueAverageByPosition = new Map<string, number | null>();
  for (const position of positions) {
    const completeScores = [...gameScores.values()]
      .filter((score) => score.position === position && score.complete)
      .map((score) => score.points);
    leagueAverageByPosition.set(position, mean(completeScores));
  }

  const entries = opponentTeams.flatMap((opponentTeam) =>
    positions.map((position): PositionFantasyPointsAllowedEntry => {
      const scores = [...gameScores.values()].filter(
        (score) => score.opponentTeam === opponentTeam && score.position === position,
      );
      const completeScores = scores.filter((score) => score.complete).map((score) => score.points);
      const incompleteGames = scores.length - completeScores.length;
      const raw = mean(completeScores);
      const suppliedPrior = input.priorPositionAverages?.[position];
      const leagueAverage = leagueAverageByPosition.get(position) ?? null;
      const baseline = suppliedPrior ?? leagueAverage;
      const baselineSource =
        suppliedPrior !== undefined
          ? "provided-prior"
          : leagueAverage !== null
            ? "current-sample-league-average"
            : "unavailable";
      if (raw === null || baseline === null) {
        return {
          opponentTeam,
          position,
          status: "unavailable",
          games: completeScores.length,
          incompleteGames,
          rawPointsPerGame: raw,
          shrunkPointsPerGame: null,
          baselinePointsPerGame: baseline,
          baselineSource,
          observedWeight: 0,
          shrinkageWeight: 0,
          reason: "No complete game score and baseline are available for this position.",
          definition: FPA_DEFINITION,
        };
      }
      const totalWeight = completeScores.length + shrinkageGames;
      const observedWeight = totalWeight === 0 ? 1 : completeScores.length / totalWeight;
      const shrinkageWeight = totalWeight === 0 ? 0 : shrinkageGames / totalWeight;
      return {
        opponentTeam,
        position,
        status: "available",
        games: completeScores.length,
        incompleteGames,
        rawPointsPerGame: raw,
        shrunkPointsPerGame: raw * observedWeight + baseline * shrinkageWeight,
        baselinePointsPerGame: baseline,
        baselineSource,
        observedWeight,
        shrinkageWeight,
        reason: null,
        definition: FPA_DEFINITION,
      };
    }),
  );

  return {
    status: entries.some((entry) => entry.status === "available") ? "available" : "unavailable",
    season: input.season,
    throughWeek,
    shrinkageGames,
    positions,
    opponentTeams,
    entries,
    reason: entries.some((entry) => entry.status === "available")
      ? null
      : "No position/opponent combination has a complete game score and baseline.",
    definition: FPA_DEFINITION,
  };
}
