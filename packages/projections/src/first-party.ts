import {
  projectionScoringProfileKey,
  scoreProjectionStatComponents,
  type ProjectionScoringProfile,
  type ProjectionStatComponents,
} from "./scoring.js";

export const FIRST_PARTY_PROJECTION_MODEL_VERSION = "laces-weekly-components-v8";

export type FirstPartyProjectionPosition = "QB" | "RB" | "WR" | "TE" | "K";

export type FirstPartyPlayerStatus =
  | "active"
  | "questionable"
  | "doubtful"
  | "out"
  | "inactive"
  | "suspended"
  | "pup"
  | "ir"
  | "unknown";

export interface FirstPartyRoleContext {
  /** Expected share of the team's offensive snaps, from zero to one. */
  readonly snapShare?: number;
  /** Expected share of the team's targets, from zero to one. */
  readonly targetShare?: number;
  /** Expected share of the team's carries, from zero to one. */
  readonly carryShare?: number;
  /** Expected share of the team's pass attempts, from zero to one. */
  readonly passAttemptShare?: number;
}

export interface FirstPartyTeamContext {
  /** Multipliers are deliberately bounded by the model before they are applied. */
  readonly playVolumeMultiplier?: number;
  readonly passVolumeMultiplier?: number;
  readonly rushVolumeMultiplier?: number;
  readonly scoringMultiplier?: number;
}

export interface FirstPartyWeeklyStatLine {
  readonly playerId: string;
  readonly position: string;
  readonly season: number;
  readonly week: number;
  readonly team: string;
  readonly opponent?: string;
  readonly components: ProjectionStatComponents;
  readonly snapShare?: number;
  readonly targetShare?: number;
  readonly carryShare?: number;
  readonly passAttemptShare?: number;
  /** Set false for a known DNP. Unknown/missing is treated as a played game. */
  readonly played?: boolean;
  readonly status?: FirstPartyPlayerStatus;
}

export interface FirstPartyProjectionTarget {
  readonly playerId: string;
  readonly position: string;
  readonly season: number;
  readonly week: number;
  readonly team: string;
  readonly opponent?: string;
  /** False means the schedule explicitly has no game for the player. */
  readonly scheduled?: boolean;
  readonly isBye?: boolean;
  readonly status?: FirstPartyPlayerStatus;
  readonly role?: FirstPartyRoleContext;
  readonly teamContext?: FirstPartyTeamContext;
}

export interface FirstPartyProjectionConfig {
  readonly recencyHalfLifeWeeks: number;
  readonly playerPriorGames: number;
  readonly opponentPriorGames: number;
  readonly teamPriorGames: number;
  readonly maxPlayerGames: number;
  readonly minimumCalibrationSamples: number;
  readonly lowerIntervalQuantile: number;
  readonly upperIntervalQuantile: number;
  /** Recent completed week batches scored by the locked backtest; earlier rows remain training. */
  readonly backtestEvaluationWeeks: number;
}

export interface FirstPartyCalibrationInterval {
  readonly samples: number;
  readonly lowerError: number;
  readonly upperError: number;
  readonly mae: number;
  readonly rmse: number;
  readonly fallback: boolean;
}

export interface FirstPartyProjectionCalibration {
  readonly modelVersion: string;
  readonly generatedThrough?: { readonly season: number; readonly week: number };
  readonly intervals: Readonly<
    Partial<
      Record<FirstPartyProjectionPosition, Readonly<Record<string, FirstPartyCalibrationInterval>>>
    >
  >;
}

export interface FirstPartyProjectionCoverage {
  readonly playerGames: number;
  readonly recentPlayerGames: number;
  readonly positionGames: number;
  readonly opponentGames: number;
  readonly teamGames: number;
  readonly calibratedComponents: number;
  readonly fallbackComponents: number;
}

export type FirstPartyProjectionQualityGrade = "high" | "medium" | "low" | "unavailable";

export interface FirstPartyProjectionQuality {
  readonly grade: FirstPartyProjectionQualityGrade;
  readonly confidence: number;
  readonly degraded: boolean;
  readonly flags: readonly string[];
}

export interface FirstPartyProjectionProvenance {
  readonly modelVersion: string;
  readonly independenceKey: "laces-out-first-party";
  readonly strategy: FirstPartyProjectionStrategy;
  readonly target: { readonly season: number; readonly week: number };
  readonly trainingCutoff: { readonly season: number; readonly week: number };
  readonly latestInput?: { readonly season: number; readonly week: number };
  readonly inputFingerprint: string;
}

export interface FirstPartyWeeklyProjection {
  readonly state: "projected" | "zero" | "unavailable";
  readonly playerId: string;
  readonly position: string;
  readonly components: ProjectionStatComponents;
  readonly floorComponents: ProjectionStatComponents;
  readonly ceilingComponents: ProjectionStatComponents;
  readonly coverage: FirstPartyProjectionCoverage;
  readonly quality: FirstPartyProjectionQuality;
  readonly reasons: readonly string[];
  readonly provenance: FirstPartyProjectionProvenance;
}

export interface FirstPartyProjectionInput {
  readonly target: FirstPartyProjectionTarget;
  readonly history: readonly FirstPartyWeeklyStatLine[];
  readonly calibration?: FirstPartyProjectionCalibration;
  readonly config?: Partial<FirstPartyProjectionConfig>;
}

export interface FirstPartyBacktestPrediction {
  readonly playerId: string;
  readonly position: FirstPartyProjectionPosition;
  readonly season: number;
  readonly week: number;
  readonly predicted: ProjectionStatComponents;
  /** Transparent recency-only challenger used for publication-gate comparisons. */
  readonly baseline: ProjectionStatComponents;
  readonly floor: ProjectionStatComponents;
  readonly ceiling: ProjectionStatComponents;
  readonly actual: ProjectionStatComponents;
  readonly trainingRows: number;
  readonly calibrationRows: number;
}

export interface FirstPartyBacktestComponentMetrics {
  readonly samples: number;
  readonly mae: number;
  readonly rmse: number;
  readonly bias: number;
  readonly intervalCoverage: number;
}

export interface FirstPartyProjectionBacktest {
  readonly modelVersion: string;
  readonly configuration: FirstPartyProjectionConfig;
  readonly predictions: readonly FirstPartyBacktestPrediction[];
  readonly metrics: Readonly<
    Partial<
      Record<
        FirstPartyProjectionPosition,
        Readonly<Record<string, FirstPartyBacktestComponentMetrics>>
      >
    >
  >;
  readonly overall: FirstPartyBacktestComponentMetrics;
  readonly calibration: FirstPartyProjectionCalibration;
  readonly evaluation: {
    readonly policy: "recent-fantasy-relevant";
    readonly maximumWeekBatches: number;
    readonly completedWeekBatches: number;
    readonly fantasyRelevantTargets: number;
    readonly firstEvaluated?: { readonly season: number; readonly week: number };
    readonly lastEvaluated?: { readonly season: number; readonly week: number };
  };
}

export type FirstPartyProjectionStrategy = "first-party-model" | "recency-only";

export interface FirstPartyProjectionChampionChoice {
  readonly strategy: FirstPartyProjectionStrategy;
  readonly reason: "model-cleared-margin" | "baseline-defended" | "insufficient-samples";
  readonly samples: number;
  readonly completedWeekBatches: number;
  readonly modelMae: number;
  readonly baselineMae: number;
  readonly modelImprovement: number;
}

export interface FirstPartyProjectionChampionPolicy {
  readonly modelVersion: string;
  readonly scoringProfileKey: string;
  readonly minimumModelImprovement: number;
  readonly minimumSamples: number;
  readonly minimumWeekBatches: number;
  readonly generatedThrough?: { readonly season: number; readonly week: number };
  readonly byPosition: Readonly<
    Partial<Record<FirstPartyProjectionPosition, FirstPartyProjectionChampionChoice>>
  >;
}

export interface FirstPartyProjectionChampionResult {
  /** Rolling, prior-only champion predictions used to calibrate and gate live publication. */
  readonly backtest: FirstPartyProjectionBacktest;
  /** Champion choices trained on every completed prediction in `backtest` for the next live week. */
  readonly policy: FirstPartyProjectionChampionPolicy;
}

export interface FirstPartyProjectionChampionOptions {
  /** A model must improve MAE by at least this fraction before it can displace recency-only. */
  readonly minimumModelImprovement?: number;
  /** Prevents a small hot streak from selecting the model. */
  readonly minimumSamples?: number;
  /** Whole completed batches required before the model can displace the baseline. */
  readonly minimumWeekBatches?: number;
}

export interface FirstPartyPointResidualCalibration {
  readonly samples: number;
  /** Prior-only fantasy-point correction added to the next raw mean. */
  readonly centerAdjustment: number;
  /** Quantiles of actual fantasy points minus projected fantasy points. */
  readonly lowerError: number;
  readonly upperError: number;
  readonly mae: number;
  readonly rmse: number;
  readonly bias: number;
  readonly baselineMae: number;
  readonly improvement: number;
  readonly beatsBaseline: boolean;
  /** Expanding-window coverage after enough prior residuals existed; null means not measurable. */
  readonly intervalCoverage: number | null;
  readonly intervalCoverageSamples: number;
}

export interface FirstPartyScoredBacktestEvaluation {
  readonly modelVersion: string;
  readonly scoringProfileKey: string;
  readonly baseline: "recency-only";
  readonly generatedThrough?: { readonly season: number; readonly week: number };
  readonly byPosition: Readonly<
    Partial<Record<FirstPartyProjectionPosition, FirstPartyPointResidualCalibration>>
  >;
  readonly byPlayer: Readonly<Record<string, FirstPartyPointResidualCalibration>>;
  readonly overall: FirstPartyPointResidualCalibration;
}

export interface FirstPartyScoredBacktestOptions {
  readonly minimumIntervalSamples?: number;
  readonly minimumPlayerSamples?: number;
  readonly lowerIntervalQuantile?: number;
  readonly upperIntervalQuantile?: number;
}

export interface FirstPartyTeamDefenseWeeklyStatLine {
  readonly team: string;
  readonly season: number;
  readonly week: number;
  readonly opponent?: string;
  readonly components: ProjectionStatComponents;
  readonly played?: boolean;
}

export interface FirstPartyTeamDefenseContext {
  readonly pressureMultiplier?: number;
  readonly turnoverMultiplier?: number;
  readonly touchdownMultiplier?: number;
  readonly pointsAllowedMultiplier?: number;
  readonly yardsAllowedMultiplier?: number;
}

export interface FirstPartyTeamDefenseTarget {
  readonly team: string;
  readonly season: number;
  readonly week: number;
  readonly opponent?: string;
  readonly scheduled?: boolean;
  readonly isBye?: boolean;
  readonly context?: FirstPartyTeamDefenseContext;
}

export interface FirstPartyTeamDefenseCalibration {
  readonly modelVersion: string;
  readonly generatedThrough?: { readonly season: number; readonly week: number };
  readonly intervals: Readonly<Record<string, FirstPartyCalibrationInterval>>;
}

export interface FirstPartyTeamDefenseProjectionInput {
  readonly target: FirstPartyTeamDefenseTarget;
  readonly history: readonly FirstPartyTeamDefenseWeeklyStatLine[];
  readonly calibration?: FirstPartyTeamDefenseCalibration;
  readonly config?: Partial<FirstPartyProjectionConfig>;
}

export interface FirstPartyTeamDefenseProjection {
  readonly state: "projected" | "unavailable";
  readonly team: string;
  readonly components: ProjectionStatComponents;
  /** Raw statistical lower/upper bounds; scoring direction is league-rule dependent. */
  readonly lowerComponents: ProjectionStatComponents;
  readonly upperComponents: ProjectionStatComponents;
  readonly coverage: {
    readonly teamGames: number;
    readonly opponentGames: number;
    readonly leagueGames: number;
    readonly calibratedComponents: number;
    readonly fallbackComponents: number;
  };
  readonly quality: FirstPartyProjectionQuality;
  readonly reasons: readonly string[];
  readonly provenance: {
    readonly modelVersion: string;
    readonly independenceKey: "laces-out-first-party-defense";
    readonly target: { readonly season: number; readonly week: number };
    readonly trainingCutoff: { readonly season: number; readonly week: number };
    readonly latestInput?: { readonly season: number; readonly week: number };
    readonly inputFingerprint: string;
  };
}

export interface FirstPartyTeamDefenseBacktestPrediction {
  readonly team: string;
  readonly season: number;
  readonly week: number;
  readonly predicted: ProjectionStatComponents;
  readonly baseline: ProjectionStatComponents;
  readonly lower: ProjectionStatComponents;
  readonly upper: ProjectionStatComponents;
  readonly actual: ProjectionStatComponents;
  readonly trainingRows: number;
  readonly calibrationRows: number;
}

export interface FirstPartyTeamDefenseBacktest {
  readonly modelVersion: string;
  readonly predictions: readonly FirstPartyTeamDefenseBacktestPrediction[];
  readonly metrics: Readonly<Record<string, FirstPartyBacktestComponentMetrics>>;
  readonly overall: FirstPartyBacktestComponentMetrics;
  readonly calibration: FirstPartyTeamDefenseCalibration;
}

export interface FirstPartyScoredTeamDefenseEvaluation {
  readonly modelVersion: string;
  readonly scoringProfileKey: string;
  readonly baseline: "recency-only";
  readonly generatedThrough?: { readonly season: number; readonly week: number };
  readonly byTeam: Readonly<Record<string, FirstPartyPointResidualCalibration>>;
  readonly overall: FirstPartyPointResidualCalibration;
}

const DEFAULT_CONFIG: FirstPartyProjectionConfig = {
  recencyHalfLifeWeeks: 6,
  playerPriorGames: 4,
  opponentPriorGames: 20,
  teamPriorGames: 16,
  maxPlayerGames: 24,
  minimumCalibrationSamples: 24,
  lowerIntervalQuantile: 0.15,
  upperIntervalQuantile: 0.85,
  backtestEvaluationWeeks: 20,
};

export const FIRST_PARTY_CHAMPION_MINIMUM_IMPROVEMENT = 0.02;
export const FIRST_PARTY_CHAMPION_MINIMUM_SAMPLES = 100;
export const FIRST_PARTY_CHAMPION_MINIMUM_WEEK_BATCHES = 8;

const POSITION_COMPONENTS: Readonly<Record<FirstPartyProjectionPosition, readonly string[]>> = {
  QB: [
    "passing_attempts",
    "passing_completions",
    "passing_yards",
    "passing_touchdowns",
    "passing_interceptions",
    "carries",
    "rushing_yards",
    "rushing_touchdowns",
    "passing_two_point_conversions",
    "rushing_two_point_conversions",
    "receiving_two_point_conversions",
    "two_point_conversions",
    "special_teams_touchdowns",
    "fumble_recovery_touchdowns",
    "punt_return_yards",
    "kickoff_return_yards",
    "return_yards",
    "return_touchdowns",
    "fumbles_lost",
  ],
  RB: [
    "carries",
    "rushing_yards",
    "rushing_touchdowns",
    "targets",
    "receptions",
    "receiving_yards",
    "receiving_touchdowns",
    "passing_two_point_conversions",
    "rushing_two_point_conversions",
    "receiving_two_point_conversions",
    "two_point_conversions",
    "special_teams_touchdowns",
    "fumble_recovery_touchdowns",
    "punt_return_yards",
    "kickoff_return_yards",
    "return_yards",
    "return_touchdowns",
    "fumbles_lost",
  ],
  WR: [
    "targets",
    "receptions",
    "receiving_yards",
    "receiving_touchdowns",
    "carries",
    "rushing_yards",
    "rushing_touchdowns",
    "passing_two_point_conversions",
    "rushing_two_point_conversions",
    "receiving_two_point_conversions",
    "two_point_conversions",
    "special_teams_touchdowns",
    "fumble_recovery_touchdowns",
    "punt_return_yards",
    "kickoff_return_yards",
    "return_yards",
    "return_touchdowns",
    "fumbles_lost",
  ],
  TE: [
    "targets",
    "receptions",
    "receiving_yards",
    "receiving_touchdowns",
    "carries",
    "rushing_yards",
    "rushing_touchdowns",
    "passing_two_point_conversions",
    "rushing_two_point_conversions",
    "receiving_two_point_conversions",
    "two_point_conversions",
    "special_teams_touchdowns",
    "fumble_recovery_touchdowns",
    "punt_return_yards",
    "kickoff_return_yards",
    "return_yards",
    "return_touchdowns",
    "fumbles_lost",
  ],
  K: [
    "field_goals_attempted",
    "field_goals_made",
    "field_goals_missed",
    "field_goals_made_0_19",
    "field_goals_made_20_29",
    "field_goals_made_30_39",
    "field_goals_made_0_39",
    "field_goals_made_40_49",
    "field_goals_made_50_59",
    "field_goals_made_60_plus",
    "field_goals_made_50_plus",
    "extra_points_attempted",
    "extra_points_made",
    "extra_points_missed",
  ],
};

const COMPONENT_CAPS: Readonly<Record<string, number>> = {
  passing_attempts: 70,
  passing_completions: 55,
  passing_yards: 600,
  passing_touchdowns: 7,
  passing_interceptions: 6,
  carries: 45,
  rushing_yards: 350,
  rushing_touchdowns: 5,
  targets: 25,
  receptions: 20,
  receiving_yards: 350,
  receiving_touchdowns: 5,
  passing_two_point_conversions: 3,
  rushing_two_point_conversions: 3,
  receiving_two_point_conversions: 3,
  two_point_conversions: 3,
  special_teams_touchdowns: 5,
  fumble_recovery_touchdowns: 3,
  punt_return_yards: 350,
  kickoff_return_yards: 500,
  return_yards: 800,
  return_touchdowns: 5,
  fumbles_lost: 4,
  field_goals_attempted: 10,
  field_goals_made: 10,
  field_goals_missed: 8,
  field_goals_made_0_19: 5,
  field_goals_made_20_29: 5,
  field_goals_made_30_39: 6,
  field_goals_made_0_39: 10,
  field_goals_made_40_49: 6,
  field_goals_made_50_59: 5,
  field_goals_made_60_plus: 3,
  field_goals_made_50_plus: 6,
  extra_points_attempted: 10,
  extra_points_made: 10,
  extra_points_missed: 5,
  defensive_sacks: 15,
  defensive_interceptions: 8,
  defensive_fumble_recoveries: 8,
  defensive_safeties: 4,
  defensive_touchdowns: 6,
  defensive_blocked_kicks: 6,
  points_allowed: 80,
  yards_allowed: 800,
  points_allowed_0_probability: 1,
  points_allowed_1_6_probability: 1,
  points_allowed_7_13_probability: 1,
  points_allowed_14_20_probability: 1,
  points_allowed_14_17_probability: 1,
  points_allowed_18_21_probability: 1,
  points_allowed_21_27_probability: 1,
  points_allowed_22_27_probability: 1,
  points_allowed_28_34_probability: 1,
  points_allowed_35_plus_probability: 1,
  points_allowed_35_45_probability: 1,
  points_allowed_46_plus_probability: 1,
  yards_allowed_0_99_probability: 1,
  yards_allowed_100_199_probability: 1,
  yards_allowed_200_299_probability: 1,
  yards_allowed_300_349_probability: 1,
  yards_allowed_350_399_probability: 1,
  yards_allowed_400_449_probability: 1,
  yards_allowed_450_499_probability: 1,
  yards_allowed_500_549_probability: 1,
  yards_allowed_550_plus_probability: 1,
};

const COMMON_TEAM_DEFENSE_POINTS_ALLOWED_BUCKETS = [
  { component: "points_allowed_0_probability", minimum: 0, maximum: 0 },
  { component: "points_allowed_1_6_probability", minimum: 1, maximum: 6 },
  { component: "points_allowed_7_13_probability", minimum: 7, maximum: 13 },
] as const;

const YAHOO_TEAM_DEFENSE_POINTS_ALLOWED_BUCKETS = [
  ...COMMON_TEAM_DEFENSE_POINTS_ALLOWED_BUCKETS,
  { component: "points_allowed_14_20_probability", minimum: 14, maximum: 20 },
  { component: "points_allowed_21_27_probability", minimum: 21, maximum: 27 },
  { component: "points_allowed_28_34_probability", minimum: 28, maximum: 34 },
  {
    component: "points_allowed_35_plus_probability",
    minimum: 35,
    maximum: Number.POSITIVE_INFINITY,
  },
] as const;

const ESPN_TEAM_DEFENSE_POINTS_ALLOWED_BUCKETS = [
  ...COMMON_TEAM_DEFENSE_POINTS_ALLOWED_BUCKETS,
  { component: "points_allowed_14_17_probability", minimum: 14, maximum: 17 },
  { component: "points_allowed_18_21_probability", minimum: 18, maximum: 21 },
  { component: "points_allowed_22_27_probability", minimum: 22, maximum: 27 },
  { component: "points_allowed_28_34_probability", minimum: 28, maximum: 34 },
  { component: "points_allowed_35_45_probability", minimum: 35, maximum: 45 },
  {
    component: "points_allowed_46_plus_probability",
    minimum: 46,
    maximum: Number.POSITIVE_INFINITY,
  },
] as const;

const TEAM_DEFENSE_POINTS_ALLOWED_BUCKET_GROUPS = [
  {
    buckets: YAHOO_TEAM_DEFENSE_POINTS_ALLOWED_BUCKETS,
    fallbackComponent: "points_allowed_21_27_probability",
  },
  {
    buckets: ESPN_TEAM_DEFENSE_POINTS_ALLOWED_BUCKETS,
    fallbackComponent: "points_allowed_22_27_probability",
  },
] as const;

const TEAM_DEFENSE_POINTS_ALLOWED_BUCKETS = [
  ...new Map(
    TEAM_DEFENSE_POINTS_ALLOWED_BUCKET_GROUPS.flatMap((group) =>
      group.buckets.map((bucket) => [bucket.component, bucket] as const),
    ),
  ).values(),
] as const;

/**
 * ESPN's evidence-established yards-allowed ladder (provider IDs 128-136 in this order;
 * `docs/plans/ROS_GATE_AND_DST_PLAN.md` §0.1). The 300-349 tier gets a component even though no
 * league prices it — the ladder must partition the yards axis or the probabilities cannot sum to 1.
 */
const ESPN_TEAM_DEFENSE_YARDS_ALLOWED_BUCKETS = [
  { component: "yards_allowed_0_99_probability", minimum: 0, maximum: 99 },
  { component: "yards_allowed_100_199_probability", minimum: 100, maximum: 199 },
  { component: "yards_allowed_200_299_probability", minimum: 200, maximum: 299 },
  { component: "yards_allowed_300_349_probability", minimum: 300, maximum: 349 },
  { component: "yards_allowed_350_399_probability", minimum: 350, maximum: 399 },
  { component: "yards_allowed_400_449_probability", minimum: 400, maximum: 449 },
  { component: "yards_allowed_450_499_probability", minimum: 450, maximum: 499 },
  { component: "yards_allowed_500_549_probability", minimum: 500, maximum: 549 },
  {
    component: "yards_allowed_550_plus_probability",
    minimum: 550,
    maximum: Number.POSITIVE_INFINITY,
  },
] as const;

/**
 * One ESPN group today. The group shape mirrors `TEAM_DEFENSE_POINTS_ALLOWED_BUCKET_GROUPS` so
 * Yahoo's 12-bucket yards-allowed ladder (provider IDs 70-81) can be admitted later without
 * restructuring; Yahoo's bracket boundaries are not evidence-established and stay unsupported.
 */
const TEAM_DEFENSE_YARDS_ALLOWED_BUCKET_GROUPS = [
  {
    buckets: ESPN_TEAM_DEFENSE_YARDS_ALLOWED_BUCKETS,
    fallbackComponent: "yards_allowed_300_349_probability",
  },
] as const;

const TEAM_DEFENSE_YARDS_ALLOWED_BUCKETS = [
  ...new Map(
    TEAM_DEFENSE_YARDS_ALLOWED_BUCKET_GROUPS.flatMap((group) =>
      group.buckets.map((bucket) => [bucket.component, bucket] as const),
    ),
  ).values(),
] as const;

/**
 * Every D/ST component the model estimates from history. The de minimis constants below are NOT
 * here on purpose: they are not fitted, not calibrated and not graded, so keeping them out of this
 * list is what makes every existing defense number — the confidence denominator, the calibration
 * intervals, the backtest residual and metric streams — byte-identical to what it was before they
 * were introduced.
 */
const TEAM_DEFENSE_MODELED_COMPONENTS = [
  "defensive_sacks",
  "defensive_interceptions",
  "defensive_fumble_recoveries",
  "defensive_safeties",
  "defensive_touchdowns",
  "defensive_blocked_kicks",
  "special_teams_touchdowns",
  "points_allowed",
  "yards_allowed",
  ...TEAM_DEFENSE_POINTS_ALLOWED_BUCKETS.map((bucket) => bucket.component),
  ...TEAM_DEFENSE_YARDS_ALLOWED_BUCKETS.map((bucket) => bucket.component),
] as const;

/**
 * D/ST components priced by the **de minimis zero model**, stated in full in
 * `docs/dst-stat-id-evidence-2026-07-29.md` §4 ("The de minimis zero criterion"):
 *
 * > A scoring component may be modeled at constant zero ONLY when publicly citable occurrence data
 * > bounds its expected fantasy points below 0.01 per team-week at the league's own point values.
 *
 * Both bounds are recorded there with their sources, denominators and arithmetic:
 * `defensive_two_point_returns` (ESPN stat 206, 2 pts in all three leagues) at 11 league-wide
 * occurrences across 5,248 team-games, 2015-2024 — **0.0042 expected points per team-week**; and
 * `one_point_safeties` (ESPN stat 209, 1 pt) at **zero occurrences in NFL history**, whose rule-of-
 * three upper bound over the same exposure is **0.00057 expected points per team-week**.
 *
 * This is a bounded, disclosed model claim graded by the same gates as everything else — NOT a
 * dropped rule (the rule is mapped, carried in the emitted profile, and multiplied into every scored
 * line) and NOT a remembered rate (the number shipped is the floor of a cited bound, not a recalled
 * frequency). No ingested source carries either event — see §1 and §2 — so there is nothing to fit
 * and nothing to grade; the constant is the model.
 *
 * Extending this list requires a new §4 subsection with its own citable bound, first. A future
 * measurement putting either component at or above 0.01 points per team-week revokes its licence:
 * it must then be modeled from data or returned to the unsupported set (§4.1).
 */
const TEAM_DEFENSE_DE_MINIMIS_ZERO_COMPONENTS = [
  "defensive_two_point_returns",
  "one_point_safeties",
] as const;

const TEAM_DEFENSE_COMPONENTS = [
  ...TEAM_DEFENSE_MODELED_COMPONENTS,
  ...TEAM_DEFENSE_DE_MINIMIS_ZERO_COMPONENTS,
] as const;

/** Writes the de minimis constants onto a component record. Always exactly 0 — see the list above. */
function applyTeamDefenseDeMinimisZeros(...records: Record<string, number>[]): void {
  for (const record of records) {
    for (const component of TEAM_DEFENSE_DE_MINIMIS_ZERO_COMPONENTS) record[component] = 0;
  }
}

function deriveTeamDefensePointBuckets(
  components: Record<string, number>,
  training: readonly FirstPartyTeamDefenseWeeklyStatLine[],
  target: FirstPartyTeamDefenseTarget,
  config: FirstPartyProjectionConfig,
): void {
  const center = clamp(components.points_allowed ?? 0, 0, capFor("points_allowed"));
  const historical = training.flatMap((row) => {
    const value = row.components.points_allowed;
    if (value === undefined || !Number.isFinite(value) || value < 0) return [];
    return [{ value, weight: defenseRecencyWeight(row, target, config.recencyHalfLifeWeeks) }];
  });
  const historicalCenter = historical.length === 0 ? center : (weightedMean(historical) ?? center);
  const variance =
    historical.length < 2
      ? 100
      : (weightedMean(
          historical.map(({ value, weight }) => ({
            value: (value - historicalCenter) ** 2,
            weight,
          })),
        ) ?? 100);
  const standardDeviation = clamp(Math.sqrt(variance), 5, 18);
  const pointMass = Array.from({ length: 81 }, (_, points) => ({
    points,
    mass: Math.exp(-0.5 * ((points - center) / standardDeviation) ** 2),
  }));
  const totalMass = pointMass.reduce((sum, row) => sum + row.mass, 0);
  for (const bucket of TEAM_DEFENSE_POINTS_ALLOWED_BUCKETS) {
    components[bucket.component] = pointMass.reduce(
      (sum, row) =>
        row.points >= bucket.minimum && row.points <= bucket.maximum
          ? sum + row.mass / totalMass
          : sum,
      0,
    );
  }
}

/**
 * Yards-allowed tier probabilities, structurally parallel to `deriveTeamDefensePointBuckets` but
 * calibrated on its own scale. The dispersion constants come from
 * `docs/dst-yards-allowed-calibration-2026-07-29.md` (measured 2023-2025 REG nflverse team-weeks:
 * league-wide weekly SD 84.97, per-team-season residual SDs 50.4-112.8) and are NOT the points
 * model's constants: integer grid 0..800 (matching `COMPONENT_CAPS.yards_allowed`), sigma clamped
 * to [55, 115], variance fallback 7225 (sigma 85) when fewer than two usable rows exist.
 */
function deriveTeamDefenseYardBuckets(
  components: Record<string, number>,
  training: readonly FirstPartyTeamDefenseWeeklyStatLine[],
  target: FirstPartyTeamDefenseTarget,
  config: FirstPartyProjectionConfig,
): void {
  const center = clamp(components.yards_allowed ?? 0, 0, capFor("yards_allowed"));
  const historical = training.flatMap((row) => {
    const value = row.components.yards_allowed;
    if (value === undefined || !Number.isFinite(value) || value < 0) return [];
    return [{ value, weight: defenseRecencyWeight(row, target, config.recencyHalfLifeWeeks) }];
  });
  const historicalCenter = historical.length === 0 ? center : (weightedMean(historical) ?? center);
  const variance =
    historical.length < 2
      ? 7225
      : (weightedMean(
          historical.map(({ value, weight }) => ({
            value: (value - historicalCenter) ** 2,
            weight,
          })),
        ) ?? 7225);
  const standardDeviation = clamp(Math.sqrt(variance), 55, 115);
  const yardMass = Array.from({ length: 801 }, (_, yards) => ({
    yards,
    mass: Math.exp(-0.5 * ((yards - center) / standardDeviation) ** 2),
  }));
  const totalMass = yardMass.reduce((sum, row) => sum + row.mass, 0);
  // Fail-safe: with sigma >= 55 and a clamped in-grid center, the nearest node carries mass ~1, so
  // total mass cannot vanish in practice. If a degenerate input ever produced zero mass anyway,
  // dividing would write NaN probabilities; instead leave the step-one shrinkage centers (already
  // bounded to [0, 1] by the component cap) untouched.
  if (!(totalMass > 0)) return;
  for (const bucket of TEAM_DEFENSE_YARDS_ALLOWED_BUCKETS) {
    components[bucket.component] = yardMass.reduce(
      (sum, row) =>
        row.yards >= bucket.minimum && row.yards <= bucket.maximum
          ? sum + row.mass / totalMass
          : sum,
      0,
    );
  }
}

const INACTIVE_STATUSES = new Set<FirstPartyPlayerStatus>([
  "out",
  "inactive",
  "suspended",
  "pup",
  "ir",
]);

function normalizedPosition(position: string): FirstPartyProjectionPosition | undefined {
  const normalized = position.trim().toUpperCase();
  return normalized === "QB" ||
    normalized === "RB" ||
    normalized === "WR" ||
    normalized === "TE" ||
    normalized === "K"
    ? normalized
    : undefined;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function finiteOrUndefined(value: number | undefined): number | undefined {
  return value === undefined || !Number.isFinite(value) ? undefined : value;
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive integer`);
  }
}

function validateTarget(target: FirstPartyProjectionTarget): void {
  if (target.playerId.trim().length === 0) throw new TypeError("target playerId must not be empty");
  if (target.team.trim().length === 0) throw new TypeError("target team must not be empty");
  assertPositiveInteger(target.season, "target season");
  assertPositiveInteger(target.week, "target week");
}

function validateConfig(config: FirstPartyProjectionConfig): void {
  if (!Number.isFinite(config.recencyHalfLifeWeeks) || config.recencyHalfLifeWeeks <= 0) {
    throw new RangeError("recencyHalfLifeWeeks must be greater than zero");
  }
  for (const [label, value] of [
    ["playerPriorGames", config.playerPriorGames],
    ["opponentPriorGames", config.opponentPriorGames],
    ["teamPriorGames", config.teamPriorGames],
    ["maxPlayerGames", config.maxPlayerGames],
    ["minimumCalibrationSamples", config.minimumCalibrationSamples],
    ["backtestEvaluationWeeks", config.backtestEvaluationWeeks],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${label} must be positive`);
  }
  if (!Number.isSafeInteger(config.backtestEvaluationWeeks)) {
    throw new RangeError("backtestEvaluationWeeks must be a positive integer");
  }
  if (
    config.lowerIntervalQuantile < 0 ||
    config.upperIntervalQuantile > 1 ||
    config.lowerIntervalQuantile >= config.upperIntervalQuantile
  ) {
    throw new RangeError("projection interval quantiles must be ordered within zero and one");
  }
}

function resolvedConfig(input: Partial<FirstPartyProjectionConfig> | undefined) {
  const config = { ...DEFAULT_CONFIG, ...input };
  validateConfig(config);
  return config;
}

function ordinal(season: number, week: number): number {
  return season * 25 + week;
}

function strictlyBefore(
  row: Pick<FirstPartyWeeklyStatLine, "season" | "week">,
  target: Pick<FirstPartyProjectionTarget, "season" | "week">,
): boolean {
  return ordinal(row.season, row.week) < ordinal(target.season, target.week);
}

function compareLines(left: FirstPartyWeeklyStatLine, right: FirstPartyWeeklyStatLine): number {
  return (
    ordinal(left.season, left.week) - ordinal(right.season, right.week) ||
    left.playerId.localeCompare(right.playerId) ||
    left.team.localeCompare(right.team)
  );
}

function isTrainingLine(row: FirstPartyWeeklyStatLine): boolean {
  return row.played !== false && !INACTIVE_STATUSES.has(row.status ?? "unknown");
}

interface PreparedFirstPartyHistory {
  readonly eligible: readonly FirstPartyWeeklyStatLine[];
  readonly latestOrdinal: number;
  readonly latestInput?: { readonly season: number; readonly week: number };
  readonly historyFingerprint: string;
  readonly byPosition: ReadonlyMap<
    FirstPartyProjectionPosition,
    readonly FirstPartyWeeklyStatLine[]
  >;
  readonly byPlayer: ReadonlyMap<string, readonly FirstPartyWeeklyStatLine[]>;
  readonly byPositionOpponent: ReadonlyMap<
    FirstPartyProjectionPosition,
    ReadonlyMap<string, readonly FirstPartyWeeklyStatLine[]>
  >;
  readonly teamWeeks: Map<string, readonly TeamWeekValue[]>;
  readonly positionPriors: Map<string, number>;
  readonly teamMultipliers: Map<string, { readonly multiplier: number; readonly samples: number }>;
  readonly opponentMultipliers: Map<
    string,
    { readonly multiplier: number; readonly samples: number }
  >;
}

const PREPARED_FIRST_PARTY_HISTORY = new WeakMap<
  readonly FirstPartyWeeklyStatLine[],
  PreparedFirstPartyHistory
>();

function prepareFirstPartyHistory(
  history: readonly FirstPartyWeeklyStatLine[],
): PreparedFirstPartyHistory {
  const cached = PREPARED_FIRST_PARTY_HISTORY.get(history);
  if (cached !== undefined) return cached;
  const eligible = history.filter(isTrainingLine).sort(compareLines);
  const byPosition = new Map<FirstPartyProjectionPosition, FirstPartyWeeklyStatLine[]>();
  const byPlayer = new Map<string, FirstPartyWeeklyStatLine[]>();
  const byPositionOpponent = new Map<
    FirstPartyProjectionPosition,
    Map<string, FirstPartyWeeklyStatLine[]>
  >();
  for (const row of eligible) {
    const playerRows = byPlayer.get(row.playerId) ?? [];
    playerRows.push(row);
    byPlayer.set(row.playerId, playerRows);
    const position = normalizedPosition(row.position);
    if (position === undefined) continue;
    const positionRows = byPosition.get(position) ?? [];
    positionRows.push(row);
    byPosition.set(position, positionRows);
    const opponent = row.opponent?.trim().toUpperCase();
    if (opponent === undefined) continue;
    const positionOpponents =
      byPositionOpponent.get(position) ?? new Map<string, FirstPartyWeeklyStatLine[]>();
    const opponentRows = positionOpponents.get(opponent) ?? [];
    opponentRows.push(row);
    positionOpponents.set(opponent, opponentRows);
    byPositionOpponent.set(position, positionOpponents);
  }
  const latest = eligible.at(-1);
  const prepared: PreparedFirstPartyHistory = {
    eligible,
    latestOrdinal:
      eligible.length === 0
        ? Number.NEGATIVE_INFINITY
        : ordinal(latest?.season ?? 0, latest?.week ?? 0),
    ...(latest === undefined ? {} : { latestInput: { season: latest.season, week: latest.week } }),
    historyFingerprint: stableFingerprint(
      eligible.map((row) => ({
        playerId: row.playerId,
        position: row.position,
        season: row.season,
        week: row.week,
        team: row.team,
        ...(row.opponent === undefined ? {} : { opponent: row.opponent }),
        components: Object.fromEntries(
          Object.entries(row.components).sort(([left], [right]) => left.localeCompare(right)),
        ),
        ...(row.snapShare === undefined ? {} : { snapShare: row.snapShare }),
        ...(row.targetShare === undefined ? {} : { targetShare: row.targetShare }),
        ...(row.carryShare === undefined ? {} : { carryShare: row.carryShare }),
        ...(row.passAttemptShare === undefined ? {} : { passAttemptShare: row.passAttemptShare }),
        ...(row.played === undefined ? {} : { played: row.played }),
        ...(row.status === undefined ? {} : { status: row.status }),
      })),
    ),
    byPosition,
    byPlayer,
    byPositionOpponent,
    teamWeeks: new Map(),
    positionPriors: new Map(),
    teamMultipliers: new Map(),
    opponentMultipliers: new Map(),
  };
  PREPARED_FIRST_PARTY_HISTORY.set(history, prepared);
  PREPARED_FIRST_PARTY_HISTORY.set(eligible, prepared);
  return prepared;
}

function weightedRecentRole(values: readonly (number | undefined)[]): number | undefined {
  let numerator = 0;
  let denominator = 0;
  for (const [index, value] of values.entries()) {
    if (value === undefined || !Number.isFinite(value)) continue;
    const weight = index + 1;
    numerator += clamp(value, 0, 1) * weight;
    denominator += weight;
  }
  return denominator === 0 ? undefined : numerator / denominator;
}

/** Derives the exact prior four-game role signal used by live forecasts and rolling backtests. */
export function firstPartyRecentRoleContext(
  history: readonly FirstPartyWeeklyStatLine[],
  playerId: string,
): FirstPartyRoleContext | undefined {
  const recent = (prepareFirstPartyHistory(history).byPlayer.get(playerId) ?? []).slice(-4);
  if (recent.length === 0) return undefined;
  const snapShare = weightedRecentRole(recent.map((row) => row.snapShare));
  const targetShare = weightedRecentRole(recent.map((row) => row.targetShare));
  const carryShare = weightedRecentRole(recent.map((row) => row.carryShare));
  const passAttemptShare = weightedRecentRole(recent.map((row) => row.passAttemptShare));
  const role: FirstPartyRoleContext = {
    ...(snapShare === undefined ? {} : { snapShare }),
    ...(targetShare === undefined ? {} : { targetShare }),
    ...(carryShare === undefined ? {} : { carryShare }),
    ...(passAttemptShare === undefined ? {} : { passAttemptShare }),
  };
  return Object.keys(role).length > 0 ? role : undefined;
}

function recencyWeight(
  row: Pick<FirstPartyWeeklyStatLine, "season" | "week">,
  target: Pick<FirstPartyProjectionTarget, "season" | "week">,
  halfLife: number,
): number {
  const distance = Math.max(1, ordinal(target.season, target.week) - ordinal(row.season, row.week));
  return 0.5 ** (distance / halfLife);
}

function componentValue(row: FirstPartyWeeklyStatLine, component: string): number | undefined {
  const value =
    row.components[component] ??
    (component === "two_point_conversions"
      ? (row.components.passing_two_point_conversions ?? 0) +
        (row.components.rushing_two_point_conversions ?? 0) +
        (row.components.receiving_two_point_conversions ?? 0)
      : component === "return_yards"
        ? (row.components.punt_return_yards ?? 0) + (row.components.kickoff_return_yards ?? 0)
        : component === "return_touchdowns"
          ? (row.components.special_teams_touchdowns ?? 0)
          : component === "field_goals_made_0_39"
            ? (row.components.field_goals_made_0_19 ?? 0) +
              (row.components.field_goals_made_20_29 ?? 0) +
              (row.components.field_goals_made_30_39 ?? 0)
            : component === "field_goals_made_50_plus"
              ? (row.components.field_goals_made_50_59 ?? 0) +
                (row.components.field_goals_made_60_plus ?? 0)
              : undefined);
  return value === undefined || !Number.isFinite(value) || value < 0 ? undefined : value;
}

function weightedMean(
  samples: readonly { readonly value: number; readonly weight: number }[],
): number | undefined {
  let numerator = 0;
  let denominator = 0;
  for (const sample of samples) {
    if (!Number.isFinite(sample.value) || !Number.isFinite(sample.weight) || sample.weight <= 0) {
      continue;
    }
    numerator += sample.value * sample.weight;
    denominator += sample.weight;
  }
  return denominator === 0 ? undefined : numerator / denominator;
}

function weightedComponentMean(
  rows: readonly FirstPartyWeeklyStatLine[],
  component: string,
  target: FirstPartyProjectionTarget,
  halfLife: number,
): number | undefined {
  return weightedMean(
    rows.flatMap((row) => {
      const value = componentValue(row, component);
      return value === undefined ? [] : [{ value, weight: recencyWeight(row, target, halfLife) }];
    }),
  );
}

function targetRoleValue(
  role: FirstPartyRoleContext | undefined,
  component: string,
): number | undefined {
  if (component.startsWith("passing_")) return finiteOrUndefined(role?.passAttemptShare);
  if (component === "carries" || component.startsWith("rushing_")) {
    return finiteOrUndefined(role?.carryShare);
  }
  if (component === "targets" || component === "receptions" || component.startsWith("receiving_")) {
    return finiteOrUndefined(role?.targetShare);
  }
  return finiteOrUndefined(role?.snapShare);
}

function rowRoleValue(row: FirstPartyWeeklyStatLine, component: string): number | undefined {
  if (component.startsWith("passing_")) return finiteOrUndefined(row.passAttemptShare);
  if (component === "carries" || component.startsWith("rushing_")) {
    return finiteOrUndefined(row.carryShare);
  }
  if (component === "targets" || component === "receptions" || component.startsWith("receiving_")) {
    return finiteOrUndefined(row.targetShare);
  }
  return finiteOrUndefined(row.snapShare);
}

function roleSimilarityWeight(
  row: FirstPartyWeeklyStatLine,
  component: string,
  wanted: number | undefined,
): number {
  const observed = rowRoleValue(row, component);
  if (wanted === undefined || observed === undefined) return 1;
  const difference = clamp(wanted, 0, 1) - clamp(observed, 0, 1);
  return Math.exp(-(difference * difference) / 0.08);
}

function positionPriorMean(
  rows: readonly FirstPartyWeeklyStatLine[],
  component: string,
  target: FirstPartyProjectionTarget,
  halfLife: number,
  wantedRole: number | undefined,
): number {
  return (
    weightedMean(
      rows.flatMap((row) => {
        const value = componentValue(row, component);
        return value === undefined
          ? []
          : [
              {
                value,
                weight:
                  recencyWeight(row, target, halfLife) *
                  roleSimilarityWeight(row, component, wantedRole),
              },
            ];
      }),
    ) ?? 0
  );
}

function roleMultiplier(
  rows: readonly FirstPartyWeeklyStatLine[],
  target: FirstPartyProjectionTarget,
  component: string,
  halfLife: number,
): number {
  const wanted = targetRoleValue(target.role, component);
  if (wanted === undefined) return 1;
  const observed = weightedMean(
    rows.flatMap((row) => {
      const value = rowRoleValue(row, component);
      return value === undefined
        ? []
        : [{ value: clamp(value, 0, 1), weight: recencyWeight(row, target, halfLife) }];
    }),
  );
  if (observed === undefined || observed < 0.04) return clamp(0.65 + wanted, 0.65, 1.35);
  return clamp(wanted / observed, 0.65, 1.35);
}

function componentFamily(component: string): "pass" | "rush" | "receive" | "score" | "other" {
  if (component.startsWith("passing_")) return "pass";
  if (component === "carries" || component === "rushing_yards") return "rush";
  if (component === "targets" || component === "receptions" || component === "receiving_yards") {
    return "receive";
  }
  if (component.includes("touchdowns")) return "score";
  return "other";
}

function explicitTeamMultiplier(target: FirstPartyProjectionTarget, component: string): number {
  const context = target.teamContext;
  const pace = finiteOrUndefined(context?.playVolumeMultiplier) ?? 1;
  const family = componentFamily(component);
  if (family === "pass" || family === "receive") {
    return clamp(pace * (finiteOrUndefined(context?.passVolumeMultiplier) ?? 1), 0.75, 1.3);
  }
  if (family === "rush") {
    return clamp(pace * (finiteOrUndefined(context?.rushVolumeMultiplier) ?? 1), 0.75, 1.3);
  }
  if (family === "score") {
    return clamp(finiteOrUndefined(context?.scoringMultiplier) ?? 1, 0.7, 1.35);
  }
  return clamp(pace, 0.8, 1.2);
}

interface TeamWeekValue {
  readonly season: number;
  readonly week: number;
  readonly team: string;
  readonly value: number;
}

function aggregateTeamWeeks(
  rows: readonly FirstPartyWeeklyStatLine[],
  component: string,
): readonly TeamWeekValue[] {
  const totals = new Map<string, TeamWeekValue>();
  for (const row of rows) {
    const value = componentValue(row, component);
    if (value === undefined) continue;
    const key = `${row.season}:${row.week}:${row.team}`;
    const previous = totals.get(key);
    totals.set(key, {
      season: row.season,
      week: row.week,
      team: row.team,
      value: (previous?.value ?? 0) + value,
    });
  }
  return [...totals.values()];
}

function learnedTeamMultiplier(
  rows: readonly FirstPartyWeeklyStatLine[],
  target: FirstPartyProjectionTarget,
  component: string,
  config: FirstPartyProjectionConfig,
  preparedTeamWeeks?: readonly TeamWeekValue[],
): { readonly multiplier: number; readonly samples: number } {
  const teamWeeks = preparedTeamWeeks ?? aggregateTeamWeeks(rows, component);
  const targetTeam = target.team.trim().toUpperCase();
  const own = teamWeeks.filter((row) => row.team.trim().toUpperCase() === targetTeam);
  const ownMean = weightedMean(
    own.map((row) => ({
      value: row.value,
      weight: recencyWeight(row, target, config.recencyHalfLifeWeeks),
    })),
  );
  const leagueMean = weightedMean(
    teamWeeks.map((row) => ({
      value: row.value,
      weight: recencyWeight(row, target, config.recencyHalfLifeWeeks),
    })),
  );
  if (ownMean === undefined || leagueMean === undefined || leagueMean <= 0) {
    return { multiplier: 1, samples: own.length };
  }
  const reliability = own.length / (own.length + config.teamPriorGames);
  return {
    multiplier: clamp(1 + (ownMean / leagueMean - 1) * reliability, 0.88, 1.12),
    samples: own.length,
  };
}

function learnedOpponentMultiplier(
  rows: readonly FirstPartyWeeklyStatLine[],
  target: FirstPartyProjectionTarget,
  component: string,
  config: FirstPartyProjectionConfig,
  preparedOpponentRows?: readonly FirstPartyWeeklyStatLine[],
): { readonly multiplier: number; readonly samples: number } {
  const opponent = target.opponent?.trim().toUpperCase();
  if (!opponent) return { multiplier: 1, samples: 0 };
  const knownOpponentRows =
    preparedOpponentRows ?? rows.filter((row) => row.opponent?.trim().toUpperCase() === opponent);
  const opponentMean = weightedComponentMean(
    knownOpponentRows,
    component,
    target,
    config.recencyHalfLifeWeeks,
  );
  const leagueMean = weightedComponentMean(rows, component, target, config.recencyHalfLifeWeeks);
  if (opponentMean === undefined || leagueMean === undefined || leagueMean <= 0) {
    return { multiplier: 1, samples: knownOpponentRows.length };
  }
  const reliability =
    knownOpponentRows.length / (knownOpponentRows.length + config.opponentPriorGames);
  return {
    multiplier: clamp(1 + (opponentMean / leagueMean - 1) * reliability, 0.85, 1.15),
    samples: knownOpponentRows.length,
  };
}

function statusMultiplier(status: FirstPartyPlayerStatus | undefined): number {
  if (status === "questionable") return 0.88;
  if (status === "doubtful") return 0.45;
  return 1;
}

function quantile(values: readonly number[], probability: number): number {
  if (values.length === 0) throw new RangeError("quantile requires at least one value");
  const ordered = [...values].sort((left, right) => left - right);
  const index = (ordered.length - 1) * probability;
  const lowerIndex = Math.floor(index);
  const upperIndex = Math.ceil(index);
  const lower = ordered[lowerIndex];
  const upper = ordered[upperIndex];
  if (lower === undefined || upper === undefined)
    throw new RangeError("quantile index out of range");
  return lower + (upper - lower) * (index - lowerIndex);
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function fallbackInterval(
  positionRows: readonly FirstPartyWeeklyStatLine[],
  component: string,
  center: number,
  target: FirstPartyProjectionTarget,
  config: FirstPartyProjectionConfig,
): FirstPartyCalibrationInterval {
  const values = positionRows
    .map((row) => componentValue(row, component))
    .filter((value): value is number => value !== undefined);
  const centerOfHistory = weightedComponentMean(
    positionRows,
    component,
    target,
    config.recencyHalfLifeWeeks,
  );
  const dispersion =
    values.length > 1 && centerOfHistory !== undefined
      ? Math.sqrt(mean(values.map((value) => (value - centerOfHistory) ** 2)))
      : Math.max(0.5, center * 0.45);
  const spread = Math.max(component.includes("touchdowns") ? 0.75 : 0.5, dispersion * 1.05);
  return {
    samples: values.length,
    lowerError: -spread,
    upperError: spread,
    mae: spread / 1.25,
    rmse: spread,
    fallback: true,
  };
}

function intervalFor(
  calibration: FirstPartyProjectionCalibration | undefined,
  position: FirstPartyProjectionPosition,
  component: string,
  positionRows: readonly FirstPartyWeeklyStatLine[],
  center: number,
  target: FirstPartyProjectionTarget,
  config: FirstPartyProjectionConfig,
): FirstPartyCalibrationInterval {
  const calibrated = calibration?.intervals[position]?.[component];
  const generatedThrough = calibration?.generatedThrough;
  const calibrationIsPrior =
    generatedThrough !== undefined &&
    ordinal(generatedThrough.season, generatedThrough.week) < ordinal(target.season, target.week);
  if (
    calibration?.modelVersion === FIRST_PARTY_PROJECTION_MODEL_VERSION &&
    calibrationIsPrior &&
    calibrated !== undefined &&
    calibrated.samples >= config.minimumCalibrationSamples
  ) {
    return calibrated;
  }
  return fallbackInterval(positionRows, component, center, target, config);
}

function capFor(component: string): number {
  return COMPONENT_CAPS[component] ?? Number.MAX_SAFE_INTEGER;
}

function normalizeComponentRelationships(
  components: Record<string, number>,
  position: FirstPartyProjectionPosition,
): void {
  if (position !== "K") {
    components.two_point_conversions =
      (components.passing_two_point_conversions ?? 0) +
      (components.rushing_two_point_conversions ?? 0) +
      (components.receiving_two_point_conversions ?? 0);
    components.return_yards =
      (components.punt_return_yards ?? 0) + (components.kickoff_return_yards ?? 0);
    components.return_touchdowns = components.special_teams_touchdowns ?? 0;
  }
  if (position === "QB") {
    components.passing_completions = Math.min(
      components.passing_completions ?? 0,
      components.passing_attempts ?? 0,
    );
  }
  if (position !== "QB") {
    if (position !== "K") {
      components.receptions = Math.min(components.receptions ?? 0, components.targets ?? 0);
    }
  }
  if (position === "K") {
    const distanceMakes =
      (components.field_goals_made_0_19 ?? 0) +
      (components.field_goals_made_20_29 ?? 0) +
      (components.field_goals_made_30_39 ?? 0) +
      (components.field_goals_made_40_49 ?? 0) +
      (components.field_goals_made_50_59 ?? 0) +
      (components.field_goals_made_60_plus ?? 0);
    components.field_goals_made = Math.min(
      components.field_goals_attempted ?? 0,
      Math.min(components.field_goals_made ?? 0, distanceMakes),
    );
    if (distanceMakes > 0) {
      const distanceScale = (components.field_goals_made ?? 0) / distanceMakes;
      for (const component of [
        "field_goals_made_0_19",
        "field_goals_made_20_29",
        "field_goals_made_30_39",
        "field_goals_made_40_49",
        "field_goals_made_50_59",
        "field_goals_made_60_plus",
      ]) {
        components[component] = (components[component] ?? 0) * distanceScale;
      }
    }
    components.field_goals_made_0_39 =
      (components.field_goals_made_0_19 ?? 0) +
      (components.field_goals_made_20_29 ?? 0) +
      (components.field_goals_made_30_39 ?? 0);
    components.field_goals_made_50_plus =
      (components.field_goals_made_50_59 ?? 0) + (components.field_goals_made_60_plus ?? 0);
    components.field_goals_missed = Math.max(
      0,
      (components.field_goals_attempted ?? 0) - (components.field_goals_made ?? 0),
    );
    components.extra_points_made = Math.min(
      components.extra_points_made ?? 0,
      components.extra_points_attempted ?? 0,
    );
    components.extra_points_missed = Math.max(
      0,
      (components.extra_points_attempted ?? 0) - (components.extra_points_made ?? 0),
    );
  }
}

function normalizedComponents(
  components: Record<string, number>,
  position: FirstPartyProjectionPosition,
): ProjectionStatComponents {
  for (const component of POSITION_COMPONENTS[position]) {
    components[component] = clamp(components[component] ?? 0, 0, capFor(component));
  }
  normalizeComponentRelationships(components, position);
  return Object.fromEntries(
    POSITION_COMPONENTS[position].map((component) => [component, components[component] ?? 0]),
  );
}

function stableFingerprint(value: unknown): string {
  const json = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < json.length; index += 1) {
    hash ^= json.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function provenanceFor(
  target: FirstPartyProjectionTarget,
  training: readonly FirstPartyWeeklyStatLine[],
  config: FirstPartyProjectionConfig,
  strategy: FirstPartyProjectionStrategy = "first-party-model",
): FirstPartyProjectionProvenance {
  const prepared = prepareFirstPartyHistory(training);
  const trainingCutoff = prepared.latestInput ?? {
    season: target.season - 1,
    week: 18,
  };
  return {
    modelVersion: FIRST_PARTY_PROJECTION_MODEL_VERSION,
    independenceKey: "laces-out-first-party",
    strategy,
    target: { season: target.season, week: target.week },
    trainingCutoff,
    ...(prepared.latestInput === undefined ? {} : { latestInput: prepared.latestInput }),
    inputFingerprint: stableFingerprint({
      modelVersion: FIRST_PARTY_PROJECTION_MODEL_VERSION,
      strategy,
      target,
      config,
      historyFingerprint: prepared.historyFingerprint,
    }),
  };
}

function emptyCoverage(): FirstPartyProjectionCoverage {
  return {
    playerGames: 0,
    recentPlayerGames: 0,
    positionGames: 0,
    opponentGames: 0,
    teamGames: 0,
    calibratedComponents: 0,
    fallbackComponents: 0,
  };
}

function emptyProjection(
  target: FirstPartyProjectionTarget,
  state: "zero" | "unavailable",
  qualityFlag: string,
  reason: string,
  training: readonly FirstPartyWeeklyStatLine[],
  config: FirstPartyProjectionConfig,
  strategy: FirstPartyProjectionStrategy = "first-party-model",
): FirstPartyWeeklyProjection {
  const position = normalizedPosition(target.position);
  const zeros =
    position === undefined
      ? {}
      : Object.fromEntries(POSITION_COMPONENTS[position].map((component) => [component, 0]));
  return {
    state,
    playerId: target.playerId,
    position: target.position,
    components: zeros,
    floorComponents: zeros,
    ceilingComponents: zeros,
    coverage: emptyCoverage(),
    quality: {
      grade: state === "zero" ? "low" : "unavailable",
      confidence: state === "zero" ? 0.98 : 0,
      degraded: state !== "zero",
      flags: [qualityFlag],
    },
    reasons: [reason],
    provenance: provenanceFor(target, training, config, strategy),
  };
}

function projectionQuality(
  playerGames: number,
  positionGames: number,
  opponentGames: number,
  fallbackComponents: number,
  componentCount: number,
  status: FirstPartyPlayerStatus | undefined,
  hasOpponent: boolean,
  usesOpponentContext = true,
): FirstPartyProjectionQuality {
  const flags: string[] = [];
  if (playerGames === 0) flags.push("position_prior_only");
  else if (playerGames < 3) flags.push("sparse_player_history");
  if (positionGames < 30) flags.push("thin_position_baseline");
  if (usesOpponentContext) {
    if (!hasOpponent) flags.push("schedule_opponent_missing");
    else if (opponentGames < 8) flags.push("thin_opponent_history");
  }
  if (fallbackComponents > 0) flags.push("uncertainty_fallback");
  if (status === "questionable") flags.push("questionable_status_discount");
  if (status === "doubtful") flags.push("doubtful_status_discount");

  const playerScore = clamp(playerGames / 8, 0, 1);
  const priorScore = clamp(positionGames / 100, 0, 1);
  const opponentScore = usesOpponentContext
    ? hasOpponent
      ? clamp(opponentGames / 24, 0, 1)
      : 0.25
    : 0.6;
  const calibrationScore = 1 - fallbackComponents / Math.max(1, componentCount);
  const confidence = clamp(
    0.1 + playerScore * 0.42 + priorScore * 0.18 + opponentScore * 0.1 + calibrationScore * 0.2,
    0,
    status === "doubtful" ? 0.45 : status === "questionable" ? 0.75 : 0.95,
  );
  const grade = confidence >= 0.75 ? "high" : confidence >= 0.5 ? "medium" : "low";
  return { grade, confidence, degraded: flags.length > 0, flags: [...new Set(flags)].sort() };
}

/**
 * Projects provider-neutral weekly stat components. Every training row is required to precede the
 * target week; same-week and future observations are discarded before any feature is calculated.
 */
export function projectFirstPartyWeeklyComponents(
  input: FirstPartyProjectionInput,
): FirstPartyWeeklyProjection {
  validateTarget(input.target);
  const config = resolvedConfig(input.config);
  const target = input.target;
  const prepared = prepareFirstPartyHistory(input.history);
  const allRowsArePrior = prepared.latestOrdinal < ordinal(target.season, target.week);
  const allPrior = allRowsArePrior
    ? prepared.eligible
    : prepared.eligible.filter((row) => strictlyBefore(row, target));
  const position = normalizedPosition(target.position);
  if (position === undefined) {
    return emptyProjection(
      target,
      "unavailable",
      "unsupported_position",
      "First-party weekly projections currently cover QB, RB, WR, TE, and K only.",
      allPrior,
      config,
    );
  }
  if (target.isBye === true || target.scheduled === false) {
    return emptyProjection(
      target,
      "unavailable",
      "no_scheduled_game",
      "No weekly projection is published when the schedule explicitly has no game.",
      allPrior,
      config,
    );
  }
  if (INACTIVE_STATUSES.has(target.status ?? "unknown")) {
    return emptyProjection(
      target,
      "zero",
      "confirmed_inactive",
      "The player's current status indicates that they will not play.",
      allPrior,
      config,
    );
  }

  const positionRows = allRowsArePrior
    ? (prepared.byPosition.get(position) ?? [])
    : allPrior.filter((row) => normalizedPosition(row.position) === position);
  const playerRows = (
    allRowsArePrior
      ? (prepared.byPlayer.get(target.playerId) ?? [])
      : allPrior.filter((row) => row.playerId === target.playerId)
  ).slice(-config.maxPlayerGames);
  const preparedOpponentRows = allRowsArePrior
    ? prepared.byPositionOpponent.get(position)?.get(target.opponent?.trim().toUpperCase() ?? "")
    : undefined;
  const components: Record<string, number> = {};
  const floors: Record<string, number> = {};
  const ceilings: Record<string, number> = {};
  let calibratedComponents = 0;
  let fallbackComponents = 0;
  let opponentGames = 0;
  let teamGames = 0;
  const targetOrdinal = ordinal(target.season, target.week);

  for (const component of POSITION_COMPONENTS[position]) {
    const playerMean = weightedComponentMean(
      playerRows,
      component,
      target,
      config.recencyHalfLifeWeeks,
    );
    const exactRoleValue = targetRoleValue(target.role, component);
    const roleBucket =
      exactRoleValue === undefined ? undefined : Math.round(clamp(exactRoleValue, 0, 1) * 10) / 10;
    const priorCacheKey = `${position}:${component}:${targetOrdinal}:${config.recencyHalfLifeWeeks}:${String(roleBucket ?? "none")}`;
    let priorMean = allRowsArePrior ? prepared.positionPriors.get(priorCacheKey) : undefined;
    if (priorMean === undefined) {
      priorMean = positionPriorMean(
        positionRows,
        component,
        target,
        config.recencyHalfLifeWeeks,
        roleBucket,
      );
      if (allRowsArePrior) prepared.positionPriors.set(priorCacheKey, priorMean);
    }
    const usablePlayerGames = playerRows.filter(
      (row) => componentValue(row, component) !== undefined,
    ).length;
    const reliability = usablePlayerGames / (usablePlayerGames + config.playerPriorGames);
    const shrunk = (playerMean ?? priorMean) * reliability + priorMean * (1 - reliability);
    const role = roleMultiplier(
      playerRows.length > 0 ? playerRows : positionRows,
      target,
      component,
      config.recencyHalfLifeWeeks,
    );
    const preparedTeamWeekKey = `${position}:${component}`;
    let preparedTeamWeeks = allRowsArePrior
      ? prepared.teamWeeks.get(preparedTeamWeekKey)
      : undefined;
    if (allRowsArePrior && preparedTeamWeeks === undefined) {
      preparedTeamWeeks = aggregateTeamWeeks(positionRows, component);
      prepared.teamWeeks.set(preparedTeamWeekKey, preparedTeamWeeks);
    }
    const teamCacheKey = `${position}:${component}:${targetOrdinal}:${config.recencyHalfLifeWeeks}:${config.teamPriorGames}:${target.team.trim().toUpperCase()}`;
    let team = allRowsArePrior ? prepared.teamMultipliers.get(teamCacheKey) : undefined;
    if (team === undefined) {
      team = learnedTeamMultiplier(positionRows, target, component, config, preparedTeamWeeks);
      if (allRowsArePrior) prepared.teamMultipliers.set(teamCacheKey, team);
    }
    const opponentCacheKey = `${position}:${component}:${targetOrdinal}:${config.recencyHalfLifeWeeks}:${config.opponentPriorGames}:${target.opponent?.trim().toUpperCase() ?? "none"}`;
    let opponent = allRowsArePrior ? prepared.opponentMultipliers.get(opponentCacheKey) : undefined;
    if (opponent === undefined) {
      opponent = learnedOpponentMultiplier(
        positionRows,
        target,
        component,
        config,
        preparedOpponentRows,
      );
      if (allRowsArePrior) prepared.opponentMultipliers.set(opponentCacheKey, opponent);
    }
    teamGames = Math.max(teamGames, team.samples);
    opponentGames = Math.max(opponentGames, opponent.samples);
    const projected =
      shrunk *
      role *
      team.multiplier *
      explicitTeamMultiplier(target, component) *
      opponent.multiplier *
      statusMultiplier(target.status);
    const center = clamp(projected, 0, capFor(component));
    const interval = intervalFor(
      input.calibration,
      position,
      component,
      positionRows,
      center,
      target,
      config,
    );
    if (interval.fallback) fallbackComponents += 1;
    else calibratedComponents += 1;
    components[component] = center;
    floors[component] = clamp(center + interval.lowerError, 0, center);
    ceilings[component] = clamp(center + interval.upperError, center, capFor(component));
  }

  const normalizedCenter = normalizedComponents(components, position);
  const normalizedFloor: Record<string, number> = {
    ...normalizedComponents(floors, position),
  };
  const normalizedCeiling: Record<string, number> = {
    ...normalizedComponents(ceilings, position),
  };
  for (const component of POSITION_COMPONENTS[position]) {
    normalizedFloor[component] = Math.min(
      normalizedFloor[component] ?? 0,
      normalizedCenter[component] ?? 0,
    );
    normalizedCeiling[component] = Math.max(
      normalizedCeiling[component] ?? 0,
      normalizedCenter[component] ?? 0,
    );
  }
  const recentPlayerGames = playerRows.filter(
    (row) => ordinal(target.season, target.week) - ordinal(row.season, row.week) <= 8,
  ).length;
  const coverage: FirstPartyProjectionCoverage = {
    playerGames: playerRows.length,
    recentPlayerGames,
    positionGames: positionRows.length,
    opponentGames,
    teamGames,
    calibratedComponents,
    fallbackComponents,
  };
  const quality = projectionQuality(
    playerRows.length,
    positionRows.length,
    opponentGames,
    fallbackComponents,
    POSITION_COMPONENTS[position].length,
    target.status,
    target.opponent !== undefined,
  );
  const reasons = [
    playerRows.length === 0
      ? "No prior player games were available; the forecast is anchored to a role-matched position prior."
      : `The player estimate uses ${playerRows.length} prior game${playerRows.length === 1 ? "" : "s"} with recency weighting and position-prior shrinkage.`,
    target.opponent === undefined
      ? "Opponent context was unavailable and therefore left neutral."
      : opponentGames === 0
        ? "The opponent sample was empty and therefore left neutral."
        : `Opponent context is shrunk toward neutral using ${opponentGames} prior position-game${opponentGames === 1 ? "" : "s"}.`,
    fallbackComponents === 0
      ? "All uncertainty bands use locked historical forecast residuals."
      : `${fallbackComponents} component uncertainty band${fallbackComponents === 1 ? " uses" : "s use"} a conservative historical-dispersion fallback.`,
  ];

  return {
    state: "projected",
    playerId: target.playerId,
    position,
    components: normalizedCenter,
    floorComponents: normalizedFloor,
    ceilingComponents: normalizedCeiling,
    coverage,
    quality,
    reasons,
    provenance: provenanceFor(target, allPrior, config),
  };
}

interface ResidualSample {
  readonly position: FirstPartyProjectionPosition;
  readonly component: string;
  readonly error: number;
}

function calibrationFromResiduals(
  residuals: readonly ResidualSample[],
  config: FirstPartyProjectionConfig,
  generatedThrough?: { readonly season: number; readonly week: number },
): FirstPartyProjectionCalibration {
  const intervals: Partial<
    Record<FirstPartyProjectionPosition, Record<string, FirstPartyCalibrationInterval>>
  > = {};
  for (const position of Object.keys(POSITION_COMPONENTS) as FirstPartyProjectionPosition[]) {
    const byComponent: Record<string, FirstPartyCalibrationInterval> = {};
    for (const component of POSITION_COMPONENTS[position]) {
      const errors = residuals
        .filter((sample) => sample.position === position && sample.component === component)
        .map((sample) => sample.error);
      if (errors.length === 0) continue;
      byComponent[component] = {
        samples: errors.length,
        lowerError: quantile(errors, config.lowerIntervalQuantile),
        upperError: quantile(errors, config.upperIntervalQuantile),
        mae: mean(errors.map((error) => Math.abs(error))),
        rmse: Math.sqrt(mean(errors.map((error) => error * error))),
        fallback: errors.length < config.minimumCalibrationSamples,
      };
    }
    if (Object.keys(byComponent).length > 0) intervals[position] = byComponent;
  }
  return {
    modelVersion: FIRST_PARTY_PROJECTION_MODEL_VERSION,
    ...(generatedThrough === undefined ? {} : { generatedThrough }),
    intervals,
  };
}

interface MetricSample {
  readonly position?: FirstPartyProjectionPosition;
  readonly component: string;
  readonly error: number;
  readonly covered: boolean;
}

function metricsFor(samples: readonly MetricSample[]): FirstPartyBacktestComponentMetrics {
  if (samples.length === 0) {
    return { samples: 0, mae: 0, rmse: 0, bias: 0, intervalCoverage: 0 };
  }
  return {
    samples: samples.length,
    mae: mean(samples.map((sample) => Math.abs(sample.error))),
    rmse: Math.sqrt(mean(samples.map((sample) => sample.error * sample.error))),
    bias: mean(samples.map((sample) => sample.error)),
    intervalCoverage: mean(samples.map((sample) => (sample.covered ? 1 : 0))),
  };
}

function recencyOnlyBaseline(
  position: FirstPartyProjectionPosition,
  target: FirstPartyProjectionTarget,
  trainingRows: readonly FirstPartyWeeklyStatLine[],
  config: FirstPartyProjectionConfig,
): ProjectionStatComponents {
  const prepared = prepareFirstPartyHistory(trainingRows);
  const positionRows = prepared.byPosition.get(position) ?? [];
  const playerRows = (prepared.byPlayer.get(target.playerId) ?? [])
    .filter((row) => normalizedPosition(row.position) === position)
    .slice(-config.maxPlayerGames);
  const components = Object.fromEntries(
    POSITION_COMPONENTS[position].map((component) => {
      const playerMean = weightedComponentMean(
        playerRows,
        component,
        target,
        config.recencyHalfLifeWeeks,
      );
      const positionMean = weightedComponentMean(
        positionRows,
        component,
        target,
        config.recencyHalfLifeWeeks,
      );
      // Kickers (weekly model v8): evidence-weighted blend toward the position mean instead of
      // the hard player-mean switch. A kicker's slot is binary — whoever holds it inherits the
      // team's kicking volume — so one or two games of personal history carry almost no signal
      // about next week's opportunity, yet the hard switch trusted a single debut game with full
      // weight. That collapsed centers for mid-season debut/replacement kickers (the ROS v7
      // Step 4 verdict's root cause). The blend reuses the contextual model's existing
      // reliability form and playerPriorGames constant verbatim — no new tunable constants, so
      // there is nothing to fit and nothing to leak. Other positions keep the hard switch
      // byte-for-byte: their role continuity genuinely is player-specific, and the transparent
      // baseline stays maximally simple where it is not measurably wrong.
      if (position === "K") {
        const usablePlayerGames = playerRows.filter(
          (row) => componentValue(row, component) !== undefined,
        ).length;
        const reliability = usablePlayerGames / (usablePlayerGames + config.playerPriorGames);
        const prior = positionMean ?? 0;
        const blended = (playerMean ?? prior) * reliability + prior * (1 - reliability);
        return [component, clamp(blended, 0, capFor(component))];
      }
      return [component, clamp(playerMean ?? positionMean ?? 0, 0, capFor(component))];
    }),
  );
  return normalizedComponents(components, position);
}

function statusAdjustedRecencyBaseline(
  position: FirstPartyProjectionPosition,
  target: FirstPartyProjectionTarget,
  trainingRows: readonly FirstPartyWeeklyStatLine[],
  config: FirstPartyProjectionConfig,
): ProjectionStatComponents {
  if (INACTIVE_STATUSES.has(target.status ?? "unknown")) {
    return Object.fromEntries(POSITION_COMPONENTS[position].map((component) => [component, 0]));
  }
  const baseline = recencyOnlyBaseline(position, target, trainingRows, config);
  return normalizedComponents(
    Object.fromEntries(
      POSITION_COMPONENTS[position].map((component) => [
        component,
        (baseline[component] ?? 0) * statusMultiplier(target.status),
      ]),
    ),
    position,
  );
}

/**
 * Projects the transparent recency-only challenger used by every publication gate. The function
 * deliberately shares the model's schedule/status semantics and strictly-prior history filter, so
 * selecting the safer champion never reintroduces a bye, inactive player, or target-week leak.
 */
export function projectFirstPartyRecencyBaselineComponents(
  input: FirstPartyProjectionInput,
): FirstPartyWeeklyProjection {
  validateTarget(input.target);
  const config = resolvedConfig(input.config);
  const target = input.target;
  const prepared = prepareFirstPartyHistory(input.history);
  const allRowsArePrior = prepared.latestOrdinal < ordinal(target.season, target.week);
  const allPrior = allRowsArePrior
    ? prepared.eligible
    : prepared.eligible.filter((row) => strictlyBefore(row, target));
  const position = normalizedPosition(target.position);
  if (position === undefined) {
    return emptyProjection(
      target,
      "unavailable",
      "unsupported_position",
      "First-party weekly projections currently cover QB, RB, WR, TE, and K only.",
      allPrior,
      config,
      "recency-only",
    );
  }
  if (target.isBye === true || target.scheduled === false) {
    return emptyProjection(
      target,
      "unavailable",
      "no_scheduled_game",
      "No weekly projection is published when the schedule explicitly has no game.",
      allPrior,
      config,
      "recency-only",
    );
  }
  if (INACTIVE_STATUSES.has(target.status ?? "unknown")) {
    return emptyProjection(
      target,
      "zero",
      "confirmed_inactive",
      "The player's current status indicates that they will not play.",
      allPrior,
      config,
      "recency-only",
    );
  }

  const positionRows = allRowsArePrior
    ? (prepared.byPosition.get(position) ?? [])
    : allPrior.filter((row) => normalizedPosition(row.position) === position);
  const playerRows = (
    allRowsArePrior
      ? (prepared.byPlayer.get(target.playerId) ?? [])
      : allPrior.filter((row) => row.playerId === target.playerId)
  )
    .filter((row) => normalizedPosition(row.position) === position)
    .slice(-config.maxPlayerGames);
  const center = statusAdjustedRecencyBaseline(position, target, allPrior, config);
  const floors: Record<string, number> = {};
  const ceilings: Record<string, number> = {};
  let calibratedComponents = 0;
  let fallbackComponents = 0;
  for (const component of POSITION_COMPONENTS[position]) {
    const value = center[component] ?? 0;
    const interval = intervalFor(
      input.calibration,
      position,
      component,
      positionRows,
      value,
      target,
      config,
    );
    if (interval.fallback) fallbackComponents += 1;
    else calibratedComponents += 1;
    floors[component] = clamp(value + interval.lowerError, 0, value);
    ceilings[component] = clamp(value + interval.upperError, value, capFor(component));
  }
  const normalizedFloor: Record<string, number> = {
    ...normalizedComponents(floors, position),
  };
  const normalizedCeiling: Record<string, number> = {
    ...normalizedComponents(ceilings, position),
  };
  for (const component of POSITION_COMPONENTS[position]) {
    normalizedFloor[component] = Math.min(normalizedFloor[component] ?? 0, center[component] ?? 0);
    normalizedCeiling[component] = Math.max(
      normalizedCeiling[component] ?? 0,
      center[component] ?? 0,
    );
  }
  const recentPlayerGames = playerRows.filter(
    (row) => ordinal(target.season, target.week) - ordinal(row.season, row.week) <= 8,
  ).length;
  const baseQuality = projectionQuality(
    playerRows.length,
    positionRows.length,
    0,
    fallbackComponents,
    POSITION_COMPONENTS[position].length,
    target.status,
    target.opponent !== undefined,
    false,
  );
  return {
    state: "projected",
    playerId: target.playerId,
    position,
    components: center,
    floorComponents: normalizedFloor,
    ceilingComponents: normalizedCeiling,
    coverage: {
      playerGames: playerRows.length,
      recentPlayerGames,
      positionGames: positionRows.length,
      opponentGames: 0,
      teamGames: 0,
      calibratedComponents,
      fallbackComponents,
    },
    quality: {
      ...baseQuality,
      flags: [...new Set([...baseQuality.flags, "recency_only_champion"])].sort(),
    },
    reasons: [
      playerRows.length === 0
        ? "The recency-only champion uses the recent position baseline because no prior player games were available."
        : `The recency-only champion uses ${playerRows.length} prior player game${playerRows.length === 1 ? "" : "s"} without opponent or team multipliers.`,
      "This challenger is selected unless the first-party model clears its locked MAE improvement margin.",
    ],
    provenance: provenanceFor(target, allPrior, config, "recency-only"),
  };
}

function isPriorFantasyRelevantBacktestTarget(
  row: FirstPartyWeeklyStatLine,
  trainingRows: readonly FirstPartyWeeklyStatLine[],
): boolean {
  const position = normalizedPosition(row.position);
  if (position === undefined) return false;
  const recent = (prepareFirstPartyHistory(trainingRows).byPlayer.get(row.playerId) ?? [])
    .filter((prior) => normalizedPosition(prior.position) === position)
    .filter((prior) => ordinal(row.season, row.week) - ordinal(prior.season, prior.week) <= 8)
    .slice(-4);
  if (recent.length === 0) return false;
  if (position === "QB") {
    return recent.some(
      (prior) =>
        (componentValue(prior, "passing_attempts") ?? 0) >= 5 ||
        (componentValue(prior, "carries") ?? 0) >= 1 ||
        (prior.snapShare ?? 0) >= 0.2,
    );
  }
  if (position === "RB" || position === "WR" || position === "TE") {
    return recent.some(
      (prior) =>
        (componentValue(prior, "targets") ?? 0) + (componentValue(prior, "carries") ?? 0) >= 1 ||
        (prior.snapShare ?? 0) >= 0.15,
    );
  }
  if (position === "K") {
    return recent.some(
      (prior) =>
        (componentValue(prior, "field_goals_attempted") ?? 0) +
          (componentValue(prior, "extra_points_attempted") ?? 0) >=
        1,
    );
  }
  return false;
}

/**
 * Runs an expanding-window simulation. Predictions and interval calibration for a target week use
 * only rows and errors from strictly earlier weeks. Same-week games are evaluated as one locked
 * batch, preventing Sunday results from leaking into a Monday projection.
 */
export function runFirstPartyProjectionBacktest(
  history: readonly FirstPartyWeeklyStatLine[],
  configInput?: Partial<FirstPartyProjectionConfig>,
): FirstPartyProjectionBacktest {
  const config = resolvedConfig(configInput);
  // Known DNP rows are valid forecast outcomes: a manager still needs the system to account for a
  // recently relevant player who unexpectedly records zero. They must not, however, be treated as
  // played games when fitting role and production history. Keeping the outcome population separate
  // from training rows prevents both optimistic survivorship bias and post-DNP role distortion.
  const observations = history
    .filter((row) => normalizedPosition(row.position) !== undefined)
    .sort(compareLines);
  const eligible = observations.filter(isTrainingLine);
  const weekKeys = [...new Set(observations.map((row) => ordinal(row.season, row.week)))]
    .sort((left, right) => left - right)
    .slice(-config.backtestEvaluationWeeks);
  const residuals: ResidualSample[] = [];
  const metricSamples: MetricSample[] = [];
  const predictions: FirstPartyBacktestPrediction[] = [];

  for (const weekKey of weekKeys) {
    const trainingRows = eligible.filter((row) => ordinal(row.season, row.week) < weekKey);
    const targetRows = observations.filter(
      (row) =>
        ordinal(row.season, row.week) === weekKey &&
        isPriorFantasyRelevantBacktestTarget(row, trainingRows),
    );
    const previousResiduals = [...residuals];
    const lastTrainingRow = trainingRows.at(-1);
    const previousCalibration = calibrationFromResiduals(
      previousResiduals,
      config,
      lastTrainingRow === undefined
        ? undefined
        : { season: lastTrainingRow.season, week: lastTrainingRow.week },
    );
    const weekResults: Array<{
      readonly prediction: FirstPartyBacktestPrediction;
      readonly residuals: readonly ResidualSample[];
      readonly metrics: readonly MetricSample[];
    }> = [];

    for (const actual of targetRows) {
      const position = normalizedPosition(actual.position);
      if (position === undefined) continue;
      const role = firstPartyRecentRoleContext(trainingRows, actual.playerId);
      // Weekly roster and historical injury releases do not consistently carry a trustworthy
      // pre-kickoff as-of timestamp. They define the realized outcome population, but must never
      // be presented to the retrospective forecast as if the final designation were known.
      const projection = projectFirstPartyWeeklyComponents({
        target: {
          playerId: actual.playerId,
          position,
          season: actual.season,
          week: actual.week,
          team: actual.team,
          ...(actual.opponent === undefined ? {} : { opponent: actual.opponent }),
          ...(role === undefined ? {} : { role }),
        },
        history: trainingRows,
        calibration: previousCalibration,
        config,
      });
      const baseline = statusAdjustedRecencyBaseline(
        position,
        {
          playerId: actual.playerId,
          position,
          season: actual.season,
          week: actual.week,
          team: actual.team,
          ...(actual.opponent === undefined ? {} : { opponent: actual.opponent }),
        },
        trainingRows,
        config,
      );
      const resultResiduals: ResidualSample[] = [];
      const resultMetrics: MetricSample[] = [];
      for (const component of POSITION_COMPONENTS[position]) {
        const actualValue = componentValue(actual, component);
        if (actualValue === undefined) continue;
        const predictedValue = projection.components[component] ?? 0;
        resultResiduals.push({
          position,
          component,
          error: actualValue - predictedValue,
        });
        resultMetrics.push({
          position,
          component,
          error: predictedValue - actualValue,
          covered:
            actualValue >= (projection.floorComponents[component] ?? 0) &&
            actualValue <= (projection.ceilingComponents[component] ?? 0),
        });
      }
      weekResults.push({
        prediction: {
          playerId: actual.playerId,
          position,
          season: actual.season,
          week: actual.week,
          predicted: projection.components,
          baseline,
          floor: projection.floorComponents,
          ceiling: projection.ceilingComponents,
          actual: Object.fromEntries(
            POSITION_COMPONENTS[position].map((component) => [
              component,
              componentValue(actual, component) ?? 0,
            ]),
          ),
          trainingRows: trainingRows.length,
          calibrationRows: previousResiduals.length,
        },
        residuals: resultResiduals,
        metrics: resultMetrics,
      });
    }

    for (const result of weekResults) {
      predictions.push(result.prediction);
      residuals.push(...result.residuals);
      metricSamples.push(...result.metrics);
    }
  }

  const metrics: Partial<
    Record<FirstPartyProjectionPosition, Record<string, FirstPartyBacktestComponentMetrics>>
  > = {};
  for (const position of Object.keys(POSITION_COMPONENTS) as FirstPartyProjectionPosition[]) {
    const byComponent: Record<string, FirstPartyBacktestComponentMetrics> = {};
    for (const component of POSITION_COMPONENTS[position]) {
      const samples = metricSamples.filter(
        (sample) => sample.position === position && sample.component === component,
      );
      if (samples.length > 0) byComponent[component] = metricsFor(samples);
    }
    if (Object.keys(byComponent).length > 0) metrics[position] = byComponent;
  }
  const last = eligible.at(-1);
  const firstPrediction = predictions[0];
  const lastPrediction = predictions.at(-1);
  return {
    modelVersion: FIRST_PARTY_PROJECTION_MODEL_VERSION,
    configuration: config,
    predictions,
    metrics,
    overall: metricsFor(metricSamples),
    calibration: calibrationFromResiduals(
      residuals,
      config,
      last === undefined ? undefined : { season: last.season, week: last.week },
    ),
    evaluation: {
      policy: "recent-fantasy-relevant",
      maximumWeekBatches: config.backtestEvaluationWeeks,
      completedWeekBatches: weekKeys.length,
      fantasyRelevantTargets: predictions.length,
      ...(firstPrediction === undefined
        ? {}
        : { firstEvaluated: { season: firstPrediction.season, week: firstPrediction.week } }),
      ...(lastPrediction === undefined
        ? {}
        : { lastEvaluated: { season: lastPrediction.season, week: lastPrediction.week } }),
    },
  };
}

interface ChampionErrorSamples {
  readonly model: number[];
  readonly baseline: number[];
  weekBatches: number;
}

function championChoice(
  samples: ChampionErrorSamples,
  minimumModelImprovement: number,
  minimumSamples: number,
  minimumWeekBatches: number,
): FirstPartyProjectionChampionChoice {
  const sampleCount = Math.min(samples.model.length, samples.baseline.length);
  const modelMae = mean(samples.model);
  const baselineMae = mean(samples.baseline);
  const modelImprovement =
    baselineMae === 0 ? (modelMae === 0 ? 0 : -1) : (baselineMae - modelMae) / baselineMae;
  const enoughSamples = sampleCount >= minimumSamples && samples.weekBatches >= minimumWeekBatches;
  const modelClearsMargin =
    enoughSamples && baselineMae > 0 && modelImprovement >= minimumModelImprovement;
  return {
    strategy: modelClearsMargin ? "first-party-model" : "recency-only",
    reason: !enoughSamples
      ? "insufficient-samples"
      : modelClearsMargin
        ? "model-cleared-margin"
        : "baseline-defended",
    samples: sampleCount,
    completedWeekBatches: samples.weekBatches,
    modelMae,
    baselineMae,
    modelImprovement,
  };
}

function policyFromChampionSamples(
  samplesByPosition: ReadonlyMap<FirstPartyProjectionPosition, ChampionErrorSamples>,
  scoringProfile: ProjectionScoringProfile,
  minimumModelImprovement: number,
  minimumSamples: number,
  minimumWeekBatches: number,
  generatedThrough?: { readonly season: number; readonly week: number },
): FirstPartyProjectionChampionPolicy {
  const byPosition: Partial<
    Record<FirstPartyProjectionPosition, FirstPartyProjectionChampionChoice>
  > = {};
  for (const position of Object.keys(POSITION_COMPONENTS) as FirstPartyProjectionPosition[]) {
    byPosition[position] = championChoice(
      samplesByPosition.get(position) ?? { model: [], baseline: [], weekBatches: 0 },
      minimumModelImprovement,
      minimumSamples,
      minimumWeekBatches,
    );
  }
  return {
    modelVersion: FIRST_PARTY_PROJECTION_MODEL_VERSION,
    scoringProfileKey: projectionScoringProfileKey(scoringProfile),
    minimumModelImprovement,
    minimumSamples,
    minimumWeekBatches,
    ...(generatedThrough === undefined ? {} : { generatedThrough }),
    byPosition,
  };
}

/** Returns the fail-safe live strategy; unknown/thin positions always defend recency-only. */
export function firstPartyChampionStrategyForPosition(
  policy: FirstPartyProjectionChampionPolicy,
  position: string,
): FirstPartyProjectionStrategy {
  const normalized = normalizedPosition(position);
  return normalized === undefined
    ? "recency-only"
    : (policy.byPosition[normalized]?.strategy ?? "recency-only");
}

function rebuiltChampionBacktest(
  source: FirstPartyProjectionBacktest,
  predictions: readonly FirstPartyBacktestPrediction[],
): FirstPartyProjectionBacktest {
  const residuals: ResidualSample[] = [];
  const metricSamples: MetricSample[] = [];
  for (const prediction of predictions) {
    for (const component of POSITION_COMPONENTS[prediction.position]) {
      const actual = prediction.actual[component];
      if (actual === undefined || !Number.isFinite(actual)) continue;
      const predicted = prediction.predicted[component] ?? 0;
      residuals.push({
        position: prediction.position,
        component,
        error: actual - predicted,
      });
      metricSamples.push({
        position: prediction.position,
        component,
        error: predicted - actual,
        covered:
          actual >= (prediction.floor[component] ?? 0) &&
          actual <= (prediction.ceiling[component] ?? 0),
      });
    }
  }
  const metrics: Partial<
    Record<FirstPartyProjectionPosition, Record<string, FirstPartyBacktestComponentMetrics>>
  > = {};
  for (const position of Object.keys(POSITION_COMPONENTS) as FirstPartyProjectionPosition[]) {
    const byComponent: Record<string, FirstPartyBacktestComponentMetrics> = {};
    for (const component of POSITION_COMPONENTS[position]) {
      const samples = metricSamples.filter(
        (sample) => sample.position === position && sample.component === component,
      );
      if (samples.length > 0) byComponent[component] = metricsFor(samples);
    }
    if (Object.keys(byComponent).length > 0) metrics[position] = byComponent;
  }
  const latest = predictions.at(-1);
  return {
    ...source,
    predictions,
    metrics,
    overall: metricsFor(metricSamples),
    calibration: calibrationFromResiduals(
      residuals,
      source.configuration,
      latest === undefined ? undefined : { season: latest.season, week: latest.week },
    ),
  };
}

/** Rebuilds locked forecasts using the final live strategy for each position. */
export function applyFirstPartyProjectionFinalPolicy(
  backtest: FirstPartyProjectionBacktest,
  policy: FirstPartyProjectionChampionPolicy,
): FirstPartyProjectionBacktest {
  if (
    backtest.modelVersion !== FIRST_PARTY_PROJECTION_MODEL_VERSION ||
    policy.modelVersion !== FIRST_PARTY_PROJECTION_MODEL_VERSION
  ) {
    throw new Error("Final champion policy does not match the current first-party model");
  }
  const applied = backtest.predictions.map((prediction) => {
    const predicted =
      firstPartyChampionStrategyForPosition(policy, prediction.position) === "first-party-model"
        ? prediction.predicted
        : prediction.baseline;
    return {
      ...prediction,
      predicted,
      floor: Object.fromEntries(
        POSITION_COMPONENTS[prediction.position].map((component) => [
          component,
          Math.min(prediction.floor[component] ?? 0, predicted[component] ?? 0),
        ]),
      ),
      ceiling: Object.fromEntries(
        POSITION_COMPONENTS[prediction.position].map((component) => [
          component,
          Math.max(prediction.ceiling[component] ?? 0, predicted[component] ?? 0),
        ]),
      ),
    } satisfies FirstPartyBacktestPrediction;
  });
  return rebuiltChampionBacktest(backtest, applied);
}

/**
 * Applies a walk-forward champion policy. A target week's candidate is chosen only from errors in
 * strictly earlier week batches; that week's results are added after every prediction is locked.
 * The returned live policy may then be used only for a target after `generatedThrough`.
 */
export function applyFirstPartyProjectionChampionPolicy(
  backtest: FirstPartyProjectionBacktest,
  scoringProfile: ProjectionScoringProfile,
  options: FirstPartyProjectionChampionOptions = {},
): FirstPartyProjectionChampionResult {
  if (backtest.modelVersion !== FIRST_PARTY_PROJECTION_MODEL_VERSION) {
    throw new Error("Backtest model version does not match the current first-party model");
  }
  const minimumModelImprovement =
    options.minimumModelImprovement ?? FIRST_PARTY_CHAMPION_MINIMUM_IMPROVEMENT;
  const minimumSamples = options.minimumSamples ?? FIRST_PARTY_CHAMPION_MINIMUM_SAMPLES;
  const minimumWeekBatches =
    options.minimumWeekBatches ?? FIRST_PARTY_CHAMPION_MINIMUM_WEEK_BATCHES;
  if (
    !Number.isFinite(minimumModelImprovement) ||
    minimumModelImprovement < 0 ||
    minimumModelImprovement > 1
  ) {
    throw new RangeError("minimumModelImprovement must be between zero and one");
  }
  if (!Number.isSafeInteger(minimumSamples) || minimumSamples <= 0) {
    throw new RangeError("minimumSamples must be a positive integer");
  }
  if (!Number.isSafeInteger(minimumWeekBatches) || minimumWeekBatches <= 0) {
    throw new RangeError("minimumWeekBatches must be a positive integer");
  }

  const ordered = [...backtest.predictions].sort(
    (left, right) =>
      ordinal(left.season, left.week) - ordinal(right.season, right.week) ||
      left.playerId.localeCompare(right.playerId),
  );
  const weekKeys = [
    ...new Set(ordered.map((prediction) => ordinal(prediction.season, prediction.week))),
  ];
  const samplesByPosition = new Map<FirstPartyProjectionPosition, ChampionErrorSamples>();
  const applied: FirstPartyBacktestPrediction[] = [];
  for (const weekKey of weekKeys) {
    const weekPredictions = ordered.filter(
      (prediction) => ordinal(prediction.season, prediction.week) === weekKey,
    );
    const choices = new Map<FirstPartyProjectionPosition, FirstPartyProjectionChampionChoice>();
    for (const position of Object.keys(POSITION_COMPONENTS) as FirstPartyProjectionPosition[]) {
      choices.set(
        position,
        championChoice(
          samplesByPosition.get(position) ?? { model: [], baseline: [], weekBatches: 0 },
          minimumModelImprovement,
          minimumSamples,
          minimumWeekBatches,
        ),
      );
    }
    for (const prediction of weekPredictions) {
      const choice = choices.get(prediction.position);
      const predicted =
        choice?.strategy === "first-party-model" ? prediction.predicted : prediction.baseline;
      applied.push({
        ...prediction,
        predicted,
        floor: Object.fromEntries(
          POSITION_COMPONENTS[prediction.position].map((component) => [
            component,
            Math.min(prediction.floor[component] ?? 0, predicted[component] ?? 0),
          ]),
        ),
        ceiling: Object.fromEntries(
          POSITION_COMPONENTS[prediction.position].map((component) => [
            component,
            Math.max(prediction.ceiling[component] ?? 0, predicted[component] ?? 0),
          ]),
        ),
      });
    }
    // Update after the whole batch: Sunday outcomes cannot choose a different champion for Monday.
    for (const prediction of weekPredictions) {
      const samples = samplesByPosition.get(prediction.position) ?? {
        model: [],
        baseline: [],
        weekBatches: 0,
      };
      const actualPoints = scoreProjectionStatComponents(prediction.actual, scoringProfile);
      samples.model.push(
        Math.abs(
          actualPoints - scoreProjectionStatComponents(prediction.predicted, scoringProfile),
        ),
      );
      samples.baseline.push(
        Math.abs(actualPoints - scoreProjectionStatComponents(prediction.baseline, scoringProfile)),
      );
      samplesByPosition.set(prediction.position, samples);
    }
    for (const position of new Set(weekPredictions.map((prediction) => prediction.position))) {
      const samples = samplesByPosition.get(position);
      if (samples !== undefined) samples.weekBatches += 1;
    }
  }
  const latest = ordered.at(-1);
  return {
    backtest: rebuiltChampionBacktest(backtest, applied),
    policy: policyFromChampionSamples(
      samplesByPosition,
      scoringProfile,
      minimumModelImprovement,
      minimumSamples,
      minimumWeekBatches,
      latest === undefined ? undefined : { season: latest.season, week: latest.week },
    ),
  };
}

interface ScoredResidualSample {
  readonly playerId: string;
  readonly position?: FirstPartyProjectionPosition;
  readonly season: number;
  readonly week: number;
  readonly rawError: number;
  readonly rawBaselineError: number;
  readonly error: number;
  readonly squaredError: number;
  readonly absoluteError: number;
  readonly baselineAbsoluteError: number;
  readonly intervalCovered?: boolean;
}

const POINT_CENTER_ADJUSTMENT_WEEK_BATCHES = 8;

function recentPointSamples(
  samples: readonly ScoredResidualSample[],
  weekBatches = POINT_CENTER_ADJUSTMENT_WEEK_BATCHES,
): readonly ScoredResidualSample[] {
  const weekKeys = [...new Set(samples.map((sample) => ordinal(sample.season, sample.week)))]
    .sort((left, right) => left - right)
    .slice(-weekBatches);
  const selected = new Set(weekKeys);
  return samples.filter((sample) => selected.has(ordinal(sample.season, sample.week)));
}

function pointResidualSummary(
  samples: readonly ScoredResidualSample[],
  lowerQuantile: number,
  upperQuantile: number,
): FirstPartyPointResidualCalibration {
  if (samples.length === 0) {
    return {
      samples: 0,
      centerAdjustment: 0,
      lowerError: 0,
      upperError: 0,
      mae: 0,
      rmse: 0,
      bias: 0,
      baselineMae: 0,
      improvement: 0,
      beatsBaseline: false,
      intervalCoverage: null,
      intervalCoverageSamples: 0,
    };
  }
  const errors = samples.map((sample) => sample.error);
  const recentRawErrors = recentPointSamples(samples).map((sample) => sample.rawError);
  const mae = mean(samples.map((sample) => sample.absoluteError));
  const baselineMae = mean(samples.map((sample) => sample.baselineAbsoluteError));
  const covered = samples.filter(
    (sample): sample is ScoredResidualSample & { readonly intervalCovered: boolean } =>
      sample.intervalCovered !== undefined,
  );
  return {
    samples: samples.length,
    centerAdjustment: mean(recentRawErrors),
    lowerError: quantile(errors, lowerQuantile),
    upperError: quantile(errors, upperQuantile),
    mae,
    rmse: Math.sqrt(mean(samples.map((sample) => sample.squaredError))),
    bias: mean(errors),
    baselineMae,
    improvement: baselineMae === 0 ? (mae === 0 ? 0 : -1) : (baselineMae - mae) / baselineMae,
    beatsBaseline: mae < baselineMae,
    intervalCoverage:
      covered.length === 0 ? null : mean(covered.map((sample) => (sample.intervalCovered ? 1 : 0))),
    intervalCoverageSamples: covered.length,
  };
}

/**
 * Scores a locked component backtest for one league profile. Point residuals are calibrated here,
 * after scoring, because raw lower/upper component bounds are not fantasy-point intervals when a
 * league assigns negative or tiered value to a component.
 */
export function evaluateFirstPartyBacktestForScoringProfile(
  backtest: FirstPartyProjectionBacktest,
  scoringProfile: ProjectionScoringProfile,
  options: FirstPartyScoredBacktestOptions = {},
): FirstPartyScoredBacktestEvaluation {
  if (backtest.modelVersion !== FIRST_PARTY_PROJECTION_MODEL_VERSION) {
    throw new Error("Backtest model version does not match the current first-party model");
  }
  const minimumIntervalSamples = options.minimumIntervalSamples ?? 24;
  const minimumPlayerSamples = options.minimumPlayerSamples ?? 24;
  const lowerQuantile = options.lowerIntervalQuantile ?? 0.15;
  const upperQuantile = options.upperIntervalQuantile ?? 0.85;
  if (!Number.isSafeInteger(minimumIntervalSamples) || minimumIntervalSamples <= 0) {
    throw new RangeError("minimumIntervalSamples must be a positive integer");
  }
  if (!Number.isSafeInteger(minimumPlayerSamples) || minimumPlayerSamples <= 0) {
    throw new RangeError("minimumPlayerSamples must be a positive integer");
  }
  if (lowerQuantile < 0 || upperQuantile > 1 || lowerQuantile >= upperQuantile) {
    throw new RangeError("point residual quantiles must be ordered within zero and one");
  }

  const scored = backtest.predictions
    .map((prediction) => {
      const actual = scoreProjectionStatComponents(prediction.actual, scoringProfile);
      const projected = scoreProjectionStatComponents(prediction.predicted, scoringProfile);
      const baseline = scoreProjectionStatComponents(prediction.baseline, scoringProfile);
      const rawError = actual - projected;
      const rawBaselineError = actual - baseline;
      return {
        playerId: prediction.playerId,
        position: prediction.position,
        season: prediction.season,
        week: prediction.week,
        rawError,
        rawBaselineError,
        error: rawError,
        squaredError: rawError * rawError,
        absoluteError: Math.abs(rawError),
        baselineAbsoluteError: Math.abs(rawBaselineError),
      } satisfies ScoredResidualSample;
    })
    .sort(
      (left, right) =>
        ordinal(left.season, left.week) - ordinal(right.season, right.week) ||
        left.playerId.localeCompare(right.playerId),
    );

  const withCoverage: ScoredResidualSample[] = [];
  const weekKeys = [...new Set(scored.map((sample) => ordinal(sample.season, sample.week)))].sort(
    (left, right) => left - right,
  );
  const priorRawByPosition = new Map<FirstPartyProjectionPosition, ScoredResidualSample[]>();
  const priorAdjustedByPosition = new Map<FirstPartyProjectionPosition, number[]>();
  for (const weekKey of weekKeys) {
    const weekSamples = scored.filter((sample) => ordinal(sample.season, sample.week) === weekKey);
    const adjustedWeekSamples: ScoredResidualSample[] = [];
    const centerByPosition = new Map<
      FirstPartyProjectionPosition,
      { readonly model: number; readonly baseline: number }
    >();
    for (const position of new Set(weekSamples.map((sample) => sample.position))) {
      const recentRawSamples = recentPointSamples(priorRawByPosition.get(position) ?? []);
      centerByPosition.set(position, {
        model:
          recentRawSamples.length < minimumIntervalSamples
            ? 0
            : mean(recentRawSamples.map((prior) => prior.rawError)),
        baseline:
          recentRawSamples.length < minimumIntervalSamples
            ? 0
            : mean(recentRawSamples.map((prior) => prior.rawBaselineError)),
      });
    }
    for (const sample of weekSamples) {
      const priorAdjustedErrors = priorAdjustedByPosition.get(sample.position) ?? [];
      const center = centerByPosition.get(sample.position) ?? { model: 0, baseline: 0 };
      const centerAdjustment = center.model;
      const baselineCenterAdjustment = center.baseline;
      const error = sample.rawError - centerAdjustment;
      const baselineError = sample.rawBaselineError - baselineCenterAdjustment;
      const adjustedSample: ScoredResidualSample = {
        ...sample,
        error,
        squaredError: error * error,
        absoluteError: Math.abs(error),
        baselineAbsoluteError: Math.abs(baselineError),
        ...(priorAdjustedErrors.length < minimumIntervalSamples
          ? {}
          : {
              intervalCovered:
                error >= quantile(priorAdjustedErrors, lowerQuantile) &&
                error <= quantile(priorAdjustedErrors, upperQuantile),
            }),
      };
      withCoverage.push(adjustedSample);
      adjustedWeekSamples.push(adjustedSample);
    }
    for (const sample of adjustedWeekSamples) {
      if (sample.position === undefined) continue;
      const priorRawSamples = priorRawByPosition.get(sample.position) ?? [];
      const priorAdjustedErrors = priorAdjustedByPosition.get(sample.position) ?? [];
      priorRawSamples.push(sample);
      priorAdjustedErrors.push(sample.error);
      priorRawByPosition.set(sample.position, priorRawSamples);
      priorAdjustedByPosition.set(sample.position, priorAdjustedErrors);
    }
  }

  const byPosition: Partial<
    Record<FirstPartyProjectionPosition, FirstPartyPointResidualCalibration>
  > = {};
  for (const position of Object.keys(POSITION_COMPONENTS) as FirstPartyProjectionPosition[]) {
    const samples = withCoverage.filter((sample) => sample.position === position);
    if (samples.length > 0) {
      byPosition[position] = pointResidualSummary(samples, lowerQuantile, upperQuantile);
    }
  }
  const playerIds = [...new Set(withCoverage.map((sample) => sample.playerId))].sort();
  const byPlayer: Record<string, FirstPartyPointResidualCalibration> = {};
  for (const playerId of playerIds) {
    const samples = withCoverage.filter((sample) => sample.playerId === playerId);
    if (samples.length >= minimumPlayerSamples) {
      byPlayer[playerId] = pointResidualSummary(samples, lowerQuantile, upperQuantile);
    }
  }
  const latest = scored.at(-1);
  return {
    modelVersion: FIRST_PARTY_PROJECTION_MODEL_VERSION,
    scoringProfileKey: projectionScoringProfileKey(scoringProfile),
    baseline: "recency-only",
    ...(latest === undefined
      ? {}
      : { generatedThrough: { season: latest.season, week: latest.week } }),
    byPosition,
    byPlayer,
    overall: pointResidualSummary(withCoverage, lowerQuantile, upperQuantile),
  };
}

export function firstPartyProjectionPositionIsSupported(position: string): boolean {
  return normalizedPosition(position) !== undefined;
}

export function firstPartyProjectionComponentsForPosition(position: string): readonly string[] {
  const normalized = normalizedPosition(position);
  return normalized === undefined ? [] : POSITION_COMPONENTS[normalized];
}

export function firstPartyTeamDefenseProjectionComponents(): readonly string[] {
  return TEAM_DEFENSE_COMPONENTS;
}

function defenseOrdinal(row: Pick<FirstPartyTeamDefenseWeeklyStatLine, "season" | "week">): number {
  return ordinal(row.season, row.week);
}

function compareDefenseLines(
  left: FirstPartyTeamDefenseWeeklyStatLine,
  right: FirstPartyTeamDefenseWeeklyStatLine,
): number {
  return defenseOrdinal(left) - defenseOrdinal(right) || left.team.localeCompare(right.team);
}

function defenseComponentValue(
  row: FirstPartyTeamDefenseWeeklyStatLine,
  component: string,
): number | undefined {
  const value = row.components[component];
  if (value !== undefined) {
    return !Number.isFinite(value) || value < 0 ? undefined : value;
  }
  const bucket = TEAM_DEFENSE_POINTS_ALLOWED_BUCKETS.find(
    (candidate) => candidate.component === component,
  );
  if (bucket !== undefined) {
    const pointsAllowed = row.components.points_allowed;
    if (pointsAllowed === undefined || !Number.isFinite(pointsAllowed) || pointsAllowed < 0) {
      return undefined;
    }
    return pointsAllowed >= bucket.minimum && pointsAllowed <= bucket.maximum ? 1 : 0;
  }
  const yardBucket = TEAM_DEFENSE_YARDS_ALLOWED_BUCKETS.find(
    (candidate) => candidate.component === component,
  );
  if (yardBucket === undefined) return undefined;
  const yardsAllowed = row.components.yards_allowed;
  if (yardsAllowed === undefined || !Number.isFinite(yardsAllowed) || yardsAllowed < 0) {
    return undefined;
  }
  return yardsAllowed >= yardBucket.minimum && yardsAllowed <= yardBucket.maximum ? 1 : 0;
}

function defenseRecencyWeight(
  row: Pick<FirstPartyTeamDefenseWeeklyStatLine, "season" | "week">,
  target: FirstPartyTeamDefenseTarget,
  halfLife: number,
): number {
  const distance = Math.max(1, ordinal(target.season, target.week) - defenseOrdinal(row));
  return 0.5 ** (distance / halfLife);
}

function weightedDefenseMean(
  rows: readonly FirstPartyTeamDefenseWeeklyStatLine[],
  component: string,
  target: FirstPartyTeamDefenseTarget,
  halfLife: number,
): number | undefined {
  return weightedMean(
    rows.flatMap((row) => {
      const value = defenseComponentValue(row, component);
      return value === undefined
        ? []
        : [{ value, weight: defenseRecencyWeight(row, target, halfLife) }];
    }),
  );
}

function defenseContextMultiplier(target: FirstPartyTeamDefenseTarget, component: string): number {
  const context = target.context;
  if (component === "defensive_sacks" || component === "defensive_blocked_kicks") {
    return clamp(finiteOrUndefined(context?.pressureMultiplier) ?? 1, 0.7, 1.35);
  }
  if (component === "defensive_interceptions" || component === "defensive_fumble_recoveries") {
    return clamp(finiteOrUndefined(context?.turnoverMultiplier) ?? 1, 0.7, 1.35);
  }
  if (component === "defensive_touchdowns" || component === "special_teams_touchdowns") {
    return clamp(finiteOrUndefined(context?.touchdownMultiplier) ?? 1, 0.65, 1.4);
  }
  if (component === "points_allowed") {
    return clamp(finiteOrUndefined(context?.pointsAllowedMultiplier) ?? 1, 0.7, 1.35);
  }
  if (component === "yards_allowed") {
    return clamp(finiteOrUndefined(context?.yardsAllowedMultiplier) ?? 1, 0.7, 1.35);
  }
  return 1;
}

function defenseFallbackInterval(
  rows: readonly FirstPartyTeamDefenseWeeklyStatLine[],
  component: string,
  center: number,
  target: FirstPartyTeamDefenseTarget,
  config: FirstPartyProjectionConfig,
): FirstPartyCalibrationInterval {
  const values = rows
    .map((row) => defenseComponentValue(row, component))
    .filter((value): value is number => value !== undefined);
  const historicalCenter = weightedDefenseMean(
    rows,
    component,
    target,
    config.recencyHalfLifeWeeks,
  );
  const dispersion =
    values.length > 1 && historicalCenter !== undefined
      ? Math.sqrt(mean(values.map((value) => (value - historicalCenter) ** 2)))
      : Math.max(component.includes("touchdowns") ? 0.5 : 1, center * 0.4);
  const spread = Math.max(component.includes("touchdowns") ? 0.65 : 0.5, dispersion * 1.05);
  return {
    samples: values.length,
    lowerError: -spread,
    upperError: spread,
    mae: spread / 1.25,
    rmse: spread,
    fallback: true,
  };
}

function defenseIntervalFor(
  calibration: FirstPartyTeamDefenseCalibration | undefined,
  component: string,
  rows: readonly FirstPartyTeamDefenseWeeklyStatLine[],
  center: number,
  target: FirstPartyTeamDefenseTarget,
  config: FirstPartyProjectionConfig,
): FirstPartyCalibrationInterval {
  const interval = calibration?.intervals[component];
  const generatedThrough = calibration?.generatedThrough;
  const calibrationIsPrior =
    generatedThrough !== undefined &&
    ordinal(generatedThrough.season, generatedThrough.week) < ordinal(target.season, target.week);
  return calibration?.modelVersion === FIRST_PARTY_PROJECTION_MODEL_VERSION &&
    calibrationIsPrior &&
    interval !== undefined &&
    interval.samples >= config.minimumCalibrationSamples
    ? interval
    : defenseFallbackInterval(rows, component, center, target, config);
}

function defenseProvenance(
  target: FirstPartyTeamDefenseTarget,
  training: readonly FirstPartyTeamDefenseWeeklyStatLine[],
  config: FirstPartyProjectionConfig,
): FirstPartyTeamDefenseProjection["provenance"] {
  const latest = [...training].sort(compareDefenseLines).at(-1);
  const trainingCutoff =
    latest === undefined
      ? { season: target.season - 1, week: 18 }
      : { season: latest.season, week: latest.week };
  return {
    modelVersion: FIRST_PARTY_PROJECTION_MODEL_VERSION,
    independenceKey: "laces-out-first-party-defense",
    target: { season: target.season, week: target.week },
    trainingCutoff,
    ...(latest === undefined ? {} : { latestInput: { season: latest.season, week: latest.week } }),
    inputFingerprint: stableFingerprint({
      modelVersion: FIRST_PARTY_PROJECTION_MODEL_VERSION,
      target,
      config,
      training: training.map((row) => ({
        ...row,
        components: Object.fromEntries(
          Object.entries(row.components).sort(([left], [right]) => left.localeCompare(right)),
        ),
      })),
    }),
  };
}

function unavailableDefenseProjection(
  target: FirstPartyTeamDefenseTarget,
  training: readonly FirstPartyTeamDefenseWeeklyStatLine[],
  config: FirstPartyProjectionConfig,
): FirstPartyTeamDefenseProjection {
  const zeros = Object.fromEntries(TEAM_DEFENSE_COMPONENTS.map((component) => [component, 0]));
  return {
    state: "unavailable",
    team: target.team,
    components: zeros,
    lowerComponents: zeros,
    upperComponents: zeros,
    coverage: {
      teamGames: 0,
      opponentGames: 0,
      leagueGames: 0,
      calibratedComponents: 0,
      fallbackComponents: 0,
    },
    quality: {
      grade: "unavailable",
      confidence: 0,
      degraded: true,
      flags: ["no_scheduled_game"],
    },
    reasons: ["No team-defense projection is published when the schedule has no game."],
    provenance: defenseProvenance(target, training, config),
  };
}

/** Projects team-defense raw components from explicitly team-scoped history. */
export function projectFirstPartyTeamDefenseComponents(
  input: FirstPartyTeamDefenseProjectionInput,
): FirstPartyTeamDefenseProjection {
  const target = input.target;
  if (target.team.trim().length === 0) throw new TypeError("defense target team must not be empty");
  assertPositiveInteger(target.season, "defense target season");
  assertPositiveInteger(target.week, "defense target week");
  const config = resolvedConfig(input.config);
  const training = input.history
    .filter(
      (row) => defenseOrdinal(row) < ordinal(target.season, target.week) && row.played !== false,
    )
    .sort(compareDefenseLines);
  if (target.isBye === true || target.scheduled === false) {
    return unavailableDefenseProjection(target, training, config);
  }

  const targetTeam = target.team.trim().toUpperCase();
  const opponent = target.opponent?.trim().toUpperCase();
  const teamRows = training
    .filter((row) => row.team.trim().toUpperCase() === targetTeam)
    .slice(-config.maxPlayerGames);
  const opponentRows =
    opponent === undefined
      ? []
      : training.filter((row) => row.opponent?.trim().toUpperCase() === opponent);
  const components: Record<string, number> = {};
  const lower: Record<string, number> = {};
  const upper: Record<string, number> = {};
  let calibratedComponents = 0;
  let fallbackComponents = 0;

  for (const component of TEAM_DEFENSE_MODELED_COMPONENTS) {
    const teamMean = weightedDefenseMean(teamRows, component, target, config.recencyHalfLifeWeeks);
    const leagueMean =
      weightedDefenseMean(training, component, target, config.recencyHalfLifeWeeks) ?? 0;
    const teamSamples = teamRows.filter(
      (row) => defenseComponentValue(row, component) !== undefined,
    ).length;
    const teamReliability = teamSamples / (teamSamples + config.playerPriorGames);
    const shrunk = (teamMean ?? leagueMean) * teamReliability + leagueMean * (1 - teamReliability);
    const opponentMean = weightedDefenseMean(
      opponentRows,
      component,
      target,
      config.recencyHalfLifeWeeks,
    );
    const opponentReliability =
      opponentRows.length / (opponentRows.length + config.opponentPriorGames);
    const opponentMultiplier =
      opponentMean === undefined || leagueMean <= 0
        ? 1
        : clamp(1 + (opponentMean / leagueMean - 1) * opponentReliability, 0.82, 1.18);
    const center = clamp(
      shrunk * opponentMultiplier * defenseContextMultiplier(target, component),
      0,
      capFor(component),
    );
    const interval = defenseIntervalFor(
      input.calibration,
      component,
      training,
      center,
      target,
      config,
    );
    if (interval.fallback) fallbackComponents += 1;
    else calibratedComponents += 1;
    components[component] = center;
    lower[component] = clamp(center + interval.lowerError, 0, center);
    upper[component] = clamp(center + interval.upperError, center, capFor(component));
  }

  deriveTeamDefensePointBuckets(components, training, target, config);
  deriveTeamDefenseYardBuckets(components, training, target, config);
  for (const bucket of [
    ...TEAM_DEFENSE_POINTS_ALLOWED_BUCKETS,
    ...TEAM_DEFENSE_YARDS_ALLOWED_BUCKETS,
  ]) {
    const normalizedProbability = components[bucket.component] ?? 0;
    components[bucket.component] = normalizedProbability;
    lower[bucket.component] = Math.min(lower[bucket.component] ?? 0, normalizedProbability);
    upper[bucket.component] = Math.max(upper[bucket.component] ?? 0, normalizedProbability);
  }
  // Emitted last so component key order stays exactly `TEAM_DEFENSE_COMPONENTS`. The band is
  // degenerate on purpose: a constant has no forecast error to bound.
  applyTeamDefenseDeMinimisZeros(components, lower, upper);

  const flags: string[] = [];
  if (teamRows.length === 0) flags.push("league_prior_only");
  else if (teamRows.length < 4) flags.push("sparse_team_history");
  if (training.length < 64) flags.push("thin_league_baseline");
  if (opponent === undefined) flags.push("schedule_opponent_missing");
  else if (opponentRows.length < 8) flags.push("thin_opponent_history");
  if (fallbackComponents > 0) flags.push("uncertainty_fallback");
  const confidence = clamp(
    0.08 +
      clamp(teamRows.length / 8, 0, 1) * 0.46 +
      clamp(training.length / 160, 0, 1) * 0.2 +
      clamp(opponentRows.length / 24, 0, 1) * 0.1 +
      (1 - fallbackComponents / TEAM_DEFENSE_MODELED_COMPONENTS.length) * 0.16,
    0,
    0.95,
  );

  return {
    state: "projected",
    team: target.team,
    components,
    lowerComponents: lower,
    upperComponents: upper,
    coverage: {
      teamGames: teamRows.length,
      opponentGames: opponentRows.length,
      leagueGames: training.length,
      calibratedComponents,
      fallbackComponents,
    },
    quality: {
      grade: confidence >= 0.75 ? "high" : confidence >= 0.5 ? "medium" : "low",
      confidence,
      degraded: flags.length > 0,
      flags: [...new Set(flags)].sort(),
    },
    reasons: [
      teamRows.length === 0
        ? "No prior team games were available; the forecast is anchored to the league defense prior."
        : `The team estimate uses ${teamRows.length} prior game${teamRows.length === 1 ? "" : "s"} with recency weighting and league-prior shrinkage.`,
      opponentRows.length === 0
        ? "Opponent offense context was unavailable and therefore left neutral."
        : `Opponent offense context is shrunk toward neutral using ${opponentRows.length} prior matchup${opponentRows.length === 1 ? "" : "s"}.`,
      fallbackComponents === 0
        ? "All raw uncertainty bands use locked historical forecast residuals."
        : `${fallbackComponents} raw component band${fallbackComponents === 1 ? " uses" : "s use"} a conservative historical-dispersion fallback.`,
    ],
    provenance: defenseProvenance(target, training, config),
  };
}

interface DefenseResidualSample {
  readonly component: string;
  readonly error: number;
}

function defenseCalibrationFromResiduals(
  residuals: readonly DefenseResidualSample[],
  config: FirstPartyProjectionConfig,
  generatedThrough?: { readonly season: number; readonly week: number },
): FirstPartyTeamDefenseCalibration {
  const intervals: Record<string, FirstPartyCalibrationInterval> = {};
  // Modeled components only: the de minimis constants produce no residuals, so an interval for one
  // would describe nothing.
  for (const component of TEAM_DEFENSE_MODELED_COMPONENTS) {
    const errors = residuals
      .filter((sample) => sample.component === component)
      .map((sample) => sample.error);
    if (errors.length === 0) continue;
    intervals[component] = {
      samples: errors.length,
      lowerError: quantile(errors, config.lowerIntervalQuantile),
      upperError: quantile(errors, config.upperIntervalQuantile),
      mae: mean(errors.map((error) => Math.abs(error))),
      rmse: Math.sqrt(mean(errors.map((error) => error * error))),
      fallback: errors.length < config.minimumCalibrationSamples,
    };
  }
  return {
    modelVersion: FIRST_PARTY_PROJECTION_MODEL_VERSION,
    ...(generatedThrough === undefined ? {} : { generatedThrough }),
    intervals,
  };
}

function recencyOnlyDefenseBaseline(
  target: FirstPartyTeamDefenseTarget,
  trainingRows: readonly FirstPartyTeamDefenseWeeklyStatLine[],
  config: FirstPartyProjectionConfig,
): ProjectionStatComponents {
  const targetTeam = target.team.trim().toUpperCase();
  const teamRows = trainingRows
    .filter((row) => row.team.trim().toUpperCase() === targetTeam)
    .slice(-config.maxPlayerGames);
  const components: Record<string, number> = {};
  for (const component of TEAM_DEFENSE_MODELED_COMPONENTS) {
    components[component] = clamp(
      weightedDefenseMean(teamRows, component, target, config.recencyHalfLifeWeeks) ??
        weightedDefenseMean(trainingRows, component, target, config.recencyHalfLifeWeeks) ??
        0,
      0,
      capFor(component),
    );
  }
  deriveTeamDefensePointBuckets(components, trainingRows, target, config);
  deriveTeamDefenseYardBuckets(components, trainingRows, target, config);
  // The baseline prices the same vocabulary as the champion, constants included, so a league profile
  // scoring 206/209 cannot make the two lines differ by so much as a rule.
  applyTeamDefenseDeMinimisZeros(components);
  return components;
}

/**
 * Public, strictly-prior D/ST challenger used by the ROS walk-forward rail. Keeping this adapter
 * beside the weekly backtest prevents historical validators from reimplementing a subtly
 * different baseline.
 */
export function projectFirstPartyTeamDefenseRecencyBaselineComponents(
  input: Pick<FirstPartyTeamDefenseProjectionInput, "target" | "history" | "config">,
): ProjectionStatComponents {
  const target = input.target;
  if (target.team.trim().length === 0) throw new TypeError("defense target team must not be empty");
  assertPositiveInteger(target.season, "defense target season");
  assertPositiveInteger(target.week, "defense target week");
  if (target.isBye === true || target.scheduled === false) {
    return Object.fromEntries(TEAM_DEFENSE_COMPONENTS.map((component) => [component, 0]));
  }
  const config = resolvedConfig(input.config);
  const training = input.history
    .filter(
      (row) => defenseOrdinal(row) < ordinal(target.season, target.week) && row.played !== false,
    )
    .sort(compareDefenseLines);
  return recencyOnlyDefenseBaseline(target, training, config);
}

/** Runs a same-week-locked expanding-window team-defense backtest. */
export function runFirstPartyTeamDefenseBacktest(
  history: readonly FirstPartyTeamDefenseWeeklyStatLine[],
  configInput?: Partial<FirstPartyProjectionConfig>,
): FirstPartyTeamDefenseBacktest {
  const config = resolvedConfig(configInput);
  const eligible = history.filter((row) => row.played !== false).sort(compareDefenseLines);
  const weekKeys = [...new Set(eligible.map(defenseOrdinal))].sort((left, right) => left - right);
  const residuals: DefenseResidualSample[] = [];
  const metricSamples: MetricSample[] = [];
  const predictions: FirstPartyTeamDefenseBacktestPrediction[] = [];

  for (const weekKey of weekKeys) {
    const targetRows = eligible.filter((row) => defenseOrdinal(row) === weekKey);
    const trainingRows = eligible.filter((row) => defenseOrdinal(row) < weekKey);
    const priorResiduals = [...residuals];
    const lastTrainingRow = trainingRows.at(-1);
    const calibration = defenseCalibrationFromResiduals(
      priorResiduals,
      config,
      lastTrainingRow === undefined
        ? undefined
        : { season: lastTrainingRow.season, week: lastTrainingRow.week },
    );
    const weekResiduals: DefenseResidualSample[] = [];
    for (const actual of targetRows) {
      const projection = projectFirstPartyTeamDefenseComponents({
        target: {
          team: actual.team,
          season: actual.season,
          week: actual.week,
          ...(actual.opponent === undefined ? {} : { opponent: actual.opponent }),
        },
        history: trainingRows,
        calibration,
        config,
      });
      const baseline = recencyOnlyDefenseBaseline(
        {
          team: actual.team,
          season: actual.season,
          week: actual.week,
          ...(actual.opponent === undefined ? {} : { opponent: actual.opponent }),
        },
        trainingRows,
        config,
      );
      const actualComponents: Record<string, number> = {};
      // Modeled components only. The de minimis constants are graded by the same league-scored gate
      // as everything else — they simply contribute 0 to predicted, baseline AND actual on every
      // line, so they can move no metric. Pushing always-zero residuals into these streams would
      // dilute the measurements of the components that ARE forecasts, which is the opposite of
      // grading them.
      for (const component of TEAM_DEFENSE_MODELED_COMPONENTS) {
        const actualValue = defenseComponentValue(actual, component) ?? 0;
        const predicted = projection.components[component] ?? 0;
        actualComponents[component] = actualValue;
        weekResiduals.push({ component, error: actualValue - predicted });
        metricSamples.push({
          component,
          error: predicted - actualValue,
          covered:
            actualValue >= (projection.lowerComponents[component] ?? 0) &&
            actualValue <= (projection.upperComponents[component] ?? 0),
        });
      }
      applyTeamDefenseDeMinimisZeros(actualComponents);
      predictions.push({
        team: actual.team,
        season: actual.season,
        week: actual.week,
        predicted: projection.components,
        baseline,
        lower: projection.lowerComponents,
        upper: projection.upperComponents,
        actual: actualComponents,
        trainingRows: trainingRows.length,
        calibrationRows: priorResiduals.length,
      });
    }
    residuals.push(...weekResiduals);
  }

  const metrics: Record<string, FirstPartyBacktestComponentMetrics> = {};
  for (const component of TEAM_DEFENSE_MODELED_COMPONENTS) {
    metrics[component] = metricsFor(
      metricSamples.filter((sample) => sample.component === component),
    );
  }
  const last = eligible.at(-1);
  return {
    modelVersion: FIRST_PARTY_PROJECTION_MODEL_VERSION,
    predictions,
    metrics,
    overall: metricsFor(metricSamples),
    calibration: defenseCalibrationFromResiduals(
      residuals,
      config,
      last === undefined ? undefined : { season: last.season, week: last.week },
    ),
  };
}

/** Scores the locked DST component backtest, including expected bracket-probability components. */
export function evaluateFirstPartyTeamDefenseBacktestForScoringProfile(
  backtest: FirstPartyTeamDefenseBacktest,
  scoringProfile: ProjectionScoringProfile,
  options: FirstPartyScoredBacktestOptions = {},
): FirstPartyScoredTeamDefenseEvaluation {
  if (backtest.modelVersion !== FIRST_PARTY_PROJECTION_MODEL_VERSION) {
    throw new Error(
      "Team-defense backtest model version does not match the current first-party model",
    );
  }
  const minimumIntervalSamples = options.minimumIntervalSamples ?? 24;
  const minimumPlayerSamples = options.minimumPlayerSamples ?? 24;
  const lowerQuantile = options.lowerIntervalQuantile ?? 0.15;
  const upperQuantile = options.upperIntervalQuantile ?? 0.85;
  if (!Number.isSafeInteger(minimumIntervalSamples) || minimumIntervalSamples <= 0) {
    throw new RangeError("minimumIntervalSamples must be a positive integer");
  }
  if (!Number.isSafeInteger(minimumPlayerSamples) || minimumPlayerSamples <= 0) {
    throw new RangeError("minimumPlayerSamples must be a positive integer");
  }
  if (lowerQuantile < 0 || upperQuantile > 1 || lowerQuantile >= upperQuantile) {
    throw new RangeError("point residual quantiles must be ordered within zero and one");
  }

  const scored = backtest.predictions
    .map((prediction) => {
      const actual = scoreProjectionStatComponents(prediction.actual, scoringProfile);
      const projected = scoreProjectionStatComponents(prediction.predicted, scoringProfile);
      const baseline = scoreProjectionStatComponents(prediction.baseline, scoringProfile);
      const rawError = actual - projected;
      const rawBaselineError = actual - baseline;
      return {
        playerId: prediction.team,
        season: prediction.season,
        week: prediction.week,
        rawError,
        rawBaselineError,
        error: rawError,
        squaredError: rawError * rawError,
        absoluteError: Math.abs(rawError),
        baselineAbsoluteError: Math.abs(rawBaselineError),
      } satisfies ScoredResidualSample;
    })
    .sort(
      (left, right) =>
        ordinal(left.season, left.week) - ordinal(right.season, right.week) ||
        left.playerId.localeCompare(right.playerId),
    );
  const withCoverage: ScoredResidualSample[] = [];
  const priorRawSamples: ScoredResidualSample[] = [];
  const priorAdjustedErrors: number[] = [];
  const weekKeys = [...new Set(scored.map((sample) => ordinal(sample.season, sample.week)))].sort(
    (left, right) => left - right,
  );
  for (const weekKey of weekKeys) {
    const weekSamples = scored.filter((sample) => ordinal(sample.season, sample.week) === weekKey);
    const adjustedWeekSamples: ScoredResidualSample[] = [];
    const recentRawSamples = recentPointSamples(priorRawSamples);
    const centerAdjustment =
      recentRawSamples.length < minimumIntervalSamples
        ? 0
        : mean(recentRawSamples.map((prior) => prior.rawError));
    const baselineCenterAdjustment =
      recentRawSamples.length < minimumIntervalSamples
        ? 0
        : mean(recentRawSamples.map((prior) => prior.rawBaselineError));
    for (const sample of weekSamples) {
      const error = sample.rawError - centerAdjustment;
      const baselineError = sample.rawBaselineError - baselineCenterAdjustment;
      const adjustedSample: ScoredResidualSample = {
        ...sample,
        error,
        squaredError: error * error,
        absoluteError: Math.abs(error),
        baselineAbsoluteError: Math.abs(baselineError),
        ...(priorAdjustedErrors.length < minimumIntervalSamples
          ? {}
          : {
              intervalCovered:
                error >= quantile(priorAdjustedErrors, lowerQuantile) &&
                error <= quantile(priorAdjustedErrors, upperQuantile),
            }),
      };
      withCoverage.push(adjustedSample);
      adjustedWeekSamples.push(adjustedSample);
    }
    priorRawSamples.push(...weekSamples);
    priorAdjustedErrors.push(...adjustedWeekSamples.map((sample) => sample.error));
  }

  const byTeam: Record<string, FirstPartyPointResidualCalibration> = {};
  const teams = [...new Set(withCoverage.map((sample) => sample.playerId))].sort();
  for (const team of teams) {
    const samples = withCoverage.filter((sample) => sample.playerId === team);
    if (samples.length >= minimumPlayerSamples) {
      byTeam[team] = pointResidualSummary(samples, lowerQuantile, upperQuantile);
    }
  }
  const latest = scored.at(-1);
  return {
    modelVersion: FIRST_PARTY_PROJECTION_MODEL_VERSION,
    scoringProfileKey: projectionScoringProfileKey(scoringProfile),
    baseline: "recency-only",
    ...(latest === undefined
      ? {}
      : { generatedThrough: { season: latest.season, week: latest.week } }),
    byTeam,
    overall: pointResidualSummary(withCoverage, lowerQuantile, upperQuantile),
  };
}
