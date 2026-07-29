import {
  projectionScoringProfileKeyForPosition,
  projectionScoringRulesFromProfileKey,
} from "./scoring-position-keys.js";
import {
  projectionScoringProfileKey,
  scoreProjectionStatComponents,
  validateProjectionScoringProfile,
  type ProjectionScoringProfile,
  type ProjectionStatComponents,
} from "./scoring.js";

export const FIRST_PARTY_ROS_MODEL_VERSION = "laces-ros-distribution-v7";
/**
 * Frozen seed-stream lineage, deliberately decoupled from the model version as of v7: the v7
 * change is kicker-branch-only, and reseeding non-kicker positions would falsify the isolation
 * proof (acceptance requires non-K output numerically unchanged from v6). Change this constant
 * only when a global reseed is the intent — and that is itself a new model version. Invariant:
 * this changes if and only if non-K draw consumption changes.
 */
export const FIRST_PARTY_ROS_SEED_VERSION = "laces-ros-distribution-v6";
export const FIRST_PARTY_ROS_POLICY_VERSION = "season-walk-forward-block-wis-cqr-v4";
export const FIRST_PARTY_ROS_INTERVAL_CALIBRATION_VERSION = "season-blocked-split-conformal-cqr-v1";
/**
 * v4 raised the release path count from 512 to 8192: the declared convergence tolerances carry
 * absolute floors (for example one point on P15) that require a quantile standard error well below
 * one point, which 512 paths cannot deliver for wide season distributions. v5 widens the simulated
 * distributions again (two-moment role/production calibration restores the persistent between-week
 * component that weekly-variance matching missed) and raises the release count to 12288 so the
 * release-vs-reference comparison keeps its margin despite the wider spread. Any further change is
 * a new model version.
 */
export const FIRST_PARTY_ROS_DEFAULT_SCENARIOS = 12_288;
export const FIRST_PARTY_ROS_CONVERGENCE_REFERENCE_SCENARIOS = 16_384;
/**
 * The inclusive path-count contract every ROS consumer shares. These bounds are the ONLY admissible
 * scenario counts the engine will simulate, and every downstream store, persistence builder, and
 * live convergence diagnostic imports them instead of restating a numeric cap. A duplicated literal
 * is what let `player_ros_projection_summaries` cap a live summary at 4096 while the engine released
 * at 12288, so the first otherwise-releasable league projection would have failed during
 * persistence; deriving the storage contract from these constants is what prevents a recurrence.
 */
export const FIRST_PARTY_ROS_MINIMUM_SCENARIOS = 128;
export const FIRST_PARTY_ROS_MAXIMUM_SCENARIOS = 16_384;
/**
 * Availability gate v2. The uniform 1.5-game expected-games MAE was retained for the one-to-four
 * and five-to-eight windows, where it is attainable and attained. For nine-plus windows it is
 * provably unattainable: an in-sample oracle that knows each same-season stratum's realized
 * availability still shows about 2.26 games of mean absolute deviation over 2022-2025, because
 * 9-17 weeks of injury/roster outcomes carry that much irreducible dispersion. The nine-plus
 * ceiling is therefore set to 2.75 (oracle floor plus margin), and a signed expected-games bias
 * ceiling of 1.0 games is added for every window — a check the old MAE could not perform and the
 * one that actually detects systematic hazard mismatch (the prior model sat at -1.6 to -2.8).
 */
export const FIRST_PARTY_ROS_MAX_AVAILABILITY_MAE = 1.5;
export const FIRST_PARTY_ROS_MAX_NINE_PLUS_AVAILABILITY_MAE = 2.75;
export const FIRST_PARTY_ROS_MAX_AVAILABILITY_BIAS = 1.0;
/**
 * Availability MAE gate v3 (2026-07-28). Every ceiling above is unchanged; only how evidence
 * against them is weighed changes. The measured defect: block-bootstrap P(MAE > 2.75) for QB
 * nine-plus is 0.53-0.67 at a cell standard error of about 0.15, so the point-estimate comparison
 * fired on sample draw — the identical cell over the identical seasons scored 2.64-2.67 at five
 * players per position and 2.76-2.81 at eight. This is the same pathology coverage gate v3 fixed,
 * and it takes the same remedy: the ceiling now fails a cell only when the record is statistical
 * evidence that the *true* MAE exceeds it, at the same one-sided alpha.
 *
 * The bias ceiling deliberately keeps its point comparison. It is the check that actually detects
 * systematic hazard mismatch (WP1, 2026-07-28), its estimator is a signed mean rather than a
 * boundary-hugging absolute one, and every cell passes it with room to spare.
 */
export const FIRST_PARTY_ROS_AVAILABILITY_EVIDENCE_ALPHA = 0.1;
/**
 * The largest expected-games absolute error one row in each remaining-weeks bucket can produce.
 * Prediction and outcome both lie in [0, scheduled games], and scheduled games cannot exceed the
 * window length — nor, for the open-ended nine-plus bucket, the 17 games an NFL team plays inside
 * an 18-week regular season. These are structural bounds read off the schedule, not fitted values,
 * which is what lets the evidence test below stay distribution-free.
 */
export const FIRST_PARTY_ROS_MAXIMUM_AVAILABILITY_ROW_ERROR: Readonly<
  Record<FirstPartyRosRemainingWeeksBucket, number>
> = { "one-to-four": 4, "five-to-eight": 8, "nine-plus": 17 };

/**
 * One-sided evidence test for H0: the cell's true expected-games MAE is at most `maeCeiling`.
 *
 * The report records a cell's MAE and its row count, and nothing about the spread of its per-row
 * absolute errors, so the null distribution cannot be estimated from the evidence — it has to be
 * bounded. Each row's absolute error lies in [0, `maximumRowError`], and among all laws on that
 * support with mean `maeCeiling` the two-point law on the endpoints carries the most variance
 * (Bhatia-Davis) — the standard least-favourable case for an upper-tail test of a bounded mean.
 * Under it `samples * MAE / maximumRowError` is exactly Binomial(samples, maeCeiling /
 * maximumRowError), so the null tail is computed exactly rather than approximated, the same way
 * the coverage gate computes its own.
 *
 * The bound is deliberately loose, and that slack is doing two jobs: it costs no distributional
 * assumption about an error law nobody has measured, and it absorbs the within-block correlation
 * this test's row-independence would otherwise ignore. At nine-plus the bound admits about six
 * times the variance a block bootstrap measured (SE 0.15), i.e. any design effect a slate of eight
 * correlated players could plausibly carry. What it costs is power: at 288 rows a nine-plus cell
 * fails only from about 3.25 games, and at 128 rows a five-to-eight cell from about 1.88.
 */
export function firstPartyRosAvailabilityEvidenceOfExcessMae(
  samples: number,
  availabilityMae: number,
  maeCeiling: number,
  maximumRowError: number,
  alpha: number,
): boolean {
  if (!Number.isSafeInteger(samples) || samples <= 0) return false;
  assertNonNegative(availabilityMae, "availability mae");
  assertPositive(maeCeiling, "availability mae ceiling");
  assertPositive(maximumRowError, "maximum availability row error");
  assertProbability(alpha, "availability evidence alpha");
  if (maeCeiling >= maximumRowError) {
    throw new RangeError("availability mae ceiling must be below the maximum row error");
  }
  if (availabilityMae <= maeCeiling) return false;
  const exceedances = Math.ceil((samples * availabilityMae) / maximumRowError);
  if (exceedances > samples) return true;
  const probability = maeCeiling / maximumRowError;
  const odds = probability / (1 - probability);
  // Unnormalised probability-mass recurrence anchored at the mode, then divided by its own total.
  // Anchoring at the tallest term is what keeps hundreds of rows away from underflow, which a
  // recurrence started at zero successes would hit long before it reached the tail.
  const mode = Math.min(samples, Math.floor((samples + 1) * probability));
  let total = 0;
  let tail = 0;
  let weight = 1;
  for (let successes = mode; successes <= samples; successes += 1) {
    total += weight;
    if (successes >= exceedances) tail += weight;
    weight *= ((samples - successes) / (successes + 1)) * odds;
    if (weight === 0) break;
  }
  weight = 1;
  for (let successes = mode; successes > 0; successes -= 1) {
    weight *= successes / ((samples - successes + 1) * odds);
    total += weight;
    if (successes - 1 >= exceedances) tail += weight;
    if (weight === 0) break;
  }
  return tail / total < alpha;
}
/**
 * Coverage gate v3 (ratified 2026-07-22). The walk-forward record holds only 4-9 blocks per cell,
 * so the previous point-estimate comparison (observed block coverage >= nominal - 0.10) falsely
 * failed a truly 0.70-covered cell with probability 0.27-0.35 — two different model versions
 * reproduced byte-identical block-coverage outcomes because block-max conformal coverage depends
 * only on the rank of evaluation-season block maxima against the training quantile. The floor is
 * unchanged (nominal 0.70 minus deviation 0.10 = 0.60); the comparison is now a one-sided exact
 * binomial evidence test: a cell fails only when P(X <= covered | p = floor, n = blocks) < alpha,
 * i.e. when the record is statistical evidence of undercoverage rather than sampling noise.
 */
export const FIRST_PARTY_ROS_COVERAGE_EVIDENCE_ALPHA = 0.1;

/** Exact binomial P(X <= successes) for the small block counts used by the coverage gate. */
export function firstPartyRosCoverageEvidenceOfUndercoverage(
  blocks: number,
  observedBlockCoverage: number,
  coverageFloor: number,
  alpha: number,
): boolean {
  if (!Number.isSafeInteger(blocks) || blocks <= 0) return false;
  assertProbability(observedBlockCoverage, "observed block coverage");
  assertProbability(coverageFloor, "coverage floor");
  assertProbability(alpha, "coverage evidence alpha");
  const covered = Math.round(observedBlockCoverage * blocks);
  let probability = 0;
  let coefficient = 1;
  for (let successes = 0; successes <= covered; successes += 1) {
    if (successes > 0) coefficient = (coefficient * (blocks - successes + 1)) / successes;
    probability +=
      coefficient * coverageFloor ** successes * (1 - coverageFloor) ** (blocks - successes);
  }
  return probability < alpha;
}
export const FIRST_PARTY_ROS_MINIMUM_HELD_OUT_SEASONS = 3;
export const FIRST_PARTY_ROS_MINIMUM_BATCHES = 30;
export const FIRST_PARTY_ROS_MINIMUM_SAMPLES = 300;
export const FIRST_PARTY_ROS_MINIMUM_CELL_SEASONS = 3;
export const FIRST_PARTY_ROS_MINIMUM_CELL_SAMPLES = 18;
export const FIRST_PARTY_ROS_MINIMUM_CELL_CUTOFFS = 3;
export const FIRST_PARTY_ROS_MINIMUM_CELL_BATCHES = 9;
export const FIRST_PARTY_ROS_MINIMUM_WALK_FORWARD_SEASONS = 1;
export const FIRST_PARTY_ROS_MINIMUM_WALK_FORWARD_BATCHES = 3;
export const FIRST_PARTY_ROS_MINIMUM_WALK_FORWARD_SAMPLES = 18;
export const FIRST_PARTY_ROS_MINIMUM_MODEL_IMPROVEMENT = 0.01;

export type FirstPartyRosStrategy = "contextual" | "availability-aware-recency";
export type FirstPartyRosAvailabilityState = "active" | "limited" | "inactive" | "reserve";
export type FirstPartyRosRemainingWeeksBucket = "one-to-four" | "five-to-eight" | "nine-plus";
export type FirstPartyRosPosition = "QB" | "RB" | "WR" | "TE" | "K" | "DST";

export interface FirstPartyRosComponentElasticity {
  /** Sensitivity to the persistent role state. Zero preserves probabilities and fixed categories. */
  readonly role: number;
  /** Sensitivity to the mean-one weekly production shock. */
  readonly production: number;
}

export interface FirstPartyRosWeeklyScenarioInput {
  readonly season: number;
  readonly week: number;
  readonly scheduled: boolean;
  readonly bye: boolean;
  /** Pinned conditional-game centers from the richer weekly model. */
  readonly contextualComponents: ProjectionStatComponents;
  /** Pinned conditional-game centers from the recency-only weekly challenger. */
  readonly recencyComponents: ProjectionStatComponents;
  /** Every component in either candidate must have an explicit elasticity. */
  readonly componentElasticities: Readonly<Record<string, FirstPartyRosComponentElasticity>>;
  readonly newAbsenceProbability?: number;
  readonly recoveryProbability?: number;
}

export interface FirstPartyRosAvailabilityInput {
  readonly state: FirstPartyRosAvailabilityState;
  /** Probability that an available player becomes unavailable before a scheduled game. */
  readonly newAbsenceProbability: number;
  /** Weekly recovery probability for an inactive player. */
  readonly recoveryProbability: number;
  /** Weekly recovery probability for a reserve/IR/PUP player. */
  readonly reserveRecoveryProbability: number;
  /** Role multiplier for the first projected week when currently limited. */
  readonly limitedRoleMultiplier: number;
  /** Role multiplier for the first projected game after a simulated return. */
  readonly returnRoleMultiplier: number;
}

export interface FirstPartyRosRoleInput {
  /** Current opportunity relative to the pinned weekly center. */
  readonly currentMultiplier: number;
  /** AR(1) persistence in log-role space. */
  readonly persistence: number;
  /** Standard deviation of each weekly innovation in log-role space. */
  readonly innovationVolatility: number;
  /** Standard deviation of the mean-one weekly production shock. */
  readonly weeklyProductionVolatility: number;
  /**
   * Log-space standard deviation of a mean-one static center-error multiplier, drawn once per
   * scenario. It represents the weekly model's own per-player center forecast error, which is
   * constant over the window and therefore cannot be expressed by the mean-reverting role
   * process or the iid production shock. Zero (the default) disables it.
   */
  readonly centerVolatility?: number;
  /** Hard fail-safe bound applied after role evolution. */
  readonly minimumMultiplier: number;
  /** Hard fail-safe bound applied after role evolution. */
  readonly maximumMultiplier: number;
}

/**
 * Kicker count-process parameters (model v7). Kicker weeks are simulated as a joint integer count
 * process on the five scored components — makes per scoring bucket, recorded misses, XP makes —
 * instead of the lognormal role × production shock, whose smooth unimodal family cannot represent
 * a kicker's discrete, low-count short-window totals.
 */
export interface FirstPartyRosKickerProcessInput {
  /** Dispersion index of per-game scored FG events (makes + recorded misses). [0.6, 1.0]. */
  readonly fgEventDispersion: number;
  /** Dispersion index of per-game XP makes. [0.7, 1.05]; at or above 0.97 samples pure Poisson. */
  readonly xpDispersion: number;
  /** Recorded-miss adapter: Σ fg_missed / Σ max(0, att − made) in training. [0.85, 1.0]. */
  readonly recordedMissRatio: number;
  /** Log-sd of the static mean-one center-error factor (weekly-model K center error). [0, 1]. */
  readonly centerVolatility: number;
  /** League FG-make share by scoring bucket (0-39, 40-49, 50+); degenerate-input fallback only. */
  readonly bucketMix: readonly [number, number, number];
}

export interface FirstPartyRosProjectionInput {
  readonly playerId: string;
  readonly position: FirstPartyRosPosition;
  readonly season: number;
  /** Last fully observed NFL week available to every supplied candidate. */
  readonly asOfWeek: number;
  /** Canonical ISO-8601 instant at which the pinned forecast inputs were known. */
  readonly asOfAt: string;
  readonly windowStartWeek: number;
  readonly windowEndWeek: number;
  readonly strategy: FirstPartyRosStrategy;
  readonly weeks: readonly FirstPartyRosWeeklyScenarioInput[];
  readonly availability: FirstPartyRosAvailabilityInput;
  readonly role: FirstPartyRosRoleInput;
  readonly scoringProfile: ProjectionScoringProfile;
  /** Required for position K under model v7; rejected for every other position. */
  readonly kicker?: FirstPartyRosKickerProcessInput;
  /** Exact pinned upstream/model input checksum. */
  readonly inputChecksum: string;
  /** Version of the weekly candidates supplied to this model. */
  readonly weeklyModelVersion: string;
  /** Caller-owned seed material. The input checksum and player identity are added automatically. */
  readonly seed: string;
  readonly scenarioCount?: number;
}

export interface FirstPartyRosWeeklyPath {
  readonly week: number;
  readonly scheduled: boolean;
  readonly bye: boolean;
  readonly availabilityProbability: number;
  readonly meanPoints: number;
  readonly p15Points: number;
  readonly p50Points: number;
  readonly p85Points: number;
}

export interface FirstPartyRosDiagnostic {
  readonly severity: "warning" | "info";
  readonly code:
    | "simulation_interval_not_calibrated"
    | "current_unavailability_persisted"
    | "role_multiplier_bounded"
    | "no_scheduled_games";
  readonly message: string;
}

export interface FirstPartyRosProjectionProvenance {
  readonly modelVersion: typeof FIRST_PARTY_ROS_MODEL_VERSION;
  readonly strategy: FirstPartyRosStrategy;
  readonly weeklyModelVersion: string;
  readonly scoringProfileKey: string;
  readonly inputChecksum: string;
  readonly seedHash: string;
  readonly randomGenerator: "xoshiro128**-sha256-128";
  readonly scenarioCount: number;
  readonly season: number;
  readonly asOfWeek: number;
  readonly asOfAt: string;
  readonly windowStartWeek: number;
  readonly windowEndWeek: number;
  /** Simulation quantiles are deliberately not represented as historically calibrated intervals. */
  readonly intervalCalibration: "simulation-only";
}

export interface FirstPartyRosProjection {
  readonly state: "projected" | "unavailable";
  readonly playerId: string;
  readonly position: FirstPartyRosPosition;
  readonly expectedGames: number;
  readonly scheduledGames: number;
  readonly meanPoints: number;
  readonly standardDeviation: number;
  readonly p15Points: number;
  readonly p50Points: number;
  readonly p85Points: number;
  /** Scenario mean of the aggregate raw stat line, not a sum of marginal component quantiles. */
  readonly expectedComponents: ProjectionStatComponents;
  readonly weekly: readonly FirstPartyRosWeeklyPath[];
  /** Weekly means include zero for bye and simulated-unavailable paths; they are not points/game. */
  readonly weeklyMeanSemantics: "unconditional-includes-zero-for-bye-or-unavailable";
  readonly simulation: {
    readonly availabilityLagOneCorrelation: number | null;
    readonly roleLagOneCorrelation: number | null;
    readonly boundedRoleSamples: number;
  };
  readonly provenance: FirstPartyRosProjectionProvenance;
  readonly diagnostics: readonly FirstPartyRosDiagnostic[];
}

interface ScenarioState {
  available: boolean;
  reserve: boolean;
  justReturned: boolean;
  limitedWeeksRemaining: number;
  roleLog: number;
}

interface ScenarioAccumulator {
  totalPoints: number;
  games: number;
  readonly components: Record<string, number>;
}

interface ScenarioPairAudit {
  readonly availabilityLeft: number[];
  readonly availabilityRight: number[];
  readonly roleLeft: number[];
  readonly roleRight: number[];
}

function assertNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) throw new TypeError(`${label} must not be empty`);
}

function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
}

function assertProbability(value: number, label: string): void {
  assertFinite(value, label);
  if (value < 0 || value > 1) throw new RangeError(`${label} must be between zero and one`);
}

function assertPositive(value: number, label: string): void {
  assertFinite(value, label);
  if (value <= 0) throw new RangeError(`${label} must be greater than zero`);
}

function assertNonNegative(value: number, label: string): void {
  assertFinite(value, label);
  if (value < 0) throw new RangeError(`${label} must not be negative`);
}

function assertCanonicalIsoInstant(value: string, label: string): void {
  assertNonEmpty(value, label);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical UTC ISO-8601 instant`);
  }
}

function assertSha256Digest(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 digest`);
  }
}

function normalizedPosition(position: string): FirstPartyRosPosition {
  const normalized = position.trim().toUpperCase();
  if (normalized === "D/ST" || normalized === "DEF") return "DST";
  if (
    normalized !== "QB" &&
    normalized !== "RB" &&
    normalized !== "WR" &&
    normalized !== "TE" &&
    normalized !== "K" &&
    normalized !== "DST"
  ) {
    throw new RangeError(`Unsupported ROS position: ${position}`);
  }
  return normalized;
}

const SHA256_ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

/** Synchronous, dependency-free SHA-256 for deterministic shared/browser model builds. */
function sha256Hex(value: string): string {
  const input = new TextEncoder().encode(value);
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const bytes = new Uint8Array(paddedLength);
  bytes.set(input);
  bytes[input.length] = 0x80;
  const bitLength = input.length * 8;
  const view = new DataView(bytes.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4, false);
    }
    for (let index = 16; index < 64; index += 1) {
      const previous15 = words[index - 15]!;
      const previous2 = words[index - 2]!;
      const sigma0 = rotateRight(previous15, 7) ^ rotateRight(previous15, 18) ^ (previous15 >>> 3);
      const sigma1 = rotateRight(previous2, 17) ^ rotateRight(previous2, 19) ^ (previous2 >>> 10);
      words[index] = (words[index - 16]! + sigma0 + words[index - 7]! + sigma1) >>> 0;
    }
    let a = state[0]!;
    let b = state[1]!;
    let c = state[2]!;
    let d = state[3]!;
    let e = state[4]!;
    let f = state[5]!;
    let g = state[6]!;
    let h = state[7]!;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temporary1 = (h + sum1 + choice + SHA256_ROUND_CONSTANTS[index]! + words[index]!) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }
    state[0] = (state[0]! + a) >>> 0;
    state[1] = (state[1]! + b) >>> 0;
    state[2] = (state[2]! + c) >>> 0;
    state[3] = (state[3]! + d) >>> 0;
    state[4] = (state[4]! + e) >>> 0;
    state[5] = (state[5]! + f) >>> 0;
    state[6] = (state[6]! + g) >>> 0;
    state[7] = (state[7]! + h) >>> 0;
  }
  return [...state].map((word) => word.toString(16).padStart(8, "0")).join("");
}

function rotateLeft(value: number, bits: number): number {
  return (value << bits) | (value >>> (32 - bits));
}

/** xoshiro128** seeded from the first 128 bits of the canonical SHA-256 digest. */
function xoshiro128StarStar(seedHash: string): () => number {
  const state = new Uint32Array(
    Array.from({ length: 4 }, (_, index) =>
      Number.parseInt(seedHash.slice(index * 8, index * 8 + 8), 16),
    ),
  );
  // xoshiro excludes the all-zero state. A SHA-256 digest can theoretically produce it, so map
  // that single invalid state deterministically instead of silently degenerating.
  if (state.every((word) => word === 0)) state[0] = 0x9e3779b9;
  return () => {
    const state0 = state[0]!;
    const state1 = state[1]!;
    const state2 = state[2]!;
    const state3 = state[3]!;
    const result = Math.imul(rotateLeft(Math.imul(state1, 5), 7), 9) >>> 0;
    const transition = state1 << 9;
    const next2 = (state2 ^ state0 ^ transition) >>> 0;
    const next3 = rotateLeft((state3 ^ state1) >>> 0, 11) >>> 0;
    state[1] = (state1 ^ state2 ^ state0) >>> 0;
    state[0] = (state0 ^ state3 ^ state1) >>> 0;
    state[2] = next2;
    state[3] = next3;
    return result / 4_294_967_296;
  };
}

function normal(random: () => number): number {
  const left = Math.max(Number.EPSILON, random());
  const right = random();
  return Math.sqrt(-2 * Math.log(left)) * Math.cos(2 * Math.PI * right);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

/** Per-side cap on the FG-event intensity Λ and the XP intensity (proportional rescale). */
const KICKER_LAMBDA_MAX = 8;
/** Dispersion at or above this samples pure Poisson (binomial n would exceed its useful range). */
const KICKER_POISSON_MODE_MIN = 0.97;
/** NaN-safety cap on Poisson inversion; P(K >= 64 | lambda = 8) < 1e-30. */
const KICKER_POISSON_STEP_MAX = 64;

function poissonInverse(lambda: number, uniform: number): number {
  if (!(lambda > 0)) return 0;
  const u = Math.min(Math.max(uniform, 0), 1 - 2 ** -33);
  let pmf = Math.exp(-lambda);
  let cdf = pmf;
  let k = 0;
  while (u > cdf && k < KICKER_POISSON_STEP_MAX) {
    k += 1;
    pmf *= lambda / k;
    cdf += pmf;
  }
  return k;
}

function binomialInverse(n: number, p: number, uniform: number): number {
  if (n <= 0 || p <= 0) return 0;
  if (p >= 1) return n;
  const u = Math.min(Math.max(uniform, 0), 1 - 2 ** -33);
  let pmf = (1 - p) ** n;
  let cdf = pmf;
  let k = 0;
  while (u > cdf && k < n) {
    k += 1;
    pmf *= ((n - k + 1) / k) * (p / (1 - p));
    cdf += pmf;
  }
  return k;
}

/**
 * Mean-exact under-dispersed count via a fractional-n binomial: dispersion index phi = 1 − p, so
 * n* = mean / p with the fractional part realized as a Bernoulli on n (E[count] = mean exactly;
 * variance = phi·mean + p²·r(1−r), excess at most 0.04). Consumes both uniforms' entropy budget
 * unconditionally — callers draw them regardless — and is monotone nondecreasing in u2, which the
 * antithetic pairing requires. At phi ≥ 0.97 the Poisson branch uses u2 alone.
 */
function underdispersedCount(mean: number, phi: number, u1: number, u2: number): number {
  if (!(mean > 0)) return 0;
  if (phi >= KICKER_POISSON_MODE_MIN) return poissonInverse(mean, u2);
  const p = 1 - phi;
  const nStar = mean / p;
  const wholeN = Math.floor(nStar);
  const fraction = nStar - wholeN;
  const n = wholeN + (u1 < fraction ? 1 : 0);
  return binomialInverse(n, p, u2);
}

interface KickerWeekParams {
  /** Expected makes per scoring bucket (0-39, 40-49, 50+), pre-scale. */
  readonly b39: number;
  readonly b49: number;
  readonly b50: number;
  /** Expected recorded misses, pre-scale: recordedMissRatio × max(0, att − made). */
  readonly missBase: number;
  /** Expected XP makes, pre-scale. */
  readonly xpBase: number;
  /** Fine-bucket shares within 0-39 (0_19, 20_29, 30_39) for the cosmetic component split. */
  readonly fine39: readonly [number, number, number];
  /** Fine-bucket shares within 50+ (50_59, 60_plus) for the cosmetic component split. */
  readonly fine50: readonly [number, number];
}

interface KickerContext {
  readonly process: FirstPartyRosKickerProcessInput;
  readonly weekParams: readonly KickerWeekParams[];
}

function kickerWeekParams(
  week: FirstPartyRosWeeklyScenarioInput,
  strategy: FirstPartyRosStrategy,
  process: FirstPartyRosKickerProcessInput,
): KickerWeekParams {
  const base = strategy === "contextual" ? week.contextualComponents : week.recencyComponents;
  const read = (key: string): number => {
    const value = base[key];
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
  };
  const fine019 = read("field_goals_made_0_19");
  const fine2029 = read("field_goals_made_20_29");
  const fine3039 = read("field_goals_made_30_39");
  const fine5059 = read("field_goals_made_50_59");
  const fine60 = read("field_goals_made_60_plus");
  let b39 =
    base["field_goals_made_0_39"] !== undefined
      ? read("field_goals_made_0_39")
      : fine019 + fine2029 + fine3039;
  let b49 = read("field_goals_made_40_49");
  let b50 =
    base["field_goals_made_50_plus"] !== undefined
      ? read("field_goals_made_50_plus")
      : fine5059 + fine60;
  const made = read("field_goals_made");
  const bucketSum = b39 + b49 + b50;
  if (made > 0 && bucketSum > 0) {
    const rescale = made / bucketSum;
    b39 *= rescale;
    b49 *= rescale;
    b50 *= rescale;
  } else if (made > 0) {
    b39 = made * process.bucketMix[0];
    b49 = made * process.bucketMix[1];
    b50 = made * process.bucketMix[2];
  }
  const attempted = Math.max(read("field_goals_attempted"), made);
  const missBase = process.recordedMissRatio * Math.max(0, attempted - made);
  const xpBase = read("extra_points_made");
  const fine39Sum = fine019 + fine2029 + fine3039;
  const fine50Sum = fine5059 + fine60;
  return {
    b39,
    b49,
    b50,
    missBase,
    xpBase,
    fine39:
      fine39Sum > 0 ? [fine019 / fine39Sum, fine2029 / fine39Sum, fine3039 / fine39Sum] : [0, 0, 1],
    fine50: fine50Sum > 0 ? [fine5059 / fine50Sum, fine60 / fine50Sum] : [1, 0],
  };
}

/**
 * Samples one kicker game as the five scored integer counts and expands them into the pinned
 * 14-key kicker component vocabulary. Satisfies every football component invariant by
 * construction (made = Σ coarse buckets, attempted = made + missed, fine sums = coarse), so the
 * caller deliberately skips enforceFootballComponentInvariants. Uses exactly the seven supplied
 * uniforms; the antithetic leg inverts them through the same monotone CDF inversions.
 *
 * Persisted component semantics (deliberate, scoring-neutral under the pinned profile, but
 * visible to any analytics consumer of the components map): extra_points_attempted equals XP
 * makes and extra_points_missed is identically zero (XP misses score nothing in scope, so the
 * XP leg models makes directly); field_goals_attempted is the recorded scoring lattice
 * made + missed, structurally excluding blocked-kick attempts. Known fidelity bound: multinomial
 * thinning of one shared FG-event total caps each simulated component's dispersion index below
 * one (the measured ~1.05 for the 50+ bucket is knowingly approximated at ~0.98), and the FG and
 * XP legs share only the scale multiplier, so their volume correlation is ~0 conditional versus
 * the measured -0.20 — both gaps push the window total wider, never narrower.
 */
function sampleKickerGame(
  params: KickerWeekParams,
  process: FirstPartyRosKickerProcessInput,
  scale: number,
  uniforms: readonly number[],
  antithetic: boolean,
): Record<string, number> {
  const u = (index: number): number => {
    const value = uniforms[index]!;
    return antithetic ? 1 - value : value;
  };
  let lambda39 = scale * params.b39;
  let lambda49 = scale * params.b49;
  let lambda50 = scale * params.b50;
  let lambdaMiss = scale * params.missBase;
  let lambdaTotal = lambda39 + lambda49 + lambda50 + lambdaMiss;
  if (lambdaTotal > KICKER_LAMBDA_MAX) {
    const rescale = KICKER_LAMBDA_MAX / lambdaTotal;
    lambda39 *= rescale;
    lambda49 *= rescale;
    lambda50 *= rescale;
    lambdaMiss *= rescale;
    lambdaTotal = KICKER_LAMBDA_MAX;
  }
  const lambdaXp = Math.min(scale * params.xpBase, KICKER_LAMBDA_MAX);
  const events = underdispersedCount(lambdaTotal, process.fgEventDispersion, u(0), u(1));
  const p39 = lambdaTotal > 0 ? clamp(lambda39 / lambdaTotal, 0, 1) : 0;
  const made39 = binomialInverse(events, p39, u(2));
  const p49 = clamp(lambda49 / Math.max(lambdaTotal - lambda39, 1e-12), 0, 1);
  const made49 = binomialInverse(events - made39, p49, u(3));
  const p50 = clamp(lambda50 / Math.max(lambdaTotal - lambda39 - lambda49, 1e-12), 0, 1);
  const made50 = binomialInverse(events - made39 - made49, p50, u(4));
  const missed = events - made39 - made49 - made50;
  const extraPoints = underdispersedCount(lambdaXp, process.xpDispersion, u(5), u(6));
  const made = made39 + made49 + made50;
  return {
    field_goals_made_0_19: made39 * params.fine39[0],
    field_goals_made_20_29: made39 * params.fine39[1],
    field_goals_made_30_39: made39 * params.fine39[2],
    field_goals_made_0_39: made39,
    field_goals_made_40_49: made49,
    field_goals_made_50_59: made50 * params.fine50[0],
    field_goals_made_60_plus: made50 * params.fine50[1],
    field_goals_made_50_plus: made50,
    field_goals_made: made,
    field_goals_missed: missed,
    field_goals_attempted: made + missed,
    extra_points_made: extraPoints,
    extra_points_attempted: extraPoints,
    extra_points_missed: 0,
  };
}

function quantile(values: readonly number[], probability: number): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const offset = (ordered.length - 1) * probability;
  const lowerIndex = Math.floor(offset);
  const upperIndex = Math.ceil(offset);
  const lower = ordered[lowerIndex] ?? 0;
  const upper = ordered[upperIndex] ?? lower;
  return lower + (upper - lower) * (offset - lowerIndex);
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const center = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - center) ** 2, 0) / values.length);
}

function correlation(left: readonly number[], right: readonly number[]): number | null {
  if (left.length !== right.length || left.length < 2) return null;
  const leftMean = mean(left);
  const rightMean = mean(right);
  let numerator = 0;
  let leftSquares = 0;
  let rightSquares = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftDelta = (left[index] ?? 0) - leftMean;
    const rightDelta = (right[index] ?? 0) - rightMean;
    numerator += leftDelta * rightDelta;
    leftSquares += leftDelta ** 2;
    rightSquares += rightDelta ** 2;
  }
  if (leftSquares <= 0 || rightSquares <= 0) return null;
  return clamp(numerator / Math.sqrt(leftSquares * rightSquares), -1, 1);
}

function componentKeys(week: FirstPartyRosWeeklyScenarioInput): readonly string[] {
  return [
    ...new Set([...Object.keys(week.contextualComponents), ...Object.keys(week.recencyComponents)]),
  ].sort();
}

function validateComponents(
  components: ProjectionStatComponents,
  keys: readonly string[],
  label: string,
): void {
  if (Object.keys(components).length === 0) throw new RangeError(`${label} must not be empty`);
  for (const key of keys) {
    assertNonEmpty(key, `${label} component key`);
    const value = components[key];
    if (value === undefined) throw new Error(`${label} is missing component ${key}`);
    assertNonNegative(value, `${label} component ${key}`);
    if (value > 1_000_000) throw new RangeError(`${label} component ${key} exceeds its bound`);
  }
  for (const key of Object.keys(components)) {
    if (!keys.includes(key)) throw new Error(`${label} contains an unexpected component ${key}`);
  }
}

const FOOTBALL_INVARIANT_TOLERANCE = 1e-8;
const FIELD_GOAL_DISTANCE_MAKES = [
  "field_goals_made_0_19",
  "field_goals_made_20_29",
  "field_goals_made_30_39",
  "field_goals_made_40_49",
  "field_goals_made_50_59",
  "field_goals_made_60_plus",
] as const;

function hasComponents(components: ProjectionStatComponents, keys: readonly string[]): boolean {
  return keys.every((key) => components[key] !== undefined);
}

function assertOrderedComponents(
  components: ProjectionStatComponents,
  lowerKey: string,
  upperKey: string,
  label: string,
): void {
  const lower = components[lowerKey];
  const upper = components[upperKey];
  if (lower !== undefined && upper !== undefined && lower > upper + FOOTBALL_INVARIANT_TOLERANCE) {
    throw new RangeError(`${label} requires ${lowerKey} not to exceed ${upperKey}`);
  }
}

function assertDifferenceIdentity(
  components: ProjectionStatComponents,
  attemptsKey: string,
  madeKey: string,
  missedKey: string,
  label: string,
): void {
  if (!hasComponents(components, [attemptsKey, madeKey, missedKey])) return;
  const attempts = components[attemptsKey]!;
  const made = components[madeKey]!;
  const missed = components[missedKey]!;
  const tolerance = Math.max(FOOTBALL_INVARIANT_TOLERANCE, attempts * 1e-6);
  if (Math.abs(attempts - made - missed) > tolerance) {
    throw new RangeError(`${label} requires attempts to equal made plus missed`);
  }
}

function validateFootballComponentInvariants(
  components: ProjectionStatComponents,
  label: string,
): void {
  assertOrderedComponents(components, "passing_completions", "passing_attempts", label);
  assertOrderedComponents(components, "passing_interceptions", "passing_attempts", label);
  assertOrderedComponents(components, "receptions", "targets", label);
  assertOrderedComponents(components, "field_goals_made", "field_goals_attempted", label);
  assertOrderedComponents(components, "extra_points_made", "extra_points_attempted", label);
  assertOrderedComponents(components, "fumbles_lost", "fumbles", label);
  assertDifferenceIdentity(
    components,
    "field_goals_attempted",
    "field_goals_made",
    "field_goals_missed",
    label,
  );
  assertDifferenceIdentity(
    components,
    "extra_points_attempted",
    "extra_points_made",
    "extra_points_missed",
    label,
  );
}

function setAggregateWhenComplete(
  components: Record<string, number>,
  aggregate: string,
  parts: readonly string[],
): void {
  if (components[aggregate] === undefined || !hasComponents(components, parts)) return;
  components[aggregate] = parts.reduce((sum, part) => sum + components[part]!, 0);
}

/** Restores supported football identities after independently shocked raw components. */
function enforceFootballComponentInvariants(
  components: Record<string, number>,
): Record<string, number> {
  if (components.passing_attempts !== undefined) {
    if (components.passing_completions !== undefined) {
      components.passing_completions = Math.min(
        components.passing_completions,
        components.passing_attempts,
      );
    }
    if (components.passing_interceptions !== undefined) {
      components.passing_interceptions = Math.min(
        components.passing_interceptions,
        components.passing_attempts,
      );
    }
  }
  if (components.targets !== undefined && components.receptions !== undefined) {
    components.receptions = Math.min(components.receptions, components.targets);
  }
  if (components.fumbles !== undefined && components.fumbles_lost !== undefined) {
    components.fumbles_lost = Math.min(components.fumbles_lost, components.fumbles);
  }

  setAggregateWhenComplete(components, "two_point_conversions", [
    "passing_two_point_conversions",
    "rushing_two_point_conversions",
    "receiving_two_point_conversions",
  ]);
  setAggregateWhenComplete(components, "fumbles", [
    "passing_fumbles",
    "rushing_fumbles",
    "receiving_fumbles",
  ]);
  setAggregateWhenComplete(components, "fumbles_lost", [
    "passing_fumbles_lost",
    "rushing_fumbles_lost",
    "receiving_fumbles_lost",
  ]);
  if (components.fumbles !== undefined && components.fumbles_lost !== undefined) {
    components.fumbles_lost = Math.min(components.fumbles_lost, components.fumbles);
  }
  setAggregateWhenComplete(components, "turnovers", ["passing_interceptions", "fumbles_lost"]);
  setAggregateWhenComplete(components, "return_yards", [
    "kickoff_return_yards",
    "punt_return_yards",
  ]);
  setAggregateWhenComplete(components, "return_touchdowns", [
    "defensive_touchdowns",
    "special_teams_touchdowns",
  ]);

  if (
    components.field_goals_made !== undefined &&
    hasComponents(components, FIELD_GOAL_DISTANCE_MAKES)
  ) {
    const distanceTotal = FIELD_GOAL_DISTANCE_MAKES.reduce(
      (sum, component) => sum + components[component]!,
      0,
    );
    components.field_goals_made = Math.min(components.field_goals_made, distanceTotal);
    if (components.field_goals_attempted !== undefined) {
      components.field_goals_made = Math.min(
        components.field_goals_made,
        components.field_goals_attempted,
      );
    }
    if (distanceTotal > 0) {
      const scale = components.field_goals_made / distanceTotal;
      for (const component of FIELD_GOAL_DISTANCE_MAKES) {
        components[component] = components[component]! * scale;
      }
    }
  } else if (
    components.field_goals_made !== undefined &&
    components.field_goals_attempted !== undefined
  ) {
    components.field_goals_made = Math.min(
      components.field_goals_made,
      components.field_goals_attempted,
    );
  }
  setAggregateWhenComplete(components, "field_goals_made_0_39", [
    "field_goals_made_0_19",
    "field_goals_made_20_29",
    "field_goals_made_30_39",
  ]);
  setAggregateWhenComplete(components, "field_goals_made_50_plus", [
    "field_goals_made_50_59",
    "field_goals_made_60_plus",
  ]);
  if (
    components.field_goals_attempted !== undefined &&
    components.field_goals_made !== undefined &&
    components.field_goals_missed !== undefined
  ) {
    components.field_goals_missed = Math.max(
      0,
      components.field_goals_attempted - components.field_goals_made,
    );
  }
  if (
    components.extra_points_attempted !== undefined &&
    components.extra_points_made !== undefined
  ) {
    components.extra_points_made = Math.min(
      components.extra_points_made,
      components.extra_points_attempted,
    );
    if (components.extra_points_missed !== undefined) {
      components.extra_points_missed = Math.max(
        0,
        components.extra_points_attempted - components.extra_points_made,
      );
    }
  }
  return components;
}

function validateProjectionInput(input: FirstPartyRosProjectionInput): {
  readonly position: FirstPartyRosPosition;
  readonly weeks: readonly FirstPartyRosWeeklyScenarioInput[];
  readonly scenarioCount: number;
} {
  assertNonEmpty(input.playerId, "ROS playerId");
  assertNonEmpty(input.inputChecksum, "ROS inputChecksum");
  assertNonEmpty(input.weeklyModelVersion, "ROS weeklyModelVersion");
  assertNonEmpty(input.seed, "ROS seed");
  const position = normalizedPosition(input.position);
  if (input.strategy !== "contextual" && input.strategy !== "availability-aware-recency") {
    throw new RangeError("Unsupported ROS strategy");
  }
  assertSha256Digest(input.inputChecksum, "ROS inputChecksum");
  if (!Number.isSafeInteger(input.season) || input.season < 2000 || input.season > 2200) {
    throw new RangeError("ROS season must be between 2000 and 2200");
  }
  if (
    !Number.isSafeInteger(input.asOfWeek) ||
    input.asOfWeek < 0 ||
    input.asOfWeek > 17 ||
    input.asOfWeek >= input.windowStartWeek
  ) {
    throw new RangeError("ROS asOfWeek must be between zero and 17 and precede windowStartWeek");
  }
  assertCanonicalIsoInstant(input.asOfAt, "ROS asOfAt");
  if (
    !Number.isSafeInteger(input.windowStartWeek) ||
    !Number.isSafeInteger(input.windowEndWeek) ||
    input.windowStartWeek < 1 ||
    input.windowEndWeek > 18 ||
    input.windowEndWeek < input.windowStartWeek
  ) {
    throw new RangeError("ROS window must be a non-empty range between Week 1 and Week 18");
  }
  const expectedWeeks = input.windowEndWeek - input.windowStartWeek + 1;
  if (input.weeks.length !== expectedWeeks) {
    throw new Error("ROS weeks must contain every week in the requested window exactly once");
  }
  const weeks = [...input.weeks].sort((left, right) => left.week - right.week);
  for (let index = 0; index < weeks.length; index += 1) {
    const week = weeks[index]!;
    const expectedWeek = input.windowStartWeek + index;
    if (week.season !== input.season || week.week !== expectedWeek) {
      throw new Error("ROS weeks must be continuous, unique, and match the target season");
    }
    if (week.bye && week.scheduled)
      throw new Error(`Week ${week.week} cannot be both scheduled and a bye`);
    if (!week.bye && !week.scheduled) {
      throw new Error(`Week ${week.week} must be either scheduled or an explicit bye`);
    }
    const keys = componentKeys(week);
    validateComponents(week.contextualComponents, keys, `Week ${week.week} contextual candidate`);
    validateComponents(week.recencyComponents, keys, `Week ${week.week} recency candidate`);
    validateFootballComponentInvariants(
      week.contextualComponents,
      `Week ${week.week} contextual candidate`,
    );
    validateFootballComponentInvariants(
      week.recencyComponents,
      `Week ${week.week} recency candidate`,
    );
    for (const key of keys) {
      const elasticity = week.componentElasticities[key];
      if (!elasticity) throw new Error(`Week ${week.week} is missing elasticity for ${key}`);
      assertFinite(elasticity.role, `Week ${week.week} role elasticity for ${key}`);
      assertFinite(elasticity.production, `Week ${week.week} production elasticity for ${key}`);
      if (elasticity.role < 0 || elasticity.role > 2) {
        throw new RangeError(
          `Week ${week.week} role elasticity for ${key} must be between zero and two`,
        );
      }
      if (elasticity.production < 0 || elasticity.production > 2) {
        throw new RangeError(
          `Week ${week.week} production elasticity for ${key} must be between zero and two`,
        );
      }
    }
    for (const key of Object.keys(week.componentElasticities)) {
      if (!keys.includes(key)) {
        throw new Error(`Week ${week.week} contains unexpected elasticity for ${key}`);
      }
    }
    if (week.newAbsenceProbability !== undefined) {
      assertProbability(week.newAbsenceProbability, `Week ${week.week} new absence probability`);
    }
    if (week.recoveryProbability !== undefined) {
      assertProbability(week.recoveryProbability, `Week ${week.week} recovery probability`);
    }
  }

  assertProbability(input.availability.newAbsenceProbability, "new absence probability");
  assertProbability(input.availability.recoveryProbability, "recovery probability");
  assertProbability(input.availability.reserveRecoveryProbability, "reserve recovery probability");
  assertProbability(input.availability.limitedRoleMultiplier, "limited role multiplier");
  assertProbability(input.availability.returnRoleMultiplier, "return role multiplier");
  if (
    input.availability.state !== "active" &&
    input.availability.state !== "limited" &&
    input.availability.state !== "inactive" &&
    input.availability.state !== "reserve"
  ) {
    throw new RangeError("Unsupported ROS availability state");
  }
  assertPositive(input.role.currentMultiplier, "current role multiplier");
  assertProbability(input.role.persistence, "role persistence");
  assertNonNegative(input.role.innovationVolatility, "role innovation volatility");
  assertNonNegative(input.role.weeklyProductionVolatility, "weekly production volatility");
  if (input.role.innovationVolatility > 1) {
    throw new RangeError("role innovation volatility must not exceed one");
  }
  if (input.role.weeklyProductionVolatility > 2) {
    throw new RangeError("weekly production volatility must not exceed two");
  }
  if (input.role.centerVolatility !== undefined) {
    assertNonNegative(input.role.centerVolatility, "center volatility");
    if (input.role.centerVolatility > 0.6) {
      throw new RangeError("center volatility must not exceed 0.6");
    }
  }
  assertPositive(input.role.minimumMultiplier, "minimum role multiplier");
  assertPositive(input.role.maximumMultiplier, "maximum role multiplier");
  if (input.role.maximumMultiplier < input.role.minimumMultiplier) {
    throw new RangeError("maximum role multiplier must not be below the minimum");
  }
  if (input.role.minimumMultiplier > 1 || input.role.maximumMultiplier < 1) {
    throw new RangeError("role multiplier bounds must contain the long-run mean of one");
  }
  if (input.role.maximumMultiplier > 10) {
    throw new RangeError("maximum role multiplier must not exceed ten");
  }
  if (
    input.role.currentMultiplier < input.role.minimumMultiplier ||
    input.role.currentMultiplier > input.role.maximumMultiplier
  ) {
    throw new RangeError("current role multiplier must be inside the configured bounds");
  }
  if (position === "K") {
    const kicker = input.kicker;
    if (!kicker) {
      throw new Error("ROS kicker process input is required for position K under model v7");
    }
    assertFinite(kicker.fgEventDispersion, "kicker FG event dispersion");
    if (kicker.fgEventDispersion < 0.6 || kicker.fgEventDispersion > 1) {
      throw new RangeError("kicker FG event dispersion must be between 0.6 and 1");
    }
    assertFinite(kicker.xpDispersion, "kicker XP dispersion");
    if (kicker.xpDispersion < 0.7 || kicker.xpDispersion > 1.05) {
      throw new RangeError("kicker XP dispersion must be between 0.7 and 1.05");
    }
    assertFinite(kicker.recordedMissRatio, "kicker recorded miss ratio");
    if (kicker.recordedMissRatio < 0.85 || kicker.recordedMissRatio > 1) {
      throw new RangeError("kicker recorded miss ratio must be between 0.85 and 1");
    }
    assertNonNegative(kicker.centerVolatility, "kicker center volatility");
    if (kicker.centerVolatility > 1) {
      throw new RangeError("kicker center volatility must not exceed one");
    }
    if (kicker.bucketMix.length !== 3) {
      throw new RangeError("kicker bucket mix must contain exactly three shares");
    }
    let bucketMixSum = 0;
    for (const share of kicker.bucketMix) {
      assertNonNegative(share, "kicker bucket mix share");
      bucketMixSum += share;
    }
    if (Math.abs(bucketMixSum - 1) > 1e-8) {
      throw new RangeError("kicker bucket mix shares must sum to one");
    }
  } else if (input.kicker !== undefined) {
    throw new Error("ROS kicker process input is only supported for position K");
  }
  validateProjectionScoringProfile(input.scoringProfile);
  const scenarioCount = input.scenarioCount ?? FIRST_PARTY_ROS_DEFAULT_SCENARIOS;
  if (
    !Number.isSafeInteger(scenarioCount) ||
    scenarioCount < FIRST_PARTY_ROS_MINIMUM_SCENARIOS ||
    scenarioCount > FIRST_PARTY_ROS_MAXIMUM_SCENARIOS ||
    scenarioCount % 2 !== 0
  ) {
    throw new RangeError(
      `ROS scenarioCount must be an even integer between ${FIRST_PARTY_ROS_MINIMUM_SCENARIOS} and ${FIRST_PARTY_ROS_MAXIMUM_SCENARIOS}`,
    );
  }
  return { position, weeks, scenarioCount };
}

function initialState(
  availability: FirstPartyRosAvailabilityInput,
  role: FirstPartyRosRoleInput,
): ScenarioState {
  return {
    available: availability.state === "active" || availability.state === "limited",
    reserve: availability.state === "reserve",
    justReturned: false,
    limitedWeeksRemaining: availability.state === "limited" ? 1 : 0,
    roleLog: Math.log(role.currentMultiplier),
  };
}

function transitionAvailability(
  state: ScenarioState,
  week: FirstPartyRosWeeklyScenarioInput,
  availability: FirstPartyRosAvailabilityInput,
  draw: number,
): void {
  if (state.available) {
    const absenceProbability = week.scheduled
      ? (week.newAbsenceProbability ?? availability.newAbsenceProbability)
      : 0;
    if (draw < absenceProbability) {
      state.available = false;
      state.reserve = false;
      state.justReturned = false;
    }
    return;
  }
  const recoveryProbability =
    week.recoveryProbability ??
    (state.reserve ? availability.reserveRecoveryProbability : availability.recoveryProbability);
  if (draw < recoveryProbability) {
    state.available = true;
    state.reserve = false;
    state.justReturned = true;
  }
}

function evolveRole(
  state: ScenarioState,
  role: FirstPartyRosRoleInput,
  innovation: number,
): { readonly multiplier: number; readonly bounded: boolean } {
  // For X[t] = rho X[t-1] + intercept + sigma Z, stationary Var(X) is
  // sigma^2/(1-rho^2). Setting stationary E[X] to -Var(X)/2 makes E[exp(X)] exactly one before
  // bounds; the corresponding transition intercept simplifies to -sigma^2/(2(1+rho)).
  const stationaryMeanOneIntercept =
    (-0.5 * role.innovationVolatility ** 2) / (1 + role.persistence);
  state.roleLog =
    state.roleLog * role.persistence +
    role.innovationVolatility * innovation +
    stationaryMeanOneIntercept;
  const unbounded = Math.exp(state.roleLog);
  const multiplier = clamp(unbounded, role.minimumMultiplier, role.maximumMultiplier);
  state.roleLog = Math.log(multiplier);
  return { multiplier, bounded: multiplier !== unbounded };
}

function scaledComponents(
  base: ProjectionStatComponents,
  elasticities: Readonly<Record<string, FirstPartyRosComponentElasticity>>,
  roleMultiplier: number,
  productionInnovation: number,
  productionVolatility: number,
): Record<string, number> {
  return enforceFootballComponentInvariants(
    Object.fromEntries(
      Object.entries(base).map(([key, value]) => {
        const elasticity = elasticities[key]!;
        const effectiveVolatility = productionVolatility * elasticity.production;
        const productionMultiplier = Math.exp(
          effectiveVolatility * productionInnovation - 0.5 * effectiveVolatility ** 2,
        );
        const scaled = value * roleMultiplier ** elasticity.role * productionMultiplier;
        if (!Number.isFinite(scaled) || scaled < 0) {
          throw new RangeError(`Simulated component ${key} left its finite nonnegative domain`);
        }
        return [key, scaled];
      }),
    ),
  );
}

function addComponents(target: Record<string, number>, source: ProjectionStatComponents): void {
  for (const [key, value] of Object.entries(source)) target[key] = (target[key] ?? 0) + value;
}

function simulatePair(
  input: FirstPartyRosProjectionInput,
  weeks: readonly FirstPartyRosWeeklyScenarioInput[],
  random: () => number,
  weeklyPoints: number[][],
  weeklyAvailability: number[][],
  componentSums: Record<string, number>,
  audit: ScenarioPairAudit,
  kickerContext: KickerContext | null,
): {
  readonly left: ScenarioAccumulator;
  readonly right: ScenarioAccumulator;
  readonly boundedRoleSamples: number;
} {
  const leftState = initialState(input.availability, input.role);
  const rightState = initialState(input.availability, input.role);
  const left: ScenarioAccumulator = { totalPoints: 0, games: 0, components: {} };
  const right: ScenarioAccumulator = { totalPoints: 0, games: 0, components: {} };
  let boundedRoleSamples = 0;
  // Static, mean-one center-error multiplier: one antithetic draw per pair, constant across the
  // window. For non-K, when centerVolatility is zero no draw is consumed, preserving the v6
  // stream byte-for-byte. The kicker branch draws unconditionally so its stream layout never
  // depends on a calibrated parameter value.
  const centerVolatility = kickerContext
    ? kickerContext.process.centerVolatility
    : (input.role.centerVolatility ?? 0);
  const centerInnovation = kickerContext || centerVolatility > 0 ? normal(random) : 0;
  const leftCenter =
    centerVolatility > 0
      ? Math.exp(centerVolatility * centerInnovation - 0.5 * centerVolatility ** 2)
      : 1;
  const rightCenter =
    centerVolatility > 0
      ? Math.exp(-centerVolatility * centerInnovation - 0.5 * centerVolatility ** 2)
      : 1;
  for (let index = 0; index < weeks.length; index += 1) {
    const week = weeks[index]!;
    const availabilityDraw = random();
    transitionAvailability(leftState, week, input.availability, availabilityDraw);
    transitionAvailability(rightState, week, input.availability, 1 - availabilityDraw);
    // Kicker weeks replace the role/production normals with a fixed block of seven count
    // uniforms (FG fractional-n, FG total, three bucket splits, XP fractional-n, XP total),
    // drawn unconditionally every window week — bye, unavailable, and zero-intensity weeks
    // included — mirroring the unconditional role/production draws so path alignment is a pure
    // function of the window length. The kicker role multiplier is identically one: kicker
    // "role" (being the team's kicker) carries no meaningful snap-share dynamics, and the count
    // process already owns the weekly production noise a lognormal shock would double-count.
    let leftRoleMultiplier = 1;
    let rightRoleMultiplier = 1;
    let productionInnovation = 0;
    let countUniforms: readonly number[] | null = null;
    if (kickerContext) {
      countUniforms = [random(), random(), random(), random(), random(), random(), random()];
    } else {
      const roleInnovation = normal(random);
      const leftRole = evolveRole(leftState, input.role, roleInnovation);
      const rightRole = evolveRole(rightState, input.role, -roleInnovation);
      boundedRoleSamples += Number(leftRole.bounded) + Number(rightRole.bounded);
      leftRoleMultiplier = leftRole.multiplier;
      rightRoleMultiplier = rightRole.multiplier;
      productionInnovation = normal(random);
    }
    const pair = [
      {
        state: leftState,
        role: leftRoleMultiplier,
        center: leftCenter,
        production: productionInnovation,
        result: left,
      },
      {
        state: rightState,
        role: rightRoleMultiplier,
        center: rightCenter,
        production: -productionInnovation,
        result: right,
      },
    ] as const;
    for (let side = 0; side < pair.length; side += 1) {
      const scenario = pair[side]!;
      const available = week.scheduled && scenario.state.available;
      weeklyAvailability[index]!.push(available ? 1 : 0);
      let points = 0;
      if (available) {
        let availabilityRoleMultiplier = 1;
        if (scenario.state.limitedWeeksRemaining > 0) {
          availabilityRoleMultiplier *= input.availability.limitedRoleMultiplier;
        }
        if (scenario.state.justReturned) {
          availabilityRoleMultiplier *= input.availability.returnRoleMultiplier;
        }
        const roleMultiplier = scenario.role * availabilityRoleMultiplier * scenario.center;
        const base =
          input.strategy === "contextual" ? week.contextualComponents : week.recencyComponents;
        const components = kickerContext
          ? sampleKickerGame(
              kickerContext.weekParams[index]!,
              kickerContext.process,
              roleMultiplier,
              countUniforms!,
              side === 1,
            )
          : scaledComponents(
              base,
              week.componentElasticities,
              roleMultiplier,
              scenario.production,
              input.role.weeklyProductionVolatility,
            );
        addComponents(scenario.result.components, components);
        addComponents(componentSums, components);
        points = scoreProjectionStatComponents(components, input.scoringProfile);
        scenario.result.games += 1;
        audit[side === 0 ? "roleLeft" : "roleRight"].push(roleMultiplier);
      } else if (week.scheduled) {
        audit[side === 0 ? "roleLeft" : "roleRight"].push(scenario.role);
      }
      if (week.scheduled) {
        audit[side === 0 ? "availabilityLeft" : "availabilityRight"].push(available ? 1 : 0);
      }
      weeklyPoints[index]!.push(points);
      scenario.result.totalPoints += points;
      if (available) {
        scenario.state.justReturned = false;
        if (scenario.state.limitedWeeksRemaining > 0) scenario.state.limitedWeeksRemaining -= 1;
      }
    }
  }
  return { left, right, boundedRoleSamples };
}

function lagOneCorrelation(
  leftPaths: readonly number[][],
  rightPaths: readonly number[][],
): number | null {
  const lagged: number[] = [];
  const next: number[] = [];
  for (const path of [...leftPaths, ...rightPaths]) {
    for (let index = 1; index < path.length; index += 1) {
      lagged.push(path[index - 1] ?? 0);
      next.push(path[index] ?? 0);
    }
  }
  return correlation(lagged, next);
}

/**
 * Produces an aggregate ROS distribution from pinned per-week candidate centers. The Monte Carlo
 * paths model the entire remaining window jointly; total quantiles are never obtained by summing
 * marginal weekly intervals.
 */
export function projectFirstPartyRestOfSeason(
  input: FirstPartyRosProjectionInput,
): FirstPartyRosProjection {
  const validated = validateProjectionInput(input);
  const seedMaterial = `${FIRST_PARTY_ROS_SEED_VERSION}|${input.seed}|${input.inputChecksum}|${input.playerId}|${input.strategy}|${input.season}|${input.asOfWeek}|${input.asOfAt}|${input.windowStartWeek}|${input.windowEndWeek}`;
  const seedHash = sha256Hex(seedMaterial);
  const random = xoshiro128StarStar(seedHash);
  const totalPoints: number[] = [];
  const games: number[] = [];
  const weeklyPoints = validated.weeks.map((): number[] => []);
  const weeklyAvailability = validated.weeks.map((): number[] => []);
  const componentSums: Record<string, number> = Object.fromEntries(
    [...new Set(validated.weeks.flatMap((week) => componentKeys(week)))].map((key) => [key, 0]),
  );
  const availabilityLeftPaths: number[][] = [];
  const availabilityRightPaths: number[][] = [];
  const roleLeftPaths: number[][] = [];
  const roleRightPaths: number[][] = [];
  let boundedRoleSamples = 0;
  const kickerContext: KickerContext | null =
    validated.position === "K"
      ? {
          process: input.kicker!,
          weekParams: validated.weeks.map((week) =>
            kickerWeekParams(week, input.strategy, input.kicker!),
          ),
        }
      : null;
  for (let pairIndex = 0; pairIndex < validated.scenarioCount / 2; pairIndex += 1) {
    const audit: ScenarioPairAudit = {
      availabilityLeft: [],
      availabilityRight: [],
      roleLeft: [],
      roleRight: [],
    };
    const pair = simulatePair(
      input,
      validated.weeks,
      random,
      weeklyPoints,
      weeklyAvailability,
      componentSums,
      audit,
      kickerContext,
    );
    totalPoints.push(pair.left.totalPoints, pair.right.totalPoints);
    games.push(pair.left.games, pair.right.games);
    availabilityLeftPaths.push(audit.availabilityLeft);
    availabilityRightPaths.push(audit.availabilityRight);
    roleLeftPaths.push(audit.roleLeft);
    roleRightPaths.push(audit.roleRight);
    boundedRoleSamples += pair.boundedRoleSamples;
  }
  const scheduledGames = validated.weeks.filter((week) => week.scheduled).length;
  const diagnostics: FirstPartyRosDiagnostic[] = [
    {
      severity: "warning",
      code: "simulation_interval_not_calibrated",
      message:
        "P15/P85 are deterministic simulation quantiles and must not be described as historically calibrated until the season-level evaluator clears its evidence gates.",
    },
  ];
  if (input.availability.state === "inactive" || input.availability.state === "reserve") {
    diagnostics.push({
      severity: "info",
      code: "current_unavailability_persisted",
      message: "Current unavailability persists across scenarios until a modeled recovery occurs.",
    });
  }
  if (boundedRoleSamples > 0) {
    diagnostics.push({
      severity: "warning",
      code: "role_multiplier_bounded",
      message: `${boundedRoleSamples} simulated role states reached a configured fail-safe bound.`,
    });
  }
  if (scheduledGames === 0) {
    diagnostics.push({
      severity: "warning",
      code: "no_scheduled_games",
      message: "The requested ROS window contains no scheduled games.",
    });
  }
  const center = mean(totalPoints);
  return {
    state: scheduledGames === 0 ? "unavailable" : "projected",
    playerId: input.playerId,
    position: validated.position,
    expectedGames: mean(games),
    scheduledGames,
    meanPoints: center,
    standardDeviation: standardDeviation(totalPoints),
    p15Points: quantile(totalPoints, 0.15),
    p50Points: quantile(totalPoints, 0.5),
    p85Points: quantile(totalPoints, 0.85),
    expectedComponents: Object.fromEntries(
      Object.entries(componentSums)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => [key, value / validated.scenarioCount]),
    ),
    weekly: validated.weeks.map((week, index) => {
      const values = weeklyPoints[index] ?? [];
      const weeklyMean = mean(values);
      return {
        week: week.week,
        scheduled: week.scheduled,
        bye: week.bye,
        availabilityProbability: mean(weeklyAvailability[index] ?? []),
        meanPoints: weeklyMean,
        p15Points: quantile(values, 0.15),
        p50Points: quantile(values, 0.5),
        p85Points: quantile(values, 0.85),
      };
    }),
    weeklyMeanSemantics: "unconditional-includes-zero-for-bye-or-unavailable",
    simulation: {
      availabilityLagOneCorrelation: lagOneCorrelation(
        availabilityLeftPaths,
        availabilityRightPaths,
      ),
      roleLagOneCorrelation: lagOneCorrelation(roleLeftPaths, roleRightPaths),
      boundedRoleSamples,
    },
    provenance: {
      modelVersion: FIRST_PARTY_ROS_MODEL_VERSION,
      strategy: input.strategy,
      weeklyModelVersion: input.weeklyModelVersion,
      scoringProfileKey: projectionScoringProfileKey(input.scoringProfile),
      inputChecksum: input.inputChecksum,
      seedHash,
      randomGenerator: "xoshiro128**-sha256-128",
      scenarioCount: validated.scenarioCount,
      season: input.season,
      asOfWeek: input.asOfWeek,
      asOfAt: input.asOfAt,
      windowStartWeek: input.windowStartWeek,
      windowEndWeek: input.windowEndWeek,
      intervalCalibration: "simulation-only",
    },
    diagnostics,
  };
}

export type FirstPartyRosConvergenceMetricName =
  "expectedGames" | "meanPoints" | "p15Points" | "p50Points" | "p85Points";

export interface FirstPartyRosConvergenceMetric {
  readonly metric: FirstPartyRosConvergenceMetricName;
  readonly releaseValue: number;
  readonly referenceValue: number;
  readonly absoluteDifference: number;
  readonly relativeDifference: number | null;
  readonly allowedDifference: number;
  /** Absolute difference divided by the allowed difference; above one means not converged. */
  readonly toleranceRatio: number;
  readonly converged: boolean;
}

export interface FirstPartyRosConvergenceDiagnostic {
  readonly state: "converged" | "unstable";
  readonly seedHash: string;
  readonly releaseScenarioCount: typeof FIRST_PARTY_ROS_DEFAULT_SCENARIOS;
  readonly referenceScenarioCount: typeof FIRST_PARTY_ROS_CONVERGENCE_REFERENCE_SCENARIOS;
  readonly metrics: readonly FirstPartyRosConvergenceMetric[];
  /** The metric with the largest tolerance ratio, identifying what dominates any failure. */
  readonly worstMetric: FirstPartyRosConvergenceMetricName;
  readonly worstToleranceRatio: number;
  readonly message: string;
}

const ROS_CONVERGENCE_TOLERANCES: Readonly<
  Record<
    FirstPartyRosConvergenceMetricName,
    { readonly absolute: number; readonly relative: number }
  >
> = {
  expectedGames: { absolute: 0.1, relative: 0.02 },
  meanPoints: { absolute: 0.5, relative: 0.02 },
  p15Points: { absolute: 1, relative: 0.04 },
  p50Points: { absolute: 0.75, relative: 0.03 },
  p85Points: { absolute: 1, relative: 0.04 },
};

/**
 * Lattice-aware p50 tolerance for the kicker count process (owner-ratified 2026-07-23). Kicker
 * window totals under model v7 are exact integers, so the interpolating median hops between
 * adjacent lattice atoms in steps of one point; a p50 absolute tolerance below the lattice
 * spacing (0.75 < 1) misreads a single-atom hop between the release prefix and the reference run
 * as Monte Carlo instability (observed in the v7 replay at tolerance ratio exactly 4/3 on a
 * non-gating stratum; recurrence ~16% per full replay). Raising the kicker p50 absolute
 * tolerance to the lattice spacing — matching the p15/p85 tolerances that already sit at 1 — is
 * a measurement declaration for a discrete distribution family, not a coverage-gate change: the
 * coverage evidence gate, availability gates, and sample floors are untouched, and every non-K
 * position keeps the original tolerances byte-for-byte.
 */
const ROS_KICKER_P50_TOLERANCE = { absolute: 1, relative: 0.03 } as const;

/**
 * Deterministically compares the standard release run with a larger deterministic reference. The
 * release paths are an exact seeded prefix of the reference run; this diagnoses Monte Carlo
 * stability without changing a published forecast or claiming statistical calibration.
 */
export function diagnoseFirstPartyRosConvergence(
  input: FirstPartyRosProjectionInput,
): FirstPartyRosConvergenceDiagnostic {
  const release = projectFirstPartyRestOfSeason({
    ...input,
    scenarioCount: FIRST_PARTY_ROS_DEFAULT_SCENARIOS,
  });
  const reference = projectFirstPartyRestOfSeason({
    ...input,
    scenarioCount: FIRST_PARTY_ROS_CONVERGENCE_REFERENCE_SCENARIOS,
  });
  const values: Readonly<
    Record<
      FirstPartyRosConvergenceMetricName,
      { readonly releaseValue: number; readonly referenceValue: number }
    >
  > = {
    expectedGames: {
      releaseValue: release.expectedGames,
      referenceValue: reference.expectedGames,
    },
    meanPoints: {
      releaseValue: release.meanPoints,
      referenceValue: reference.meanPoints,
    },
    p15Points: {
      releaseValue: release.p15Points,
      referenceValue: reference.p15Points,
    },
    p50Points: {
      releaseValue: release.p50Points,
      referenceValue: reference.p50Points,
    },
    p85Points: {
      releaseValue: release.p85Points,
      referenceValue: reference.p85Points,
    },
  };
  const metrics = (Object.keys(values) as FirstPartyRosConvergenceMetricName[]).map((metric) => {
    const pair = values[metric];
    const tolerance =
      metric === "p50Points" && release.position === "K"
        ? ROS_KICKER_P50_TOLERANCE
        : ROS_CONVERGENCE_TOLERANCES[metric];
    const absoluteDifference = Math.abs(pair.releaseValue - pair.referenceValue);
    const referenceMagnitude = Math.abs(pair.referenceValue);
    const allowedDifference = Math.max(tolerance.absolute, referenceMagnitude * tolerance.relative);
    return {
      metric,
      releaseValue: pair.releaseValue,
      referenceValue: pair.referenceValue,
      absoluteDifference,
      relativeDifference: referenceMagnitude === 0 ? null : absoluteDifference / referenceMagnitude,
      allowedDifference,
      toleranceRatio: absoluteDifference / allowedDifference,
      converged: absoluteDifference <= allowedDifference,
    };
  });
  const converged = metrics.every((metric) => metric.converged);
  const worst = metrics.reduce((current, candidate) =>
    candidate.toleranceRatio > current.toleranceRatio ? candidate : current,
  );
  return {
    state: converged ? "converged" : "unstable",
    seedHash: reference.provenance.seedHash,
    releaseScenarioCount: FIRST_PARTY_ROS_DEFAULT_SCENARIOS,
    referenceScenarioCount: FIRST_PARTY_ROS_CONVERGENCE_REFERENCE_SCENARIOS,
    metrics,
    worstMetric: worst.metric,
    worstToleranceRatio: worst.toleranceRatio,
    message: converged
      ? `The ${FIRST_PARTY_ROS_DEFAULT_SCENARIOS}-path release distribution is within every declared tolerance of the deterministic ${FIRST_PARTY_ROS_CONVERGENCE_REFERENCE_SCENARIOS}-path reference.`
      : `At least one release-distribution statistic exceeds its declared ${FIRST_PARTY_ROS_CONVERGENCE_REFERENCE_SCENARIOS}-path reference tolerance; retain the prior good forecast or publish the larger run.`,
  };
}

export interface FirstPartyRosHeldOutCoverageEvidence {
  /** Fraction of required pinned candidate inputs that were present and publishable. */
  readonly contextual: number;
  readonly recency: number;
}

export interface FirstPartyRosHeldOutAvailabilityEvidence {
  readonly scheduledGames: number;
  readonly actualGames: number;
  readonly contextualExpectedGames: number;
  readonly recencyExpectedGames: number;
}

export interface FirstPartyRosHeldOutConvergenceCandidateEvidence {
  readonly state: "converged" | "unstable";
  /** Canonical checksum of the immutable release-vs-reference convergence diagnostic artifact. */
  readonly diagnosticChecksum: string;
}

export interface FirstPartyRosHeldOutEvidence {
  readonly coverage: FirstPartyRosHeldOutCoverageEvidence;
  readonly availability: FirstPartyRosHeldOutAvailabilityEvidence;
  readonly convergence: {
    readonly contextual: FirstPartyRosHeldOutConvergenceCandidateEvidence;
    readonly recency: FirstPartyRosHeldOutConvergenceCandidateEvidence;
  };
}

export interface FirstPartyRosEvidenceIdentity {
  readonly contextualModelVersion: string;
  readonly recencyModelVersion: string;
  readonly scoringProfileKey: string;
  readonly intervalMethodVersion: string;
}

/**
 * Rewrites an evidence identity into this interface's declared field order.
 *
 * An admitted champion policy is stored as PostgreSQL `jsonb`, which does not preserve object key
 * order — it reorders keys by length. Every identity comparison and artifact checksum below goes
 * through `JSON.stringify`, which IS order-sensitive, so a policy read back from the database
 * compared unequal to a byte-identical in-memory one and withheld a release that should have gone
 * out (`evidence-identity-mismatch`, `interval-calibration-unavailable`). Canonicalizing here makes
 * those comparisons depend on the four values and nothing else.
 *
 * This changes no threshold and no decision for equal identities. The canonical order is the same
 * order the code has always constructed these objects in, so every previously computed checksum is
 * reproduced byte-for-byte; only round-tripped objects change behavior, and only by now agreeing.
 */
function canonicalEvidenceIdentity(
  identity: FirstPartyRosEvidenceIdentity | null,
): FirstPartyRosEvidenceIdentity | null {
  if (identity === null) return null;
  return {
    contextualModelVersion: identity.contextualModelVersion,
    recencyModelVersion: identity.recencyModelVersion,
    scoringProfileKey: identity.scoringProfileKey,
    intervalMethodVersion: identity.intervalMethodVersion,
  };
}

function evidenceIdentitiesMatch(
  left: FirstPartyRosEvidenceIdentity | null,
  right: FirstPartyRosEvidenceIdentity | null,
): boolean {
  return (
    JSON.stringify(canonicalEvidenceIdentity(left)) ===
    JSON.stringify(canonicalEvidenceIdentity(right))
  );
}

/**
 * Builds the scoring profile a stored whole-profile key denotes, mirroring
 * `firstPartyRosArtifactScoringProfile` (`apps/worker/src/first-party-ros-publication.ts`). The
 * round trip inside `projectionScoringRulesFromProfileKey` throws on any key that is not the
 * canonical JSON it claims to be, so callers must treat a throw as "not comparable" (fail closed).
 */
function recoveredEvidenceScoringProfile(scoringProfileKey: string): ProjectionScoringProfile {
  return {
    id: "recovered-evidence-identity-profile",
    rules: projectionScoringRulesFromProfileKey(scoringProfileKey),
  };
}

/**
 * Position-scoped evidence-identity comparison for the live release gate (2026-07-29).
 *
 * The three version fields (`contextualModelVersion`, `recencyModelVersion`,
 * `intervalMethodVersion`) must be strictly equal — a model or interval-method drift is a real
 * identity change for every position, and no scoping can excuse it. Only the scoring-profile
 * comparison is scoped, and it is scoped to exactly the cell being gated:
 *
 * - Byte-equal whole keys match immediately. This fast path is also the only way two keys that are
 *   not canonical whole-profile keys can ever match, so identities carrying opaque or legacy keys
 *   keep the exact whole-key behavior they have always had.
 * - Otherwise each key is recovered into its rule list via `projectionScoringRulesFromProfileKey`;
 *   a key that does not round-trip is corrupt rather than merely different, and refuses to match
 *   (fail closed).
 * - Each recovered profile is reduced to the gated position's own scoped key
 *   (`projectionScoringProfileKeyForPosition`). A scoped key of `"[]"` — a profile that prices
 *   nothing for the position — must never read as agreement, even against another `"[]"`: two
 *   empty subsets are not evidence of identical scoring (`scoring-position-keys.ts` states this
 *   hazard, and `matchFirstPartyRosPositions` in `apps/worker/src/first-party-ros-publication.ts`
 *   enforces the same rule).
 * - The identities match iff the scoped keys are byte-equal.
 *
 * Why scoping is sound: positions never interact numerically — a rule outside the position's
 * component vocabulary contributes exactly 0 to its score (`matchFirstPartyRosPositions`) — so a
 * rule the position cannot see, for example a D/ST rule joining the league profile the day D/ST
 * becomes supported, cannot change the position's scoring behavior. Byte-equal scoped keys mean
 * byte-identical scoring for the cell being gated, which is what keeps the ROS rail publishing for
 * a league whose whole profile key moves for reasons that cannot touch the rail positions.
 */
function evidenceIdentitiesMatchForPosition(
  admitted: FirstPartyRosEvidenceIdentity | null,
  live: FirstPartyRosEvidenceIdentity | null,
  position: FirstPartyRosPosition,
): boolean {
  if (admitted === null || live === null) return admitted === live;
  if (
    admitted.contextualModelVersion !== live.contextualModelVersion ||
    admitted.recencyModelVersion !== live.recencyModelVersion ||
    admitted.intervalMethodVersion !== live.intervalMethodVersion
  ) {
    return false;
  }
  if (admitted.scoringProfileKey === live.scoringProfileKey) return true;
  let admittedScopedKey: string;
  let liveScopedKey: string;
  try {
    // `FirstPartyRosPosition` is assignable to `LeagueScoringPosition` (the unions are identical);
    // if they ever diverge this stops compiling, which is the fail-closed outcome we want.
    admittedScopedKey = projectionScoringProfileKeyForPosition(
      recoveredEvidenceScoringProfile(admitted.scoringProfileKey),
      position,
    );
    liveScopedKey = projectionScoringProfileKeyForPosition(
      recoveredEvidenceScoringProfile(live.scoringProfileKey),
      position,
    );
  } catch {
    return false;
  }
  if (admittedScopedKey === "[]" || liveScopedKey === "[]") return false;
  return admittedScopedKey === liveScopedKey;
}

export interface FirstPartyRosHeldOutForecast extends FirstPartyRosEvidenceIdentity {
  readonly playerId: string;
  readonly position: FirstPartyRosPosition;
  readonly forecastSeason: number;
  readonly asOfWeek: number;
  readonly windowStartWeek: number;
  readonly windowEndWeek: number;
  /** Must be strictly before forecastSeason; current-season outcomes cannot train its own policy. */
  readonly trainedThroughSeason: number;
  readonly inputChecksum: string;
  readonly evidence: FirstPartyRosHeldOutEvidence;
  readonly contextual: {
    readonly meanPoints: number;
    readonly p15Points: number;
    readonly p50Points: number;
    readonly p85Points: number;
  };
  readonly recency: {
    readonly meanPoints: number;
    readonly p15Points: number;
    readonly p50Points: number;
    readonly p85Points: number;
  };
  readonly actualPoints: number;
}

export interface FirstPartyRosHeldOutSeason {
  readonly season: number;
  /** An incomplete season is rejected because its overlapping ROS outcomes are unresolved. */
  readonly complete: boolean;
  readonly forecasts: readonly FirstPartyRosHeldOutForecast[];
}

export interface FirstPartyRosChampionOptions {
  /** Global held-out seasons across the complete evaluation corpus. */
  readonly minimumHeldOutSeasons?: number;
  /** Global unique season/cutoff batches across all position/window cells. */
  readonly minimumBatches?: number;
  /** Global paired outcome rows across the complete evaluation corpus. */
  readonly minimumSamples?: number;
  readonly minimumCellSeasons?: number;
  readonly minimumCellSamples?: number;
  readonly minimumCellCutoffs?: number;
  readonly minimumCellBatches?: number;
  readonly minimumModelImprovement?: number;
}

export interface FirstPartyRosDerivedHeldOutEvidence {
  readonly state: "derived-immutable-not-calibrated" | "insufficient-evidence";
  readonly evidenceChecksum: string | null;
  readonly nominalCentralIntervalCoverage: 0.7;
  readonly contextualObservedIntervalCoverage: number;
  readonly recencyObservedIntervalCoverage: number;
  readonly contextualMeanInputCoverage: number;
  readonly recencyMeanInputCoverage: number;
  readonly contextualAvailabilityMae: number;
  readonly recencyAvailabilityMae: number;
  /** Block-weighted mean of signed (expected minus actual) games; detects hazard mismatch. */
  readonly contextualAvailabilityBias: number;
  readonly recencyAvailabilityBias: number;
  readonly contextualConvergenceRate: number;
  readonly recencyConvergenceRate: number;
  readonly seasons: number;
  readonly blocks: number;
  readonly samples: number;
  /** Held-out coverage is descriptive evidence only, never a calibration claim. */
  readonly intervalCalibration: "not-calibrated";
}

export interface FirstPartyRosIntervalCalibrationArtifact {
  readonly state: "calibrated" | "not-calibrated";
  readonly calibrationVersion: typeof FIRST_PARTY_ROS_INTERVAL_CALIBRATION_VERSION;
  readonly strategy: FirstPartyRosStrategy;
  readonly position: FirstPartyRosPosition;
  readonly bucket: FirstPartyRosRemainingWeeksBucket;
  readonly evidenceIdentity: FirstPartyRosEvidenceIdentity | null;
  readonly nominalCoverage: 0.7;
  readonly lowerQuantile: 0.15;
  readonly upperQuantile: 0.85;
  /** Symmetric nonnegative CQR expansion learned from season/cutoff block maxima. */
  readonly adjustmentPoints: number;
  readonly observedCalibratedBlockCoverage: number;
  readonly trainedThroughSeason: number | null;
  readonly seasons: number;
  readonly blocks: number;
  readonly samples: number;
  readonly evidenceChecksum: string | null;
  readonly artifactChecksum: string | null;
}

export interface FirstPartyRosCalibratedInterval {
  readonly p15Points: number;
  readonly p50Points: number;
  readonly p85Points: number;
  readonly intervalCalibration: "split-conformal-cqr" | "not-calibrated";
  readonly calibrationArtifactChecksum: string | null;
}

export interface FirstPartyRosWalkForwardCalibrationEvidence {
  readonly state: "available" | "unavailable";
  readonly observedBlockCoverage: number;
  readonly seasons: number;
  readonly blocks: number;
  readonly samples: number;
  readonly evidenceChecksum: string | null;
}

export interface FirstPartyRosChampionChoice {
  readonly position: FirstPartyRosPosition;
  readonly bucket: FirstPartyRosRemainingWeeksBucket;
  readonly strategy: FirstPartyRosStrategy;
  readonly reason:
    | "model-cleared-margin"
    | "baseline-defended"
    | "insufficient-global-evidence"
    | "insufficient-statistical-evidence"
    | "sparse-cell";
  readonly heldOutSeasons: number;
  /** Unique season/cutoff batches in this position/window cell. */
  readonly batches: number;
  /** Unique season/cutoff batches across the complete held-out evaluation corpus. */
  readonly globalBatches: number;
  readonly globalSeasons: number;
  readonly globalSamples: number;
  readonly distinctCutoffs: number;
  readonly samples: number;
  readonly contextualMae: number;
  readonly recencyMae: number;
  readonly contextualWeightedIntervalScore: number;
  readonly recencyWeightedIntervalScore: number;
  readonly modelImprovement: number;
  /** One paired block per season/cutoff; player rows inside a block never inflate precision. */
  readonly pairedBlocks: number;
  readonly modelImprovementLowerBound: number | null;
  readonly intervalScoreDifferenceUpperBound: number | null;
  readonly uncertaintyMethod: "paired-season-clustered-one-sided-95";
  readonly heldOutEvidence: FirstPartyRosDerivedHeldOutEvidence;
  readonly intervalCalibrationArtifacts: {
    readonly contextual: FirstPartyRosIntervalCalibrationArtifact;
    readonly recency: FirstPartyRosIntervalCalibrationArtifact;
  };
  readonly walkForwardCalibrationEvidence: {
    readonly contextual: FirstPartyRosWalkForwardCalibrationEvidence;
    readonly recency: FirstPartyRosWalkForwardCalibrationEvidence;
  };
  /** Calibration applies only after a season-blocked immutable artifact clears every gate. */
  readonly intervalCalibration: "split-conformal-cqr" | "not-calibrated";
}

export interface FirstPartyRosChampionPolicy {
  readonly policyVersion: typeof FIRST_PARTY_ROS_POLICY_VERSION;
  readonly modelVersion: typeof FIRST_PARTY_ROS_MODEL_VERSION;
  readonly evidenceThroughSeason: number | null;
  readonly minimumHeldOutSeasons: number;
  readonly minimumBatches: number;
  readonly minimumSamples: number;
  readonly minimumCellSeasons: number;
  readonly minimumCellSamples: number;
  readonly minimumCellCutoffs: number;
  readonly minimumCellBatches: number;
  readonly minimumModelImprovement: number;
  readonly globalBatches: number;
  readonly globalSeasons: number;
  readonly globalSamples: number;
  readonly evidenceIdentity: FirstPartyRosEvidenceIdentity | null;
  readonly choices: readonly FirstPartyRosChampionChoice[];
}

export interface FirstPartyRosSelectedEvaluation {
  readonly playerId: string;
  readonly forecastSeason: number;
  readonly asOfWeek: number;
  readonly position: FirstPartyRosPosition;
  readonly bucket: FirstPartyRosRemainingWeeksBucket;
  readonly strategy: FirstPartyRosStrategy;
  readonly predictedMean: number;
  readonly p15Points: number;
  readonly p50Points: number;
  readonly p85Points: number;
  readonly intervalCalibration: "split-conformal-cqr" | "not-calibrated";
  readonly calibrationArtifactChecksum: string | null;
  readonly intervalCovered: boolean | null;
  readonly actualPoints: number;
}

export interface FirstPartyRosSeasonPolicyAudit {
  readonly season: number;
  readonly evidenceThroughSeason: number | null;
  readonly policy: FirstPartyRosChampionPolicy;
}

export interface FirstPartyRosChampionEvaluation {
  /** Policy available for the next season after every supplied complete held-out season resolves. */
  readonly livePolicy: FirstPartyRosChampionPolicy;
  /** One audit entry per season, captured before that season's outcomes update evidence. */
  readonly seasonPolicies: readonly FirstPartyRosSeasonPolicyAudit[];
  readonly selected: readonly FirstPartyRosSelectedEvaluation[];
}

interface ErrorEvidence {
  readonly seasons: Set<number>;
  readonly batches: Set<string>;
  readonly blocks: Map<string, PairedErrorBlock>;
  readonly records: HeldOutEvidenceRecord[];
  readonly walkForwardCalibration: {
    readonly contextual: WalkForwardCalibrationRecord[];
    readonly recency: WalkForwardCalibrationRecord[];
  };
  contextualAbsoluteError: number[];
  recencyAbsoluteError: number[];
  contextualIntervalScore: number[];
  recencyIntervalScore: number[];
}

interface WalkForwardCalibrationRecord {
  readonly season: number;
  readonly cutoffWeek: number;
  readonly playerId: string;
  readonly covered: boolean;
  readonly artifactChecksum: string;
}

interface PendingWalkForwardCalibrationRecord extends WalkForwardCalibrationRecord {
  readonly position: FirstPartyRosPosition;
  readonly bucket: FirstPartyRosRemainingWeeksBucket;
  readonly strategy: FirstPartyRosStrategy;
}

interface HeldOutEvidenceRecord {
  readonly identity: string;
  readonly blockKey: string;
  readonly inputChecksum: string;
  readonly contextualModelVersion: string;
  readonly recencyModelVersion: string;
  readonly scoringProfileKey: string;
  readonly intervalMethodVersion: string;
  readonly actualPoints: number;
  readonly contextualMeanPoints: number;
  readonly contextualP15Points: number;
  readonly contextualP50Points: number;
  readonly contextualP85Points: number;
  readonly recencyMeanPoints: number;
  readonly recencyP15Points: number;
  readonly recencyP50Points: number;
  readonly recencyP85Points: number;
  readonly scheduledGames: number;
  readonly actualGames: number;
  readonly contextualExpectedGames: number;
  readonly recencyExpectedGames: number;
  readonly contextualConvergenceChecksum: string;
  readonly recencyConvergenceChecksum: string;
  readonly contextualAbsoluteError: number;
  readonly recencyAbsoluteError: number;
  readonly contextualIntervalScore: number;
  readonly recencyIntervalScore: number;
  readonly contextualIntervalHit: boolean;
  readonly recencyIntervalHit: boolean;
  readonly contextualCoverage: number;
  readonly recencyCoverage: number;
  readonly contextualAvailabilityError: number;
  readonly recencyAvailabilityError: number;
  readonly contextualAvailabilitySignedError: number;
  readonly recencyAvailabilitySignedError: number;
  readonly contextualConverged: boolean;
  readonly recencyConverged: boolean;
}

interface PairedErrorBlock {
  readonly season: number;
  readonly cutoffWeek: number;
  readonly contextualAbsoluteError: number[];
  readonly recencyAbsoluteError: number[];
  readonly contextualIntervalScore: number[];
  readonly recencyIntervalScore: number[];
}

function remainingWeeksBucket(
  startWeek: number,
  endWeek: number,
): FirstPartyRosRemainingWeeksBucket {
  const remaining = endWeek - startWeek + 1;
  return remaining <= 4 ? "one-to-four" : remaining <= 8 ? "five-to-eight" : "nine-plus";
}

function intervalScore(actual: number, lower: number, upper: number, alpha = 0.3): number {
  const boundedLower = Math.min(lower, upper);
  const boundedUpper = Math.max(lower, upper);
  return (
    boundedUpper -
    boundedLower +
    (actual < boundedLower ? (2 / alpha) * (boundedLower - actual) : 0) +
    (actual > boundedUpper ? (2 / alpha) * (actual - boundedUpper) : 0)
  );
}

function standardWeightedIntervalScore(
  actual: number,
  predictedMedian: number,
  lower: number,
  upper: number,
  alpha = 0.3,
): number {
  // Standard single-central-interval WIS: (0.5 * median error + alpha/2 * interval score)
  // divided by K + 0.5, with K = 1. The median—not the arithmetic mean—backs the point term.
  return (
    (0.5 * Math.abs(actual - predictedMedian) +
      (alpha / 2) * intervalScore(actual, lower, upper, alpha)) /
    1.5
  );
}

function evidenceKey(
  position: FirstPartyRosPosition,
  bucket: FirstPartyRosRemainingWeeksBucket,
): string {
  return `${position}:${bucket}`;
}

function emptyEvidence(): ErrorEvidence {
  return {
    seasons: new Set(),
    batches: new Set(),
    blocks: new Map(),
    records: [],
    walkForwardCalibration: { contextual: [], recency: [] },
    contextualAbsoluteError: [],
    recencyAbsoluteError: [],
    contextualIntervalScore: [],
    recencyIntervalScore: [],
  };
}

function resolvedChampionOptions(options: FirstPartyRosChampionOptions) {
  const resolved = {
    minimumHeldOutSeasons:
      options.minimumHeldOutSeasons ?? FIRST_PARTY_ROS_MINIMUM_HELD_OUT_SEASONS,
    minimumBatches: options.minimumBatches ?? FIRST_PARTY_ROS_MINIMUM_BATCHES,
    minimumSamples: options.minimumSamples ?? FIRST_PARTY_ROS_MINIMUM_SAMPLES,
    minimumCellSeasons: options.minimumCellSeasons ?? FIRST_PARTY_ROS_MINIMUM_CELL_SEASONS,
    minimumCellSamples: options.minimumCellSamples ?? FIRST_PARTY_ROS_MINIMUM_CELL_SAMPLES,
    minimumCellCutoffs: options.minimumCellCutoffs ?? FIRST_PARTY_ROS_MINIMUM_CELL_CUTOFFS,
    minimumCellBatches: options.minimumCellBatches ?? FIRST_PARTY_ROS_MINIMUM_CELL_BATCHES,
    minimumModelImprovement:
      options.minimumModelImprovement ?? FIRST_PARTY_ROS_MINIMUM_MODEL_IMPROVEMENT,
  };
  if (!Number.isSafeInteger(resolved.minimumHeldOutSeasons) || resolved.minimumHeldOutSeasons < 2) {
    throw new RangeError("minimumHeldOutSeasons must be an integer of at least two");
  }
  if (!Number.isSafeInteger(resolved.minimumBatches) || resolved.minimumBatches <= 0) {
    throw new RangeError("minimumBatches must be a positive integer");
  }
  if (!Number.isSafeInteger(resolved.minimumSamples) || resolved.minimumSamples <= 0) {
    throw new RangeError("minimumSamples must be a positive integer");
  }
  if (!Number.isSafeInteger(resolved.minimumCellSeasons) || resolved.minimumCellSeasons < 2) {
    throw new RangeError("minimumCellSeasons must be an integer of at least two");
  }
  if (!Number.isSafeInteger(resolved.minimumCellSamples) || resolved.minimumCellSamples <= 0) {
    throw new RangeError("minimumCellSamples must be a positive integer");
  }
  if (!Number.isSafeInteger(resolved.minimumCellCutoffs) || resolved.minimumCellCutoffs <= 0) {
    throw new RangeError("minimumCellCutoffs must be a positive integer");
  }
  if (!Number.isSafeInteger(resolved.minimumCellBatches) || resolved.minimumCellBatches <= 0) {
    throw new RangeError("minimumCellBatches must be a positive integer");
  }
  assertProbability(resolved.minimumModelImprovement, "minimum model improvement");
  return resolved;
}

function sampleStandardError(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const center = mean(values);
  const sampleVariance =
    values.reduce((sum, value) => sum + (value - center) ** 2, 0) / (values.length - 1);
  return Math.sqrt(sampleVariance / values.length);
}

/** Conservative one-sided 95% Student-t critical value for small held-out season counts. */
function oneSided95CriticalValue(degreesOfFreedom: number): number {
  const table = [
    6.314, 2.92, 2.353, 2.132, 2.015, 1.943, 1.895, 1.86, 1.833, 1.812, 1.796, 1.782, 1.771, 1.761,
    1.753, 1.746, 1.74, 1.734, 1.729, 1.725,
  ] as const;
  if (degreesOfFreedom <= 0) return Number.POSITIVE_INFINITY;
  if (degreesOfFreedom <= table.length) return table[degreesOfFreedom - 1]!;
  if (degreesOfFreedom <= 30) return 1.697;
  if (degreesOfFreedom <= 60) return 1.671;
  if (degreesOfFreedom <= 120) return 1.658;
  return 1.645;
}

function seasonClusteredDifferences(
  blocks: readonly PairedErrorBlock[],
  difference: (block: PairedErrorBlock) => number,
): readonly number[] {
  const bySeason = new Map<number, number[]>();
  for (const block of blocks) {
    const values = bySeason.get(block.season) ?? [];
    values.push(difference(block));
    bySeason.set(block.season, values);
  }
  return [...bySeason.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, values]) => mean(values));
}

function blockWeightedRecordMean(
  records: readonly HeldOutEvidenceRecord[],
  select: (record: HeldOutEvidenceRecord) => number,
): number {
  const byBlock = new Map<string, number[]>();
  for (const record of records) {
    const values = byBlock.get(record.blockKey) ?? [];
    values.push(select(record));
    byBlock.set(record.blockKey, values);
  }
  return mean([...byBlock.values()].map((values) => mean(values)));
}

function derivedHeldOutEvidence(
  evidence: ErrorEvidence,
  enoughEvidence: boolean,
): FirstPartyRosDerivedHeldOutEvidence {
  const records = [...evidence.records].sort((left, right) =>
    left.identity.localeCompare(right.identity),
  );
  return {
    state: enoughEvidence ? "derived-immutable-not-calibrated" : "insufficient-evidence",
    evidenceChecksum: records.length === 0 ? null : sha256Hex(JSON.stringify(records)),
    nominalCentralIntervalCoverage: 0.7,
    contextualObservedIntervalCoverage: blockWeightedRecordMean(records, (record) =>
      Number(record.contextualIntervalHit),
    ),
    recencyObservedIntervalCoverage: blockWeightedRecordMean(records, (record) =>
      Number(record.recencyIntervalHit),
    ),
    contextualMeanInputCoverage: blockWeightedRecordMean(
      records,
      (record) => record.contextualCoverage,
    ),
    recencyMeanInputCoverage: blockWeightedRecordMean(records, (record) => record.recencyCoverage),
    contextualAvailabilityMae: blockWeightedRecordMean(
      records,
      (record) => record.contextualAvailabilityError,
    ),
    recencyAvailabilityMae: blockWeightedRecordMean(
      records,
      (record) => record.recencyAvailabilityError,
    ),
    contextualAvailabilityBias: blockWeightedRecordMean(
      records,
      (record) => record.contextualAvailabilitySignedError,
    ),
    recencyAvailabilityBias: blockWeightedRecordMean(
      records,
      (record) => record.recencyAvailabilitySignedError,
    ),
    contextualConvergenceRate: blockWeightedRecordMean(records, (record) =>
      Number(record.contextualConverged),
    ),
    recencyConvergenceRate: blockWeightedRecordMean(records, (record) =>
      Number(record.recencyConverged),
    ),
    seasons: evidence.seasons.size,
    blocks: evidence.blocks.size,
    samples: records.length,
    intervalCalibration: "not-calibrated",
  };
}

function cqrNonconformity(actual: number, lower: number, upper: number): number {
  return Math.max(0, Math.min(lower, upper) - actual, actual - Math.max(lower, upper));
}

function calibrationBlockScores(
  records: readonly HeldOutEvidenceRecord[],
  strategy: FirstPartyRosStrategy,
): readonly number[] {
  const byBlock = new Map<string, number[]>();
  for (const record of records) {
    const score =
      strategy === "contextual"
        ? cqrNonconformity(
            record.actualPoints,
            record.contextualP15Points,
            record.contextualP85Points,
          )
        : cqrNonconformity(record.actualPoints, record.recencyP15Points, record.recencyP85Points);
    const scores = byBlock.get(record.blockKey) ?? [];
    scores.push(score);
    byBlock.set(record.blockKey, scores);
  }
  // A block contributes its worst row. This preserves season/cutoff blocking instead of treating
  // correlated players in one slate as independent conformal samples.
  return [...byBlock.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, scores]) => Math.max(...scores));
}

type FirstPartyRosCalibrationArtifactPayload = Omit<
  FirstPartyRosIntervalCalibrationArtifact,
  "state" | "artifactChecksum"
>;

function intervalCalibrationArtifactChecksum(
  artifact: FirstPartyRosCalibrationArtifactPayload,
): string {
  return sha256Hex(
    JSON.stringify({
      calibrationVersion: artifact.calibrationVersion,
      strategy: artifact.strategy,
      position: artifact.position,
      bucket: artifact.bucket,
      evidenceIdentity: canonicalEvidenceIdentity(artifact.evidenceIdentity),
      nominalCoverage: artifact.nominalCoverage,
      lowerQuantile: artifact.lowerQuantile,
      upperQuantile: artifact.upperQuantile,
      adjustmentPoints: artifact.adjustmentPoints,
      observedCalibratedBlockCoverage: artifact.observedCalibratedBlockCoverage,
      trainedThroughSeason: artifact.trainedThroughSeason,
      seasons: artifact.seasons,
      blocks: artifact.blocks,
      samples: artifact.samples,
      evidenceChecksum: artifact.evidenceChecksum,
    }),
  );
}

function intervalCalibrationArtifactIsValid(
  artifact: FirstPartyRosIntervalCalibrationArtifact,
): boolean {
  return (
    artifact.state === "calibrated" &&
    artifact.calibrationVersion === FIRST_PARTY_ROS_INTERVAL_CALIBRATION_VERSION &&
    artifact.nominalCoverage === 0.7 &&
    artifact.lowerQuantile === 0.15 &&
    artifact.upperQuantile === 0.85 &&
    Number.isFinite(artifact.adjustmentPoints) &&
    artifact.adjustmentPoints >= 0 &&
    Number.isFinite(artifact.observedCalibratedBlockCoverage) &&
    artifact.observedCalibratedBlockCoverage >= 0 &&
    artifact.observedCalibratedBlockCoverage <= 1 &&
    artifact.trainedThroughSeason !== null &&
    Number.isSafeInteger(artifact.trainedThroughSeason) &&
    Number.isSafeInteger(artifact.seasons) &&
    artifact.seasons > 0 &&
    Number.isSafeInteger(artifact.blocks) &&
    artifact.blocks > 0 &&
    Number.isSafeInteger(artifact.samples) &&
    artifact.samples > 0 &&
    artifact.evidenceIdentity !== null &&
    artifact.evidenceChecksum !== null &&
    /^[a-f0-9]{64}$/u.test(artifact.evidenceChecksum) &&
    artifact.artifactChecksum !== null &&
    /^[a-f0-9]{64}$/u.test(artifact.artifactChecksum) &&
    artifact.artifactChecksum === intervalCalibrationArtifactChecksum(artifact)
  );
}

function buildIntervalCalibrationArtifact(
  position: FirstPartyRosPosition,
  bucket: FirstPartyRosRemainingWeeksBucket,
  strategy: FirstPartyRosStrategy,
  evidence: ErrorEvidence,
  evidenceIdentity: FirstPartyRosEvidenceIdentity | null,
  enoughEvidence: boolean,
  evidenceChecksum: string | null,
): FirstPartyRosIntervalCalibrationArtifact {
  const scores = calibrationBlockScores(evidence.records, strategy);
  const trainedThroughSeason =
    evidence.seasons.size === 0 ? null : Math.max(...evidence.seasons.values());
  if (!enoughEvidence || evidenceIdentity === null || evidenceChecksum === null) {
    return {
      state: "not-calibrated",
      calibrationVersion: FIRST_PARTY_ROS_INTERVAL_CALIBRATION_VERSION,
      strategy,
      position,
      bucket,
      evidenceIdentity,
      nominalCoverage: 0.7,
      lowerQuantile: 0.15,
      upperQuantile: 0.85,
      adjustmentPoints: 0,
      observedCalibratedBlockCoverage: 0,
      trainedThroughSeason,
      seasons: evidence.seasons.size,
      blocks: scores.length,
      samples: evidence.records.length,
      evidenceChecksum,
      artifactChecksum: null,
    };
  }
  // Split-conformal finite-sample rank ceil((n+1)*(1-alpha)), alpha=.30. Evidence gates ensure
  // enough blocks that this rank exists. Scores are nonnegative, so calibration never narrows or
  // reverses the candidate interval.
  const orderedScores = [...scores].sort((left, right) => left - right);
  const rank = Math.ceil((orderedScores.length + 1) * 0.7);
  if (rank < 1 || rank > orderedScores.length) {
    return {
      state: "not-calibrated",
      calibrationVersion: FIRST_PARTY_ROS_INTERVAL_CALIBRATION_VERSION,
      strategy,
      position,
      bucket,
      evidenceIdentity,
      nominalCoverage: 0.7,
      lowerQuantile: 0.15,
      upperQuantile: 0.85,
      adjustmentPoints: 0,
      observedCalibratedBlockCoverage: 0,
      trainedThroughSeason,
      seasons: evidence.seasons.size,
      blocks: scores.length,
      samples: evidence.records.length,
      evidenceChecksum,
      artifactChecksum: null,
    };
  }
  const adjustmentPoints = orderedScores[rank - 1]!;
  const observedCalibratedBlockCoverage = mean(
    orderedScores.map((score) => Number(score <= adjustmentPoints)),
  );
  const artifactPayload = {
    calibrationVersion: FIRST_PARTY_ROS_INTERVAL_CALIBRATION_VERSION,
    strategy,
    position,
    bucket,
    evidenceIdentity,
    nominalCoverage: 0.7,
    lowerQuantile: 0.15,
    upperQuantile: 0.85,
    adjustmentPoints,
    observedCalibratedBlockCoverage,
    trainedThroughSeason,
    seasons: evidence.seasons.size,
    blocks: scores.length,
    samples: evidence.records.length,
    evidenceChecksum,
  } as const;
  return {
    state: "calibrated",
    ...artifactPayload,
    artifactChecksum: intervalCalibrationArtifactChecksum(artifactPayload),
  };
}

/** Applies a previously season-locked CQR artifact; uncalibrated artifacts leave inputs unchanged. */
export function applyFirstPartyRosIntervalCalibration(
  interval: {
    readonly p15Points: number;
    readonly p50Points: number;
    readonly p85Points: number;
  },
  artifact: FirstPartyRosIntervalCalibrationArtifact,
): FirstPartyRosCalibratedInterval {
  for (const [label, value] of [
    ["P15", interval.p15Points],
    ["P50", interval.p50Points],
    ["P85", interval.p85Points],
  ] as const) {
    assertFinite(value, `ROS interval ${label}`);
  }
  if (interval.p15Points > interval.p50Points || interval.p50Points > interval.p85Points) {
    throw new RangeError("ROS interval quantiles must be ordered P15, P50, P85");
  }
  if (!intervalCalibrationArtifactIsValid(artifact)) {
    return {
      ...interval,
      intervalCalibration: "not-calibrated",
      calibrationArtifactChecksum: null,
    };
  }
  assertNonNegative(artifact.adjustmentPoints, "ROS conformal adjustment");
  return {
    p15Points: interval.p15Points - artifact.adjustmentPoints,
    p50Points: interval.p50Points,
    p85Points: interval.p85Points + artifact.adjustmentPoints,
    intervalCalibration: "split-conformal-cqr",
    calibrationArtifactChecksum: artifact.artifactChecksum,
  };
}

function walkForwardCalibrationEvidence(
  records: readonly WalkForwardCalibrationRecord[],
): FirstPartyRosWalkForwardCalibrationEvidence {
  const ordered = [...records].sort(
    (left, right) =>
      left.season - right.season ||
      left.cutoffWeek - right.cutoffWeek ||
      left.playerId.localeCompare(right.playerId) ||
      left.artifactChecksum.localeCompare(right.artifactChecksum),
  );
  const byBlock = new Map<string, boolean[]>();
  for (const record of ordered) {
    const key = `${record.season}:${record.cutoffWeek}`;
    const hits = byBlock.get(key) ?? [];
    hits.push(record.covered);
    byBlock.set(key, hits);
  }
  const blockHits = [...byBlock.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, hits]) => Number(hits.every(Boolean)));
  return {
    state: ordered.length === 0 ? "unavailable" : "available",
    observedBlockCoverage: mean(blockHits),
    seasons: new Set(ordered.map((record) => record.season)).size,
    blocks: blockHits.length,
    samples: ordered.length,
    evidenceChecksum: ordered.length === 0 ? null : sha256Hex(JSON.stringify(ordered)),
  };
}

function choiceFromEvidence(
  position: FirstPartyRosPosition,
  bucket: FirstPartyRosRemainingWeeksBucket,
  evidence: ErrorEvidence,
  options: ReturnType<typeof resolvedChampionOptions>,
  evidenceIdentity: FirstPartyRosEvidenceIdentity | null,
  globalBatches: number,
  globalSeasons: number,
  globalSamples: number,
): FirstPartyRosChampionChoice {
  const blocks = [...evidence.blocks.values()].sort(
    (left, right) => left.season - right.season || left.cutoffWeek - right.cutoffWeek,
  );
  const samples = Math.min(
    evidence.contextualAbsoluteError.length,
    evidence.recencyAbsoluteError.length,
  );
  const distinctCutoffs = new Set(blocks.map((block) => block.cutoffWeek)).size;
  // Every season/cutoff block has equal weight. Hundreds of players in one slate cannot overwhelm
  // a smaller slate or masquerade as hundreds of independent experiments.
  const contextualMae = mean(blocks.map((block) => mean(block.contextualAbsoluteError)));
  const recencyMae = mean(blocks.map((block) => mean(block.recencyAbsoluteError)));
  const contextualWeightedIntervalScore = mean(
    blocks.map((block) => mean(block.contextualIntervalScore)),
  );
  const recencyWeightedIntervalScore = mean(
    blocks.map((block) => mean(block.recencyIntervalScore)),
  );
  const modelImprovement =
    recencyMae === 0 ? (contextualMae === 0 ? 0 : -1) : (recencyMae - contextualMae) / recencyMae;
  const seasonMaeDifferences = seasonClusteredDifferences(
    blocks,
    (block) => mean(block.recencyAbsoluteError) - mean(block.contextualAbsoluteError),
  );
  const seasonIntervalDifferences = seasonClusteredDifferences(
    blocks,
    (block) => mean(block.contextualIntervalScore) - mean(block.recencyIntervalScore),
  );
  const maeStandardError = sampleStandardError(seasonMaeDifferences);
  const intervalStandardError = sampleStandardError(seasonIntervalDifferences);
  const criticalValue = oneSided95CriticalValue(seasonMaeDifferences.length - 1);
  const modelImprovementLowerBound =
    maeStandardError === null || recencyMae <= 0
      ? null
      : (mean(seasonMaeDifferences) - criticalValue * maeStandardError) / recencyMae;
  const intervalScoreDifferenceUpperBound =
    intervalStandardError === null
      ? null
      : mean(seasonIntervalDifferences) + criticalValue * intervalStandardError;
  const enoughGlobalEvidence =
    globalSeasons >= options.minimumHeldOutSeasons &&
    globalBatches >= options.minimumBatches &&
    globalSamples >= options.minimumSamples;
  const enoughCellEvidence =
    evidence.seasons.size >= options.minimumCellSeasons &&
    samples >= options.minimumCellSamples &&
    distinctCutoffs >= options.minimumCellCutoffs &&
    evidence.blocks.size >= options.minimumCellBatches;
  const enoughCalibrationEvidence = enoughGlobalEvidence && enoughCellEvidence;
  const enoughEvidence =
    enoughCalibrationEvidence &&
    modelImprovementLowerBound !== null &&
    intervalScoreDifferenceUpperBound !== null;
  const clears =
    enoughEvidence &&
    modelImprovementLowerBound >= options.minimumModelImprovement &&
    intervalScoreDifferenceUpperBound <= 0;
  const heldOutEvidence = derivedHeldOutEvidence(evidence, enoughEvidence);
  const contextualCalibration = buildIntervalCalibrationArtifact(
    position,
    bucket,
    "contextual",
    evidence,
    evidenceIdentity,
    enoughCalibrationEvidence,
    heldOutEvidence.evidenceChecksum,
  );
  const recencyCalibration = buildIntervalCalibrationArtifact(
    position,
    bucket,
    "availability-aware-recency",
    evidence,
    evidenceIdentity,
    enoughCalibrationEvidence,
    heldOutEvidence.evidenceChecksum,
  );
  const selectedCalibration = clears ? contextualCalibration : recencyCalibration;
  return {
    position,
    bucket,
    strategy: clears ? "contextual" : "availability-aware-recency",
    reason: !enoughGlobalEvidence
      ? "insufficient-global-evidence"
      : !enoughCellEvidence
        ? "sparse-cell"
        : !enoughEvidence
          ? "insufficient-statistical-evidence"
          : clears
            ? "model-cleared-margin"
            : "baseline-defended",
    heldOutSeasons: evidence.seasons.size,
    batches: evidence.batches.size,
    globalBatches,
    globalSeasons,
    globalSamples,
    distinctCutoffs,
    samples,
    contextualMae,
    recencyMae,
    contextualWeightedIntervalScore,
    recencyWeightedIntervalScore,
    modelImprovement,
    pairedBlocks: blocks.length,
    modelImprovementLowerBound,
    intervalScoreDifferenceUpperBound,
    uncertaintyMethod: "paired-season-clustered-one-sided-95",
    heldOutEvidence,
    intervalCalibrationArtifacts: {
      contextual: contextualCalibration,
      recency: recencyCalibration,
    },
    walkForwardCalibrationEvidence: {
      contextual: walkForwardCalibrationEvidence(evidence.walkForwardCalibration.contextual),
      recency: walkForwardCalibrationEvidence(evidence.walkForwardCalibration.recency),
    },
    intervalCalibration:
      selectedCalibration.state === "calibrated" ? "split-conformal-cqr" : "not-calibrated",
  };
}

function policyFromEvidence(
  evidence: ReadonlyMap<string, ErrorEvidence>,
  evidenceThroughSeason: number | null,
  options: ReturnType<typeof resolvedChampionOptions>,
  evidenceIdentity: FirstPartyRosEvidenceIdentity | null,
): FirstPartyRosChampionPolicy {
  const positions: readonly FirstPartyRosPosition[] = ["QB", "RB", "WR", "TE", "K", "DST"];
  const buckets: readonly FirstPartyRosRemainingWeeksBucket[] = [
    "one-to-four",
    "five-to-eight",
    "nine-plus",
  ];
  const globalBatches = new Set(
    [...evidence.values()].flatMap((cell) => [...cell.batches.values()]),
  ).size;
  const globalSeasons = new Set(
    [...evidence.values()].flatMap((cell) => [...cell.seasons.values()]),
  ).size;
  const globalSamples = [...evidence.values()].reduce(
    (total, cell) => total + cell.records.length,
    0,
  );
  return {
    policyVersion: FIRST_PARTY_ROS_POLICY_VERSION,
    modelVersion: FIRST_PARTY_ROS_MODEL_VERSION,
    evidenceThroughSeason,
    minimumHeldOutSeasons: options.minimumHeldOutSeasons,
    minimumBatches: options.minimumBatches,
    minimumSamples: options.minimumSamples,
    minimumCellSeasons: options.minimumCellSeasons,
    minimumCellSamples: options.minimumCellSamples,
    minimumCellCutoffs: options.minimumCellCutoffs,
    minimumCellBatches: options.minimumCellBatches,
    minimumModelImprovement: options.minimumModelImprovement,
    globalBatches,
    globalSeasons,
    globalSamples,
    evidenceIdentity,
    choices: positions.flatMap((position) =>
      buckets.map((bucket) =>
        choiceFromEvidence(
          position,
          bucket,
          evidence.get(evidenceKey(position, bucket)) ?? emptyEvidence(),
          options,
          evidenceIdentity,
          globalBatches,
          globalSeasons,
          globalSamples,
        ),
      ),
    ),
  };
}

function validateHeldOutForecast(
  forecast: FirstPartyRosHeldOutForecast,
  season: number,
  duplicates: Set<string>,
): void {
  assertNonEmpty(forecast.playerId, "held-out playerId");
  assertSha256Digest(forecast.inputChecksum, "held-out inputChecksum");
  assertNonEmpty(forecast.contextualModelVersion, "held-out contextualModelVersion");
  assertNonEmpty(forecast.recencyModelVersion, "held-out recencyModelVersion");
  assertNonEmpty(forecast.scoringProfileKey, "held-out scoringProfileKey");
  assertNonEmpty(forecast.intervalMethodVersion, "held-out intervalMethodVersion");
  if (normalizedPosition(forecast.position) !== forecast.position) {
    throw new RangeError("Held-out ROS position must use its canonical value");
  }
  if (forecast.forecastSeason !== season) {
    throw new Error("Held-out forecast season must match its containing season");
  }
  if (
    !Number.isSafeInteger(forecast.trainedThroughSeason) ||
    forecast.trainedThroughSeason < 2000 ||
    forecast.trainedThroughSeason >= forecast.forecastSeason
  ) {
    throw new Error("Held-out ROS forecasts must be trained only through an earlier season");
  }
  if (
    !Number.isSafeInteger(forecast.asOfWeek) ||
    forecast.asOfWeek < 0 ||
    forecast.asOfWeek > 18 ||
    !Number.isSafeInteger(forecast.windowStartWeek) ||
    !Number.isSafeInteger(forecast.windowEndWeek) ||
    forecast.windowStartWeek < 1 ||
    forecast.windowEndWeek > 18 ||
    forecast.windowStartWeek > forecast.windowEndWeek ||
    forecast.windowStartWeek <= forecast.asOfWeek
  ) {
    throw new RangeError("Held-out ROS forecast has an invalid as-of/window boundary");
  }
  for (const [label, candidate] of [
    ["contextual", forecast.contextual],
    ["recency", forecast.recency],
  ] as const) {
    assertFinite(candidate.meanPoints, `${label} held-out mean`);
    assertFinite(candidate.p15Points, `${label} held-out P15`);
    assertFinite(candidate.p50Points, `${label} held-out P50`);
    assertFinite(candidate.p85Points, `${label} held-out P85`);
    if (candidate.p15Points > candidate.p50Points || candidate.p50Points > candidate.p85Points) {
      throw new RangeError(`${label} held-out quantiles must be ordered P15, P50, P85`);
    }
  }
  assertFinite(forecast.actualPoints, "held-out actual points");
  assertProbability(forecast.evidence.coverage.contextual, "held-out contextual input coverage");
  assertProbability(forecast.evidence.coverage.recency, "held-out recency input coverage");
  const availability = forecast.evidence.availability;
  if (
    !Number.isSafeInteger(availability.scheduledGames) ||
    availability.scheduledGames < 0 ||
    availability.scheduledGames > 18 ||
    !Number.isSafeInteger(availability.actualGames) ||
    availability.actualGames < 0 ||
    availability.actualGames > availability.scheduledGames
  ) {
    throw new RangeError("Held-out availability games must be valid scheduled/actual counts");
  }
  for (const [label, expectedGames] of [
    ["contextual", availability.contextualExpectedGames],
    ["recency", availability.recencyExpectedGames],
  ] as const) {
    assertFinite(expectedGames, `held-out ${label} expected games`);
    if (expectedGames < 0 || expectedGames > availability.scheduledGames) {
      throw new RangeError(`held-out ${label} expected games must be within the schedule`);
    }
  }
  for (const [label, convergence] of [
    ["contextual", forecast.evidence.convergence.contextual],
    ["recency", forecast.evidence.convergence.recency],
  ] as const) {
    if (convergence.state !== "converged" && convergence.state !== "unstable") {
      throw new RangeError(`held-out ${label} convergence state is unsupported`);
    }
    assertSha256Digest(
      convergence.diagnosticChecksum,
      `held-out ${label} convergence diagnosticChecksum`,
    );
  }
  const key = `${forecast.playerId}:${forecast.forecastSeason}:${forecast.asOfWeek}:${forecast.windowStartWeek}:${forecast.windowEndWeek}:${forecast.inputChecksum}`;
  if (duplicates.has(key)) throw new Error(`Duplicate held-out ROS forecast: ${key}`);
  duplicates.add(key);
}

function choiceForForecast(
  policy: FirstPartyRosChampionPolicy,
  forecast: FirstPartyRosHeldOutForecast,
): FirstPartyRosChampionChoice {
  const bucket = remainingWeeksBucket(forecast.windowStartWeek, forecast.windowEndWeek);
  return policy.choices.find(
    (choice) => choice.position === forecast.position && choice.bucket === bucket,
  )!;
}

function addSeasonEvidence(
  evidence: Map<string, ErrorEvidence>,
  season: FirstPartyRosHeldOutSeason,
): void {
  for (const forecast of season.forecasts) {
    const bucket = remainingWeeksBucket(forecast.windowStartWeek, forecast.windowEndWeek);
    const key = evidenceKey(forecast.position, bucket);
    const samples = evidence.get(key) ?? emptyEvidence();
    const blockKey = `${season.season}:${forecast.asOfWeek}`;
    const block = samples.blocks.get(blockKey) ?? {
      season: season.season,
      cutoffWeek: forecast.asOfWeek,
      contextualAbsoluteError: [],
      recencyAbsoluteError: [],
      contextualIntervalScore: [],
      recencyIntervalScore: [],
    };
    samples.seasons.add(season.season);
    samples.batches.add(blockKey);
    const contextualAbsoluteError = Math.abs(
      forecast.contextual.meanPoints - forecast.actualPoints,
    );
    const recencyAbsoluteError = Math.abs(forecast.recency.meanPoints - forecast.actualPoints);
    const contextualIntervalScore = standardWeightedIntervalScore(
      forecast.actualPoints,
      forecast.contextual.p50Points,
      forecast.contextual.p15Points,
      forecast.contextual.p85Points,
    );
    const recencyIntervalScore = standardWeightedIntervalScore(
      forecast.actualPoints,
      forecast.recency.p50Points,
      forecast.recency.p15Points,
      forecast.recency.p85Points,
    );
    samples.contextualAbsoluteError.push(contextualAbsoluteError);
    samples.recencyAbsoluteError.push(recencyAbsoluteError);
    samples.contextualIntervalScore.push(contextualIntervalScore);
    samples.recencyIntervalScore.push(recencyIntervalScore);
    block.contextualAbsoluteError.push(contextualAbsoluteError);
    block.recencyAbsoluteError.push(recencyAbsoluteError);
    block.contextualIntervalScore.push(contextualIntervalScore);
    block.recencyIntervalScore.push(recencyIntervalScore);
    samples.blocks.set(blockKey, block);
    samples.records.push({
      identity: `${forecast.playerId}:${forecast.forecastSeason}:${forecast.asOfWeek}:${forecast.windowStartWeek}:${forecast.windowEndWeek}:${forecast.inputChecksum}`,
      blockKey,
      inputChecksum: forecast.inputChecksum,
      contextualModelVersion: forecast.contextualModelVersion,
      recencyModelVersion: forecast.recencyModelVersion,
      scoringProfileKey: forecast.scoringProfileKey,
      intervalMethodVersion: forecast.intervalMethodVersion,
      actualPoints: forecast.actualPoints,
      contextualMeanPoints: forecast.contextual.meanPoints,
      contextualP15Points: forecast.contextual.p15Points,
      contextualP50Points: forecast.contextual.p50Points,
      contextualP85Points: forecast.contextual.p85Points,
      recencyMeanPoints: forecast.recency.meanPoints,
      recencyP15Points: forecast.recency.p15Points,
      recencyP50Points: forecast.recency.p50Points,
      recencyP85Points: forecast.recency.p85Points,
      scheduledGames: forecast.evidence.availability.scheduledGames,
      actualGames: forecast.evidence.availability.actualGames,
      contextualExpectedGames: forecast.evidence.availability.contextualExpectedGames,
      recencyExpectedGames: forecast.evidence.availability.recencyExpectedGames,
      contextualConvergenceChecksum: forecast.evidence.convergence.contextual.diagnosticChecksum,
      recencyConvergenceChecksum: forecast.evidence.convergence.recency.diagnosticChecksum,
      contextualAbsoluteError,
      recencyAbsoluteError,
      contextualIntervalScore,
      recencyIntervalScore,
      contextualIntervalHit:
        forecast.actualPoints >= forecast.contextual.p15Points &&
        forecast.actualPoints <= forecast.contextual.p85Points,
      recencyIntervalHit:
        forecast.actualPoints >= forecast.recency.p15Points &&
        forecast.actualPoints <= forecast.recency.p85Points,
      contextualCoverage: forecast.evidence.coverage.contextual,
      recencyCoverage: forecast.evidence.coverage.recency,
      contextualAvailabilityError: Math.abs(
        forecast.evidence.availability.contextualExpectedGames -
          forecast.evidence.availability.actualGames,
      ),
      recencyAvailabilityError: Math.abs(
        forecast.evidence.availability.recencyExpectedGames -
          forecast.evidence.availability.actualGames,
      ),
      contextualAvailabilitySignedError:
        forecast.evidence.availability.contextualExpectedGames -
        forecast.evidence.availability.actualGames,
      recencyAvailabilitySignedError:
        forecast.evidence.availability.recencyExpectedGames -
        forecast.evidence.availability.actualGames,
      contextualConverged: forecast.evidence.convergence.contextual.state === "converged",
      recencyConverged: forecast.evidence.convergence.recency.state === "converged",
    });
    evidence.set(key, samples);
  }
}

function addWalkForwardCalibrationEvidence(
  evidence: Map<string, ErrorEvidence>,
  records: readonly PendingWalkForwardCalibrationRecord[],
): void {
  for (const record of records) {
    const cell = evidence.get(evidenceKey(record.position, record.bucket));
    if (cell === undefined) {
      throw new Error("Walk-forward calibration evidence has no matching held-out cell");
    }
    const candidate =
      record.strategy === "contextual"
        ? cell.walkForwardCalibration.contextual
        : cell.walkForwardCalibration.recency;
    candidate.push({
      season: record.season,
      cutoffWeek: record.cutoffWeek,
      playerId: record.playerId,
      covered: record.covered,
      artifactChecksum: record.artifactChecksum,
    });
  }
}

/**
 * Applies a season-locked ROS champion policy. Every forecast in a held-out season uses only
 * evidence from fully resolved earlier seasons; overlapping cutoffs from the current season are
 * added together only after the whole season completes.
 */
export function evaluateFirstPartyRosChampionPolicy(
  heldOutSeasons: readonly FirstPartyRosHeldOutSeason[],
  options: FirstPartyRosChampionOptions = {},
): FirstPartyRosChampionEvaluation {
  const resolvedOptions = resolvedChampionOptions(options);
  const ordered = [...heldOutSeasons].sort((left, right) => left.season - right.season);
  const duplicateSeasons = new Set<number>();
  let evidenceIdentity: FirstPartyRosEvidenceIdentity | null = null;
  for (const season of ordered) {
    if (!Number.isSafeInteger(season.season) || season.season < 2000 || season.season > 2200) {
      throw new RangeError("Held-out season must be between 2000 and 2200");
    }
    if (!season.complete) {
      throw new Error(
        `Held-out season ${season.season} is incomplete and cannot update ROS evidence`,
      );
    }
    if (duplicateSeasons.has(season.season)) {
      throw new Error(`Duplicate held-out ROS season: ${season.season}`);
    }
    duplicateSeasons.add(season.season);
    const duplicates = new Set<string>();
    for (const forecast of season.forecasts) {
      validateHeldOutForecast(forecast, season.season, duplicates);
      const identity = {
        contextualModelVersion: forecast.contextualModelVersion,
        recencyModelVersion: forecast.recencyModelVersion,
        scoringProfileKey: forecast.scoringProfileKey,
        intervalMethodVersion: forecast.intervalMethodVersion,
      };
      if (evidenceIdentity === null) evidenceIdentity = identity;
      else if (!evidenceIdentitiesMatch(evidenceIdentity, identity)) {
        throw new Error("Held-out ROS evidence identities cannot be mixed in one evaluation");
      }
    }
  }

  const evidence = new Map<string, ErrorEvidence>();
  const seasonPolicies: FirstPartyRosSeasonPolicyAudit[] = [];
  const selected: FirstPartyRosSelectedEvaluation[] = [];
  let evidenceThroughSeason: number | null = null;
  for (const season of ordered) {
    const policy = policyFromEvidence(
      evidence,
      evidenceThroughSeason,
      resolvedOptions,
      evidenceIdentity,
    );
    seasonPolicies.push({ season: season.season, evidenceThroughSeason, policy });
    const walkForwardRecords: PendingWalkForwardCalibrationRecord[] = [];
    for (const forecast of season.forecasts) {
      const choice = choiceForForecast(policy, forecast);
      const candidate = choice.strategy === "contextual" ? forecast.contextual : forecast.recency;
      const calibrationArtifact =
        choice.strategy === "contextual"
          ? choice.intervalCalibrationArtifacts.contextual
          : choice.intervalCalibrationArtifacts.recency;
      const calibratedInterval = applyFirstPartyRosIntervalCalibration(
        {
          p15Points: candidate.p15Points,
          p50Points: candidate.p50Points,
          p85Points: candidate.p85Points,
        },
        calibrationArtifact,
      );
      if (
        calibratedInterval.intervalCalibration === "split-conformal-cqr" &&
        (calibrationArtifact.trainedThroughSeason === null ||
          calibrationArtifact.trainedThroughSeason >= season.season)
      ) {
        throw new Error("Walk-forward calibration artifact must precede the evaluated season");
      }
      const intervalCovered =
        calibratedInterval.intervalCalibration === "split-conformal-cqr"
          ? forecast.actualPoints >= calibratedInterval.p15Points &&
            forecast.actualPoints <= calibratedInterval.p85Points
          : null;
      selected.push({
        playerId: forecast.playerId,
        forecastSeason: forecast.forecastSeason,
        asOfWeek: forecast.asOfWeek,
        position: forecast.position,
        bucket: remainingWeeksBucket(forecast.windowStartWeek, forecast.windowEndWeek),
        strategy: choice.strategy,
        predictedMean: candidate.meanPoints,
        p15Points: calibratedInterval.p15Points,
        p50Points: calibratedInterval.p50Points,
        p85Points: calibratedInterval.p85Points,
        intervalCalibration: calibratedInterval.intervalCalibration,
        calibrationArtifactChecksum: calibratedInterval.calibrationArtifactChecksum,
        intervalCovered,
        actualPoints: forecast.actualPoints,
      });
      if (intervalCovered !== null && calibratedInterval.calibrationArtifactChecksum !== null) {
        walkForwardRecords.push({
          season: season.season,
          cutoffWeek: forecast.asOfWeek,
          playerId: forecast.playerId,
          position: forecast.position,
          bucket: remainingWeeksBucket(forecast.windowStartWeek, forecast.windowEndWeek),
          strategy: choice.strategy,
          covered: intervalCovered,
          artifactChecksum: calibratedInterval.calibrationArtifactChecksum,
        });
      }
    }
    // The entire season resolves before any of its overlapping cutoff outcomes become evidence.
    addSeasonEvidence(evidence, season);
    addWalkForwardCalibrationEvidence(evidence, walkForwardRecords);
    evidenceThroughSeason = season.season;
  }
  return {
    livePolicy: policyFromEvidence(
      evidence,
      evidenceThroughSeason,
      resolvedOptions,
      evidenceIdentity,
    ),
    seasonPolicies,
    selected,
  };
}

export interface FirstPartyRosLiveReleaseEvidence extends FirstPartyRosEvidenceIdentity {
  readonly position: FirstPartyRosPosition;
  readonly bucket: FirstPartyRosRemainingWeeksBucket;
  readonly inputChecksum: string;
  readonly coverage: FirstPartyRosHeldOutCoverageEvidence;
  readonly availability: {
    readonly scheduledGames: number;
    readonly contextualExpectedGames: number;
    readonly recencyExpectedGames: number;
  };
  readonly convergence: {
    readonly contextual: FirstPartyRosHeldOutConvergenceCandidateEvidence;
    readonly recency: FirstPartyRosHeldOutConvergenceCandidateEvidence;
  };
}

export interface FirstPartyRosReleaseGateOptions {
  readonly minimumInputCoverage?: number;
  readonly maximumHeldOutAvailabilityMae?: number;
  /** Separate ceiling for nine-plus windows, whose outcome dispersion floor exceeds 1.5 games. */
  readonly maximumNinePlusHeldOutAvailabilityMae?: number;
  readonly maximumHeldOutAvailabilityBias?: number;
  readonly minimumHeldOutConvergenceRate?: number;
  readonly maximumIntervalCoverageDeviation?: number;
  /** One-sided exact binomial significance level for the coverage evidence test (gate v3). */
  readonly intervalCoverageEvidenceAlpha?: number;
  /** One-sided exact binomial significance level for the availability MAE evidence test (gate v3). */
  readonly availabilityEvidenceAlpha?: number;
  readonly minimumWalkForwardCalibrationSeasons?: number;
  readonly minimumWalkForwardCalibrationBatches?: number;
  readonly minimumWalkForwardCalibrationSamples?: number;
}

export type FirstPartyRosReleaseGateReason =
  | "missing-policy-evidence"
  | "evidence-identity-mismatch"
  | "invalid-live-evidence"
  | "insufficient-held-out-evidence"
  | "input-coverage-below-threshold"
  | "availability-error-above-threshold"
  | "availability-bias-above-threshold"
  | "convergence-gate-failed"
  | "interval-calibration-unavailable"
  | "insufficient-walk-forward-calibration-evidence"
  | "interval-coverage-gate-failed"
  | "no-expected-games";

export interface FirstPartyRosReleaseGateDecision {
  readonly state: "release" | "withhold";
  readonly strategy: FirstPartyRosStrategy | null;
  readonly reasons: readonly FirstPartyRosReleaseGateReason[];
  readonly evidenceChecksum: string;
  readonly intervalCalibration: "split-conformal-cqr" | "not-calibrated";
  readonly calibrationArtifactChecksum: string | null;
}

/**
 * Fail-closed point/quantile release gate. It cannot release unless the selected stratum has an
 * immutable season-blocked split-conformal artifact. Aligned with the report-side availability
 * gate v3 on 2026-07-29: the availability-MAE comparison is the same one-sided evidence test at
 * the same ceilings and alpha (`firstPartyRosAvailabilityEvidenceOfExcessMae`), the bias gate
 * keeps its point comparison, and the evidence-identity comparison is scoped to the position
 * being gated (`evidenceIdentitiesMatchForPosition`).
 */
export function evaluateFirstPartyRosReleaseGate(
  policy: FirstPartyRosChampionPolicy,
  live: FirstPartyRosLiveReleaseEvidence,
  options: FirstPartyRosReleaseGateOptions = {},
): FirstPartyRosReleaseGateDecision {
  const minimumInputCoverage = options.minimumInputCoverage ?? 0.95;
  const maximumHeldOutAvailabilityMae =
    options.maximumHeldOutAvailabilityMae ?? FIRST_PARTY_ROS_MAX_AVAILABILITY_MAE;
  const maximumNinePlusHeldOutAvailabilityMae =
    options.maximumNinePlusHeldOutAvailabilityMae ?? FIRST_PARTY_ROS_MAX_NINE_PLUS_AVAILABILITY_MAE;
  const maximumHeldOutAvailabilityBias =
    options.maximumHeldOutAvailabilityBias ?? FIRST_PARTY_ROS_MAX_AVAILABILITY_BIAS;
  const minimumHeldOutConvergenceRate = options.minimumHeldOutConvergenceRate ?? 1;
  const maximumIntervalCoverageDeviation = options.maximumIntervalCoverageDeviation ?? 0.1;
  const intervalCoverageEvidenceAlpha =
    options.intervalCoverageEvidenceAlpha ?? FIRST_PARTY_ROS_COVERAGE_EVIDENCE_ALPHA;
  const availabilityEvidenceAlpha =
    options.availabilityEvidenceAlpha ?? FIRST_PARTY_ROS_AVAILABILITY_EVIDENCE_ALPHA;
  const minimumWalkForwardCalibrationSeasons =
    options.minimumWalkForwardCalibrationSeasons ?? FIRST_PARTY_ROS_MINIMUM_WALK_FORWARD_SEASONS;
  const minimumWalkForwardCalibrationBatches =
    options.minimumWalkForwardCalibrationBatches ?? FIRST_PARTY_ROS_MINIMUM_WALK_FORWARD_BATCHES;
  const minimumWalkForwardCalibrationSamples =
    options.minimumWalkForwardCalibrationSamples ?? FIRST_PARTY_ROS_MINIMUM_WALK_FORWARD_SAMPLES;
  for (const [value, label] of [
    [minimumInputCoverage, "minimumInputCoverage"],
    [minimumHeldOutConvergenceRate, "minimumHeldOutConvergenceRate"],
    [maximumIntervalCoverageDeviation, "maximumIntervalCoverageDeviation"],
    [intervalCoverageEvidenceAlpha, "intervalCoverageEvidenceAlpha"],
    [availabilityEvidenceAlpha, "availabilityEvidenceAlpha"],
  ] as const) {
    assertProbability(value, label);
  }
  assertNonNegative(maximumHeldOutAvailabilityMae, "maximumHeldOutAvailabilityMae");
  assertNonNegative(maximumNinePlusHeldOutAvailabilityMae, "maximumNinePlusHeldOutAvailabilityMae");
  assertNonNegative(maximumHeldOutAvailabilityBias, "maximumHeldOutAvailabilityBias");
  for (const [value, label] of [
    [minimumWalkForwardCalibrationSeasons, "minimumWalkForwardCalibrationSeasons"],
    [minimumWalkForwardCalibrationBatches, "minimumWalkForwardCalibrationBatches"],
    [minimumWalkForwardCalibrationSamples, "minimumWalkForwardCalibrationSamples"],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`${label} must be a positive integer`);
    }
  }

  const reasons = new Set<FirstPartyRosReleaseGateReason>();
  let selectedCalibration: FirstPartyRosIntervalCalibrationArtifact | null = null;
  const choice = policy.choices.find(
    (candidate) => candidate.position === live.position && candidate.bucket === live.bucket,
  );
  const liveIdentity: FirstPartyRosEvidenceIdentity = {
    contextualModelVersion: live.contextualModelVersion,
    recencyModelVersion: live.recencyModelVersion,
    scoringProfileKey: live.scoringProfileKey,
    intervalMethodVersion: live.intervalMethodVersion,
  };
  if (policy.evidenceIdentity === null || choice === undefined) {
    reasons.add("missing-policy-evidence");
  } else if (
    !evidenceIdentitiesMatchForPosition(policy.evidenceIdentity, liveIdentity, live.position)
  ) {
    reasons.add("evidence-identity-mismatch");
  }
  const liveEvidenceIsValid =
    /^[a-f0-9]{64}$/u.test(live.inputChecksum) &&
    /^[a-f0-9]{64}$/u.test(live.convergence.contextual.diagnosticChecksum) &&
    /^[a-f0-9]{64}$/u.test(live.convergence.recency.diagnosticChecksum) &&
    Number.isSafeInteger(live.availability.scheduledGames) &&
    live.availability.scheduledGames >= 0 &&
    live.availability.scheduledGames <= 18 &&
    [
      live.coverage.contextual,
      live.coverage.recency,
      live.availability.contextualExpectedGames,
      live.availability.recencyExpectedGames,
    ].every((value) => Number.isFinite(value)) &&
    live.coverage.contextual >= 0 &&
    live.coverage.contextual <= 1 &&
    live.coverage.recency >= 0 &&
    live.coverage.recency <= 1 &&
    live.availability.contextualExpectedGames >= 0 &&
    live.availability.contextualExpectedGames <= live.availability.scheduledGames &&
    live.availability.recencyExpectedGames >= 0 &&
    live.availability.recencyExpectedGames <= live.availability.scheduledGames;
  if (!liveEvidenceIsValid) reasons.add("invalid-live-evidence");

  if (choice !== undefined) {
    const selected = choice.strategy === "contextual" ? "contextual" : "recency";
    selectedCalibration = choice.intervalCalibrationArtifacts[selected];
    const walkForwardCalibration = choice.walkForwardCalibrationEvidence[selected];
    const heldOut = choice.heldOutEvidence;
    if (heldOut.state !== "derived-immutable-not-calibrated" || heldOut.evidenceChecksum === null) {
      reasons.add("insufficient-held-out-evidence");
    }
    if (
      live.coverage[selected] < minimumInputCoverage ||
      heldOut[`${selected}MeanInputCoverage`] < minimumInputCoverage
    ) {
      reasons.add("input-coverage-below-threshold");
    }
    const availabilityMaeCeiling =
      live.bucket === "nine-plus"
        ? maximumNinePlusHeldOutAvailabilityMae
        : maximumHeldOutAvailabilityMae;
    // Availability MAE gate v3: the ceiling is unchanged, but a cell now fails it only on
    // statistical evidence that its true MAE exceeds it — the same test, bound, and alpha the
    // report gate applies in `historicalRosCalibrationBlockers`. The point comparison is retained
    // as a structural guard so no cell inside its ceiling can ever block, whatever the test
    // returns. `choice.samples` is the paired held-out row count the MAE is averaged over, exactly
    // as it is on the report side.
    if (
      heldOut[`${selected}AvailabilityMae`] > availabilityMaeCeiling &&
      firstPartyRosAvailabilityEvidenceOfExcessMae(
        choice.samples,
        heldOut[`${selected}AvailabilityMae`],
        availabilityMaeCeiling,
        FIRST_PARTY_ROS_MAXIMUM_AVAILABILITY_ROW_ERROR[live.bucket],
        availabilityEvidenceAlpha,
      )
    ) {
      reasons.add("availability-error-above-threshold");
    }
    if (Math.abs(heldOut[`${selected}AvailabilityBias`]) > maximumHeldOutAvailabilityBias) {
      reasons.add("availability-bias-above-threshold");
    }
    if (
      live.convergence[selected].state !== "converged" ||
      heldOut[`${selected}ConvergenceRate`] < minimumHeldOutConvergenceRate
    ) {
      reasons.add("convergence-gate-failed");
    }
    if (
      !intervalCalibrationArtifactIsValid(selectedCalibration) ||
      selectedCalibration.strategy !== choice.strategy ||
      selectedCalibration.position !== choice.position ||
      selectedCalibration.bucket !== choice.bucket ||
      !evidenceIdentitiesMatchForPosition(
        selectedCalibration.evidenceIdentity,
        liveIdentity,
        live.position,
      )
    ) {
      reasons.add("interval-calibration-unavailable");
    }
    if (
      walkForwardCalibration.state !== "available" ||
      walkForwardCalibration.evidenceChecksum === null ||
      walkForwardCalibration.seasons < minimumWalkForwardCalibrationSeasons ||
      walkForwardCalibration.blocks < minimumWalkForwardCalibrationBatches ||
      walkForwardCalibration.samples < minimumWalkForwardCalibrationSamples
    ) {
      reasons.add("insufficient-walk-forward-calibration-evidence");
    }
    if (
      firstPartyRosCoverageEvidenceOfUndercoverage(
        walkForwardCalibration.blocks,
        walkForwardCalibration.observedBlockCoverage,
        selectedCalibration.nominalCoverage - maximumIntervalCoverageDeviation,
        intervalCoverageEvidenceAlpha,
      )
    ) {
      reasons.add("interval-coverage-gate-failed");
    }
    if (live.availability[`${selected}ExpectedGames`] <= 0) reasons.add("no-expected-games");
  }
  const orderedReasons = [...reasons].sort();
  const evidenceChecksum = sha256Hex(
    JSON.stringify({
      policyVersion: policy.policyVersion,
      modelVersion: policy.modelVersion,
      heldOutEvidenceChecksum: choice?.heldOutEvidence.evidenceChecksum ?? null,
      calibrationArtifactChecksum: selectedCalibration?.artifactChecksum ?? null,
      walkForwardCalibrationEvidenceChecksum:
        choice === undefined
          ? null
          : choice.walkForwardCalibrationEvidence[
              choice.strategy === "contextual" ? "contextual" : "recency"
            ].evidenceChecksum,
      live: {
        contextualModelVersion: live.contextualModelVersion,
        recencyModelVersion: live.recencyModelVersion,
        scoringProfileKey: live.scoringProfileKey,
        intervalMethodVersion: live.intervalMethodVersion,
        position: live.position,
        bucket: live.bucket,
        inputChecksum: live.inputChecksum,
        coverage: {
          contextual: live.coverage.contextual,
          recency: live.coverage.recency,
        },
        availability: {
          scheduledGames: live.availability.scheduledGames,
          contextualExpectedGames: live.availability.contextualExpectedGames,
          recencyExpectedGames: live.availability.recencyExpectedGames,
        },
        convergence: {
          contextual: {
            state: live.convergence.contextual.state,
            diagnosticChecksum: live.convergence.contextual.diagnosticChecksum,
          },
          recency: {
            state: live.convergence.recency.state,
            diagnosticChecksum: live.convergence.recency.diagnosticChecksum,
          },
        },
      },
      thresholds: {
        minimumInputCoverage,
        maximumHeldOutAvailabilityMae,
        maximumNinePlusHeldOutAvailabilityMae,
        availabilityEvidenceAlpha,
        maximumAvailabilityRowError: FIRST_PARTY_ROS_MAXIMUM_AVAILABILITY_ROW_ERROR[live.bucket],
        maximumHeldOutAvailabilityBias,
        minimumHeldOutConvergenceRate,
        intervalCoverageEvidenceAlpha,
        maximumIntervalCoverageDeviation,
        minimumWalkForwardCalibrationSeasons,
        minimumWalkForwardCalibrationBatches,
        minimumWalkForwardCalibrationSamples,
      },
      reasons: orderedReasons,
    }),
  );
  return {
    state: orderedReasons.length === 0 ? "release" : "withhold",
    strategy: orderedReasons.length === 0 && choice !== undefined ? choice.strategy : null,
    reasons: orderedReasons,
    evidenceChecksum,
    intervalCalibration:
      orderedReasons.length === 0 && selectedCalibration?.state === "calibrated"
        ? "split-conformal-cqr"
        : "not-calibrated",
    calibrationArtifactChecksum:
      orderedReasons.length === 0 ? (selectedCalibration?.artifactChecksum ?? null) : null,
  };
}
