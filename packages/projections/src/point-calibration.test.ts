import { describe, expect, it } from "vitest";
import {
  evaluateFirstPartyBacktestForScoringProfile,
  runFirstPartyProjectionBacktest,
  type FirstPartyProjectionBacktest,
  type FirstPartyProjectionPosition,
} from "./first-party.js";
import {
  applyWeeklyPointCalibration,
  evaluateWeeklyPointCalibration,
  missingLongTouchdownScoringComponents,
  replayWeeklyPointCalibration,
  weeklyPointEvidenceConfidence,
  storedWeeklyPointPolicyVersion,
  WEEKLY_POINT_CALIBRATION_POLICY_VERSION,
  type WeeklyPointResidualCalibration,
} from "./point-calibration.js";

const profile = { id: "test", rules: [{ statId: "receiving_yards", points: 1 }] };
function fixture(
  positions: readonly FirstPartyProjectionPosition[] = ["WR"],
): FirstPartyProjectionBacktest {
  return {
    ...runFirstPartyProjectionBacktest([]),
    predictions: Array.from({ length: 12 }, (_, week) =>
      positions.flatMap((position) =>
        Array.from({ length: 48 }, (_, player) => {
          const raw = player / 2 + 1;
          const actual = raw * 0.5 + 2 + (((week + player) % 5) - 2) * 0.8;
          return {
            playerId: `${position}-${String(player).padStart(2, "0")}`,
            position,
            season: 2025,
            week: week + 1,
            predicted: { receiving_yards: raw },
            baseline: { receiving_yards: raw },
            actual: { receiving_yards: actual },
            floor: {},
            ceiling: {},
            trainingRows: 10,
            calibrationRows: 50,
          };
        }),
      ),
    ).flat(),
  };
}

function receiverCalibration(): WeeklyPointResidualCalibration {
  const result = evaluateWeeklyPointCalibration(fixture(), profile).byPosition.WR;
  if (result === undefined) throw new Error("Missing receiver calibration");
  return result;
}

describe("weekly point-layer calibration", () => {
  it("leaves QB and K calibration exactly unchanged", () => {
    const input = fixture(["QB", "K", "WR"]);
    const legacy = evaluateFirstPartyBacktestForScoringProfile(input, profile);
    const next = evaluateWeeklyPointCalibration(input, profile);
    expect(next.byPosition.QB).toEqual(legacy.byPosition.QB);
    expect(next.byPosition.K).toEqual(legacy.byPosition.K);
    expect(next.byPosition.WR?.pointPolicy?.version).toBe(WEEKLY_POINT_CALIBRATION_POLICY_VERSION);
    expect(next.modelVersion).toBe(input.modelVersion);
  });

  it("learns a shrunk affine center without modifying physical components", () => {
    const input = fixture();
    const original = structuredClone(input);
    const calibration = evaluateWeeklyPointCalibration(input, profile).byPosition.WR;
    expect(calibration?.pointPolicy?.slope).toBeGreaterThan(0.5);
    expect(calibration?.pointPolicy?.slope).toBeLessThan(0.6);
    expect(calibration?.mae).toBeLessThan(calibration?.baselineMae ?? 0);
    expect(input).toEqual(original);
  });

  it("freezes every target-week forecast before seeing any outcome in that week", () => {
    const input = fixture();
    const first = replayWeeklyPointCalibration(input, profile);
    const changed = replayWeeklyPointCalibration(
      {
        ...input,
        predictions: input.predictions.map((row) =>
          row.week === 8 ? { ...row, actual: { receiving_yards: 999 } } : row,
        ),
      },
      profile,
    );
    const pointOnly = (rows: typeof first.forecasts) =>
      rows.filter((row) => row.week <= 8).map((row) => ({ ...row, actual: 0 }));
    expect(pointOnly(changed.forecasts)).toEqual(pointOnly(first.forecasts));
    expect(
      first.forecasts.every(
        (row) => row.trainedThrough === null || row.trainedThrough < row.season * 25 + row.week,
      ),
    ).toBe(true);
  });

  it("is prefix invariant, including cohort ranks and conditional evidence", () => {
    const full = fixture();
    const prefix = { ...full, predictions: full.predictions.filter((row) => row.week <= 7) };
    const small = replayWeeklyPointCalibration(prefix, profile);
    const large = replayWeeklyPointCalibration(full, profile);
    expect(large.forecasts.filter((row) => row.week <= 7)).toEqual(small.forecasts);
    expect(small.evaluation.byPosition.WR?.starterIntervalQuality?.samples).toBe(6 * 36);
    expect(small.evaluation.byPosition.WR?.starterIntervalQuality?.cohort).toBe(
      "prior-baseline-position-rank",
    );
  });

  it("uses only the latest eight observed batches for the live point fit", () => {
    const input = fixture();
    const changed = {
      ...input,
      predictions: input.predictions.map((row) =>
        row.week <= 4 ? { ...row, actual: { receiving_yards: 999 } } : row,
      ),
    };
    const before = evaluateWeeklyPointCalibration(input, profile).byPosition.WR?.pointPolicy;
    const after = evaluateWeeklyPointCalibration(changed, profile).byPosition.WR?.pointPolicy;
    expect(after?.slope).toBe(before?.slope);
    expect(after?.intercept).toBe(before?.intercept);
    expect(after?.trainingSamples).toBe(8 * 48);
  });

  it("applies the same signed raw scale without treating a point center as the raw forecast", () => {
    const calibration = receiverCalibration();
    const pointPolicy = calibration.pointPolicy;
    if (pointPolicy === undefined) throw new Error("Missing policy");
    const fit = {
      ...calibration,
      pointPolicy: {
        ...pointPolicy,
        slope: 0.5,
        intercept: 2,
        lowerNormalizedError: -1,
        upperNormalizedError: 2,
      },
    };
    expect(applyWeeklyPointCalibration(16, fit)).toEqual({ mean: 10, floor: 6, ceiling: 18 });
    expect(applyWeeklyPointCalibration(-16, fit)).toEqual({ mean: -6, floor: -10, ceiling: 2 });
    expect(applyWeeklyPointCalibration(0, fit)).toEqual({ mean: 2, floor: 1, ceiling: 4 });
    expect(() => applyWeeklyPointCalibration(Number.NaN, fit)).toThrow("finite");
  });

  it("retains legacy point application, including a center outside residual quantiles", () => {
    expect(
      applyWeeklyPointCalibration(12, { centerAdjustment: -1, lowerError: 2, upperError: 5 }),
    ).toEqual({ mean: 11, floor: 11, ceiling: 16 });
  });

  it("keeps insufficient evidence explicit and caps confidence below the advice threshold", () => {
    const input = fixture();
    const calibration = evaluateWeeklyPointCalibration(
      { ...input, predictions: input.predictions.filter((row) => row.week <= 2) },
      profile,
    ).byPosition.WR;
    if (calibration === undefined) throw new Error("Missing calibration");
    expect(calibration.starterIntervalQuality).toMatchObject({
      state: "insufficient",
      samples: 36,
      qualityFlag: "uncalibrated_starter_intervals",
    });
    expect(weeklyPointEvidenceConfidence(0.95, calibration)).toBe(0.49);
    expect(weeklyPointEvidenceConfidence(0.3, calibration)).toBe(0.3);
    expect(
      weeklyPointEvidenceConfidence(0.95, { ...calibration, starterIntervalQuality: undefined }),
    ).toBe(0.49);
  });

  it("validates the type and version of stored point policies before trusting provenance", () => {
    const calibration = receiverCalibration();
    const metadata = {
      livePointCalibration: {
        policyVersion: WEEKLY_POINT_CALIBRATION_POLICY_VERSION,
        byPosition: { WR: calibration },
      },
    };
    expect(storedWeeklyPointPolicyVersion(metadata)).toBe(WEEKLY_POINT_CALIBRATION_POLICY_VERSION);
    expect(storedWeeklyPointPolicyVersion({})).toBeUndefined();
    expect(
      storedWeeklyPointPolicyVersion({
        livePointCalibration: { ...metadata.livePointCalibration, policyVersion: "older-version" },
      }),
    ).toBeUndefined();
    for (const bad of [
      undefined,
      { ...calibration.pointPolicy, slope: "0.5" },
      { ...calibration.pointPolicy, slope: 2 },
      { ...calibration.pointPolicy, intervalScale: "constant" },
      { ...calibration.pointPolicy, trainingSamples: -1 },
    ]) {
      expect(
        storedWeeklyPointPolicyVersion({
          livePointCalibration: {
            ...metadata.livePointCalibration,
            byPosition: { WR: { ...calibration, pointPolicy: bad } },
          },
        }),
      ).toBeUndefined();
    }
  });

  it("caps miscalibrated starter evidence even if whole-position evidence passes", () => {
    const calibration = receiverCalibration();
    const quality = calibration.starterIntervalQuality;
    if (quality === undefined) throw new Error("Missing quality");
    expect(
      weeklyPointEvidenceConfidence(0.95, {
        ...calibration,
        intervalCoverage: 0.7,
        starterIntervalQuality: { ...quality, state: "miscalibrated", samples: 200, coverage: 0.4 },
      }),
    ).toBe(0.49);
    expect(
      weeklyPointEvidenceConfidence(0.95, {
        ...calibration,
        starterIntervalQuality: { ...quality, state: "available", samples: 200, coverage: 0.7 },
      }),
    ).toBe(0.95);
    expect(weeklyPointEvidenceConfidence(Number.NaN, calibration)).toBe(0);
  });

  it("binds calibration to exact scoring and rejects duplicate player/week inputs", () => {
    const input = fixture();
    const normal = evaluateWeeklyPointCalibration(input, profile);
    const doubled = evaluateWeeklyPointCalibration(input, {
      ...profile,
      rules: [{ statId: "receiving_yards", points: 2 }],
    });
    expect(doubled.scoringProfileKey).not.toBe(normal.scoringProfileKey);
    expect(doubled.byPosition.WR?.mae).toBeCloseTo((normal.byPosition.WR?.mae ?? 0) * 2);
    const first = input.predictions[0];
    if (first === undefined) throw new Error("Missing fixture prediction");
    expect(() =>
      evaluateWeeklyPointCalibration(
        { ...input, predictions: [...input.predictions, first] },
        profile,
      ),
    ).toThrow("Duplicate");
  });

  it.each(["actual", "predicted", "baseline"] as const)(
    "withholds only affected positions when priced long-TD %s is unknown",
    (field) => {
      const source = fixture(["WR", "K"]);
      const bonusProfile = {
        ...profile,
        rules: [...profile.rules, { statId: "receiving_touchdowns_40_plus", points: 2 }],
      };
      const complete = {
        ...source,
        predictions: source.predictions.map((row) => ({
          ...row,
          predicted: { ...row.predicted, receiving_touchdowns_40_plus: 0 },
          baseline: { ...row.baseline, receiving_touchdowns_40_plus: 0 },
          actual: { ...row.actual, receiving_touchdowns_40_plus: 0 },
        })),
      };
      const missing = {
        ...complete,
        predictions: complete.predictions.map((row, index) =>
          index === 0 ? { ...row, [field]: { receiving_yards: 2 } } : row,
        ),
      };
      const full = evaluateWeeklyPointCalibration(complete, bonusProfile);
      const partial = evaluateWeeklyPointCalibration(missing, bonusProfile);
      expect(full.byPosition.WR?.samples).toBe(576);
      expect(partial.byPosition.WR).toMatchObject({
        samples: 0,
        componentCoverage: {
          state: "unavailable",
          missingStatIds: ["receiving_touchdowns_40_plus"],
        },
      });
      expect(partial.byPosition.K).toEqual(full.byPosition.K);
      expect(evaluateWeeklyPointCalibration(missing, profile).byPosition.WR?.samples).toBe(576);
    },
  );

  it.each(["QB", "RB", "WR", "TE"] as const)(
    "requires only the %s vocabulary for a profile pricing all six long-TD bonuses",
    (position) => {
      const all = ["passing", "rushing", "receiving"].flatMap((family) => [
        `${family}_touchdowns_40_plus`,
        `${family}_touchdowns_50_plus`,
      ]);
      const relevant = all.filter((statId) =>
        position === "QB" ? !statId.startsWith("receiving_") : !statId.startsWith("passing_"),
      );
      const allBonusProfile = {
        id: "all-long-touchdown-bonuses",
        rules: all.map((statId) => ({ statId, points: 2 })),
      };
      const components = Object.fromEntries(relevant.map((statId) => [statId, 0]));
      expect(missingLongTouchdownScoringComponents(components, allBonusProfile, position)).toEqual(
        [],
      );
      // Even if its parent TD total is absent too, a missing modeled event stays unknown.
      delete components[relevant[0]!];
      expect(missingLongTouchdownScoringComponents(components, allBonusProfile, position)).toEqual([
        relevant[0],
      ]);
    },
  );
});
