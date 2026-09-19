import type { LockedPointForecast } from "./point-calibration.js";

/** Publication intervals only: neither the point center nor football components change. */
export const WEEKLY_INTERVAL_CALIBRATION_POLICY_VERSION = "prior-raw-score-two-bin-interval-v1";
export const WEEKLY_INTERVAL_PROVISIONAL_CONFIDENCE_CAP = 0.49;
const STARTER_COUNTS = { RB: 24, WR: 36, TE: 12 } as const;
export type WeeklyIntervalPosition = keyof typeof STARTER_COUNTS;
const MINIMUM_SAMPLES = 24;
const WINDOW_BATCHES = 8;

interface ResidualTails {
  readonly samples: number;
  readonly lower: number;
  readonly upper: number;
}

export interface WeeklyIntervalPolicy {
  readonly version: typeof WEEKLY_INTERVAL_CALIBRATION_POLICY_VERSION;
  readonly position: WeeklyIntervalPosition;
  readonly cutoff: number | null;
  readonly trainedThrough: number | null;
  readonly weekBatches: number;
  readonly pooled: ResidualTails | null;
  readonly below: ResidualTails | null;
  readonly above: ResidualTails | null;
}

export interface WeeklyIntervalMetrics {
  readonly samples: number;
  readonly coverage: number | null;
  readonly meanWidth: number | null;
  readonly meanIntervalScore: number | null;
}

export interface WeeklyIntervalEvidence extends WeeklyIntervalMetrics {
  readonly starters: WeeklyIntervalMetrics;
}

const ordinal = (row: Pick<LockedPointForecast, "season" | "week">) => row.season * 25 + row.week;
const scale = (rawMean: number) => Math.sqrt(Math.max(1, Math.abs(rawMean)));
const quantile = (values: readonly number[], probability: number) => {
  const sorted = [...values].sort((left, right) => left - right);
  const index = (sorted.length - 1) * probability;
  const lower = sorted[Math.floor(index)] ?? 0;
  return lower + ((sorted[Math.ceil(index)] ?? lower) - lower) * (index - Math.floor(index));
};

function tails(rows: readonly LockedPointForecast[]): ResidualTails | null {
  if (rows.length === 0) return null;
  const errors = rows.map((row) => (row.actual - row.mean) / scale(row.rawMean));
  return { samples: rows.length, lower: quantile(errors, 0.15), upper: quantile(errors, 0.85) };
}

export function isWeeklyIntervalPosition(position: string): position is WeeklyIntervalPosition {
  return Object.hasOwn(STARTER_COUNTS, position);
}

/** Callers supply completed, previously locked forecasts only, never the target batch. */
export function fitWeeklyIntervalPolicy(
  rows: readonly LockedPointForecast[],
  position: WeeklyIntervalPosition,
): WeeklyIntervalPolicy {
  const history = rows.filter((row) => row.position === position);
  const weeks = [...new Set(history.map(ordinal))]
    .sort((left, right) => left - right)
    .slice(-WINDOW_BATCHES);
  const selected = new Set(weeks);
  const recent = history.filter((row) => selected.has(ordinal(row)));
  const cutoffs = weeks.flatMap((week) => {
    const batch = recent
      .filter((row) => ordinal(row) === week)
      .sort(
        (left, right) =>
          right.rawMean - left.rawMean || left.playerId.localeCompare(right.playerId),
      );
    const threshold = batch[STARTER_COUNTS[position] - 1];
    return threshold === undefined ? [] : [threshold.rawMean];
  });
  const cutoff = cutoffs.length === 0 ? null : quantile(cutoffs, 0.5);
  return {
    version: WEEKLY_INTERVAL_CALIBRATION_POLICY_VERSION,
    position,
    cutoff,
    trainedThrough: weeks.at(-1) ?? null,
    weekBatches: weeks.length,
    pooled: tails(recent),
    below: cutoff === null ? null : tails(recent.filter((row) => row.rawMean < cutoff)),
    above: cutoff === null ? null : tails(recent.filter((row) => row.rawMean >= cutoff)),
  };
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const validTails = (value: unknown): value is ResidualTails | null =>
  value === null ||
  (object(value) &&
    Number.isSafeInteger(value.samples) &&
    Number(value.samples) > 0 &&
    finite(value.lower) &&
    finite(value.upper) &&
    value.lower <= value.upper);

/** Persisted metadata is not an executable policy until its complete shape is checked. */
export function isWeeklyIntervalPolicy(value: unknown): value is WeeklyIntervalPolicy {
  if (
    !object(value) ||
    value.version !== WEEKLY_INTERVAL_CALIBRATION_POLICY_VERSION ||
    typeof value.position !== "string" ||
    !isWeeklyIntervalPosition(value.position) ||
    !(value.cutoff === null || finite(value.cutoff)) ||
    !(value.trainedThrough === null || Number.isSafeInteger(value.trainedThrough)) ||
    !Number.isInteger(value.weekBatches) ||
    Number(value.weekBatches) < 0 ||
    Number(value.weekBatches) > WINDOW_BATCHES ||
    !validTails(value.pooled) ||
    !validTails(value.below) ||
    !validTails(value.above)
  )
    return false;
  if (value.weekBatches === 0)
    return (
      value.trainedThrough === null &&
      value.cutoff === null &&
      value.pooled === null &&
      value.below === null &&
      value.above === null
    );
  if (value.trainedThrough === null || value.pooled === null) return false;
  if (value.cutoff === null) return value.below === null && value.above === null;
  return (value.below?.samples ?? 0) + (value.above?.samples ?? 0) === value.pooled.samples;
}

export function weeklyIntervalPolicyIsUsable(value: unknown): value is WeeklyIntervalPolicy {
  return isWeeklyIntervalPolicy(value) && (value.pooled?.samples ?? 0) >= MINIMUM_SAMPLES;
}

/** Stored policies identify the original interval; they never recalibrate a kickoff-locked row. */
export function storedWeeklyIntervalPolicyProvenance(
  metadata: unknown,
  playerId: string,
):
  | {
      readonly version: typeof WEEKLY_INTERVAL_CALIBRATION_POLICY_VERSION;
      readonly position: WeeklyIntervalPosition;
    }
  | undefined {
  if (!object(metadata) || !object(metadata.intervalPolicyByPlayer)) return undefined;
  const row = metadata.intervalPolicyByPlayer[playerId];
  if (
    !object(row) ||
    row.version !== WEEKLY_INTERVAL_CALIBRATION_POLICY_VERSION ||
    (row.origin !== "current" && row.origin !== "frozen") ||
    typeof row.position !== "string" ||
    !isWeeklyIntervalPosition(row.position)
  )
    return undefined;
  const provenance = {
    version: WEEKLY_INTERVAL_CALIBRATION_POLICY_VERSION,
    position: row.position,
  } as const;
  // Current fits describe unlocked rows. A formerly published role can be withheld now without
  // invalidating the original interval, whose role/version survive in the frozen-row metadata.
  if (row.origin === "frozen")
    return object(metadata.frozenIntervalPolicyVersions) &&
      Object.hasOwn(metadata.frozenIntervalPolicyVersions, playerId) &&
      metadata.frozenIntervalPolicyVersions[playerId] === row.version
      ? provenance
      : undefined;
  if (
    !object(metadata.weeklyIntervalCalibration) ||
    metadata.weeklyIntervalCalibration.policyVersion !==
      WEEKLY_INTERVAL_CALIBRATION_POLICY_VERSION ||
    !object(metadata.weeklyIntervalCalibration.byPosition)
  )
    return undefined;
  const entry = metadata.weeklyIntervalCalibration.byPosition[row.position];
  return object(entry) &&
    isWeeklyIntervalPolicy(entry.policy) &&
    entry.policy.position === row.position
    ? provenance
    : undefined;
}

export function storedWeeklyIntervalPolicyVersion(
  metadata: unknown,
  playerId: string,
): string | undefined {
  return storedWeeklyIntervalPolicyProvenance(metadata, playerId)?.version;
}

/** Mean is passed through exactly. Invalid/sparse policy preserves the existing validated bounds. */
export function applyWeeklyIntervalPolicy(
  rawMean: number,
  original: { readonly mean: number; readonly floor: number; readonly ceiling: number },
  policy: unknown,
): { readonly mean: number; readonly floor: number; readonly ceiling: number } {
  if (!Number.isFinite(rawMean) || !weeklyIntervalPolicyIsUsable(policy)) return original;
  const bin =
    policy.cutoff === null ? policy.pooled : rawMean >= policy.cutoff ? policy.above : policy.below;
  const errors = (bin?.samples ?? 0) >= MINIMUM_SAMPLES ? bin : policy.pooled;
  if (errors === null) return original;
  const lower = original.mean + scale(rawMean) * errors.lower;
  const upper = original.mean + scale(rawMean) * errors.upper;
  if (!Number.isFinite(lower) || !Number.isFinite(upper)) return original;
  return {
    mean: original.mean,
    floor: Math.min(original.mean, lower, upper),
    ceiling: Math.max(original.mean, lower, upper),
  };
}

function metrics(rows: readonly LockedPointForecast[]): WeeklyIntervalMetrics {
  const eligible = rows.filter((row) => row.floor !== undefined && row.ceiling !== undefined);
  let covered = 0;
  let widths = 0;
  let scores = 0;
  for (const row of eligible) {
    const lower = row.floor!;
    const upper = row.ceiling!;
    const width = upper - lower;
    covered += Number(row.actual >= lower && row.actual <= upper);
    widths += width;
    scores +=
      width +
      (2 / 0.3) * Math.max(lower - row.actual, 0) +
      (2 / 0.3) * Math.max(row.actual - upper, 0);
  }
  return {
    samples: eligible.length,
    coverage: eligible.length === 0 ? null : covered / eligible.length,
    meanWidth: eligible.length === 0 ? null : widths / eligible.length,
    meanIntervalScore: eligible.length === 0 ? null : scores / eligible.length,
  };
}

/** Strategy and centers are already frozen; this replay changes interval endpoints only. */
export function replayWeeklyIntervalCalibration(rows: readonly LockedPointForecast[]): {
  readonly forecasts: readonly LockedPointForecast[];
  readonly byPosition: Readonly<Partial<Record<WeeklyIntervalPosition, WeeklyIntervalEvidence>>>;
  readonly policies: Readonly<Partial<Record<WeeklyIntervalPosition, WeeklyIntervalPolicy>>>;
} {
  const batches = new Map<number, LockedPointForecast[]>();
  for (const row of rows) {
    const key = ordinal(row);
    const batch = batches.get(key) ?? [];
    batch.push(row);
    batches.set(key, batch);
  }
  const history = new Map<WeeklyIntervalPosition, LockedPointForecast[]>();
  const forecasts: LockedPointForecast[] = [];
  for (const [week, batch] of [...batches].sort(([left], [right]) => left - right)) {
    const policies = new Map<WeeklyIntervalPosition, WeeklyIntervalPolicy>();
    for (const position of Object.keys(STARTER_COUNTS) as WeeklyIntervalPosition[]) {
      const policy = fitWeeklyIntervalPolicy(history.get(position) ?? [], position);
      if (policy.trainedThrough !== null && policy.trainedThrough >= week)
        throw new Error("Weekly interval policy used future evidence");
      policies.set(position, policy);
    }
    for (const row of batch) {
      if (
        !isWeeklyIntervalPosition(row.position) ||
        row.floor === undefined ||
        row.ceiling === undefined
      ) {
        forecasts.push(row);
        continue;
      }
      const interval = applyWeeklyIntervalPolicy(
        row.rawMean,
        { mean: row.mean, floor: row.floor, ceiling: row.ceiling },
        policies.get(row.position),
      );
      forecasts.push({ ...row, ...interval });
    }
    // Only after every target forecast is frozen may this week's outcomes enter a later fit.
    for (const row of batch) {
      if (!isWeeklyIntervalPosition(row.position)) continue;
      const prior = history.get(row.position) ?? [];
      prior.push(row);
      history.set(row.position, prior);
    }
  }
  const byPosition: Partial<Record<WeeklyIntervalPosition, WeeklyIntervalEvidence>> = {};
  const policies: Partial<Record<WeeklyIntervalPosition, WeeklyIntervalPolicy>> = {};
  for (const [position, prior] of history) {
    const projected = forecasts.filter((row) => row.position === position);
    byPosition[position] = {
      ...metrics(projected),
      starters: metrics(
        projected.filter((row) => row.priorBaselineRank <= STARTER_COUNTS[position]),
      ),
    };
    policies[position] = fitWeeklyIntervalPolicy(prior, position);
  }
  return { forecasts, byPosition, policies };
}
