import {
  firstPartyTeamDefenseRealizedAllowedBuckets,
  expandFirstPartyTeamDefenseAllowedDistribution,
  type FirstPartyTeamDefenseIntegerMassDistribution,
  type FirstPartyTeamDefenseDiscreteGaussianParameters,
} from "./first-party.js";
import type { ProjectionStatComponents } from "./scoring.js";

/** Physical game sampler; admission still requires a separately versioned historical replay. */
export const FIRST_PARTY_DEFENSE_GAME_VERSION = "defense-discrete-game-v1";

export const DEFENSE_EVENT_COMPONENTS = [
  "defensive_sacks",
  "defensive_interceptions",
  "defensive_fumble_recoveries",
  "defensive_safeties",
  "defensive_blocked_kicks",
  "fourth_down_stops",
  "special_teams_touchdowns",
] as const;

export const DEFENSE_COPULA_COMPONENTS = [
  ...DEFENSE_EVENT_COMPONENTS,
  "points_allowed",
  "yards_allowed",
] as const;

export type DefenseEventComponent = (typeof DEFENSE_EVENT_COMPONENTS)[number];
export type DefenseAllowedDistribution =
  FirstPartyTeamDefenseIntegerMassDistribution | FirstPartyTeamDefenseDiscreteGaussianParameters;

export interface DefenseRankInterval {
  readonly lower: number;
  readonly upper: number;
}

/**
 * A checkerboard empirical copula. Select a row uniformly, then jitter each tied rank interval
 * independently. Every dimension has a uniform marginal, including when most events are zero.
 * Fitting rows and the chronology evidence belong to the caller, not the random sampler.
 */
export interface DefenseGameDependence {
  readonly rowCount: number;
  /** Little-endian uint16 lower/upper rank counts, row-major in component order, base64 encoded. */
  readonly packedRanks: string;
}

export interface PreparedDefenseGame {
  readonly eventCdfs: Readonly<Record<DefenseEventComponent, readonly number[]>>;
  readonly pointsAllowedCdf: readonly number[];
  readonly yardsAllowedCdf: readonly number[];
  readonly touchdownProbabilityPerTurnover: number;
  readonly dependence: { readonly rowCount: number; readonly ranks: Uint16Array };
  /** Raw weekly location parameters can differ from bounded integer-distribution means. */
  readonly allowedMeanAdjustments: {
    readonly pointsAllowed: number;
    readonly yardsAllowed: number;
  };
}

/** One row-selection draw, nine marginal jitters, and one conditional touchdown draw. */
export const DEFENSE_GAME_UNIFORMS = 1 + DEFENSE_COPULA_COMPONENTS.length + 1;

function uniform(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new RangeError("Defense game draws must lie in [0, 1)");
  }
  return value;
}

function nonnegative(value: number | undefined, name: string): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`Defense game ${name} must be finite and nonnegative`);
  }
  return value;
}

function integerCdf(distribution: FirstPartyTeamDefenseIntegerMassDistribution): number[] {
  if (distribution.weights.length === 0 || distribution.weights.length > 8_193) {
    throw new RangeError("Defense integer distribution has an invalid support");
  }
  const total = nonnegative(distribution.totalWeight, "total mass");
  if (total === 0) throw new RangeError("Defense integer distribution has no mass");
  let sum = 0;
  for (const weight of distribution.weights) sum += nonnegative(weight, "outcome mass");
  if (!Number.isFinite(sum) || sum === 0 || Math.abs(sum - total) > 1e-12 * Math.max(sum, total)) {
    throw new RangeError("Defense integer distribution total does not match its weights");
  }
  const cdf: number[] = [];
  let cumulative = 0;
  for (const weight of distribution.weights) {
    cumulative += weight;
    cdf.push(cumulative / sum);
  }
  cdf[cdf.length - 1] = 1;
  return cdf;
}

/** NB2: E[X]=mean and Var[X]=mean+alpha*mean²; alpha=0 is the Poisson limit. */
function countCdf(mean: number, alpha: number): number[] {
  nonnegative(mean, "event mean");
  nonnegative(alpha, "event overdispersion");
  if (mean > 100 || alpha > 100) {
    throw new RangeError("Defense event parameters exceed the bounded numerical domain");
  }
  if (mean === 0) return [1];
  let probability = Math.exp(alpha === 0 ? -mean : -Math.log1p(alpha * mean) / alpha);
  let cumulative = probability;
  const cdf = [cumulative];
  for (let k = 1; cumulative < 1 - 1e-13 && k <= 8_192; k += 1) {
    probability *= (mean * (1 + (k - 1) * alpha)) / (k * (1 + alpha * mean));
    cumulative += probability;
    cdf.push(cumulative);
  }
  if (!Number.isFinite(cumulative) || cumulative < 1 - 1e-12) {
    throw new RangeError("Defense event distribution did not converge within its support bound");
  }
  cdf[cdf.length - 1] = 1;
  return cdf;
}

function inverse(cdf: readonly number[], draw: number): number {
  let lower = 0;
  let upper = cdf.length - 1;
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);
    if (draw < cdf[middle]!) upper = middle;
    else lower = middle + 1;
  }
  return lower;
}

function cdfMean(cdf: readonly number[]): number {
  // Tail-sum identity avoids differencing almost equal CDF values in the tails.
  return cdf.slice(0, -1).reduce((sum, value) => sum + 1 - value, 0);
}

export function prepareFirstPartyDefenseGame(input: {
  readonly components: ProjectionStatComponents;
  readonly allowed: {
    readonly pointsAllowed: DefenseAllowedDistribution;
    readonly yardsAllowed: DefenseAllowedDistribution;
  };
  readonly overdispersion: Readonly<Record<DefenseEventComponent, number>>;
  readonly dependence: DefenseGameDependence;
}): PreparedDefenseGame {
  const pointsMass =
    "weights" in input.allowed.pointsAllowed
      ? input.allowed.pointsAllowed
      : expandFirstPartyTeamDefenseAllowedDistribution(input.allowed.pointsAllowed);
  const yardsMass =
    "weights" in input.allowed.yardsAllowed
      ? input.allowed.yardsAllowed
      : expandFirstPartyTeamDefenseAllowedDistribution(input.allowed.yardsAllowed);
  if (pointsMass.weights.length > 81 || yardsMass.weights.length > 801) {
    throw new RangeError("Defense allowed distributions exceed the weekly model's grid support");
  }
  for (const component of ["defensive_two_point_returns", "one_point_safeties"]) {
    if (input.components[component] !== undefined && input.components[component] !== 0) {
      throw new RangeError(`Defense game cannot discard a nonzero ${component} center`);
    }
  }
  const eventCdfs = {} as Record<DefenseEventComponent, readonly number[]>;
  for (const key of DEFENSE_EVENT_COMPONENTS) {
    eventCdfs[key] = countCdf(nonnegative(input.components[key], key), input.overdispersion[key]);
  }
  const touchdownMean = nonnegative(input.components.defensive_touchdowns, "touchdown mean");
  const turnoverMean =
    input.components.defensive_interceptions! + input.components.defensive_fumble_recoveries!;
  if (touchdownMean > turnoverMean) {
    throw new RangeError("Defense touchdown mean exceeds its interception/recovery opportunities");
  }
  const dependence = decodeDependence(input.dependence);
  const pointsAllowedCdf = integerCdf(pointsMass);
  const yardsAllowedCdf = integerCdf(yardsMass);
  return {
    eventCdfs,
    pointsAllowedCdf,
    yardsAllowedCdf,
    touchdownProbabilityPerTurnover: turnoverMean === 0 ? 0 : touchdownMean / turnoverMean,
    dependence,
    allowedMeanAdjustments: {
      pointsAllowed:
        cdfMean(pointsAllowedCdf) - nonnegative(input.components.points_allowed, "points allowed"),
      yardsAllowed:
        cdfMean(yardsAllowedCdf) - nonnegative(input.components.yards_allowed, "yards allowed"),
    },
  };
}

/** Builds exact tied empirical ranks; each dimension's marginal is uniform by construction. */
export function defenseGameRankDependence(
  observations: readonly (readonly number[])[],
): DefenseGameDependence {
  if (observations.length === 0 || observations.length > 20_000) {
    throw new RangeError("Defense dependence requires bounded observations");
  }
  for (const row of observations) {
    if (
      row.length !== DEFENSE_COPULA_COMPONENTS.length ||
      Array.from(row).some((v) => !Number.isFinite(v))
    ) {
      throw new RangeError("Defense dependence observations must be finite and complete");
    }
  }
  const ranks = DEFENSE_COPULA_COMPONENTS.map((_, dimension) => {
    const sorted = observations.map((row) => row[dimension]!).sort((a, b) => a - b);
    const result = new Map<number, DefenseRankInterval>();
    let start = 0;
    while (start < sorted.length) {
      let end = start + 1;
      while (end < sorted.length && sorted[end] === sorted[start]) end += 1;
      result.set(sorted[start]!, { lower: start, upper: end });
      start = end;
    }
    return result;
  });
  const bytes = new Uint8Array(observations.length * DEFENSE_COPULA_COMPONENTS.length * 4);
  const view = new DataView(bytes.buffer);
  observations.forEach((row, rowIndex) =>
    row.forEach((value, dimension) => {
      const rank = ranks[dimension]!.get(value)!;
      const offset = (rowIndex * DEFENSE_COPULA_COMPONENTS.length + dimension) * 4;
      view.setUint16(offset, rank.lower, true);
      view.setUint16(offset + 2, rank.upper, true);
    }),
  );
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8_192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8_192));
  }
  return { rowCount: observations.length, packedRanks: btoa(binary) };
}

const DECODED_DEPENDENCE = new WeakMap<
  DefenseGameDependence,
  {
    readonly packedRanks: string;
    readonly decoded: PreparedDefenseGame["dependence"];
  }
>();

function decodeDependence(input: DefenseGameDependence): PreparedDefenseGame["dependence"] {
  const count = input.rowCount;
  if (
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > 20_000 ||
    typeof input.packedRanks !== "string" ||
    input.packedRanks.length !== Math.ceil((count * DEFENSE_COPULA_COMPONENTS.length * 4) / 3) * 4
  ) {
    throw new RangeError("Defense dependence requires bounded complete packed ranks");
  }
  const cached = DECODED_DEPENDENCE.get(input);
  if (cached?.packedRanks === input.packedRanks && cached.decoded.rowCount === count) {
    return cached.decoded;
  }
  let binary: string;
  try {
    binary = atob(input.packedRanks);
  } catch {
    throw new RangeError("Defense dependence ranks are not valid base64");
  }
  if (
    binary.length !== count * DEFENSE_COPULA_COMPONENTS.length * 4 ||
    btoa(binary) !== input.packedRanks
  ) {
    throw new RangeError("Defense dependence ranks are not canonically encoded");
  }
  const bytes = Uint8Array.from(binary, (value) => value.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  const values = new Uint16Array(bytes.length / 2);
  for (let i = 0; i < values.length; i += 1) values[i] = view.getUint16(i * 2, true);
  for (let dimension = 0; dimension < DEFENSE_COPULA_COMPONENTS.length; dimension += 1) {
    const groups = new Map<number, { lower: number; upper: number; count: number }>();
    for (let row = 0; row < count; row += 1) {
      const offset = (row * DEFENSE_COPULA_COMPONENTS.length + dimension) * 2;
      const lower = values[offset]!;
      const upper = values[offset + 1]!;
      if (lower >= upper || upper > count) {
        throw new RangeError("Defense dependence contains an invalid rank interval");
      }
      const key = lower * 65_536 + upper;
      const group = groups.get(key) ?? { lower, upper, count: 0 };
      group.count += 1;
      groups.set(key, group);
    }
    let priorUpper = 0;
    for (const group of [...groups.values()].sort((a, b) => a.lower - b.lower)) {
      if (group.lower !== priorUpper || group.upper - group.lower !== group.count) {
        throw new RangeError("Defense dependence does not preserve uniform marginal ranks");
      }
      priorUpper = group.upper;
    }
    if (priorUpper !== count)
      throw new RangeError("Defense dependence has incomplete marginal ranks");
  }
  const decoded = { rowCount: count, ranks: values };
  DECODED_DEPENDENCE.set(input, { packedRanks: input.packedRanks, decoded });
  return decoded;
}

function conditionalTouchdowns(trials: number, probability: number, draw: number): number {
  if (probability === 0 || trials === 0) return 0;
  if (probability === 1) return trials;
  // Start at the mode so neither rare nor high-rate returns underflow at the first count.
  const mode = Math.floor((trials + 1) * probability);
  const masses = Array<number>(trials + 1).fill(0);
  masses[mode] = 1;
  const odds = probability / (1 - probability);
  for (let k = mode; k > 0; k -= 1) {
    masses[k - 1] = (masses[k]! * k) / ((trials - k + 1) * odds);
  }
  for (let k = mode; k < trials; k += 1) {
    masses[k + 1] = (masses[k]! * (trials - k) * odds) / (k + 1);
  }
  const target = draw * masses.reduce((sum, mass) => sum + mass, 0);
  let cumulative = 0;
  for (let count = 0; count <= trials; count += 1) {
    cumulative += masses[count]!;
    if (target < cumulative) return count;
  }
  return trials;
}

/** Returns one coherent game's components, ready for arbitrary supported league scoring. */
export function sampleFirstPartyDefenseGame(
  prepared: PreparedDefenseGame,
  draws: readonly number[],
): Readonly<Record<string, number>> {
  if (draws.length !== DEFENSE_GAME_UNIFORMS) {
    throw new RangeError("Defense game requires its complete fixed draw block");
  }
  for (const draw of draws) uniform(draw);
  const rowIndex = Math.floor(draws[0]! * prepared.dependence.rowCount);
  const marginalDraws = DEFENSE_COPULA_COMPONENTS.map((_, index) => {
    const offset = (rowIndex * DEFENSE_COPULA_COMPONENTS.length + index) * 2;
    const lower = prepared.dependence.ranks[offset]!;
    const upper = prepared.dependence.ranks[offset + 1]!;
    return Math.min(
      1 - Number.EPSILON,
      (lower + draws[index + 1]! * (upper - lower)) / prepared.dependence.rowCount,
    );
  });
  const components: Record<string, number> = Object.fromEntries(
    DEFENSE_EVENT_COMPONENTS.map((key, index) => [
      key,
      inverse(prepared.eventCdfs[key], marginalDraws[index]!),
    ]),
  );
  components.defensive_touchdowns = conditionalTouchdowns(
    components.defensive_interceptions! + components.defensive_fumble_recoveries!,
    prepared.touchdownProbabilityPerTurnover,
    draws.at(-1)!,
  );
  components.points_allowed = inverse(prepared.pointsAllowedCdf, marginalDraws[7]!);
  components.yards_allowed = inverse(prepared.yardsAllowedCdf, marginalDraws[8]!);
  Object.assign(
    components,
    firstPartyTeamDefenseRealizedAllowedBuckets({
      pointsAllowed: components.points_allowed,
      yardsAllowed: components.yards_allowed,
    }),
  );
  // These rare-event assumptions remain explicit in the existing weekly model and scorer.
  components.defensive_two_point_returns = 0;
  components.one_point_safeties = 0;
  return components;
}
