import { beforeAll, describe, expect, it } from "vitest";
import {
  buildFirstPartyRosPointQualificationSet,
  evaluateFirstPartyRosPointReleaseGate,
  extractFirstPartyRosPointConvergence,
  firstPartyRosPointArtifactIsConsistent,
  firstPartyRosPointEvidenceChecksum,
  firstPartyRosPointQualificationIsStructurallyValid,
  type FirstPartyRosPointConvergenceEvidence,
} from "./point-ros-release.js";
import {
  pointConvergenceFixture,
  pointLegacyConvergenceChecksumFixture,
  pointRosReleaseFixture,
} from "./point-ros-release.test-fixtures.js";
import {
  evaluateFirstPartyRosReleaseGate,
  type FirstPartyRosLiveReleaseEvidence,
} from "./rest-of-season.js";
import {
  deriveRosArtifactBlockers,
  deriveVerifiedPointRosArtifactBlockers,
  firstPartyRosReleaseArtifactChecksum,
} from "./ros-artifact-blockers.js";
import { projectionScoringProfileKey } from "./scoring.js";
import { projectionScoringRulesFromProfileKey } from "./scoring-position-keys.js";

let fixture: ReturnType<typeof pointRosReleaseFixture>;
beforeAll(() => {
  fixture = pointRosReleaseFixture();
});
function gate(
  live: FirstPartyRosLiveReleaseEvidence = fixture.live,
  qualification: unknown = fixture.qualifications.find(
    (q) => q.position === live.position && q.bucket === live.bucket,
  ),
) {
  return evaluateFirstPartyRosPointReleaseGate({
    meanPolicy: fixture.policy,
    live,
    admittedQualification: qualification,
    expectedForecastSeason: 2026,
  });
}

describe("independently evidenced point-only ROS release", () => {
  it("separates quantile instability from authenticated point convergence without changing tolerances", () => {
    const diagnostic = fixture.live.pointConvergence!.contextual;
    expect(diagnostic.state).toBe("unstable");
    const point = extractFirstPartyRosPointConvergence({
      position: "DST",
      scoringProfileKey: fixture.live.scoringProfileKey,
      diagnostic,
    });
    expect(point.state).toBe("converged");
    expect(point.metrics.map((m) => m.metric)).toEqual(["expectedGames", "meanPoints"]);
    expect(point.lowerScenarioCount).toBe(12_288);
    expect(point.referenceScenarioCount).toBe(16_384);
    expect(evaluateFirstPartyRosReleaseGate(fixture.policy, fixture.live).reasons).toContain(
      "convergence-gate-failed",
    );
    expect(gate()).toMatchObject({
      state: "release",
      intervalAvailable: false,
      intervalCalibration: "unavailable-point-only-v1",
      calibrationArtifactChecksum: null,
      reasons: [],
    });
  });
  it.each(["mean", "games"] as const)("withholds actual %s instability", (metric) => {
    const diagnostic = pointConvergenceFixture("DST", fixture.live.scoringProfileKey, metric);
    const live = {
      ...fixture.live,
      availability: {
        ...fixture.live.availability,
        contextualExpectedGames: metric === "games" ? 1.5 : 2,
        recencyExpectedGames: metric === "games" ? 1.5 : 2,
      },
      pointConvergence: { contextual: diagnostic, recency: diagnostic },
      convergence: {
        contextual: {
          state: diagnostic.state,
          diagnosticChecksum: pointLegacyConvergenceChecksumFixture(diagnostic),
        },
        recency: {
          state: diagnostic.state,
          diagnosticChecksum: pointLegacyConvergenceChecksumFixture(diagnostic),
        },
      },
    };
    expect(gate(live).reasons).toContain("point-convergence-gate-failed");
    expect(gate(live).state).toBe("withhold");
  });
  it("rejects a forged metric tolerance, incomplete metrics, or a falsely converged original diagnostic", () => {
    const original = fixture.live.pointConvergence!.contextual;
    for (const diagnostic of [
      { ...original, state: "converged" as const },
      { ...original, metrics: original.metrics.slice(0, 2) },
      {
        ...original,
        metrics: original.metrics.map((metric) =>
          metric.metric === "p85Points" ? { ...metric, allowedDifference: 100 } : metric,
        ),
      },
    ])
      expect(() =>
        extractFirstPartyRosPointConvergence({
          position: "DST",
          scoringProfileKey: fixture.live.scoringProfileKey,
          diagnostic,
        }),
      ).toThrow();
    const { pointConvergence, ...withoutFullDiagnostic } = fixture.live;
    expect(pointConvergence).toBeDefined();
    expect(gate(withoutFullDiagnostic).reasons).toContain("invalid-point-convergence-evidence");
    const unrelated = { ...original, seedHash: "f".repeat(64) };
    expect(
      gate({ ...fixture.live, pointConvergence: { contextual: unrelated, recency: unrelated } })
        .reasons,
    ).toContain("invalid-point-convergence-evidence");
  });
  it("preserves coverage, input identity, availability, and zero-games withholding", () => {
    for (const [live, expected] of [
      [
        { ...fixture.live, coverage: { contextual: 0.5, recency: 0.5 } },
        "input-coverage-below-threshold",
      ],
      [{ ...fixture.live, inputChecksum: "forged" }, "invalid-live-evidence"],
      [{ ...fixture.live, contextualModelVersion: "wrong" }, "evidence-identity-mismatch"],
      [
        {
          ...fixture.live,
          availability: { scheduledGames: 0, contextualExpectedGames: 0, recencyExpectedGames: 0 },
        },
        "no-expected-games",
      ],
    ] as const)
      expect(gate(live).reasons).toContain(expected);
    const changed = {
      ...fixture.policy,
      choices: fixture.policy.choices.map((choice) => ({ ...choice, samples: 1 })),
    };
    const decision = evaluateFirstPartyRosPointReleaseGate({
      meanPolicy: changed,
      live: fixture.live,
      admittedQualification: fixture.qualifications[0],
      expectedForecastSeason: 2026,
    });
    expect(decision.state).toBe("withhold");
    expect(decision.reasons).toContain("invalid-mean-selection-evidence");
  });
  it("preserves exact per-position scoring reuse while rejecting changes to this position", () => {
    const rules = projectionScoringRulesFromProfileKey(fixture.live.scoringProfileKey);
    const changedProfile = (statId: string) =>
      projectionScoringProfileKey({
        id: "point-position-matching",
        rules: rules.map((rule) =>
          rule.statId === statId ? { ...rule, points: rule.points + 1 } : rule,
        ),
      });
    const unrelated = changedProfile("receptions");
    expect(unrelated).not.toBe(fixture.live.scoringProfileKey);
    expect(gate({ ...fixture.live, scoringProfileKey: unrelated }).state).toBe("release");
    const changed = changedProfile("defensive_sacks");
    expect(changed).not.toBe(fixture.live.scoringProfileKey);
    expect(gate({ ...fixture.live, scoringProfileKey: changed }).reasons).toContain(
      "evidence-identity-mismatch",
    );
  });
  it("requires exact historical strata, permits only proved full-distribution bounds, and records actual mean failures", () => {
    const input = fixture.buildInput;
    expect(() =>
      buildFirstPartyRosPointQualificationSet({
        ...input,
        convergenceEvidence: input.convergenceEvidence.slice(1),
      }),
    ).toThrow(/missing/);
    expect(() =>
      buildFirstPartyRosPointQualificationSet({
        ...input,
        convergenceEvidence: [...input.convergenceEvidence, input.convergenceEvidence[0]!],
      }),
    ).toThrow(/unique/);
    const altered = input.convergenceEvidence.map(
      (row, index): FirstPartyRosPointConvergenceEvidence =>
        index === 0
          ? {
              ...row,
              kind: "full-distribution-converged",
              state: "converged",
              worstToleranceRatio: 1.001,
            }
          : row,
    );
    expect(() =>
      buildFirstPartyRosPointQualificationSet({ ...input, convergenceEvidence: altered }),
    ).toThrow(/bound/);
    const target = fixture.qualifications.find(
      (q) => q.position === "DST" && q.bucket === "one-to-four",
    )!;
    const failed = input.convergenceEvidence.map((row): FirstPartyRosPointConvergenceEvidence =>
      row.position === "DST" && row.bucket === "one-to-four"
        ? {
            kind: "full-diagnostic",
            season: row.season,
            position: row.position,
            bucket: row.bucket,
            strategy: row.strategy,
            diagnosticChecksum: row.diagnosticChecksum,
            diagnostic: pointConvergenceFixture("DST", fixture.live.scoringProfileKey, "mean"),
          }
        : row,
    );
    const receipts = buildFirstPartyRosPointQualificationSet({
      ...input,
      convergenceEvidence: failed,
    });
    const qualification = receipts.find(
      (q) => q.position === target.position && q.bucket === target.bucket,
    )!;
    expect(qualification.convergence.recency.rate).toBe(0);
    expect(gate(fixture.live, qualification).reasons).toContain("point-convergence-gate-failed");
  });
  it("binds all18 receipts to policy, source pins, profile and season and rejects unknown fields", () => {
    expect(fixture.qualifications).toHaveLength(18);
    expect(fixture.qualifications.every(firstPartyRosPointQualificationIsStructurallyValid)).toBe(
      true,
    );
    expect(firstPartyRosPointArtifactIsConsistent(fixture.artifact)).toBe(true);
    expect(
      firstPartyRosPointArtifactIsConsistent({
        ...fixture.artifact,
        releaseGate: { ...fixture.artifact.releaseGate, blockers: [null] },
      }),
    ).toBe(false);
    const q = fixture.qualifications[0]!;
    expect(firstPartyRosPointQualificationIsStructurallyValid({ ...q, unexpected: true })).toBe(
      false,
    );
    const { evidenceChecksum, ...payload } = q;
    expect(evidenceChecksum).toBe(firstPartyRosPointEvidenceChecksum(payload));
    const bad = {
      ...payload,
      support: { ...payload.support, samples: payload.support.samples + 1 },
    };
    const forged = { ...bad, evidenceChecksum: firstPartyRosPointEvidenceChecksum(bad) };
    expect(firstPartyRosPointQualificationIsStructurallyValid(forged)).toBe(true);
    const envelope = fixture.artifact.releaseGate.pointForecasts as Record<string, unknown>;
    expect(
      firstPartyRosPointArtifactIsConsistent({
        ...fixture.artifact,
        releaseGate: {
          ...fixture.artifact.releaseGate,
          pointForecasts: {
            ...envelope,
            qualifications: [forged, ...fixture.qualifications.slice(1)],
          },
        },
      }),
    ).toBe(false);
    expect(firstPartyRosPointArtifactIsConsistent({ ...fixture.artifact, season: 2027 })).toBe(
      false,
    );
    expect(
      firstPartyRosPointArtifactIsConsistent({
        ...fixture.artifact,
        sourceChecksums: fixture.artifact.sourceChecksums.slice(1),
      }),
    ).toBe(false);
    expect(
      firstPartyRosPointArtifactIsConsistent({
        ...fixture.artifact,
        releaseGate: {
          pointForecasts: {
            ...envelope,
            qualifications: [...fixture.qualifications.slice(1), fixture.qualifications[1]],
          },
        },
      }),
    ).toBe(false);
  });
  it("supersedes only exact interval/full-convergence diagnostics after complete artifact verification", () => {
    const interval = "calibration_DST_one-to-four_coverage_shortfall_above_maximum";
    const convergence = "calibration_DST_one-to-four_convergence_below_minimum";
    const mean = "champion_DST_one-to-four_mean_rmse_above_maximum";
    const mixed = `${interval},availability_bad`;
    const artifact = {
      ...fixture.artifact,
      releaseGate: {
        ...fixture.artifact.releaseGate,
        blockers: [interval, convergence, mean, mixed],
      },
    };
    const checksum = firstPartyRosReleaseArtifactChecksum(artifact);
    expect(
      deriveVerifiedPointRosArtifactBlockers({ ...artifact, artifactChecksum: checksum })
        ?.effectiveBlockers,
    ).toEqual([mean, mixed]);
    expect(
      deriveVerifiedPointRosArtifactBlockers({ ...artifact, artifactChecksum: "0".repeat(64) }),
    ).toBeNull();
    expect(
      deriveRosArtifactBlockers({
        policyVersion: artifact.policyVersion,
        releaseGate: artifact.releaseGate,
      }).effectiveBlockers,
    ).toEqual([interval, convergence, mean, mixed]);
  });
});
