import {
  FIRST_PARTY_ROS_INTERVAL_CALIBRATION_VERSION,
  FIRST_PARTY_ROS_MODEL_VERSION,
  FIRST_PARTY_ROS_POLICY_VERSION,
  evaluateFirstPartyRosChampionPolicy,
  projectionScoringProfileKey,
  type FirstPartyRosChampionPolicy,
  type FirstPartyRosHeldOutForecast,
  type FirstPartyRosPosition,
  rosScoringProfile,
  type FirstPartyRosLiveReleaseEvidence,
  type ProjectionScoringProfile,
} from "@fantasy/projections";
import { describe, expect, it } from "vitest";

import {
  buildFirstPartyRosRunPayload,
  evaluateFirstPartyRosPublication,
  firstPartyRosChampionArtifactChecksum,
  firstPartyRosChampionArtifactIsValid,
  selectFirstPartyRosArtifactForLeague,
  type FirstPartyRosChampionArtifactPayload,
  type LoadedFirstPartyRosChampionArtifact,
} from "./first-party-ros-publication.js";

const SCORING_KEY = "test-ppr:v1";

function heldOutForecast(
  season: number,
  asOfWeek: number,
  playerId: string,
  scoringProfileKey: string = SCORING_KEY,
): FirstPartyRosHeldOutForecast {
  const actual = 100;
  const contextualMean = actual + 1;
  const recencyMean = actual + 8;
  return {
    playerId,
    position: "WR",
    contextualModelVersion: "contextual-v1",
    recencyModelVersion: "recency-v1",
    scoringProfileKey,
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

function buildLivePolicy(scoringProfileKey: string = SCORING_KEY): FirstPartyRosChampionPolicy {
  const evaluation = evaluateFirstPartyRosChampionPolicy(
    [2023, 2024, 2025].map((season) => ({
      season,
      complete: true,
      forecasts: [
        heldOutForecast(season, 10, `${season}-one`, scoringProfileKey),
        heldOutForecast(season, 11, `${season}-two`, scoringProfileKey),
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

function liveEvidenceFor(input: {
  readonly scoringProfileKey: string;
  readonly position?: FirstPartyRosPosition;
}): FirstPartyRosLiveReleaseEvidence {
  return {
    ...liveEvidence,
    scoringProfileKey: input.scoringProfileKey,
    ...(input.position === undefined ? {} : { position: input.position }),
  };
}

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

describe("first-party ROS per-position publication matching", () => {
  // Positions never interact numerically: a rule outside a position's component vocabulary
  // contributes exactly 0 to its score. These fixtures differ ONLY in the kicker's field-goal
  // brackets, which is the real-world shape (ESPN leagues split 50-59/60+ where the admitted
  // catalog prices 50+), so QB/RB/WR/TE score byte-identically under both.
  const offenseRules = [
    { statId: "receptions", points: 1 },
    { statId: "receiving_yards", points: 0.1 },
    { statId: "receiving_touchdowns", points: 6 },
    { statId: "rushing_yards", points: 0.1 },
    { statId: "rushing_touchdowns", points: 6 },
  ] as const;
  const artifactProfile: ProjectionScoringProfile = {
    id: "catalog-ppr",
    rules: [
      ...offenseRules,
      { statId: "field_goals_made_0_39", points: 3 },
      { statId: "field_goals_made_40_49", points: 4 },
      { statId: "field_goals_made_50_plus", points: 5 },
    ],
  };
  const splitKickerProfile: ProjectionScoringProfile = {
    id: "league-split-fg",
    rules: [
      ...offenseRules,
      { statId: "field_goals_made_0_39", points: 3 },
      { statId: "field_goals_made_40_49", points: 4 },
      { statId: "field_goals_made_50_59", points: 5 },
      { statId: "field_goals_made_60_plus", points: 6 },
    ],
  };
  const artifactKey = projectionScoringProfileKey(artifactProfile);
  const splitKickerKey = projectionScoringProfileKey(splitKickerProfile);
  const railPositions = ["QB", "RB", "WR", "TE", "K"] as const;
  /**
   * These cells stamp the ARTIFACT's whole key, which byte-equals the champion policy's evidence
   * identity and so holds the live gate's identity comparison on its fast path. That keeps the
   * unit under test — the per-position scoring-identity gate and the cell/reason arithmetic
   * layered on it — observable in isolation.
   *
   * It stopped being the only workable shape on 2026-07-29, when the live gate's evidence-identity
   * comparison became position-scoped (`evidenceIdentitiesMatchForPosition`,
   * `packages/projections/src/rest-of-season.ts`): `buildFirstPartyRosLeagueTarget` stamps live
   * evidence with the LEAGUE's whole-profile key, and cells stamped that way now release for every
   * position whose scoped keys agree. The production shape is exercised below by "publishes a
   * partially matched league's matched positions in the production evidence shape".
   */
  const evidence = [liveEvidenceFor({ scoringProfileKey: artifactKey })];
  const convergence = {
    state: "converged" as const,
    lowerScenarioCount: 12_288,
    referenceScenarioCount: 16_384,
    maxToleranceRatio: 0.4,
    diagnosticChecksum: "e".repeat(64),
  };

  function keyedArtifact(scoringProfileKey: string): LoadedFirstPartyRosChampionArtifact {
    return loadedArtifact(buildLivePolicy(scoringProfileKey), { scoringProfileKey });
  }

  it("publishes a partially matched league's matched positions in the production evidence shape", () => {
    // PRODUCTION SHAPE — formerly the recorded seam for docs/plans/ROS_AVAILABILITY_PLAN.md.
    // `buildFirstPartyRosLeagueTarget` derives both the target's `leagueScoringProfileKey` and
    // every live evidence row's `scoringProfileKey` from the same league profile, so a partially
    // matched league's whole-profile key differs from the artifact's by construction. The live
    // release gate's evidence-identity comparison is position-scoped as of 2026-07-29
    // (`evidenceIdentitiesMatchForPosition`, `packages/projections/src/rest-of-season.ts`): the
    // two keys recover to profiles whose WR-scoped keys are byte-equal — the fixtures differ only
    // in kicker brackets — so the WR cell releases, and the positions the per-position matcher
    // withholds stay withheld. This inverts the pin that recorded the whole-key gate refusing
    // every cell of this population.
    const decision = evaluateFirstPartyRosPublication({
      artifact: keyedArtifact(artifactKey),
      leagueScoringProfileKey: splitKickerKey,
      evidence: [liveEvidenceFor({ scoringProfileKey: splitKickerKey })],
      futureWindowComplete: true,
      gateOptions: releaseOptions,
      positionMatching: {
        leagueScoringProfile: splitKickerProfile,
        supportedPositions: [...railPositions],
      },
    });

    expect(decision.scoringProfileMatches).toBe(true);
    expect(decision.withheldPositions).toEqual([
      { position: "K", reason: "scoring-profile-position-mismatch" },
    ]);
    expect(decision.buckets[0]!.gate.reasons).not.toContain("evidence-identity-mismatch");
    expect(decision.buckets[0]).toMatchObject({
      position: "WR",
      state: "release",
      strategy: "contextual",
    });
    expect(decision.releasingBuckets).toHaveLength(1);
    expect(decision.canPublish).toBe(true);
    // A partial release is never authoritative on its own: the last good set stays.
    expect(decision.preservePriorGoodSet).toBe(true);
  });

  it("releases the positions whose scoped keys match and withholds only the rest", () => {
    const decision = evaluateFirstPartyRosPublication({
      artifact: keyedArtifact(artifactKey),
      leagueScoringProfileKey: splitKickerKey,
      evidence,
      futureWindowComplete: true,
      gateOptions: releaseOptions,
      positionMatching: {
        leagueScoringProfile: splitKickerProfile,
        supportedPositions: [...railPositions],
      },
    });

    // The whole-profile keys differ, so the pre-per-position gate would have withheld everything.
    expect(splitKickerKey).not.toBe(artifactKey);
    expect(decision.scoringProfileMatches).toBe(true);
    expect(decision.canPublish).toBe(true);
    expect(decision.withheldPositions).toEqual([
      { position: "K", reason: "scoring-profile-position-mismatch" },
    ]);
    expect(decision.reasons).toContain("ros_scoring_profile_position_withheld");
    expect(decision.reasons).not.toContain("ros_champion_artifact_scoring_profile_mismatch");
    // A partial release is never authoritative on its own: the last good set stays.
    expect(decision.preservePriorGoodSet).toBe(true);
  });

  it("withholds a position normalization does not support even when its scoped key matches", () => {
    const decision = evaluateFirstPartyRosPublication({
      artifact: keyedArtifact(artifactKey),
      leagueScoringProfileKey: artifactKey,
      evidence,
      futureWindowComplete: true,
      gateOptions: releaseOptions,
      positionMatching: {
        leagueScoringProfile: artifactProfile,
        supportedPositions: ["QB", "RB", "WR", "TE"],
      },
    });

    expect(decision.withheldPositions).toEqual([{ position: "K", reason: "position-unsupported" }]);
    expect(decision.canPublish).toBe(true);
    expect(decision.preservePriorGoodSet).toBe(true);
  });

  it("forces a cell to withhold when its position was not matched, keeping the gate intact", () => {
    const decision = evaluateFirstPartyRosPublication({
      artifact: keyedArtifact(artifactKey),
      leagueScoringProfileKey: artifactKey,
      evidence,
      futureWindowComplete: true,
      gateOptions: releaseOptions,
      positionMatching: {
        leagueScoringProfile: artifactProfile,
        supportedPositions: ["QB", "RB", "TE", "K"],
      },
    });

    expect(decision.scoringProfileMatches).toBe(true);
    expect(decision.buckets[0]).toMatchObject({ position: "WR", state: "withhold" });
    // The live gate decision itself is preserved unmodified for observability.
    expect(decision.buckets[0]!.gate.state).toBe("release");
    expect(decision.canPublish).toBe(false);
    expect(decision.preservePriorGoodSet).toBe(true);
  });

  it("withholds every position and reports the whole mismatch when none match", () => {
    const decision = evaluateFirstPartyRosPublication({
      artifact: keyedArtifact(artifactKey),
      leagueScoringProfileKey: splitKickerKey,
      evidence,
      futureWindowComplete: true,
      gateOptions: releaseOptions,
      positionMatching: {
        leagueScoringProfile: splitKickerProfile,
        supportedPositions: [],
      },
    });

    expect(decision.scoringProfileMatches).toBe(false);
    expect(decision.canPublish).toBe(false);
    expect(decision.reasons).toContain("ros_champion_artifact_scoring_profile_mismatch");
    expect(decision.withheldPositions.map((entry) => entry.position)).toEqual([...railPositions]);
    expect(
      decision.withheldPositions.every((entry) => entry.reason === "position-unsupported"),
    ).toBe(true);
    expect(decision.buckets).toHaveLength(0);
  });

  it("refuses every position when the artifact's stored scoring key is not canonical", () => {
    const decision = evaluateFirstPartyRosPublication({
      artifact: keyedArtifact("not-a-canonical-key"),
      leagueScoringProfileKey: artifactKey,
      evidence,
      futureWindowComplete: true,
      gateOptions: releaseOptions,
      positionMatching: {
        leagueScoringProfile: artifactProfile,
        supportedPositions: [...railPositions],
      },
    });

    expect(decision.artifactValid).toBe(true);
    expect(decision.scoringProfileMatches).toBe(false);
    expect(decision.canPublish).toBe(false);
    expect(
      decision.withheldPositions.every(
        (entry) => entry.reason === "artifact-scoring-profile-key-unreadable",
      ),
    ).toBe(true);
  });

  it("refuses every position when the league's own scoring profile is not scoreable", () => {
    // The league side of the comparison is inside the same protection as the artifact side: an
    // unscoreable profile from a caller withholds everything instead of throwing out of the job.
    const decision = evaluateFirstPartyRosPublication({
      artifact: keyedArtifact(artifactKey),
      leagueScoringProfileKey: artifactKey,
      evidence,
      futureWindowComplete: true,
      gateOptions: releaseOptions,
      positionMatching: {
        leagueScoringProfile: { id: "empty-league-profile", rules: [] },
        supportedPositions: [...railPositions],
      },
    });

    expect(decision.canPublish).toBe(false);
    expect(decision.scoringProfileMatches).toBe(false);
    expect(
      decision.withheldPositions.every(
        (entry) => entry.reason === "league-scoring-profile-invalid",
      ),
    ).toBe(true);
  });

  it("never reads two empty position subsets as a match", () => {
    // A league that prices nothing for a position has scoped key "[]", and so does an artifact
    // that prices nothing for it. Equal-but-empty is not evidence of identical scoring, so the
    // position is withheld even though the caller claimed normalization supports it.
    const kickerOnlyProfile: ProjectionScoringProfile = {
      id: "kicker-only",
      rules: [
        { statId: "field_goals_made_0_39", points: 3 },
        { statId: "field_goals_made_40_49", points: 4 },
        { statId: "field_goals_made_50_plus", points: 5 },
      ],
    };
    const decision = evaluateFirstPartyRosPublication({
      artifact: keyedArtifact(projectionScoringProfileKey(kickerOnlyProfile)),
      leagueScoringProfileKey: projectionScoringProfileKey(kickerOnlyProfile),
      evidence,
      futureWindowComplete: true,
      gateOptions: releaseOptions,
      positionMatching: {
        leagueScoringProfile: kickerOnlyProfile,
        supportedPositions: ["QB", "K"],
      },
    });

    expect(decision.withheldPositions).toEqual([
      { position: "QB", reason: "position-unsupported" },
      { position: "RB", reason: "position-unsupported" },
      { position: "WR", reason: "position-unsupported" },
      { position: "TE", reason: "position-unsupported" },
    ]);
  });

  it("states a reason when it withholds a cell for a position this rail does not model", () => {
    // The provider cannot produce D/ST evidence (candidates are filtered to matched rail
    // positions), but a hand-built target could. A forced withhold must never be silent.
    const decision = evaluateFirstPartyRosPublication({
      artifact: keyedArtifact(artifactKey),
      leagueScoringProfileKey: artifactKey,
      evidence: [liveEvidenceFor({ scoringProfileKey: artifactKey, position: "DST" })],
      futureWindowComplete: true,
      gateOptions: releaseOptions,
      positionMatching: {
        leagueScoringProfile: artifactProfile,
        supportedPositions: [...railPositions],
      },
    });

    expect(decision.buckets[0]).toMatchObject({
      position: "DST",
      state: "withhold",
      positionReason: "position-not-on-ros-rail",
    });
    const payload = buildFirstPartyRosRunPayload({
      artifact: keyedArtifact(artifactKey),
      decision,
      convergence,
      orchestrationVersion: "orchestration-v1",
    });
    // Every rail position matched here, so the D/ST cell is the only decision — and it carries its
    // gate's reasons plus the stated off-rail reason rather than withholding silently.
    expect(payload.metrics.cellDecisions).toEqual([
      {
        position: "DST",
        bucket: "five-to-eight",
        state: "withhold",
        reasons: [...decision.buckets[0]!.gate.reasons, "position-not-on-ros-rail"],
      },
    ]);
    expect(decision.buckets[0]!.gate.reasons.length).toBeGreaterThan(0);
  });

  it("keeps the whole-profile identity gate for a target that carries no position matching", () => {
    const decision = evaluateFirstPartyRosPublication({
      artifact: keyedArtifact(artifactKey),
      leagueScoringProfileKey: splitKickerKey,
      evidence,
      futureWindowComplete: true,
      gateOptions: releaseOptions,
    });

    expect(decision.scoringProfileMatches).toBe(false);
    expect(decision.withheldPositions).toEqual([]);
    expect(decision.reasons).toContain("ros_champion_artifact_scoring_profile_mismatch");
  });

  it("records every withheld position's cells so the status surface can render them", () => {
    const artifact = keyedArtifact(artifactKey);
    const decision = evaluateFirstPartyRosPublication({
      artifact,
      leagueScoringProfileKey: splitKickerKey,
      evidence,
      futureWindowComplete: true,
      gateOptions: releaseOptions,
      positionMatching: {
        leagueScoringProfile: splitKickerProfile,
        supportedPositions: [...railPositions],
      },
    });

    const payload = buildFirstPartyRosRunPayload({
      artifact,
      decision,
      convergence,
      orchestrationVersion: "orchestration-v1",
    });

    expect(payload.metrics.cellDecisions).toEqual([
      { position: "WR", bucket: "five-to-eight", state: "release", reasons: [] },
      {
        position: "K",
        bucket: "one-to-four",
        state: "withhold",
        reasons: ["scoring-profile-position-mismatch"],
      },
      {
        position: "K",
        bucket: "five-to-eight",
        state: "withhold",
        reasons: ["scoring-profile-position-mismatch"],
      },
      {
        position: "K",
        bucket: "nine-plus",
        state: "withhold",
        reasons: ["scoring-profile-position-mismatch"],
      },
    ]);
    expect(payload.metrics.preservePriorGoodSet).toBe(true);
  });
});

describe("first-party ROS run payload cell observability", () => {
  const convergence = {
    state: "converged" as const,
    lowerScenarioCount: 12_288,
    referenceScenarioCount: 16_384,
    maxToleranceRatio: 0.4,
    diagnosticChecksum: "e".repeat(64),
  };

  it("records every bucket decision, not only the releasing ones", () => {
    const policy = buildLivePolicy();
    const decision = evaluateFirstPartyRosPublication({
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

    const payload = buildFirstPartyRosRunPayload({
      artifact: loadedArtifact(policy),
      decision,
      convergence,
      orchestrationVersion: "orchestration-v1",
    });

    expect(payload.metrics.cellDecisions).toEqual([
      { position: "WR", bucket: "five-to-eight", state: "withhold", reasons: [] },
    ]);
    expect(payload.metrics.preservePriorGoodSet).toBe(true);
    // The pre-existing observability keys must keep working for anything already reading them.
    expect(payload.metrics.releasingBuckets).toBe(0);
    expect(payload.metrics.withheldReasons).toContain("ros_admitted_cell_blocker_withheld");
  });

  it("records a releasing cell with its gate reasons and no retained-set flag", () => {
    const policy = buildLivePolicy();
    const decision = evaluateFirstPartyRosPublication({
      artifact: loadedArtifact(policy),
      leagueScoringProfileKey: SCORING_KEY,
      evidence: [liveEvidence],
      futureWindowComplete: true,
      gateOptions: releaseOptions,
    });

    const payload = buildFirstPartyRosRunPayload({
      artifact: loadedArtifact(policy),
      decision,
      convergence,
      orchestrationVersion: "orchestration-v1",
    });

    expect(payload.metrics.cellDecisions).toEqual([
      { position: "WR", bucket: "five-to-eight", state: "release", reasons: [] },
    ]);
    expect(payload.metrics.preservePriorGoodSet).toBe(false);
  });
});

describe("selectFirstPartyRosArtifactForLeague", () => {
  const policy = buildLivePolicy();
  const artifactFor = (key: "full-ppr" | "half-ppr" | "standard", admittedAt: string) => ({
    ...loadedArtifact(policy),
    scoringProfileKey: rosScoringProfile(key).scoringProfileKey,
    admittedAt: new Date(admittedAt),
  });

  it("selects the artifact whose scoring profile matches exactly", () => {
    const selected = selectFirstPartyRosArtifactForLeague({
      artifacts: [
        artifactFor("full-ppr", "2026-07-23T00:00:00.000Z"),
        artifactFor("half-ppr", "2026-07-23T00:00:00.000Z"),
      ],
      leagueScoringProfileKey: rosScoringProfile("half-ppr").scoringProfileKey,
    });

    expect(selected?.scoringProfileKey).toBe(rosScoringProfile("half-ppr").scoringProfileKey);
  });

  it("never falls back to a similar profile", () => {
    const selected = selectFirstPartyRosArtifactForLeague({
      artifacts: [
        artifactFor("full-ppr", "2026-07-23T00:00:00.000Z"),
        artifactFor("half-ppr", "2026-07-23T00:00:00.000Z"),
      ],
      leagueScoringProfileKey: rosScoringProfile("standard").scoringProfileKey,
    });

    expect(selected).toBeNull();
  });

  it("returns null rather than guessing when nothing is admitted", () => {
    expect(
      selectFirstPartyRosArtifactForLeague({
        artifacts: [],
        leagueScoringProfileKey: rosScoringProfile("full-ppr").scoringProfileKey,
      }),
    ).toBeNull();
  });

  it("prefers the most recently admitted artifact within one profile", () => {
    const older = artifactFor("full-ppr", "2026-07-01T00:00:00.000Z");
    const newer = artifactFor("full-ppr", "2026-07-23T00:00:00.000Z");
    const selected = selectFirstPartyRosArtifactForLeague({
      artifacts: [older, newer],
      leagueScoringProfileKey: rosScoringProfile("full-ppr").scoringProfileKey,
    });

    expect(selected?.admittedAt?.toISOString()).toBe("2026-07-23T00:00:00.000Z");
  });
});

describe("selectFirstPartyRosArtifactForLeague position-scoped arbitration", () => {
  // With the live gate's evidence identity position-scoped, one league can match several admitted
  // artifacts on subsets of its positions. These tests pin the recorded WP0 Step 3 tie-break rule:
  // (1) whole-key equality wins outright, latest admittedAt among whole-key matches; (2) otherwise
  // most matched supported positions wins; (3) tie -> latest admittedAt; (4) tie ->
  // lexicographically greatest artifactChecksum.
  const policy = buildLivePolicy();
  const offenseRules = [
    { statId: "receptions", points: 1 },
    { statId: "receiving_yards", points: 0.1 },
    { statId: "receiving_touchdowns", points: 6 },
    { statId: "rushing_yards", points: 0.1 },
    { statId: "rushing_touchdowns", points: 6 },
  ] as const;
  const catalogKickerProfile: ProjectionScoringProfile = {
    id: "arbitration-catalog",
    rules: [...offenseRules, { statId: "field_goals_made_0_39", points: 3 }],
  };
  const splitKickerProfile: ProjectionScoringProfile = {
    id: "arbitration-split-fg",
    rules: [
      ...offenseRules,
      { statId: "field_goals_made_0_39", points: 3 },
      { statId: "field_goals_made_50_plus", points: 5 },
    ],
  };
  const railPositions = ["QB", "RB", "WR", "TE", "K"] as const;

  function admittedArtifact(
    profile: ProjectionScoringProfile,
    admittedAt?: string,
  ): LoadedFirstPartyRosChampionArtifact {
    const scoringProfileKey = projectionScoringProfileKey(profile);
    return {
      ...loadedArtifact(policy, { scoringProfileKey }),
      ...(admittedAt === undefined ? {} : { admittedAt: new Date(admittedAt) }),
    };
  }

  it("lets a whole-key match win outright over a newer, wider partial match", () => {
    const wholeKey = admittedArtifact(catalogKickerProfile, "2026-07-01T00:00:00.000Z");
    const newerPartial = admittedArtifact(splitKickerProfile, "2026-07-23T00:00:00.000Z");
    const selected = selectFirstPartyRosArtifactForLeague({
      artifacts: [newerPartial, wholeKey],
      leagueScoringProfileKey: wholeKey.scoringProfileKey,
      leagueScoringProfile: catalogKickerProfile,
      supportedPositions: [...railPositions],
    });

    expect(selected?.artifactChecksum).toBe(wholeKey.artifactChecksum);
  });

  it("never engages partial matching when the profile and supported positions are absent", () => {
    // Rule 1 is the only behavior without the optional inputs, which keeps the worker's per-key
    // artifact dedupe byte-identical: a partial match must never be selected implicitly.
    const partial = admittedArtifact(catalogKickerProfile, "2026-07-23T00:00:00.000Z");
    const selected = selectFirstPartyRosArtifactForLeague({
      artifacts: [partial],
      leagueScoringProfileKey: projectionScoringProfileKey(splitKickerProfile),
    });

    expect(selected).toBeNull();
  });

  it("sends a partially matched league to the artifact matching more supported positions", () => {
    // The league's own whole key matches neither artifact (it carries a D/ST rule no artifact
    // prices). The split-kicker artifact matches all five rail positions; the catalog-kicker one
    // matches four (K diverges). Coverage beats recency: the older, wider match wins.
    const leagueProfile: ProjectionScoringProfile = {
      id: "arbitration-league",
      rules: [...splitKickerProfile.rules, { statId: "defensive_sacks", points: 1 }],
    };
    const narrowerNewer = admittedArtifact(catalogKickerProfile, "2026-07-23T00:00:00.000Z");
    const widerOlder = admittedArtifact(splitKickerProfile, "2026-07-01T00:00:00.000Z");
    const selected = selectFirstPartyRosArtifactForLeague({
      artifacts: [narrowerNewer, widerOlder],
      leagueScoringProfileKey: projectionScoringProfileKey(leagueProfile),
      leagueScoringProfile: leagueProfile,
      supportedPositions: [...railPositions],
    });

    expect(selected?.artifactChecksum).toBe(widerOlder.artifactChecksum);
  });

  it("breaks a matched-position tie by recency, then by greatest artifact checksum", () => {
    // Both artifacts match the same four positions (K diverges from the league for both; the
    // D/ST rule on one of them is outside every rail position's vocabulary).
    const dstAugmentedProfile: ProjectionScoringProfile = {
      id: "arbitration-catalog-dst",
      rules: [...catalogKickerProfile.rules, { statId: "defensive_sacks", points: 1 }],
    };
    const leagueScoringProfileKey = projectionScoringProfileKey(splitKickerProfile);
    const older = admittedArtifact(catalogKickerProfile, "2026-07-01T00:00:00.000Z");
    const newer = admittedArtifact(dstAugmentedProfile, "2026-07-23T00:00:00.000Z");
    const byRecency = selectFirstPartyRosArtifactForLeague({
      artifacts: [older, newer],
      leagueScoringProfileKey,
      leagueScoringProfile: splitKickerProfile,
      supportedPositions: [...railPositions],
    });
    expect(byRecency?.artifactChecksum).toBe(newer.artifactChecksum);

    const tiedA = admittedArtifact(catalogKickerProfile, "2026-07-23T00:00:00.000Z");
    const tiedB = admittedArtifact(dstAugmentedProfile, "2026-07-23T00:00:00.000Z");
    const greatestChecksum = [tiedA.artifactChecksum, tiedB.artifactChecksum].sort().at(-1);
    for (const artifacts of [
      [tiedA, tiedB],
      [tiedB, tiedA],
    ]) {
      const byChecksum = selectFirstPartyRosArtifactForLeague({
        artifacts,
        leagueScoringProfileKey,
        leagueScoringProfile: splitKickerProfile,
        supportedPositions: [...railPositions],
      });
      expect(byChecksum?.artifactChecksum).toBe(greatestChecksum);
    }
  });

  it("selects nothing when no artifact matches any supported position", () => {
    const kickerOnlyLeague: ProjectionScoringProfile = {
      id: "arbitration-kicker-only",
      rules: [{ statId: "field_goals_made_50_plus", points: 5 }],
    };
    const selected = selectFirstPartyRosArtifactForLeague({
      artifacts: [admittedArtifact(catalogKickerProfile, "2026-07-23T00:00:00.000Z")],
      leagueScoringProfileKey: projectionScoringProfileKey(kickerOnlyLeague),
      leagueScoringProfile: kickerOnlyLeague,
      supportedPositions: ["K"],
    });

    expect(selected).toBeNull();
  });
});
