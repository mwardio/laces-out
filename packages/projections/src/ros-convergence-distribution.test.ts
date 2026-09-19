import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  measureRosConvergenceDistribution,
  ROS_CONVERGENCE_SCORE_VECTOR_VERSION,
  rosConvergenceDistributionMatchesScores,
  type RosConvergenceDistributionInput,
  type RosConvergenceDistributionProvenance,
} from "./ros-convergence-distribution.js";
import { projectionScoringProfileKey } from "./scoring.js";

const N = 16_384;
const RELEASE = 12_288;
const source: RosConvergenceDistributionProvenance = {
  modelVersion: "test-physical-model-α",
  scorerVersion: "test-canonical-scorer-v1",
  scoringProfileKey: projectionScoringProfileKey({
    id: "custom-defense",
    rules: [
      { statId: "defensiveSacks", points: 0.25 },
      { statId: "defensivePointsAllowed", points: -0.01 },
      { statId: "defensiveTouchdowns", points: 6 },
    ],
  }),
  seedHash: "a".repeat(64),
  inputChecksum: "b".repeat(64),
  vectorChecksum: "c".repeat(64),
};

function input(
  scores: readonly number[] | Float64Array = Array<number>(N).fill(0),
): RosConvergenceDistributionInput {
  return { scores, provenance: { ...source }, familySize: 24, familyErrorBudget: 0.01 };
}

function histogram(...entries: readonly [number, number][]): number[] {
  return entries.flatMap(([score, count]) => Array<number>(count).fill(score));
}

// Numerical fixtures only: this ordered histogram does not assert real PRNG independence.
function hiddenDrift(): number[] {
  return [...histogram([0, 6141], [1, 6144], [2, 3]), ...histogram([0, 3072], [2, 1023], [4, 1])];
}

function boundary(): number[] {
  return [...histogram([0, 6145], [1, 6143]), ...histogram([0, 2045], [1, 2051])];
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, entry]) => [key, reverseKeys(entry)]),
    );
  return value;
}

describe("ROS convergence distribution measurement", () => {
  it("exposes a large hidden CDF shift despite identical mean and tail quantiles and a one-point median jump", () => {
    const scores = hiddenDrift();
    const mean = (values: readonly number[]) =>
      values.reduce((sum, value) => sum + value, 0) / values.length;
    expect(mean(scores.slice(0, RELEASE))).toBe(1025 / 2048);
    expect(mean(scores)).toBe(1025 / 2048);
    const result = measureRosConvergenceDistribution(input(scores));
    expect(result.quantileRanks.map((q) => q.prefixType7)).toEqual([0, 1, 1]);
    expect(result.quantileRanks.map((q) => q.fullType7)).toEqual([0, 0, 1]);
    expect(result.prefixVsSuffix).toEqual({
      leftSamples: RELEASE,
      rightSamples: 4096,
      numerator: 1025,
      denominator: 4096,
      fraction: 1025 / 4096,
      score: 0,
      leftAtOrBelow: 6141,
      rightAtOrBelow: 3072,
      direction: "right-above",
    });
    expect(result.prefixVsFull.numerator).toBe(1025);
    expect(result.prefixVsFull.denominator).toBe(16_384);
    expect(result.prefixVsFull.fraction).toBe(result.prefixVsSuffix.fraction / 4);
    expect(result).not.toHaveProperty("state");
    expect(result).not.toHaveProperty("passed");
    expect(result.purpose).toBe("numerical-measurement-only");
  });

  it("describes a benign median boundary with exact tiny drift and tied cross-CDF ranks", () => {
    const result = measureRosConvergenceDistribution(input(boundary()));
    const median = result.quantileRanks[1]!;
    expect([median.prefixType7, median.fullType7]).toEqual([0, 1]);
    expect(result.prefixVsSuffix).toMatchObject({ numerator: 5, denominator: 6144, score: 0 });
    expect(result.prefixVsFull).toMatchObject({ numerator: 5, denominator: 24_576, score: 0 });
    expect(median.atPrefixType7).toEqual({
      prefix: {
        samples: RELEASE,
        below: 0,
        equal: 6145,
        atOrBelow: 6145,
        belowFraction: 0,
        atOrBelowFraction: 6145 / RELEASE,
      },
      suffix: {
        samples: 4096,
        below: 0,
        equal: 2045,
        atOrBelow: 2045,
        belowFraction: 0,
        atOrBelowFraction: 2045 / 4096,
      },
      full: {
        samples: N,
        below: 0,
        equal: 8190,
        atOrBelow: 8190,
        belowFraction: 0,
        atOrBelowFraction: 8190 / N,
      },
    });
    expect(median.atFullType7.full).toMatchObject({ below: 8190, equal: 8194, atOrBelow: N });
    const bounds = result.precision.quantileBounds[1]!;
    for (const partition of [bounds.prefix, bounds.suffix, bounds.full]) {
      expect(partition.lower).toMatchObject({ kind: "finite", value: 0 });
      expect(partition.upper).toMatchObject({ kind: "finite", value: 1 });
    }
  });

  it("keeps constant scores and zero distance exact without manufacturing uncertainty in score units", () => {
    const result = measureRosConvergenceDistribution(input(Array<number>(N).fill(-3.75)));
    expect(result.prefixVsSuffix).toMatchObject({
      numerator: 0,
      denominator: 1,
      fraction: 0,
      score: -3.75,
      direction: "equal",
    });
    for (const row of result.precision.quantileBounds)
      for (const partition of [row.prefix, row.suffix, row.full]) {
        expect(partition.lower).toMatchObject({ kind: "finite", value: -3.75 });
        expect(partition.upper).toMatchObject({ kind: "finite", value: -3.75 });
      }
    expect(
      result.quantileRanks.every((q) => q.prefixType7 === -3.75 && q.fullType7 === -3.75),
    ).toBe(true);
  });

  it.each([
    [0.125, -7.75],
    [6, 100],
    [1, -1000],
  ] as const)(
    "preserves CDF distances under positive affine scores scale=%s offset=%s",
    (scale, offset) => {
      const original = measureRosConvergenceDistribution(input(hiddenDrift()));
      const transformed = measureRosConvergenceDistribution(
        input(hiddenDrift().map((score) => score * scale + offset)),
      );
      expect(transformed.prefixVsSuffix.fraction).toBe(original.prefixVsSuffix.fraction);
      expect(transformed.prefixVsFull.fraction).toBe(original.prefixVsFull.fraction);
      expect(transformed.prefixVsSuffix.score).toBe(original.prefixVsSuffix.score * scale + offset);
      expect(transformed.quantileRanks.map((q) => q.prefixType7)).toEqual(
        original.quantileRanks.map((q) => q.prefixType7 * scale + offset),
      );
      expect(transformed.scoreVectorChecksum).not.toBe(original.scoreVectorChecksum);
    },
  );

  it("supports negative multipliers and coarse atoms without any score lattice tolerance", () => {
    const positive = measureRosConvergenceDistribution(input(hiddenDrift()));
    const negative = measureRosConvergenceDistribution(
      input(hiddenDrift().map((score) => -100 * score)),
    );
    expect(negative.prefixVsSuffix.fraction).toBe(positive.prefixVsSuffix.fraction);
    expect(negative.prefixVsFull.fraction).toBe(positive.prefixVsFull.fraction);
    expect(negative.quantileRanks.map((q) => q.prefixType7)).toEqual([-100, -100, 0]);
    expect(negative.quantileRanks.map((q) => q.fullType7)).toEqual([-100, 0, 0]);
  });

  it("retains interpolated type-7 forecasts separately from inverse-ECDF identification bounds", () => {
    const scores = [...histogram([0, 6144], [10, 6144]), ...histogram([0, 2048], [10, 2048])];
    const result = measureRosConvergenceDistribution(input(scores));
    expect(result.forecastQuantileDefinition).toBe("type-7");
    expect(result.precision.identificationQuantileDefinition).toBe("inverse-empirical-cdf");
    expect(result.quantileRanks[1]!.prefixType7).toBe(5);
    expect(result.quantileRanks[1]!.atPrefixType7.prefix).toMatchObject({
      below: 6144,
      equal: 0,
      atOrBelow: 6144,
    });
    expect(result.precision.quantileBounds[1]!.prefix.lower).toMatchObject({
      kind: "finite",
      value: 0,
    });
    expect(result.precision.quantileBounds[1]!.prefix.upper).toMatchObject({
      kind: "finite",
      value: 10,
    });
  });

  it("uses four streams with pair counts rather than independent-path or two-sample assumptions", () => {
    const result = measureRosConvergenceDistribution({
      ...input(),
      familySize: 1,
      familyErrorBudget: 0.01,
    });
    expect(result.pairing).toEqual({
      convention: "adjacent-even-left-odd-right",
      prefixEven: 6144,
      prefixOdd: 6144,
      suffixEven: 2048,
      suffixOdd: 2048,
      independenceStatus: "assumed-not-authenticated",
    });
    expect(result.precision.logDkwFactor).toBeCloseTo(Math.log(800), 14);
    expect(result.precision.prefixCdfRadius).toBeCloseTo(Math.sqrt(Math.log(800) / (2 * 6144)), 15);
    expect(result.precision.suffixCdfRadius).toBeCloseTo(Math.sqrt(Math.log(800) / (2 * 2048)), 15);
    expect(result.precision.fullCdfRadius).toBe(
      0.75 * result.precision.prefixCdfRadius + 0.25 * result.precision.suffixCdfRadius,
    );
    expect(result.provenanceStatus).toBe("caller-supplied-not-authenticated");
    expect(result.precision.target).toBe("fixed-simulator-pair-mixture-distribution");
  });

  it("targets an equal pair mixture when deterministic left and right laws differ", () => {
    // Every left leg is 0, every right leg is 100. Each leg has its own degenerate IID law;
    // their mixture is half mass at each atom. No equality of the two marginal laws is needed.
    const scores = Array.from({ length: N }, (_, index) => (index % 2 === 0 ? 0 : 100));
    const result = measureRosConvergenceDistribution(input(scores));
    expect(result.precision.assumption).toBe(
      "each-leg-stream-iid-with-fixed-leg-marginal-across-partitions",
    );
    expect(result.prefixVsSuffix.fraction).toBe(0);
    expect(result.prefixVsFull.fraction).toBe(0);
    expect(result.quantileRanks.map((row) => row.fullType7)).toEqual([0, 50, 100]);
    // The generalized inverse mixture median is 0; the type-7 forecast is 50.
    const median = result.precision.quantileBounds[1]!.full;
    expect(median.lower).toMatchObject({ kind: "finite", value: 0 });
    expect(median.upper).toMatchObject({ kind: "finite", value: 100 });
  });

  it("keeps an upper probability of exactly one finite while a lower probability of zero is not clamped", () => {
    const result = measureRosConvergenceDistribution({
      ...input(Array.from({ length: N }, (_, index) => index)),
      familySize: 1,
      familyErrorBudget: Math.exp(Math.log(8) - RELEASE * 0.15 ** 2),
    });
    const lower = result.precision.quantileBounds[0]!.prefix;
    const upper = result.precision.quantileBounds[2]!.prefix;
    expect(lower.lowerProbability).toBeLessThanOrEqual(0);
    expect(lower.lower).toEqual({ kind: "unbounded", direction: "below" });
    expect(upper.upperProbability).toBe(1);
    expect(upper.upper).toEqual({ kind: "finite", value: RELEASE - 1, orderStatistic: RELEASE });
  });

  it("matches independently counted ECDF suprema over negative, fractional, and repeated support", () => {
    const support = [-9, -0.75, 0, 0.125, 2, 7.5, 100];
    const scores = Array.from(
      { length: N },
      (_, index) => support[(index * 37 + Math.floor(index / 13)) % support.length]!,
    );
    const result = measureRosConvergenceDistribution(input(scores));
    const prefix = scores.slice(0, RELEASE);
    const suffix = scores.slice(RELEASE);
    for (const [right, measured] of [
      [suffix, result.prefixVsSuffix],
      [scores, result.prefixVsFull],
    ] as const) {
      const counts = support.map((score) => ({
        score,
        left: prefix.filter((value) => value <= score).length,
        right: right.filter((value) => value <= score).length,
      }));
      const exact = counts.map((row) => Math.abs(row.left * right.length - row.right * RELEASE));
      const maximum = Math.max(...exact);
      const first = counts[exact.indexOf(maximum)]!;
      expect(measured.fraction).toBe(maximum / (RELEASE * right.length));
      expect(measured.numerator * RELEASE * right.length).toBe(maximum * measured.denominator);
      expect(measured.score).toBe(first.score);
      expect(measured.leftAtOrBelow).toBe(first.left);
      expect(measured.rightAtOrBelow).toBe(first.right);
    }
  });

  it("widens bounds when the explicit family grows or its error budget shrinks", () => {
    const base = input(Array.from({ length: N }, (_, i) => i));
    const one = measureRosConvergenceDistribution({ ...base, familySize: 1 });
    const family = measureRosConvergenceDistribution(base);
    const tighter = measureRosConvergenceDistribution({ ...base, familyErrorBudget: 0.001 });
    expect(family.precision.prefixCdfRadius).toBeGreaterThan(one.precision.prefixCdfRadius);
    expect(tighter.precision.prefixCdfRadius).toBeGreaterThan(family.precision.prefixCdfRadius);
    expect(family.evidenceChecksum).not.toBe(one.evidenceChecksum);
    expect(tighter.evidenceChecksum).not.toBe(family.evidenceChecksum);
    expect(tighter.scoreVectorChecksum).toBe(one.scoreVectorChecksum);
  });

  it("keeps extreme positive alpha finite and reports insufficient endpoint precision as unbounded", () => {
    const result = measureRosConvergenceDistribution({
      ...input(Array<number>(N).fill(42)),
      familySize: Number.MAX_SAFE_INTEGER,
      familyErrorBudget: Number.MIN_VALUE,
    });
    expect(Number.isFinite(result.precision.logDkwFactor)).toBe(true);
    expect(Number.isFinite(result.precision.fullCdfRadius)).toBe(true);
    const low = result.precision.quantileBounds[0]!;
    const high = result.precision.quantileBounds[2]!;
    for (const bounds of [low.prefix, low.suffix, low.full]) {
      expect(bounds.lowerProbability).toBeLessThan(0);
      expect(bounds.lower).toEqual({ kind: "unbounded", direction: "below" });
      expect(bounds.upper).toMatchObject({ kind: "finite", value: 42 });
    }
    for (const bounds of [high.prefix, high.suffix, high.full]) {
      expect(bounds.upperProbability).toBeGreaterThan(1);
      expect(bounds.upper).toEqual({ kind: "unbounded", direction: "above" });
    }
    expect(JSON.stringify(result)).not.toContain("null");
  });

  it("handles alpha just below one without zero or negative radii", () => {
    const result = measureRosConvergenceDistribution({
      ...input(),
      familySize: 1,
      familyErrorBudget: 1 - Number.EPSILON,
    });
    expect(result.precision.prefixCdfRadius).toBeGreaterThan(0);
    expect(result.precision.prefixCdfRadius).toBeLessThan(0.02);
  });

  it("takes the smallest maximizing score and includes whole tied atoms", () => {
    const scores = [...histogram([0, 6144], [2, 6144]), ...histogram([1, 4096])];
    const result = measureRosConvergenceDistribution(input(scores));
    expect(result.prefixVsSuffix).toMatchObject({
      score: 0,
      fraction: 0.5,
      leftAtOrBelow: 6144,
      rightAtOrBelow: 0,
    });
    expect(result.prefixVsFull).toMatchObject({ score: 0, fraction: 0.125 });
  });

  it("does not mutate scores or provenance, and does not infer valid pairs from a checksum", () => {
    const scores = Object.freeze(hiddenDrift());
    const frozen = Object.freeze({ ...input(scores), provenance: Object.freeze({ ...source }) });
    const result = measureRosConvergenceDistribution(frozen);
    expect(scores).toEqual(hiddenDrift());
    const reordered = [...scores];
    [reordered[0], reordered[RELEASE - 1]] = [reordered[RELEASE - 1]!, reordered[0]!];
    const changed = measureRosConvergenceDistribution(input(reordered));
    expect(changed.prefixVsSuffix).toEqual(result.prefixVsSuffix);
    expect(changed.scoreVectorChecksum).not.toBe(result.scoreVectorChecksum);
    expect(changed.evidenceChecksum).not.toBe(result.evidenceChecksum);
    expect(changed.provenance.vectorChecksum).toBe(result.provenance.vectorChecksum);
    expect(changed.pairing.independenceStatus).toBe("assumed-not-authenticated");
  });

  it("uses identical canonical bytes for arrays, Float64Array, and signed zero", () => {
    const scores = boundary();
    const array = measureRosConvergenceDistribution(input(scores));
    const typed = measureRosConvergenceDistribution(input(new Float64Array(scores)));
    expect(typed).toEqual(array);
    const negativeZero = scores.map((score) => (score === 0 ? -0 : score));
    expect(measureRosConvergenceDistribution(input(negativeZero))).toEqual(array);
    expect(array.scoreVectorChecksum).toBe(
      createHash("sha256")
        .update(JSON.stringify({ scores, version: ROS_CONVERGENCE_SCORE_VECTOR_VERSION }))
        .digest("hex"),
    );
    const { evidenceChecksum, ...body } = array;
    expect(evidenceChecksum).toBe(
      createHash("sha256").update(canonical(body), "utf8").digest("hex"),
    );
  });

  it("recomputes exact receipts across JSONB key reordering and refuses any relabelled or missing evidence", () => {
    const values = input(boundary());
    const result = measureRosConvergenceDistribution(values);
    const roundTrip: unknown = JSON.parse(JSON.stringify(reverseKeys(result)));
    expect(rosConvergenceDistributionMatchesScores(roundTrip, values)).toBe(true);
    expect(
      measureRosConvergenceDistribution({
        ...values,
        provenance: reverseKeys(source) as RosConvergenceDistributionProvenance,
      }).evidenceChecksum,
    ).toBe(result.evidenceChecksum);
    expect(
      rosConvergenceDistributionMatchesScores({ ...result, purpose: "admitted" }, values),
    ).toBe(false);
    expect(rosConvergenceDistributionMatchesScores({ ...result, extra: true }, values)).toBe(false);
    expect(
      rosConvergenceDistributionMatchesScores(
        { ...result, precision: { ...result.precision, familySize: 1 } },
        values,
      ),
    ).toBe(false);
    expect(
      rosConvergenceDistributionMatchesScores(
        { ...result, evidenceChecksum: "0".repeat(64) },
        values,
      ),
    ).toBe(false);
    expect(
      rosConvergenceDistributionMatchesScores(
        { ...result, prefixVsFull: { ...result.prefixVsFull, numerator: 0 } },
        values,
      ),
    ).toBe(false);
    expect(
      rosConvergenceDistributionMatchesScores(result, { ...values, scores: hiddenDrift() }),
    ).toBe(false);
    expect(rosConvergenceDistributionMatchesScores(null, values)).toBe(false);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity])(
    "rejects invalid family size %s",
    (familySize) => {
      expect(() => measureRosConvergenceDistribution({ ...input(), familySize })).toThrow(
        /familySize/,
      );
    },
  );

  it.each([0, -0.1, 1, 2, NaN, Infinity])(
    "rejects invalid family error budget %s",
    (familyErrorBudget) => {
      expect(() => measureRosConvergenceDistribution({ ...input(), familyErrorBudget })).toThrow(
        /familyErrorBudget/,
      );
    },
  );

  it.each([0, 4096, RELEASE, N - 1, N + 1])(
    "rejects vector length %s instead of changing the frozen prefix",
    (length) => {
      expect(() => measureRosConvergenceDistribution(input(Array<number>(length).fill(0)))).toThrow(
        /exactly/,
      );
    },
  );

  it.each([NaN, Infinity, -Infinity, undefined, "1", null])(
    "rejects nonfinite or nonnumeric score %s",
    (score) => {
      const scores: unknown[] = Array<number>(N).fill(0);
      scores[8000] = score;
      expect(() => measureRosConvergenceDistribution(input(scores as number[]))).toThrow(/finite/);
    },
  );

  it("rejects sparse arrays, array metadata, wrong typed storage, missing context, and unknown input fields", () => {
    const sparse = Array<number>(N).fill(0);
    Reflect.deleteProperty(sparse, 12);
    expect(() => measureRosConvergenceDistribution(input(sparse))).toThrow(/dense/);
    const extra = Object.assign(Array<number>(N).fill(0), { metadata: true });
    expect(() => measureRosConvergenceDistribution(input(extra))).toThrow(/dense/);
    expect(() =>
      measureRosConvergenceDistribution(input(new Float32Array(N) as unknown as number[])),
    ).toThrow(/dense/);
    const missing: Record<string, unknown> = { ...input() };
    delete missing.familySize;
    expect(() =>
      measureRosConvergenceDistribution(missing as unknown as RosConvergenceDistributionInput),
    ).toThrow(/fields/);
    expect(() =>
      measureRosConvergenceDistribution({
        ...input(),
        releaseSamples: 100,
      } as RosConvergenceDistributionInput),
    ).toThrow(/fields/);
  });

  it.each(["seedHash", "inputChecksum", "vectorChecksum"] as const)(
    "rejects malformed %s and binds every valid provenance digest",
    (field) => {
      const original = measureRosConvergenceDistribution(input());
      expect(() =>
        measureRosConvergenceDistribution({
          ...input(),
          provenance: { ...source, [field]: "not-a-digest" },
        }),
      ).toThrow(/checksum/);
      const changed = measureRosConvergenceDistribution({
        ...input(),
        provenance: { ...source, [field]: "d".repeat(64) },
      });
      expect(changed.scoreVectorChecksum).toBe(original.scoreVectorChecksum);
      expect(changed.evidenceChecksum).not.toBe(original.evidenceChecksum);
    },
  );

  it("rejects malformed/noncanonical or oversized scoring keys and empty model/scorer identifiers", () => {
    for (const scoringProfileKey of [
      "not-json",
      ` ${source.scoringProfileKey}`,
      "x".repeat(65_537),
    ])
      expect(() =>
        measureRosConvergenceDistribution({
          ...input(),
          provenance: { ...source, scoringProfileKey },
        }),
      ).toThrow();
    for (const modelVersion of ["", " ", "x".repeat(257)])
      expect(() =>
        measureRosConvergenceDistribution({ ...input(), provenance: { ...source, modelVersion } }),
      ).toThrow(/provenance/);
    expect(() =>
      measureRosConvergenceDistribution({
        ...input(),
        provenance: { ...source, scorerVersion: "" },
      }),
    ).toThrow(/provenance/);
    expect(() =>
      measureRosConvergenceDistribution({
        ...input(),
        provenance: { ...source, unknown: "value" } as RosConvergenceDistributionProvenance,
      }),
    ).toThrow(/fields/);
  });

  it("refuses finite inputs whose existing type-7 arithmetic overflows instead of serializing NaN", () => {
    const scores = [
      ...histogram([-Number.MAX_VALUE, 6144], [Number.MAX_VALUE, 6144]),
      ...histogram([-Number.MAX_VALUE, 2048], [Number.MAX_VALUE, 2048]),
    ];
    expect(() => measureRosConvergenceDistribution(input(scores))).toThrow(/type-7 arithmetic/);
  });
});
