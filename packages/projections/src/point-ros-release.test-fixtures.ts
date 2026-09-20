import { rosMarginalIntervalQualificationFullFixtureInput } from "./ros-marginal-interval-test-fixtures.js";
import {
  evaluateFirstPartyRosChampionPolicy,
  evaluateFirstPartyRosConvergence,
  type FirstPartyRosChampionPolicy,
  type FirstPartyRosConvergenceDiagnostic,
  type FirstPartyRosLiveReleaseEvidence,
  type FirstPartyRosPosition,
} from "./rest-of-season.js";
import {
  buildFirstPartyRosPointQualificationSet,
  FIRST_PARTY_ROS_POINT_CALIBRATION_VERSION,
  FIRST_PARTY_ROS_POINT_POLICY_VERSION,
  FIRST_PARTY_ROS_POINT_RELEASE_VERSION,
  type FirstPartyRosPointConvergenceEvidence,
} from "./point-ros-release.js";
import type { RosArtifactBlockerContext } from "./ros-artifact-blockers.js";
import { sha256Hex } from "./sha256.js";

export function pointLegacyConvergenceChecksumFixture(
  diagnostic: FirstPartyRosConvergenceDiagnostic,
) {
  return sha256Hex(
    JSON.stringify({
      version: "live-bounded-ros-convergence-v1",
      seedHash: diagnostic.seedHash,
      lowerScenarioCount: diagnostic.releaseScenarioCount,
      referenceScenarioCount: diagnostic.referenceScenarioCount,
      metrics: diagnostic.metrics.map((metric) => ({
        metric: metric.metric,
        absoluteDifference: metric.absoluteDifference,
        allowed: metric.allowedDifference,
        ratio: metric.toleranceRatio,
      })),
    }),
  );
}

export function pointConvergenceFixture(
  position: FirstPartyRosPosition,
  scoringProfileKey: string,
  metric: "quantile" | "mean" | "games" | "none" = "quantile",
) {
  const reference = {
    seedHash: sha256Hex("physical-point-path"),
    scoringProfileKey,
    scenarioCount: 16_384,
    expectedGames: 2,
    meanPoints: 10,
    p15Points: 8,
    p50Points: 10,
    p85Points: 12,
  };
  const release = {
    ...reference,
    scenarioCount: 12_288,
    expectedGames: metric === "games" ? 1.5 : 2,
    meanPoints: metric === "mean" ? 11 : 10,
    p85Points: metric === "quantile" ? 15 : 12,
  };
  return evaluateFirstPartyRosConvergence({ position, reference, release });
}
export function pointEvidenceFixture(
  policy: FirstPartyRosChampionPolicy,
): FirstPartyRosPointConvergenceEvidence[] {
  return policy.choices.flatMap((choice) =>
    choice.meanSelectionEvidence.seasonEvidence.flatMap(({ season }) =>
      (["contextual", "availability-aware-recency"] as const).map((strategy) => ({
        kind: "full-distribution-converged" as const,
        season,
        position: choice.position,
        bucket: choice.bucket,
        strategy,
        diagnosticChecksum: sha256Hex(`${choice.position}:${choice.bucket}:${season}:${strategy}`),
        state: "converged" as const,
        worstToleranceRatio: 0.5,
      })),
    ),
  );
}
export function pointRosReleaseFixture() {
  const source = rosMarginalIntervalQualificationFullFixtureInput();
  const policy = evaluateFirstPartyRosChampionPolicy(source.candidate.heldOutSeasons).livePolicy;
  const convergenceEvidence = pointEvidenceFixture(policy);
  const buildInput = {
    meanPolicy: policy,
    forecastSeason: 2026,
    candidateReportChecksum: sha256Hex("candidate-report"),
    sourceEvidenceChecksum: sha256Hex("source-evidence"),
    comparisonManifestChecksum: sha256Hex("comparison-manifest"),
    convergenceEvidence,
  };
  const qualifications = buildFirstPartyRosPointQualificationSet(buildInput);
  const identity = policy.evidenceIdentity!;
  const live: FirstPartyRosLiveReleaseEvidence = {
    ...identity,
    position: "DST",
    bucket: "one-to-four",
    inputChecksum: sha256Hex("live-point-input"),
    coverage: { contextual: 1, recency: 1 },
    availability: { scheduledGames: 2, contextualExpectedGames: 2, recencyExpectedGames: 2 },
    convergence: {
      contextual: {
        state: "unstable",
        diagnosticChecksum: pointLegacyConvergenceChecksumFixture(
          pointConvergenceFixture("DST", identity.scoringProfileKey),
        ),
      },
      recency: {
        state: "unstable",
        diagnosticChecksum: pointLegacyConvergenceChecksumFixture(
          pointConvergenceFixture("DST", identity.scoringProfileKey),
        ),
      },
    },
    pointConvergence: {
      contextual: pointConvergenceFixture("DST", identity.scoringProfileKey),
      recency: pointConvergenceFixture("DST", identity.scoringProfileKey),
    },
  };
  const artifact: RosArtifactBlockerContext = {
    season: 2026,
    scoringProfileKey: identity.scoringProfileKey,
    modelVersion: policy.modelVersion,
    policyVersion: FIRST_PARTY_ROS_POINT_POLICY_VERSION,
    calibrationVersion: FIRST_PARTY_ROS_POINT_CALIBRATION_VERSION,
    evidenceThroughSeason: 2025,
    sourceChecksums: [
      { key: "point-candidate-report", checksum: buildInput.candidateReportChecksum },
      { key: "point-source-evidence", checksum: buildInput.sourceEvidenceChecksum },
      { key: "point-comparison-manifest", checksum: buildInput.comparisonManifestChecksum },
    ],
    policy,
    releaseGate: {
      blockers: [],
      pointForecasts: {
        schemaVersion: 1,
        method: FIRST_PARTY_ROS_POINT_RELEASE_VERSION,
        intervalAvailable: false,
        qualifications,
      },
    },
  };
  return { policy, live, artifact, qualifications, buildInput };
}
