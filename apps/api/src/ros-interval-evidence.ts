import type { RosIntervalDescriptor } from "@laces-out/contracts";

/** One row from the bounded immutable summary -> model-run lookup, never projection-set metadata. */
export type StoredRosIntervalEvidence = {
  readonly projectionSetId: string;
  readonly linkedRunCount: number;
  readonly matchesScope: boolean;
  readonly rosIntervals: unknown;
};

const LEGACY_KEYS = [
  "schemaVersion",
  "state",
  "method",
  "evidenceChecksum",
  "heldOutSeasons",
  "batches",
  "samples",
  "nominalCoverage",
  "empiricalCoverage",
  "maximumAllowedCoverageError",
] as const;
const SHA256 = /^[a-f0-9]{64}$/u;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function probability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function integer(value: unknown, minimum: number): value is number {
  // Schema 1 casts these counts to PostgreSQL integer, not an unbounded JavaScript double.
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= 2_147_483_647
  );
}

function decimalFraction(value: number): readonly [bigint, bigint] {
  // JSONB numeric values use exact decimal comparison in migration 0025. Preserve that behavior
  // at boundaries such as abs(0.8 - 0.7) <= 0.1, without an epsilon or altered admission rule.
  const [mantissa, exponentText] = value.toString().split("e");
  const [whole, decimals = ""] = mantissa!.split(".");
  const exponent = Number(exponentText ?? 0) - decimals.length;
  const numerator = BigInt(`${whole}${decimals}`);
  return exponent >= 0
    ? [numerator * 10n ** BigInt(exponent), 1n]
    : [numerator, 10n ** BigInt(-exponent)];
}

function legacyCoverageWithinBound(nominal: number, empirical: number, maximum: number): boolean {
  const [nominalN, nominalD] = decimalFraction(nominal);
  const [empiricalN, empiricalD] = decimalFraction(empirical);
  const [maximumN, maximumD] = decimalFraction(maximum);
  const signedDifference = empiricalN * nominalD - nominalN * empiricalD;
  const absoluteDifference = signedDifference < 0n ? -signedDifference : signedDifference;
  return absoluteDifference * maximumD <= maximumN * nominalD * empiricalD;
}

/**
 * Read-only interpretation of the retained schema-1 contract. This verifies its original support
 * and numeric requirements; it neither re-admits a model nor turns legacy block coverage into an
 * individual target. Schema 2 stays unavailable until its qualification contract is implemented.
 */
export function parseStoredRosIntervalCalibration(value: unknown): RosIntervalDescriptor | null {
  if (!record(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== LEGACY_KEYS.length || LEGACY_KEYS.some((key) => !Object.hasOwn(value, key)))
    return null;
  if (
    value.schemaVersion !== 1 ||
    value.state !== "calibrated" ||
    value.method !== "season-blocked-split-conformal-cqr-v1" ||
    typeof value.evidenceChecksum !== "string" ||
    !SHA256.test(value.evidenceChecksum) ||
    !integer(value.heldOutSeasons, 3) ||
    !integer(value.batches, 30) ||
    !integer(value.samples, 300) ||
    !probability(value.nominalCoverage) ||
    !probability(value.empiricalCoverage) ||
    !probability(value.maximumAllowedCoverageError) ||
    !legacyCoverageWithinBound(
      value.nominalCoverage,
      value.empiricalCoverage,
      value.maximumAllowedCoverageError,
    )
  )
    return null;
  return {
    kind: "legacy-block-cqr",
    method: "season-blocked-split-conformal-cqr-v1",
    quantiles: [0.15, 0.5, 0.85],
    evidenceInterpretation: "historical-descriptive",
    evidenceChecksum: value.evidenceChecksum,
  };
}

/** Ambiguous linkage is unavailable even if both runs happen to carry byte-identical contracts. */
export function parseLinkedRosIntervalEvidence(value: unknown): RosIntervalDescriptor | null {
  return record(value) && value.linkedRunCount === 1 && value.matchesScope === true
    ? parseStoredRosIntervalCalibration(value.rosIntervals)
    : null;
}
