import { describe, expect, it } from "vitest";
import type { LockedPointForecast } from "./point-calibration.js";
import {
  applyWeeklyIntervalPolicy,
  fitWeeklyIntervalPolicy,
  isWeeklyIntervalPolicy,
  replayWeeklyIntervalCalibration,
  storedWeeklyIntervalPolicyVersion,
  storedWeeklyIntervalPolicyProvenance,
  WEEKLY_INTERVAL_CALIBRATION_POLICY_VERSION,
} from "./weekly-interval-calibration.js";

function fixture(): LockedPointForecast[] {
  return Array.from({ length: 12 }, (_, week) =>
    Array.from({ length: 60 }, (_, index) => {
      const rawMean = index - 10;
      const mean = rawMean * 0.75 + 2;
      return {
        playerId: `wr-${String(index).padStart(2, "0")}`,
        position: "WR" as const,
        season: 2025,
        week: week + 1,
        rawMean,
        baselineRawMean: rawMean,
        mean,
        baselineMean: rawMean,
        actual:
          mean + (((index * 7 + week * 3) % 19) - 9) * Math.sqrt(Math.max(1, Math.abs(rawMean))),
        ...(week === 0 ? {} : { floor: mean - 5, ceiling: mean + 6 }),
        priorBaselineRank: 60 - index,
        trainedThrough: week === 0 ? null : 2025 * 25 + week,
      };
    }),
  ).flat();
}

describe("separate weekly conditional interval policy", () => {
  it("uses the median Nth raw forecast from only the latest eight observed batches", () => {
    const rows = fixture();
    const policy = fitWeeklyIntervalPolicy(rows, "WR");
    expect(policy.cutoff).toBe(14);
    expect(policy.weekBatches).toBe(8);
    expect(policy.pooled?.samples).toBe(480);
    expect(policy.trainedThrough).toBe(2025 * 25 + 12);
    const changed = rows.map((row) =>
      row.week <= 4 ? { ...row, rawMean: 999, actual: 999 } : row,
    );
    expect(fitWeeklyIntervalPolicy(changed, "WR")).toEqual(policy);
    expect(isWeeklyIntervalPolicy(policy)).toBe(true);
  });

  it("preserves all centers, non-interval fields, source arrays and initial warmup", () => {
    const rows = fixture();
    const copy = structuredClone(rows);
    const result = replayWeeklyIntervalCalibration(rows);
    expect(rows).toEqual(copy);
    for (const [index, row] of result.forecasts.entries()) {
      expect({ ...row, floor: undefined, ceiling: undefined }).toEqual({
        ...rows[index]!,
        floor: undefined,
        ceiling: undefined,
      });
      if (row.week === 1) expect(row.floor).toBeUndefined();
      else expect(row.floor).toBeLessThanOrEqual(row.mean);
    }
    expect(result.byPosition.WR?.samples).toBe(660);
    expect(result.byPosition.WR?.starters.samples).toBe(396);
    expect(result.byPosition.WR?.meanIntervalScore).toBeGreaterThan(0);
  });

  it("is prefix invariant and cannot use any target-week outcome", () => {
    const rows = fixture();
    const original = replayWeeklyIntervalCalibration(rows);
    const prefix = rows.filter((row) => row.week <= 6);
    expect(replayWeeklyIntervalCalibration(prefix).forecasts).toEqual(
      original.forecasts.filter((row) => row.week <= 6),
    );
    const changed = rows.map((row) => (row.week === 6 ? { ...row, actual: 10000 } : row));
    const removeActual = (values: readonly LockedPointForecast[]) =>
      values.filter((row) => row.week <= 6).map((row) => ({ ...row, actual: 0 }));
    expect(removeActual(replayWeeklyIntervalCalibration(changed).forecasts)).toEqual(
      removeActual(original.forecasts),
    );
  });

  it("uses pooled tails for sparse bins and handles cutoff equality and negative raw scores", () => {
    const policy = fitWeeklyIntervalPolicy(fixture(), "WR");
    const sparse = {
      ...policy,
      above: { samples: 2, lower: -100, upper: 100 },
      below: { ...policy.below!, samples: policy.pooled!.samples - 2 },
    };
    const original = { mean: -3, floor: -4, ceiling: 0 };
    const result = applyWeeklyIntervalPolicy(100, original, sparse);
    expect(result).toEqual({
      mean: -3,
      floor: Math.min(-3, -3 + 10 * policy.pooled!.lower),
      ceiling: Math.max(-3, -3 + 10 * policy.pooled!.upper),
    });
    expect(applyWeeklyIntervalPolicy(-16, original, policy).mean).toBe(-3);
    const atCutoff = applyWeeklyIntervalPolicy(policy.cutoff!, original, policy);
    expect(atCutoff.floor).toBe(Math.min(-3, -3 + Math.sqrt(policy.cutoff!) * policy.above!.lower));
  });

  it("rejects malformed policies and preserves the original validated interval", () => {
    const policy = fitWeeklyIntervalPolicy(fixture(), "WR");
    const original = { mean: 2, floor: -1, ceiling: 8 };
    for (const malformed of [
      null,
      {},
      { ...policy, version: "other" },
      { ...policy, cutoff: Number.NaN },
      { ...policy, pooled: { samples: 0, lower: -1, upper: 1 } },
      { ...policy, above: { ...policy.above, lower: 10, upper: -10 } },
      { ...policy, weekBatches: 9 },
      { ...policy, above: null },
    ]) {
      expect(isWeeklyIntervalPolicy(malformed)).toBe(false);
      expect(applyWeeklyIntervalPolicy(12, original, malformed)).toBe(original);
    }
    expect(applyWeeklyIntervalPolicy(12, original, fitWeeklyIntervalPolicy([], "WR"))).toBe(
      original,
    );
  });

  it("validates stored interval provenance without executing the stored policy", () => {
    const policy = fitWeeklyIntervalPolicy(fixture(), "WR");
    const metadata = {
      intervalPolicyByPlayer: {
        player: {
          version: WEEKLY_INTERVAL_CALIBRATION_POLICY_VERSION,
          position: "WR",
          origin: "current",
        },
      },
      weeklyIntervalCalibration: {
        policyVersion: WEEKLY_INTERVAL_CALIBRATION_POLICY_VERSION,
        byPosition: { WR: { policy } },
      },
    };
    expect(storedWeeklyIntervalPolicyVersion(metadata, "player")).toBe(
      WEEKLY_INTERVAL_CALIBRATION_POLICY_VERSION,
    );
    expect(storedWeeklyIntervalPolicyProvenance(metadata, "player")).toEqual({
      version: WEEKLY_INTERVAL_CALIBRATION_POLICY_VERSION,
      position: "WR",
    });
    expect(storedWeeklyIntervalPolicyVersion(metadata, "missing")).toBeUndefined();
    expect(
      storedWeeklyIntervalPolicyVersion(
        {
          ...metadata,
          weeklyIntervalCalibration: {
            ...metadata.weeklyIntervalCalibration,
            byPosition: { WR: { policy: { ...policy, position: "TE" } } },
          },
        },
        "player",
      ),
    ).toBeUndefined();
    expect(
      storedWeeklyIntervalPolicyVersion({ ...metadata, weeklyIntervalCalibration: {} }, "player"),
    ).toBeUndefined();
  });

  it("restores the original frozen role and refuses missing or conflicting role evidence", () => {
    const policy = fitWeeklyIntervalPolicy(fixture(), "WR");
    const metadata = {
      intervalPolicyByPlayer: {
        player: {
          version: WEEKLY_INTERVAL_CALIBRATION_POLICY_VERSION,
          position: "WR",
          origin: "frozen",
        },
      },
      frozenIntervalPolicyVersions: { player: WEEKLY_INTERVAL_CALIBRATION_POLICY_VERSION },
      weeklyIntervalCalibration: {
        policyVersion: WEEKLY_INTERVAL_CALIBRATION_POLICY_VERSION,
        byPosition: { WR: { policy }, TE: { policy: { ...policy, position: "TE" } } },
      },
    };
    expect(storedWeeklyIntervalPolicyProvenance(metadata, "player")?.position).toBe("WR");
    expect(
      storedWeeklyIntervalPolicyProvenance({ ...metadata, weeklyIntervalCalibration: {} }, "player")
        ?.position,
    ).toBe("WR");
    for (const frozenIntervalPolicyVersions of [undefined, {}, { player: "unknown" }]) {
      expect(
        storedWeeklyIntervalPolicyProvenance(
          { ...metadata, frozenIntervalPolicyVersions },
          "player",
        ),
      ).toBeUndefined();
    }
    for (const position of [undefined, "QB"]) {
      expect(
        storedWeeklyIntervalPolicyProvenance(
          {
            ...metadata,
            intervalPolicyByPlayer: {
              player: { ...metadata.intervalPolicyByPlayer.player, position },
            },
          },
          "player",
        ),
      ).toBeUndefined();
    }
  });
});
