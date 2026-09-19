import { beforeAll, describe, expect, it } from "vitest";
import {
  FIRST_PARTY_ROS_MARGINAL_POLICY_VERSION,
  FIRST_PARTY_ROS_POLICY_VERSION,
  MARGINAL_INTERVAL_CALIBRATION_VERSION,
  rosScoringProfile,
  type FirstPartyRosHeldOutForecast,
  type FirstPartyRosLiveReleaseEvidence,
} from "@laces-out/projections";
import {
  firstPartyRosAdmissionConstants,
  validateFirstPartyRosAdmission,
} from "./first-party-ros-admission.js";
import {
  FIRST_PARTY_ROS_MARGINAL_ADMISSION_VERSION,
  prepareFirstPartyRosMarginalAdmission,
} from "./first-party-ros-marginal-admission.js";
import {
  evaluateFirstPartyRosPublication,
  firstPartyRosChampionArtifactChecksum,
  firstPartyRosChampionArtifactIsValid,
  type FirstPartyRosMarginalArtifactIntervals,
} from "./first-party-ros-publication.js";
import {
  reportFixture,
  hash,
  SCORING,
  rowBucket,
} from "./ros-marginal-development.test-fixtures.js";
import {
  buildRosMarginalDevelopmentReport,
  ROS_MARGINAL_COMPOSITE_TRAINING_VERSION,
} from "./ros-marginal-development.js";

import {
  MARGINAL_ADMISSION_POSITIONS as POSITIONS,
  fullReport,
  defenseTrainingReport,
  trainingRequest,
} from "./ros-marginal-admission.test-fixtures.js";
const PROTOCOL =
  "# Frozen full-portfolio marginal qualification\n\nUse all declared cells, years, fixed mean choices and four matched WIS benchmarks.\n";
const CONSTANTS = firstPartyRosAdmissionConstants(SCORING.profile);

type Report = ReturnType<typeof fullReport>;
let candidate: Report;
let previous: Report;
let training: ReturnType<typeof defenseTrainingReport>;
let passed: ReturnType<typeof prepareFirstPartyRosMarginalAdmission>;
function request(nextCandidate: unknown = candidate, nextPrevious: unknown = previous) {
  const candidateReportJson = JSON.stringify(nextCandidate);
  const previousReportJson = JSON.stringify(nextPrevious);
  return {
    candidateReportJson,
    candidateReportChecksum: hash(candidateReportJson),
    previousReportJson,
    previousReportChecksum: hash(previousReportJson),
    qualificationProtocolText: PROTOCOL,
    qualificationProtocolChecksum: hash(PROTOCOL),
    forecastSeason: 2026,
    scoringProfile: SCORING.profile,
  };
}
beforeAll(() => {
  candidate = fullReport(false);
  previous = fullReport(true);
  training = defenseTrainingReport();
  const pinned = request();
  const before = structuredClone(pinned);
  passed = prepareFirstPartyRosMarginalAdmission(pinned);
  expect(pinned).toEqual(before);
}, 60_000);

function expectAdmissible(result: ReturnType<typeof prepareFirstPartyRosMarginalAdmission>) {
  expect(result.state, JSON.stringify(result.state === "rejected" ? result.blockers : [])).toBe(
    "admissible",
  );
  if (result.state !== "admissible") throw new Error(result.blockers.join(", "));
  return result;
}

describe("pure full-scope marginal admission preparation", () => {
  it("reconstructs18 receipts from pinned raw reports, preserving the exact v7 mean policy", () => {
    const result = expectAdmissible(passed);
    expect(candidate.report.forecasts).toBe(3264);
    expect(candidate.report.convergenceAudit).toHaveLength(144);
    expect(candidate.report.diagnosedPairs).toBe(72);
    expect(result.payload).toMatchObject({
      season: 2026,
      policyVersion: FIRST_PARTY_ROS_MARGINAL_POLICY_VERSION,
      calibrationVersion: MARGINAL_INTERVAL_CALIBRATION_VERSION,
    });
    expect(result.payload.policy).toEqual(candidate.publicationPolicy);
    expect(result.payload.policy.policyVersion).toBe(FIRST_PARTY_ROS_POLICY_VERSION);
    expect(result.payload).not.toHaveProperty("canAuthorizeRelease");
    const intervals = result.payload.releaseGate
      .marginalIntervals as FirstPartyRosMarginalArtifactIntervals;
    expect(intervals.qualifications).toHaveLength(18);
    expect(intervals.cells).toHaveLength(18);
    expect(intervals.qualifications.every((receipt) => receipt.canAuthorizeRelease === false)).toBe(
      true,
    );
    expect(firstPartyRosChampionArtifactChecksum(result.payload)).toBe(result.artifactChecksum);
    expect(
      firstPartyRosChampionArtifactIsValid({
        ...result.payload,
        artifactChecksum: result.artifactChecksum,
      }),
    ).toBe(true);
  });

  it("records pinned protocol bytes, all8 source-audit fields and passed four-comparator evidence", () => {
    const result = expectAdmissible(passed);
    const proof = result.payload.releaseGate.marginalAdmission as Record<string, unknown>;
    expect(proof).toMatchObject({
      version: FIRST_PARTY_ROS_MARGINAL_ADMISSION_VERSION,
      protocolText: PROTOCOL,
      pins: {
        candidateReportChecksum: request().candidateReportChecksum,
        previousReportChecksum: request().previousReportChecksum,
        qualificationProtocolChecksum: hash(PROTOCOL),
      },
    });
    expect(proof.sourceAudit).toEqual(candidate.sources);
    expect(result.payload.sourceChecksums).toHaveLength(42);
    const sources = proof.sourceAudit as Report["sources"];
    expect(
      sources.every(
        (source) =>
          /^[a-f0-9]{64}$/u.test(source.playerWeeklyRawChecksum) &&
          /^[a-f0-9]{64}$/u.test(source.playerTouchdownPlayByPlayChecksum),
      ),
    ).toBe(true);
    const intervals = result.payload.releaseGate
      .marginalIntervals as FirstPartyRosMarginalArtifactIntervals;
    for (const receipt of intervals.qualifications)
      expect(receipt.sourceScope.sourceManifestChecksum).toBe(proof.sourceAuditChecksum);
    expect(proof.portfolio).toMatchObject({
      state: "passed",
      scope: "chronological-selected-portfolio",
      worseThan: [],
    });
    expect(
      Object.keys(
        (proof.portfolio as { benchmarkSources: Record<string, unknown> }).benchmarkSources,
      ).sort(),
    ).toEqual(["previous-deployed", "previous-raw", "same-physics-legacy", "same-physics-raw"]);
  });

  it.each([
    "candidateReportChecksum",
    "previousReportChecksum",
    "qualificationProtocolChecksum",
  ] as const)("rejects changed %s before reconstructing evidence", (field) => {
    const result = prepareFirstPartyRosMarginalAdmission({ ...request(), [field]: "0".repeat(64) });
    expect(result.state).toBe("rejected");
    expect(result.blockers.join(" ")).toContain("pin_mismatch");
  });

  it.each(["", "   ", "x".repeat(1024 * 1024 + 1)])(
    "requires bounded nonempty protocol bytes",
    (qualificationProtocolText) => {
      const result = prepareFirstPartyRosMarginalAdmission({
        ...request(),
        qualificationProtocolText,
        qualificationProtocolChecksum: hash(qualificationProtocolText),
      });
      expect(result.state).toBe("rejected");
      expect(result.blockers.join(" ")).toContain("protocol_pin_mismatch");
    },
  );

  it("does not normalize whitespace in pinned protocol text", () => {
    const result = prepareFirstPartyRosMarginalAdmission({
      ...request(),
      qualificationProtocolText: PROTOCOL.trimEnd(),
    });
    expect(result.state).toBe("rejected");
    expect(result.blockers.join(" ")).toContain("protocol_pin_mismatch");
  });

  it("requires the current season and exact requested scoring constants", () => {
    for (const forecastSeason of [NaN, 2025, 2027]) {
      expect(prepareFirstPartyRosMarginalAdmission({ ...request(), forecastSeason }).state).toBe(
        "rejected",
      );
    }
    const mismatch = prepareFirstPartyRosMarginalAdmission({
      ...request(),
      scoringProfile: rosScoringProfile("half-ppr").profile,
    });
    expect(mismatch.state).toBe("rejected");
    expect(mismatch.blockers).toContain("scoring_profile_mismatch");
  });

  it.each(["candidate", "previous"])(
    "rejects a defense-only %s report instead of composing unqualified positions",
    (side) => {
      const result =
        side === "candidate"
          ? prepareFirstPartyRosMarginalAdmission(request(reportFixture(false), previous))
          : prepareFirstPartyRosMarginalAdmission(request(candidate, reportFixture(true)));
      expect(result.state).toBe("rejected");
      expect(result.blockers.join(" ")).toContain(`${side}_scope_not_complete`);
    },
  );

  it("rejects partial or malformed separate training pins", () => {
    for (const extra of [
      { intervalTrainingReportJson: "{}" },
      { intervalTrainingReportChecksum: hash("{}") },
      { intervalTrainingReportJson: "{}", intervalTrainingReportChecksum: hash("{}") },
    ]) {
      const result = prepareFirstPartyRosMarginalAdmission({ ...request(), ...extra });
      expect(result.state).toBe("rejected");
      expect(result.blockers.join(" ")).toMatch(/pin_incomplete|reconstruction_failed/u);
    }
  });

  it("composes4896 pinned training rows for all18 cells without changing3264 audit means", () => {
    const pinned = { ...request(), ...trainingRequest(training) };
    const before = JSON.stringify(pinned);
    const result = expectAdmissible(prepareFirstPartyRosMarginalAdmission(pinned));
    expect(JSON.stringify(pinned)).toBe(before);
    expect(result.payload.policy).toEqual(candidate.publicationPolicy);
    const proof = result.payload.releaseGate.marginalAdmission as Record<string, unknown>;
    expect(proof.pins).toMatchObject({
      intervalTrainingReportChecksum: pinned.intervalTrainingReportChecksum,
    });
    const composition = proof.intervalTrainingComposition as {
      evaluation: { source: { reportChecksum: string }; forecasts: number };
      constituents: {
        source: { reportChecksum: string; physicalCorpusChecksum: string };
        forecasts: number;
      }[];
      trainingRowsChecksum: string;
    };
    expect(composition).toMatchObject({
      version: ROS_MARGINAL_COMPOSITE_TRAINING_VERSION,
      evaluation: { forecasts: 3264, source: { reportChecksum: pinned.candidateReportChecksum } },
      trainingForecasts: 4896,
      constituents: [
        {
          role: "unchanged-non-defense-audit",
          forecasts: 2720,
          source: { physicalCorpusChecksum: candidate.outcomeCorpusIdentity },
        },
        {
          role: "complete-defense-training",
          forecasts: 2176,
          source: {
            physicalCorpusChecksum: training.outcomeCorpusIdentity,
            reportChecksum: pinned.intervalTrainingReportChecksum,
          },
        },
      ],
    });
    const intervals = result.payload.releaseGate
      .marginalIntervals as FirstPartyRosMarginalArtifactIntervals;
    const originalIntervals = expectAdmissible(passed).payload.releaseGate
      .marginalIntervals as FirstPartyRosMarginalArtifactIntervals;
    expect(intervals.qualifications).toHaveLength(18);
    expect(
      new Set(
        intervals.qualifications.map((receipt) => JSON.stringify(receipt.sources.intervalTraining)),
      ).size,
    ).toBe(1);
    for (const receipt of intervals.qualifications) {
      expect(receipt.intervalTraining).toMatchObject({
        evaluationForecasts: 3264,
        trainingForecasts: 4896,
        additionalTrainingForecasts: 1632,
        trainingRowsChecksum: composition.trainingRowsChecksum,
      });
      expect(receipt.sources.intervalTraining!.source.physicalCorpusChecksum).not.toBe(
        candidate.outcomeCorpusIdentity,
      );
      expect(receipt.sources.intervalTraining!.source.physicalCorpusChecksum).not.toBe(
        training.outcomeCorpusIdentity,
      );
      if (receipt.cell.position !== "DST") {
        const original = originalIntervals.qualifications.find(
          (cell) =>
            cell.cell.position === receipt.cell.position &&
            cell.cell.bucket === receipt.cell.bucket,
        )!;
        expect(receipt.strategy).toBe(original.strategy);
        expect(receipt.evidence).toEqual(original.evidence);
        expect(receipt.liveArtifact).toEqual(original.liveArtifact);
      }
    }
    expect(
      firstPartyRosChampionArtifactIsValid({
        ...result.payload,
        artifactChecksum: result.artifactChecksum,
      }),
    ).toBe(true);
  }, 30_000);

  it.each(["missing-team", "changed-source", "same-corpus", "bad-pin"] as const)(
    "rejects full training composition with %s",
    (mutation) => {
      const changed = structuredClone(training);
      if (mutation === "missing-team") changed.diagnostics.candidateForecasts.pop();
      if (mutation === "changed-source")
        changed.sources[0]!.playerWeeklyRawChecksum = hash("changed raw source");
      if (mutation === "same-corpus")
        changed.outcomeCorpusIdentity = candidate.outcomeCorpusIdentity;
      const pinned = { ...request(), ...trainingRequest(changed) };
      if (mutation === "bad-pin") pinned.intervalTrainingReportChecksum = "0".repeat(64);
      const result = prepareFirstPartyRosMarginalAdmission(pinned);
      expect(result.state).toBe("rejected");
    },
    15_000,
  );

  it.each(["input", "target"] as const)(
    "rejects a changed original DST %s with rebuilt training proofs",
    (mutation) => {
      const changed = defenseTrainingReport(
        training.diagnostics.candidateForecasts.map((row) =>
          row.playerId === "DST:LAR" && row.forecastSeason === 2022 && row.asOfWeek === 1
            ? {
                ...row,
                ...(mutation === "input"
                  ? { inputChecksum: hash("changed audit input") }
                  : { actualPoints: row.actualPoints + 1 }),
              }
            : row,
        ),
      );
      const result = prepareFirstPartyRosMarginalAdmission({
        ...request(),
        ...trainingRequest(changed),
      });
      expect(result.state).toBe("rejected");
      expect(result.blockers.join(" ")).toContain("preserve every original audit input and target");
    },
    15_000,
  );

  it("retains separate training physical and original audit convergence blockers", () => {
    const changed = defenseTrainingReport(
      training.diagnostics.candidateForecasts.map((row) =>
        row.forecastSeason === 2022 && rowBucket(row) === "nine-plus"
          ? {
              ...row,
              evidence: {
                ...row.evidence,
                convergence: {
                  contextual: {
                    ...row.evidence.convergence.contextual,
                    state: "unstable" as const,
                  },
                  recency: { ...row.evidence.convergence.recency },
                },
              },
            }
          : row,
      ),
    );
    const audit = structuredClone(candidate);
    audit.report.blockers.push("calibration_QB_one-to-four_convergence_below_minimum");
    audit.report.state = "insufficient";
    changed.report.blockers.push("calibration_DST_nine-plus_convergence_below_minimum");
    changed.report.blockers.push("calibration_QB_five-to-eight_convergence_below_minimum");
    changed.report.state = "insufficient";
    const result = expectAdmissible(
      prepareFirstPartyRosMarginalAdmission({ ...request(audit), ...trainingRequest(changed) }),
    );
    expect(result.cellBlockers).toEqual(
      expect.arrayContaining([
        "calibration_QB_one-to-four_convergence_below_minimum",
        "calibration_DST_nine-plus_marginal_training_physical_convergence_2022_contextual",
        "calibration_DST_nine-plus_marginal_training_convergence_below_minimum",
      ]),
    );
    expect(result.cellBlockers).not.toContain(
      "calibration_QB_five-to-eight_marginal_training_convergence_below_minimum",
    );
    expect(result.payload.releaseGate.marginalAdmission).toMatchObject({
      intervalTrainingDiagnostics: {
        ignoredOutOfScopeLegacyConvergenceBlockers: [
          "calibration_QB_five-to-eight_convergence_below_minimum",
        ],
        rawLegacyConvergenceBlockers: [
          "calibration_DST_nine-plus_convergence_below_minimum",
          "calibration_QB_five-to-eight_convergence_below_minimum",
        ],
      },
    });
  }, 30_000);

  it.each([
    [
      "global blocker",
      { state: "insufficient", blockers: ["portfolio_forecasts_below_minimum"] },
      "report_global_blockers_present",
    ],
    ["undersized cohort", { forecasts: 2964 }, "release_validation_forecasts_below_minimum"],
    [
      "availability calibration",
      { availabilityCalibrationVersion: "forged" },
      "availability_calibration_mismatch",
    ],
    ["role calibration", { roleCalibrationVersion: "forged" }, "role_calibration_mismatch"],
    ["kicker calibration", { kickerCalibrationVersion: "forged" }, "kicker_calibration_mismatch"],
  ])("retains exact legacy rejection for %s", (_label, change, expected) => {
    const changed = {
      ...candidate,
      report: { ...candidate.report, ...(change as Record<string, unknown>) },
    };
    const legacy = validateFirstPartyRosAdmission({
      report: changed,
      evidenceThroughSeason: 2025,
      constants: CONSTANTS,
    });
    expect(legacy.state).toBe("rejected");
    const result = prepareFirstPartyRosMarginalAdmission(request(changed));
    expect(result).toEqual(legacy);
    expect(result.blockers).toContain(expected);
  });

  it("rejects forged mean-policy evidence and complete cohort omissions despite refreshed report pins", () => {
    const mean = structuredClone(candidate);
    Object.assign(mean.publicationPolicy.choices[0]!.meanSelectionEvidence, {
      contextualRmse: 999,
    });
    expect(prepareFirstPartyRosMarginalAdmission(request(mean)).state).toBe("rejected");
    const missing = structuredClone(candidate);
    missing.diagnostics.candidateForecasts.pop();
    missing.report.forecasts--;
    const result = prepareFirstPartyRosMarginalAdmission(request(missing));
    expect(result.state).toBe("rejected");
    expect(result.blockers.join(" ")).toContain("incomplete forecast count");
  });

  it.each([
    "playerWeeklyRawChecksum",
    "playerTouchdownPlayByPlayChecksum",
    "scheduleChecksum",
  ] as const)(
    "independently binds %s even though legacy source-list derivation omits raw/PBP",
    (field) => {
      const changed = structuredClone(candidate);
      changed.sources[0]![field] = hash("changed upstream source");
      const result = prepareFirstPartyRosMarginalAdmission(request(changed));
      expect(result.state).toBe("rejected");
      expect(result.blockers.join(" ")).toContain("source checksums differ");
    },
  );

  it("keeps numerical failure in an unselected strategy as a cell blocker while reconstructing passing intervals", () => {
    const raw = candidate.diagnostics.candidateForecasts.map((row) =>
      row.position === "WR" && row.forecastSeason === 2022 && rowBucket(row) === "nine-plus"
        ? {
            ...row,
            evidence: {
              ...row.evidence,
              convergence: {
                ...row.evidence.convergence,
                contextual: { ...row.evidence.convergence.contextual, state: "unstable" as const },
              },
            },
          }
        : row,
    );
    const changed = fullReport(false, raw);
    expect(changed.report.blockers).not.toContain(
      "calibration_WR_nine-plus_convergence_below_minimum",
    );
    const result = expectAdmissible(prepareFirstPartyRosMarginalAdmission(request(changed)));
    expect(result.cellBlockers).toContain(
      "calibration_WR_nine-plus_marginal_physical_convergence_2022_contextual",
    );
    const evidence: FirstPartyRosLiveReleaseEvidence = {
      ...result.payload.policy.evidenceIdentity!,
      position: "WR",
      bucket: "nine-plus",
      inputChecksum: hash("live-input"),
      coverage: { contextual: 1, recency: 1 },
      availability: { scheduledGames: 9, contextualExpectedGames: 9, recencyExpectedGames: 9 },
      convergence: {
        contextual: { state: "converged", diagnosticChecksum: hash("live-contextual") },
        recency: { state: "converged", diagnosticChecksum: hash("live-recency") },
      },
    };
    const decision = evaluateFirstPartyRosPublication({
      artifact: { ...result.payload, artifactChecksum: result.artifactChecksum },
      leagueScoringProfileKey: result.payload.scoringProfileKey,
      evidence: [evidence],
      futureWindowComplete: true,
    });
    expect(decision.buckets[0]!.gate.state).toBe("release");
    expect(decision).toMatchObject({ canPublish: false, preservePriorGoodSet: true });
  }, 30_000);

  it("retains original cell blockers instead of letting qualified intervals erase an independent constraint", () => {
    const blocker = "calibration_K_one-to-four_count_family_dispersion_out_of_bounds";
    const changed = {
      ...candidate,
      report: { ...candidate.report, state: "insufficient", blockers: [blocker] },
    };
    const result = expectAdmissible(prepareFirstPartyRosMarginalAdmission(request(changed)));
    expect(result.cellBlockers).toContain(blocker);
    expect(result.payload.releaseGate.blockers).toContain(blocker);
  }, 30_000);

  it("keeps an isolated failed marginal cell while the complete four-comparator portfolio still passes", () => {
    const change = (row: FirstPartyRosHeldOutForecast) => {
      if (row.position !== "WR" || row.forecastSeason !== 2025 || rowBucket(row) !== "one-to-four")
        return row;
      const actualPoints = row.actualPoints + 20 * row.evidence.availability.scheduledGames;
      return {
        ...row,
        actualPoints,
        contextual: { ...row.contextual, meanPoints: actualPoints + 1 },
        recency: { ...row.recency, meanPoints: actualPoints + 1 },
      };
    };
    const result = expectAdmissible(
      prepareFirstPartyRosMarginalAdmission(
        request(
          fullReport(false, candidate.diagnostics.candidateForecasts.map(change)),
          fullReport(true, previous.diagnostics.candidateForecasts.map(change)),
        ),
      ),
    );
    expect(result.cellBlockers).toContain(
      "calibration_WR_one-to-four_marginal_interval_qualification_failed",
    );
    const intervals = result.payload.releaseGate
      .marginalIntervals as FirstPartyRosMarginalArtifactIntervals;
    expect(intervals.qualifications).toHaveLength(18);
    expect(intervals.cells).toHaveLength(17);
    expect(
      intervals.qualifications.find(
        (receipt) => receipt.cell.position === "WR" && receipt.cell.bucket === "one-to-four",
      )!.state,
    ).toBe("failed-qualification");
  }, 30_000);

  it("rejects a failing chronological four-comparator portfolio globally, regardless of supplied qualification claims", () => {
    const change = (row: FirstPartyRosHeldOutForecast) =>
      row.forecastSeason !== 2025
        ? row
        : { ...row, actualPoints: 20 * row.evidence.availability.scheduledGames };
    const next = fullReport(false, candidate.diagnostics.candidateForecasts.map(change));
    const old = fullReport(true, previous.diagnostics.candidateForecasts.map(change));
    const result = prepareFirstPartyRosMarginalAdmission({
      ...request(
        { ...next, qualification: { state: "qualified", canAuthorizeRelease: true } },
        old,
      ),
    });
    expect(result.state).toBe("rejected");
    expect(result.blockers).toContain("marginal_admission_portfolio_comparison_failed");
    expect(
      result.blockers.some((reason) => reason.includes("wis_worse_than_same-physics-raw")),
    ).toBe(true);
  }, 30_000);

  it("does not accept a development wrapper as an admission input and does not mutate inputs", () => {
    const pinned = request();
    const before = structuredClone(pinned);
    const wrapper = buildRosMarginalDevelopmentReport({
      ...pinned,
      evaluationSeason: 2025,
      positions: POSITIONS,
    });
    expect(prepareFirstPartyRosMarginalAdmission(request(wrapper)).state).toBe("rejected");
    expect(pinned).toEqual(before);
    expect(candidate).toEqual(fullReport(false));
  }, 30_000);
});
