import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  FIRST_PARTY_ROS_MODEL_VERSION,
  evaluateFirstPartyRosChampionPolicy,
  rosProfileDefinitionFromKey,
  rosScoringProfile,
  type FirstPartyRosChampionOptions,
  type FirstPartyRosChampionPolicy,
  type FirstPartyRosHeldOutForecast,
  type FirstPartyRosRemainingWeeksBucket,
  type FirstPartyRosStrategy,
} from "@laces-out/projections";
import {
  firstPartyRosAdmissionConstants,
  validateFirstPartyRosAdmission,
} from "./first-party-ros-admission.js";
import { firstPartyRosChampionPolicyChecksum } from "./first-party-ros-publication.js";
import {
  buildRosMarginalDevelopmentReport,
  ROS_MARGINAL_DEVELOPMENT_VERSION,
} from "./ros-marginal-development.js";

const SEASONS = [2022, 2023, 2024, 2025];
const TEAMS = ["LAR", "BUF", "KC", "SF", "DAL", "BAL", "PIT", "MIA"];
const BUCKETS: readonly FirstPartyRosRemainingWeeksBucket[] = [
  "one-to-four",
  "five-to-eight",
  "nine-plus",
];
const STRATEGIES: readonly FirstPartyRosStrategy[] = ["contextual", "availability-aware-recency"];
const OPTIONS: FirstPartyRosChampionOptions = {
  minimumHeldOutSeasons: 3,
  minimumBatches: 30,
  minimumSamples: 300,
  minimumCellSeasons: 3,
  minimumCellSamples: 18,
  minimumCellCutoffs: 3,
  minimumCellBatches: 9,
  minimumModelImprovement: 0.01,
};
const SCORING = rosProfileDefinitionFromKey(rosScoringProfile("full-ppr").scoringProfileKey);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const rowBucket = (row: FirstPartyRosHeldOutForecast): FirstPartyRosRemainingWeeksBucket => {
  const weeks = row.windowEndWeek - row.windowStartWeek + 1;
  return weeks <= 4 ? "one-to-four" : weeks <= 8 ? "five-to-eight" : "nine-plus";
};

function forecasts(previous: boolean): FirstPartyRosHeldOutForecast[] {
  const model = previous ? "laces-ros-distribution-v12" : FIRST_PARTY_ROS_MODEL_VERSION;
  return SEASONS.flatMap((season) =>
    Array.from({ length: 17 }, (_, cutoffIndex) => cutoffIndex + 1).flatMap((cutoff) =>
      TEAMS.map((team): FirstPartyRosHeldOutForecast => {
        const games = 18 - cutoff;
        const playerId = `DST:${previous && team === "LAR" ? "LA" : team}`;
        const candidate = {
          meanPoints: 2 * games + 1,
          p15Points: games,
          p50Points: 2 * games,
          p85Points: 3 * games,
        };
        return {
          playerId,
          position: "DST",
          forecastSeason: season,
          asOfWeek: cutoff,
          windowStartWeek: cutoff + 1,
          windowEndWeek: 18,
          trainedThroughSeason: season - 1,
          inputChecksum: hash(`${model}:${season}:${cutoff}:${playerId}`),
          contextualModelVersion: `${model}:contextual:laces-weekly-components-v15`,
          recencyModelVersion: `${model}:availability-aware-recency:laces-weekly-components-v15`,
          scoringProfileKey: SCORING.scoringProfileKey,
          intervalMethodVersion: "simulation-p15-p50-p85-cqr-v1",
          evidence: {
            coverage: { contextual: 1, recency: 1 },
            availability: {
              scheduledGames: games,
              actualGames: games,
              contextualExpectedGames: games,
              recencyExpectedGames: games,
            },
            convergence: {
              contextual: {
                state: "converged",
                diagnosticChecksum: hash(`${model}:${season}:${cutoff}:${playerId}:contextual`),
              },
              recency: {
                state: "converged",
                diagnosticChecksum: hash(`${model}:${season}:${cutoff}:${playerId}:recency`),
              },
            },
          },
          contextual: { ...candidate },
          recency: { ...candidate },
          actualPoints: 2 * games,
        };
      }),
    ),
  );
}

interface ConvergenceFixture {
  season: number;
  position: "DST";
  bucket: FirstPartyRosRemainingWeeksBucket;
  strategy: FirstPartyRosStrategy;
  state: "converged" | "unstable";
  worstToleranceRatio: number;
}

/** Recompute every policy/identity/selection proof after raw mutations, as the actual CLI does. */
function reportFixture(previous: boolean, raw = forecasts(previous)) {
  const modelVersion = previous ? "laces-ros-distribution-v12" : FIRST_PARTY_ROS_MODEL_VERSION;
  const legacy = evaluateFirstPartyRosChampionPolicy(
    SEASONS.map((season) => ({
      season,
      complete: true,
      forecasts: raw.filter((row) => row.forecastSeason === season),
    })),
    OPTIONS,
  );
  const publicationPolicy = { ...legacy.livePolicy, modelVersion } as FirstPartyRosChampionPolicy;
  const convergenceAudit = SEASONS.flatMap((season) =>
    BUCKETS.flatMap((bucket) =>
      STRATEGIES.map((strategy): ConvergenceFixture => {
        const candidate = strategy === "contextual" ? "contextual" : "recency";
        const unstable = raw.some(
          (row) =>
            row.forecastSeason === season &&
            rowBucket(row) === bucket &&
            row.evidence.convergence[candidate].state === "unstable",
        );
        return {
          season,
          position: "DST",
          bucket,
          strategy,
          state: unstable ? "unstable" : "converged",
          worstToleranceRatio: unstable ? 2 : 0.5,
        };
      }),
    ),
  );
  return {
    validationMode: "read-only-first-party-ros-backtest",
    validationScope: { positions: ["DST"], completePortfolio: false },
    noDatabaseWrites: true,
    sourcePolicy: "official-nflverse-artifacts",
    outcomeCorpusIdentity: hash(`${modelVersion}:complete-corpus`),
    scoringProfile: { key: SCORING.key, label: SCORING.label, digest: SCORING.digest },
    coverage: {
      state: "qualified",
      fullyHeldOutSeasons: [...SEASONS],
      completeAsOfBatches: 68,
      totalAsOfBatches: 68,
    },
    report: {
      state: "evidence-ready",
      blockers: [] as string[],
      seasons: [...SEASONS],
      playersPerPosition: 8,
      maximumForecasts: 6000,
      forecasts: raw.length,
      batches: 68,
      skippedForecasts: 0,
      diagnosedPairs: 12,
      convergenceAudit,
      leakagePolicy: {
        calibration: "seasons-strictly-before-heldout",
        features: "strictly-before-cutoff",
        futureRosterUse: false,
        targetOutcomeUse: "evaluation-only",
      },
    },
    champion: { publicationPolicyChecksum: firstPartyRosChampionPolicyChecksum(publicationPolicy) },
    publicationPolicy,
    diagnostics: {
      candidateForecasts: raw,
      selected: legacy.selected,
      seasonPolicies: legacy.seasonPolicies.map((audit) => ({
        season: audit.season,
        evidenceThroughSeason: audit.evidenceThroughSeason,
        choices: audit.policy.choices
          .filter((choice) => choice.position === "DST")
          .map((choice) => ({
            position: choice.position,
            bucket: choice.bucket,
            strategy: choice.strategy,
            reason: choice.reason,
            contextualCalibration: choice.intervalCalibrationArtifacts.contextual,
            recencyCalibration: choice.intervalCalibrationArtifacts.recency,
          })),
      })),
    },
    identityAudit: {
      inputChecksums: new Set(raw.map((row) => row.inputChecksum)).size,
      contextualConvergenceChecksums: new Set(
        raw.map((row) => row.evidence.convergence.contextual.diagnosticChecksum),
      ).size,
      recencyConvergenceChecksums: new Set(
        raw.map((row) => row.evidence.convergence.recency.diagnosticChecksum),
      ).size,
      ...legacy.livePolicy.evidenceIdentity!,
    },
    sources: [2019, 2020, 2021, 2022, 2023, 2024, 2025].map((season) => ({
      season,
      weeklyStatsChecksum: hash(`${season}:weekly-stats`),
      playerWeeklyRawChecksum: hash(`${season}:raw-player-weekly`),
      playerTouchdownPlayByPlayChecksum: hash(`${season}:touchdown-pbp`),
      teamWeeklyStatsChecksum: hash(`${season}:team-weekly`),
      weeklyRosterChecksum: hash(`${season}:weekly-roster`),
      injuryChecksum: hash(`${season}:injury`),
      snapChecksum: hash(`${season}:snaps`),
      scheduleChecksum: hash(`${season}:schedule`),
    })),
  };
}

type Fixture = ReturnType<typeof reportFixture>;
let candidate: Fixture;
let previous: Fixture;
let passed: ReturnType<typeof buildRosMarginalDevelopmentReport>;

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
});

describe("pinned marginal ROS report development wrapper", () => {
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
});
