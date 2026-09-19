import { beforeAll, describe, expect, it } from "vitest";
import { type FirstPartyRosHeldOutForecast } from "@laces-out/projections";
import { buildRosConditionalDevelopmentReport } from "./ros-conditional-development.js";
import { buildRosMarginalDevelopmentReport } from "./ros-marginal-development.js";
import {
  firstPartyRosAdmissionConstants,
  validateFirstPartyRosAdmission,
} from "./first-party-ros-admission.js";
import {
  fullReport,
  fullForecasts,
  defenseTrainingReport,
  trainingRequest,
} from "./ros-marginal-admission.test-fixtures.js";
import {
  forecasts,
  reportFixture,
  hash,
  rowBucket,
  SCORING,
} from "./ros-marginal-development.test-fixtures.js";

const PROTOCOL =
  "# Frozen synthetic conditional development protocol\nAll eighteen cells and all original years; no tuning or publication.\n";
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
type Fixture = ReturnType<typeof fullReport>;
let candidate: Fixture, previous: Fixture;
let result: ReturnType<typeof buildRosConditionalDevelopmentReport>;
function request(current: unknown = candidate, old: unknown = previous) {
  const candidateReportJson = JSON.stringify(current),
    previousReportJson = JSON.stringify(old);
  return {
    candidateReportJson,
    candidateReportChecksum: hash(candidateReportJson),
    previousReportJson,
    previousReportChecksum: hash(previousReportJson),
    protocolText: PROTOCOL,
    protocolChecksum: hash(PROTOCOL),
    sourceManifestChecksum: hash(canonical(candidate.sources)),
    scoringProfileKey: SCORING.scoringProfileKey,
  };
}
beforeAll(() => {
  candidate = fullReport(false);
  previous = fullReport(true);
  result = buildRosConditionalDevelopmentReport(request());
}, 60_000);

describe("pinned full-portfolio conditional development grading", () => {
  it("grades all3264 synthetic rows and eighteen cells with fixed prior chronology and four mandatory benchmarks", () => {
    expect(result).toMatchObject({
      state: "development-screen-passed",
      canAuthorizeRelease: false,
      noDatabaseWrites: true,
      completePortfolio: true,
      forecastSeason: 2026,
      evaluationSeason: 2025,
    });
    expect(result.conditionalDevelopment.evaluation.auditCoverage).toMatchObject({
      forecasts: 3264,
      candidateRows: 6528,
      selectedRows: 3264,
    });
    expect(result.conditionalDevelopment.cells).toHaveLength(18);
    for (const cell of result.conditionalDevelopment.cells) {
      expect(cell.strategies).toHaveLength(2);
      expect(cell.intervalPassed).toBe(true);
      expect(cell.comparison.state).toBe("available");
      for (const strategy of cell.strategies) {
        expect(strategy.evidence.complete).toBe(true);
        expect(strategy.evidence.measurement.perSeason.map((year) => year.forecastSeason)).toEqual([
          2023, 2024, 2025,
        ]);
        expect(strategy.liveFit.fit.priorSeasons).toEqual([2022, 2023, 2024, 2025]);
        expect(strategy.evidence.version).toBe("conditional-prior-fit-marginal-evidence-v1");
        expect(strategy.evidence.diagnostics.rawMeanSignedError).toBe(1);
        expect(strategy.evidence.diagnostics.correctedWidth).toBe(0);
        expect(
          strategy.evidence.perYear.every((year) => year.diagnostics.rawMeanSignedError === 1),
        ).toBe(true);
      }
    }
    const portfolio = result.conditionalDevelopment.portfolio;
    if (portfolio.state !== "available") throw new Error(portfolio.reason);
    expect(Object.keys(portfolio.comparison.benchmarkSources).sort()).toEqual([
      "previous-deployed",
      "previous-raw",
      "same-physics-legacy",
      "same-physics-raw",
    ]);
    expect(portfolio.comparison.cells).toHaveLength(18);
    expect(result.additionalUnconditionalComparator.latestChronologicalPortfolio.complete).toBe(
      true,
    );
    expect(
      result.additionalUnconditionalComparator.latestChronologicalPortfolio.conditionalWis,
    ).toBe(0);
    expect(
      result.additionalUnconditionalComparator.latestChronologicalPortfolio.unconditionalWis,
    ).toBe(0);
    const { evidenceChecksum, ...payload } = result;
    expect(evidenceChecksum).toBe(hash(canonical(payload)));
    expect(
      validateFirstPartyRosAdmission({
        report: result,
        evidenceThroughSeason: 2025,
        constants: firstPartyRosAdmissionConstants(SCORING.profile),
      }).state,
    ).toBe("rejected");
  });

  it("preserves the original v1 development report byte checksum after parser extraction", () => {
    const current = reportFixture(false),
      old = reportFixture(true);
    const candidateReportJson = JSON.stringify(current),
      previousReportJson = JSON.stringify(old);
    const legacy = buildRosMarginalDevelopmentReport({
      candidateReportJson,
      candidateReportChecksum: hash(candidateReportJson),
      previousReportJson,
      previousReportChecksum: hash(previousReportJson),
      forecastSeason: 2026,
      evaluationSeason: 2025,
      positions: ["DST"],
    });
    expect(legacy.evidenceChecksum).toBe(
      "819ba4c624278306d877c2637a6f339741fb073809891ff243dff6de8f09c92f",
    );
  });

  it("uses retrospective final-live choices for cells and independently frozen chronological choices for the portfolio", () => {
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
    const graded = buildRosConditionalDevelopmentReport(
      request(
        fullReport(false, fullForecasts(false).map(switchCandidate)),
        fullReport(true, fullForecasts(true).map(previousFixed)),
      ),
    );
    expect(graded.state).toBe("development-screen-passed");
    expect(graded.conditionalDevelopment.interpretation).toEqual({
      cells: "retrospective-final-live-2026-mean-choice-on-prior-fit-historical-intervals",
      portfolio: "chronological-2025-mean-choice-and-interval-fits",
      historicalIntervals: "each-evaluation-year-fitted-only-on-completed-prior-years",
    });
    expect(
      graded.conditionalDevelopment.cells.every(
        (cell) =>
          cell.strategy === "contextual" && cell.previousStrategy === "availability-aware-recency",
      ),
    ).toBe(true);
    const historical = graded.conditionalDevelopment.evaluation;
    expect(
      historical.selected
        .filter((row) => row.forecastSeason === 2025)
        .every((row) => row.strategy === "availability-aware-recency"),
    ).toBe(true);
    const fits2025 = historical.seasonFits.find((year) => year.forecastSeason === 2025)!;
    for (const row of historical.candidates.filter((entry) => entry.forecastSeason === 2025)) {
      const fit = fits2025.cells.find((cell) => cell.fit.checksum === row.fitChecksum)!;
      expect(fit.fit.priorSeasons).toEqual([2022, 2023, 2024]);
    }
    const portfolio = graded.conditionalDevelopment.portfolio;
    if (portfolio.state !== "available") throw new Error(portfolio.reason);
    for (const cell of graded.conditionalDevelopment.cells) {
      if (cell.comparison.state !== "available") throw new Error(cell.comparison.reason);
      const portfolioCell = portfolio.comparison.cells.find(
        (entry) => entry.position === cell.position && entry.bucket === cell.bucket,
      )!;
      expect(portfolioCell.benchmarkWis["same-physics-legacy"]!).toBeCloseTo(
        2 * cell.comparison.comparison.benchmarkWis["same-physics-legacy"]!,
        12,
      );
      expect(portfolioCell.benchmarkWis["previous-deployed"]!).toBeCloseTo(
        cell.comparison.comparison.benchmarkWis["previous-deployed"]!,
        12,
      );
      expect(cell.comparison.comparison.benchmarkWis["previous-deployed"]!).toBeCloseTo(
        3 * cell.comparison.comparison.benchmarkWis["same-physics-legacy"]!,
        12,
      );
    }
  }, 30_000);

  it("refuses partial/DST-only reports and every mismatched byte, protocol, source or scoring pin", () => {
    expect(() =>
      buildRosConditionalDevelopmentReport(request(reportFixture(false), reportFixture(true))),
    ).toThrow(/scope/u);
    for (const patch of [
      { candidateReportChecksum: "0".repeat(64) },
      { previousReportChecksum: "0".repeat(64) },
      { protocolChecksum: "0".repeat(64) },
      { protocolText: `${PROTOCOL}changed` },
      { sourceManifestChecksum: "0".repeat(64) },
      { scoringProfileKey: "[]" },
      { intervalTrainingReportChecksum: "0".repeat(64) },
    ])
      expect(() => buildRosConditionalDevelopmentReport({ ...request(), ...patch })).toThrow();
  }, 30_000);

  it("keeps exact-six CQR supersession separate from physical, unknown and mixed blockers", () => {
    const six = [
      "artifact_unavailable",
      "walk_forward_unavailable",
      "walk_forward_seasons_below_minimum",
      "walk_forward_blocks_below_minimum",
      "walk_forward_samples_below_minimum",
      "coverage_shortfall_above_maximum",
    ].map((suffix) => `calibration_WR_one-to-four_${suffix}`);
    const retained = [
      "calibration_WR_one-to-four_convergence_below_minimum",
      "calibration_WR_one-to-four_artifact_unavailable+convergence_below_minimum",
      "calibration_WR_one-to-four_unknown_new_gate",
      "unknown_global_gate",
    ];
    const changed = {
      ...candidate,
      report: { ...candidate.report, state: "insufficient", blockers: [...six, ...retained] },
    };
    const graded = buildRosConditionalDevelopmentReport(request(changed));
    expect(graded.state).toBe("rejected-at-development-screen");
    expect(graded.legacyDiagnostics.supersededIntervalDiagnostics).toEqual(six);
    expect(graded.legacyDiagnostics.effective).toEqual(retained);
    expect(graded.conditionalDevelopment.reasons).toContain("preserved-legacy:unknown_global_gate");
  }, 30_000);

  it("retains original physical failure in an unselected strategy even when interval gates pass", () => {
    const raw = fullForecasts(false).map((row): FirstPartyRosHeldOutForecast =>
      row.position === "WR" && row.forecastSeason === 2025 && rowBucket(row) === "one-to-four"
        ? {
            ...row,
            evidence: {
              ...row.evidence,
              convergence: {
                ...row.evidence.convergence,
                contextual: {
                  state: "unstable",
                  diagnosticChecksum: hash("retained physical failure"),
                },
              },
            },
          }
        : row,
    );
    const graded = buildRosConditionalDevelopmentReport(request(fullReport(false, raw)));
    expect(graded.state).toBe("rejected-at-development-screen");
    expect(graded.conditionalDevelopment.cells.every((cell) => cell.intervalPassed)).toBe(true);
    expect(graded.conditionalDevelopment.reasons).toContain(
      "physical-convergence:2025:WR:one-to-four:contextual",
    );
    expect(graded.conditionalDevelopment.physicalIssues).toHaveLength(32);
    expect(
      graded.conditionalDevelopment.evaluation.candidates.find(
        (row) => row.physicalIssues.length > 0,
      )!.physicalEvidence.convergence.contextual.state,
    ).toBe("unstable");
  }, 30_000);

  it("reconstructs omitted availability failures rather than trusting an empty reported blocker list", () => {
    const raw = fullForecasts(false).map((row) =>
      row.position !== "WR"
        ? row
        : {
            ...row,
            evidence: {
              ...row.evidence,
              availability: {
                ...row.evidence.availability,
                contextualExpectedGames: 0,
                recencyExpectedGames: 0,
              },
            },
          },
    );
    const current = fullReport(false, raw);
    const falsifiedSummary = {
      ...current,
      report: { ...current.report, blockers: [], state: "evidence-ready" },
    };
    const graded = buildRosConditionalDevelopmentReport(request(falsifiedSummary));
    expect(graded.state).toBe("rejected-at-development-screen");
    expect(graded.legacyDiagnostics.effective).toContain(
      "calibration_WR_nine-plus_availability_bias_above_maximum",
    );
  }, 30_000);

  it("retains partial input coverage diagnostics without tightening the existing aggregate gate", () => {
    const raw = fullForecasts(false).map((row) =>
      row.position !== "WR"
        ? row
        : { ...row, evidence: { ...row.evidence, coverage: { contextual: 0.99, recency: 0.99 } } },
    );
    const graded = buildRosConditionalDevelopmentReport(request(fullReport(false, raw)));
    expect(graded.state).toBe("development-screen-passed");
    expect(graded.conditionalDevelopment.physicalIssues.length).toBeGreaterThan(0);
    expect(graded.legacyDiagnostics.effective).toEqual([]);
  }, 30_000);

  it("rejects worse latest-year intervals and pooled tail misses without applying the2026 fit to2025", () => {
    const raw = fullForecasts(false).map((row) =>
      row.forecastSeason !== 2025
        ? row
        : {
            ...row,
            contextual: {
              ...row.contextual,
              p15Points: row.contextual.p15Points + 100,
              p50Points: row.contextual.p50Points + 100,
              p85Points: row.contextual.p85Points + 100,
            },
            recency: {
              ...row.recency,
              p15Points: row.recency.p15Points + 100,
              p50Points: row.recency.p50Points + 100,
              p85Points: row.recency.p85Points + 100,
            },
          },
    );
    const graded = buildRosConditionalDevelopmentReport(request(fullReport(false, raw)));
    expect(graded.state).toBe("rejected-at-development-screen");
    expect(
      graded.conditionalDevelopment.cells.some((cell) =>
        cell.strategies
          .find((strategy) => strategy.selectedForFinalLive)!
          .evidence.screen.reasons.includes("lower-tail-above-one-quarter"),
      ),
    ).toBe(true);
    expect(
      graded.conditionalDevelopment.reasons.some((reason) =>
        reason.includes("wis-worse-than-previous-deployed"),
      ),
    ).toBe(true);
    const original2025 = result.conditionalDevelopment.evaluation.seasonFits.find(
      (year) => year.forecastSeason === 2025,
    )!;
    expect(
      graded.conditionalDevelopment.evaluation.seasonFits.find(
        (year) => year.forecastSeason === 2025,
      ),
    ).toEqual(original2025);
    expect(graded.conditionalDevelopment.evaluation.liveFits).not.toEqual(
      result.conditionalDevelopment.evaluation.liveFits,
    );
  }, 30_000);

  it("reports unavailable fits and matched comparisons while retaining the entire required population", () => {
    const raw = fullForecasts(false).map((row) => ({
      ...row,
      contextual: {
        ...row.contextual,
        p15Points: row.contextual.p50Points,
        p85Points: row.contextual.p50Points,
      },
      recency: {
        ...row.recency,
        p15Points: row.recency.p50Points,
        p85Points: row.recency.p50Points,
      },
    }));
    const graded = buildRosConditionalDevelopmentReport(request(fullReport(false, raw)));
    expect(graded.state).toBe("rejected-at-development-screen");
    expect(graded.conditionalDevelopment.evaluation.auditCoverage).toMatchObject({
      forecasts: 3264,
      candidateRows: 6528,
      selectedRows: 3264,
      correctedCandidateRows: 0,
    });
    expect(
      graded.conditionalDevelopment.cells.every(
        (cell) =>
          cell.comparison.state === "unavailable" &&
          cell.strategies.every((strategy) => !strategy.evidence.complete),
      ),
    ).toBe(true);
    expect(graded.conditionalDevelopment.portfolio.state).toBe("unavailable");
    expect(
      graded.additionalUnconditionalComparator.evaluation.candidates.some(
        (row) => row.corrected !== null,
      ),
    ).toBe(true);
    expect(graded.legacyDiagnostics.supersededIntervalDiagnostics).toEqual([]);
  }, 30_000);

  it("binds the exact4896-row composition and keeps full-DST failures and non-DST placeholders distinct", () => {
    const training = defenseTrainingReport();
    const augmented = {
      ...training,
      report: {
        ...training.report,
        state: "insufficient",
        blockers: [
          "champion_QB_nine-plus_insufficient-global-evidence",
          "calibration_QB_one-to-four_convergence_below_minimum",
          "calibration_DST_one-to-four_artifact_unavailable",
          "calibration_DST_one-to-four_unknown_gate",
        ],
      },
    };
    const graded = buildRosConditionalDevelopmentReport({
      ...request(),
      ...trainingRequest(augmented),
    });
    expect(graded.provenance.intervalTrainingComposition?.trainingForecasts).toBe(4896);
    expect(graded.conditionalDevelopment.evaluation.auditCoverage.forecasts).toBe(3264);
    expect(graded.conditionalDevelopment.evaluation.cohort.trainingForecasts).toBe(4896);
    expect(graded.trainingDiagnostics?.nonAuditDiagnostics).toContain(
      "calibration_QB_one-to-four_convergence_below_minimum",
    );
    expect(graded.trainingDiagnostics?.effective).toContain(
      "calibration_DST_one-to-four_unknown_gate",
    );
    expect(graded.state).toBe("rejected-at-development-screen");
    expect(graded.conditionalDevelopment.evaluation.legacyEvaluation).toEqual(
      result.conditionalDevelopment.evaluation.legacyEvaluation,
    );
  }, 40_000);

  it("authenticates source manifests, original targets and retained model lineage before fitting", () => {
    const changedSources = {
      ...candidate,
      sources: candidate.sources.map((source, index) =>
        index !== 0 ? source : { ...source, scheduleChecksum: hash("different schedule") },
      ),
    };
    expect(() => buildRosConditionalDevelopmentReport(request(changedSources))).toThrow(
      /source checksums/u,
    );
    const changedOutcome = fullReport(
      true,
      fullForecasts(true).map((row, index) =>
        index !== 0 ? row : { ...row, actualPoints: row.actualPoints + 1 },
      ),
    );
    expect(() => buildRosConditionalDevelopmentReport(request(candidate, changedOutcome))).toThrow(
      /outcome\/schedule/u,
    );
    expect(() => buildRosConditionalDevelopmentReport(request(candidate, candidate))).toThrow(
      /legacy report/u,
    );
    expect(() =>
      buildRosConditionalDevelopmentReport({
        ...request(),
        ...trainingRequest(defenseTrainingReport(forecasts(false))),
      }),
    ).toThrow(/forecast count/u);
  }, 30_000);
});
