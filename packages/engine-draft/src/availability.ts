export interface DraftAvailabilityInput {
  readonly meanAdp: number;
  readonly standardDeviation?: number;
  /** Number of drafts used by a source-supplied mean/deviation pair. */
  readonly distributionSampleSize?: number;
  readonly currentPick: number;
  readonly nextPick: number;
  /** Historical selections for the same source/scoring/league-size context. */
  readonly empiricalPicks?: readonly number[];
}

export interface DraftAvailabilityEstimate {
  /** Conditional probability that the player survives from now to nextPick. */
  readonly probabilityAvailable: number;
  readonly probabilitySelectedBeforeNextPick: number;
  readonly method: "empirical" | "normal";
  readonly sampleSize: number;
  readonly confidence: number;
  readonly meanAdp: number;
  readonly standardDeviation: number;
}

function erf(value: number): number {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value);
  const t = 1 / (1 + 0.3275911 * x);
  const polynomial =
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  return sign * (1 - polynomial * Math.exp(-x * x));
}

function normalSurvival(value: number, mean: number, standardDeviation: number): number {
  const z = (value - mean) / (standardDeviation * Math.sqrt(2));
  return Math.max(0, Math.min(1, 0.5 * (1 - erf(z))));
}

function validatePick(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 10_000) {
    throw new RangeError(`${label} must be a positive draft-pick integer`);
  }
}

/**
 * Estimates conditional survival rather than the unconditional chance implied
 * by ADP. A player known to be available at the current pick has already
 * survived part of the distribution; conditioning prevents that evidence from
 * being discarded. Empirical samples win when at least 20 valid observations
 * exist, otherwise a normal approximation is used.
 */
export function estimateDraftAvailability(
  input: DraftAvailabilityInput,
): DraftAvailabilityEstimate {
  if (!Number.isFinite(input.meanAdp) || input.meanAdp <= 0 || input.meanAdp > 10_000) {
    throw new RangeError("Mean ADP must be a positive finite number");
  }
  validatePick(input.currentPick, "Current pick");
  validatePick(input.nextPick, "Next pick");
  if (input.nextPick <= input.currentPick) {
    throw new RangeError("Next pick must occur after the current pick");
  }
  const suppliedDeviation = input.standardDeviation;
  if (
    suppliedDeviation !== undefined &&
    (!Number.isFinite(suppliedDeviation) || suppliedDeviation <= 0 || suppliedDeviation > 10_000)
  ) {
    throw new RangeError("ADP standard deviation must be a positive finite number");
  }
  if (
    input.distributionSampleSize !== undefined &&
    (!Number.isSafeInteger(input.distributionSampleSize) || input.distributionSampleSize < 0)
  ) {
    throw new RangeError("ADP distribution sample size must be a nonnegative integer");
  }
  const empirical = (input.empiricalPicks ?? []).filter(
    (value) => Number.isSafeInteger(value) && value > 0 && value <= 10_000,
  );
  const standardDeviation = suppliedDeviation ?? Math.max(6, input.meanAdp * 0.15);

  let probabilityAvailable: number;
  let method: DraftAvailabilityEstimate["method"];
  if (empirical.length >= 20) {
    const survivedCurrent = empirical.filter((pick) => pick >= input.currentPick).length;
    const survivedNext = empirical.filter((pick) => pick >= input.nextPick).length;
    probabilityAvailable = survivedCurrent === 0 ? 0 : survivedNext / survivedCurrent;
    method = "empirical";
  } else {
    // Half-pick continuity correction for integer draft positions.
    const currentSurvival = normalSurvival(
      input.currentPick - 0.5,
      input.meanAdp,
      standardDeviation,
    );
    const nextSurvival = normalSurvival(input.nextPick - 0.5, input.meanAdp, standardDeviation);
    probabilityAvailable = currentSurvival <= Number.EPSILON ? 0 : nextSurvival / currentSurvival;
    method = "normal";
  }
  probabilityAvailable = Math.max(0, Math.min(1, probabilityAvailable));
  const sampleSize =
    method === "empirical" ? empirical.length : (input.distributionSampleSize ?? 0);
  const confidence =
    method === "empirical"
      ? Math.min(1, sampleSize / 200)
      : suppliedDeviation === undefined
        ? 0.35
        : Math.min(0.85, 0.45 + sampleSize / 500);

  return {
    probabilityAvailable,
    probabilitySelectedBeforeNextPick: 1 - probabilityAvailable,
    method,
    sampleSize,
    confidence,
    meanAdp: input.meanAdp,
    standardDeviation,
  };
}
