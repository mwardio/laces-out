import { describe, expect, it, vi } from "vitest";
import { rosScoringProfile } from "@laces-out/projections";
import { buildHistoricalRosBacktest } from "./first-party-ros-backtest.js";
import { historicalCorpusFixture } from "./ros-historical-outcome.test-fixtures.js";
import { replayRosHistoricalCorpus } from "./ros-historical-corpus-replay.js";
import { requireCorrectedRosDefenseEvidence } from "./ros-historical-defense-evidence.js";

const message = /Corrected provider-specific defense history/;
const evidence = {
  actualDefinitionVersion: "observed-weekly-components-complete-v1",
  pointsAllowedDefinition: "yahoo-2022-v1",
};

describe("legacy release defense evidence boundary", () => {
  it("requires corrected observed provenance and the exact provider, even without priced PA", () => {
    for (const invalid of [
      undefined,
      {},
      { ...evidence, actualDefinitionVersion: "old" },
      { ...evidence, pointsAllowedDefinition: undefined },
    ]) {
      expect(() =>
        requireCorrectedRosDefenseEvidence({ positions: ["DST"], evidence: invalid }),
      ).toThrow(message);
    }
    expect(() => requireCorrectedRosDefenseEvidence({ positions: ["WR"] })).not.toThrow();
    expect(() =>
      requireCorrectedRosDefenseEvidence({
        positions: ["DST"],
        evidence,
        scoringProfile: rosScoringProfile("full-ppr").profile,
      }),
    ).not.toThrow();
    expect(() =>
      requireCorrectedRosDefenseEvidence({
        positions: ["DST"],
        evidence,
        scoringProfile: rosScoringProfile("espn-ppr-4pt-pass").profile,
      }),
    ).toThrow(message);
  });

  it.each(["full-ppr", "espn-ppr-4pt-pass"] as const)(
    "rejects an old DST corpus before vector reads for %s",
    async (key) => {
      const base = historicalCorpusFixture();
      const corpus = {
        ...base,
        options: { ...base.options, positions: ["DST" as const] },
        forecasts: base.forecasts.map((row) => ({
          ...row,
          forecast: { ...row.forecast, position: "DST" as const },
        })),
      };
      const cache = {
        read: vi.fn(async () => ({ state: "missing" as const })),
        write: vi.fn(async () => {
          throw new Error("Must not write");
        }),
      };
      await expect(
        replayRosHistoricalCorpus({
          corpus,
          cache,
          scoringProfile: rosScoringProfile(key).profile,
        }),
      ).rejects.toThrow(message);
      expect(cache.read).not.toHaveBeenCalled();
      expect(cache.write).not.toHaveBeenCalled();
    },
  );

  it("refuses direct legacy D/ST rebuilding before fitting or simulation", async () => {
    const projectionEvaluator = vi.fn(async () => {
      throw new Error("Must not simulate");
    });
    const onProgress = vi.fn();
    await expect(
      buildHistoricalRosBacktest({
        history: [],
        defenseHistory: [],
        rosters: [],
        injuries: [],
        schedules: [],
        coverage: historicalCorpusFixture().coverage,
        scoringProfile: rosScoringProfile("full-ppr").profile,
        options: { heldOutSeasons: [2023, 2024, 2025], positions: ["DST"] },
        projectionEvaluator,
        onProgress,
      }),
    ).rejects.toThrow(message);
    expect(projectionEvaluator).not.toHaveBeenCalled();
    expect(onProgress).not.toHaveBeenCalled();
  });
});
