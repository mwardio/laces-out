import {
  FIRST_PARTY_PROJECTION_MODEL_VERSION,
  FIRST_PARTY_ROS_CONVERGENCE_REFERENCE_SCENARIOS,
  FIRST_PARTY_ROS_DEFAULT_SCENARIOS,
  FIRST_PARTY_ROS_INTERVAL_CALIBRATION_VERSION,
  FIRST_PARTY_ROS_MODEL_VERSION,
  FIRST_PARTY_ROS_OUTCOME_SCHEMA_VERSION,
  FIRST_PARTY_ROS_POLICY_VERSION,
  FIRST_PARTY_ROS_SEED_VERSION,
} from "@laces-out/projections";
import { NFLVERSE_WEEKLY_STATS_COMPONENT_SCHEMA } from "@laces-out/source-nflverse";
import { FIRST_PARTY_PLAYER_HISTORY_VERSION } from "./first-party-projection-inputs.js";

import {
  HISTORICAL_ROS_AVAILABILITY_CALIBRATION_VERSION,
  HISTORICAL_ROS_CANDIDATE_PAIR_VERSION,
  HISTORICAL_ROS_COHORT_SELECTION_VERSION,
  HISTORICAL_ROS_INTERVAL_METHOD_VERSION,
  HISTORICAL_ROS_KICKER_CALIBRATION_VERSION,
  HISTORICAL_ROS_PRODUCTION_BASIS_VERSION,
  HISTORICAL_ROS_ROLE_CALIBRATION_VERSION,
} from "./first-party-ros-backtest.js";
import { ROS_HISTORICAL_COVERAGE_DEFAULT_THRESHOLDS } from "./ros-data-coverage.js";
import { ROS_OUTCOME_CACHE_VERSION } from "./ros-outcome-cache.js";

/** Exact football-generation compatibility; evaluation policies never change these paths. */
export const ROS_HISTORICAL_CORPUS_PHYSICAL_PROTOCOL = Object.freeze({
  version: "historical-ros-build-protocol-v1",
  modelVersion: FIRST_PARTY_ROS_MODEL_VERSION,
  seedVersion: FIRST_PARTY_ROS_SEED_VERSION,
  outcomeSchemaVersion: FIRST_PARTY_ROS_OUTCOME_SCHEMA_VERSION,
  cacheVersion: ROS_OUTCOME_CACHE_VERSION,
  scenarioCount: FIRST_PARTY_ROS_DEFAULT_SCENARIOS,
  referenceScenarioCount: FIRST_PARTY_ROS_CONVERGENCE_REFERENCE_SCENARIOS,
  weeklyModelVersion: HISTORICAL_ROS_CANDIDATE_PAIR_VERSION,
  weeklyComponentModelVersion: FIRST_PARTY_PROJECTION_MODEL_VERSION,
  playerHistoryVersion: FIRST_PARTY_PLAYER_HISTORY_VERSION,
  productionBasis: HISTORICAL_ROS_PRODUCTION_BASIS_VERSION,
  cohortStrategy: HISTORICAL_ROS_COHORT_SELECTION_VERSION,
  availabilityVersion: HISTORICAL_ROS_AVAILABILITY_CALIBRATION_VERSION,
  roleVersion: HISTORICAL_ROS_ROLE_CALIBRATION_VERSION,
  kickerVersion: HISTORICAL_ROS_KICKER_CALIBRATION_VERSION,
  intervalMethodVersion: HISTORICAL_ROS_INTERVAL_METHOD_VERSION,
  weeklySourceParserVersion: NFLVERSE_WEEKLY_STATS_COMPONENT_SCHEMA,
});

/** Immutable provenance of the original build, including its then-current evaluator. */
export const ROS_HISTORICAL_CORPUS_BUILD_PROTOCOL = Object.freeze({
  ...ROS_HISTORICAL_CORPUS_PHYSICAL_PROTOCOL,
  policyVersion: FIRST_PARTY_ROS_POLICY_VERSION,
  calibrationVersion: FIRST_PARTY_ROS_INTERVAL_CALIBRATION_VERSION,
});

export type RosHistoricalCorpusBuildProtocol = typeof ROS_HISTORICAL_CORPUS_BUILD_PROTOCOL;

// Retain only explicitly reviewed historical evaluation provenance. Unknown versions must not
// become an escape hatch from physical compatibility, even when their names look well formed.
const compatibleEvaluationVersions = [
  {
    policyVersion: "season-walk-forward-block-wis-cqr-v5",
    calibrationVersion: "season-blocked-split-conformal-cqr-v1",
  },
  {
    policyVersion: FIRST_PARTY_ROS_POLICY_VERSION,
    calibrationVersion: FIRST_PARTY_ROS_INTERVAL_CALIBRATION_VERSION,
  },
] as const;

export type RosHistoricalCorpusBuildProvenance = typeof ROS_HISTORICAL_CORPUS_PHYSICAL_PROTOCOL &
  (typeof compatibleEvaluationVersions)[number];

/** These six exact options define the release evaluator, independently of cohort size. */
export const ROS_HISTORICAL_CORPUS_RELEASE_THRESHOLDS = Object.freeze({
  minimumPortfolioForecasts: 300,
  minimumPortfolioBatches: 30,
  minimumCellSamples: 18,
  minimumCellCutoffs: 3,
  minimumCellBatches: 9,
  minimumCellSeasons: 3,
});

export const ROS_HISTORICAL_CORPUS_COVERAGE_THRESHOLDS = ROS_HISTORICAL_COVERAGE_DEFAULT_THRESHOLDS;

function matchesFields(
  value: unknown,
  expected: Readonly<Record<string, string | number>>,
  exact: boolean,
): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const fields = value as Record<string, unknown>;
  const names = Object.keys(expected);
  return (
    (!exact || Object.keys(fields).length === names.length) &&
    names.every((name) => Object.hasOwn(fields, name) && fields[name] === expected[name])
  );
}

export function isCurrentRosHistoricalCorpusBuildProtocol(
  value: unknown,
): value is RosHistoricalCorpusBuildProtocol {
  return matchesFields(value, ROS_HISTORICAL_CORPUS_BUILD_PROTOCOL, true);
}

/**
 * Raw corpus reuse only: preserve the original evaluator names while checking every physical
 * field exactly. A fresh current-policy replay and separate profile admission are still required.
 */
export function isCompatibleRosHistoricalCorpusBuildProtocol(
  value: unknown,
): value is RosHistoricalCorpusBuildProvenance {
  if (!matchesFields(value, ROS_HISTORICAL_CORPUS_PHYSICAL_PROTOCOL, false)) return false;
  const fields = value as Record<string, unknown>;
  return (
    Object.keys(fields).length === Object.keys(ROS_HISTORICAL_CORPUS_BUILD_PROTOCOL).length &&
    Object.hasOwn(fields, "policyVersion") &&
    Object.hasOwn(fields, "calibrationVersion") &&
    compatibleEvaluationVersions.some(
      (version) =>
        fields.policyVersion === version.policyVersion &&
        fields.calibrationVersion === version.calibrationVersion,
    )
  );
}

/** Extra scope options are allowed, but none of the six evaluator thresholds may differ. */
export function hasRosHistoricalCorpusReleaseThresholds(value: unknown): boolean {
  return matchesFields(value, ROS_HISTORICAL_CORPUS_RELEASE_THRESHOLDS, false);
}

export function hasCurrentRosHistoricalCoverageThresholds(value: unknown): boolean {
  return matchesFields(value, { ...ROS_HISTORICAL_CORPUS_COVERAGE_THRESHOLDS }, true);
}
