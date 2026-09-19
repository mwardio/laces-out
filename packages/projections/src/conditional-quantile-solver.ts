/**
 * Development candidate only. The objective is sum(w * pinball(r-a-b*z)) + b²/4.
 * This module neither qualifies a statistical model nor authorizes its publication.
 */
export const CONDITIONAL_QUANTILE_SOLVER_VERSION = "certified-regularized-quantile-2d-v1";

/** Fixed dimensionless absolute tolerances; callers cannot relax them. */
export const CONDITIONAL_QUANTILE_NUMERICS = Object.freeze({
  maximumRows: 6_000,
  maximumIterations: 96,
  maximumRationalMassBits: 8_192,
  slopeSearchBound: 4,
  normalizedWeightTolerance: 1e-12,
  nearAtomResidualTolerance: 1e-10,
  dualMassTolerance: 1e-12,
  slopeStationarityTolerance: 1e-11,
  complementarityTolerance: 2e-10,
  primalDualGapTolerance: 1e-9,
  objectiveRoundoffCeiling: 2.5e-10,
  dualMomentSearchTolerance: 1e-13,
  dualBoxRoundoffUnits: 16,
  dualAllocationRoundoffUnits: 32,
  objectiveRoundoffUnits: 32,
});

export type ConditionalQuantile = 0.15 | 0.5 | 0.85;
export interface ConditionalQuantileRow {
  readonly residual: number;
  readonly feature: number;
  readonly weight: number;
  /** Optional exact mass 1/d; supply for every row or none. The numeric weight must match. */
  readonly weightDenominator?: number;
}
export interface ConditionalQuantileInput {
  readonly quantile: ConditionalQuantile;
  readonly rows: readonly ConditionalQuantileRow[];
}
export interface ConditionalQuantileCandidate {
  readonly intercept: number;
  readonly slope: number;
  readonly dualWeights: readonly number[];
}
export interface ConditionalQuantileDiagnostics {
  readonly primalObjective: number;
  readonly dualObjective: number;
  readonly primalDualGap: number;
  readonly objectiveRoundoffBound: number;
  readonly dualMass: number;
  readonly dualFeatureMoment: number;
  readonly slopeStationarityError: number;
  readonly complementarityGap: number;
  readonly interceptMassError: number;
  readonly nearAtomCount: number;
  readonly constantFeature: boolean;
}
export type ConditionalQuantileCertification =
  | {
      readonly certified: true;
      readonly version: typeof CONDITIONAL_QUANTILE_SOLVER_VERSION;
      readonly interceptInterval: readonly [number, number];
      readonly diagnostics: ConditionalQuantileDiagnostics;
    }
  | { readonly certified: false; readonly reason: string };
export type ConditionalQuantileSolution =
  | (ConditionalQuantileCandidate & {
      readonly status: "certified";
      readonly quantile: ConditionalQuantile;
      readonly iterations: number;
      readonly certificate: Extract<ConditionalQuantileCertification, { certified: true }>;
    })
  | { readonly status: "unavailable"; readonly reason: string };

class CompensatedSum {
  private total = 0;
  private correction = 0;
  add(value: number): void {
    const next = this.total + value;
    this.correction +=
      Math.abs(this.total) >= Math.abs(value)
        ? this.total - next + value
        : value - next + this.total;
    this.total = next;
  }
  value(): number {
    return this.total + this.correction;
  }
}
function sum(values: Iterable<number>): number {
  const result = new CompensatedSum();
  for (const value of values) result.add(value);
  return result.value();
}
function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
function validateInput(input: ConditionalQuantileInput): string | undefined {
  if (!input || ![0.15, 0.5, 0.85].includes(input.quantile)) return "unsupported quantile";
  if (
    !Array.isArray(input.rows) ||
    input.rows.length < 1 ||
    input.rows.length > CONDITIONAL_QUANTILE_NUMERICS.maximumRows
  )
    return "row count outside supported range";
  const rows: readonly ConditionalQuantileRow[] = input.rows;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (
      !Object.hasOwn(input.rows, index) ||
      !row ||
      !finite(row.residual) ||
      !finite(row.feature) ||
      Math.abs(row.feature) > 2 ||
      !finite(row.weight) ||
      row.weight <= 0
    )
      return "rows require finite residuals, features in [-2,2], and positive weights";
    if (
      (row.weightDenominator === undefined) !== (rows[0]!.weightDenominator === undefined) ||
      (row.weightDenominator !== undefined &&
        (!Number.isSafeInteger(row.weightDenominator) ||
          row.weightDenominator < 1 ||
          row.weight !== 1 / row.weightDenominator))
    )
      return "exact weight denominators must be complete, positive safe integers matching weights";
  }
  const mass = sum(rows.map((row) => row.weight));
  if (
    !Number.isFinite(mass) ||
    Math.abs(mass - 1) > CONDITIONAL_QUANTILE_NUMERICS.normalizedWeightTolerance
  )
    return "weights are not normalized";
  return undefined;
}

/** Exact dyadic weight sums distinguish arbitrarily small positive mass from a true tie. */
function exactMasses(rows: readonly ConditionalQuantileRow[]): bigint[] | undefined {
  if (rows[0]!.weightDenominator !== undefined) {
    function gcd(a: bigint, b: bigint): bigint {
      while (b !== 0n) [a, b] = [b, a % b];
      return a;
    }
    let common = 1n;
    for (const denominator of new Set(rows.map((row) => row.weightDenominator!))) {
      const integer = BigInt(denominator);
      common = (common / gcd(common, integer)) * integer;
      if (common.toString(2).length > CONDITIONAL_QUANTILE_NUMERICS.maximumRationalMassBits)
        return undefined;
    }
    const masses = rows.map((row) => common / BigInt(row.weightDenominator!));
    // Exact normalization matters when rational weights are supplied; float rounding is not proof.
    if (masses.reduce((total, mass) => total + mass, 0n) !== common) return undefined;
    return masses;
  }
  const view = new DataView(new ArrayBuffer(8));
  const parts = rows.map(({ weight }) => {
    view.setFloat64(0, weight, false);
    const bits = view.getBigUint64(0, false);
    const exponent = Number((bits >> 52n) & 0x7ffn);
    const mantissa = bits & 0xfffffffffffffn;
    return exponent === 0
      ? { mantissa, exponent: -1074 }
      : { mantissa: mantissa | 0x10000000000000n, exponent: exponent - 1075 };
  });
  const minimumExponent = Math.min(...parts.map((part) => part.exponent));
  return parts.map((part) => part.mantissa << BigInt(part.exponent - minimumExponent));
}
interface PreparedInput {
  readonly input: ConditionalQuantileInput;
  readonly masses: readonly bigint[];
  readonly targetMass: bigint;
  readonly constantFeature: boolean;
}
function prepare(input: ConditionalQuantileInput): PreparedInput | undefined {
  const masses = exactMasses(input.rows);
  if (!masses) return undefined;
  const numerator = input.quantile === 0.15 ? 3n : input.quantile === 0.5 ? 10n : 17n;
  return {
    input,
    masses,
    targetMass: masses.reduce((total, mass) => total + mass, 0n) * numerator,
    constantFeature: input.rows.every((row) => row.feature === input.rows[0]!.feature),
  };
}
function interceptAt(
  prepared: PreparedInput,
  slope: number,
): { intercept: number; interval: readonly [number, number] } | undefined {
  const values = prepared.input.rows.map((row, index) => ({
    value: row.residual - slope * row.feature,
    index,
  }));
  if (values.some(({ value }) => !Number.isFinite(value))) return undefined;
  values.sort((a, b) => a.value - b.value || a.index - b.index);
  let mass = 0n;
  for (let index = 0; index < values.length; index++) {
    const row = values[index]!;
    mass += prepared.masses[row.index]! * 20n;
    if (mass >= prepared.targetMass) {
      const lower = row.value;
      const upper = mass === prepared.targetMass ? values[index + 1]!.value : lower;
      const combined = lower + upper;
      const intercept =
        lower === upper ? lower : Number.isFinite(combined) ? combined / 2 : lower / 2 + upper / 2;
      return { intercept: intercept === 0 ? 0 : intercept, interval: [lower, upper] };
    }
  }
  return undefined;
}
function bounds(row: ConditionalQuantileRow, quantile: ConditionalQuantile) {
  return { lower: row.weight * (quantile - 1), upper: row.weight * quantile };
}
function pinball(residual: number, quantile: ConditionalQuantile): number {
  return residual >= 0 ? quantile * residual : (quantile - 1) * residual;
}

/**
 * Independently recomputes the certificate from rows and candidate dual weights. It never trusts
 * optimizer state, supplied objective values, an optimizer termination flag, or a stored verdict.
 * Quantile levels are the exact fractions 3/20, 10/20, 17/20 for intercept mass comparisons.
 * IEEE arithmetic in loss/dual calculations is bounded separately and must certify as well.
 */
export function certifyConditionalQuantile(
  input: ConditionalQuantileInput,
  candidate: ConditionalQuantileCandidate,
): ConditionalQuantileCertification {
  const invalid = validateInput(input);
  if (invalid) return { certified: false, reason: invalid };
  if (
    !candidate ||
    !finite(candidate.intercept) ||
    !finite(candidate.slope) ||
    Math.abs(candidate.slope) > CONDITIONAL_QUANTILE_NUMERICS.slopeSearchBound ||
    !Array.isArray(candidate.dualWeights) ||
    candidate.dualWeights.length !== input.rows.length
  )
    return { certified: false, reason: "malformed coefficients or dual vector" };
  const prepared = prepare(input);
  if (!prepared)
    return {
      certified: false,
      reason: "rational weights are not exactly normalized or exceed the mass budget",
    };
  const location = interceptAt(prepared, candidate.slope);
  if (!location || candidate.intercept !== location.intercept)
    return {
      certified: false,
      reason: "intercept is not the complete minimizer interval midpoint",
    };
  if (prepared.constantFeature && candidate.slope !== 0)
    return { certified: false, reason: "constant features require the explicit zero slope" };
  const mass = new CompensatedSum();
  const moment = new CompensatedSum();
  const primalLoss = new CompensatedSum();
  const dualLinear = new CompensatedSum();
  const absoluteDualLinear = new CompensatedSum();
  const complementarity = new CompensatedSum();
  let nearAtomCount = 0;
  for (let index = 0; index < input.rows.length; index++) {
    const row = input.rows[index]!;
    const alpha: unknown = candidate.dualWeights[index];
    if (!Object.hasOwn(candidate.dualWeights, index) || !finite(alpha))
      return { certified: false, reason: "dual vector must be dense and finite" };
    const { lower, upper } = bounds(row, input.quantile);
    // Relative to this row's own weight: tiny rows never inherit a large absolute box tolerance.
    const boxRoundoff =
      CONDITIONAL_QUANTILE_NUMERICS.dualBoxRoundoffUnits * Number.EPSILON * row.weight;
    if (alpha < lower - boxRoundoff || alpha > upper + boxRoundoff)
      return { certified: false, reason: "dual box constraint failed" };
    const residual = row.residual - candidate.intercept - candidate.slope * row.feature;
    const loss = row.weight * pinball(residual, input.quantile);
    const linear = alpha * row.residual;
    const slack = residual >= 0 ? (upper - alpha) * residual : (lower - alpha) * residual;
    if (![residual, loss, linear, slack].every(Number.isFinite))
      return { certified: false, reason: "certificate arithmetic is non-finite" };
    if (Math.abs(residual) <= CONDITIONAL_QUANTILE_NUMERICS.nearAtomResidualTolerance)
      nearAtomCount++;
    mass.add(alpha);
    moment.add(alpha * row.feature);
    primalLoss.add(loss);
    dualLinear.add(linear);
    absoluteDualLinear.add(Math.abs(linear));
    complementarity.add(Math.abs(slack));
  }
  const dualMass = mass.value();
  const dualFeatureMoment = moment.value();
  const primalObjective = primalLoss.value() + (candidate.slope * candidate.slope) / 4;
  const dualObjective = dualLinear.value() - dualFeatureMoment * dualFeatureMoment;
  const primalDualGap = primalObjective - dualObjective;
  const objectiveRoundoffBound =
    CONDITIONAL_QUANTILE_NUMERICS.objectiveRoundoffUnits *
    Number.EPSILON *
    (Math.abs(primalObjective) + Math.abs(dualObjective) + absoluteDualLinear.value());
  const slopeStationarityError = Math.abs(candidate.slope - 2 * dualFeatureMoment);
  const complementarityGap = complementarity.value();
  const interceptMassError = Math.abs(candidate.intercept * dualMass);
  const diagnostics: ConditionalQuantileDiagnostics = {
    primalObjective,
    dualObjective,
    primalDualGap,
    objectiveRoundoffBound,
    dualMass,
    dualFeatureMoment,
    slopeStationarityError,
    complementarityGap,
    interceptMassError,
    nearAtomCount,
    constantFeature: prepared.constantFeature,
  };
  if (!Object.values(diagnostics).every((value) => typeof value === "boolean" || finite(value)))
    return { certified: false, reason: "certificate arithmetic is non-finite" };
  if (Math.abs(dualMass) > CONDITIONAL_QUANTILE_NUMERICS.dualMassTolerance)
    return { certified: false, reason: "dual intercept stationarity failed" };
  if (slopeStationarityError > CONDITIONAL_QUANTILE_NUMERICS.slopeStationarityTolerance)
    return { certified: false, reason: "dual slope stationarity failed" };
  if (
    complementarityGap > CONDITIONAL_QUANTILE_NUMERICS.complementarityTolerance ||
    interceptMassError > CONDITIONAL_QUANTILE_NUMERICS.complementarityTolerance
  )
    return { certified: false, reason: "dual complementarity failed" };
  if (objectiveRoundoffBound > CONDITIONAL_QUANTILE_NUMERICS.objectiveRoundoffCeiling)
    return { certified: false, reason: "objective precision cannot certify the fixed tolerance" };
  if (
    // Approximate mass stationarity can shift the uncentered dual objective by a*sum(alpha).
    // Bound that signed uncertainty explicitly; a negative raw gap is never blindly accepted.
    primalDualGap < -objectiveRoundoffBound - interceptMassError ||
    primalDualGap + objectiveRoundoffBound + interceptMassError >
      CONDITIONAL_QUANTILE_NUMERICS.primalDualGapTolerance
  )
    return { certified: false, reason: "primal-dual objective gap failed" };
  return {
    certified: true,
    version: CONDITIONAL_QUANTILE_SOLVER_VERSION,
    interceptInterval: location.interval,
    diagnostics,
  };
}

/** Extremal tied-atom assignments solve a bounded one-mass linear program by feature order. */
function atomDualRange(input: ConditionalQuantileInput, intercept: number, slope: number) {
  const base: number[] = [];
  const atoms: number[] = [];
  for (let index = 0; index < input.rows.length; index++) {
    const row = input.rows[index]!;
    const residual = row.residual - intercept - slope * row.feature;
    if (!Number.isFinite(residual)) return undefined;
    const { lower, upper } = bounds(row, input.quantile);
    if (Math.abs(residual) <= CONDITIONAL_QUANTILE_NUMERICS.nearAtomResidualTolerance) {
      base.push(lower);
      atoms.push(index);
    } else base.push(residual > 0 ? upper : lower);
  }
  const needed = -sum(base);
  const capacity = sum(atoms.map((index) => input.rows[index]!.weight));
  const massRoundoff = CONDITIONAL_QUANTILE_NUMERICS.dualAllocationRoundoffUnits * Number.EPSILON;
  if (needed < -massRoundoff || needed > capacity + massRoundoff) return undefined;
  const allocationMass = Math.min(capacity, Math.max(0, needed));
  atoms.sort((a, b) => input.rows[a]!.feature - input.rows[b]!.feature || a - b);
  function extreme(order: readonly number[]) {
    const alpha = [...base];
    const allocated = new CompensatedSum();
    for (const index of order) {
      const row = input.rows[index]!;
      const amount = Math.max(0, Math.min(row.weight, allocationMass - allocated.value()));
      const { lower, upper } = bounds(row, input.quantile);
      alpha[index] = Math.max(lower, Math.min(upper, lower + amount));
      allocated.add(amount);
    }
    return { alpha, moment: sum(alpha.map((value, index) => value * input.rows[index]!.feature)) };
  }
  const minimum = extreme(atoms);
  const maximum = extreme([...atoms].reverse());
  return { minimum, maximum };
}

/** O(maxIterations * n log n) time, O(n) memory, and no configurable tolerance/iteration escape. */
export function solveConditionalQuantile(
  input: ConditionalQuantileInput,
): ConditionalQuantileSolution {
  const invalid = validateInput(input);
  if (invalid) return { status: "unavailable", reason: invalid };
  const prepared = prepare(input);
  if (!prepared)
    return {
      status: "unavailable",
      reason: "rational weights are not exactly normalized or exceed the mass budget",
    };
  let lower: number = -CONDITIONAL_QUANTILE_NUMERICS.slopeSearchBound;
  let upper: number = CONDITIONAL_QUANTILE_NUMERICS.slopeSearchBound;
  let failure = "fixed iteration budget exhausted without an optimality certificate";
  for (
    let iteration = 1;
    iteration <= CONDITIONAL_QUANTILE_NUMERICS.maximumIterations;
    iteration++
  ) {
    const slope = prepared.constantFeature ? 0 : lower / 2 + upper / 2;
    const location = interceptAt(prepared, slope);
    if (!location) return { status: "unavailable", reason: "intercept arithmetic is non-finite" };
    const range = atomDualRange(input, location.intercept, slope);
    if (!range)
      return { status: "unavailable", reason: "tied-atom dual mass cannot be constructed" };
    const desired = slope / 2;
    if (
      desired >= range.minimum.moment - CONDITIONAL_QUANTILE_NUMERICS.dualMomentSearchTolerance &&
      desired <= range.maximum.moment + CONDITIONAL_QUANTILE_NUMERICS.dualMomentSearchTolerance
    ) {
      const width = range.maximum.moment - range.minimum.moment;
      const fraction =
        width > 0 ? Math.min(1, Math.max(0, (desired - range.minimum.moment) / width)) : 0;
      const dualWeights = range.minimum.alpha.map((minimum, index) => {
        const { lower: lo, upper: hi } = bounds(input.rows[index]!, input.quantile);
        return Math.max(
          lo,
          Math.min(hi, minimum + fraction * (range.maximum.alpha[index]! - minimum)),
        );
      });
      const candidate = {
        intercept: location.intercept,
        slope: slope === 0 ? 0 : slope,
        dualWeights,
      };
      const certificate = certifyConditionalQuantile(input, candidate);
      if (certificate.certified)
        return {
          status: "certified",
          quantile: input.quantile,
          ...candidate,
          iterations: iteration,
          certificate,
        };
      failure = certificate.reason;
    }
    if (prepared.constantFeature) break;
    if (desired < range.minimum.moment) lower = slope;
    else upper = slope;
    if (lower === upper || lower / 2 + upper / 2 === slope) break;
  }
  return { status: "unavailable", reason: failure };
}
