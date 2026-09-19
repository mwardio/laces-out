import { describe, expect, it } from "vitest";
import { evaluateConditionalRosDevelopment } from "./conditional-ros-development.js";
import {
  evaluateFirstPartyRosChampionPolicy,
  type FirstPartyRosHeldOutForecast,
  type FirstPartyRosHeldOutSeason,
  type FirstPartyRosPosition,
} from "./rest-of-season.js";
import { rosScoringProfile } from "./ros-scoring-profiles.js";
import { sha256Hex } from "./sha256.js";

const LOCKED_MEAN_OPTIONS = {
  minimumHeldOutSeasons: 3,
  minimumBatches: 30,
  minimumSamples: 300,
  minimumCellSeasons: 3,
  minimumCellSamples: 18,
  minimumCellCutoffs: 3,
  minimumCellBatches: 9,
  minimumModelImprovement: 0.01,
} as const;

function forecast(
  season: number,
  cutoff: number,
  player: number,
  position: FirstPartyRosPosition = "WR",
): FirstPartyRosHeldOutForecast {
  const games = 18 - cutoff;
  const mean = games * (10 + player);
  return {
    playerId: `${position}:${player}`,
    position,
    forecastSeason: season,
    asOfWeek: cutoff,
    windowStartWeek: cutoff + 1,
    windowEndWeek: 18,
    trainedThroughSeason: season - 1,
    inputChecksum: sha256Hex(`${season}:${cutoff}:${position}:${player}`),
    contextualModelVersion: "synthetic-contextual-v13",
    recencyModelVersion: "synthetic-recency-v13",
    scoringProfileKey: rosScoringProfile("full-ppr").scoringProfileKey,
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
        contextual: { state: "converged", diagnosticChecksum: sha256Hex("synthetic-contextual") },
        recency: { state: "converged", diagnosticChecksum: sha256Hex("synthetic-recency") },
      },
    },
    contextual: {
      meanPoints: mean,
      p15Points: mean - 2 * games,
      p50Points: mean,
      p85Points: mean + 2 * games,
    },
    recency: {
      meanPoints: mean + games,
      p15Points: mean - games,
      p50Points: mean + games,
      p85Points: mean + 3 * games,
    },
    actualPoints: mean + games * ((player % 3) - 1),
  };
}
function seasons(full = false): FirstPartyRosHeldOutSeason[] {
  const positions: readonly FirstPartyRosPosition[] = full
    ? ["QB", "RB", "WR", "TE", "K", "DST"]
    : ["WR"];
  const cutoffs = full ? [1, 2, 3, 10, 11, 12, 14, 15, 16] : [14, 15, 16];
  return [2022, 2023, 2024, 2025].map((season) => ({
    season,
    complete: true,
    forecasts: positions.flatMap((position) =>
      cutoffs.flatMap((cutoff) =>
        Array.from({ length: 6 }, (_, player) => forecast(season, cutoff, player, position)),
      ),
    ),
  }));
}
function run(audit = seasons(), training?: readonly FirstPartyRosHeldOutSeason[]) {
  return evaluateConditionalRosDevelopment(audit, {
    forecastSeason: 2026,
    ...(training === undefined ? {} : { intervalTrainingSeasons: training }),
  });
}
function expanded(audit = seasons()): FirstPartyRosHeldOutSeason[] {
  return audit.map((season) => ({
    ...season,
    forecasts: [
      ...season.forecasts,
      ...[14, 15, 16].flatMap((cutoff) =>
        Array.from({ length: 6 }, (_, player) => {
          const row = forecast(season.season, cutoff, player + 6);
          return { ...row, actualPoints: row.actualPoints + 20 };
        }),
      ),
    ],
  }));
}
function wrFits(result: ReturnType<typeof run>, season: number) {
  const collection =
    season === 2026
      ? result.liveFits
      : result.seasonFits.find((row) => row.forecastSeason === season)!;
  return collection.cells.filter(
    (row) => row.context.position === "WR" && row.context.bucket === "one-to-four",
  );
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

describe("chronological conditional ROS development adapter", () => {
  it("covers all six positions and three horizons without changing any audit mean or selection", () => {
    const audit = freeze(seasons(true));
    const before = JSON.stringify(audit);
    const result = run(audit);
    expect(result.canAuthorizeRelease).toBe(false);
    expect(result.meanSelectorOptions).toEqual(LOCKED_MEAN_OPTIONS);
    expect(result.legacyEvaluation).toEqual(
      evaluateFirstPartyRosChampionPolicy(audit, LOCKED_MEAN_OPTIONS),
    );
    expect(result.auditCoverage).toMatchObject({
      forecasts: 1296,
      candidateRows: 2592,
      selectedRows: 1296,
      correctedCandidateRows: 1944,
      withheldCandidateRows: 648,
      physicallyFlaggedCandidateRows: 0,
    });
    expect(result.liveFits.cells).toHaveLength(36);
    expect(result.liveFits.cells.every((cell) => cell.fit.state === "fitted")).toBe(true);
    expect(
      result.liveFits.cells.every(
        (cell) => JSON.stringify(cell.fit.priorSeasons) === "[2022,2023,2024,2025]",
      ),
    ).toBe(true);
    expect(new Set(result.liveFits.cells.map((cell) => cell.seriesKey)).size).toBe(36);
    expect(
      result.selected.map(({ playerId, forecastSeason, asOfWeek, strategy, predictedMean }) => ({
        playerId,
        forecastSeason,
        asOfWeek,
        strategy,
        predictedMean,
      })),
    ).toEqual(
      result.legacyEvaluation.selected.map(
        ({ playerId, forecastSeason, asOfWeek, strategy, predictedMean }) => ({
          playerId,
          forecastSeason,
          asOfWeek,
          strategy,
          predictedMean,
        }),
      ),
    );
    const raw = audit.flatMap((year) => year.forecasts);
    result.candidates.forEach((row, index) => {
      const source = raw[Math.floor(index / 2)]!;
      const candidateKey = row.strategy === "contextual" ? "contextual" : "recency";
      expect(row.predictedMean).toBe(source[candidateKey].meanPoints);
      expect(JSON.parse(row.identity) as unknown[]).toContain(source.inputChecksum);
      expect(row.physicalEvidence).toEqual(source.evidence);
      if (row.correction !== null) {
        expect(row.correction.meanPoints).toBe(row.predictedMean);
        expect(row.correction.p15Points).toBeLessThanOrEqual(row.correction.p50Points);
        expect(row.correction.p50Points).toBeLessThanOrEqual(row.correction.p85Points);
        expect(row.correction.rearrangement.unsorted).toHaveLength(3);
      }
    });
    expect(JSON.stringify(audit)).toBe(before);
  });

  it("fits each year only on completed prior years and preserves every unsupported first-year row", () => {
    const result = run();
    for (const [index, year] of result.seasonFits.entries()) {
      expect(year.completedSeasons).toEqual([2022, 2023, 2024, 2025].slice(0, index));
      for (const cell of year.cells) {
        expect(cell.fit.history.every(({ row }) => row.forecastSeason < year.forecastSeason)).toBe(
          true,
        );
      }
    }
    const first = result.candidates.filter((row) => row.forecastSeason === 2022);
    expect(first).toHaveLength(36);
    expect(
      first.every(
        (row) => row.failure?.code === "prior-fit-unavailable" && row.correction === null,
      ),
    ).toBe(true);
    expect(wrFits(result, 2023).every((cell) => cell.fit.samples === 18)).toBe(true);
    expect(wrFits(result, 2026).every((cell) => cell.fit.samples === 72)).toBe(true);
  });

  it("excludes current and future targets and covariates from earlier fits and applications", () => {
    const audit = seasons();
    const original = run(audit);
    const altered = audit.map((year) =>
      year.season < 2025
        ? year
        : {
            ...year,
            forecasts: year.forecasts.map((row) => ({
              ...row,
              actualPoints: row.actualPoints + 100,
              contextual: { ...row.contextual, meanPoints: row.contextual.meanPoints + 50 },
            })),
          },
    );
    const changed = run(altered);
    expect(changed.seasonFits).toEqual(original.seasonFits);
    expect(changed.candidates.filter((row) => row.forecastSeason < 2025)).toEqual(
      original.candidates.filter((row) => row.forecastSeason < 2025),
    );
    expect(changed.liveFits).not.toEqual(original.liveFits);
    expect(changed.cohort.evaluationRowsChecksum).not.toBe(original.cohort.evaluationRowsChecksum);
  });

  it("uses a validated physical training superset without promoting any extra row into the audit", () => {
    const audit = freeze(seasons());
    const training = freeze(expanded(audit));
    const original = run(audit);
    const result = run(audit, training);
    expect(result.legacyEvaluation).toEqual(original.legacyEvaluation);
    expect(result.auditCoverage.forecastIdentities).toEqual(
      original.auditCoverage.forecastIdentities,
    );
    expect(result.candidates).toHaveLength(144);
    expect(result.selected).toHaveLength(72);
    expect(result.cohort).toMatchObject({
      evaluationForecasts: 72,
      trainingForecasts: 144,
      additionalTrainingForecasts: 72,
    });
    expect(wrFits(result, 2023).every((cell) => cell.fit.samples === 36)).toBe(true);
    expect(wrFits(result, 2023)).not.toEqual(wrFits(original, 2023));
    const futureChanged = training.map((year) =>
      year.season < 2025
        ? year
        : {
            ...year,
            forecasts: year.forecasts.map((row) =>
              Number(row.playerId.split(":")[1]) < 6
                ? row
                : { ...row, actualPoints: row.actualPoints - 200 },
            ),
          },
    );
    expect(run(audit, futureChanged).seasonFits).toEqual(result.seasonFits);
  });

  it("names structural zero-game training exclusions and retains both unavailable audit rows", () => {
    const audit = seasons();
    const original = audit[1]!.forecasts[0]!;
    const zero = {
      ...original,
      evidence: {
        ...original.evidence,
        availability: {
          scheduledGames: 0,
          actualGames: 0,
          contextualExpectedGames: 0,
          recencyExpectedGames: 0,
        },
      },
    };
    const changed = audit.map((year) =>
      year.season !== 2023 ? year : { ...year, forecasts: [zero, ...year.forecasts.slice(1)] },
    );
    const result = run(changed);
    const rows = result.candidates.filter((row) => row.inputChecksum === original.inputChecksum);
    expect(rows).toHaveLength(2);
    expect(
      rows.every((row) => row.failure?.code === "zero-scheduled-games" && row.correction === null),
    ).toBe(true);
    expect(result.auditCoverage).toMatchObject({
      forecasts: 72,
      candidateRows: 144,
      selectedRows: 72,
    });
    for (const cell of wrFits(result, 2024)) {
      expect(cell.training).toMatchObject({
        priorForecasts: 36,
        includedForecasts: 35,
        zeroScheduledGameExclusions: [
          {
            reason: "structural-zero-scheduled-games",
            inputChecksum: original.inputChecksum,
            forecastSeason: 2023,
          },
        ],
      });
      expect(cell.fit.samples).toBe(35);
      expect(cell.fit.state).toBe("fitted");
    }
  });

  it("retains strategy-specific original and broader-training physical failures after a numerical fit", () => {
    const audit = seasons();
    const row = audit[1]!.forecasts[0]!;
    const changed = audit.map((year) =>
      year.season !== 2023
        ? year
        : {
            ...year,
            forecasts: [
              {
                ...row,
                evidence: {
                  ...row.evidence,
                  coverage: { ...row.evidence.coverage, contextual: 0.75 },
                  convergence: {
                    ...row.evidence.convergence,
                    contextual: {
                      state: "unstable" as const,
                      diagnosticChecksum: sha256Hex("original-failure"),
                    },
                  },
                },
              },
              ...year.forecasts.slice(1),
            ],
          },
    );
    const expandedWithFailure = expanded(changed).map((year) =>
      year.season !== 2022
        ? year
        : {
            ...year,
            forecasts: year.forecasts.map((extra) =>
              extra.playerId !== "WR:6"
                ? extra
                : {
                    ...extra,
                    evidence: {
                      ...extra.evidence,
                      convergence: {
                        ...extra.evidence.convergence,
                        recency: {
                          state: "unstable" as const,
                          diagnosticChecksum: sha256Hex("extra-failure"),
                        },
                      },
                    },
                  },
            ),
          },
    );
    // A broader sample may carry different convergence diagnostics for identical physical rows.
    // A passing copy must never replace the original audit's failed diagnostic.
    const training = expandedWithFailure.map((year) => ({
      ...year,
      forecasts: year.forecasts.map((source) =>
        source.inputChecksum !== row.inputChecksum
          ? source
          : {
              ...source,
              evidence: {
                ...source.evidence,
                convergence: {
                  ...source.evidence.convergence,
                  contextual: {
                    state: "converged" as const,
                    diagnosticChecksum: sha256Hex("broader-sample-pass"),
                  },
                },
              },
            },
      ),
    }));
    const result = run(changed, training);
    const contextual = result.candidates.find(
      (candidate) =>
        candidate.inputChecksum === row.inputChecksum && candidate.strategy === "contextual",
    )!;
    expect(contextual.intervalState).toBe("corrected");
    expect(contextual.physicalIssues.map((issue) => issue.kind)).toEqual([
      "incomplete-input-coverage",
      "unstable-physical-convergence",
    ]);
    expect(contextual.physicalEvidence.convergence.contextual.diagnosticChecksum).toBe(
      sha256Hex("original-failure"),
    );
    expect(
      wrFits(result, 2023).find((cell) => cell.context.strategy === "availability-aware-recency")!
        .training.physicalIssues,
    ).toHaveLength(3);
    expect(result.auditCoverage.physicallyFlaggedCandidateRows).toBe(1);
    expect(result.canAuthorizeRelease).toBe(false);
  });

  it("retains application-domain failure without replacing the interval or switching mean strategy", () => {
    const audit = seasons().map((year) => ({
      ...year,
      forecasts: year.forecasts.map((row) => ({
        ...row,
        evidence: {
          ...row.evidence,
          availability: {
            scheduledGames: year.season === 2022 ? 1 : 2,
            actualGames: 1,
            contextualExpectedGames: 1,
            recencyExpectedGames: 1,
          },
        },
      })),
    }));
    const result = run(audit);
    const year = result.candidates.filter((row) => row.forecastSeason === 2023);
    expect(
      year.every(
        (row) => row.failure?.code === "application-unavailable" && row.correction === null,
      ),
    ).toBe(true);
    expect(year[0]!.failure!.reasons[0]).toContain("different games");
    expect(result.selected.filter((row) => row.forecastSeason === 2023)).toHaveLength(18);
  });

  it("retains every audit row when a zero-scale prior fit cannot produce conditional endpoints", () => {
    const audit = seasons().map((year) => ({
      ...year,
      forecasts: year.forecasts.map((row) => ({
        ...row,
        contextual: {
          meanPoints: row.contextual.meanPoints,
          p15Points: row.contextual.meanPoints,
          p50Points: row.contextual.meanPoints,
          p85Points: row.contextual.meanPoints,
        },
        recency: {
          meanPoints: row.recency.meanPoints,
          p15Points: row.recency.meanPoints,
          p50Points: row.recency.meanPoints,
          p85Points: row.recency.meanPoints,
        },
      })),
    }));
    const result = run(audit);
    expect(result.auditCoverage).toMatchObject({
      forecasts: 72,
      candidateRows: 144,
      selectedRows: 72,
      correctedCandidateRows: 0,
      withheldCandidateRows: 144,
    });
    expect(
      wrFits(result, 2023).every(
        (cell) =>
          cell.fit.state === "unavailable" && cell.fit.reasons.includes("zero-forecast-scale"),
      ),
    ).toBe(true);
    expect(result.candidates.every((row) => row.correction === null && row.failure !== null)).toBe(
      true,
    );
    expect(result.legacyEvaluation).toEqual(
      evaluateFirstPartyRosChampionPolicy(audit, LOCKED_MEAN_OPTIONS),
    );
  });

  it("fails closed on incomplete, duplicate, mismatched or altered training scopes", () => {
    const audit = seasons();
    expect(() => run([{ ...audit[0]!, complete: false }, ...audit.slice(1)])).toThrow(/completed/u);
    expect(() =>
      run([
        { ...audit[0]!, forecasts: [...audit[0]!.forecasts, audit[0]!.forecasts[0]!] },
        ...audit.slice(1),
      ]),
    ).toThrow(/Duplicate|duplicate/u);
    expect(() => run(audit, expanded(audit).slice(1))).toThrow(/exactly/u);
    const wrong = expanded(audit).map((year) => ({
      ...year,
      forecasts: year.forecasts.map((row) => ({
        ...row,
        scoringProfileKey: rosScoringProfile("half-ppr").scoringProfileKey,
      })),
    }));
    expect(() => run(audit, wrong)).toThrow(/identity/u);
    const altered = expanded(audit).map((year) => ({
      ...year,
      forecasts: year.forecasts.map((row) =>
        row.playerId !== "WR:0" ? row : { ...row, actualPoints: row.actualPoints + 1 },
      ),
    }));
    expect(() => run(audit, altered)).toThrow(/preserve every original/u);
    expect(() => evaluateConditionalRosDevelopment(audit, { forecastSeason: 2025 })).toThrow(
      /follow/u,
    );
    const leaked = audit.map((year) => ({
      ...year,
      forecasts: year.forecasts.map((row) => ({
        ...row,
        trainedThroughSeason: row.forecastSeason,
      })),
    }));
    expect(() => run(leaked)).toThrow(/earlier season/u);
  });

  it("does not allow same numeric rows from another exact scoring profile to share fitted identities", () => {
    const audit = seasons();
    const changed = audit.map((year) => ({
      ...year,
      forecasts: year.forecasts.map((row) => ({
        ...row,
        scoringProfileKey: rosScoringProfile("half-ppr").scoringProfileKey,
      })),
    }));
    const original = run(audit);
    const other = run(changed);
    expect(wrFits(other, 2023)[0]!.seriesKey).not.toBe(wrFits(original, 2023)[0]!.seriesKey);
    expect(wrFits(other, 2023)[0]!.fit.checksum).not.toBe(wrFits(original, 2023)[0]!.fit.checksum);
  });
});
