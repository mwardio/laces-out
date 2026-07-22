import { createHash } from "node:crypto";

import {
  FIRST_PARTY_PROJECTION_MODEL_VERSION,
  FIRST_PARTY_ROS_COVERAGE_EVIDENCE_ALPHA,
  FIRST_PARTY_ROS_MAX_AVAILABILITY_BIAS,
  firstPartyRosCoverageEvidenceOfUndercoverage,
  FIRST_PARTY_ROS_MAX_AVAILABILITY_MAE,
  FIRST_PARTY_ROS_MAX_NINE_PLUS_AVAILABILITY_MAE,
  FIRST_PARTY_ROS_MODEL_VERSION,
  diagnoseFirstPartyRosConvergence,
  evaluateFirstPartyRosChampionPolicy,
  firstPartyProjectionComponentsForPosition,
  firstPartyRecentRoleContext,
  firstPartyTeamDefenseProjectionComponents,
  projectFirstPartyRecencyBaselineComponents,
  projectFirstPartyRestOfSeason,
  projectFirstPartyTeamDefenseComponents,
  projectFirstPartyTeamDefenseRecencyBaselineComponents,
  projectFirstPartyWeeklyComponents,
  projectionScoringProfileKey,
  runFirstPartyProjectionBacktest,
  runFirstPartyTeamDefenseBacktest,
  scoreProjectionStatComponents,
  type FirstPartyBacktestPrediction,
  type FirstPartyPlayerStatus,
  type FirstPartyProjectionCalibration,
  type FirstPartyProjectionPosition,
  type FirstPartyRosAvailabilityInput,
  type FirstPartyRosChampionEvaluation,
  type FirstPartyRosConvergenceDiagnostic,
  type FirstPartyRosHeldOutForecast,
  type FirstPartyRosHeldOutSeason,
  type FirstPartyRosPosition,
  type FirstPartyRosProjectionInput,
  type FirstPartyRosRemainingWeeksBucket,
  type FirstPartyRosRoleInput,
  type FirstPartyTeamDefenseCalibration,
  type FirstPartyTeamDefenseWeeklyStatLine,
  type FirstPartyWeeklyProjection,
  type FirstPartyWeeklyStatLine,
  type ProjectionScoringProfile,
  type ProjectionStatComponents,
} from "@fantasy/projections";

import {
  firstPartyPlayerStatus,
  type ProjectionInjuryFact,
  type ProjectionRosterFact,
  type ProjectionScheduleFact,
} from "./first-party-projection-inputs.js";
import type { RosHistoricalCoverageReport } from "./ros-data-coverage.js";

export const HISTORICAL_ROS_INTERVAL_METHOD_VERSION = "simulation-p15-p50-p85-cqr-v1";
export const HISTORICAL_ROS_CANDIDATE_PAIR_VERSION = `${FIRST_PARTY_PROJECTION_MODEL_VERSION}:contextual-vs-recency-v1`;
export const HISTORICAL_ROS_DEFAULT_CUTOFFS = Array.from({ length: 17 }, (_, index) => index + 1);
export const HISTORICAL_ROS_SUPPORTED_POSITIONS = ["QB", "RB", "WR", "TE", "K"] as const;
export const HISTORICAL_ROS_SCORING_PROFILE: ProjectionScoringProfile = {
  id: "laces-out-historical-ros-ppr",
  version: "1",
  rules: [
    { statId: "passing_yards", points: 0.04 },
    { statId: "passing_touchdowns", points: 4 },
    { statId: "passing_interceptions", points: -2 },
    { statId: "rushing_yards", points: 0.1 },
    { statId: "rushing_touchdowns", points: 6 },
    { statId: "receptions", points: 1 },
    { statId: "receiving_yards", points: 0.1 },
    { statId: "receiving_touchdowns", points: 6 },
    { statId: "fumbles_lost", points: -2 },
    { statId: "field_goals_made_0_39", points: 3 },
    { statId: "field_goals_made_40_49", points: 4 },
    { statId: "field_goals_made_50_plus", points: 5 },
    { statId: "field_goals_missed", points: -1 },
    { statId: "extra_points_made", points: 1 },
    { statId: "defensive_sacks", points: 1 },
    { statId: "defensive_interceptions", points: 2 },
    { statId: "defensive_fumble_recoveries", points: 2 },
    { statId: "defensive_safeties", points: 2 },
    { statId: "defensive_touchdowns", points: 6 },
    { statId: "defensive_blocked_kicks", points: 2 },
    { statId: "special_teams_touchdowns", points: 6 },
    { statId: "points_allowed_0_probability", points: 10 },
    { statId: "points_allowed_1_6_probability", points: 7 },
    { statId: "points_allowed_7_13_probability", points: 4 },
    { statId: "points_allowed_14_20_probability", points: 1 },
    { statId: "points_allowed_21_27_probability", points: 0 },
    { statId: "points_allowed_28_34_probability", points: -1 },
    { statId: "points_allowed_35_plus_probability", points: -4 },
  ],
};

const positionSet = new Set<string>(HISTORICAL_ROS_SUPPORTED_POSITIONS);
const inactiveStatuses = new Set<FirstPartyPlayerStatus>([
  "doubtful",
  "out",
  "inactive",
  "suspended",
  "pup",
  "ir",
]);

export interface HistoricalRosBacktestOptions {
  readonly heldOutSeasons: readonly number[];
  readonly asOfWeeks?: readonly number[];
  readonly playersPerPosition?: number;
  readonly maximumForecasts?: number;
  readonly minimumPortfolioForecasts?: number;
  readonly minimumPortfolioBatches?: number;
  readonly minimumCellSamples?: number;
  readonly minimumCellCutoffs?: number;
  readonly minimumCellBatches?: number;
  readonly minimumCellSeasons?: number;
}

export interface HistoricalRosBacktestInput {
  readonly history: readonly FirstPartyWeeklyStatLine[];
  readonly defenseHistory: readonly FirstPartyTeamDefenseWeeklyStatLine[];
  readonly rosters: readonly ProjectionRosterFact[];
  readonly injuries: readonly ProjectionInjuryFact[];
  readonly schedules: readonly ProjectionScheduleFact[];
  readonly coverage: RosHistoricalCoverageReport;
  readonly scoringProfile: ProjectionScoringProfile;
  readonly options: HistoricalRosBacktestOptions;
  readonly onProgress?: (event: HistoricalRosBacktestProgress) => void;
}

export interface HistoricalRosBacktestProgress {
  readonly stage:
    | "defense-outcomes-ready"
    | "season-calibration-ready"
    | "season-forecasts-ready"
    | "convergence-started"
    | "convergence-ready"
    | "evaluation-ready";
  readonly season?: number;
  readonly forecasts: number;
  readonly convergenceStrata?: number;
}

export interface HistoricalRosCellEvidence {
  readonly position: FirstPartyRosPosition;
  readonly bucket: FirstPartyRosRemainingWeeksBucket;
  readonly seasons: number;
  readonly cutoffs: number;
  readonly batches: number;
  readonly samples: number;
  readonly ready: boolean;
  readonly reasons: readonly string[];
}

export interface HistoricalRosBacktestReport {
  readonly state: "evidence-ready" | "insufficient";
  readonly seasons: readonly number[];
  readonly forecasts: number;
  readonly batches: number;
  readonly diagnosedPairs: number;
  readonly skippedForecasts: number;
  readonly playersPerPosition: number;
  readonly maximumForecasts: number;
  readonly leakagePolicy: {
    readonly calibration: "seasons-strictly-before-heldout";
    readonly features: "strictly-before-cutoff";
    readonly futureRosterUse: false;
    readonly targetOutcomeUse: "evaluation-only";
  };
  readonly selectionPolicy: {
    readonly strategy: "recent-production-stratified";
    readonly tiers: readonly ["high", "middle", "lower"];
    readonly excludesNonPositiveRecentProduction: true;
  };
  readonly unsupportedPositions: readonly string[];
  readonly blockers: readonly string[];
  readonly cells: readonly HistoricalRosCellEvidence[];
  readonly availabilityCalibrationVersion: typeof HISTORICAL_ROS_AVAILABILITY_CALIBRATION_VERSION;
  readonly roleCalibrationVersion: typeof HISTORICAL_ROS_ROLE_CALIBRATION_VERSION;
  /** Compact worst-metric view of every stratum's release-vs-reference convergence diagnostic. */
  readonly convergenceAudit: readonly HistoricalRosConvergenceAuditEntry[];
}

export interface HistoricalRosBacktestResult {
  readonly heldOutSeasons: readonly FirstPartyRosHeldOutSeason[];
  readonly champion: FirstPartyRosChampionEvaluation;
  readonly report: HistoricalRosBacktestReport;
}

export function historicalRosCalibrationBlockers(
  choices: FirstPartyRosChampionEvaluation["livePolicy"]["choices"],
): readonly string[] {
  return choices.flatMap((choice) => {
    const selected = choice.strategy === "contextual" ? "contextual" : "recency";
    const artifact = choice.intervalCalibrationArtifacts[selected];
    const walkForward = choice.walkForwardCalibrationEvidence[selected];
    const heldOut = choice.heldOutEvidence;
    const inputCoverage =
      selected === "contextual"
        ? heldOut.contextualMeanInputCoverage
        : heldOut.recencyMeanInputCoverage;
    const availabilityMae =
      selected === "contextual"
        ? heldOut.contextualAvailabilityMae
        : heldOut.recencyAvailabilityMae;
    const availabilityBias =
      selected === "contextual"
        ? heldOut.contextualAvailabilityBias
        : heldOut.recencyAvailabilityBias;
    const availabilityMaeCeiling =
      choice.bucket === "nine-plus"
        ? FIRST_PARTY_ROS_MAX_NINE_PLUS_AVAILABILITY_MAE
        : FIRST_PARTY_ROS_MAX_AVAILABILITY_MAE;
    const convergenceRate =
      selected === "contextual"
        ? heldOut.contextualConvergenceRate
        : heldOut.recencyConvergenceRate;
    const prefix = `calibration_${choice.position}_${choice.bucket}`;
    return [
      ...(heldOut.state !== "derived-immutable-not-calibrated" || heldOut.evidenceChecksum === null
        ? [`${prefix}_held_out_evidence_unavailable`]
        : []),
      ...(inputCoverage < 0.95 ? [`${prefix}_input_coverage_below_minimum`] : []),
      ...(availabilityMae > availabilityMaeCeiling
        ? [`${prefix}_availability_mae_above_maximum`]
        : []),
      ...(Math.abs(availabilityBias) > FIRST_PARTY_ROS_MAX_AVAILABILITY_BIAS
        ? [`${prefix}_availability_bias_above_maximum`]
        : []),
      ...(convergenceRate < 1 ? [`${prefix}_convergence_below_minimum`] : []),
      ...(choice.intervalCalibration !== "split-conformal-cqr" || artifact.state !== "calibrated"
        ? [`${prefix}_artifact_unavailable`]
        : []),
      ...(walkForward.state !== "available" || walkForward.evidenceChecksum === null
        ? [`${prefix}_walk_forward_unavailable`]
        : []),
      ...(walkForward.seasons < 1 ? [`${prefix}_walk_forward_seasons_below_minimum`] : []),
      ...(walkForward.blocks < 3 ? [`${prefix}_walk_forward_blocks_below_minimum`] : []),
      ...(walkForward.samples < 18 ? [`${prefix}_walk_forward_samples_below_minimum`] : []),
      ...(firstPartyRosCoverageEvidenceOfUndercoverage(
        walkForward.blocks,
        walkForward.observedBlockCoverage,
        artifact.nominalCoverage - 0.1,
        FIRST_PARTY_ROS_COVERAGE_EVIDENCE_ALPHA,
      )
        ? [`${prefix}_coverage_shortfall_above_maximum`]
        : []),
    ];
  });
}

interface ResolvedOptions {
  readonly heldOutSeasons: readonly number[];
  readonly asOfWeeks: readonly number[];
  readonly playersPerPosition: number;
  readonly maximumForecasts: number;
  readonly minimumPortfolioForecasts: number;
  readonly minimumPortfolioBatches: number;
  readonly minimumCellSamples: number;
  readonly minimumCellCutoffs: number;
  readonly minimumCellBatches: number;
  readonly minimumCellSeasons: number;
}

type HistoricalRosSelectionTier = "high" | "middle" | "lower";

interface CandidatePlayer {
  readonly playerId: string;
  readonly position: FirstPartyProjectionPosition;
  readonly team: string;
  readonly rosterStatus?: string | null;
  readonly recentPoints: number;
  readonly selectionTier: HistoricalRosSelectionTier;
}

interface CandidateDefense {
  readonly team: string;
  readonly recentPoints: number;
  readonly selectionTier: HistoricalRosSelectionTier;
}

interface HistoricalRosDraft {
  readonly forecast: Omit<FirstPartyRosHeldOutForecast, "evidence">;
  readonly contextualInput: FirstPartyRosProjectionInput;
  readonly recencyInput: FirstPartyRosProjectionInput;
  readonly coverage: { readonly contextual: number; readonly recency: number };
  readonly actualGames: number;
  readonly scheduledGames: number;
  readonly contextualExpectedGames: number;
  readonly recencyExpectedGames: number;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function normalizeForChecksum(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeForChecksum);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, candidate]) => [key, normalizeForChecksum(candidate)]),
    );
  }
  return value;
}

export function historicalRosChecksum(value: unknown): string {
  return sha256(JSON.stringify(normalizeForChecksum(value)));
}

function sortedUniqueIntegers(values: readonly number[], label: string): readonly number[] {
  if (values.some((value) => !Number.isSafeInteger(value))) {
    throw new TypeError(`${label} must contain integers`);
  }
  return [...new Set(values)].sort((left, right) => left - right);
}

function resolveOptions(options: HistoricalRosBacktestOptions): ResolvedOptions {
  const heldOutSeasons = sortedUniqueIntegers(options.heldOutSeasons, "heldOutSeasons");
  const asOfWeeks = sortedUniqueIntegers(
    options.asOfWeeks ?? HISTORICAL_ROS_DEFAULT_CUTOFFS,
    "asOfWeeks",
  );
  if (
    heldOutSeasons.length < 3 ||
    heldOutSeasons.some((season) => season < 2000 || season > 2200)
  ) {
    throw new RangeError(
      "Historical ROS evaluation requires at least three valid held-out seasons",
    );
  }
  if (asOfWeeks.length === 0 || asOfWeeks.some((week) => week < 1 || week > 17)) {
    throw new RangeError("Historical ROS cutoffs must be between Weeks 1 and 17");
  }
  const resolved = {
    heldOutSeasons,
    asOfWeeks,
    playersPerPosition: options.playersPerPosition ?? 5,
    maximumForecasts: options.maximumForecasts ?? 3_000,
    minimumPortfolioForecasts: options.minimumPortfolioForecasts ?? 300,
    minimumPortfolioBatches: options.minimumPortfolioBatches ?? 30,
    minimumCellSamples: options.minimumCellSamples ?? 18,
    minimumCellCutoffs: options.minimumCellCutoffs ?? 3,
    minimumCellBatches: options.minimumCellBatches ?? 9,
    minimumCellSeasons: options.minimumCellSeasons ?? 3,
  };
  for (const [label, value] of Object.entries(resolved).filter(
    ([key]) => key !== "heldOutSeasons" && key !== "asOfWeeks",
  )) {
    if (!Number.isSafeInteger(value) || (value as number) <= 0) {
      throw new RangeError(`${label} must be a positive integer`);
    }
  }
  return resolved;
}

export function historicalRosBucket(
  windowStartWeek: number,
  windowEndWeek = 18,
): FirstPartyRosRemainingWeeksBucket {
  const remaining = windowEndWeek - windowStartWeek + 1;
  if (remaining <= 0) throw new RangeError("Historical ROS window must not be empty");
  return remaining <= 4 ? "one-to-four" : remaining <= 8 ? "five-to-eight" : "nine-plus";
}

function ordinal(row: Pick<FirstPartyWeeklyStatLine, "season" | "week">): number {
  return row.season * 32 + row.week;
}

export function historicalRosTrainingRows(
  history: readonly FirstPartyWeeklyStatLine[],
  heldOutSeason: number,
): readonly FirstPartyWeeklyStatLine[] {
  return history.filter((row) => row.season < heldOutSeason);
}

export function historicalRosFeatureRows(
  history: readonly FirstPartyWeeklyStatLine[],
  heldOutSeason: number,
  asOfWeek: number,
): readonly FirstPartyWeeklyStatLine[] {
  const cutoff = heldOutSeason * 32 + asOfWeek;
  return history.filter((row) => ordinal(row) <= cutoff);
}

export function historicalRosDefenseTrainingRows(
  history: readonly FirstPartyTeamDefenseWeeklyStatLine[],
  heldOutSeason: number,
): readonly FirstPartyTeamDefenseWeeklyStatLine[] {
  return history.filter((row) => row.season < heldOutSeason);
}

export function historicalRosDefenseFeatureRows(
  history: readonly FirstPartyTeamDefenseWeeklyStatLine[],
  heldOutSeason: number,
  asOfWeek: number,
): readonly FirstPartyTeamDefenseWeeklyStatLine[] {
  const cutoff = heldOutSeason * 32 + asOfWeek;
  return history.filter((row) => ordinal(row) <= cutoff);
}

/** Uses the weekly core's canonical D/ST actual normalizer, including provider bucket families. */
export function canonicalHistoricalRosDefenseOutcomes(
  history: readonly FirstPartyTeamDefenseWeeklyStatLine[],
): readonly FirstPartyTeamDefenseWeeklyStatLine[] {
  return runFirstPartyTeamDefenseBacktest(history).predictions.map(
    (prediction): FirstPartyTeamDefenseWeeklyStatLine => ({
      team: prediction.team,
      season: prediction.season,
      week: prediction.week,
      components: prediction.actual,
      played: true,
    }),
  );
}

function stratifiedRecentProductionSelection<T extends { readonly recentPoints: number }>(
  candidates: readonly T[],
  count: number,
): readonly (T & { readonly selectionTier: HistoricalRosSelectionTier })[] {
  const eligible = candidates.filter((candidate) => candidate.recentPoints > 0);
  const selectedCount = Math.min(count, eligible.length);
  if (selectedCount === 0) return [];
  const indices = Array.from({ length: selectedCount }, (_, index) =>
    selectedCount === 1 ? 0 : Math.round((index * (eligible.length - 1)) / (selectedCount - 1)),
  );
  return [...new Set(indices)].map((candidateIndex, index, selectedIndices) => ({
    ...eligible[candidateIndex]!,
    selectionTier: index === 0 ? "high" : index === selectedIndices.length - 1 ? "lower" : "middle",
  }));
}

export function selectHistoricalRosDefenses(input: {
  readonly history: readonly FirstPartyTeamDefenseWeeklyStatLine[];
  readonly season: number;
  readonly asOfWeek: number;
  readonly scoringProfile: ProjectionScoringProfile;
  readonly teams: number;
}): readonly CandidateDefense[] {
  const rowsByTeam = new Map<string, FirstPartyTeamDefenseWeeklyStatLine[]>();
  for (const row of input.history) {
    if (row.season !== input.season || row.week > input.asOfWeek) continue;
    const rows = rowsByTeam.get(row.team) ?? [];
    rows.push(row);
    rowsByTeam.set(row.team, rows);
  }
  return stratifiedRecentProductionSelection(
    [...rowsByTeam.entries()]
      .map(([team, rows]) => ({
        team,
        recentPoints: [...rows]
          .sort((left, right) => ordinal(left) - ordinal(right))
          .filter((row) => row.played !== false)
          .slice(-4)
          .reduce(
            (sum, row) => sum + scoreProjectionStatComponents(row.components, input.scoringProfile),
            0,
          ),
      }))
      .sort(
        (left, right) =>
          right.recentPoints - left.recentPoints || left.team.localeCompare(right.team),
      ),
    input.teams,
  );
}

function latestRosterByPlayer(
  rosters: readonly ProjectionRosterFact[],
  season: number,
  asOfWeek: number,
): ReadonlyMap<string, ProjectionRosterFact> {
  const result = new Map<string, ProjectionRosterFact>();
  for (const row of rosters) {
    if (row.season !== season || row.week > asOfWeek || !positionSet.has(row.position)) continue;
    const current = result.get(row.playerId);
    if (
      !current ||
      row.week > current.week ||
      (row.week === current.week &&
        `${row.team}:${row.status ?? ""}` < `${current.team}:${current.status ?? ""}`)
    ) {
      result.set(row.playerId, row);
    }
  }
  return result;
}

function recentFantasyPoints(
  rows: readonly FirstPartyWeeklyStatLine[],
  scoringProfile: ProjectionScoringProfile,
): number {
  return rows
    .filter((row) => row.played !== false)
    .slice(-4)
    .reduce((sum, row) => sum + scoreProjectionStatComponents(row.components, scoringProfile), 0);
}

export function selectHistoricalRosPlayers(input: {
  readonly history: readonly FirstPartyWeeklyStatLine[];
  readonly rosters: readonly ProjectionRosterFact[];
  readonly season: number;
  readonly asOfWeek: number;
  readonly scoringProfile: ProjectionScoringProfile;
  readonly playersPerPosition: number;
}): readonly CandidatePlayer[] {
  const rosterByPlayer = latestRosterByPlayer(input.rosters, input.season, input.asOfWeek);
  const historyByPlayer = new Map<string, FirstPartyWeeklyStatLine[]>();
  for (const history of input.history) {
    if (history.season !== input.season || history.week > input.asOfWeek) continue;
    const rows = historyByPlayer.get(history.playerId) ?? [];
    rows.push(history);
    historyByPlayer.set(history.playerId, rows);
  }
  const candidates = [...rosterByPlayer.values()].flatMap(
    (row): Array<Omit<CandidatePlayer, "selectionTier">> => {
      const position = row.position as FirstPartyProjectionPosition;
      const playerRows = historyByPlayer.get(row.playerId);
      if (!playerRows || playerRows.length === 0) return [];
      return [
        {
          playerId: row.playerId,
          position,
          team: row.team,
          ...(row.status === undefined ? {} : { rosterStatus: row.status }),
          recentPoints: recentFantasyPoints(playerRows, input.scoringProfile),
        },
      ];
    },
  );
  return HISTORICAL_ROS_SUPPORTED_POSITIONS.flatMap((position) =>
    stratifiedRecentProductionSelection(
      candidates
        .filter((candidate) => candidate.position === position)
        .sort(
          (left, right) =>
            right.recentPoints - left.recentPoints || left.playerId.localeCompare(right.playerId),
        ),
      input.playersPerPosition,
    ),
  );
}

function latestInjuryStatus(
  injuries: readonly ProjectionInjuryFact[],
  playerId: string,
  season: number,
  asOfWeek: number,
): ProjectionInjuryFact | undefined {
  return injuries
    .filter((row) => row.playerId === playerId && row.season === season && row.week <= asOfWeek)
    .sort((left, right) => right.week - left.week)[0];
}

function statusState(status: FirstPartyPlayerStatus): FirstPartyRosAvailabilityInput["state"] {
  if (status === "ir" || status === "pup") return "reserve";
  if (inactiveStatuses.has(status)) return "inactive";
  if (status === "questionable") return "limited";
  return "active";
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export const HISTORICAL_ROS_AVAILABILITY_CALIBRATION_VERSION =
  "historical-ros-availability-curve-matched-v3";
export const HISTORICAL_ROS_ROLE_CALIBRATION_VERSION = "historical-ros-role-center-two-moment-v4";

/**
 * Consecutive played scheduled opportunities entering a week. `returning` players (streak <= 1)
 * carry a materially higher re-absence hazard than `established` (streak >= 5) starters; treating
 * the two populations with one global hazard was the dominant long-horizon expected-games bias.
 */
export type HistoricalRosStreakBucket = "returning" | "settling" | "established";

export function historicalRosStreakBucket(streak: number): HistoricalRosStreakBucket {
  if (!Number.isSafeInteger(streak) || streak < 0) {
    throw new RangeError("availability streak must be a nonnegative integer");
  }
  return streak <= 1 ? "returning" : streak <= 4 ? "settling" : "established";
}

/**
 * Availability parameters are no longer raw week-to-week transition frequencies. Transition
 * counting mixed short game-time absences with long reserve stints and healthy-scratch churn,
 * driving the fitted recovery rate to its floor and expected games far below reality for
 * established starters. v3 instead builds walk-forward per-stratum availability curves — the
 * probability that a roster-relevant player (positive trailing-four-played-game points) plays
 * their team's scheduled game `lag` weeks after a cutoff — and grid-fits the simulator's own
 * two-state chain `(newAbsenceProbability, recoveryProbability)` to reproduce each curve. The
 * simulated expected-games trajectory therefore matches the observed availability of exactly the
 * population the forecasts serve.
 */
export interface HistoricalRosAvailabilityCalibration {
  readonly version: typeof HISTORICAL_ROS_AVAILABILITY_CALIBRATION_VERSION;
  readonly global: Omit<FirstPartyRosAvailabilityInput, "state">;
  /** Keyed `${position}:${streakBucket}`; chain absence hazard fitted to the stratum curve. */
  readonly newAbsenceByPositionStreak: Readonly<Record<string, number>>;
  /** Keyed `${position}:${streakBucket}`; chain recovery fitted jointly with the hazard above. */
  readonly recoveryByPositionStreak: Readonly<Record<string, number>>;
  /** Keyed by position; recovery fitted to absent-at-cutoff curves (longer, selection-biased). */
  readonly absentRecoveryByPosition: Readonly<Record<string, number>>;
  /** Long-run availability implied by each fitted stratum chain, used for personal blending. */
  readonly asymptoteByPositionStreak: Readonly<Record<string, number>>;
}

type ScheduledWeeksIndex = ReadonlyMap<string, readonly number[]>;

function scheduledWeeksByTeamSeason(
  schedules: readonly ProjectionScheduleFact[],
): ScheduledWeeksIndex {
  const index = new Map<string, number[]>();
  for (const game of schedules) {
    for (const team of [game.awayTeam, game.homeTeam]) {
      const key = `${game.season}:${team}`;
      const weeks = index.get(key) ?? [];
      weeks.push(game.week);
      index.set(key, weeks);
    }
  }
  for (const weeks of index.values()) weeks.sort((left, right) => left - right);
  return index;
}

function nextScheduledWeek(
  index: ScheduledWeeksIndex,
  season: number,
  team: string,
  week: number,
): number | null {
  const weeks = index.get(`${season}:${team}`);
  if (!weeks) return null;
  for (const candidate of weeks) if (candidate > week) return candidate;
  return null;
}

function rowIsAvailable(row: FirstPartyWeeklyStatLine): boolean {
  return row.played !== false && !inactiveStatuses.has(row.status ?? "unknown");
}

/**
 * True only when `next` is the very next scheduled opportunity for `previous`'s team, so bye
 * weeks are spanned but multi-week roster gaps and team changes never masquerade as one-week
 * availability transitions.
 */
function isConsecutiveScheduledTransition(
  index: ScheduledWeeksIndex,
  previous: FirstPartyWeeklyStatLine,
  next: FirstPartyWeeklyStatLine,
): boolean {
  return (
    previous.season === next.season &&
    previous.team === next.team &&
    nextScheduledWeek(index, previous.season, previous.team, previous.week) === next.week
  );
}

interface AvailabilityCurve {
  readonly played: Float64Array;
  readonly trials: Float64Array;
}

function newAvailabilityCurve(): AvailabilityCurve {
  return { played: new Float64Array(18), trials: new Float64Array(18) };
}

/**
 * Simulator-faithful two-state chain: an available player misses the next opportunity with
 * probability `absence`; an unavailable player returns with probability `recovery`. Availability
 * is measured after each transition, matching `projectFirstPartyRestOfSeason` semantics.
 */
function chainAvailabilityCurve(
  startAvailable: boolean,
  absence: number,
  recovery: number,
  lags: number,
): Float64Array {
  const curve = new Float64Array(lags + 1);
  let available = startAvailable ? 1 : 0;
  for (let lag = 1; lag <= lags; lag += 1) {
    available = available * (1 - absence) + (1 - available) * recovery;
    curve[lag] = available;
  }
  return curve;
}

const AVAILABILITY_ABSENCE_GRID = Array.from({ length: 60 }, (_, index) => 0.005 * (index + 1));
const AVAILABILITY_RECOVERY_GRID = Array.from({ length: 35 }, (_, index) => 0.04 + 0.025 * index);
const AVAILABILITY_CURVE_POOL_STRENGTH = 150;
const AVAILABILITY_PERSONAL_STRENGTH = 40;
const AVAILABILITY_PERSONAL_MAX_TRIALS = 60;

function blendedCurvePoint(
  positionCurve: AvailabilityCurve | undefined,
  pooledCurve: AvailabilityCurve | undefined,
  lag: number,
): { readonly rate: number; readonly weight: number } | null {
  const positionTrials = positionCurve?.trials[lag] ?? 0;
  const positionPlayed = positionCurve?.played[lag] ?? 0;
  const pooledTrials = pooledCurve?.trials[lag] ?? 0;
  const pooledPlayed = pooledCurve?.played[lag] ?? 0;
  if (positionTrials + pooledTrials === 0) return null;
  const pooledRate = pooledTrials === 0 ? 0 : pooledPlayed / pooledTrials;
  const rate =
    (positionPlayed + AVAILABILITY_CURVE_POOL_STRENGTH * pooledRate) /
    (positionTrials + AVAILABILITY_CURVE_POOL_STRENGTH);
  return { rate, weight: positionTrials + 1 };
}

function fitAvailabilityChain(
  positionCurve: AvailabilityCurve | undefined,
  pooledCurve: AvailabilityCurve | undefined,
  startAvailable: boolean,
  fixedAbsence?: number,
): { readonly absence: number; readonly recovery: number } | null {
  const points: Array<{ lag: number; rate: number; weight: number }> = [];
  for (let lag = 1; lag <= 17; lag += 1) {
    const point = blendedCurvePoint(positionCurve, pooledCurve, lag);
    if (point) points.push({ lag, ...point });
  }
  if (points.length === 0) return null;
  const absenceGrid = fixedAbsence === undefined ? AVAILABILITY_ABSENCE_GRID : [fixedAbsence];
  let best: { absence: number; recovery: number; loss: number } | null = null;
  for (const absence of absenceGrid) {
    for (const recovery of AVAILABILITY_RECOVERY_GRID) {
      const curve = chainAvailabilityCurve(startAvailable, absence, recovery, 17);
      let loss = 0;
      for (const point of points) {
        loss += point.weight * (curve[point.lag]! - point.rate) ** 2;
      }
      if (best === null || loss < best.loss - 1e-12) best = { absence, recovery, loss };
    }
  }
  return best === null ? null : { absence: best.absence, recovery: best.recovery };
}

const AVAILABILITY_FALLBACK = { absence: 0.08, recovery: 0.3 } as const;

export function calibrateHistoricalRosAvailability(
  training: readonly FirstPartyWeeklyStatLine[],
  schedules: readonly ProjectionScheduleFact[],
  scoringProfile: ProjectionScoringProfile,
): HistoricalRosAvailabilityCalibration {
  const scheduleIndex = scheduledWeeksByTeamSeason(schedules);
  const byPlayer = new Map<string, FirstPartyWeeklyStatLine[]>();
  for (const row of training) {
    const rows = byPlayer.get(row.playerId) ?? [];
    rows.push(row);
    byPlayer.set(row.playerId, rows);
  }
  // Curves keyed `${position|*}:${streakBucket}` for available-at-cutoff snapshots,
  // `${position|*}:absent` for unavailable-at-cutoff, and `*:reserve` for ir/pup-at-cutoff.
  const curves = new Map<string, AvailabilityCurve>();
  const curveFor = (key: string): AvailabilityCurve => {
    const cell = curves.get(key) ?? newAvailabilityCurve();
    curves.set(key, cell);
    return cell;
  };
  for (const rows of byPlayer.values()) {
    rows.sort((left, right) => ordinal(left) - ordinal(right));
    const playedByWeek = new Map<string, boolean>();
    for (const row of rows) playedByWeek.set(`${row.season}:${row.week}`, row.played !== false);
    let streak = 0;
    const trailing: number[] = [];
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]!;
      const previous = index === 0 ? undefined : rows[index - 1]!;
      const chained =
        previous !== undefined &&
        (previous.season !== row.season ||
          isConsecutiveScheduledTransition(scheduleIndex, previous, row));
      const available = rowIsAvailable(row);
      if (!available) streak = 0;
      else if (previous === undefined || chained) streak = Math.min(streak + 1, 10);
      else streak = 1;
      const relevant = trailing.reduce((sum, value) => sum + value, 0) > 0;
      // The snapshot stands for a cutoff at this row's week: record whether the player played
      // each of the team's remaining scheduled opportunities this season.
      if (relevant && row.week <= 17) {
        const status = row.status ?? "unknown";
        const strata = available
          ? [
              `${row.position.trim().toUpperCase()}:${historicalRosStreakBucket(streak)}`,
              `*:${historicalRosStreakBucket(streak)}`,
            ]
          : status === "ir" || status === "pup"
            ? ["*:reserve"]
            : [`${row.position.trim().toUpperCase()}:absent`, "*:absent"];
        const scheduled = scheduleIndex.get(`${row.season}:${row.team}`) ?? [];
        for (const key of strata) {
          const cell = curveFor(key);
          for (const week of scheduled) {
            if (week <= row.week || week > 18) continue;
            const lag = week - row.week;
            if (lag > 17) continue;
            cell.trials[lag] = (cell.trials[lag] ?? 0) + 1;
            if (playedByWeek.get(`${row.season}:${week}`) === true) {
              cell.played[lag] = (cell.played[lag] ?? 0) + 1;
            }
          }
        }
      }
      if (row.played !== false) {
        trailing.push(scoreProjectionStatComponents(row.components, scoringProfile));
        if (trailing.length > 4) trailing.shift();
      }
    }
  }

  const streakBuckets: readonly HistoricalRosStreakBucket[] = [
    "returning",
    "settling",
    "established",
  ];
  const globalFit =
    fitAvailabilityChain(curves.get("*:settling"), curves.get("*:settling"), true) ??
    AVAILABILITY_FALLBACK;
  const globalAbsentFit = fitAvailabilityChain(
    curves.get("*:absent"),
    curves.get("*:absent"),
    false,
    globalFit.absence,
  ) ?? { absence: globalFit.absence, recovery: 0.25 };
  const reserveFit = fitAvailabilityChain(
    curves.get("*:reserve"),
    curves.get("*:reserve"),
    false,
    globalFit.absence,
  );
  const reserveRecovery = clamp(reserveFit?.recovery ?? globalAbsentFit.recovery * 0.5, 0.02, 0.6);

  const newAbsenceByPositionStreak: Record<string, number> = {};
  const recoveryByPositionStreak: Record<string, number> = {};
  const absentRecoveryByPosition: Record<string, number> = {};
  const asymptoteByPositionStreak: Record<string, number> = {};
  for (const position of HISTORICAL_ROS_SUPPORTED_POSITIONS) {
    for (const bucket of streakBuckets) {
      const fit =
        fitAvailabilityChain(
          curves.get(`${position}:${bucket}`),
          curves.get(`*:${bucket}`),
          true,
        ) ?? globalFit;
      newAbsenceByPositionStreak[`${position}:${bucket}`] = fit.absence;
      recoveryByPositionStreak[`${position}:${bucket}`] = fit.recovery;
      asymptoteByPositionStreak[`${position}:${bucket}`] =
        fit.recovery / (fit.absence + fit.recovery);
    }
    const absentFit = fitAvailabilityChain(
      curves.get(`${position}:absent`),
      curves.get("*:absent"),
      false,
      newAbsenceByPositionStreak[`${position}:returning`],
    );
    absentRecoveryByPosition[position] = clamp(
      absentFit?.recovery ?? globalAbsentFit.recovery,
      0.04,
      0.9,
    );
  }
  return {
    version: HISTORICAL_ROS_AVAILABILITY_CALIBRATION_VERSION,
    global: {
      newAbsenceProbability: globalFit.absence,
      recoveryProbability: globalFit.recovery,
      reserveRecoveryProbability: reserveRecovery,
      limitedRoleMultiplier: 0.85,
      returnRoleMultiplier: 0.75,
    },
    newAbsenceByPositionStreak,
    recoveryByPositionStreak,
    absentRecoveryByPosition,
    asymptoteByPositionStreak,
  };
}

export interface HistoricalRosPersonalAvailability {
  /** Fraction of this player's own trailing history rows that were available. */
  readonly rate: number;
  readonly trials: number;
}

export function historicalRosAvailabilityFor(
  calibration: HistoricalRosAvailabilityCalibration,
  position: FirstPartyProjectionPosition,
  streak: number,
  state: FirstPartyRosAvailabilityInput["state"] = "active",
  personal?: HistoricalRosPersonalAvailability,
): Omit<FirstPartyRosAvailabilityInput, "state"> {
  const bucket = historicalRosStreakBucket(streak);
  const key = `${position}:${bucket}`;
  let absence =
    calibration.newAbsenceByPositionStreak[key] ?? calibration.global.newAbsenceProbability;
  const jointRecovery =
    calibration.recoveryByPositionStreak[key] ?? calibration.global.recoveryProbability;
  // Available-start players recover from simulated mid-window absences at the jointly fitted
  // rate; players already absent at the cutoff follow the slower absent-at-cutoff recovery.
  const recovery =
    state === "active" || state === "limited"
      ? jointRecovery
      : (calibration.absentRecoveryByPosition[position] ?? jointRecovery);
  if (personal !== undefined && personal.trials > 0) {
    const stratumAsymptote =
      calibration.asymptoteByPositionStreak[key] ?? jointRecovery / (absence + jointRecovery);
    const trials = Math.min(personal.trials, AVAILABILITY_PERSONAL_MAX_TRIALS);
    const blended =
      (clamp(personal.rate, 0, 1) * trials + stratumAsymptote * AVAILABILITY_PERSONAL_STRENGTH) /
      (trials + AVAILABILITY_PERSONAL_STRENGTH);
    absence = clamp((jointRecovery * (1 - blended)) / Math.max(blended, 0.05), 0.005, 0.5);
  }
  return {
    newAbsenceProbability: absence,
    recoveryProbability: recovery,
    reserveRecoveryProbability: calibration.global.reserveRecoveryProbability,
    limitedRoleMultiplier: calibration.global.limitedRoleMultiplier,
    returnRoleMultiplier: calibration.global.returnRoleMultiplier,
  };
}

/**
 * Consecutive played scheduled opportunities through the cutoff, matching the calibrator's streak
 * semantics: DNP or inactive status breaks the chain, a same-season missing scheduled opportunity
 * breaks the chain, byes are spanned, and a season boundary neither breaks nor extends it.
 */
export function historicalRosActiveStreak(
  history: readonly FirstPartyWeeklyStatLine[],
  playerId: string,
  season: number,
  asOfWeek: number,
  schedules: readonly ProjectionScheduleFact[],
): number {
  const scheduleIndex = scheduledWeeksByTeamSeason(schedules);
  const rows = history
    .filter(
      (row) =>
        row.playerId === playerId &&
        (row.season < season || (row.season === season && row.week <= asOfWeek)),
    )
    .sort((left, right) => ordinal(left) - ordinal(right));
  let streak = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    const previous = index === 0 ? undefined : rows[index - 1]!;
    const chained =
      previous !== undefined &&
      (previous.season !== row.season ||
        isConsecutiveScheduledTransition(scheduleIndex, previous, row));
    if (!rowIsAvailable(row)) streak = 0;
    else if (previous === undefined || chained) streak = Math.min(streak + 1, 10);
    else streak = 1;
  }
  return streak;
}

export interface HistoricalRosRoleCalibration {
  readonly version: typeof HISTORICAL_ROS_ROLE_CALIBRATION_VERSION;
  readonly byPosition: Readonly<Record<string, FirstPartyRosRoleInput>>;
  readonly fallback: FirstPartyRosRoleInput;
}

const ROS_ROLE_PERSISTENCE = 0.82;

/**
 * Per-position role and production calibration. The prior fixed weekly production volatility of
 * 0.15 implied a weekly fantasy-point coefficient of variation near 15%, far below the observed
 * 45-70% for every supported position, which is why simulated intervals undercovered — worst for
 * kickers, whose week-to-week variance is nearly all production noise rather than role change.
 * Weekly production volatility is now matched to the median observed within-season weekly-point
 * CV of relevant players (>= 5 played games, >= 4 mean points), less the stationary role variance.
 */
export function calibrateHistoricalRosRole(
  training: readonly FirstPartyWeeklyStatLine[],
  schedules: readonly ProjectionScheduleFact[],
  scoringProfile: ProjectionScoringProfile,
  weeklyPredictions: readonly FirstPartyBacktestPrediction[] = [],
): HistoricalRosRoleCalibration {
  // Center-error volatility: the weekly model's own locked backtest residuals, grouped per
  // player-season. The between-player variance of each player-season's mean log residual, less
  // its expected sampling contribution, estimates the static per-player center error the ROS
  // simulation must carry — a component that neither within-season variance (V1) nor
  // trailing-form residuals (V4) can see, because both are measured relative to the player's own
  // realized level.
  const centerResidualsByPosition = new Map<
    string,
    Array<{ mean: number; count: number; variance: number }>
  >();
  {
    const byPlayerSeason = new Map<string, { position: string; residuals: number[] }>();
    for (const prediction of weeklyPredictions) {
      const predictedPoints = scoreProjectionStatComponents(prediction.predicted, scoringProfile);
      const actualPoints = scoreProjectionStatComponents(prediction.actual, scoringProfile);
      if (actualPoints < 0.5) continue; // exclude DNP-style zeros; availability is modeled separately
      const key = `${prediction.playerId}:${prediction.season}`;
      const entry = byPlayerSeason.get(key) ?? {
        position: prediction.position.trim().toUpperCase(),
        residuals: [],
      };
      entry.residuals.push(
        clamp(Math.log((actualPoints + 4) / (Math.max(predictedPoints, 0) + 4)), -2, 2),
      );
      byPlayerSeason.set(key, entry);
    }
    for (const entry of byPlayerSeason.values()) {
      if (entry.residuals.length < 6) continue;
      const count = entry.residuals.length;
      const mean = entry.residuals.reduce((sum, value) => sum + value, 0) / count;
      const variance =
        entry.residuals.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (count - 1);
      const list = centerResidualsByPosition.get(entry.position) ?? [];
      list.push({ mean, count, variance });
      centerResidualsByPosition.set(entry.position, list);
    }
  }
  const centerVolatilityFor = (position: string): number => {
    const groups = centerResidualsByPosition.get(position) ?? [];
    if (groups.length < 20) return 0.25;
    const grandMean = groups.reduce((sum, group) => sum + group.mean, 0) / groups.length;
    const betweenVariance =
      groups.reduce((sum, group) => sum + (group.mean - grandMean) ** 2, 0) / (groups.length - 1);
    const samplingVariance =
      groups.reduce((sum, group) => sum + group.variance / group.count, 0) / groups.length;
    return clamp(Math.sqrt(Math.max(betweenVariance - samplingVariance, 0.0025)), 0.05, 0.5);
  };
  const scheduleIndex = scheduledWeeksByTeamSeason(schedules);
  const snapChangesByPosition = new Map<string, number[]>();
  const byPlayer = new Map<string, FirstPartyWeeklyStatLine[]>();
  for (const row of training) {
    const rows = byPlayer.get(row.playerId) ?? [];
    rows.push(row);
    byPlayer.set(row.playerId, rows);
  }
  const cvsByPosition = new Map<string, number[]>();
  const fourWeekResidualsByPosition = new Map<string, number[]>();
  for (const rows of byPlayer.values()) {
    rows.sort((left, right) => ordinal(left) - ordinal(right));
    // Snap-share log-changes over consecutive scheduled opportunities feed role innovation.
    for (let index = 1; index < rows.length; index += 1) {
      const previous = rows[index - 1]!;
      const next = rows[index]!;
      if (
        previous.played === false ||
        next.played === false ||
        previous.snapShare === undefined ||
        next.snapShare === undefined ||
        previous.snapShare <= 0 ||
        next.snapShare <= 0 ||
        !isConsecutiveScheduledTransition(scheduleIndex, previous, next)
      ) {
        continue;
      }
      const position = previous.position.trim().toUpperCase();
      const changes = snapChangesByPosition.get(position) ?? [];
      changes.push(Math.log(clamp(next.snapShare, 0.05, 1) / clamp(previous.snapShare, 0.05, 1)));
      snapChangesByPosition.set(position, changes);
    }
    // Within-season weekly fantasy-point CV of relevant player-seasons feeds the iid production
    // moment; trailing-form four-week-ahead log residuals feed the persistent role moment.
    const bySeason = new Map<number, number[]>();
    for (const row of rows) {
      if (row.played === false) continue;
      const points = scoreProjectionStatComponents(row.components, scoringProfile);
      const values = bySeason.get(row.season) ?? [];
      values.push(points);
      bySeason.set(row.season, values);
    }
    const position = rows[0]!.position.trim().toUpperCase();
    for (const values of bySeason.values()) {
      if (values.length < 5) continue;
      const meanPoints = values.reduce((sum, value) => sum + value, 0) / values.length;
      if (meanPoints < 4) continue;
      const variance =
        values.reduce((sum, value) => sum + (value - meanPoints) ** 2, 0) / (values.length - 1);
      const cvs = cvsByPosition.get(position) ?? [];
      cvs.push(Math.sqrt(variance) / meanPoints);
      cvsByPosition.set(position, cvs);
      // Non-overlapping four-week-ahead residuals against the trailing four-game mean: the
      // predictive dispersion of exactly the multi-week totals the ROS intervals must cover.
      for (let index = 4; index + 4 <= values.length; index += 4) {
        const trailingMean =
          (values[index - 4]! + values[index - 3]! + values[index - 2]! + values[index - 1]!) / 4;
        const forwardSum =
          values[index]! + values[index + 1]! + values[index + 2]! + values[index + 3]!;
        if (trailingMean < 2 || forwardSum < 1) continue;
        const residual = clamp(Math.log(forwardSum / (4 * trailingMean)), -1.5, 1.5);
        const residuals = fourWeekResidualsByPosition.get(position) ?? [];
        residuals.push(residual);
        fourWeekResidualsByPosition.set(position, residuals);
      }
    }
  }
  const median = (values: readonly number[]): number => {
    const ordered = [...values].sort((left, right) => left - right);
    const middle = Math.floor(ordered.length / 2);
    return ordered.length % 2 === 0
      ? (ordered[middle - 1]! + ordered[middle]!) / 2
      : ordered[middle]!;
  };
  const roleFor = (position: string): FirstPartyRosRoleInput => {
    const changes = snapChangesByPosition.get(position) ?? [];
    let innovationVolatility = 0.05;
    if (changes.length >= 30) {
      const center = changes.reduce((sum, value) => sum + value, 0) / changes.length;
      const deviation = Math.sqrt(
        changes.reduce((sum, value) => sum + (value - center) ** 2, 0) / (changes.length - 1),
      );
      innovationVolatility = clamp(deviation * 0.5, 0.05, 0.35);
    }
    const cvs = cvsByPosition.get(position) ?? [];
    const residuals = fourWeekResidualsByPosition.get(position) ?? [];
    let weeklyProductionVolatility = 0.5;
    if (cvs.length >= 20) {
      const cv = median(cvs);
      const weeklyLogVariance = Math.log(1 + cv * cv);
      if (residuals.length >= 30) {
        // Two-moment matching for the transient components. With the static center error handled
        // separately (it cancels out of both moments because each is measured against the
        // player's own realized level), the AR(1) role state p_t (persistence 0.82) and the iid
        // shock e_t satisfy approximately:
        //   V1 (within-season weekly log-variance)          ~ 0.7 * Var(p) + Var(e)
        //   V4 (4wk-forward vs 4wk-trailing log residual)   ~ 0.3 * Var(p) + 0.5 * V1
        // where 0.7 reflects the average within-season decorrelation of p_t and V4's constants
        // fold the block-mean correlations of adjacent four-week windows plus both windows'
        // sampling noise. Solving: Var(p) = (V4 - 0.5*V1)/0.3, Var(e) = V1 - 0.7*Var(p).
        const residualMean = residuals.reduce((sum, value) => sum + value, 0) / residuals.length;
        const fourWeekLogVariance =
          residuals.reduce((sum, value) => sum + (value - residualMean) ** 2, 0) /
          (residuals.length - 1);
        const persistentVariance = clamp(
          (fourWeekLogVariance - 0.5 * weeklyLogVariance) / 0.3,
          0.0025,
          0.36,
        );
        const iidVariance = clamp(weeklyLogVariance - 0.7 * persistentVariance, 0.01, 1.44);
        innovationVolatility = clamp(
          Math.sqrt(persistentVariance * (1 - ROS_ROLE_PERSISTENCE ** 2)),
          0.05,
          0.5,
        );
        weeklyProductionVolatility = clamp(Math.sqrt(iidVariance), 0.1, 1.2);
      } else {
        const stationaryRoleVariance = innovationVolatility ** 2 / (1 - ROS_ROLE_PERSISTENCE ** 2);
        weeklyProductionVolatility = clamp(
          Math.sqrt(Math.max(weeklyLogVariance - stationaryRoleVariance, 0.0025)),
          0.1,
          1.2,
        );
      }
    }
    return {
      currentMultiplier: 1,
      persistence: ROS_ROLE_PERSISTENCE,
      innovationVolatility,
      weeklyProductionVolatility,
      centerVolatility: centerVolatilityFor(position),
      minimumMultiplier: 0.2,
      maximumMultiplier: 3,
    };
  };
  const byPosition: Record<string, FirstPartyRosRoleInput> = {};
  for (const position of HISTORICAL_ROS_SUPPORTED_POSITIONS) {
    byPosition[position] = roleFor(position);
  }
  return {
    version: HISTORICAL_ROS_ROLE_CALIBRATION_VERSION,
    byPosition,
    fallback: {
      currentMultiplier: 1,
      persistence: ROS_ROLE_PERSISTENCE,
      innovationVolatility: 0.05,
      weeklyProductionVolatility: 0.5,
      centerVolatility: 0.25,
      minimumMultiplier: 0.2,
      maximumMultiplier: 3,
    },
  };
}

export function historicalRosComponentElasticities(
  contextual: ProjectionStatComponents,
  recency: ProjectionStatComponents,
) {
  return Object.fromEntries(
    [...new Set([...Object.keys(contextual), ...Object.keys(recency)])].sort().map((component) => [
      component,
      component.endsWith("_probability")
        ? { role: 0, production: 0 }
        : {
            role: 1,
            production:
              component.includes("attempt") || component === "targets" || component === "carries"
                ? 0.5
                : component.includes("touchdown") || component.includes("interception")
                  ? 1.2
                  : 1,
          },
    ]),
  );
}

function zeroDefenseComponents(): ProjectionStatComponents {
  return Object.fromEntries(
    firstPartyTeamDefenseProjectionComponents().map((component) => [component, 0]),
  );
}

function zeroComponents(position: FirstPartyProjectionPosition): ProjectionStatComponents {
  return Object.fromEntries(
    firstPartyProjectionComponentsForPosition(position).map((component) => [component, 0]),
  );
}

function scheduleForTeam(
  schedules: readonly ProjectionScheduleFact[],
  season: number,
  week: number,
  team: string,
): ProjectionScheduleFact | undefined {
  return schedules.find(
    (row) =>
      row.season === season &&
      row.week === week &&
      (row.awayTeam === team || row.homeTeam === team),
  );
}

function opponentFor(game: ProjectionScheduleFact, team: string): string {
  return game.awayTeam === team ? game.homeTeam : game.awayTeam;
}

export function historicalRosAsOfAt(
  schedules: readonly ProjectionScheduleFact[],
  season: number,
  asOfWeek: number,
): string {
  const timestamps = schedules
    .filter((row) => row.season === season && row.week <= asOfWeek && row.kickoffAt !== null)
    .flatMap((row) => (row.kickoffAt ? [row.kickoffAt.getTime()] : []));
  if (timestamps.length === 0) return new Date(Date.UTC(season, 8, 1 + asOfWeek)).toISOString();
  return new Date(Math.max(...timestamps) + 12 * 60 * 60 * 1_000).toISOString();
}

function aggregateActual(input: {
  readonly history: readonly FirstPartyWeeklyStatLine[];
  readonly playerId: string;
  readonly season: number;
  readonly windowStartWeek: number;
  readonly windowEndWeek: number;
  readonly scoringProfile: ProjectionScoringProfile;
}) {
  const rows = input.history.filter(
    (row) =>
      row.playerId === input.playerId &&
      row.season === input.season &&
      row.week >= input.windowStartWeek &&
      row.week <= input.windowEndWeek,
  );
  const components: Record<string, number> = {};
  for (const row of rows) {
    for (const [component, value] of Object.entries(row.components)) {
      components[component] = (components[component] ?? 0) + value;
    }
  }
  return {
    actualGames: new Set(
      rows.filter((row) => row.played !== false).map((row) => `${row.season}:${row.week}`),
    ).size,
    actualPoints: scoreProjectionStatComponents(components, input.scoringProfile),
  };
}

function aggregateDefenseActual(input: {
  readonly history: readonly FirstPartyTeamDefenseWeeklyStatLine[];
  readonly team: string;
  readonly season: number;
  readonly windowStartWeek: number;
  readonly windowEndWeek: number;
  readonly scoringProfile: ProjectionScoringProfile;
}) {
  const rows = input.history.filter(
    (row) =>
      row.team === input.team &&
      row.season === input.season &&
      row.week >= input.windowStartWeek &&
      row.week <= input.windowEndWeek,
  );
  return {
    actualGames: new Set(
      rows.filter((row) => row.played !== false).map((row) => `${row.season}:${row.week}`),
    ).size,
    actualPoints: rows.reduce(
      (sum, row) => sum + scoreProjectionStatComponents(row.components, input.scoringProfile),
      0,
    ),
  };
}

function projectionIsUsable(projection: FirstPartyWeeklyProjection, scheduled: boolean): boolean {
  return !scheduled || projection.state === "projected" || projection.state === "zero";
}

function convergenceChecksum(input: {
  readonly season: number;
  readonly position: FirstPartyRosPosition;
  readonly bucket: FirstPartyRosRemainingWeeksBucket;
  readonly strategy: "contextual" | "availability-aware-recency";
  readonly diagnostics: readonly FirstPartyRosConvergenceDiagnostic[];
}): string {
  return historicalRosChecksum({ version: "stratified-convergence-v2", ...input });
}

function createDraft(input: {
  readonly player: CandidatePlayer;
  readonly season: number;
  readonly asOfWeek: number;
  readonly featureHistory: readonly FirstPartyWeeklyStatLine[];
  readonly outcomeHistory: readonly FirstPartyWeeklyStatLine[];
  readonly calibration: FirstPartyProjectionCalibration;
  readonly availabilityCalibration: HistoricalRosAvailabilityCalibration;
  readonly roleCalibration: HistoricalRosRoleCalibration;
  readonly injuries: readonly ProjectionInjuryFact[];
  readonly schedules: readonly ProjectionScheduleFact[];
  readonly scoringProfile: ProjectionScoringProfile;
}): HistoricalRosDraft | null {
  const windowStartWeek = input.asOfWeek + 1;
  const windowEndWeek = 18;
  const injury = latestInjuryStatus(
    input.injuries,
    input.player.playerId,
    input.season,
    input.asOfWeek,
  );
  const status = firstPartyPlayerStatus(
    input.player.rosterStatus,
    injury?.reportStatus,
    injury?.practiceStatus,
  );
  const availabilityStreak = historicalRosActiveStreak(
    input.featureHistory,
    input.player.playerId,
    input.season,
    input.asOfWeek,
    input.schedules,
  );
  // Personal trailing availability over the player's own rows (current season through the cutoff
  // plus the two prior seasons), blended toward the stratum asymptote inside the accessor.
  const personalRows = input.featureHistory.filter(
    (row) =>
      row.playerId === input.player.playerId &&
      row.season >= input.season - 2 &&
      (row.season < input.season || row.week <= input.asOfWeek),
  );
  const personalAvailable = personalRows.filter(
    (row) => row.played !== false && !inactiveStatuses.has(row.status ?? "unknown"),
  ).length;
  const personal = {
    rate: personalRows.length === 0 ? 0 : personalAvailable / personalRows.length,
    trials: personalRows.length,
  };
  const availabilityState = statusState(status);
  const availabilityBase = historicalRosAvailabilityFor(
    input.availabilityCalibration,
    input.player.position,
    availabilityStreak,
    availabilityState,
    personal,
  );
  const role =
    input.roleCalibration.byPosition[input.player.position] ?? input.roleCalibration.fallback;
  const weeks = [];
  const fingerprints = [];
  const roleContext = firstPartyRecentRoleContext(input.featureHistory, input.player.playerId);
  let contextualPresent = 0;
  let recencyPresent = 0;
  let scheduledGames = 0;
  for (let week = windowStartWeek; week <= windowEndWeek; week += 1) {
    const game = scheduleForTeam(input.schedules, input.season, week, input.player.team);
    const scheduled = game !== undefined;
    if (scheduled) scheduledGames += 1;
    const target = {
      playerId: input.player.playerId,
      position: input.player.position,
      season: input.season,
      week,
      team: input.player.team,
      ...(game ? { opponent: opponentFor(game, input.player.team) } : {}),
      scheduled,
      isBye: !scheduled,
      status: "active" as const,
      ...(roleContext ? { role: roleContext } : {}),
    };
    const contextual = projectFirstPartyWeeklyComponents({
      target,
      history: input.featureHistory,
      calibration: input.calibration,
    });
    const recency = projectFirstPartyRecencyBaselineComponents({
      target,
      history: input.featureHistory,
      calibration: input.calibration,
    });
    if (!projectionIsUsable(contextual, scheduled) || !projectionIsUsable(recency, scheduled)) {
      return null;
    }
    if (scheduled && contextual.state !== "unavailable") contextualPresent += 1;
    if (scheduled && recency.state !== "unavailable") recencyPresent += 1;
    const contextualComponents = scheduled
      ? contextual.components
      : zeroComponents(input.player.position);
    const recencyComponents = scheduled
      ? recency.components
      : zeroComponents(input.player.position);
    weeks.push({
      season: input.season,
      week,
      scheduled,
      bye: !scheduled,
      contextualComponents,
      recencyComponents,
      componentElasticities: historicalRosComponentElasticities(
        contextualComponents,
        recencyComponents,
      ),
    });
    fingerprints.push({
      week,
      contextual: contextual.provenance.inputFingerprint,
      recency: recency.provenance.inputFingerprint,
    });
  }
  const asOfAt = historicalRosAsOfAt(input.schedules, input.season, input.asOfWeek);
  const availability = { state: availabilityState, ...availabilityBase };
  const inputChecksum = historicalRosChecksum({
    version: "historical-ros-input-v2",
    playerId: input.player.playerId,
    position: input.player.position,
    team: input.player.team,
    selectionTier: input.player.selectionTier,
    season: input.season,
    asOfWeek: input.asOfWeek,
    asOfAt,
    windowStartWeek,
    windowEndWeek,
    fingerprints,
    availability,
    availabilityStreak,
    availabilityCalibrationVersion: input.availabilityCalibration.version,
    role,
    roleCalibrationVersion: input.roleCalibration.version,
    scoringProfileKey: projectionScoringProfileKey(input.scoringProfile),
  });
  const common = {
    playerId: input.player.playerId,
    position: input.player.position,
    season: input.season,
    asOfWeek: input.asOfWeek,
    asOfAt,
    windowStartWeek,
    windowEndWeek,
    weeks,
    availability,
    role,
    scoringProfile: input.scoringProfile,
    inputChecksum,
    weeklyModelVersion: HISTORICAL_ROS_CANDIDATE_PAIR_VERSION,
    seed: `historical:${input.season}:${input.asOfWeek}:${input.player.playerId}`,
  } as const;
  const contextualInput: FirstPartyRosProjectionInput = { ...common, strategy: "contextual" };
  const recencyInput: FirstPartyRosProjectionInput = {
    ...common,
    strategy: "availability-aware-recency",
  };
  const contextual = projectFirstPartyRestOfSeason(contextualInput);
  const recency = projectFirstPartyRestOfSeason(recencyInput);
  const actual = aggregateActual({
    history: input.outcomeHistory,
    playerId: input.player.playerId,
    season: input.season,
    windowStartWeek,
    windowEndWeek,
    scoringProfile: input.scoringProfile,
  });
  const contextualModelVersion = `${FIRST_PARTY_ROS_MODEL_VERSION}:contextual:${FIRST_PARTY_PROJECTION_MODEL_VERSION}`;
  const recencyModelVersion = `${FIRST_PARTY_ROS_MODEL_VERSION}:availability-aware-recency:${FIRST_PARTY_PROJECTION_MODEL_VERSION}`;
  return {
    forecast: {
      playerId: input.player.playerId,
      position: input.player.position,
      contextualModelVersion,
      recencyModelVersion,
      scoringProfileKey: projectionScoringProfileKey(input.scoringProfile),
      intervalMethodVersion: HISTORICAL_ROS_INTERVAL_METHOD_VERSION,
      forecastSeason: input.season,
      asOfWeek: input.asOfWeek,
      windowStartWeek,
      windowEndWeek,
      trainedThroughSeason: input.season - 1,
      inputChecksum,
      contextual: {
        meanPoints: contextual.meanPoints,
        p15Points: contextual.p15Points,
        p50Points: contextual.p50Points,
        p85Points: contextual.p85Points,
      },
      recency: {
        meanPoints: recency.meanPoints,
        p15Points: recency.p15Points,
        p50Points: recency.p50Points,
        p85Points: recency.p85Points,
      },
      actualPoints: actual.actualPoints,
    },
    contextualInput,
    recencyInput,
    coverage: {
      contextual: scheduledGames === 0 ? 0 : contextualPresent / scheduledGames,
      recency: scheduledGames === 0 ? 0 : recencyPresent / scheduledGames,
    },
    actualGames: actual.actualGames,
    scheduledGames,
    contextualExpectedGames: contextual.expectedGames,
    recencyExpectedGames: recency.expectedGames,
  };
}

function createDefenseDraft(input: {
  readonly defense: CandidateDefense;
  readonly season: number;
  readonly asOfWeek: number;
  readonly featureHistory: readonly FirstPartyTeamDefenseWeeklyStatLine[];
  /** Canonical actual components from the official weekly D/ST expanding-window backtest. */
  readonly outcomeHistory: readonly FirstPartyTeamDefenseWeeklyStatLine[];
  readonly calibration: FirstPartyTeamDefenseCalibration;
  readonly schedules: readonly ProjectionScheduleFact[];
  readonly scoringProfile: ProjectionScoringProfile;
}): HistoricalRosDraft | null {
  const windowStartWeek = input.asOfWeek + 1;
  const windowEndWeek = 18;
  const weeks = [];
  const fingerprints = [];
  let scheduledGames = 0;
  let contextualPresent = 0;
  let recencyPresent = 0;
  for (let week = windowStartWeek; week <= windowEndWeek; week += 1) {
    const game = scheduleForTeam(input.schedules, input.season, week, input.defense.team);
    const scheduled = game !== undefined;
    if (scheduled) scheduledGames += 1;
    const target = {
      team: input.defense.team,
      season: input.season,
      week,
      ...(game ? { opponent: opponentFor(game, input.defense.team) } : {}),
      scheduled,
      isBye: !scheduled,
    };
    const contextual = projectFirstPartyTeamDefenseComponents({
      target,
      history: input.featureHistory,
      calibration: input.calibration,
    });
    const recency = projectFirstPartyTeamDefenseRecencyBaselineComponents({
      target,
      history: input.featureHistory,
    });
    if (scheduled && contextual.state !== "projected") return null;
    if (scheduled) {
      contextualPresent += 1;
      recencyPresent += 1;
    }
    const contextualComponents = scheduled ? contextual.components : zeroDefenseComponents();
    const recencyComponents = scheduled ? recency : zeroDefenseComponents();
    weeks.push({
      season: input.season,
      week,
      scheduled,
      bye: !scheduled,
      contextualComponents,
      recencyComponents,
      componentElasticities: historicalRosComponentElasticities(
        contextualComponents,
        recencyComponents,
      ),
    });
    fingerprints.push({
      week,
      contextual: contextual.provenance.inputFingerprint,
      recency: historicalRosChecksum({
        version: `${FIRST_PARTY_PROJECTION_MODEL_VERSION}:defense-recency-adapter-v1`,
        target,
        components: recencyComponents,
        strictPriorHistoryFingerprint: contextual.provenance.inputFingerprint,
      }),
    });
  }
  const playerId = `DST:${input.defense.team}`;
  const asOfAt = historicalRosAsOfAt(input.schedules, input.season, input.asOfWeek);
  const availability: FirstPartyRosAvailabilityInput = {
    state: "active",
    newAbsenceProbability: 0,
    recoveryProbability: 1,
    reserveRecoveryProbability: 1,
    limitedRoleMultiplier: 1,
    returnRoleMultiplier: 1,
  };
  const role: FirstPartyRosRoleInput = {
    currentMultiplier: 1,
    persistence: 1,
    innovationVolatility: 0,
    weeklyProductionVolatility: 0.15,
    minimumMultiplier: 1,
    maximumMultiplier: 1,
  };
  const inputChecksum = historicalRosChecksum({
    version: "historical-ros-defense-input-v2",
    playerId,
    position: "DST",
    team: input.defense.team,
    selectionTier: input.defense.selectionTier,
    season: input.season,
    asOfWeek: input.asOfWeek,
    asOfAt,
    windowStartWeek,
    windowEndWeek,
    fingerprints,
    availability,
    role,
    scoringProfileKey: projectionScoringProfileKey(input.scoringProfile),
  });
  const common = {
    playerId,
    position: "DST" as const,
    season: input.season,
    asOfWeek: input.asOfWeek,
    asOfAt,
    windowStartWeek,
    windowEndWeek,
    weeks,
    availability,
    role,
    scoringProfile: input.scoringProfile,
    inputChecksum,
    weeklyModelVersion: HISTORICAL_ROS_CANDIDATE_PAIR_VERSION,
    seed: `historical:${input.season}:${input.asOfWeek}:${playerId}`,
  } as const;
  const contextualInput: FirstPartyRosProjectionInput = { ...common, strategy: "contextual" };
  const recencyInput: FirstPartyRosProjectionInput = {
    ...common,
    strategy: "availability-aware-recency",
  };
  const contextual = projectFirstPartyRestOfSeason(contextualInput);
  const recency = projectFirstPartyRestOfSeason(recencyInput);
  const actual = aggregateDefenseActual({
    history: input.outcomeHistory,
    team: input.defense.team,
    season: input.season,
    windowStartWeek,
    windowEndWeek,
    scoringProfile: input.scoringProfile,
  });
  return {
    forecast: {
      playerId,
      position: "DST",
      contextualModelVersion: `${FIRST_PARTY_ROS_MODEL_VERSION}:contextual:${FIRST_PARTY_PROJECTION_MODEL_VERSION}`,
      recencyModelVersion: `${FIRST_PARTY_ROS_MODEL_VERSION}:availability-aware-recency:${FIRST_PARTY_PROJECTION_MODEL_VERSION}`,
      scoringProfileKey: projectionScoringProfileKey(input.scoringProfile),
      intervalMethodVersion: HISTORICAL_ROS_INTERVAL_METHOD_VERSION,
      forecastSeason: input.season,
      asOfWeek: input.asOfWeek,
      windowStartWeek,
      windowEndWeek,
      trainedThroughSeason: input.season - 1,
      inputChecksum,
      contextual: {
        meanPoints: contextual.meanPoints,
        p15Points: contextual.p15Points,
        p50Points: contextual.p50Points,
        p85Points: contextual.p85Points,
      },
      recency: {
        meanPoints: recency.meanPoints,
        p15Points: recency.p15Points,
        p50Points: recency.p50Points,
        p85Points: recency.p85Points,
      },
      actualPoints: actual.actualPoints,
    },
    contextualInput,
    recencyInput,
    coverage: {
      contextual: scheduledGames === 0 ? 0 : contextualPresent / scheduledGames,
      recency: scheduledGames === 0 ? 0 : recencyPresent / scheduledGames,
    },
    actualGames: actual.actualGames,
    scheduledGames,
    contextualExpectedGames: contextual.expectedGames,
    recencyExpectedGames: recency.expectedGames,
  };
}

function stratumKey(input: {
  readonly season: number;
  readonly position: FirstPartyRosPosition;
  readonly windowStartWeek: number;
  readonly windowEndWeek: number;
}): string {
  return `${input.season}:${input.position}:${historicalRosBucket(input.windowStartWeek, input.windowEndWeek)}`;
}

export interface HistoricalRosConvergenceAuditEntry {
  readonly season: number;
  readonly position: FirstPartyRosPosition;
  readonly bucket: FirstPartyRosRemainingWeeksBucket;
  readonly strategy: "contextual" | "availability-aware-recency";
  readonly state: "converged" | "unstable";
  /** The statistic with the largest difference relative to its declared tolerance. */
  readonly worstMetric: string;
  /** Absolute difference over allowed difference; above one means the stratum failed. */
  readonly worstToleranceRatio: number;
}

interface ConvergenceStrategyEvidence {
  readonly state: "converged" | "unstable";
  readonly checksum: string;
  readonly worstMetric: string;
  readonly worstToleranceRatio: number;
}

function convergenceEvidence(drafts: readonly HistoricalRosDraft[]): ReadonlyMap<
  string,
  {
    readonly contextual: ConvergenceStrategyEvidence;
    readonly recency: ConvergenceStrategyEvidence;
  }
> {
  const byStratum = new Map<string, HistoricalRosDraft[]>();
  for (const draft of drafts) {
    const key = stratumKey({
      season: draft.forecast.forecastSeason,
      position: draft.forecast.position,
      windowStartWeek: draft.forecast.windowStartWeek,
      windowEndWeek: draft.forecast.windowEndWeek,
    });
    const values = byStratum.get(key) ?? [];
    values.push(draft);
    byStratum.set(key, values);
  }
  const result = new Map<
    string,
    {
      readonly contextual: ConvergenceStrategyEvidence;
      readonly recency: ConvergenceStrategyEvidence;
    }
  >();
  for (const [key, values] of byStratum) {
    const sample = [...values].sort((left, right) => {
      const leftHash = historicalRosChecksum(left.forecast.inputChecksum);
      const rightHash = historicalRosChecksum(right.forecast.inputChecksum);
      return leftHash.localeCompare(rightHash);
    })[0]!;
    const contextualDiagnostics = [diagnoseFirstPartyRosConvergence(sample.contextualInput)];
    const recencyDiagnostics = [diagnoseFirstPartyRosConvergence(sample.recencyInput)];
    const position = sample.forecast.position;
    const bucket = historicalRosBucket(
      sample.forecast.windowStartWeek,
      sample.forecast.windowEndWeek,
    );
    const strategyEvidence = (
      strategy: "contextual" | "availability-aware-recency",
      diagnostics: readonly FirstPartyRosConvergenceDiagnostic[],
    ): ConvergenceStrategyEvidence => {
      const worst = diagnostics.reduce((current, candidate) =>
        candidate.worstToleranceRatio > current.worstToleranceRatio ? candidate : current,
      );
      return {
        state: diagnostics.every((diagnostic) => diagnostic.state === "converged")
          ? "converged"
          : "unstable",
        checksum: convergenceChecksum({
          season: sample.forecast.forecastSeason,
          position,
          bucket,
          strategy,
          diagnostics,
        }),
        worstMetric: worst.worstMetric,
        worstToleranceRatio: worst.worstToleranceRatio,
      };
    };
    result.set(key, {
      contextual: strategyEvidence("contextual", contextualDiagnostics),
      recency: strategyEvidence("availability-aware-recency", recencyDiagnostics),
    });
  }
  return result;
}

export function evaluateHistoricalRosCells(input: {
  readonly forecasts: readonly FirstPartyRosHeldOutForecast[];
  readonly minimumSamples: number;
  readonly minimumCutoffs: number;
  readonly minimumBatches: number;
  readonly minimumSeasons: number;
}): readonly HistoricalRosCellEvidence[] {
  const positions: readonly FirstPartyRosPosition[] = ["QB", "RB", "WR", "TE", "K", "DST"];
  const buckets: readonly FirstPartyRosRemainingWeeksBucket[] = [
    "nine-plus",
    "five-to-eight",
    "one-to-four",
  ];
  return positions.flatMap((position) =>
    buckets.map((bucket) => {
      const rows = input.forecasts.filter(
        (forecast) =>
          forecast.position === position &&
          historicalRosBucket(forecast.windowStartWeek, forecast.windowEndWeek) === bucket,
      );
      const seasons = new Set(rows.map((row) => row.forecastSeason)).size;
      const cutoffs = new Set(rows.map((row) => row.asOfWeek)).size;
      const batches = new Set(rows.map((row) => `${row.forecastSeason}:${row.asOfWeek}`)).size;
      const reasons = [
        ...(seasons < input.minimumSeasons ? ["insufficient_seasons"] : []),
        ...(cutoffs < input.minimumCutoffs ? ["insufficient_cutoffs"] : []),
        ...(batches < input.minimumBatches ? ["insufficient_batches"] : []),
        ...(rows.length < input.minimumSamples ? ["insufficient_samples"] : []),
      ];
      return {
        position,
        bucket,
        seasons,
        cutoffs,
        batches,
        samples: rows.length,
        ready: reasons.length === 0,
        reasons,
      };
    }),
  );
}

export function buildHistoricalRosBacktest(
  input: HistoricalRosBacktestInput,
): HistoricalRosBacktestResult {
  const options = resolveOptions(input.options);
  const qualifiedSeasons = new Set(input.coverage.fullyHeldOutSeasons);
  const drafts: HistoricalRosDraft[] = [];
  // The official D/ST backtest is also the canonical raw-outcome normalizer: its `actual` rows
  // materialize one-hot points-allowed buckets. These rows are joined only after each forecast.
  const defenseOutcomeHistory = canonicalHistoricalRosDefenseOutcomes(input.defenseHistory);
  input.onProgress?.({ stage: "defense-outcomes-ready", forecasts: drafts.length });
  let skippedForecasts = 0;
  for (const season of options.heldOutSeasons) {
    if (!qualifiedSeasons.has(season)) continue;
    const training = historicalRosTrainingRows(input.history, season);
    if (training.length === 0) continue;
    const weeklyBacktest = runFirstPartyProjectionBacktest(training);
    const calibration = weeklyBacktest.calibration;
    const defenseTraining = historicalRosDefenseTrainingRows(input.defenseHistory, season);
    if (defenseTraining.length === 0) continue;
    const defenseCalibration = runFirstPartyTeamDefenseBacktest(defenseTraining).calibration;
    const availabilityCalibration = calibrateHistoricalRosAvailability(
      training,
      input.schedules,
      input.scoringProfile,
    );
    const roleCalibration = calibrateHistoricalRosRole(
      training,
      input.schedules,
      input.scoringProfile,
      weeklyBacktest.predictions,
    );
    input.onProgress?.({
      stage: "season-calibration-ready",
      season,
      forecasts: drafts.length,
    });
    const coverageSeason = input.coverage.seasons.find((candidate) => candidate.season === season);
    for (const asOfWeek of options.asOfWeeks) {
      const coverageWeek = coverageSeason?.weeks.find(
        (week) => week.asOfWeek === asOfWeek && week.complete,
      );
      if (!coverageWeek) continue;
      const features = historicalRosFeatureRows(input.history, season, asOfWeek);
      const defenseFeatures = historicalRosDefenseFeatureRows(
        input.defenseHistory,
        season,
        asOfWeek,
      );
      const players = selectHistoricalRosPlayers({
        history: features,
        rosters: input.rosters,
        season,
        asOfWeek,
        scoringProfile: input.scoringProfile,
        playersPerPosition: options.playersPerPosition,
      });
      for (const player of players) {
        if (drafts.length >= options.maximumForecasts) break;
        const draft = createDraft({
          player,
          season,
          asOfWeek,
          featureHistory: features,
          outcomeHistory: input.history,
          calibration,
          availabilityCalibration,
          roleCalibration,
          injuries: input.injuries,
          schedules: input.schedules,
          scoringProfile: input.scoringProfile,
        });
        if (draft) drafts.push(draft);
        else skippedForecasts += 1;
      }
      const defenses = selectHistoricalRosDefenses({
        history: historicalRosDefenseFeatureRows(defenseOutcomeHistory, season, asOfWeek),
        season,
        asOfWeek,
        scoringProfile: input.scoringProfile,
        teams: options.playersPerPosition,
      });
      for (const defense of defenses) {
        if (drafts.length >= options.maximumForecasts) break;
        const draft = createDefenseDraft({
          defense,
          season,
          asOfWeek,
          featureHistory: defenseFeatures,
          outcomeHistory: defenseOutcomeHistory,
          calibration: defenseCalibration,
          schedules: input.schedules,
          scoringProfile: input.scoringProfile,
        });
        if (draft) drafts.push(draft);
        else skippedForecasts += 1;
      }
    }
    input.onProgress?.({ stage: "season-forecasts-ready", season, forecasts: drafts.length });
  }
  input.onProgress?.({ stage: "convergence-started", forecasts: drafts.length });
  const convergence = convergenceEvidence(drafts);
  input.onProgress?.({
    stage: "convergence-ready",
    forecasts: drafts.length,
    convergenceStrata: convergence.size,
  });
  const forecasts = drafts.map((draft): FirstPartyRosHeldOutForecast => {
    const key = stratumKey({
      season: draft.forecast.forecastSeason,
      position: draft.forecast.position,
      windowStartWeek: draft.forecast.windowStartWeek,
      windowEndWeek: draft.forecast.windowEndWeek,
    });
    const diagnostic = convergence.get(key);
    if (!diagnostic) throw new Error(`Missing convergence diagnostic for ${key}`);
    return {
      ...draft.forecast,
      evidence: {
        coverage: draft.coverage,
        availability: {
          scheduledGames: draft.scheduledGames,
          actualGames: Math.min(draft.actualGames, draft.scheduledGames),
          contextualExpectedGames: draft.contextualExpectedGames,
          recencyExpectedGames: draft.recencyExpectedGames,
        },
        convergence: {
          contextual: {
            state: diagnostic.contextual.state,
            diagnosticChecksum: diagnostic.contextual.checksum,
          },
          recency: {
            state: diagnostic.recency.state,
            diagnosticChecksum: diagnostic.recency.checksum,
          },
        },
      },
    };
  });
  const heldOutSeasons = options.heldOutSeasons
    .filter((season) => qualifiedSeasons.has(season))
    .map((season): FirstPartyRosHeldOutSeason => ({
      season,
      complete: true,
      forecasts: forecasts.filter((forecast) => forecast.forecastSeason === season),
    }));
  const batches = new Set(
    forecasts.map((forecast) => `${forecast.forecastSeason}:${forecast.asOfWeek}`),
  );
  const cells = evaluateHistoricalRosCells({
    forecasts,
    minimumSamples: options.minimumCellSamples,
    minimumCutoffs: options.minimumCellCutoffs,
    minimumBatches: options.minimumCellBatches,
    minimumSeasons: options.minimumCellSeasons,
  });
  const champion = evaluateFirstPartyRosChampionPolicy(heldOutSeasons, {
    minimumHeldOutSeasons: 3,
    minimumBatches: options.minimumPortfolioBatches,
    minimumSamples: options.minimumPortfolioForecasts,
    minimumCellSamples: options.minimumCellSamples,
    minimumCellSeasons: options.minimumCellSeasons,
    minimumCellCutoffs: options.minimumCellCutoffs,
    minimumCellBatches: options.minimumCellBatches,
  });
  input.onProgress?.({
    stage: "evaluation-ready",
    forecasts: forecasts.length,
    convergenceStrata: convergence.size,
  });
  const blockers = [
    ...(heldOutSeasons.length < 3 ? ["fewer_than_three_qualified_heldout_seasons"] : []),
    ...(batches.size < options.minimumPortfolioBatches
      ? ["portfolio_cutoff_batches_below_minimum"]
      : []),
    ...(forecasts.length < options.minimumPortfolioForecasts
      ? ["portfolio_forecasts_below_minimum"]
      : []),
    ...cells
      .filter((cell) => !cell.ready)
      .map((cell) => `cell_${cell.position}_${cell.bucket}_${cell.reasons.join("+")}`),
    ...champion.livePolicy.choices
      .filter(
        (choice) => choice.reason.startsWith("insufficient") || choice.reason === "sparse-cell",
      )
      .map((choice) => `champion_${choice.position}_${choice.bucket}_${choice.reason}`),
    ...historicalRosCalibrationBlockers(champion.livePolicy.choices),
  ];
  return {
    heldOutSeasons,
    champion,
    report: {
      state: blockers.length === 0 ? "evidence-ready" : "insufficient",
      seasons: heldOutSeasons.map((season) => season.season),
      forecasts: forecasts.length,
      batches: batches.size,
      diagnosedPairs: convergence.size,
      skippedForecasts,
      playersPerPosition: options.playersPerPosition,
      maximumForecasts: options.maximumForecasts,
      leakagePolicy: {
        calibration: "seasons-strictly-before-heldout",
        features: "strictly-before-cutoff",
        futureRosterUse: false,
        targetOutcomeUse: "evaluation-only",
      },
      selectionPolicy: {
        strategy: "recent-production-stratified",
        tiers: ["high", "middle", "lower"],
        excludesNonPositiveRecentProduction: true,
      },
      unsupportedPositions: [],
      blockers: [...new Set(blockers)],
      cells,
      availabilityCalibrationVersion: HISTORICAL_ROS_AVAILABILITY_CALIBRATION_VERSION,
      roleCalibrationVersion: HISTORICAL_ROS_ROLE_CALIBRATION_VERSION,
      convergenceAudit: [...convergence.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .flatMap(([key, evidence]): HistoricalRosConvergenceAuditEntry[] => {
          const [season, position, bucket] = key.split(":") as [
            string,
            FirstPartyRosPosition,
            FirstPartyRosRemainingWeeksBucket,
          ];
          return (
            [
              ["contextual", evidence.contextual],
              ["availability-aware-recency", evidence.recency],
            ] as const
          ).map(([strategy, candidate]) => ({
            season: Number(season),
            position,
            bucket,
            strategy,
            state: candidate.state,
            worstMetric: candidate.worstMetric,
            worstToleranceRatio: candidate.worstToleranceRatio,
          }));
        }),
    },
  };
}
