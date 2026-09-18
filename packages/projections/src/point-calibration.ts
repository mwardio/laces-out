import {
  evaluateFirstPartyBacktestForScoringProfile,
  type FirstPartyPointResidualCalibration,
  type FirstPartyProjectionBacktest,
  type FirstPartyProjectionPosition,
  type FirstPartyScoredBacktestEvaluation,
} from "./first-party.js";
import { leagueScoringPositionComponents } from "./league-scoring.js";
import {
  scoreProjectionStatComponents,
  SCORING_LONG_TOUCHDOWN_COMPONENTS,
  type ProjectionScoringProfile,
  type ProjectionStatComponents,
} from "./scoring.js";

/** A point-layer policy; physical component forecasts and their model version are unchanged. */
export const WEEKLY_POINT_CALIBRATION_POLICY_VERSION =
  "prior-affine-or-additive-sqrt-mean-point-v3";
export const UNCALIBRATED_STARTER_INTERVALS = "uncalibrated_starter_intervals";
export const UNCALIBRATED_STARTER_MEANS = "uncalibrated_starter_means";
const MINIMUM_FIT_SAMPLES = 24;
const WINDOW_BATCHES = 8;
const STARTER_COUNTS = { RB: 24, WR: 36, TE: 12 } as const;

export type WeeklyPointCenterStrategy = "affine" | "additive";

export interface WeeklyPointCalibrationOptions {
  /** RB/WR/TE default to affine centers; their normalized interval treatment is unchanged. */
  readonly centerStrategyByPosition?: Readonly<
    Partial<Record<FirstPartyProjectionPosition, WeeklyPointCenterStrategy>>
  >;
}

export interface StarterIntervalQuality {
  readonly state: "available" | "insufficient" | "miscalibrated";
  readonly cohort: "prior-baseline-position-rank";
  readonly topPlayersPerWeek: number;
  readonly samples: number;
  readonly coverage: number | null;
  readonly minimumSamples: 100;
  readonly minimumCoverage: 0.6;
  readonly maximumCoverage: 0.8;
  readonly qualityFlag?: typeof UNCALIBRATED_STARTER_INTERVALS;
}

/** Conditional point evidence comes from locked chronological forecasts, never the live refit. */
export interface StarterMeanQuality {
  readonly state: "available" | "insufficient" | "miscalibrated";
  readonly cohort: "prior-baseline-position-rank";
  readonly topPlayersPerWeek: number;
  readonly samples: number;
  readonly mae: number | null;
  readonly rmse: number | null;
  readonly baselineRmse: number | null;
  /** Match the residual convention: actual minus forecast. */
  readonly bias: number | null;
  readonly biasLimit: number | null;
  readonly minimumSamples: 100;
  readonly maximumRelativeBias: 0.15;
  readonly qualityFlag?: typeof UNCALIBRATED_STARTER_MEANS;
}

export interface WeeklyPointResidualCalibration extends FirstPartyPointResidualCalibration {
  readonly componentCoverage?: {
    readonly state: "unavailable";
    readonly missingStatIds: readonly string[];
    readonly reason: "missing-priced-long-touchdown-components";
  };
  readonly pointPolicy?:
    | {
        readonly version: typeof WEEKLY_POINT_CALIBRATION_POLICY_VERSION;
        readonly slope: number;
        readonly intercept: number;
        readonly intervalScale: "sqrt-absolute-raw";
        readonly lowerNormalizedError: number;
        readonly upperNormalizedError: number;
        readonly trainingSamples: number;
        readonly intervalSamples: number;
      }
    | undefined;
  readonly starterIntervalQuality?: StarterIntervalQuality | undefined;
  readonly starterMeanQuality?: StarterMeanQuality | undefined;
}

export interface WeeklyPointCalibrationEvaluation extends FirstPartyScoredBacktestEvaluation {
  readonly pointPolicyVersion: typeof WEEKLY_POINT_CALIBRATION_POLICY_VERSION;
  readonly byPosition: Readonly<
    Partial<Record<FirstPartyProjectionPosition, WeeklyPointResidualCalibration>>
  >;
}

interface RawForecast {
  readonly playerId: string;
  readonly season: number;
  readonly week: number;
  readonly position: FirstPartyProjectionPosition;
  readonly rawMean: number;
  readonly baselineRawMean: number;
  readonly actual: number;
}

export interface LockedPointForecast extends RawForecast {
  readonly mean: number;
  readonly baselineMean: number;
  readonly floor?: number;
  readonly ceiling?: number;
  readonly priorBaselineRank: number;
  readonly trainedThrough: number | null;
}

interface PointFit {
  readonly slope: number;
  readonly intercept: number;
  readonly lowerError: number;
  readonly upperError: number;
  readonly normalized: boolean;
  readonly trainingSamples: number;
  readonly intervalSamples: number;
  readonly trainedThrough: number | null;
}

const ordinal = (row: { readonly season: number; readonly week: number }) =>
  row.season * 25 + row.week;
const mean = (values: readonly number[]) =>
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
const rawScale = (rawMean: number) => Math.sqrt(Math.max(1, Math.abs(rawMean)));

/** An old immutable row without event counts is unknown, never an observed zero. */
export function missingLongTouchdownScoringComponents(
  components: ProjectionStatComponents,
  profile: ProjectionScoringProfile,
  position: string,
): readonly string[] {
  const normalizedPosition = position.toUpperCase();
  if (
    normalizedPosition !== "QB" &&
    normalizedPosition !== "RB" &&
    normalizedPosition !== "WR" &&
    normalizedPosition !== "TE"
  )
    return [];
  const vocabulary = leagueScoringPositionComponents(normalizedPosition);
  const longTouchdowns = new Set<string>(
    SCORING_LONG_TOUCHDOWN_COMPONENTS.flatMap((group) => [group.fortyPlus, group.fiftyPlus]),
  );
  return profile.rules
    .filter(
      (rule) =>
        longTouchdowns.has(rule.statId) &&
        vocabulary.has(rule.statId) &&
        (rule.points !== 0 || (rule.bonuses ?? []).some((bonus) => bonus.points !== 0)) &&
        !Number.isFinite(components[rule.statId]),
    )
    .map((rule) => rule.statId);
}

function quantile(values: readonly number[], probability: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = (sorted.length - 1) * probability;
  const lower = sorted[Math.floor(index)] ?? 0;
  return lower + ((sorted[Math.ceil(index)] ?? lower) - lower) * (index - Math.floor(index));
}

function recentRows<T extends { readonly season: number; readonly week: number }>(
  rows: readonly T[],
): readonly T[] {
  const weeks = [...new Set(rows.map(ordinal))].sort((left, right) => left - right);
  const selected = new Set(weeks.slice(-WINDOW_BATCHES));
  return rows.filter((row) => selected.has(ordinal(row)));
}

function usesNormalizedIntervals(
  position: FirstPartyProjectionPosition,
): position is keyof typeof STARTER_COUNTS {
  return Object.hasOwn(STARTER_COUNTS, position);
}

function fitPointPolicy(
  prior: readonly LockedPointForecast[],
  position: FirstPartyProjectionPosition,
  centerStrategy: WeeklyPointCenterStrategy = "affine",
): PointFit {
  const recent = recentRows(prior);
  const normalized = usesNormalizedIntervals(position);
  const affineCenter = normalized && centerStrategy === "affine";
  let slope = 1;
  let intercept = 0;
  if (recent.length >= MINIMUM_FIT_SAMPLES) {
    const xbar = mean(recent.map((row) => row.rawMean));
    const ybar = mean(recent.map((row) => row.actual));
    if (affineCenter) {
      const xx = recent.reduce((sum, row) => sum + (row.rawMean - xbar) ** 2, 0);
      const xy = recent.reduce((sum, row) => sum + (row.rawMean - xbar) * (row.actual - ybar), 0);
      if (xx > 1e-12) {
        slope = Math.max(0, Math.min(1, (recent.length * (xy / xx) + 24) / (recent.length + 24)));
      }
    }
    // Preserve the baseline's exact residual summation order for additive centers, including
    // unchanged QB/K scoring. Subtracting separately averaged actual/raw values can round apart.
    intercept = affineCenter
      ? ybar - slope * xbar
      : mean(recent.map((row) => row.actual - row.rawMean));
  }
  const intervalRows = normalized ? recent : prior;
  const errors = intervalRows.map(
    (row) => (row.actual - row.mean) / (normalized ? rawScale(row.rawMean) : 1),
  );
  return {
    slope,
    intercept,
    lowerError: quantile(errors, 0.15),
    upperError: quantile(errors, 0.85),
    normalized,
    trainingSamples: recent.length,
    intervalSamples: errors.length,
    trainedThrough: prior.length === 0 ? null : Math.max(...prior.map(ordinal)),
  };
}

function calibrationFromFit(
  fit: PointFit,
): Pick<
  WeeklyPointResidualCalibration,
  "centerAdjustment" | "lowerError" | "upperError" | "pointPolicy"
> {
  return {
    centerAdjustment: fit.intercept,
    lowerError: fit.lowerError,
    upperError: fit.upperError,
    ...(fit.normalized
      ? {
          pointPolicy: {
            version: WEEKLY_POINT_CALIBRATION_POLICY_VERSION,
            slope: fit.slope,
            intercept: fit.intercept,
            intervalScale: "sqrt-absolute-raw" as const,
            lowerNormalizedError: fit.lowerError,
            upperNormalizedError: fit.upperError,
            trainingSamples: fit.trainingSamples,
            intervalSamples: fit.intervalSamples,
          },
        }
      : {}),
  };
}

/** Release replay and live publication share this exact transformation of raw scored points. */
export function applyWeeklyPointCalibration(
  rawMean: number,
  calibration: Pick<
    WeeklyPointResidualCalibration,
    "centerAdjustment" | "lowerError" | "upperError" | "pointPolicy"
  >,
): { readonly mean: number; readonly floor: number; readonly ceiling: number } {
  if (!Number.isFinite(rawMean)) throw new RangeError("Raw fantasy forecast must be finite");
  const policy = calibration.pointPolicy;
  const center =
    policy === undefined
      ? rawMean + calibration.centerAdjustment
      : policy.slope * rawMean + policy.intercept;
  const scale = policy === undefined ? 1 : rawScale(rawMean);
  const lower = center + scale * (policy?.lowerNormalizedError ?? calibration.lowerError);
  const upper = center + scale * (policy?.upperNormalizedError ?? calibration.upperError);
  return {
    mean: center,
    floor: Math.min(center, lower, upper),
    ceiling: Math.max(center, lower, upper),
  };
}

export function weeklyPointEvidenceConfidence(
  confidence: number,
  calibration: WeeklyPointResidualCalibration,
  position?: string,
): number {
  const finite = Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0;
  const requiresEvidence =
    position !== undefined && Object.hasOwn(STARTER_COUNTS, position.toUpperCase());
  if (calibration.pointPolicy === undefined && !requiresEvidence) return finite;
  const quality = calibration.starterIntervalQuality;
  const reliableIntervals =
    quality?.state === "available" &&
    quality.samples >= 100 &&
    quality.coverage !== null &&
    Number.isFinite(quality.coverage) &&
    quality.coverage >= 0.6 &&
    quality.coverage <= 0.8;
  const point = calibration.starterMeanQuality;
  const reliableMean =
    point?.state === "available" &&
    point.samples >= 100 &&
    point.mae !== null &&
    Number.isFinite(point.mae) &&
    point.mae >= 0 &&
    point.rmse !== null &&
    Number.isFinite(point.rmse) &&
    point.rmse >= 0 &&
    point.baselineRmse !== null &&
    Number.isFinite(point.baselineRmse) &&
    point.baselineRmse > 0 &&
    point.rmse <= point.baselineRmse &&
    point.bias !== null &&
    Number.isFinite(point.bias) &&
    Math.abs(point.bias) <= 0.15 * point.mae;
  return reliableIntervals && reliableMean ? finite : Math.min(0.49, finite);
}

/** Stored metadata is provenance, not a trusted runtime policy object. */
export function storedWeeklyPointPolicyVersion(metadata: unknown): string | undefined {
  const record = (value: unknown): Record<string, unknown> | undefined =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const live = record(record(metadata)?.livePointCalibration);
  if (live?.policyVersion !== WEEKLY_POINT_CALIBRATION_POLICY_VERSION) return undefined;
  const positions = record(live.byPosition);
  if (positions === undefined) return undefined;
  for (const position of Object.keys(STARTER_COUNTS)) {
    const entry = positions[position];
    if (entry === undefined || entry === null) continue;
    const calibration = record(entry);
    const policy = record(calibration?.pointPolicy);
    if (
      policy?.version !== WEEKLY_POINT_CALIBRATION_POLICY_VERSION ||
      policy.intervalScale !== "sqrt-absolute-raw"
    )
      return undefined;
    const finite = (value: unknown): value is number =>
      typeof value === "number" && Number.isFinite(value);
    if (
      !finite(policy.slope) ||
      policy.slope < 0 ||
      policy.slope > 1 ||
      !finite(policy.intercept) ||
      !finite(policy.lowerNormalizedError) ||
      !finite(policy.upperNormalizedError) ||
      policy.lowerNormalizedError > policy.upperNormalizedError ||
      !Number.isSafeInteger(policy.trainingSamples) ||
      Number(policy.trainingSamples) < 0 ||
      !Number.isSafeInteger(policy.intervalSamples) ||
      Number(policy.intervalSamples) < 0
    )
      return undefined;
    const starter = record(calibration?.starterMeanQuality);
    if (
      !finite(calibration?.rmse) ||
      calibration.rmse < 0 ||
      !finite(calibration.baselineRmse) ||
      calibration.baselineRmse <= 0 ||
      calibration.rmse > calibration.baselineRmse ||
      starter?.cohort !== "prior-baseline-position-rank" ||
      starter.topPlayersPerWeek !== STARTER_COUNTS[position as keyof typeof STARTER_COUNTS] ||
      starter.minimumSamples !== 100 ||
      starter.maximumRelativeBias !== 0.15 ||
      !Number.isSafeInteger(starter.samples) ||
      Number(starter.samples) < 100 ||
      !finite(starter.mae) ||
      starter.mae < 0 ||
      !finite(starter.rmse) ||
      starter.rmse < 0 ||
      !finite(starter.baselineRmse) ||
      starter.baselineRmse <= 0 ||
      starter.rmse > starter.baselineRmse ||
      !finite(starter.bias) ||
      !["available", "miscalibrated"].includes(String(starter.state))
    )
      return undefined;
  }
  return WEEKLY_POINT_CALIBRATION_POLICY_VERSION;
}

function starterQuality(
  rows: readonly LockedPointForecast[],
  position: keyof typeof STARTER_COUNTS,
): StarterIntervalQuality {
  const covered = rows.filter(
    (row) =>
      row.priorBaselineRank <= STARTER_COUNTS[position] &&
      row.floor !== undefined &&
      row.ceiling !== undefined,
  );
  const coverage =
    covered.length === 0
      ? null
      : mean(
          covered.map((row) =>
            row.actual >= (row.floor ?? 0) && row.actual <= (row.ceiling ?? 0) ? 1 : 0,
          ),
        );
  const state =
    covered.length < 100 || coverage === null
      ? "insufficient"
      : coverage < 0.6 || coverage > 0.8
        ? "miscalibrated"
        : "available";
  return {
    state,
    cohort: "prior-baseline-position-rank",
    topPlayersPerWeek: STARTER_COUNTS[position],
    samples: covered.length,
    coverage,
    minimumSamples: 100,
    minimumCoverage: 0.6,
    maximumCoverage: 0.8,
    ...(state === "available" ? {} : { qualityFlag: UNCALIBRATED_STARTER_INTERVALS }),
  };
}

function starterMeanQuality(
  rows: readonly LockedPointForecast[],
  position: keyof typeof STARTER_COUNTS,
): StarterMeanQuality {
  const starters = rows.filter((row) => row.priorBaselineRank <= STARTER_COUNTS[position]);
  const errors = starters.map((row) => row.actual - row.mean);
  const mae = starters.length === 0 ? null : mean(errors.map(Math.abs));
  const rmse = starters.length === 0 ? null : Math.sqrt(mean(errors.map((error) => error ** 2)));
  const baselineRmse =
    starters.length === 0
      ? null
      : Math.sqrt(mean(starters.map((row) => (row.actual - row.baselineMean) ** 2)));
  const bias = starters.length === 0 ? null : mean(errors);
  const biasLimit = mae === null ? null : 0.15 * mae;
  const sufficient =
    starters.length >= 100 &&
    [mae, rmse, baselineRmse, bias].every((value) => value !== null && Number.isFinite(value)) &&
    baselineRmse !== null &&
    baselineRmse > 0;
  const state = !sufficient
    ? "insufficient"
    : Math.abs(bias!) > biasLimit!
      ? "miscalibrated"
      : "available";
  return {
    state,
    cohort: "prior-baseline-position-rank",
    topPlayersPerWeek: STARTER_COUNTS[position],
    samples: starters.length,
    mae,
    rmse,
    baselineRmse,
    bias,
    biasLimit,
    minimumSamples: 100,
    maximumRelativeBias: 0.15,
    ...(state === "available" ? {} : { qualityFlag: UNCALIBRATED_STARTER_MEANS }),
  };
}

function metrics(
  rows: readonly LockedPointForecast[],
  original: FirstPartyPointResidualCalibration,
): FirstPartyPointResidualCalibration {
  const errors = rows.map((row) => row.actual - row.mean);
  const mae = mean(errors.map(Math.abs));
  const baselineMae = mean(rows.map((row) => Math.abs(row.actual - row.baselineMean)));
  const covered = rows.filter((row) => row.floor !== undefined && row.ceiling !== undefined);
  return {
    ...original,
    samples: rows.length,
    lowerError: quantile(errors, 0.15),
    upperError: quantile(errors, 0.85),
    mae,
    rmse: Math.sqrt(mean(errors.map((error) => error ** 2))),
    bias: mean(errors),
    baselineMae,
    baselineRmse: Math.sqrt(mean(rows.map((row) => (row.actual - row.baselineMean) ** 2))),
    improvement: baselineMae === 0 ? (mae === 0 ? 0 : -1) : (baselineMae - mae) / baselineMae,
    beatsBaseline: mae < baselineMae,
    intervalCoverage:
      covered.length === 0
        ? null
        : mean(
            covered.map((row) =>
              row.actual >= (row.floor ?? 0) && row.actual <= (row.ceiling ?? 0) ? 1 : 0,
            ),
          ),
    intervalCoverageSamples: covered.length,
  };
}

/** No target outcome is consumed until every forecast in that NFL week has been frozen. */
export function replayWeeklyPointCalibration(
  backtest: FirstPartyProjectionBacktest,
  profile: ProjectionScoringProfile,
  options: WeeklyPointCalibrationOptions = {},
): {
  readonly evaluation: WeeklyPointCalibrationEvaluation;
  readonly forecasts: readonly LockedPointForecast[];
} {
  const unavailable = new Map<FirstPartyProjectionPosition, Set<string>>();
  for (const row of backtest.predictions) {
    const missing = [row.predicted, row.baseline, row.actual].flatMap((components) =>
      missingLongTouchdownScoringComponents(components, profile, row.position),
    );
    if (missing.length === 0) continue;
    const stats = unavailable.get(row.position) ?? new Set<string>();
    for (const stat of missing) stats.add(stat);
    unavailable.set(row.position, stats);
  }
  // Withhold the affected position completely: dropping only unknown games would select an
  // easier, nonrepresentative evaluation population. Other independently scored positions survive.
  const completeBacktest =
    unavailable.size === 0
      ? backtest
      : {
          ...backtest,
          predictions: backtest.predictions.filter((row) => !unavailable.has(row.position)),
        };
  const legacy = evaluateFirstPartyBacktestForScoringProfile(completeBacktest, profile);
  const scored: RawForecast[] = completeBacktest.predictions
    .map((row) => ({
      playerId: row.playerId,
      season: row.season,
      week: row.week,
      position: row.position,
      rawMean: scoreProjectionStatComponents(row.predicted, profile),
      baselineRawMean: scoreProjectionStatComponents(row.baseline, profile),
      actual: scoreProjectionStatComponents(row.actual, profile),
    }))
    .sort(
      (left, right) =>
        ordinal(left) - ordinal(right) || left.playerId.localeCompare(right.playerId),
    );
  const seen = new Set<string>();
  const batches = new Map<number, RawForecast[]>();
  for (const row of scored) {
    const identity = `${row.playerId}:${ordinal(row)}`;
    if (seen.has(identity)) throw new Error("Duplicate locked player/week forecast");
    seen.add(identity);
    const batch = batches.get(ordinal(row)) ?? [];
    batch.push(row);
    batches.set(ordinal(row), batch);
  }
  const forecasts: LockedPointForecast[] = [];
  const prior = new Map<FirstPartyProjectionPosition, LockedPointForecast[]>();
  for (const [week, batch] of batches) {
    const locked: LockedPointForecast[] = [];
    for (const position of new Set(batch.map((row) => row.position))) {
      const history = prior.get(position) ?? [];
      const fit = fitPointPolicy(history, position, options.centerStrategyByPosition?.[position]);
      if (fit.trainedThrough !== null && fit.trainedThrough >= week)
        throw new Error("Point calibration used future evidence");
      const recent = recentRows(history);
      const baselineAdjustment =
        recent.length < MINIMUM_FIT_SAMPLES
          ? 0
          : mean(recent.map((row) => row.actual - row.baselineRawMean));
      const ranked = batch
        .filter((row) => row.position === position)
        .sort(
          (left, right) =>
            right.baselineRawMean - left.baselineRawMean ||
            left.playerId.localeCompare(right.playerId),
        );
      for (const [index, row] of ranked.entries()) {
        const projected = applyWeeklyPointCalibration(row.rawMean, calibrationFromFit(fit));
        locked.push({
          ...row,
          mean: projected.mean,
          baselineMean: row.baselineRawMean + baselineAdjustment,
          ...(fit.intervalSamples < MINIMUM_FIT_SAMPLES
            ? {}
            : { floor: projected.floor, ceiling: projected.ceiling }),
          priorBaselineRank: index + 1,
          trainedThrough: fit.trainedThrough,
        });
      }
    }
    // Keep a stable player ordering in the fitting rows, independent of rank/outcome changes.
    locked.sort((left, right) => left.playerId.localeCompare(right.playerId));
    forecasts.push(...locked);
    for (const row of locked) {
      const history = prior.get(row.position) ?? [];
      history.push(row);
      prior.set(row.position, history);
    }
  }
  const byPosition: Partial<Record<FirstPartyProjectionPosition, WeeklyPointResidualCalibration>> =
    { ...legacy.byPosition };
  for (const [position, rows] of prior) {
    const original = legacy.byPosition[position];
    if (original === undefined || !usesNormalizedIntervals(position)) continue;
    const fit = fitPointPolicy(rows, position, options.centerStrategyByPosition?.[position]);
    byPosition[position] = {
      ...metrics(rows, original),
      centerAdjustment: fit.intercept,
      pointPolicy: calibrationFromFit(fit).pointPolicy,
      starterIntervalQuality: starterQuality(rows, position),
      starterMeanQuality: starterMeanQuality(rows, position),
    };
  }
  for (const [position, missing] of unavailable) {
    byPosition[position] = {
      ...metrics([], legacy.overall),
      centerAdjustment: 0,
      componentCoverage: {
        state: "unavailable",
        missingStatIds: [...missing].sort(),
        reason: "missing-priced-long-touchdown-components",
      },
    };
  }
  return {
    evaluation: {
      ...legacy,
      pointPolicyVersion: WEEKLY_POINT_CALIBRATION_POLICY_VERSION,
      byPosition,
      byPlayer: {},
      overall: metrics(forecasts, legacy.overall),
    },
    forecasts,
  };
}

export function evaluateWeeklyPointCalibration(
  backtest: FirstPartyProjectionBacktest,
  profile: ProjectionScoringProfile,
  options: WeeklyPointCalibrationOptions = {},
): WeeklyPointCalibrationEvaluation {
  return replayWeeklyPointCalibration(backtest, profile, options).evaluation;
}
