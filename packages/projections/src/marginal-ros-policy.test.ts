import { describe, expect, it } from "vitest";
import {
  applyMarginalIntervalArtifact,
  marginalIntervalArtifactIsValid,
} from "./marginal-interval-artifact.js";
import { validateMarginalIntervalEvidence } from "./marginal-interval-evidence.js";
import {
  evaluateFirstPartyRosMarginalPolicy,
  FIRST_PARTY_ROS_MARGINAL_POLICY_VERSION,
  type MarginalRosChampionPolicy,
} from "./marginal-ros-policy.js";
import {
  applyFirstPartyRosIntervalCalibration,
  evaluateFirstPartyRosChampionPolicy,
  type FirstPartyRosChampionOptions,
  type FirstPartyRosHeldOutForecast,
  type FirstPartyRosHeldOutSeason,
} from "./rest-of-season.js";
import { projectionScoringProfileKey } from "./scoring.js";

const championOptions: FirstPartyRosChampionOptions = {
  minimumHeldOutSeasons: 2,
  minimumBatches: 1,
  minimumSamples: 1,
  minimumCellSeasons: 2,
  minimumCellSamples: 1,
  minimumCellCutoffs: 1,
  minimumCellBatches: 1,
  minimumModelImprovement: 0.05,
};

function forecast(season: number, cutoff: number, player: number): FirstPartyRosHeldOutForecast {
  return {
    playerId: `p${player}`,
    position: "WR",
    forecastSeason: season,
    asOfWeek: cutoff,
    windowStartWeek: cutoff + 1,
    windowEndWeek: 18,
    trainedThroughSeason: season - 1,
    inputChecksum: "b".repeat(64),
    contextualModelVersion: "contextual-v13",
    recencyModelVersion: "recency-v13",
    scoringProfileKey: projectionScoringProfileKey({
      id: "test",
      rules: [{ statId: "receptions", points: 1 }],
    }),
    intervalMethodVersion: "simulation-p15-p50-p85-cqr-v1",
    evidence: {
      coverage: { contextual: 1, recency: 1 },
      availability: {
        scheduledGames: 2,
        actualGames: 2,
        contextualExpectedGames: 2,
        recencyExpectedGames: 2,
      },
      convergence: {
        contextual: { state: "converged", diagnosticChecksum: "c".repeat(64) },
        recency: { state: "converged", diagnosticChecksum: "d".repeat(64) },
      },
    },
    contextual: { meanPoints: 100, p15Points: 80, p50Points: 100, p85Points: 120 },
    recency: { meanPoints: 110, p15Points: 90, p50Points: 110, p85Points: 130 },
    actualPoints: 100,
  };
}

function seasons(years = [2022, 2023, 2024, 2025]): FirstPartyRosHeldOutSeason[] {
  return years.map((season) => ({
    season,
    complete: true,
    forecasts: [14, 15, 16].flatMap((cutoff) =>
      Array.from({ length: 6 }, (_, player) => forecast(season, cutoff, player)),
    ),
  }));
}

function run(input = seasons(), forecastSeason = 2026) {
  return evaluateFirstPartyRosMarginalPolicy(input, { forecastSeason, championOptions });
}

function cell(policy: MarginalRosChampionPolicy) {
  return policy.choices.find(
    (choice) => choice.position === "WR" && choice.bucket === "one-to-four",
  )!;
}

function reordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reordered);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, child]) => [key, reordered(child)]),
    );
  return value;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

describe("chronological marginal ROS candidate policy", () => {
  it("preserves every legacy mean policy, proof, strategy and selected mean without mutating inputs", () => {
    const input = deepFreeze(seasons());
    const before = JSON.stringify(input);
    const legacy = evaluateFirstPartyRosChampionPolicy(input, championOptions);
    const result = run(input);
    expect(result.policyVersion).toBe(FIRST_PARTY_ROS_MARGINAL_POLICY_VERSION);
    expect(result.legacyEvaluation).toEqual(legacy);
    expect(result.livePolicy.meanPolicy).toEqual(legacy.livePolicy);
    result.seasonPolicies.forEach(({ policy }, index) => {
      expect(policy.meanPolicy).toEqual(legacy.seasonPolicies[index]!.policy);
      policy.choices.forEach((choice, choiceIndex) => {
        expect(choice.meanChoice).toBe(policy.meanPolicy.choices[choiceIndex]);
        expect(choice.strategy).toBe(choice.meanChoice.strategy);
      });
    });
    expect(
      result.selected.map(({ predictedMean, strategy }) => ({ predictedMean, strategy })),
    ).toEqual(legacy.selected.map(({ predictedMean, strategy }) => ({ predictedMean, strategy })));
    expect(new Set(result.selected.map((row) => row.strategy))).toEqual(
      new Set(["contextual", "availability-aware-recency"]),
    );
    expect(result.selected.every((row) => result.candidates.includes(row))).toBe(true);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("fits after one prior supported season independently of mean-selector minimums", () => {
    const result = evaluateFirstPartyRosMarginalPolicy(seasons([2022, 2024]), {
      forecastSeason: 2027,
    });
    const second = cell(result.seasonPolicies[1]!.policy);
    expect(second.meanChoice.reason).toBe("insufficient-global-evidence");
    expect(second.meanChoice.intervalCalibrationArtifacts.contextual.state).toBe("not-calibrated");
    expect(second.intervalArtifacts.contextual!.fit).toMatchObject({
      state: "fitted",
      forecastSeason: 2024,
      priorSeasons: [2022],
      samples: 18,
      blocks: 3,
    });
    expect(
      result.candidates
        .filter((row) => row.forecastSeason === 2024)
        .every((row) => row.corrected !== null),
    ).toBe(true);
    expect(cell(result.livePolicy).intervalArtifacts.contextual!.fit).toMatchObject({
      forecastSeason: 2027,
      priorSeasons: [2022, 2024],
    });
    expect(result.seasonPolicies.map(({ season }) => season)).toEqual([2022, 2024]);
  });

  it("locks fits and decisions before an entire season and resists current/future outcome leakage", () => {
    const input = seasons();
    const original = run(input);
    const changed = run(
      input.map((season) =>
        season.season < 2024
          ? season
          : {
              ...season,
              forecasts: season.forecasts.map((row) => ({
                ...row,
                actualPoints: row.actualPoints + 500,
              })),
            },
      ),
    );
    expect(changed.seasonPolicies.slice(0, 3)).toEqual(original.seasonPolicies.slice(0, 3));
    expect(changed.candidates.filter((row) => row.forecastSeason < 2024)).toEqual(
      original.candidates.filter((row) => row.forecastSeason < 2024),
    );
    const originalCurrent = original.candidates.filter((row) => row.forecastSeason === 2024);
    const changedCurrent = changed.candidates.filter((row) => row.forecastSeason === 2024);
    expect(
      changedCurrent.map((row) => [
        row.calibrationArtifactChecksum,
        row.rawQuantiles,
        row.corrected && [
          row.corrected.p15Points,
          row.corrected.p50Points,
          row.corrected.p85Points,
        ],
      ]),
    ).toEqual(
      originalCurrent.map((row) => [
        row.calibrationArtifactChecksum,
        row.rawQuantiles,
        row.corrected && [
          row.corrected.p15Points,
          row.corrected.p50Points,
          row.corrected.p85Points,
        ],
      ]),
    );
    expect(cell(changed.livePolicy).intervalArtifacts).not.toEqual(
      cell(original.livePolicy).intervalArtifacts,
    );
    for (const row of original.candidates) {
      if (row.corrected !== null)
        expect(row.corrected.trainedThroughSeason).toBeLessThan(row.forecastSeason);
    }
  });

  it("keeps the raw-WIS safeguard even when contextual expected means are exact", () => {
    const input = seasons().map((season) => ({
      ...season,
      forecasts: season.forecasts.map((row) => ({
        ...row,
        contextual: { ...row.contextual, p15Points: -500, p85Points: 700 },
      })),
    }));
    const choice = cell(run(input).livePolicy);
    expect(choice.meanChoice.meanSelectionEvidence.clearsMeanMargin).toBe(true);
    expect(choice.meanChoice.intervalScoreDifferenceUpperBound).toBeGreaterThan(0);
    expect(choice.strategy).toBe("availability-aware-recency");
    expect(choice.meanChoice).toEqual(
      evaluateFirstPartyRosChampionPolicy(input, championOptions).livePolicy.choices.find(
        (item) => item.position === "WR" && item.bucket === "one-to-four",
      ),
    );
  });

  it("retains both legacy candidate intervals and exactly matches original selected legacy output", () => {
    const result = run();
    for (const row of result.candidates) {
      const policy = result.legacyEvaluation.seasonPolicies.find(
        (item) => item.season === row.forecastSeason,
      )!.policy;
      const choice = policy.choices.find(
        (item) => item.position === row.position && item.bucket === row.bucket,
      )!;
      expect(row.legacyInterval).toEqual(
        applyFirstPartyRosIntervalCalibration(
          row.rawQuantiles,
          choice.intervalCalibrationArtifacts[
            row.strategy === "contextual" ? "contextual" : "recency"
          ],
        ),
      );
    }
    result.selected.forEach((row, index) => {
      const legacy = result.legacyEvaluation.selected[index]!;
      expect(row.legacyInterval).toEqual({
        p15Points: legacy.p15Points,
        p50Points: legacy.p50Points,
        p85Points: legacy.p85Points,
        intervalCalibration: legacy.intervalCalibration,
        calibrationArtifactChecksum: legacy.calibrationArtifactChecksum,
      });
    });
    expect(result.candidates[0]!.legacyInterval.intervalCalibration).toBe("not-calibrated");
    expect(result.candidates.at(-1)!.legacyInterval.intervalCalibration).toBe(
      "split-conformal-cqr",
    );
  });

  it("does not rescue a failed selected interval by switching to the other passing candidate", () => {
    const input = seasons().map((season) => ({
      ...season,
      forecasts: season.forecasts.map((row) =>
        season.season === 2025
          ? {
              ...row,
              contextual: {
                ...row.contextual,
                p15Points: 180,
                p50Points: 200,
                p85Points: 220,
              },
            }
          : row,
      ),
    }));
    const result = run(input);
    const selected = result.selected.filter((row) => row.forecastSeason === 2025);
    expect(selected.every((row) => row.strategy === "contextual")).toBe(true);
    expect(selected.every((row) => row.corrected!.p15Points > row.actualPoints)).toBe(true);
    const choice = cell(result.livePolicy);
    expect(choice.intervalScreens.contextual!.state).toBe("failed-screen");
    expect(choice.intervalScreens.recency!.state).toBe("descriptive-screen-passed");
    expect(result.selected.map((row) => [row.strategy, row.predictedMean])).toEqual(
      result.legacyEvaluation.selected.map((row) => [row.strategy, row.predictedMean]),
    );
  });

  it("reports warmup and sparse cells explicitly, never returning raw ranges as corrected", () => {
    const result = run(seasons([2022]));
    expect(result.candidates).toHaveLength(36);
    expect(
      result.candidates.every(
        (row) =>
          row.intervalState === "withheld" &&
          row.withheldReason === "insufficient-prior-fit" &&
          row.corrected === null,
      ),
    ).toBe(true);
    expect(cell(result.livePolicy).support.contextual).toEqual({
      forecasts: 18,
      corrected: 0,
      insufficientPriorFit: 18,
      zeroScheduledGames: 0,
    });
    expect(cell(result.livePolicy).intervalScreens.contextual!.state).toBe("insufficient-evidence");
    const missing = result.livePolicy.choices.find((choice) => choice.position === "QB")!;
    expect(missing.intervalArtifacts.contextual!.fit.state).toBe("insufficient-evidence");
    expect(missing.support.contextual.forecasts).toBe(0);
  });

  it("retains zero-game rows as explicit withheld diagnostics, excluding them only from fitting", () => {
    const input = seasons([2022, 2023]).map((season) => ({
      ...season,
      forecasts: [
        ...season.forecasts,
        {
          ...forecast(season.season, 17, 99),
          evidence: {
            ...forecast(season.season, 17, 99).evidence,
            availability: {
              scheduledGames: 0,
              actualGames: 0,
              contextualExpectedGames: 0,
              recencyExpectedGames: 0,
            },
          },
        },
      ],
    }));
    const result = run(input);
    const zeros = result.candidates.filter((row) => row.scheduledGames === 0);
    expect(zeros).toHaveLength(4);
    expect(
      zeros.every((row) => row.withheldReason === "zero-scheduled-games" && row.corrected === null),
    ).toBe(true);
    expect(cell(result.livePolicy).support.contextual).toEqual({
      forecasts: 38,
      corrected: 18,
      insufficientPriorFit: 18,
      zeroScheduledGames: 2,
    });
    expect(cell(result.livePolicy).intervalArtifacts.contextual!.fit.samples).toBe(36);
    expect(cell(result.livePolicy).intervalEvidence.contextual!.overall.samples).toBe(18);
    expect(result.selected).toHaveLength(38);
  });

  it("sorts crossed corrections once and publishes the corrected median while preserving the mean", () => {
    const input = seasons([2022, 2023]).map((season) => ({
      ...season,
      forecasts: season.forecasts.map((row) => {
        const candidate =
          season.season === 2022
            ? { meanPoints: 100, p15Points: 0, p50Points: 50, p85Points: 100 }
            : { meanPoints: 100, p15Points: 20, p50Points: 25, p85Points: 30 };
        return { ...row, actualPoints: 10, contextual: candidate, recency: candidate };
      }),
    }));
    const row = run(input).selected.find((candidate) => candidate.forecastSeason === 2023)!;
    expect(row.corrected).toMatchObject({ p15Points: -60, p50Points: -15, p85Points: 30 });
    expect(row.rearrangement).toEqual({
      crossed: true,
      unsorted: [30, -15, -60],
      permutation: [2, 1, 0],
      maximumMovement: 90,
    });
    expect(row.predictedMean).toBe(100);
  });

  it("builds valid descriptive evidence for both candidates and the independently selected sequence", () => {
    const result = run();
    const choice = cell(result.livePolicy);
    for (const evidence of [
      choice.intervalEvidence.contextual!,
      choice.intervalEvidence.recency!,
      choice.selectedEvidence!,
    ]) {
      expect(() => validateMarginalIntervalEvidence(evidence)).not.toThrow();
      expect(evidence.overall).toMatchObject({ seasons: 3, blocks: 9, samples: 54 });
      expect(evidence.overall.metrics!.coverage).toEqual({ numerator: "1", denominator: "1" });
      expect(evidence.interpretation).toBe("overlapping-outcomes-descriptive-only");
    }
    expect(choice.selectedEvidence!.seriesKey).toMatch(/^ros-marginal-selected:/u);
    expect(choice.intervalScreens.contextual!.state).toBe("descriptive-screen-passed");
    expect(result.livePolicy.choices).toHaveLength(18);
  });

  it("applies a JSONB-reordered stored artifact identically and binds exact schedule and season", () => {
    const result = run();
    const artifact = cell(result.seasonPolicies[1]!.policy).intervalArtifacts.recency!;
    const stored = reordered(JSON.parse(JSON.stringify(artifact)));
    expect(marginalIntervalArtifactIsValid(stored)).toBe(true);
    if (!marginalIntervalArtifactIsValid(stored)) throw new Error("test artifact is invalid");
    const row = result.candidates.find(
      (candidate) =>
        candidate.forecastSeason === 2023 && candidate.strategy === "availability-aware-recency",
    )!;
    const input = {
      seriesKey: row.seriesKey,
      forecastSeason: row.forecastSeason,
      asOfWeek: row.asOfWeek,
      windowStartWeek: row.windowStartWeek,
      windowEndWeek: row.windowEndWeek,
      scheduledGames: row.scheduledGames,
      ...row.rawQuantiles,
    };
    const applied = applyMarginalIntervalArtifact(input, stored.context, stored);
    expect(applied).toEqual(applyMarginalIntervalArtifact(input, artifact.context, artifact));
    expect(applied.p50Points).toBe(row.corrected!.p50Points);
    expect(() =>
      applyMarginalIntervalArtifact({ ...input, forecastSeason: 2024 }, stored.context, stored),
    ).toThrow();
    expect(() =>
      applyMarginalIntervalArtifact(
        { ...input, windowEndWeek: input.windowStartWeek },
        stored.context,
        stored,
      ),
    ).toThrow();
    expect(
      applyMarginalIntervalArtifact({ ...input, scheduledGames: 1 }, stored.context, stored)
        .p50Points,
    ).not.toBe(applied.p50Points);
  });

  it("binds each training window and game count in the fit evidence checksum", () => {
    const original = run(seasons([2022]));
    const altered = run(
      seasons([2022]).map((season) => ({
        ...season,
        forecasts: season.forecasts.map((row) =>
          row.asOfWeek === 14 ? { ...row, windowStartWeek: 16 } : row,
        ),
      })),
    );
    const before = cell(original.livePolicy).intervalArtifacts.contextual!;
    const after = cell(altered.livePolicy).intervalArtifacts.contextual!;
    expect(after.fit.corrections).toEqual(before.fit.corrections);
    expect(after.evidenceChecksum).not.toBe(before.evidenceChecksum);
    expect(after.artifactChecksum).not.toBe(before.artifactChecksum);
  });

  it("rejects physical schedule counts outside the actual window instead of inventing a scale", () => {
    const row = forecast(2022, 16, 1);
    expect(() =>
      run([{ season: 2022, complete: true, forecasts: [{ ...row, windowEndWeek: 17 }] }]),
    ).toThrow(/exact forecast window/u);
    const full = forecast(2022, 0, 1);
    expect(() =>
      run([
        {
          season: 2022,
          complete: true,
          forecasts: [
            {
              ...full,
              evidence: {
                ...full.evidence,
                availability: {
                  scheduledGames: 18,
                  actualGames: 17,
                  contextualExpectedGames: 17,
                  recencyExpectedGames: 17,
                },
              },
            },
          ],
        },
      ]),
    ).toThrow(/exact forecast window/u);
  });

  it("rejects duplicate semantic players even under different input checksums", () => {
    const row = forecast(2022, 14, 1);
    expect(() =>
      run([
        {
          season: 2022,
          complete: true,
          forecasts: [row, { ...row, inputChecksum: "f".repeat(64) }],
        },
      ]),
    ).toThrow(/duplicate season\/cutoff\/player/u);
  });

  it("rejects incomplete seasons, mixed profile evidence and retroactive live forecasts", () => {
    expect(() => run([{ ...seasons()[0]!, complete: false }])).toThrow(/incomplete/u);
    const mixed = seasons([2022]);
    mixed[0] = {
      ...mixed[0]!,
      forecasts: mixed[0]!.forecasts.map((row, index) =>
        index === 0 ? { ...row, scoringProfileKey: "[]" } : row,
      ),
    };
    expect(() => run(mixed)).toThrow(/identities cannot be mixed/u);
    expect(() => run(seasons(), 2025)).toThrow(/must follow/u);
    expect(() => run(seasons(), Number.NaN)).toThrow(/must follow/u);
  });

  it("keeps empty input explicitly unsupported with no invented evidence identity", () => {
    const result = run([]);
    expect(result.candidates).toEqual([]);
    expect(result.selected).toEqual([]);
    expect(result.livePolicy.evidenceIdentity).toBeNull();
    expect(
      result.livePolicy.choices.every(
        (choice) =>
          choice.intervalArtifacts.contextual === null &&
          choice.intervalEvidence.contextual === null &&
          choice.selectedEvidence === null,
      ),
    ).toBe(true);
  });
});
