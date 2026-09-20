import { describe, expect, it } from "vitest";
import { buildFrozenRosBenchmark } from "./frozen-ros-benchmark.js";
import { validateMarginalRosTrainingCohort } from "./marginal-ros-training.js";
import {
  buildRosMarginalIntervalQualificationSet,
  type RosMarginalQualificationDataset,
} from "./ros-marginal-interval-qualification.js";
import { rosMarginalIntervalQualificationFixtureInput } from "./ros-marginal-interval-test-fixtures.js";
import {
  evaluateRetainedV12FirstPartyRosChampionPolicy,
  type FirstPartyRosHeldOutForecast,
} from "./rest-of-season.js";
import { projectionScoringRulesFromProfileKey } from "./scoring-position-keys.js";
import { projectionScoringProfileKey } from "./scoring.js";
import { sha256Hex } from "./sha256.js";

const options = {
  minimumHeldOutSeasons: 3,
  minimumBatches: 30,
  minimumSamples: 300,
  minimumCellSeasons: 3,
  minimumCellSamples: 18,
  minimumCellCutoffs: 3,
  minimumCellBatches: 9,
  minimumModelImprovement: 0.01,
};

function pin(value: RosMarginalQualificationDataset): RosMarginalQualificationDataset {
  return {
    ...value,
    rowsChecksum: validateMarginalRosTrainingCohort(value.heldOutSeasons, value.heldOutSeasons)
      .provenance.evaluationRowsChecksum,
  };
}

function corrected(value: RosMarginalQualificationDataset) {
  return pin({
    ...value,
    source: {
      ...value.source,
      reportChecksum: sha256Hex(value.source.reportChecksum + ":corrected"),
    },
    heldOutSeasons: value.heldOutSeasons.map((year) => ({
      ...year,
      forecasts: year.forecasts.map((row) => ({ ...row, actualPoints: row.actualPoints + 25 })),
    })),
  });
}

describe("frozen previous ROS forecasts under corrected observations", () => {
  it("preserves original policies and endpoints when refitting would change them", () => {
    const original = rosMarginalIntervalQualificationFixtureInput().previous;
    const changed = corrected(original);
    const frozen = buildFrozenRosBenchmark(
      { original, comparisonManifestChecksum: sha256Hex("audited correction") },
      changed,
      options,
    );
    const expected = evaluateRetainedV12FirstPartyRosChampionPolicy(
      original.heldOutSeasons,
      options,
    );
    const refitted = evaluateRetainedV12FirstPartyRosChampionPolicy(
      changed.heldOutSeasons,
      options,
    );
    expect(frozen.evaluation).toEqual(expected);
    expect(frozen.evaluation.selected.filter((row) => row.forecastSeason === 2025)).not.toEqual(
      refitted.selected.filter((row) => row.forecastSeason === 2025),
    );
    expect(frozen.binding.original.rowsChecksum).toBe(original.rowsChecksum);
    expect(frozen.binding.correctedObservations.rowsChecksum).toBe(changed.rowsChecksum);
  });

  it("uses the frozen comparator in qualification while evaluating common corrected truth", () => {
    const base = rosMarginalIntervalQualificationFixtureInput();
    const input = {
      ...base,
      candidate: corrected(base.candidate),
      previous: corrected(base.previous),
    };
    const frozen = buildRosMarginalIntervalQualificationSet({
      ...input,
      frozenPrevious: {
        original: base.previous,
        comparisonManifestChecksum: sha256Hex("audited correction"),
      },
    });
    const refit = buildRosMarginalIntervalQualificationSet(input);
    const oldPolicy = evaluateRetainedV12FirstPartyRosChampionPolicy(
      base.previous.heldOutSeasons,
      options,
    );
    expect(frozen).toHaveLength(3);
    for (const row of frozen) {
      expect(row.previousMeanChoice).toEqual(
        oldPolicy.livePolicy.choices.find(
          (choice) => choice.position === row.cell.position && choice.bucket === row.cell.bucket,
        ),
      );
      expect(row.frozenPrevious?.original.rowsChecksum).toBe(base.previous.rowsChecksum);
      const other = refit.find((other) => other.cell.bucket === row.cell.bucket)!;
      expect(row.comparison).not.toEqual(other.comparison);
      expect(row.evidence).toEqual(other.evidence);
      expect(row.liveArtifact).toEqual(other.liveArtifact);
    }
  });

  it.each(["mean", "input", "window", "games", "seed-evidence"] as const)(
    "rejects a rehashed changed %s",
    (kind) => {
      const original = rosMarginalIntervalQualificationFixtureInput().previous;
      const value = corrected(original);
      const changeForecast = (row: FirstPartyRosHeldOutForecast): FirstPartyRosHeldOutForecast => {
        switch (kind) {
          case "mean":
            return {
              ...row,
              contextual: { ...row.contextual, meanPoints: row.contextual.meanPoints + 1 },
            };
          case "input":
            return { ...row, inputChecksum: sha256Hex("other input") };
          case "window":
            return { ...row, windowStartWeek: row.windowStartWeek + 1 };
          case "games":
            return {
              ...row,
              evidence: {
                ...row.evidence,
                availability: {
                  ...row.evidence.availability,
                  actualGames: row.evidence.availability.actualGames - 1,
                },
              },
            };
          case "seed-evidence":
            return {
              ...row,
              evidence: {
                ...row.evidence,
                convergence: {
                  ...row.evidence.convergence,
                  contextual: {
                    ...row.evidence.convergence.contextual,
                    diagnosticChecksum: sha256Hex("other seed"),
                  },
                },
              },
            };
        }
      };
      const changed = {
        ...value,
        heldOutSeasons: value.heldOutSeasons.map((year, seasonIndex) => ({
          ...year,
          forecasts: year.forecasts.map((row, rowIndex) =>
            seasonIndex === 0 && rowIndex === 0 ? changeForecast(row) : row,
          ),
        })),
      };
      expect(() =>
        buildFrozenRosBenchmark(
          { original, comparisonManifestChecksum: sha256Hex("audited correction") },
          pin(changed),
          options,
        ),
      ).toThrow();
    },
  );

  it("rejects changed numerical scoring even when report and row pins are recomputed", () => {
    const original = rosMarginalIntervalQualificationFixtureInput().previous;
    const value = corrected(original);
    const rules = projectionScoringRulesFromProfileKey(value.source.scoringProfileKey).map(
      (rule, index) => (index === 0 ? { ...rule, points: rule.points + 1 } : rule),
    );
    const scoringProfileKey = projectionScoringProfileKey({ id: "changed-rule", rules });
    const changed = pin({
      ...value,
      source: { ...value.source, scoringProfileKey },
      heldOutSeasons: value.heldOutSeasons.map((year) => ({
        ...year,
        forecasts: year.forecasts.map((row) => ({ ...row, scoringProfileKey })),
      })),
    });
    expect(() =>
      buildFrozenRosBenchmark(
        { original, comparisonManifestChecksum: sha256Hex("audited correction") },
        changed,
        options,
      ),
    ).toThrow("numerical scoring rules differ");
  });

  it("requires both original row pins and an explicit correction manifest", () => {
    const original = rosMarginalIntervalQualificationFixtureInput().previous;
    expect(() =>
      buildFrozenRosBenchmark(
        { original, comparisonManifestChecksum: "" },
        corrected(original),
        options,
      ),
    ).toThrow("source checksum");
    expect(() =>
      buildFrozenRosBenchmark(
        {
          original: { ...original, rowsChecksum: sha256Hex("forged rows") },
          comparisonManifestChecksum: sha256Hex("audited correction"),
        },
        corrected(original),
        options,
      ),
    ).toThrow("rows do not match");
  });

  it("allows a definition-only annotation while preserving the original policy identity", () => {
    const annotated = rosMarginalIntervalQualificationFixtureInput().previous;
    const scoringProfileKey = projectionScoringProfileKey({
      id: "original-unannotated-profile",
      rules: projectionScoringRulesFromProfileKey(annotated.source.scoringProfileKey).map(
        (rule) => ({
          statId: rule.statId,
          points: rule.points,
          ...(rule.bonuses === undefined ? {} : { bonuses: rule.bonuses }),
        }),
      ),
    });
    const original = pin({
      ...annotated,
      source: { ...annotated.source, scoringProfileKey },
      heldOutSeasons: annotated.heldOutSeasons.map((year) => ({
        ...year,
        forecasts: year.forecasts.map((row) => ({ ...row, scoringProfileKey })),
      })),
    });
    const changed = corrected(annotated);
    const result = buildFrozenRosBenchmark(
      { original, comparisonManifestChecksum: sha256Hex("annotated correction") },
      changed,
      options,
    );
    expect(result.evaluation.livePolicy.evidenceIdentity?.scoringProfileKey).toBe(
      scoringProfileKey,
    );
    expect(result.binding.correctedObservations.source.scoringProfileKey).toBe(
      annotated.source.scoringProfileKey,
    );
  });

  it("rejects undeclared original forecast evidence before traversing an arbitrary proof tree", () => {
    const base = rosMarginalIntervalQualificationFixtureInput();
    const original = structuredClone(base.previous);
    const row = original.heldOutSeasons[0]!.forecasts[0]!;
    Object.assign(row.evidence, { unboundedProof: { nested: { ignoredByRowChecksum: true } } });
    expect(() =>
      buildRosMarginalIntervalQualificationSet({
        ...base,
        frozenPrevious: {
          original,
          comparisonManifestChecksum: sha256Hex("audited correction"),
        },
      }),
    ).toThrow("unknown or missing fields");
  });
});
