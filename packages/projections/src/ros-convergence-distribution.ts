import {
  FIRST_PARTY_ROS_CONVERGENCE_REFERENCE_SCENARIOS,
  FIRST_PARTY_ROS_DEFAULT_SCENARIOS,
} from "./rest-of-season.js";
import { projectionScoringRulesFromProfileKey } from "./scoring-position-keys.js";
import { sha256Hex } from "./sha256.js";

/** A numerical measurement, not a convergence, calibration, or publication decision. */
export const ROS_CONVERGENCE_DISTRIBUTION_VERSION = "ros-convergence-distribution-v1";
export const ROS_CONVERGENCE_SCORE_VECTOR_VERSION = "ros-ordered-score-vector-v1";

const RELEASE_COUNT = FIRST_PARTY_ROS_DEFAULT_SCENARIOS;
const REFERENCE_COUNT = FIRST_PARTY_ROS_CONVERGENCE_REFERENCE_SCENARIOS;
const SUFFIX_COUNT = REFERENCE_COUNT - RELEASE_COUNT;
const PROBABILITIES = [0.15, 0.5, 0.85] as const;

export interface RosConvergenceDistributionProvenance {
  readonly modelVersion: string;
  readonly scorerVersion: string;
  /** Whole canonical scoring key; this helper cannot establish that the scores used it. */
  readonly scoringProfileKey: string;
  readonly seedHash: string;
  readonly inputChecksum: string;
  /** Caller-supplied checksum of the verified source vector, not authenticated here. */
  readonly vectorChecksum: string;
}

export interface RosConvergenceDistributionInput {
  /** Ordered left/right pairs. The release vector is structurally the exact 12,288 prefix. */
  readonly scores: readonly number[] | Float64Array;
  readonly provenance: RosConvergenceDistributionProvenance;
  /** Predeclared number of vectors in the family being claimed; selection/search must be included. */
  readonly familySize: number;
  /** Simultaneous error budget for that entire family, strictly between zero and one. */
  readonly familyErrorBudget: number;
}

export interface RosEmpiricalCdfRanks {
  readonly samples: number;
  readonly below: number;
  readonly equal: number;
  readonly atOrBelow: number;
  readonly belowFraction: number;
  readonly atOrBelowFraction: number;
}

export interface RosEmpiricalCdfDistance {
  readonly leftSamples: number;
  readonly rightSamples: number;
  /** Reduced exact nonnegative rational, independent of floating-point CDF subtraction. */
  readonly numerator: number;
  readonly denominator: number;
  readonly fraction: number;
  /** Smallest observed score attaining the supremum; ties are evaluated after their entire atom. */
  readonly score: number;
  readonly leftAtOrBelow: number;
  readonly rightAtOrBelow: number;
  readonly direction: "left-above" | "right-above" | "equal";
}

export type RosQuantileIdentificationEndpoint =
  | { readonly kind: "finite"; readonly value: number; readonly orderStatistic: number }
  | { readonly kind: "unbounded"; readonly direction: "below" | "above" };

export interface RosQuantileIdentificationBounds {
  readonly lowerProbability: number;
  readonly upperProbability: number;
  readonly lower: RosQuantileIdentificationEndpoint;
  readonly upper: RosQuantileIdentificationEndpoint;
}

interface PartitionRanks {
  readonly prefix: RosEmpiricalCdfRanks;
  readonly suffix: RosEmpiricalCdfRanks;
  readonly full: RosEmpiricalCdfRanks;
}

export interface RosConvergenceDistributionMeasurement {
  readonly schemaVersion: 1;
  readonly version: typeof ROS_CONVERGENCE_DISTRIBUTION_VERSION;
  readonly purpose: "numerical-measurement-only";
  readonly provenanceStatus: "caller-supplied-not-authenticated";
  readonly provenance: RosConvergenceDistributionProvenance;
  readonly scoreVectorVersion: typeof ROS_CONVERGENCE_SCORE_VECTOR_VERSION;
  /** Computed here from every supplied score in original pair order, with -0 normalized to 0. */
  readonly scoreVectorChecksum: string;
  readonly prefixSamples: number;
  readonly suffixSamples: number;
  readonly fullSamples: number;
  readonly pairing: {
    readonly convention: "adjacent-even-left-odd-right";
    readonly prefixEven: number;
    readonly prefixOdd: number;
    readonly suffixEven: number;
    readonly suffixOdd: number;
    readonly independenceStatus: "assumed-not-authenticated";
  };
  readonly prefixVsSuffix: RosEmpiricalCdfDistance;
  readonly prefixVsFull: RosEmpiricalCdfDistance;
  readonly forecastQuantileDefinition: "type-7";
  readonly quantileRanks: readonly {
    readonly probability: number;
    readonly prefixType7: number;
    readonly fullType7: number;
    readonly atPrefixType7: PartitionRanks;
    readonly atFullType7: PartitionRanks;
  }[];
  readonly precision: {
    readonly method: "four-stream-dkw-union-bound";
    readonly target: "fixed-simulator-pair-mixture-distribution";
    readonly assumption: "each-leg-stream-iid-with-fixed-leg-marginal-across-partitions";
    readonly familySize: number;
    readonly familyErrorBudget: number;
    readonly streamsPerVector: 4;
    /** log(8 * familySize / familyErrorBudget), computed without division or multiplication. */
    readonly logDkwFactor: number;
    readonly prefixCdfRadius: number;
    readonly suffixCdfRadius: number;
    readonly fullCdfRadius: number;
    readonly identificationQuantileDefinition: "inverse-empirical-cdf";
    readonly quantileBounds: readonly {
      readonly probability: number;
      readonly prefix: RosQuantileIdentificationBounds;
      readonly suffix: RosQuantileIdentificationBounds;
      readonly full: RosQuantileIdentificationBounds;
    }[];
  };
  /** Canonical JSON checksum of every preceding field; neither a signature nor an admission. */
  readonly evidenceChecksum: string;
}

function fail(message: string): never {
  throw new TypeError(`ROS convergence distribution: ${message}`);
}

function exactKeys(value: unknown, expected: readonly string[]): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("invalid object");
  const keys = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (keys.length !== sorted.length || keys.some((key, i) => key !== sorted[i]))
    fail("missing or unknown fields");
}

function boundedText(value: unknown, maximum: number): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum)
    fail("invalid bounded provenance text");
}

function digest(value: unknown): void {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value))
    fail("invalid provenance checksum");
}

function provenance(
  value: RosConvergenceDistributionProvenance,
): RosConvergenceDistributionProvenance {
  exactKeys(value, [
    "modelVersion",
    "scorerVersion",
    "scoringProfileKey",
    "seedHash",
    "inputChecksum",
    "vectorChecksum",
  ]);
  boundedText(value.modelVersion, 256);
  boundedText(value.scorerVersion, 256);
  boundedText(value.scoringProfileKey, 65_536);
  projectionScoringRulesFromProfileKey(value.scoringProfileKey);
  digest(value.seedHash);
  digest(value.inputChecksum);
  digest(value.vectorChecksum);
  return { ...value };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`)
      .join(",")}}`;
  }
  const result = JSON.stringify(value);
  if (result === undefined) fail("undefined measurement field");
  return result;
}

function copyScores(value: RosConvergenceDistributionInput["scores"]): number[] {
  if (
    (!Array.isArray(value) && !(value instanceof Float64Array)) ||
    value.length !== REFERENCE_COUNT ||
    Object.keys(value).length !== REFERENCE_COUNT
  )
    fail(`scores must contain exactly ${REFERENCE_COUNT} dense finite entries`);
  const copied: number[] = [];
  for (let index = 0; index < value.length; index++) {
    const score: unknown = value[index];
    if (!Object.hasOwn(value, index) || typeof score !== "number" || !Number.isFinite(score))
      fail("scores must be dense and finite");
    copied.push(score === 0 ? 0 : score);
  }
  return copied;
}

function merge(left: readonly number[], right: readonly number[]): number[] {
  const result: number[] = [];
  let a = 0;
  let b = 0;
  while (a < left.length || b < right.length) {
    if (b === right.length || (a < left.length && left[a]! <= right[b]!)) result.push(left[a++]!);
    else result.push(right[b++]!);
  }
  return result;
}

function gcd(a: number, b: number): number {
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

function cdfDistance(left: readonly number[], right: readonly number[]): RosEmpiricalCdfDistance {
  let a = 0;
  let b = 0;
  let largest = -1;
  let signed = 0;
  let score = 0;
  let leftAtOrBelow = 0;
  let rightAtOrBelow = 0;
  while (a < left.length || b < right.length) {
    const location =
      b === right.length || (a < left.length && left[a]! <= right[b]!) ? left[a]! : right[b]!;
    while (a < left.length && left[a] === location) a++;
    while (b < right.length && right[b] === location) b++;
    const difference = a * right.length - b * left.length;
    if (Math.abs(difference) > largest) {
      largest = Math.abs(difference);
      signed = difference;
      score = location;
      leftAtOrBelow = a;
      rightAtOrBelow = b;
    }
  }
  const denominator = left.length * right.length;
  const divisor = gcd(largest, denominator);
  return {
    leftSamples: left.length,
    rightSamples: right.length,
    numerator: largest / divisor,
    denominator: denominator / divisor,
    fraction: largest / denominator,
    score,
    leftAtOrBelow,
    rightAtOrBelow,
    direction: signed > 0 ? "left-above" : signed < 0 ? "right-above" : "equal",
  };
}

function ranks(ordered: readonly number[], score: number): RosEmpiricalCdfRanks {
  function bound(includeEqual: boolean): number {
    let lower = 0;
    let upper = ordered.length;
    while (lower < upper) {
      const middle = Math.floor((lower + upper) / 2);
      if (ordered[middle]! < score || (includeEqual && ordered[middle] === score))
        lower = middle + 1;
      else upper = middle;
    }
    return lower;
  }
  const below = bound(false);
  const atOrBelow = bound(true);
  return {
    samples: ordered.length,
    below,
    equal: atOrBelow - below,
    atOrBelow,
    belowFraction: below / ordered.length,
    atOrBelowFraction: atOrBelow / ordered.length,
  };
}

/** Keep the forecast's existing type-7 arithmetic; do not substitute an inverse-CDF quantile. */
function type7(ordered: readonly number[], probability: number): number {
  const offset = (ordered.length - 1) * probability;
  const lower = ordered[Math.floor(offset)]!;
  const upper = ordered[Math.ceil(offset)]!;
  const value = lower + (upper - lower) * (offset - Math.floor(offset));
  if (!Number.isFinite(value)) fail("type-7 arithmetic exceeds finite score range");
  return value === 0 ? 0 : value;
}

function quantileBounds(
  ordered: readonly number[],
  probability: number,
  radius: number,
): RosQuantileIdentificationBounds {
  const lowerProbability = probability - radius;
  const upperProbability = probability + radius;
  function inverse(q: number): RosQuantileIdentificationEndpoint {
    const orderStatistic = Math.ceil(ordered.length * q);
    return { kind: "finite", value: ordered[orderStatistic - 1]!, orderStatistic };
  }
  return {
    lowerProbability,
    upperProbability,
    lower:
      lowerProbability > 0 ? inverse(lowerProbability) : { kind: "unbounded", direction: "below" },
    upper:
      upperProbability <= 1 ? inverse(upperProbability) : { kind: "unbounded", direction: "above" },
  };
}

/**
 * Describes one verified score vector without authenticating its source or changing any gate.
 *
 * Conditional on a fixed simulator, each even/odd stream must be IID across pairs. The left leg
 * has fixed marginal F_L in both prefix and suffix, and the right leg has fixed marginal F_R in
 * both partitions; F_L need not equal F_R. The target is their equal mixture F=(F_L+F_R)/2,
 * which also covers sampler endpoint asymmetries. Legs within a pair may depend arbitrarily;
 * neither all-path independence nor independence between streams/vectors is assumed. A PRNG
 * seed or digest cannot prove these premises. The caller must verify generation, scoring, pair
 * order, and the predeclared family. IID across pairs is a modeling assumption about the PRNG.
 *
 * DKW gives P(sup|Fhat-F| > e) <= 2 exp(-2 n e²) for each stream. Assigning alpha/(4 M) to
 * each of four streams in each of M vectors gives e = sqrt(log(8 M/alpha)/(2 n)). A union bound
 * needs no cross-stream independence. Each band is about that leg's own F_L or F_R. Averaging
 * the two equal-length streams gives the prefix and suffix radii about F; the full radius is
 * their count-weighted average. This event covers all x and
 * hence all quantiles simultaneously, with no additional penalty for the three reported p values.
 *
 * On that event Qhat(p-e) <= Q_F(p) <= Qhat(p+e), where Q is the generalized inverse CDF.
 * For p-e <= 0 the lower endpoint is unbounded; for p+e > 1 the upper endpoint is unbounded.
 * At p+e = 1 the finite empirical maximum IS justified because F(max) >= 1-e = p. These bounds
 * identify quantiles of the simulator law, not real-world predictive coverage. They deliberately
 * differ from the type-7 point estimates used by the forecast. No radius or distance is a gate.
 */
export function measureRosConvergenceDistribution(
  input: RosConvergenceDistributionInput,
): RosConvergenceDistributionMeasurement {
  exactKeys(input, ["scores", "provenance", "familySize", "familyErrorBudget"]);
  if (!Number.isSafeInteger(input.familySize) || input.familySize < 1)
    fail("familySize must be a positive safe integer");
  if (
    typeof input.familyErrorBudget !== "number" ||
    !Number.isFinite(input.familyErrorBudget) ||
    input.familyErrorBudget <= 0 ||
    input.familyErrorBudget >= 1
  )
    fail("familyErrorBudget must be strictly between zero and one");
  // These are fixed protocol sizes, not configurable inputs; both cuts preserve adjacent pairs.
  if (RELEASE_COUNT !== 12_288 || REFERENCE_COUNT !== 16_384)
    fail("scenario counts changed; a new measurement version is required");
  const source = provenance(input.provenance);
  const scores = copyScores(input.scores);
  const scoreVectorChecksum = sha256Hex(
    canonical({ version: ROS_CONVERGENCE_SCORE_VECTOR_VERSION, scores }),
  );
  const prefix = scores.slice(0, RELEASE_COUNT).sort((a, b) => a - b);
  const suffix = scores.slice(RELEASE_COUNT).sort((a, b) => a - b);
  const full = merge(prefix, suffix);
  function allRanks(score: number): PartitionRanks {
    return { prefix: ranks(prefix, score), suffix: ranks(suffix, score), full: ranks(full, score) };
  }
  // Never form 8*M/alpha or alpha/(4*M): valid extreme inputs would overflow or underflow.
  const logDkwFactor = Math.log(8) + Math.log(input.familySize) - Math.log(input.familyErrorBudget);
  const prefixCdfRadius = Math.sqrt(logDkwFactor / RELEASE_COUNT);
  const suffixCdfRadius = Math.sqrt(logDkwFactor / SUFFIX_COUNT);
  const fullCdfRadius =
    (RELEASE_COUNT / REFERENCE_COUNT) * prefixCdfRadius +
    (SUFFIX_COUNT / REFERENCE_COUNT) * suffixCdfRadius;
  const measurement: Omit<RosConvergenceDistributionMeasurement, "evidenceChecksum"> = {
    schemaVersion: 1,
    version: ROS_CONVERGENCE_DISTRIBUTION_VERSION,
    purpose: "numerical-measurement-only",
    provenanceStatus: "caller-supplied-not-authenticated",
    provenance: source,
    scoreVectorVersion: ROS_CONVERGENCE_SCORE_VECTOR_VERSION,
    scoreVectorChecksum,
    prefixSamples: RELEASE_COUNT,
    suffixSamples: SUFFIX_COUNT,
    fullSamples: REFERENCE_COUNT,
    pairing: {
      convention: "adjacent-even-left-odd-right",
      prefixEven: RELEASE_COUNT / 2,
      prefixOdd: RELEASE_COUNT / 2,
      suffixEven: SUFFIX_COUNT / 2,
      suffixOdd: SUFFIX_COUNT / 2,
      independenceStatus: "assumed-not-authenticated",
    },
    prefixVsSuffix: cdfDistance(prefix, suffix),
    prefixVsFull: cdfDistance(prefix, full),
    forecastQuantileDefinition: "type-7",
    quantileRanks: PROBABILITIES.map((probability) => {
      const prefixType7 = type7(prefix, probability);
      const fullType7 = type7(full, probability);
      return {
        probability,
        prefixType7,
        fullType7,
        atPrefixType7: allRanks(prefixType7),
        atFullType7: allRanks(fullType7),
      };
    }),
    precision: {
      method: "four-stream-dkw-union-bound",
      target: "fixed-simulator-pair-mixture-distribution",
      assumption: "each-leg-stream-iid-with-fixed-leg-marginal-across-partitions",
      familySize: input.familySize,
      familyErrorBudget: input.familyErrorBudget,
      streamsPerVector: 4,
      logDkwFactor,
      prefixCdfRadius,
      suffixCdfRadius,
      fullCdfRadius,
      identificationQuantileDefinition: "inverse-empirical-cdf",
      quantileBounds: PROBABILITIES.map((probability) => ({
        probability,
        prefix: quantileBounds(prefix, probability, prefixCdfRadius),
        suffix: quantileBounds(suffix, probability, suffixCdfRadius),
        full: quantileBounds(full, probability, fullCdfRadius),
      })),
    },
  };
  return { ...measurement, evidenceChecksum: sha256Hex(canonical(measurement)) };
}

/** Compare only the bounded expected shape, independent of JSON/JSONB object key ordering. */
function equalCanonical(actual: unknown, expected: unknown): boolean {
  if (expected === null || typeof expected !== "object") return actual === expected;
  if (actual === null || typeof actual !== "object") return false;
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false;
    if (Object.keys(actual).length !== expected.length) return false;
    return expected.every(
      (entry, index) => Object.hasOwn(actual, index) && equalCanonical(actual[index], entry),
    );
  }
  if (Array.isArray(actual)) return false;
  const expectedRow = expected as Record<string, unknown>;
  const actualRow = actual as Record<string, unknown>;
  const keys = Object.keys(expectedRow);
  return (
    Object.keys(actualRow).length === keys.length &&
    keys.every(
      (key) => Object.hasOwn(actualRow, key) && equalCanonical(actualRow[key], expectedRow[key]),
    )
  );
}

/**
 * Recomputes from the vector and exact context; it never treats a self-consistent opaque receipt
 * checksum as proof. This still cannot authenticate the supplied source provenance or IID premise.
 */
export function rosConvergenceDistributionMatchesScores(
  value: unknown,
  input: RosConvergenceDistributionInput,
): value is RosConvergenceDistributionMeasurement {
  try {
    return equalCanonical(value, measureRosConvergenceDistribution(input));
  } catch {
    return false;
  }
}
