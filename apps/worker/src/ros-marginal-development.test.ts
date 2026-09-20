import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { NFL_TEAMS } from "@laces-out/domain";
import { beforeAll, describe, expect, it } from "vitest";
import {
  FIRST_PARTY_ROS_MODEL_VERSION,
  rosProfileDefinitionFromKey,
  rosScoringProfile,
  type FirstPartyRosChampionPolicy,
  type FirstPartyRosHeldOutForecast,
} from "@laces-out/projections";
import {
  firstPartyRosAdmissionConstants,
  validateFirstPartyRosAdmission,
} from "./first-party-ros-admission.js";
import { firstPartyRosChampionPolicyChecksum } from "./first-party-ros-publication.js";
import {
  buildRosMarginalDevelopmentReport,
  ROS_MARGINAL_DEVELOPMENT_VERSION,
  ROS_MARGINAL_TRAINING_DEVELOPMENT_VERSION,
  ROS_MARGINAL_QUALIFIED_DEVELOPMENT_VERSION,
} from "./ros-marginal-development.js";

import {
  forecasts,
  reportFixture,
  hash,
  rowBucket,
  SCORING,
  TEAMS,
} from "./ros-marginal-development.test-fixtures.js";

type Fixture = ReturnType<typeof reportFixture>;
function trainingFixture(raw = forecasts(false, NFL_TEAMS)) {
  const report = reportFixture(false, raw);
  return {
    ...report,
    outcomeCorpusIdentity: hash(`${FIRST_PARTY_ROS_MODEL_VERSION}:full-defense-training-corpus`),
    report: { ...report.report, playersPerPosition: 32 },
  };
}

function trainingRequest(report: Fixture) {
  const intervalTrainingReportJson = JSON.stringify(report);
  return {
    intervalTrainingReportJson,
    intervalTrainingReportChecksum: hash(intervalTrainingReportJson),
  };
}

let candidate: Fixture;
let previous: Fixture;
let passed: ReturnType<typeof buildRosMarginalDevelopmentReport>;
let training: Fixture;

function request(nextCandidate = candidate, nextPrevious = previous) {
  const candidateReportJson = JSON.stringify(nextCandidate);
  const previousReportJson = JSON.stringify(nextPrevious);
  return {
    candidateReportJson,
    candidateReportChecksum: hash(candidateReportJson),
    previousReportJson,
    previousReportChecksum: hash(previousReportJson),
    forecastSeason: 2026,
    evaluationSeason: 2025,
    positions: ["DST"] as const,
  };
}
function build(nextCandidate = candidate, nextPrevious = previous) {
  return buildRosMarginalDevelopmentReport(request(nextCandidate, nextPrevious));
}
function changedCandidate(
  mutate: (row: FirstPartyRosHeldOutForecast, index: number) => FirstPartyRosHeldOutForecast,
) {
  return reportFixture(false, candidate.diagnostics.candidateForecasts.map(mutate));
}

beforeAll(() => {
  candidate = reportFixture(false);
  previous = reportFixture(true);
  passed = build();
  training = trainingFixture();
});

describe("pinned marginal ROS report development wrapper", () => {
  it.each([false, true])(
    "reconstructs shared qualification with separate training=%s",
    (useTraining) => {
      const pinned = { ...request(), ...(useTraining ? trainingRequest(training) : {}) };
      const baseline = useTraining ? buildRosMarginalDevelopmentReport(pinned) : passed;
      const protocol = hash("frozen test qualification protocol");
      const result = buildRosMarginalDevelopmentReport({
        ...pinned,
        qualificationProtocolChecksum: protocol,
      });
      expect(result).toMatchObject({
        schemaVersion: 3,
        version: ROS_MARGINAL_QUALIFIED_DEVELOPMENT_VERSION,
        canAuthorizeRelease: false,
        state: baseline.state,
      });
      expect(result.marginalDevelopment).toEqual(baseline.marginalDevelopment);
      expect(result.legacyEvaluation).toEqual(baseline.legacyEvaluation);
      if (!("qualification" in result)) throw new Error("missing qualification envelope");
      expect(result.qualification.developmentReportChecksum).toBe(
        hash(`${JSON.stringify(baseline, null, 2)}\n`),
      );
      expect(result.qualification.developmentEvidenceChecksum).toBe(baseline.evidenceChecksum);
      expect(result.qualification.cells).toHaveLength(3);
      for (const proof of result.qualification.cells) {
        const cell = baseline.marginalDevelopment.cells.find(
          (candidate) =>
            candidate.position === proof.cell.position && candidate.bucket === proof.cell.bucket,
        )!;
        expect(proof).toMatchObject({
          state: "qualified",
          canAuthorizeRelease: false,
          sourceScope: { protocolChecksum: protocol },
          requiredEvaluationSeasons: [2023, 2024, 2025],
          strategy: cell.strategy,
          evidence: cell.evidence,
          comparison: cell.comparison,
          liveArtifact: cell.intervalArtifact,
        });
        expect(proof.sourceScope.requiredCells).toHaveLength(3);
        expect(proof.sources.intervalTraining === null).toBe(!useTraining);
      }
      expect(
        validateFirstPartyRosAdmission({
          report: result,
          evidenceThroughSeason: 2025,
          constants: firstPartyRosAdmissionConstants(SCORING.profile),
        }).state,
      ).toBe("rejected");
    },
    15_000,
  );

  it("retains independent legacy blockers even when every interval qualification passes", () => {
    const changed = structuredClone(candidate);
    changed.report.state = "insufficient";
    changed.report.blockers = ["calibration_DST_nine-plus_convergence_below_minimum"];
    const result = buildRosMarginalDevelopmentReport({
      ...request(changed),
      qualificationProtocolChecksum: hash("protocol with independent convergence gates"),
    });
    expect(result.state).toBe("rejected-at-development-screen");
    expect(result.marginalDevelopment.reasons).toContain(
      "preserved-legacy:calibration_DST_nine-plus_convergence_below_minimum",
    );
    if (!("qualification" in result)) throw new Error("missing qualification envelope");
    expect(result.qualification.cells.every((cell) => cell.state === "qualified")).toBe(true);
    expect(result.canAuthorizeRelease).toBe(false);
  }, 15_000);

  it("rejects an invalid qualification protocol checksum before report reconstruction", () => {
    expect(() =>
      buildRosMarginalDevelopmentReport({
        ...request(),
        qualificationProtocolChecksum: "unknown",
      }),
    ).toThrow(/invalid provenance checksum/u);
  });

  it("keeps the v1 payload byte identity for the current provider definition without separate training", () => {
    // The explicit Yahoo PA definition changed the fixture's scoring identity. Frozen benchmark
    // support must leave this existing native report byte-for-byte unchanged.
    expect(passed.evidenceChecksum).toMatchInlineSnapshot(
      `"b23c92005ec55cd1580c1f193ff6eea1f5e788f19114679dc2defbbbef104930"`,
    );
    expect(passed.schemaVersion).toBe(1);
    expect(passed).not.toHaveProperty("intervalTraining");
    expect(passed.provenance).not.toHaveProperty("intervalTraining");
    expect(passed.marginalDevelopment.evaluation).not.toHaveProperty("intervalTraining");
  });

  it("evaluates the complete 544-row synthetic DST pair without creating an admissible report", () => {
    expect(candidate.diagnostics.candidateForecasts).toHaveLength(544);
    expect(candidate.report.convergenceAudit).toHaveLength(24);
    expect(candidate.report.diagnosedPairs).toBe(12);
    expect(passed).toMatchObject({
      version: ROS_MARGINAL_DEVELOPMENT_VERSION,
      validationMode: "marginal-interval-development-only",
      state: "development-screen-passed",
      noDatabaseWrites: true,
      canAuthorizeRelease: false,
      completePortfolio: false,
      forecastSeason: 2026,
      evaluationSeason: 2025,
      positions: ["DST"],
    });
    expect(passed).not.toHaveProperty("publicationPolicy");
    expect(passed).not.toHaveProperty("champion");
    expect(passed).not.toHaveProperty("report");
    expect(passed.evidenceChecksum).toMatch(/^[a-f0-9]{64}$/u);
    expect(passed.marginalDevelopment.reasons).toEqual([]);
    expect(passed.marginalDevelopment.cells).toHaveLength(3);
    expect(passed.marginalDevelopment.portfolio).toMatchObject({
      state: "passed",
      candidateWis: 0,
      scope: "chronological-selected-portfolio",
    });
    for (const cell of passed.marginalDevelopment.cells) {
      expect(cell.screen!.state).toBe("descriptive-screen-passed");
      expect(cell.comparison).toMatchObject({ state: "passed", candidateWis: 0 });
      expect(cell.evidence!.perSeason.map((row) => row.forecastSeason)).toEqual([2023, 2024, 2025]);
    }
    expect(passed.marginalDevelopment.evaluation.candidates).toHaveLength(1088);
    expect(passed.marginalDevelopment.evaluation.selected).toHaveLength(544);
    expect(passed.legacyEvaluation.candidateReport).toEqual(candidate.report);
    expect(passed.legacyEvaluation.previousReport).toEqual(previous.report);
    expect(
      validateFirstPartyRosAdmission({
        report: passed,
        evidenceThroughSeason: 2025,
        constants: firstPartyRosAdmissionConstants(SCORING.profile),
      }).state,
    ).toBe("rejected");
  });

  it("preserves input report bytes, complete v7 policy and original means through the wrapper", () => {
    const input = Object.freeze(request());
    const before = JSON.stringify(input);
    const result = buildRosMarginalDevelopmentReport(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(result.legacyEvaluation.candidatePolicy).toEqual(candidate.publicationPolicy);
    expect(result.legacyEvaluation.previousPolicy).toEqual(previous.publicationPolicy);
    expect(
      result.marginalDevelopment.evaluation.selected.map((row) => [
        row.strategy,
        row.predictedMean,
      ]),
    ).toEqual(candidate.diagnostics.selected.map((row) => [row.strategy, row.predictedMean]));
    expect(
      result.marginalDevelopment.evaluation.selected
        .filter((row) => row.forecastSeason > 2022)
        .every(
          (row) =>
            row.corrected!.p50Points === row.actualPoints &&
            row.predictedMean === row.actualPoints + 1,
        ),
    ).toBe(true);
    expect(result.evidenceChecksum).toBe(passed.evidenceChecksum);
  });

  it("accepts only the explicitly declared old DST:LA to new DST:LAR identity amendment", () => {
    expect(previous.diagnostics.candidateForecasts[0]!.playerId).toBe("DST:LA");
    expect(candidate.diagnostics.candidateForecasts[0]!.playerId).toBe("DST:LAR");
    expect(passed.identityAmendments).toEqual({ previousPlayerId: { "DST:LA": "DST:LAR" } });
    expect(() =>
      build(
        changedCandidate((row) =>
          row.playerId === "DST:LAR" ? { ...row, playerId: "DST:LA" } : row,
        ),
      ),
    ).toThrow(/legacy Rams identity/u);
    const collision = reportFixture(
      true,
      previous.diagnostics.candidateForecasts.map((row) =>
        row.playerId === "DST:BUF" ? { ...row, playerId: "DST:LAR" } : row,
      ),
    );
    expect(() => build(candidate, collision)).toThrow(/canonical identity collision/u);
  });

  it.each(["candidateReportChecksum", "previousReportChecksum"] as const)(
    "rejects a mismatched %s before evaluating the report",
    (field) => {
      expect(() =>
        buildRosMarginalDevelopmentReport({ ...request(), [field]: "0".repeat(64) }),
      ).toThrow(/pinned SHA256/u);
    },
  );

  it.each(["year", "cutoff", "player"] as const)(
    "rejects an omitted held-out %s even with new report hashes",
    (scope) => {
      const changed = structuredClone(candidate);
      changed.diagnostics.candidateForecasts = changed.diagnostics.candidateForecasts.filter(
        (row, index) =>
          scope === "year"
            ? row.forecastSeason !== 2022
            : scope === "cutoff"
              ? !(row.forecastSeason === 2022 && row.asOfWeek === 1)
              : index !== 0,
      );
      changed.report.forecasts = changed.diagnostics.candidateForecasts.length;
      expect(() => build(changed)).toThrow(/incomplete forecast count/u);
    },
  );

  it("requires all declared years, physical strata and two-strategy convergence support", () => {
    const year = structuredClone(candidate);
    year.report.seasons = [2023, 2024, 2025];
    expect(() => build(year)).toThrow(/frozen held-out seasons/u);
    const audit = structuredClone(candidate);
    audit.report.convergenceAudit.pop();
    expect(() => build(audit)).toThrow(/incomplete physical convergence audit/u);
    const pairs = structuredClone(candidate);
    pairs.report.diagnosedPairs = 11;
    expect(() => build(pairs)).toThrow(/incomplete physical convergence audit/u);
  });

  it("rejects changed earlier outcomes after all candidate mean/artifact proofs are rebuilt", () => {
    const changed = changedCandidate((row, index) =>
      index === 0 ? { ...row, actualPoints: row.actualPoints + 1 } : row,
    );
    expect(() => build(changed)).toThrow(/all-season outcome\/schedule mismatch/u);
  });

  it("rejects changed earlier schedules after both deterministic support and candidate proofs are rebuilt", () => {
    const changed = changedCandidate((row, index) =>
      index === 0
        ? {
            ...row,
            evidence: {
              ...row.evidence,
              availability: {
                scheduledGames: 16,
                actualGames: 16,
                contextualExpectedGames: 16,
                recencyExpectedGames: 16,
              },
            },
          }
        : row,
    );
    expect(() => build(changed)).toThrow(/all-season outcome\/schedule mismatch/u);
  });

  it.each(["model", "raw-method", "training-year"] as const)(
    "rejects changed %s lineage even when complete proofs are rebuilt",
    (field) => {
      const changed = changedCandidate((row) => ({
        ...row,
        ...(field === "model"
          ? {
              contextualModelVersion: `${FIRST_PARTY_ROS_MODEL_VERSION}:contextual:laces-weekly-components-v14`,
            }
          : field === "raw-method"
            ? { intervalMethodVersion: "simulation-p15-p85-v2" }
            : { trainedThroughSeason: row.forecastSeason - 2 }),
      }));
      expect(() => build(changed)).toThrow(/lineage\/chronology mismatch/u);
    },
  );

  it("rejects changed mean-selector thresholds instead of using a more permissive mean policy", () => {
    const changed = structuredClone(candidate);
    changed.publicationPolicy = { ...changed.publicationPolicy, minimumModelImprovement: 0 };
    changed.champion.publicationPolicyChecksum = firstPartyRosChampionPolicyChecksum(
      changed.publicationPolicy,
    );
    expect(() => build(changed)).toThrow(/mean-selector thresholds/u);
  });

  it("rejects differing source hashes, missing prior source seasons and shared physical corpus identities", () => {
    const source = structuredClone(candidate);
    source.sources[0]!.scheduleChecksum = hash("different 2019 schedule");
    expect(() => build(source)).toThrow(/source checksums differ/u);
    const missing = structuredClone(candidate);
    missing.sources.shift();
    expect(() => build(missing)).toThrow(/frozen source seasons/u);
    const corpus = { ...candidate, outcomeCorpusIdentity: previous.outcomeCorpusIdentity };
    expect(() => build(corpus)).toThrow(/cannot share one corpus identity/u);
  });

  it("rejects uncalibrated legacy comparison rows instead of accepting their raw endpoints", () => {
    const changed = structuredClone(previous);
    changed.diagnostics.selected = changed.diagnostics.selected.map((row) =>
      row.forecastSeason === 2025
        ? {
            ...row,
            intervalCalibration: "not-calibrated",
            calibrationArtifactChecksum: null,
            intervalCovered: null,
          }
        : row,
    );
    expect(() => build(candidate, changed)).toThrow(
      /chronological selected means\/ranges mismatch/u,
    );
  });

  it("rejects physical instability in an unselected candidate even when marginal scores pass", () => {
    const changed = changedCandidate((row) =>
      row.forecastSeason === 2022 && rowBucket(row) === "nine-plus"
        ? {
            ...row,
            evidence: {
              ...row.evidence,
              convergence: {
                ...row.evidence.convergence,
                contextual: { ...row.evidence.convergence.contextual, state: "unstable" },
              },
            },
          }
        : row,
    );
    const result = build(changed);
    expect(result.state).toBe("rejected-at-development-screen");
    expect(
      result.marginalDevelopment.evaluation.selected.every(
        (row) => row.strategy === "availability-aware-recency",
      ),
    ).toBe(true);
    expect(
      result.marginalDevelopment.cells.every((cell) => cell.comparison.state === "passed"),
    ).toBe(true);
    expect(result.marginalDevelopment.reasons).toContain(
      "physical-convergence:2022:DST:nine-plus:contextual",
    );
    expect(result.legacyEvaluation.physicalBlockers).toContain(
      "physical-convergence:2022:DST:nine-plus:contextual",
    );
  });

  it("preserves legacy blockers instead of allowing a better marginal score to erase them", () => {
    const blocker = "calibration_DST_nine-plus_interval_coverage_gate_failed";
    const changed = structuredClone(candidate);
    changed.report.state = "insufficient";
    changed.report.blockers = [blocker];
    const result = build(changed);
    expect(result.state).toBe("rejected-at-development-screen");
    expect(result.marginalDevelopment.reasons).toContain(`preserved-legacy:${blocker}`);
    expect(result.legacyEvaluation.preservedLegacyBlockers).toEqual([blocker]);
  });

  it("rejects failed marginal coverage across the same frozen outcomes even with complete source parity", () => {
    const shift = (row: FirstPartyRosHeldOutForecast) =>
      row.forecastSeason === 2025
        ? { ...row, actualPoints: 20 * row.evidence.availability.scheduledGames }
        : row;
    const result = build(
      reportFixture(false, candidate.diagnostics.candidateForecasts.map(shift)),
      reportFixture(true, previous.diagnostics.candidateForecasts.map(shift)),
    );
    expect(result.state).toBe("rejected-at-development-screen");
    expect(
      result.marginalDevelopment.cells.every((cell) => cell.screen!.state === "failed-screen"),
    ).toBe(true);
    expect(result.marginalDevelopment.reasons).toEqual(
      expect.arrayContaining([
        "DST:one-to-four:marginal-screen:failed-screen",
        "DST:five-to-eight:marginal-screen:failed-screen",
        "DST:nine-plus:marginal-screen:failed-screen",
      ]),
    );
  });

  it("uses final-live choices for cells and independently frozen chronological choices for the portfolio", () => {
    const switchCandidate = (row: FirstPartyRosHeldOutForecast) => {
      const games = row.evidence.availability.scheduledGames;
      return {
        ...row,
        contextual: {
          ...row.contextual,
          meanPoints: row.actualPoints + (row.forecastSeason === 2023 ? 10 : 8),
        },
        recency: {
          meanPoints: row.actualPoints + 10,
          p15Points: 0,
          p50Points: 2 * games,
          p85Points: 4 * games,
        },
      };
    };
    const previousFixed = (row: FirstPartyRosHeldOutForecast) => ({
      ...row,
      contextual: { ...row.contextual, meanPoints: row.actualPoints + 10 },
      recency: {
        meanPoints: row.actualPoints + 10,
        p15Points: -row.evidence.availability.scheduledGames,
        p50Points: row.actualPoints,
        p85Points: 5 * row.evidence.availability.scheduledGames,
      },
    });
    const result = build(
      reportFixture(false, candidate.diagnostics.candidateForecasts.map(switchCandidate)),
      reportFixture(true, previous.diagnostics.candidateForecasts.map(previousFixed)),
    );
    expect(result.state).toBe("development-screen-passed");
    expect(
      result.marginalDevelopment.cells.every(
        (cell) =>
          cell.strategy === "contextual" && cell.previousStrategy === "availability-aware-recency",
      ),
    ).toBe(true);
    expect(
      result.marginalDevelopment.evaluation.selected
        .filter((row) => row.forecastSeason === 2025)
        .every((row) => row.strategy === "availability-aware-recency"),
    ).toBe(true);
    for (const cell of result.marginalDevelopment.cells) {
      const portfolioCell = result.marginalDevelopment.portfolio.cells.find(
        (entry) => entry.bucket === cell.bucket,
      )!;
      expect(portfolioCell.benchmarkWis["same-physics-legacy"]!).toBeCloseTo(
        2 * cell.comparison.benchmarkWis["same-physics-legacy"]!,
        12,
      );
      expect(portfolioCell.benchmarkWis["previous-deployed"]!).toBeCloseTo(
        cell.comparison.benchmarkWis["previous-deployed"]!,
        12,
      );
      expect(cell.comparison.benchmarkWis["previous-deployed"]!).toBeCloseTo(
        3 * cell.comparison.benchmarkWis["same-physics-legacy"]!,
        12,
      );
    }
  });

  it("binds all 2,176 training rows while retaining the original 544-row means and audit", () => {
    const input = { ...request(), ...trainingRequest(training) };
    const result = buildRosMarginalDevelopmentReport(input);
    expect(result).toMatchObject({
      schemaVersion: 2,
      version: ROS_MARGINAL_TRAINING_DEVELOPMENT_VERSION,
      state: "development-screen-passed",
      canAuthorizeRelease: false,
      noDatabaseWrites: true,
      provenance: {
        intervalTraining: {
          reportChecksum: input.intervalTrainingReportChecksum,
          physicalCorpusChecksum: training.outcomeCorpusIdentity,
        },
      },
      legacyEvaluation: {
        candidatePolicy: candidate.publicationPolicy,
        intervalTraining: { interpretation: "diagnostic-only", fullReport: training },
      },
      marginalDevelopment: {
        evaluation: {
          intervalTraining: {
            evaluationForecasts: 544,
            trainingForecasts: 2176,
            additionalTrainingForecasts: 1632,
          },
        },
      },
    });
    expect(result.marginalDevelopment.evaluation.selected).toHaveLength(544);
    expect(result.marginalDevelopment.evaluation.intervalTraining!.evaluationRowsChecksum).toMatch(
      /^[a-f0-9]{64}$/u,
    );
    expect(result.marginalDevelopment.evaluation.intervalTraining!.trainingRowsChecksum).toMatch(
      /^[a-f0-9]{64}$/u,
    );
    expect(result.marginalDevelopment.evaluation.candidates).toHaveLength(1088);
    expect(result.marginalDevelopment.evaluation.legacyEvaluation).toEqual(
      passed.marginalDevelopment.evaluation.legacyEvaluation,
    );
    expect(
      result.marginalDevelopment.evaluation.selected.map((row) => [
        row.playerId,
        row.forecastSeason,
        row.asOfWeek,
        row.strategy,
        row.predictedMean,
      ]),
    ).toEqual(
      passed.marginalDevelopment.evaluation.selected.map((row) => [
        row.playerId,
        row.forecastSeason,
        row.asOfWeek,
        row.strategy,
        row.predictedMean,
      ]),
    );
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    expect(
      validateFirstPartyRosAdmission({
        report: result,
        evidenceThroughSeason: 2025,
        constants: firstPartyRosAdmissionConstants(SCORING.profile),
      }).state,
    ).toBe("rejected");
  });

  it("keeps broader-cohort mean choices and legacy CQR failures diagnostic only", () => {
    const broader = trainingFixture(
      training.diagnostics.candidateForecasts.map((row) =>
        TEAMS.includes(row.playerId.slice(4))
          ? row
          : {
              ...row,
              contextual: { ...row.contextual, meanPoints: row.actualPoints },
              recency: { ...row.recency, meanPoints: row.actualPoints + 100 },
            },
      ),
    );
    const blocker = "calibration_DST_nine-plus_interval_coverage_gate_failed";
    broader.report.blockers.push(blocker);
    broader.report.state = "insufficient";
    const result = buildRosMarginalDevelopmentReport({ ...request(), ...trainingRequest(broader) });
    expect(result.state).toBe("development-screen-passed");
    expect(result.marginalDevelopment.reasons).toEqual([]);
    expect(result.legacyEvaluation.intervalTraining!.fullReport).toEqual(broader);
    expect(
      broader.publicationPolicy.choices
        .filter((choice) => choice.position === "DST")
        .every((choice) => choice.strategy === "contextual"),
    ).toBe(true);
    expect(result.marginalDevelopment.evaluation.legacyEvaluation).toEqual(
      passed.marginalDevelopment.evaluation.legacyEvaluation,
    );
  });

  it.each(["json", "checksum"] as const)("rejects a partial training %s pin", (part) => {
    const pin = trainingRequest(training);
    expect(() =>
      buildRosMarginalDevelopmentReport({
        ...request(),
        ...(part === "json"
          ? { intervalTrainingReportJson: pin.intervalTrainingReportJson }
          : { intervalTrainingReportChecksum: pin.intervalTrainingReportChecksum }),
      }),
    ).toThrow(/supplied together/u);
  });

  it("rejects training bytes that do not match their independently pinned checksum", () => {
    expect(() =>
      buildRosMarginalDevelopmentReport({
        ...request(),
        ...trainingRequest(training),
        intervalTrainingReportChecksum: "0".repeat(64),
      }),
    ).toThrow(/pinned SHA256/u);
  });

  it.each([
    "missing-team",
    "count-metadata",
    "unknown-team",
    "position",
    "cutoff",
    "window",
  ] as const)("rejects an incomplete or wrong-scope training cohort: %s", (mutation) => {
    const changed = structuredClone(training);
    if (mutation === "missing-team") {
      changed.diagnostics.candidateForecasts.pop();
      changed.report.forecasts--;
    } else if (mutation === "count-metadata") changed.report.playersPerPosition = 8;
    else if (mutation === "unknown-team") {
      changed.diagnostics.candidateForecasts = changed.diagnostics.candidateForecasts.map((row) =>
        row.playerId === "DST:ARI" ? { ...row, playerId: "DST:UNKNOWN" } : row,
      );
    } else if (mutation === "position") changed.validationScope.positions = ["TE"];
    else if (mutation === "cutoff")
      changed.diagnostics.candidateForecasts[0] = {
        ...changed.diagnostics.candidateForecasts[0]!,
        asOfWeek: 0,
      };
    else
      changed.diagnostics.candidateForecasts[0] = {
        ...changed.diagnostics.candidateForecasts[0]!,
        windowEndWeek: 17,
      };
    expect(() =>
      buildRosMarginalDevelopmentReport({ ...request(), ...trainingRequest(changed) }),
    ).toThrow(
      /incomplete forecast count|locked release cohort|canonical defense|defense-only|scope\/window/u,
    );
  });

  it("keeps candidate and previous benchmark cohorts fixed at eight teams even with training", () => {
    expect(() =>
      buildRosMarginalDevelopmentReport({
        ...request(training, previous),
        ...trainingRequest(training),
      }),
    ).toThrow(/locked release cohort/u);
    const broaderPrevious = reportFixture(true, forecasts(true, NFL_TEAMS));
    broaderPrevious.report.playersPerPosition = 32;
    expect(() =>
      buildRosMarginalDevelopmentReport({
        ...request(candidate, broaderPrevious),
        ...trainingRequest(training),
      }),
    ).toThrow(/locked release cohort/u);
  });

  it.each(["source", "candidate-corpus", "previous-corpus", "season", "model"] as const)(
    "rejects a training provenance mismatch: %s",
    (mutation) => {
      const changed = structuredClone(training);
      if (mutation === "source")
        changed.sources[0]!.scheduleChecksum = hash("changed training schedule");
      else if (mutation === "candidate-corpus")
        changed.outcomeCorpusIdentity = candidate.outcomeCorpusIdentity;
      else if (mutation === "previous-corpus")
        changed.outcomeCorpusIdentity = previous.outcomeCorpusIdentity;
      else if (mutation === "season") changed.report.seasons[0] = 2021;
      else
        changed.publicationPolicy = {
          ...changed.publicationPolicy,
          modelVersion: "laces-ros-distribution-v12",
        } as unknown as FirstPartyRosChampionPolicy;
      expect(() =>
        buildRosMarginalDevelopmentReport({ ...request(), ...trainingRequest(changed) }),
      ).toThrow(
        /source checksums differ|distinct physical corpus|frozen held-out seasons|unrecognized/u,
      );
    },
  );

  it("rejects rescored training even when all its legacy proofs are rebuilt", () => {
    const scoring = rosProfileDefinitionFromKey(rosScoringProfile("half-ppr").scoringProfileKey);
    const changed = trainingFixture(
      training.diagnostics.candidateForecasts.map((row) => ({
        ...row,
        scoringProfileKey: scoring.scoringProfileKey,
      })),
    );
    changed.scoringProfile = { key: scoring.key, label: scoring.label, digest: scoring.digest };
    expect(() =>
      buildRosMarginalDevelopmentReport({ ...request(), ...trainingRequest(changed) }),
    ).toThrow(/model or scoring profile differs/u);
  });

  it.each(["target", "physical-mean", "input-checksum"] as const)(
    "rejects a mutated audit %s in training despite rebuilt legacy proofs",
    (mutation) => {
      const changed = trainingFixture(
        training.diagnostics.candidateForecasts.map((row) =>
          row.forecastSeason === 2022 && row.asOfWeek === 1 && row.playerId === "DST:LAR"
            ? {
                ...row,
                ...(mutation === "target"
                  ? { actualPoints: row.actualPoints + 1 }
                  : mutation === "physical-mean"
                    ? {
                        contextual: {
                          ...row.contextual,
                          meanPoints: row.contextual.meanPoints + 1,
                        },
                      }
                    : { inputChecksum: hash("mutated training audit input") }),
              }
            : row,
        ),
      );
      expect(() =>
        buildRosMarginalDevelopmentReport({ ...request(), ...trainingRequest(changed) }),
      ).toThrow(/preserve every original audit input and target/u);
    },
  );

  it("preserves every extra training convergence failure and original audit blocker", () => {
    const changed = trainingFixture(
      training.diagnostics.candidateForecasts.map((row) =>
        row.forecastSeason === 2022 && rowBucket(row) === "nine-plus"
          ? {
              ...row,
              evidence: {
                ...row.evidence,
                convergence: {
                  contextual: { ...row.evidence.convergence.contextual, state: "unstable" },
                  recency: { ...row.evidence.convergence.recency, state: "unstable" },
                },
              },
            }
          : row,
      ),
    );
    const trainingBlocker = "calibration_DST_nine-plus_convergence_below_minimum";
    changed.report.blockers = [
      trainingBlocker,
      "calibration_DST_nine-plus_interval_coverage_gate_failed",
    ];
    changed.report.state = "insufficient";
    const audit = structuredClone(candidate);
    const auditBlocker = "calibration_DST_five-to-eight_interval_coverage_gate_failed";
    audit.report.blockers = [auditBlocker];
    audit.report.state = "insufficient";
    const result = buildRosMarginalDevelopmentReport({
      ...request(audit),
      ...trainingRequest(changed),
    });
    expect(result.state).toBe("rejected-at-development-screen");
    expect(result.marginalDevelopment.reasons).toEqual([
      `preserved-legacy:${auditBlocker}`,
      "interval-training:physical-convergence:2022:DST:nine-plus:contextual",
      "interval-training:physical-convergence:2022:DST:nine-plus:availability-aware-recency",
      `interval-training:preserved-legacy:${trainingBlocker}`,
    ]);
    expect(result.legacyEvaluation.intervalTraining!.fullReport).toEqual(changed);
    expect(result.marginalDevelopment.evaluation.intervalTraining!.diagnostics).toMatchObject({
      contextual: { unstableForecasts: 288 },
      recency: { unstableForecasts: 288 },
    });
  });

  it("round-trips pinned training through the CLI, preserving default v1 output and exclusive writes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ros-marginal-training-"));
    const execute = promisify(execFile);
    try {
      const pinned = { ...request(), ...trainingRequest(training) };
      await Promise.all([
        writeFile(join(directory, "candidate.json"), pinned.candidateReportJson),
        writeFile(join(directory, "previous.json"), pinned.previousReportJson),
        writeFile(join(directory, "training.json"), pinned.intervalTrainingReportJson),
      ]);
      const base = [
        "--import",
        "tsx",
        "apps/worker/scripts/evaluate-marginal-ros.ts",
        `--candidate-report=${join(directory, "candidate.json")}`,
        `--candidate-sha256=${pinned.candidateReportChecksum}`,
        `--previous-report=${join(directory, "previous.json")}`,
        `--previous-sha256=${pinned.previousReportChecksum}`,
        "--forecast-season=2026",
        "--evaluation-season=2025",
        "--positions=DST",
      ];
      const extra = [
        `--interval-training-report=${join(directory, "training.json")}`,
        `--interval-training-sha256=${pinned.intervalTrainingReportChecksum}`,
      ];
      for (const option of extra) {
        await expect(
          execute(process.execPath, [...base, option, `--out=${join(directory, "partial.json")}`]),
        ).rejects.toThrow(/supplied together/u);
      }
      const output = join(directory, "v2.json");
      await execute(process.execPath, [...base, ...extra, `--out=${output}`]);
      const serialized = await readFile(output, "utf8");
      expect(JSON.parse(serialized)).toEqual(buildRosMarginalDevelopmentReport(pinned));
      await expect(
        execute(process.execPath, [...base, ...extra, `--out=${output}`]),
      ).rejects.toThrow(/EEXIST/u);
      expect(await readFile(output, "utf8")).toBe(serialized);
      const defaultOutput = join(directory, "v1.json");
      await execute(process.execPath, [...base, `--out=${defaultOutput}`]);
      expect(await readFile(defaultOutput, "utf8")).toBe(`${JSON.stringify(passed, null, 2)}\n`);
      const protocol = "Frozen qualification CLI protocol.\n";
      const protocolPath = join(directory, "protocol.md");
      await writeFile(protocolPath, protocol);
      const protocolArgs = [
        `--qualification-protocol=${protocolPath}`,
        `--qualification-protocol-sha256=${hash(protocol)}`,
      ];
      for (const option of protocolArgs) {
        await expect(
          execute(process.execPath, [
            ...base,
            option,
            `--out=${join(directory, "partial-protocol.json")}`,
          ]),
        ).rejects.toThrow(/supplied together/u);
      }
      await expect(
        execute(process.execPath, [
          ...base,
          protocolArgs[0]!,
          `--qualification-protocol-sha256=${hash("different")}`,
          `--out=${join(directory, "bad-protocol.json")}`,
        ]),
      ).rejects.toThrow(/protocol bytes do not match/u);
      const qualifiedOutput = join(directory, "v3.json");
      await execute(process.execPath, [...base, ...protocolArgs, `--out=${qualifiedOutput}`]);
      const qualified = JSON.parse(await readFile(qualifiedOutput, "utf8")) as ReturnType<
        typeof buildRosMarginalDevelopmentReport
      >;
      expect(qualified.schemaVersion).toBe(3);
      if (!("qualification" in qualified)) throw new Error("missing CLI qualification envelope");
      expect(qualified.qualification.developmentReportChecksum).toBe(
        hash(await readFile(defaultOutput, "utf8")),
      );
      expect(qualified.qualification.cells).toHaveLength(3);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 45_000);
});
