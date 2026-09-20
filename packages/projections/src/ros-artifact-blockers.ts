import { FIRST_PARTY_ROS_MARGINAL_POLICY_VERSION } from "./marginal-ros-policy.js";
import { MARGINAL_INTERVAL_CALIBRATION_VERSION } from "./marginal-interval-calibration.js";
import {
  ROS_MARGINAL_INTERVAL_QUALIFICATION_VERSION,
  type RosMarginalIntervalQualification,
} from "./ros-marginal-interval-qualification.js";
import {
  buildRosMarginalIntervalStoredCells,
  rosMarginalIntervalQualificationIsStructurallyValid,
} from "./ros-marginal-interval-storage.js";
import {
  FIRST_PARTY_ROS_POLICY_VERSION,
  type FirstPartyRosChampionPolicy,
} from "./rest-of-season.js";
import { sha256Hex } from "./sha256.js";
import {
  FIRST_PARTY_ROS_POINT_POLICY_VERSION,
  firstPartyRosPointArtifactIsConsistent,
  firstPartyRosPointQualificationIsStructurallyValid,
} from "./point-ros-release.js";

const POSITIONS = ["QB", "RB", "WR", "TE", "K", "DST"] as const;
const FIRST_PARTY_ROS_BUCKETS = ["one-to-four", "five-to-eight", "nine-plus"] as const;
export interface RosArtifactBlockerContext {
  readonly season: number;
  readonly scoringProfileKey: string;
  readonly modelVersion: string;
  readonly policyVersion: string;
  readonly calibrationVersion: string;
  readonly evidenceThroughSeason: number;
  readonly sourceChecksums: readonly { readonly key: string; readonly checksum: string }[];
  readonly policy: FirstPartyRosChampionPolicy;
  readonly releaseGate: Record<string, unknown>;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function normalizeForChecksum(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeForChecksum);
  if (isRecord(value))
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, normalizeForChecksum(entry)]),
    );
  return value;
}
function sameCanonical(left: unknown, right: unknown): boolean {
  return JSON.stringify(normalizeForChecksum(left)) === JSON.stringify(normalizeForChecksum(right));
}
/** Same immutable artifact checksum contract used at admission; no timestamp or ledger state. */
export function firstPartyRosReleaseArtifactChecksum(payload: RosArtifactBlockerContext): string {
  return sha256Hex(
    JSON.stringify(
      normalizeForChecksum({
        version: "first-party-ros-champion-artifact-v1",
        season: payload.season,
        scoringProfileKey: payload.scoringProfileKey,
        modelVersion: payload.modelVersion,
        policyVersion: payload.policyVersion,
        calibrationVersion: payload.calibrationVersion,
        evidenceThroughSeason: payload.evidenceThroughSeason,
        sourceChecksums: [...payload.sourceChecksums]
          .map(({ key, checksum }) => ({ key, checksum }))
          .sort((a, b) => a.key.localeCompare(b.key)),
        policy: payload.policy,
        releaseGate: payload.releaseGate,
      }),
    ),
  );
}

export function firstPartyRosMarginalArtifactIntervalsAreConsistent(
  artifact: RosArtifactBlockerContext,
): boolean {
  const value = artifact.releaseGate.marginalIntervals;
  if (
    !isRecord(value) ||
    !sameCanonical(Object.keys(value).sort(), [
      "cells",
      "qualificationMethod",
      "qualifications",
      "schemaVersion",
    ]) ||
    value.schemaVersion !== 1 ||
    value.qualificationMethod !== ROS_MARGINAL_INTERVAL_QUALIFICATION_VERSION ||
    !Array.isArray(value.qualifications) ||
    value.qualifications.length !== 18 ||
    !Array.isArray(value.cells) ||
    value.cells.length > 18 ||
    artifact.policy.choices.length !== 18 ||
    artifact.evidenceThroughSeason >= artifact.season
  )
    return false;
  const blockers = artifact.releaseGate.blockers;
  if (
    blockers !== undefined &&
    (!Array.isArray(blockers) ||
      blockers.length > 512 ||
      blockers.some(
        (blocker) => typeof blocker !== "string" || !blocker.trim() || blocker.length > 1024,
      ))
  )
    return false;
  const qualifications: RosMarginalIntervalQualification[] = [];
  const required = POSITIONS.flatMap((position) =>
    FIRST_PARTY_ROS_BUCKETS.map((bucket) => `${position}:${bucket}`),
  ).sort();
  for (const raw of value.qualifications) {
    if (!rosMarginalIntervalQualificationIsStructurallyValid(raw)) return false;
    const choice = artifact.policy.choices.find(
      (candidate) =>
        candidate.position === raw.cell.position && candidate.bucket === raw.cell.bucket,
    );
    if (
      !sameCanonical(
        raw.sourceScope.requiredCells.map((cell) => `${cell.position}:${cell.bucket}`).sort(),
        required,
      ) ||
      raw.forecastSeason !== artifact.season ||
      raw.comparisonSeason !== artifact.evidenceThroughSeason ||
      raw.sources.candidate.source.modelVersion !== artifact.modelVersion ||
      raw.sources.candidate.source.policyVersion !== FIRST_PARTY_ROS_POLICY_VERSION ||
      raw.sources.candidate.source.scoringProfileKey !== artifact.scoringProfileKey ||
      !sameCanonical(raw.liveArtifact.context.evidenceIdentity, artifact.policy.evidenceIdentity) ||
      !sameCanonical(raw.meanChoice, choice) ||
      Object.entries(raw.meanSelectorOptions).some(
        ([key, expected]) => artifact.policy[key as keyof FirstPartyRosChampionPolicy] !== expected,
      ) ||
      artifact.policy.globalBatches !== raw.meanChoice.globalBatches ||
      artifact.policy.globalSeasons !== raw.meanChoice.globalSeasons ||
      artifact.policy.globalSamples !== raw.meanChoice.globalSamples
    )
      return false;
    qualifications.push(raw);
  }
  // The builder checks duplicates, common source/scope/season identities, complete membership,
  // passing marginal screens and BOTH matched WIS comparators for the selected compact cells.
  const expected = buildRosMarginalIntervalStoredCells({
    qualifications,
    releasedCells: qualifications
      .filter((receipt) => receipt.state === "qualified")
      .map((receipt) => receipt.cell),
  });
  return sameCanonical(value.cells, expected);
}

const ARTIFACT_CELL_BLOCKER_PATTERN =
  /^(?:cell|champion|calibration)_(QB|RB|WR|TE|K|DST)_(one-to-four|five-to-eight|nine-plus)_/u;

const REPLACED_LEGACY_INTERVAL_BLOCKERS = new Set([
  "artifact_unavailable",
  "walk_forward_unavailable",
  "walk_forward_seasons_below_minimum",
  "walk_forward_blocks_below_minimum",
  "walk_forward_samples_below_minimum",
  "coverage_shortfall_above_maximum",
]);

export interface RosArtifactBlockerDiagnostics {
  readonly rawBlockers: readonly string[];
  readonly effectiveBlockers: readonly string[];
  readonly supersededIntervalDiagnostics: readonly string[];
  readonly blockedCells: ReadonlySet<string>;
}
/**
 * Interpret diagnostics only after the caller validates the immutable admitted artifact. This
 * classifier does not authenticate receipts, admit evidence, or authorize publication itself.
 */
export function deriveRosArtifactBlockers(
  input: {
    readonly policyVersion: string;
    readonly releaseGate: Record<string, unknown>;
  } & Partial<Omit<RosArtifactBlockerContext, "policy">> & { readonly policy?: unknown },
): RosArtifactBlockerDiagnostics {
  const rawBlockers = Array.isArray(input.releaseGate.blockers)
    ? input.releaseGate.blockers.filter((value): value is string => typeof value === "string")
    : [];
  const effectiveBlockers: string[] = [];
  const supersededIntervalDiagnostics: string[] = [];
  const blockedCells = new Set<string>();
  const marginal = input.policyVersion === FIRST_PARTY_ROS_MARGINAL_POLICY_VERSION;
  const point =
    input.policyVersion === FIRST_PARTY_ROS_POINT_POLICY_VERSION &&
    firstPartyRosPointArtifactIsConsistent(input as RosArtifactBlockerContext);
  const intervals = input.releaseGate.marginalIntervals;
  const qualified = new Set<string>();
  if (marginal && isRecord(intervals) && Array.isArray(intervals.qualifications)) {
    for (const receipt of intervals.qualifications) {
      if (
        isRecord(receipt) &&
        receipt.state === "qualified" &&
        isRecord(receipt.cell) &&
        typeof receipt.cell.position === "string" &&
        typeof receipt.cell.bucket === "string"
      )
        qualified.add(`${receipt.cell.position}:${receipt.cell.bucket}`);
    }
  }
  const points = input.releaseGate.pointForecasts;
  if (point && isRecord(points) && Array.isArray(points.qualifications)) {
    for (const receipt of points.qualifications) {
      if (firstPartyRosPointQualificationIsStructurallyValid(receipt)) {
        const selected = receipt.selectedStrategy === "contextual" ? "contextual" : "recency";
        if (receipt.convergence[selected].rate === 1)
          qualified.add(`${receipt.position}:${receipt.bucket}`);
      }
    }
  }
  for (const blocker of rawBlockers) {
    const match = ARTIFACT_CELL_BLOCKER_PATTERN.exec(blocker);
    if (match) {
      const cell = `${match[1]}:${match[2]}`;
      if (
        (marginal || point) &&
        qualified.has(cell) &&
        blocker.startsWith("calibration_") &&
        (REPLACED_LEGACY_INTERVAL_BLOCKERS.has(blocker.slice(match[0].length)) ||
          (point && blocker.slice(match[0].length) === "convergence_below_minimum"))
      ) {
        supersededIntervalDiagnostics.push(blocker);
        continue;
      }
      blockedCells.add(cell);
    } else if (marginal || input.policyVersion === FIRST_PARTY_ROS_POINT_POLICY_VERSION) {
      for (const position of POSITIONS)
        for (const bucket of FIRST_PARTY_ROS_BUCKETS) blockedCells.add(`${position}:${bucket}`);
    }
    effectiveBlockers.push(blocker);
  }
  return { rawBlockers, effectiveBlockers, supersededIntervalDiagnostics, blockedCells };
}

/** Read-only point status requires an authenticated enclosing artifact before suppression. */
export function deriveVerifiedPointRosArtifactBlockers(
  artifact: RosArtifactBlockerContext & { readonly artifactChecksum: string },
): RosArtifactBlockerDiagnostics | null {
  try {
    if (
      artifact.artifactChecksum !== firstPartyRosReleaseArtifactChecksum(artifact) ||
      !firstPartyRosPointArtifactIsConsistent(artifact)
    )
      return null;
    return deriveRosArtifactBlockers(artifact);
  } catch {
    return null;
  }
}

/**
 * Read-only status boundary for an immutable admitted row. Full receipt/source/mean binding and
 * the enclosing checksum are verified before any legacy diagnostic is suppressed. A failed or
 * malformed proof returns null; callers must retain all raw diagnostics instead.
 */
export function deriveVerifiedMarginalRosArtifactBlockers(
  artifact: RosArtifactBlockerContext & { readonly artifactChecksum: string },
): RosArtifactBlockerDiagnostics | null {
  try {
    if (
      artifact.policyVersion !== FIRST_PARTY_ROS_MARGINAL_POLICY_VERSION ||
      artifact.calibrationVersion !== MARGINAL_INTERVAL_CALIBRATION_VERSION ||
      artifact.policy.policyVersion !== FIRST_PARTY_ROS_POLICY_VERSION ||
      artifact.artifactChecksum !== firstPartyRosReleaseArtifactChecksum(artifact) ||
      !firstPartyRosMarginalArtifactIntervalsAreConsistent(artifact)
    )
      return null;
    return deriveRosArtifactBlockers(artifact);
  } catch {
    return null;
  }
}
