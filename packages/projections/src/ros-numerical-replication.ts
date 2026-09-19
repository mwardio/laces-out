import {
  evaluateFirstPartyRosConvergence,
  FIRST_PARTY_ROS_CONVERGENCE_REFERENCE_SCENARIOS,
  FIRST_PARTY_ROS_DEFAULT_SCENARIOS,
  type FirstPartyRosConvergenceMetric,
  type FirstPartyRosConvergenceSummary,
  type FirstPartyRosPosition,
} from "./rest-of-season.js";
import {
  measureRosConvergenceDistribution,
  type RosConvergenceDistributionInput,
  type RosQuantileIdentificationBounds,
} from "./ros-convergence-distribution.js";
import { sha256Hex } from "./sha256.js";

/** Candidate evaluation only. No historical, live, or publication gate invokes this module. */
export const ROS_NUMERICAL_REPLICATION_VERSION = "ros-empirical-numerical-replication-v1";
export const ROS_ORDERED_GAMES_VECTOR_VERSION = "ros-ordered-games-vector-v1";
export const ROS_NUMERICAL_REPLICATION_CDF_CEILING = Object.freeze({
  numerator: 1,
  denominator: 100,
});

const RELEASE = FIRST_PARTY_ROS_DEFAULT_SCENARIOS;
const FULL = FIRST_PARTY_ROS_CONVERGENCE_REFERENCE_SCENARIOS;
const POSITIONS = ["QB", "RB", "WR", "TE", "K", "DST"] as const;
const QUANTILES = ["p15Points", "p50Points", "p85Points"] as const;

export interface RosNumericalReplicationInput extends RosConvergenceDistributionInput {
  readonly position: FirstPartyRosPosition;
  readonly scheduledGames: number;
  /** Same original adjacent-pair order as scores, from the same verified physical vector. */
  readonly games: readonly number[] | Uint8Array;
}

export type RosNumericalQuantileSpan =
  | { readonly kind: "finite"; readonly points: number }
  | { readonly kind: "unbounded" }
  | { readonly kind: "exceeds-finite-range" };

function fail(message: string): never {
  throw new TypeError(`ROS numerical replication: ${message}`);
}

function exactKeys(value: unknown, expected: readonly string[]): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("invalid input");
  const keys = Object.keys(value).sort();
  const names = [...expected].sort();
  if (keys.length !== names.length || keys.some((key, index) => key !== names[index]))
    fail("missing or unknown input fields");
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
  if (result === undefined || (typeof value === "number" && !Number.isFinite(value)))
    fail("non-finite or undefined receipt field");
  return result;
}

function copyVector(
  value: RosNumericalReplicationInput["scores"] | RosNumericalReplicationInput["games"],
  role: "scores" | "games",
  scheduledGames: number,
): number[] {
  if (
    (!Array.isArray(value) &&
      !(role === "scores" ? value instanceof Float64Array : value instanceof Uint8Array)) ||
    value.length !== FULL ||
    Object.keys(value).length !== FULL
  )
    fail(`${role} must contain exactly ${FULL} dense entries`);
  const copied: number[] = [];
  for (let index = 0; index < FULL; index++) {
    const entry: unknown = value[index];
    if (!Object.hasOwn(value, index) || typeof entry !== "number" || !Number.isFinite(entry))
      fail(`${role} must be dense and finite`);
    if (role === "games" && (!Number.isSafeInteger(entry) || entry < 0 || entry > scheduledGames))
      fail("games must be integers within scheduled support");
    copied.push(entry === 0 ? 0 : entry);
  }
  return copied;
}

function span(bounds: RosQuantileIdentificationBounds): RosNumericalQuantileSpan {
  if (bounds.lower.kind === "unbounded" || bounds.upper.kind === "unbounded")
    return { kind: "unbounded" };
  const points = bounds.upper.value - bounds.lower.value;
  return Number.isFinite(points) ? { kind: "finite", points } : { kind: "exceeds-finite-range" };
}

function metric(
  values: readonly FirstPartyRosConvergenceMetric[],
  name: FirstPartyRosConvergenceMetric["metric"],
): FirstPartyRosConvergenceMetric {
  const found = values.find((candidate) => candidate.metric === name);
  if (!found) fail("legacy convergence metric is unavailable");
  return { ...found };
}

/**
 * Candidate empirical replication rule, not true-CDF accuracy or release authorization.
 *
 * The caller must authenticate generation, scoring, input/seed identity, original pair order,
 * scheduled support and the predeclared family. Supplied metadata cannot prove those claims.
 * The one-vector interface makes the release an exact prefix; private copies bind both summaries
 * and diagnostics to the same captured values. No independently supplied summaries are accepted.
 *
 * Prefix/full CDF distance <= 1/100 is exactly prefix/suffix distance <= 4/100 at these fixed
 * counts. This operational ceiling is independent of the measurement's DKW precision bounds.
 * Quantile identification is for inverse-ECDF quantiles of the raw simulator mixture, not for
 * type-7 forecast accuracy or corrected marginal endpoints. Complete old scalar diagnostics are
 * retained unchanged: a legacy quantile failure never becomes an old-method pass.
 */
export function evaluateRosNumericalReplication(input: RosNumericalReplicationInput) {
  exactKeys(input, [
    "scores",
    "games",
    "position",
    "scheduledGames",
    "provenance",
    "familySize",
    "familyErrorBudget",
  ]);
  if (RELEASE !== 12_288 || FULL !== 16_384) fail("new path counts require a new version");
  if (!(POSITIONS as readonly unknown[]).includes(input.position))
    fail("invalid canonical position");
  if (
    !Number.isSafeInteger(input.scheduledGames) ||
    input.scheduledGames < 0 ||
    input.scheduledGames > 18
  )
    fail("scheduledGames must be an integer between zero and 18");
  const scores = copyVector(input.scores, "scores", input.scheduledGames);
  const games = copyVector(input.games, "games", input.scheduledGames);
  const measurement = measureRosConvergenceDistribution({
    scores,
    provenance: input.provenance,
    familySize: input.familySize,
    familyErrorBudget: input.familyErrorBudget,
  });
  function summary(count: number, partition: "prefixType7" | "fullType7") {
    // Match the existing scorer/engine's original-order arithmetic, including its prefix sum.
    let pointsSum = 0;
    let gamesSum = 0;
    for (let index = 0; index < count; index++) {
      pointsSum += scores[index]!;
      gamesSum += games[index]!;
    }
    const meanPoints = pointsSum / count;
    if (!Number.isFinite(meanPoints)) fail("score mean exceeds finite arithmetic");
    return {
      expectedGames: gamesSum / count,
      meanPoints,
      p15Points: measurement.quantileRanks[0]![partition],
      p50Points: measurement.quantileRanks[1]![partition],
      p85Points: measurement.quantileRanks[2]![partition],
      scenarioCount: count,
      seedHash: measurement.provenance.seedHash,
      scoringProfileKey: measurement.provenance.scoringProfileKey,
    } satisfies FirstPartyRosConvergenceSummary;
  }
  const release = summary(RELEASE, "prefixType7");
  const reference = summary(FULL, "fullType7");
  const legacyDiagnostic = evaluateFirstPartyRosConvergence({
    position: input.position,
    release,
    reference,
  });
  const meanPoints = metric(legacyDiagnostic.metrics, "meanPoints");
  const expectedGames = metric(legacyDiagnostic.metrics, "expectedGames");
  const distance = measurement.prefixVsFull;
  const withinCdfCeiling =
    distance.numerator * ROS_NUMERICAL_REPLICATION_CDF_CEILING.denominator <=
    distance.denominator * ROS_NUMERICAL_REPLICATION_CDF_CEILING.numerator;
  const failures = [
    ...(!withinCdfCeiling ? (["prefix-full-cdf-ceiling"] as const) : []),
    ...(!meanPoints.converged ? (["mean-points-tolerance"] as const) : []),
    ...(!expectedGames.converged ? (["expected-games-tolerance"] as const) : []),
  ];
  const quantiles = QUANTILES.map((name, index) => {
    const legacyMetric = metric(legacyDiagnostic.metrics, name);
    const identification = measurement.precision.quantileBounds[index]!;
    return {
      metric: name,
      probability: identification.probability,
      empiricalPointEstimateChanged: legacyMetric.releaseValue !== legacyMetric.referenceValue,
      legacyMetric,
      rawInverseCdfIdentificationSpan: {
        prefix: span(identification.prefix),
        full: span(identification.full),
      },
    };
  });
  const legacyFailedQuantiles = quantiles
    .filter((entry) => !entry.legacyMetric.converged)
    .map((entry) => entry.metric);
  const body = {
    schemaVersion: 1,
    version: ROS_NUMERICAL_REPLICATION_VERSION,
    purpose: "candidate-empirical-replication-only",
    sourceAuthentication: "caller-responsibility-not-authenticated",
    canAuthorizeRelease: false,
    canAuthorizeModelAdoption: false,
    position: input.position,
    scheduledGames: input.scheduledGames,
    gamesVectorVersion: ROS_ORDERED_GAMES_VECTOR_VERSION,
    gamesVectorChecksum: sha256Hex(canonical({ version: ROS_ORDERED_GAMES_VECTOR_VERSION, games })),
    summaries: { release, reference },
    measurement,
    operational: {
      state: failures.length === 0 ? "within-tolerance" : "outside-tolerance",
      criterion: "prefix-full-empirical-cdf-and-legacy-mean-games",
      cdfCeiling: { ...ROS_NUMERICAL_REPLICATION_CDF_CEILING },
      withinCdfCeiling,
      meanPoints,
      expectedGames,
      failures,
    },
    legacyDiagnostic,
    pointSensitivity: {
      state:
        legacyFailedQuantiles.length === 0
          ? "within-legacy-quantile-tolerances"
          : "legacy-quantile-sensitive",
      legacyFailedQuantiles,
      quantiles,
    },
  } as const;
  return { ...body, evidenceChecksum: sha256Hex(canonical(body)) };
}

export type RosNumericalReplicationEvaluation = ReturnType<typeof evaluateRosNumericalReplication>;

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

/** Recompute against exact supplied vectors/context; self-consistent JSON alone is insufficient. */
export function rosNumericalReplicationMatchesVectors(
  value: unknown,
  input: RosNumericalReplicationInput,
): value is RosNumericalReplicationEvaluation {
  try {
    return equalCanonical(value, evaluateRosNumericalReplication(input));
  } catch {
    return false;
  }
}
