import { describe, expect, it } from "vitest";
import {
  groupLocalResiduals,
  localEffectiveSupport,
  localMidpointResidualQuantile,
  localRationalNumber,
  localWeightMasses,
} from "./local-weighted-quantile.js";

describe("local weighted midpoint quantiles", () => {
  it("interpolates midpoint knots and groups ties without treating them as separate jumps", () => {
    const groups = groupLocalResiduals([0, 10]);
    const mass = localWeightMasses([1, 3]);
    expect(localMidpointResidualQuantile(groups, mass, 3)).toBeCloseTo(0.5, 14);
    expect(localMidpointResidualQuantile(groups, mass, 10)).toBe(7.5);
    expect(localMidpointResidualQuantile(groups, mass, 17)).toBe(10);
    expect(
      localMidpointResidualQuantile(
        groupLocalResiduals([0, -0, 10]),
        localWeightMasses([1, 1, 2]),
        10,
      ),
    ).toBe(5);
    expect(localMidpointResidualQuantile(groups, localWeightMasses([6, 14]), 3)).toBe(0);
  });

  it("is invariant to a matching permutation and exactly representable common weight scaling", () => {
    const values = [-7, -3, 2, 2, 19];
    const weights = [1, 3, 2, 4, 1];
    for (const probability of [3, 10, 17] as const) {
      const expected = localMidpointResidualQuantile(
        groupLocalResiduals(values),
        localWeightMasses(weights),
        probability,
      );
      expect(
        localMidpointResidualQuantile(
          groupLocalResiduals(values.toReversed()),
          localWeightMasses(weights.toReversed().map((v) => v * 8)),
          probability,
        ),
      ).toBe(expected);
    }
    expect(
      localMidpointResidualQuantile(groupLocalResiduals([-9, -9]), localWeightMasses([1, 100]), 17),
    ).toBe(-9);
  });

  it("preserves the entire representable binary64 weight range", () => {
    const masses = localWeightMasses([Number.MIN_VALUE, 1, Number.MAX_VALUE]);
    expect(masses[0]).toBe(1n);
    expect(masses[1]).toBe(1n << 1074n);
    expect(localMidpointResidualQuantile(groupLocalResiduals([-1, 0, 1]), masses, 10)).toBe(1);
    expect(localEffectiveSupport(masses, 18).sufficient).toBe(false);
    for (const invalid of [0, -1, Infinity, NaN])
      expect(() => localWeightMasses([invalid])).toThrow();
  });

  it("keeps group partitions private and rejects forged or mismatched prepared inputs", () => {
    const prepared = groupLocalResiduals([0, 1]);
    expect(() => localMidpointResidualQuantile({ ...prepared }, [1n, 1n], 10)).toThrow(/request/);
    expect(() => localMidpointResidualQuantile(prepared, [1n], 10)).toThrow(/masses/);
    expect(() => groupLocalResiduals([NaN])).toThrow(/nonfinite/);
    const values = [0, 10];
    const detached = groupLocalResiduals(values);
    values[1] = NaN;
    expect(localMidpointResidualQuantile(detached, [1n, 1n], 10)).toBe(5);
  });

  it("uses exact ESS decisions even when displayed ESS rounds to the threshold", () => {
    expect(localEffectiveSupport(localWeightMasses(Array<number>(18).fill(1)), 18)).toEqual({
      sufficient: true,
      effective: 18,
    });
    const perturbed = [...Array<number>(17).fill(1), 1 + Number.EPSILON];
    expect(localEffectiveSupport(localWeightMasses(perturbed), 18)).toEqual({
      sufficient: false,
      effective: 18,
    });
    expect(localEffectiveSupport([1n, 1n, 1n], 3).sufficient).toBe(true);
    expect(localEffectiveSupport([1n, 1n, 2n], 3).sufficient).toBe(false);
  });

  it("rounds huge rational integers with ties to even and correct subnormal behavior", () => {
    const huge = 1n << 2000n;
    expect(localRationalNumber(huge, huge * 2n)).toBe(0.5);
    expect(localRationalNumber((1n << 53n) + 1n, 1n << 53n)).toBe(1);
    expect(localRationalNumber((1n << 53n) + 3n, 1n << 53n)).toBe(1 + 2 ** -51);
    expect(localRationalNumber(1n, 1n << 1075n)).toBe(0);
    expect(localRationalNumber(3n, 1n << 1075n)).toBe(2 * Number.MIN_VALUE);
    expect(() => localRationalNumber(1n << 1024n, 1n)).toThrow(/overflow/);
    expect(() => localRationalNumber(-1n, 2n)).toThrow();
  });
});
