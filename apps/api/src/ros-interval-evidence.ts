import type { RosIntervalDescriptor } from "@laces-out/contracts";
import {
  projectionScoringRulesFromProfileKey,
  rosMarginalIntervalStorageIsValid,
} from "@laces-out/projections";

/** One row from the bounded immutable summary -> model-run lookup, never projection-set metadata. */
export type StoredRosIntervalEvidence = {
  readonly projectionSetId: string;
  readonly linkedRunCount: number;
  readonly matchesScope: boolean;
  readonly distributionScopeMatches?: boolean;
  /** Schema 2 binds every saved player's calibration to its run and immutable admitted cell. */
  readonly marginalScopeMatches?: boolean;
  readonly pointScopeMatches?: boolean;
  readonly rosIntervals: unknown;
  readonly rosPoints?: unknown;
};

export type RosForecastKind = "point-only" | "calibrated-distribution";

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

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    record(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

/** Structural validation complements the database's immutable run/artifact/player binding. */
export function storedRosPointEvidenceIsValid(value: unknown): boolean {
  if (
    !exactKeys(value, [
      "schemaVersion",
      "method",
      "state",
      "championArtifactChecksum",
      "scoringProfileKey",
      "intervalAvailable",
      "cells",
    ]) ||
    value.schemaVersion !== 1 ||
    value.method !== "point-ros-release-v1" ||
    value.state !== "validated" ||
    value.intervalAvailable !== false ||
    typeof value.championArtifactChecksum !== "string" ||
    !SHA256.test(value.championArtifactChecksum) ||
    typeof value.scoringProfileKey !== "string" ||
    value.scoringProfileKey.length > 100_000 ||
    !Array.isArray(value.cells) ||
    value.cells.length < 1 ||
    value.cells.length > 18
  )
    return false;
  try {
    projectionScoringRulesFromProfileKey(value.scoringProfileKey);
  } catch {
    return false;
  }
  const seen = new Set<string>();
  for (const cell of value.cells) {
    if (
      !exactKeys(cell, [
        "position",
        "bucket",
        "strategy",
        "qualificationChecksum",
        "releaseEvidenceChecksum",
      ]) ||
      typeof cell.position !== "string" ||
      !["QB", "RB", "WR", "TE", "K", "DST"].includes(cell.position) ||
      typeof cell.bucket !== "string" ||
      !["one-to-four", "five-to-eight", "nine-plus"].includes(cell.bucket) ||
      typeof cell.strategy !== "string" ||
      !["contextual", "availability-aware-recency"].includes(cell.strategy) ||
      typeof cell.qualificationChecksum !== "string" ||
      !SHA256.test(cell.qualificationChecksum) ||
      typeof cell.releaseEvidenceChecksum !== "string" ||
      !SHA256.test(cell.releaseEvidenceChecksum)
    )
      return false;
    const key = `${cell.position}:${cell.bucket}`;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
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
 * individual target. Schema 2 uses the shared closed qualification-storage validator.
 */
export function parseStoredRosIntervalCalibration(value: unknown): RosIntervalDescriptor | null {
  if (!record(value)) return null;
  if (value.schemaVersion === 2) {
    if (!rosMarginalIntervalStorageIsValid(value)) return null;
    return {
      kind: "player-marginal",
      method: value.method,
      target: value.target,
      nominalCoverage: value.nominalCoverage,
      qualificationMethod: value.qualificationMethod,
      quantiles: [0.15, 0.5, 0.85],
      evidenceInterpretation: value.interpretation,
      evidenceChecksum: value.evidenceChecksum,
    };
  }
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
  if (
    !record(value) ||
    value.linkedRunCount !== 1 ||
    value.matchesScope !== true ||
    value.distributionScopeMatches !== true ||
    value.pointScopeMatches === true ||
    (value.rosPoints !== undefined && value.rosPoints !== null)
  )
    return null;
  if (
    record(value.rosIntervals) &&
    value.rosIntervals.schemaVersion === 2 &&
    value.marginalScopeMatches !== true
  )
    return null;
  return parseStoredRosIntervalCalibration(value.rosIntervals);
}

export function parseLinkedRosForecastKind(value: unknown): RosForecastKind | null {
  if (!record(value) || value.linkedRunCount !== 1 || value.matchesScope !== true) return null;
  if (
    value.pointScopeMatches === true &&
    value.distributionScopeMatches === false &&
    (value.rosIntervals === null || value.rosIntervals === undefined) &&
    storedRosPointEvidenceIsValid(value.rosPoints)
  )
    return "point-only";
  return parseLinkedRosIntervalEvidence(value) ? "calibrated-distribution" : null;
}
