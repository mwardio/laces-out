import {
  FIRST_PARTY_ROS_INTERVAL_CALIBRATION_VERSION,
  FIRST_PARTY_ROS_MODEL_VERSION,
  FIRST_PARTY_ROS_POLICY_VERSION,
  evaluateFirstPartyRosChampionPolicy,
  type FirstPartyRosChampionPolicy,
  type FirstPartyRosHeldOutForecast,
  type FirstPartyRosLiveReleaseEvidence,
} from "@fantasy/projections";
import { describe, expect, it } from "vitest";

import {
  evaluateFirstPartyRosPublication,
  firstPartyRosChampionArtifactChecksum,
  firstPartyRosChampionArtifactIsValid,
  type FirstPartyRosChampionArtifactPayload,
  type LoadedFirstPartyRosChampionArtifact,
} from "./first-party-ros-publication.js";

const SCORING_KEY = "test-ppr:v1";

function heldOutForecast(
  season: number,
  asOfWeek: number,
  playerId: string,
): FirstPartyRosHeldOutForecast {
  const actual = 100;
  const contextualMean = actual + 1;
  const recencyMean = actual + 8;
  return {
    playerId,
    position: "WR",
    contextualModelVersion: "contextual-v1",
    recencyModelVersion: "recency-v1",
    scoringProfileKey: SCORING_KEY,
    intervalMethodVersion: "simulation-p15-p85-v1",
    forecastSeason: season,
    asOfWeek,
    windowStartWeek: asOfWeek + 1,
    windowEndWeek: 18,
    trainedThroughSeason: season - 1,
    inputChecksum: "b".repeat(64),
    evidence: {
      coverage: { contextual: 1, recency: 1 },
      availability: {
        scheduledGames: 18 - asOfWeek,
        actualGames: 17 - asOfWeek,
        contextualExpectedGames: 17 - asOfWeek,
        recencyExpectedGames: 16.5 - asOfWeek,
      },
      convergence: {
        contextual: { state: "converged", diagnosticChecksum: "c".repeat(64) },
        recency: { state: "converged", diagnosticChecksum: "d".repeat(64) },
      },
    },
    contextual: {
      meanPoints: contextualMean,
      p15Points: contextualMean - 15,
      p50Points: contextualMean,
      p85Points: contextualMean + 15,
    },
    recency: {
      meanPoints: recencyMean,
      p15Points: recencyMean - 25,
      p50Points: recencyMean,
      p85Points: recencyMean + 25,
    },
    actualPoints: actual,
  };
}

function buildLivePolicy(): FirstPartyRosChampionPolicy {
  const evaluation = evaluateFirstPartyRosChampionPolicy(
    [2023, 2024, 2025].map((season) => ({
      season,
      complete: true,
      forecasts: [
        heldOutForecast(season, 10, `${season}-one`),
        heldOutForecast(season, 11, `${season}-two`),
      ],
    })),
    {
      minimumHeldOutSeasons: 2,
      minimumBatches: 4,
      minimumSamples: 4,
      minimumCellSeasons: 2,
      minimumCellSamples: 4,
      minimumCellCutoffs: 2,
      minimumCellBatches: 4,
    },
  );
  return evaluation.livePolicy;
}

const releaseOptions = {
  maximumIntervalCoverageDeviation: 0.31,
  minimumWalkForwardCalibrationSeasons: 1,
  minimumWalkForwardCalibrationBatches: 2,
  minimumWalkForwardCalibrationSamples: 2,
} as const;

const liveEvidence: FirstPartyRosLiveReleaseEvidence = {
  contextualModelVersion: "contextual-v1",
  recencyModelVersion: "recency-v1",
  scoringProfileKey: SCORING_KEY,
  intervalMethodVersion: "simulation-p15-p85-v1",
  position: "WR",
  bucket: "five-to-eight",
  inputChecksum: "e".repeat(64),
  coverage: { contextual: 1, recency: 1 },
  availability: { scheduledGames: 8, contextualExpectedGames: 7, recencyExpectedGames: 6.5 },
  convergence: {
    contextual: { state: "converged", diagnosticChecksum: "c".repeat(64) },
    recency: { state: "converged", diagnosticChecksum: "d".repeat(64) },
  },
};

function artifactPayload(
  policy: FirstPartyRosChampionPolicy,
  overrides: Partial<FirstPartyRosChampionArtifactPayload> = {},
): FirstPartyRosChampionArtifactPayload {
  return {
    season: 2026,
    scoringProfileKey: SCORING_KEY,
    modelVersion: FIRST_PARTY_ROS_MODEL_VERSION,
    policyVersion: FIRST_PARTY_ROS_POLICY_VERSION,
    calibrationVersion: FIRST_PARTY_ROS_INTERVAL_CALIBRATION_VERSION,
    evidenceThroughSeason: 2025,
    sourceChecksums: [{ key: "nflverse.schedules.2026", checksum: "a".repeat(64) }],
    policy,
    releaseGate: { state: "release" },
    ...overrides,
  };
}

function loadedArtifact(
  policy: FirstPartyRosChampionPolicy,
  overrides: Partial<FirstPartyRosChampionArtifactPayload> = {},
): LoadedFirstPartyRosChampionArtifact {
  const payload = artifactPayload(policy, overrides);
  return { ...payload, artifactChecksum: firstPartyRosChampionArtifactChecksum(payload) };
}

describe("first-party ROS champion artifact checksum", () => {
  it("is a deterministic SHA-256 that is stable across source-checksum order", () => {
    const policy = buildLivePolicy();
    const one = artifactPayload(policy, {
      sourceChecksums: [
        { key: "nflverse.schedules.2026", checksum: "a".repeat(64) },
        { key: "laces-out.projections.first-party", checksum: "b".repeat(64) },
      ],
    });
    const reordered = {
      ...one,
      sourceChecksums: [...one.sourceChecksums].reverse(),
    };
    const checksum = firstPartyRosChampionArtifactChecksum(one);
    expect(checksum).toMatch(/^[a-f0-9]{64}$/u);
    expect(firstPartyRosChampionArtifactChecksum(reordered)).toBe(checksum);
    expect(firstPartyRosChampionArtifactChecksum({ ...one, evidenceThroughSeason: 2024 })).not.toBe(
      checksum,
    );
  });
});

describe("first-party ROS champion artifact validity", () => {
  it("accepts a self-consistent artifact and rejects tampering", () => {
    const policy = buildLivePolicy();
    const artifact = loadedArtifact(policy);
    expect(firstPartyRosChampionArtifactIsValid(artifact)).toBe(true);
    expect(
      firstPartyRosChampionArtifactIsValid({ ...artifact, artifactChecksum: "0".repeat(64) }),
    ).toBe(false);
    expect(
      firstPartyRosChampionArtifactIsValid({
        ...artifact,
        modelVersion: "laces-ros-distribution-v3",
      }),
    ).toBe(false);
    expect(
      firstPartyRosChampionArtifactIsValid({ ...artifact, scoringProfileKey: "other-profile" }),
    ).toBe(false);
  });
});

describe("first-party ROS publication decision", () => {
  it("fails closed with no artifact and preserves the prior good set", () => {
    const decision = evaluateFirstPartyRosPublication({
      artifact: null,
      leagueScoringProfileKey: SCORING_KEY,
      evidence: [liveEvidence],
      futureWindowComplete: true,
    });
    expect(decision).toMatchObject({
      canPublish: false,
      artifactValid: false,
      preservePriorGoodSet: true,
      reasons: ["ros_champion_artifact_absent"],
    });
    expect(decision.releasingBuckets).toHaveLength(0);
  });

  it("releases only when the artifact validates and the live gate clears", () => {
    const decision = evaluateFirstPartyRosPublication({
      artifact: loadedArtifact(buildLivePolicy()),
      leagueScoringProfileKey: SCORING_KEY,
      evidence: [liveEvidence],
      futureWindowComplete: true,
      gateOptions: releaseOptions,
    });
    expect(decision.canPublish).toBe(true);
    expect(decision.reasons).toHaveLength(0);
    expect(decision.releasingBuckets).toHaveLength(1);
    expect(decision.releasingBuckets[0]).toMatchObject({
      position: "WR",
      bucket: "five-to-eight",
      state: "release",
      strategy: "contextual",
    });
    expect(decision.preservePriorGoodSet).toBe(false);
  });

  it("honors the admitted report's own cell blockers over a releasing live gate", () => {
    const policy = buildLivePolicy();
    const blocked = evaluateFirstPartyRosPublication({
      artifact: loadedArtifact(policy, {
        releaseGate: {
          state: "insufficient",
          blockers: ["calibration_WR_five-to-eight_count_family_dispersion_out_of_bounds"],
        },
      }),
      leagueScoringProfileKey: SCORING_KEY,
      evidence: [liveEvidence],
      futureWindowComplete: true,
      gateOptions: releaseOptions,
    });
    expect(blocked.canPublish).toBe(false);
    expect(blocked.preservePriorGoodSet).toBe(true);
    expect(blocked.reasons).toContain("ros_admitted_cell_blocker_withheld");
    expect(blocked.buckets[0]).toMatchObject({ state: "withhold" });
    // The live gate decision itself is preserved unmodified for observability.
    expect(blocked.buckets[0]!.gate.state).toBe("release");
    // A blocker for a different cell leaves this bucket untouched.
    const unrelated = evaluateFirstPartyRosPublication({
      artifact: loadedArtifact(policy, {
        releaseGate: {
          state: "insufficient",
          blockers: ["calibration_K_one-to-four_coverage_shortfall_above_maximum"],
        },
      }),
      leagueScoringProfileKey: SCORING_KEY,
      evidence: [liveEvidence],
      futureWindowComplete: true,
      gateOptions: releaseOptions,
    });
    expect(unrelated.canPublish).toBe(true);
    expect(unrelated.reasons).not.toContain("ros_admitted_cell_blocker_withheld");
  });

  it("withholds and preserves the prior set on an invalid artifact checksum", () => {
    const artifact = loadedArtifact(buildLivePolicy());
    const decision = evaluateFirstPartyRosPublication({
      artifact: { ...artifact, artifactChecksum: "0".repeat(64) },
      leagueScoringProfileKey: SCORING_KEY,
      evidence: [liveEvidence],
      futureWindowComplete: true,
      gateOptions: releaseOptions,
    });
    expect(decision.canPublish).toBe(false);
    expect(decision.reasons).toContain("ros_champion_artifact_invalid");
    expect(decision.preservePriorGoodSet).toBe(true);
    expect(decision.releasingBuckets).toHaveLength(0);
  });

  it("withholds on a scoring-profile mismatch between artifact and league", () => {
    const decision = evaluateFirstPartyRosPublication({
      artifact: loadedArtifact(buildLivePolicy()),
      leagueScoringProfileKey: "half-ppr:v1",
      evidence: [liveEvidence],
      futureWindowComplete: true,
      gateOptions: releaseOptions,
    });
    expect(decision.canPublish).toBe(false);
    expect(decision.scoringProfileMatches).toBe(false);
    expect(decision.reasons).toContain("ros_champion_artifact_scoring_profile_mismatch");
    expect(decision.preservePriorGoodSet).toBe(true);
  });

  it("withholds and preserves the prior set on a gate withhold reason", () => {
    const decision = evaluateFirstPartyRosPublication({
      artifact: loadedArtifact(buildLivePolicy()),
      leagueScoringProfileKey: SCORING_KEY,
      evidence: [
        {
          ...liveEvidence,
          convergence: {
            ...liveEvidence.convergence,
            contextual: { state: "unstable", diagnosticChecksum: "c".repeat(64) },
          },
        },
      ],
      futureWindowComplete: true,
      gateOptions: releaseOptions,
    });
    expect(decision.canPublish).toBe(false);
    expect(decision.reasons).toContain("ros_release_gate_withheld");
    expect(decision.preservePriorGoodSet).toBe(true);
  });

  it("withholds on an incomplete future window", () => {
    const decision = evaluateFirstPartyRosPublication({
      artifact: loadedArtifact(buildLivePolicy()),
      leagueScoringProfileKey: SCORING_KEY,
      evidence: [liveEvidence],
      futureWindowComplete: false,
      gateOptions: releaseOptions,
    });
    expect(decision.canPublish).toBe(false);
    expect(decision.reasons).toContain("ros_future_window_incomplete");
    expect(decision.releasingBuckets).toHaveLength(0);
    expect(decision.preservePriorGoodSet).toBe(true);
  });
});
