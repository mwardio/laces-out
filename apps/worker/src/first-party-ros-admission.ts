import type { FirstPartyRosChampionArtifactSourceChecksum } from "@laces-out/db";
import {
  FIRST_PARTY_ROS_INTERVAL_CALIBRATION_VERSION,
  FIRST_PARTY_ROS_MODEL_VERSION,
  FIRST_PARTY_ROS_POLICY_VERSION,
  projectionScoringProfileKey,
  type ProjectionScoringProfile,
} from "@laces-out/projections";

import {
  HISTORICAL_ROS_AVAILABILITY_CALIBRATION_VERSION,
  HISTORICAL_ROS_INTERVAL_METHOD_VERSION,
  HISTORICAL_ROS_KICKER_CALIBRATION_VERSION,
  HISTORICAL_ROS_ROLE_CALIBRATION_VERSION,
  HISTORICAL_ROS_SCORING_PROFILE,
} from "./first-party-ros-backtest.js";
import {
  firstPartyRosChampionArtifactChecksum,
  firstPartyRosChampionArtifactIsValid,
  firstPartyRosChampionPolicyChecksum,
  firstPartyRosChampionPolicyIsPublicationReady,
  type FirstPartyRosChampionArtifactPayload,
} from "./first-party-ros-publication.js";
import { firstPartyRosReleaseValidationBlockers } from "./first-party-ros-validation-contract.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

/** The running-code identities an admitted artifact must exactly reproduce. */
export interface FirstPartyRosAdmissionConstants {
  readonly modelVersion: string;
  readonly policyVersion: string;
  readonly calibrationVersion: string;
  readonly intervalMethodVersion: string;
  readonly availabilityCalibrationVersion: string;
  readonly roleCalibrationVersion: string;
  readonly kickerCalibrationVersion: string;
  readonly scoringProfileKey: string;
}

/**
 * Snapshots the admission identities from the running model/policy/calibration/scoring code.
 *
 * The scoring profile is explicit so the same frozen validation and admission process can be run
 * independently per profile. It changes only which profile is being admitted; every gate, including
 * the `scoring_profile_mismatch` comparison below, keeps its original strength.
 */
export function firstPartyRosAdmissionConstants(
  scoringProfile: ProjectionScoringProfile = HISTORICAL_ROS_SCORING_PROFILE,
): FirstPartyRosAdmissionConstants {
  return {
    modelVersion: FIRST_PARTY_ROS_MODEL_VERSION,
    policyVersion: FIRST_PARTY_ROS_POLICY_VERSION,
    calibrationVersion: FIRST_PARTY_ROS_INTERVAL_CALIBRATION_VERSION,
    intervalMethodVersion: HISTORICAL_ROS_INTERVAL_METHOD_VERSION,
    availabilityCalibrationVersion: HISTORICAL_ROS_AVAILABILITY_CALIBRATION_VERSION,
    roleCalibrationVersion: HISTORICAL_ROS_ROLE_CALIBRATION_VERSION,
    kickerCalibrationVersion: HISTORICAL_ROS_KICKER_CALIBRATION_VERSION,
    scoringProfileKey: projectionScoringProfileKey(scoringProfile),
  };
}

export type FirstPartyRosAdmissionValidation =
  | { readonly state: "rejected"; readonly blockers: readonly string[] }
  | {
      readonly state: "admissible";
      readonly blockers: readonly [];
      /**
       * Per-cell blockers carried into admission (ratified per-cell policy, 2026-07-22): the
       * release gate re-evaluates every cell at publish time, so a cell listed here is simply
       * withheld while every clean cell publishes. Global/portfolio blockers always reject.
       */
      readonly cellBlockers: readonly string[];
      readonly payload: FirstPartyRosChampionArtifactPayload;
      readonly artifactChecksum: string;
    };

const CELL_BLOCKER_PATTERN =
  /^(?:cell|champion|calibration)_(?:QB|RB|WR|TE|K|DST)_(?:one-to-four|five-to-eight|nine-plus)_/u;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const SOURCE_CHECKSUM_FIELDS: readonly (readonly [string, string])[] = [
  ["nflverse.stats-player-week", "weeklyStatsChecksum"],
  ["nflverse.stats-team-week", "teamWeeklyStatsChecksum"],
  ["nflverse.weekly-rosters", "weeklyRosterChecksum"],
  ["nflverse.injuries", "injuryChecksum"],
  ["nflverse.snap-counts", "snapChecksum"],
  ["nflverse.schedules", "scheduleChecksum"],
];

/**
 * Expands the validation report's per-season source audit into the artifact's pinned upstream
 * lineage. Only lowercase SHA-256 checksums are kept; a report produced without `--full` (no source
 * audit) therefore yields an empty lineage, which the caller treats as a fail-closed blocker.
 */
export function deriveFirstPartyRosSourceChecksums(
  report: unknown,
): readonly FirstPartyRosChampionArtifactSourceChecksum[] {
  if (!isObject(report) || !Array.isArray(report.sources)) return [];
  const byKey = new Map<string, string>();
  for (const entry of report.sources) {
    if (!isObject(entry)) continue;
    const season = entry.season;
    if (!Number.isSafeInteger(season)) continue;
    for (const [prefix, field] of SOURCE_CHECKSUM_FIELDS) {
      const checksum = entry[field];
      if (typeof checksum === "string" && SHA256_PATTERN.test(checksum)) {
        byKey.set(`${prefix}.${season as number}`, checksum);
      }
    }
  }
  return [...byKey.entries()]
    .map(([key, checksum]) => ({ key, checksum }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

/**
 * Fail-closed admission validation. It authorizes exactly one immutable champion artifact only when
 * the validation report is `evidence-ready` with no blockers and every model/policy/calibration/
 * scoring identity in the report matches the running code. It is a pure function so the decision can
 * be tested without a database or a live backtest.
 */
export function validateFirstPartyRosAdmission(input: {
  readonly report: unknown;
  readonly evidenceThroughSeason: number;
  readonly constants: FirstPartyRosAdmissionConstants;
}): FirstPartyRosAdmissionValidation {
  const blockers: string[] = [];
  const { evidenceThroughSeason, constants } = input;

  if (!Number.isSafeInteger(evidenceThroughSeason) || evidenceThroughSeason < 1999) {
    blockers.push("evidence_through_season_invalid");
  }
  if (!isObject(input.report)) {
    return { state: "rejected", blockers: [...blockers, "report_not_object"] };
  }
  const report = input.report;

  // Position-only replays are evidence inputs for composing a complete report, never admissible
  // release artifacts by themselves. Older complete reports predate this explicit scope and remain
  // accepted through the existing locked full-portfolio count checks.
  if (report.validationScope !== undefined) {
    if (!isObject(report.validationScope)) {
      blockers.push("validation_scope_unreadable");
    } else {
      const scope = report.validationScope;
      const positions = Array.isArray(scope.positions) ? scope.positions : [];
      if (
        scope.completePortfolio !== true ||
        positions.length !== 6 ||
        new Set(positions).size !== 6 ||
        !["QB", "RB", "WR", "TE", "K", "DST"].every((position) => positions.includes(position))
      ) {
        blockers.push("validation_scope_not_complete_portfolio");
      }
    }
  }

  const backtest = report.report;
  let cellBlockers: readonly string[] = [];
  if (!isObject(backtest)) {
    blockers.push("report_body_missing");
  } else {
    blockers.push(...firstPartyRosReleaseValidationBlockers(backtest));
    if (!Array.isArray(backtest.blockers) || backtest.blockers.some((b) => typeof b !== "string")) {
      blockers.push("report_blockers_unreadable");
    } else {
      const reported = backtest.blockers as readonly string[];
      cellBlockers = reported.filter((blocker) => CELL_BLOCKER_PATTERN.test(blocker));
      const globalBlockers = reported.filter((blocker) => !CELL_BLOCKER_PATTERN.test(blocker));
      if (globalBlockers.length > 0) blockers.push("report_global_blockers_present");
      // "insufficient" is acceptable only when it is explained entirely by per-cell blockers the
      // release gate will re-evaluate; any other state, or an unexplained state, rejects.
      if (backtest.state !== "evidence-ready") {
        if (backtest.state !== "insufficient") blockers.push("report_state_unsupported");
        else if (reported.length === 0) blockers.push("report_state_inconsistent");
      }
    }
    if (backtest.availabilityCalibrationVersion !== constants.availabilityCalibrationVersion) {
      blockers.push("availability_calibration_mismatch");
    }
    if (backtest.roleCalibrationVersion !== constants.roleCalibrationVersion) {
      blockers.push("role_calibration_mismatch");
    }
    if (backtest.kickerCalibrationVersion !== constants.kickerCalibrationVersion) {
      blockers.push("kicker_calibration_mismatch");
    }
  }

  const champion = report.champion;
  if (!isObject(champion)) {
    blockers.push("champion_missing");
  } else {
    if (champion.modelVersion !== constants.modelVersion) blockers.push("model_version_mismatch");
    if (champion.policyVersion !== constants.policyVersion)
      blockers.push("policy_version_mismatch");
    if (champion.evidenceThroughSeason !== evidenceThroughSeason) {
      blockers.push("evidence_through_season_report_mismatch");
    }
    const evidenceIdentity = champion.evidenceIdentity;
    if (!isObject(evidenceIdentity)) {
      blockers.push("evidence_identity_missing");
    } else {
      if (evidenceIdentity.scoringProfileKey !== constants.scoringProfileKey) {
        blockers.push("scoring_profile_mismatch");
      }
      if (evidenceIdentity.intervalMethodVersion !== constants.intervalMethodVersion) {
        blockers.push("interval_method_mismatch");
      }
    }
  }

  const publicationPolicy = report.publicationPolicy;
  if (!firstPartyRosChampionPolicyIsPublicationReady(publicationPolicy)) {
    blockers.push("publication_policy_missing_or_invalid");
  } else {
    if (publicationPolicy.modelVersion !== constants.modelVersion) {
      blockers.push("publication_policy_model_version_mismatch");
    }
    if (publicationPolicy.policyVersion !== constants.policyVersion) {
      blockers.push("publication_policy_version_mismatch");
    }
    if (publicationPolicy.evidenceThroughSeason !== evidenceThroughSeason) {
      blockers.push("publication_policy_evidence_through_season_mismatch");
    }
    if (publicationPolicy.evidenceIdentity?.scoringProfileKey !== constants.scoringProfileKey) {
      blockers.push("publication_policy_scoring_profile_mismatch");
    }
    if (
      isObject(champion) &&
      (champion.modelVersion !== publicationPolicy.modelVersion ||
        champion.policyVersion !== publicationPolicy.policyVersion ||
        champion.evidenceThroughSeason !== publicationPolicy.evidenceThroughSeason)
    ) {
      blockers.push("champion_summary_publication_policy_mismatch");
    }
    if (
      !isObject(champion) ||
      typeof champion.publicationPolicyChecksum !== "string" ||
      champion.publicationPolicyChecksum !== firstPartyRosChampionPolicyChecksum(publicationPolicy)
    ) {
      blockers.push("publication_policy_checksum_mismatch");
    }
  }

  const sourceChecksums = deriveFirstPartyRosSourceChecksums(report);
  if (sourceChecksums.length === 0) blockers.push("source_lineage_unavailable");

  if (
    blockers.length > 0 ||
    !isObject(champion) ||
    !firstPartyRosChampionPolicyIsPublicationReady(publicationPolicy)
  ) {
    return { state: "rejected", blockers };
  }

  const payload: FirstPartyRosChampionArtifactPayload = {
    season: evidenceThroughSeason + 1,
    scoringProfileKey: constants.scoringProfileKey,
    modelVersion: constants.modelVersion,
    policyVersion: constants.policyVersion,
    calibrationVersion: constants.calibrationVersion,
    evidenceThroughSeason,
    sourceChecksums,
    policy: publicationPolicy,
    releaseGate: isObject(backtest) ? backtest : {},
  };
  const artifactChecksum = firstPartyRosChampionArtifactChecksum(payload);
  if (!firstPartyRosChampionArtifactIsValid({ ...payload, artifactChecksum })) {
    return { state: "rejected", blockers: ["constructed_artifact_invalid"] };
  }
  return { state: "admissible", blockers: [], cellBlockers, payload, artifactChecksum };
}
