import { describe, expect, it } from "vitest";
import {
  certifyConditionalQuantile,
  CONDITIONAL_QUANTILE_NUMERICS,
  solveConditionalQuantile,
  type ConditionalQuantile,
  type ConditionalQuantileInput,
  type ConditionalQuantileSolution,
} from "./conditional-quantile-solver.js";

function certified(input: ConditionalQuantileInput) {
  const result = solveConditionalQuantile(input);
  expect(result.status, JSON.stringify(result)).toBe("certified");
  if (result.status !== "certified") throw new Error(result.reason);
  expect(certifyConditionalQuantile(input, result)).toEqual(result.certificate);
  return result;
}
function objective(input: ConditionalQuantileInput, intercept: number, slope: number) {
  return input.rows.reduce(
    (total, row) => {
      const residual = row.residual - intercept - slope * row.feature;
      return total + row.weight * residual * (input.quantile - (residual < 0 ? 1 : 0));
    },
    (slope * slope) / 4,
  );
}
const QUANTILES = [0.15, 0.5, 0.85] as const;

describe("certified regularized conditional quantile solver", () => {
  it("recovers the exact two-point conditional signal with jointly assigned tied atoms", () => {
    const input: ConditionalQuantileInput = {
      quantile: 0.5,
      rows: [
        { residual: -1, feature: -1, weight: 0.5 },
        { residual: 1, feature: 1, weight: 0.5 },
      ],
    };
    const result = certified(input);
    expect(result.intercept).toBe(0);
    expect(result.slope).toBe(1);
    expect(result.dualWeights).toEqual([-0.25, 0.25]);
    expect(result.certificate.interceptInterval).toEqual([0, 0]);
    expect(result.certificate.diagnostics.primalObjective).toBe(0.25);
    expect(result.certificate.diagnostics.primalDualGap).toBe(0);
  });

  it("reports the complete nonunique intercept interval and its midpoint", () => {
    const result = certified({
      quantile: 0.5,
      rows: [
        { residual: -2, feature: -1, weight: 0.5 },
        { residual: 2, feature: 1, weight: 0.5 },
      ],
    });
    expect(result.slope).toBe(1);
    expect(result.intercept).toBe(0);
    expect(result.certificate.interceptInterval).toEqual([-1, 1]);
    expect(result.certificate.diagnostics.primalObjective).toBe(0.75);
  });

  it("rounds the midpoint correctly for a subnormal intercept interval", () => {
    const result = certified({
      quantile: 0.5,
      rows: [
        { residual: Number.MIN_VALUE, feature: 0, weight: 0.5 },
        { residual: 2 * Number.MIN_VALUE, feature: 0, weight: 0.5 },
      ],
    });
    expect(result.intercept).toBe(2 * Number.MIN_VALUE);
    expect(result.certificate.interceptInterval).toEqual([Number.MIN_VALUE, 2 * Number.MIN_VALUE]);
  });

  it.each(QUANTILES)("matches the exact three-point atom solution for tau=%s", (quantile) => {
    const result = certified({
      quantile,
      rows: [
        { residual: -2, feature: -1, weight: 0.25 },
        { residual: 0, feature: 0, weight: 0.5 },
        { residual: 2, feature: 1, weight: 0.25 },
      ],
    });
    const expectedSlope = quantile === 0.5 ? 0.5 : 0.3;
    expect(result.slope).toBeCloseTo(expectedSlope, 10);
    expect(result.intercept).toBeCloseTo(quantile === 0.5 ? 0 : quantile === 0.15 ? -1.7 : 1.7, 10);
  });

  it.each(QUANTILES)(
    "represents an intercept-only constant feature explicitly at tau=%s",
    (quantile) => {
      const rows = Array.from({ length: 20 }, (_, index) => ({
        residual: index - 10,
        feature: 1.75,
        weight: 1 / 20,
      }));
      const result = certified({ quantile, rows });
      expect(result.slope).toBe(0);
      const lower = quantile * 20 - 11;
      expect(result.certificate.interceptInterval).toEqual([lower, lower + 1]);
      expect(result.intercept).toBe(lower + 0.5);
      expect(result.certificate.diagnostics.constantFeature).toBe(true);
    },
  );

  it.each(QUANTILES)(
    "handles all-equal residual atoms with varied features at tau=%s",
    (quantile) => {
      const result = certified({
        quantile,
        rows: Array.from({ length: 101 }, (_, index) => ({
          residual: 3,
          feature: (index - 50) / 25,
          weight: 1 / 101,
        })),
      });
      expect(result.intercept).toBe(3);
      expect(result.slope).toBe(0);
      expect(result.certificate.diagnostics.nearAtomCount).toBe(101);
    },
  );

  it("does not turn a tiny positive mass into a false quantile tie", () => {
    const result = certified({
      quantile: 0.5,
      rows: [
        { residual: 0, feature: 0, weight: 0.5 },
        { residual: 1, feature: 0, weight: Number.MIN_VALUE },
        { residual: 2, feature: 0, weight: 0.5 },
      ],
    });
    expect(result.certificate.interceptInterval).toEqual([1, 1]);
    expect(result.intercept).toBe(1);
  });

  it("uses optional exact rational weights to preserve unequal-block mass ties", () => {
    const rows = [
      { residual: 0, feature: 0, weight: 1 / 2, weightDenominator: 2 },
      { residual: 1, feature: 0, weight: 1 / 3, weightDenominator: 3 },
      { residual: 2, feature: 0, weight: 1 / 6, weightDenominator: 6 },
    ];
    const exact = certified({ quantile: 0.5, rows });
    expect(exact.certificate.interceptInterval).toEqual([0, 1]);
    expect(exact.intercept).toBe(0.5);
    // The actual supplied binary approximations have slightly less than half above zero.
    const binary = certified({
      quantile: 0.5,
      rows: rows.map(({ residual, feature, weight }) => ({ residual, feature, weight })),
    });
    expect(binary.certificate.interceptInterval).toEqual([0, 0]);
  });

  it.each(QUANTILES)(
    "preserves offset and signed feature/quantile symmetry at tau=%s",
    (quantile) => {
      const rows = [
        { residual: -3.7, feature: -2, weight: 0.125 },
        { residual: -1, feature: -0.3, weight: 0.25 },
        { residual: 1.1, feature: 0.4, weight: 0.125 },
        { residual: 1.1, feature: 0.9, weight: 0.25 },
        { residual: 5, feature: 2, weight: 0.25 },
      ];
      const original = certified({ quantile, rows });
      const offset = certified({
        quantile,
        rows: rows.map((row) => ({ ...row, residual: row.residual + 7 })),
      });
      expect(offset.intercept).toBeCloseTo(original.intercept + 7, 8);
      expect(offset.slope).toBeCloseTo(original.slope, 8);
      const reversedQuantile: ConditionalQuantile =
        quantile === 0.15 ? 0.85 : quantile === 0.85 ? 0.15 : 0.5;
      const reversed = certified({
        quantile: reversedQuantile,
        rows: rows.map((row) => ({ ...row, residual: -row.residual, feature: -row.feature })),
      });
      expect(reversed.intercept).toBeCloseTo(-original.intercept, 8);
      expect(reversed.slope).toBeCloseTo(original.slope, 8);
    },
  );

  it("is deterministic, does not mutate frozen input, and is insensitive to row permutation", () => {
    const rows = Object.freeze(
      Array.from({ length: 31 }, (_, index) =>
        Object.freeze({
          residual: Math.sin(index) + index / 7,
          feature: (index - 15) / 8,
          weight: 1 / 31,
        }),
      ),
    );
    const input = Object.freeze({ quantile: 0.85 as const, rows });
    const before = JSON.stringify(input);
    const result = certified(input);
    expect(solveConditionalQuantile(input)).toEqual(result);
    expect(JSON.stringify(input)).toBe(before);
    const reversed = certified({ quantile: input.quantile, rows: [...rows].reverse() });
    expect(reversed.intercept).toBeCloseTo(result.intercept, 9);
    expect(reversed.slope).toBeCloseTo(result.slope, 9);
  });

  it("beats an independently enumerated intercept/slope grid for diverse bounded cases", () => {
    for (const quantile of QUANTILES) {
      for (let example = 0; example < 12; example++) {
        const rows = Array.from({ length: 8 }, (_, index) => ({
          residual: Math.sin((index + 1) * (example + 1)) * 3,
          feature: Math.cos(index * 3 + example) * 2,
          weight: 1 / 8,
        }));
        const input = { quantile, rows };
        const result = certified(input);
        const obtained = objective(input, result.intercept, result.slope);
        for (let slope = -2; slope <= 2; slope += 0.1) {
          // For a fixed slope a minimizing intercept must be a residual-feature atom.
          for (const row of rows) {
            expect(obtained).toBeLessThanOrEqual(
              objective(input, row.residual - slope * row.feature, slope) + 1e-9,
            );
          }
        }
      }
    }
  });

  it("certifies the supported 6,000-row boundary with linear-sized dual output", () => {
    const result = certified({
      quantile: 0.5,
      rows: Array.from({ length: 6_000 }, (_, index) => ({
        residual: (index % 17) - 8,
        feature: ((index % 13) - 6) / 3,
        weight: 1 / 6_000,
      })),
    });
    expect(result.dualWeights).toHaveLength(6_000);
    expect(result.iterations).toBeLessThanOrEqual(CONDITIONAL_QUANTILE_NUMERICS.maximumIterations);
  });
});

describe("independent certificate failures", () => {
  const input: ConditionalQuantileInput = {
    quantile: 0.5,
    rows: [
      { residual: -2, feature: -1, weight: 0.5 },
      { residual: 2, feature: 1, weight: 0.5 },
    ],
  };
  it("rejects an optimal but noncanonical endpoint of a minimizing intercept interval", () => {
    const result = certified(input);
    expect(certifyConditionalQuantile(input, { ...result, intercept: -1 })).toMatchObject({
      certified: false,
      reason: "intercept is not the complete minimizer interval midpoint",
    });
  });
  it("rejects box violations, incorrect joint mass, wrong moment and broken complementarity", () => {
    const result = certified(input);
    for (const dualWeights of [
      [-0.26, 0.26],
      [-0.25, 0.2],
      [0.25, -0.25],
      [0, 0],
    ]) {
      expect(certifyConditionalQuantile(input, { ...result, dualWeights }).certified).toBe(false);
    }
    const noSlope = { ...result, slope: 0, dualWeights: [0, 0] };
    expect(certifyConditionalQuantile(input, noSlope)).toMatchObject({
      certified: false,
      reason: "dual complementarity failed",
    });
  });
  it("does not accept finite but uncertifiable objective cancellation", () => {
    const result = solveConditionalQuantile({
      quantile: 0.5,
      rows: [
        { residual: -1e12, feature: -1, weight: 0.5 },
        { residual: 1e12, feature: 1, weight: 0.5 },
      ],
    });
    expect(result).toMatchObject({
      status: "unavailable",
      reason: "objective precision cannot certify the fixed tolerance",
    });
  });
  it("rejects non-finite intermediate residual arithmetic without clipping or zeroing", () => {
    expect(
      solveConditionalQuantile({
        quantile: 0.5,
        rows: [
          { residual: Number.MAX_VALUE, feature: 0, weight: 2 / 3 },
          { residual: -Number.MAX_VALUE, feature: 0, weight: 1 / 3 },
        ],
      }),
    ).toMatchObject({ status: "unavailable" });
  });
  it("requires complete, consistent and exactly normalized rational weight metadata", () => {
    for (const rows of [
      [{ residual: 0, feature: 0, weight: 1, weightDenominator: 2 }],
      [{ residual: 0, feature: 0, weight: 1, weightDenominator: 1.5 }],
      [
        { residual: 0, feature: 0, weight: 0.5, weightDenominator: 2 },
        { residual: 1, feature: 0, weight: 0.5 },
      ],
      [
        { residual: 0, feature: 0, weight: 1, weightDenominator: 1 },
        { residual: 1, feature: 0, weight: 1e-15, weightDenominator: 1e15 },
      ],
    ])
      expect(solveConditionalQuantile({ quantile: 0.5, rows })).toMatchObject({
        status: "unavailable",
      });
  });
  it("does not give tiny rows an absolute dual-box allowance", () => {
    const tinyInput: ConditionalQuantileInput = {
      quantile: 0.5,
      rows: [
        { residual: 0, feature: 0, weight: 1e-200 },
        { residual: 0, feature: 0, weight: 1 },
      ],
    };
    expect(
      certifyConditionalQuantile(tinyInput, {
        intercept: 0,
        slope: 0,
        dualWeights: [1e-100, -1e-100],
      }),
    ).toMatchObject({ certified: false, reason: "dual box constraint failed" });
  });
  it.each([
    { quantile: 0.2, rows: input.rows },
    { quantile: 0.5, rows: [] },
    { quantile: 0.5, rows: Array(2) },
    { quantile: 0.5, rows: [{ residual: NaN, feature: 0, weight: 1 }] },
    { quantile: 0.5, rows: [{ residual: 0, feature: Infinity, weight: 1 }] },
    { quantile: 0.5, rows: [{ residual: 0, feature: 2.0000000001, weight: 1 }] },
    { quantile: 0.5, rows: [{ residual: 0, feature: 0, weight: 0 }] },
    { quantile: 0.5, rows: [{ residual: 0, feature: 0, weight: -1 }] },
    { quantile: 0.5, rows: [{ residual: 0, feature: 0, weight: 0.999 }] },
    {
      quantile: 0.5,
      rows: Array.from({ length: 6_001 }, () => ({ residual: 0, feature: 0, weight: 1 / 6_001 })),
    },
  ])("fails closed for malformed input %#", (bad) => {
    expect(solveConditionalQuantile(bad as ConditionalQuantileInput)).toMatchObject({
      status: "unavailable",
    });
  });
  it("rejects sparse or non-finite certificate vectors and does not trust a stored verdict", () => {
    const result: ConditionalQuantileSolution = certified(input);
    for (const dualWeights of [Array(2) as number[], [NaN, 0], [Infinity, 0], [0]]) {
      expect(certifyConditionalQuantile(input, { ...result, dualWeights }).certified).toBe(false);
    }
  });
});
