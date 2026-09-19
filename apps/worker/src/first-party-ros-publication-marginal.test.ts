import { beforeAll, describe, expect, it } from "vitest";
import {
  FIRST_PARTY_ROS_MARGINAL_POLICY_VERSION,
  FIRST_PARTY_ROS_POLICY_VERSION,
  FIRST_PARTY_ROS_MODEL_VERSION,
  FIRST_PARTY_ROS_INTERVAL_CALIBRATION_VERSION,
  MARGINAL_INTERVAL_CALIBRATION_VERSION,
  ROS_MARGINAL_INTERVAL_QUALIFICATION_VERSION,
  buildRosMarginalIntervalQualificationSet,
  buildRosMarginalIntervalStoredCells,
  evaluateFirstPartyRosChampionPolicy,
  rosMarginalIntervalStorageIsValid,
  rosMarginalIntervalStorageMatchesQualifications,
  rosScoringProfile,
  validateMarginalRosTrainingCohort,
  type FirstPartyRosLiveReleaseEvidence,
  type FirstPartyRosPosition,
  type RosMarginalQualificationDataset,
} from "@laces-out/projections";
import { createHash } from "node:crypto";
import { rosMarginalIntervalQualificationFullFixtureInput } from "../../../packages/projections/src/ros-marginal-interval-test-fixtures.js";
import {
  buildFirstPartyRosPlayerPersistenceRow,
  buildFirstPartyRosRunPayload,
  calibrateFirstPartyRosReleasedPlayers,
  evaluateFirstPartyRosPublication,
  firstPartyRosChampionArtifactChecksum,
  firstPartyRosChampionArtifactIsValid,
  type FirstPartyRosMarginalArtifactIntervals,
  type FirstPartyRosReleasedPlayer,
  type LoadedFirstPartyRosChampionArtifact,
} from "./first-party-ros-publication.js";
import { HISTORICAL_ROS_CANDIDATE_PAIR_VERSION } from "./first-party-ros-backtest.js";

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const CELL = { position: "DST", bucket: "one-to-four" } as const;
const convergence = {
  state: "converged" as const,
  lowerScenarioCount: 12_288,
  referenceScenarioCount: 16_384,
  maxToleranceRatio: 0.4,
  diagnosticChecksum: digest("live-numerical-diagnostic"),
};

function seal(artifact: LoadedFirstPartyRosChampionArtifact): LoadedFirstPartyRosChampionArtifact {
  return { ...artifact, artifactChecksum: firstPartyRosChampionArtifactChecksum(artifact) };
}

function fixture(failedDst = false) {
  const input = rosMarginalIntervalQualificationFullFixtureInput();
  const amend = (dataset: RosMarginalQualificationDataset): RosMarginalQualificationDataset => {
    const heldOutSeasons = dataset.heldOutSeasons.map((year) => ({
      ...year,
      forecasts: year.forecasts.map((row) => {
        const games = row.evidence.availability.scheduledGames;
        const actualPoints =
          row.actualPoints +
          (failedDst && row.position === "DST" && row.asOfWeek >= 14 && row.forecastSeason === 2025
            ? 20 * games
            : 0);
        return {
          ...row,
          actualPoints,
          inputChecksum: digest(`${row.inputChecksum}:shifted-median:${failedDst}`),
          contextual: { ...row.contextual, meanPoints: actualPoints + 1, p50Points: 1.5 * games },
          recency: { ...row.recency, meanPoints: actualPoints + 1, p50Points: 1.5 * games },
        };
      }),
    }));
    return {
      ...dataset,
      source: {
        ...dataset.source,
        reportChecksum: digest(`${dataset.source.reportChecksum}:${failedDst}`),
        physicalCorpusChecksum: digest(`${dataset.source.physicalCorpusChecksum}:${failedDst}`),
      },
      heldOutSeasons,
      rowsChecksum: validateMarginalRosTrainingCohort(heldOutSeasons, heldOutSeasons).provenance
        .evaluationRowsChecksum,
    };
  };
  const candidate = amend(input.candidate);
  const qualifications = buildRosMarginalIntervalQualificationSet({
    ...input,
    candidate,
    previous: amend(input.previous),
  });
  const policy = evaluateFirstPartyRosChampionPolicy(
    candidate.heldOutSeasons,
    qualifications[0]!.meanSelectorOptions,
  ).livePolicy;
  const marginalIntervals: FirstPartyRosMarginalArtifactIntervals = {
    schemaVersion: 1,
    qualificationMethod: ROS_MARGINAL_INTERVAL_QUALIFICATION_VERSION,
    qualifications,
    cells: buildRosMarginalIntervalStoredCells({
      qualifications,
      releasedCells: qualifications
        .filter((receipt) => receipt.state === "qualified")
        .map((receipt) => receipt.cell),
    }),
  };
  const artifact = seal({
    season: 2026,
    scoringProfileKey: candidate.source.scoringProfileKey,
    modelVersion: FIRST_PARTY_ROS_MODEL_VERSION,
    policyVersion: FIRST_PARTY_ROS_MARGINAL_POLICY_VERSION,
    calibrationVersion: MARGINAL_INTERVAL_CALIBRATION_VERSION,
    evidenceThroughSeason: 2025,
    sourceChecksums: [{ key: "nflverse.schedules.2025", checksum: digest("source-schedule") }],
    policy,
    releaseGate: { state: "insufficient", blockers: [], marginalIntervals },
    artifactChecksum: "",
  });
  return { artifact, qualifications, marginalIntervals };
}

let base: ReturnType<typeof fixture>;
let partial: ReturnType<typeof fixture>;
beforeAll(() => {
  base = fixture();
  partial = fixture(true);
}, 60_000);

function live(
  artifact = base.artifact,
  position: FirstPartyRosPosition = "DST",
): FirstPartyRosLiveReleaseEvidence {
  return {
    ...artifact.policy.evidenceIdentity!,
    position,
    bucket: "one-to-four",
    inputChecksum: digest(`${position}:live-inputs`),
    coverage: { contextual: 1, recency: 1 },
    availability: { scheduledGames: 4, contextualExpectedGames: 4, recencyExpectedGames: 4 },
    convergence: {
      contextual: { state: "converged", diagnosticChecksum: digest(`${position}:contextual`) },
      recency: { state: "converged", diagnosticChecksum: digest(`${position}:recency`) },
    },
  };
}

function decide(artifact = base.artifact, evidence = [live(artifact)]) {
  return evaluateFirstPartyRosPublication({
    artifact,
    leagueScoringProfileKey: artifact.scoringProfileKey,
    evidence,
    futureWindowComplete: true,
  });
}

function rawPlayer(
  position: FirstPartyRosPosition = "DST",
  playerId = `${position}:LAR`,
): FirstPartyRosReleasedPlayer {
  return {
    playerId,
    bucket: "one-to-four",
    strategy: "availability-aware-recency",
    projection: {
      state: "projected",
      playerId,
      position,
      expectedGames: 4,
      scheduledGames: 4,
      meanPoints: 9.125,
      standardDeviation: 3,
      p15Points: 4,
      p50Points: 6,
      p85Points: 12,
      expectedComponents: { defensive_sacks: 4 },
      weekly: [15, 16, 17, 18].map((week) => ({
        week,
        scheduled: true,
        bye: false,
        availabilityProbability: 1,
      })),
      weeklyMeanSemantics: "unconditional-includes-zero-for-bye-or-unavailable",
      simulation: {
        availabilityLagOneCorrelation: 0,
        roleLagOneCorrelation: 0,
        boundedRoleSamples: 0,
      },
      provenance: {
        modelVersion: FIRST_PARTY_ROS_MODEL_VERSION,
        strategy: "availability-aware-recency",
        weeklyModelVersion: HISTORICAL_ROS_CANDIDATE_PAIR_VERSION,
        scoringProfileKey: base.artifact.scoringProfileKey,
        inputChecksum: digest(`${playerId}:raw-inputs`),
        seedHash: digest(`${playerId}:raw-seed`),
        randomGenerator: "xoshiro128**-sha256-128",
        scenarioCount: 12_288,
        season: 2026,
        asOfWeek: 14,
        asOfAt: "2026-12-15T12:00:00.000Z",
        windowStartWeek: 15,
        windowEndWeek: 18,
        intervalCalibration: "simulation-only",
      },
      diagnostics: [],
    },
  };
}

function payload(artifact = base.artifact, decision = decide(artifact)) {
  return buildFirstPartyRosRunPayload({
    artifact,
    decision,
    convergence,
    orchestrationVersion: "test-orchestration",
  });
}

describe("marginal admitted artifact boundary", () => {
  it("accepts complete 18-cell receipts with the unchanged v7 mean policy and stable JSONB ordering", () => {
    expect(base.qualifications).toHaveLength(18);
    expect(base.marginalIntervals.cells).toHaveLength(18);
    expect(base.artifact.policy.policyVersion).toBe(FIRST_PARTY_ROS_POLICY_VERSION);
    expect(firstPartyRosChampionArtifactIsValid(base.artifact)).toBe(true);
    const jsonb = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(jsonb)
        : value !== null && typeof value === "object"
          ? Object.fromEntries(
              Object.entries(value)
                .reverse()
                .map(([key, child]) => [key, jsonb(child)]),
            )
          : value;
    expect(
      firstPartyRosChampionArtifactIsValid(
        jsonb(base.artifact) as LoadedFirstPartyRosChampionArtifact,
      ),
    ).toBe(true);
  });

  it.each([
    [
      "missing full receipt",
      (value: FirstPartyRosMarginalArtifactIntervals) => ({
        ...value,
        qualifications: value.qualifications.slice(1),
      }),
    ],
    [
      "duplicate receipt",
      (value: FirstPartyRosMarginalArtifactIntervals) => ({
        ...value,
        qualifications: [value.qualifications[0], ...value.qualifications.slice(0, -1)],
      }),
    ],
    [
      "missing compact cell",
      (value: FirstPartyRosMarginalArtifactIntervals) => ({
        ...value,
        cells: value.cells.slice(1),
      }),
    ],
    [
      "unknown envelope field",
      (value: FirstPartyRosMarginalArtifactIntervals) => ({ ...value, admitsModel: true }),
    ],
    [
      "wrong qualification method",
      (value: FirstPartyRosMarginalArtifactIntervals) => ({
        ...value,
        qualificationMethod: "legacy",
      }),
    ],
    [
      "tampered fit",
      (value: FirstPartyRosMarginalArtifactIntervals) => ({
        ...value,
        qualifications: value.qualifications.map((q, index) =>
          index === 0
            ? {
                ...q,
                liveArtifact: {
                  ...q.liveArtifact,
                  fit: { ...q.liveArtifact.fit, corrections: [99, 99, 99] },
                },
              }
            : q,
        ),
      }),
    ],
    [
      "different common scope",
      (value: FirstPartyRosMarginalArtifactIntervals) => ({
        ...value,
        qualifications: value.qualifications.map((q, index) =>
          index === 0 ? { ...q, sourceScope: { ...q.sourceScope, requiredCells: [CELL] } } : q,
        ),
      }),
    ],
    [
      "wrong compact linkage",
      (value: FirstPartyRosMarginalArtifactIntervals) => ({
        ...value,
        cells: value.cells.map((cell, index) =>
          index === 0 ? { ...cell, qualificationChecksum: digest("forged") } : cell,
        ),
      }),
    ],
  ] as const)("rejects %s even after recomputing the outer artifact checksum", (_label, change) => {
    const artifact = seal({
      ...base.artifact,
      releaseGate: {
        ...base.artifact.releaseGate,
        marginalIntervals: change(base.marginalIntervals),
      },
    });
    expect(firstPartyRosChampionArtifactIsValid(artifact)).toBe(false);
    expect(decide(artifact)).toMatchObject({
      canPublish: false,
      preservePriorGoodSet: true,
      reasons: ["ros_champion_artifact_invalid"],
    });
  });

  it("rejects changed outer season, scoring, calibration, or mean choice", () => {
    const changes: Partial<LoadedFirstPartyRosChampionArtifact>[] = [
      { season: 2027 },
      { scoringProfileKey: rosScoringProfile("half-ppr").scoringProfileKey },
      { calibrationVersion: FIRST_PARTY_ROS_INTERVAL_CALIBRATION_VERSION },
      { policy: { ...base.artifact.policy, minimumSamples: 1 } },
      {
        policy: {
          ...base.artifact.policy,
          choices: base.artifact.policy.choices.map((choice, index) =>
            index === 0 ? { ...choice, recencyMae: choice.recencyMae + 0.01 } : choice,
          ),
        },
      },
    ];
    for (const change of changes)
      expect(firstPartyRosChampionArtifactIsValid(seal({ ...base.artifact, ...change }))).toBe(
        false,
      );
  });

  it("keeps failed receipts in the artifact but excludes them from interval-qualified cells", () => {
    expect(firstPartyRosChampionArtifactIsValid(partial.artifact)).toBe(true);
    expect(partial.qualifications).toHaveLength(18);
    expect(partial.marginalIntervals.cells).toHaveLength(17);
    const decision = decide(partial.artifact, [
      live(partial.artifact),
      live(partial.artifact, "WR"),
    ]);
    expect(decision).toMatchObject({ canPublish: true, preservePriorGoodSet: true });
    expect(decision.releasingBuckets.map((cell) => cell.position)).toEqual(["WR"]);
    expect(decision.buckets[0]!.gate.reasons).toContain("marginal-qualification-failed");
    const envelope = payload(partial.artifact, decision).calibration.rosIntervals;
    expect(envelope).toMatchObject({ releasedCells: [{ position: "WR", bucket: "one-to-four" }] });
    const wrong = seal({
      ...partial.artifact,
      releaseGate: {
        ...partial.artifact.releaseGate,
        marginalIntervals: { ...partial.marginalIntervals, cells: base.marginalIntervals.cells },
      },
    });
    expect(firstPartyRosChampionArtifactIsValid(wrong)).toBe(false);
  });
});

describe("marginal publication gates", () => {
  it.each([
    "artifact_unavailable",
    "walk_forward_unavailable",
    "walk_forward_seasons_below_minimum",
    "walk_forward_blocks_below_minimum",
    "walk_forward_samples_below_minimum",
    "coverage_shortfall_above_maximum",
  ])("replaces only the qualified cell's exact old interval reason %s", (suffix) => {
    const artifact = seal({
      ...base.artifact,
      releaseGate: {
        ...base.artifact.releaseGate,
        blockers: [`calibration_DST_one-to-four_${suffix}`],
      },
    });
    expect(decide(artifact)).toMatchObject({ canPublish: true, preservePriorGoodSet: false });
  });

  it.each([
    "calibration_DST_one-to-four_availability_mae_above_maximum",
    "calibration_DST_one-to-four_availability_bias_above_maximum",
    "calibration_DST_one-to-four_input_coverage_below_minimum",
    "calibration_DST_one-to-four_convergence_below_minimum",
    "calibration_DST_one-to-four_count_family_dispersion_out_of_bounds",
    "calibration_DST_one-to-four_coverage_shortfall_above_maximum+availability_mae_above_maximum",
    "calibration_DST_one-to-four_unknown_future_reason",
    "champion_DST_one-to-four_sparse-cell",
    "cell_DST_one-to-four_fewer-than-three-seasons",
    "portfolio_forecasts_below_minimum",
  ])("retains independent, mixed, unknown or global blocker %s", (blocker) => {
    const artifact = seal({
      ...base.artifact,
      releaseGate: { ...base.artifact.releaseGate, blockers: [blocker] },
    });
    expect(decide(artifact)).toMatchObject({ canPublish: false, preservePriorGoodSet: true });
    expect(decide(artifact).reasons).toContain("ros_admitted_cell_blocker_withheld");
  });

  it("retains fixed numerical/coverage gates despite caller legacy gate overrides", () => {
    const evidence = live();
    const result = evaluateFirstPartyRosPublication({
      artifact: base.artifact,
      leagueScoringProfileKey: base.artifact.scoringProfileKey,
      evidence: [
        {
          ...evidence,
          coverage: { contextual: 1, recency: 0.5 },
          convergence: {
            ...evidence.convergence,
            recency: { ...evidence.convergence.recency, state: "unstable" },
          },
        },
      ],
      futureWindowComplete: true,
      gateOptions: { minimumInputCoverage: 0, minimumHeldOutConvergenceRate: 0 },
    });
    expect(result.canPublish).toBe(false);
    expect(result.buckets[0]!.gate.reasons).toEqual(
      expect.arrayContaining(["input-coverage-below-threshold", "convergence-gate-failed"]),
    );
  });

  it("retains incomplete future-window and exact position-scoring checks", () => {
    const result = evaluateFirstPartyRosPublication({
      artifact: base.artifact,
      leagueScoringProfileKey: base.artifact.scoringProfileKey,
      evidence: [live()],
      futureWindowComplete: false,
    });
    expect(result.reasons).toContain("ros_future_window_incomplete");
    const profile = rosScoringProfile("full-ppr").profile;
    const mismatched = evaluateFirstPartyRosPublication({
      artifact: base.artifact,
      leagueScoringProfileKey: "different",
      evidence: [live()],
      futureWindowComplete: true,
      positionMatching: {
        leagueScoringProfile: {
          ...profile,
          rules: profile.rules.map((rule) =>
            rule.statId === "defensive_sacks" ? { ...rule, points: 0.5 } : rule,
          ),
        },
        supportedPositions: ["QB", "RB", "WR", "TE", "K", "DST"],
      },
    });
    expect(mismatched.canPublish).toBe(false);
    expect(mismatched.withheldPositions).toContainEqual({
      position: "DST",
      reason: "scoring-profile-position-mismatch",
    });
  });
});

describe("marginal publication calibration and persistence linkage", () => {
  it("corrects P15/P50/P85 without changing means, and binds every row to the actual artifact/run envelope", () => {
    const decision = decide();
    const players = [rawPlayer(), rawPlayer("DST", "DST:BUF")];
    const before = structuredClone(players);
    const corrected = calibrateFirstPartyRosReleasedPlayers({
      artifact: base.artifact,
      decision,
      players,
    });
    const run = payload(base.artifact, decision);
    expect(rosMarginalIntervalStorageIsValid(run.calibration.rosIntervals)).toBe(true);
    expect(
      rosMarginalIntervalStorageMatchesQualifications(run.calibration.rosIntervals, {
        qualifications: base.qualifications,
        championArtifactChecksum: base.artifact.artifactChecksum,
        releasedCells: [CELL],
      }),
    ).toBe(true);
    for (const player of corrected) {
      expect([
        player.projection.p15Points,
        player.projection.p50Points,
        player.projection.p85Points,
      ]).toEqual([8, 8, 8]);
      expect(player.projection.meanPoints).toBe(9.125);
      const row = buildFirstPartyRosPlayerPersistenceRow(player);
      expect(row.playerProjection).toMatchObject({
        meanPoints: "9.125",
        floorPoints: "8.000",
        ceilingPoints: "8.000",
      });
      expect(row.summary).toMatchObject({
        aggregateMeanPoints: "9.125",
        p50Points: "8.000",
        intervalCalibration: {
          schemaVersion: 1,
          ...CELL,
          strategy: "availability-aware-recency",
          releaseEvidenceChecksum: (run.calibration.rosIntervals as { evidenceChecksum: string })
            .evidenceChecksum,
        },
      });
      const q = base.qualifications.find(
        (receipt) => receipt.cell.position === "DST" && receipt.cell.bucket === "one-to-four",
      )!;
      expect(row.summary.intervalCalibration).toMatchObject({
        qualificationChecksum: q.qualificationChecksum,
        calibrationArtifactChecksum: q.liveArtifact.artifactChecksum,
      });
    }
    expect(run.configuration).toMatchObject({
      policyVersion: FIRST_PARTY_ROS_MARGINAL_POLICY_VERSION,
      calibrationVersion: MARGINAL_INTERVAL_CALIBRATION_VERSION,
      championArtifactChecksum: base.artifact.artifactChecksum,
    });
    expect(run.metrics.rosConvergence).toMatchObject({
      state: "converged",
      method: "live-bounded-ros-convergence-v1",
      maxToleranceRatio: 0.4,
    });
    expect(players).toEqual(before);
  });

  it("keeps actual current numerical failure severity and cannot overwrite fixed run identity through extras", () => {
    const run = buildFirstPartyRosRunPayload({
      artifact: base.artifact,
      decision: decide(),
      convergence: { ...convergence, state: "unstable", maxToleranceRatio: 3 },
      orchestrationVersion: "test",
      extraConfiguration: {
        championArtifactChecksum: "forged",
        policyVersion: "forged",
        releasingBuckets: [],
        leagueSeasonId: "league",
      },
    });
    expect(run.configuration.championArtifactChecksum).toBe(base.artifact.artifactChecksum);
    expect(run.configuration.policyVersion).toBe(FIRST_PARTY_ROS_MARGINAL_POLICY_VERSION);
    expect(run.configuration.releasingBuckets).toHaveLength(1);
    expect(run.configuration.leagueSeasonId).toBe("league");
    expect(run.metrics.rosConvergence).toMatchObject({ state: "unstable", maxToleranceRatio: 3 });
  });

  it("rejects a changed artifact or live evidence between decision and calibration/run assembly", () => {
    const decision = decide();
    const artifact = seal({
      ...base.artifact,
      sourceChecksums: [{ key: "changed-source", checksum: digest("changed-source") }],
    });
    expect(() =>
      calibrateFirstPartyRosReleasedPlayers({ artifact, decision, players: [rawPlayer()] }),
    ).toThrow("admitted artifact");
    expect(() => payload(artifact, decision)).toThrow("admitted artifact");
    const changed = structuredClone(decision);
    Object.assign(changed.releasingBuckets[0]!.liveEvidence!, {
      inputChecksum: digest("new-live-inputs"),
    });
    expect(() => payload(base.artifact, changed)).toThrow("gate no longer matches");
  });

  it("rejects forged duplicate/rebound releasing cells and double calibration", () => {
    const decision = decide();
    const duplicate = {
      ...decision,
      releasingBuckets: [...decision.releasingBuckets, ...decision.releasingBuckets],
    };
    expect(() => payload(base.artifact, duplicate)).toThrow();
    const calibrated = calibrateFirstPartyRosReleasedPlayers({
      artifact: base.artifact,
      decision,
      players: [rawPlayer()],
    });
    expect(() =>
      calibrateFirstPartyRosReleasedPlayers({
        artifact: base.artifact,
        decision,
        players: calibrated,
      }),
    ).toThrow("raw selected projection");
    expect(() =>
      calibrateFirstPartyRosReleasedPlayers({
        artifact: base.artifact,
        decision,
        players: [rawPlayer(), rawPlayer()],
      }),
    ).toThrow("raw selected projection");
  });

  it.each(["player", "season", "window", "schedule", "lineage", "strategy"])(
    "rejects a raw player with wrong %s binding",
    (field) => {
      const player = structuredClone(rawPlayer());
      if (field === "player") Object.assign(player, { playerId: "DST:BUF" });
      if (field === "season") Object.assign(player.projection.provenance, { season: 2025 });
      if (field === "window")
        Object.assign(player.projection.provenance, { windowStartWeek: 10, asOfWeek: 9 });
      if (field === "schedule") Object.assign(player.projection, { scheduledGames: 3 });
      if (field === "lineage")
        Object.assign(player.projection.provenance, { weeklyModelVersion: "wrong-model" });
      if (field === "strategy")
        Object.assign(player.projection.provenance, { strategy: "contextual" });
      expect(() =>
        calibrateFirstPartyRosReleasedPlayers({
          artifact: base.artifact,
          decision: decide(),
          players: [player],
        }),
      ).toThrow();
    },
  );

  it("rejects mismatched per-player persisted metadata", () => {
    const [player] = calibrateFirstPartyRosReleasedPlayers({
      artifact: base.artifact,
      decision: decide(),
      players: [rawPlayer()],
    });
    expect(() =>
      buildFirstPartyRosPlayerPersistenceRow({
        ...player!,
        intervalCalibration: { ...player!.intervalCalibration!, position: "K" },
      }),
    ).toThrow("metadata");
  });

  it("keeps legacy run schema/checksums and omits new per-player metadata", () => {
    const artifact = seal({
      ...base.artifact,
      policyVersion: FIRST_PARTY_ROS_POLICY_VERSION,
      calibrationVersion: FIRST_PARTY_ROS_INTERVAL_CALIBRATION_VERSION,
      releaseGate: { state: "release", blockers: [] },
    });
    const decision = decide(artifact);
    expect(decision.canPublish).toBe(true);
    expect(decision).not.toHaveProperty("championArtifactChecksum");
    expect(decision.buckets[0]).not.toHaveProperty("liveEvidence");
    const corrected = calibrateFirstPartyRosReleasedPlayers({
      artifact,
      decision,
      players: [rawPlayer()],
    });
    expect(corrected[0]!.projection.p50Points).toBe(6);
    expect(buildFirstPartyRosPlayerPersistenceRow(corrected[0]!).summary).not.toHaveProperty(
      "intervalCalibration",
    );
    const run = payload(artifact, decision);
    expect(run.calibration.rosIntervals).toMatchObject({
      schemaVersion: 1,
      method: FIRST_PARTY_ROS_INTERVAL_CALIBRATION_VERSION,
    });
    expect(run.configuration.policyVersion).toBe(FIRST_PARTY_ROS_POLICY_VERSION);
    expect(firstPartyRosChampionArtifactChecksum(artifact)).toBe(artifact.artifactChecksum);
  });
});
