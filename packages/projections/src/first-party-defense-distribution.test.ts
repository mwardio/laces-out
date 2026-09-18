import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  expandFirstPartyTeamDefenseAllowedDistribution,
  firstPartyTeamDefenseAllowedDistributionParameters,
  firstPartyTeamDefenseAllowedDistributions,
  firstPartyTeamDefenseRealizedAllowedBuckets,
  projectFirstPartyTeamDefenseComponents,
  projectFirstPartyTeamDefenseRecencyBaselineComponents,
  type FirstPartyTeamDefenseAllowedDistributionParameters,
  type FirstPartyTeamDefenseDiscreteGaussianParameters,
  type FirstPartyTeamDefenseWeeklyStatLine,
} from "./first-party.js";

const target = { team: "AAA", opponent: "BBB", season: 2026, week: 5 };
const sparse: readonly FirstPartyTeamDefenseWeeklyStatLine[] = [
  {
    team: "AAA",
    opponent: "BBB",
    season: 2026,
    week: 1,
    components: { points_allowed: 22, yards_allowed: 338, defensive_sacks: 3 },
  },
];
const varied: readonly FirstPartyTeamDefenseWeeklyStatLine[] = Array.from(
  { length: 20 },
  (_, index) => ({
    team: index % 2 === 0 ? "AAA" : "BBB",
    opponent: index % 2 === 0 ? "BBB" : "AAA",
    season: 2025,
    week: index + 1,
    components: {
      points_allowed: (index * 13) % 65,
      yards_allowed: 110 + ((index * 61) % 620),
      defensive_sacks: index % 7,
      defensive_interceptions: index % 3,
      defensive_fumble_recoveries: index % 2,
    },
  }),
);

// Independent provider-contract expectations, deliberately not imported from the implementation.
const pointsBuckets = [
  ["points_allowed_0_probability", 0, 0],
  ["points_allowed_1_6_probability", 1, 6],
  ["points_allowed_7_13_probability", 7, 13],
  ["points_allowed_14_20_probability", 14, 20],
  ["points_allowed_21_27_probability", 21, 27],
  ["points_allowed_28_34_probability", 28, 34],
  ["points_allowed_35_plus_probability", 35, Infinity],
  ["points_allowed_14_17_probability", 14, 17],
  ["points_allowed_18_21_probability", 18, 21],
  ["points_allowed_22_27_probability", 22, 27],
  ["points_allowed_35_45_probability", 35, 45],
  ["points_allowed_46_plus_probability", 46, Infinity],
] as const;
const yardsBuckets = [
  ["yards_allowed_0_99_probability", 0, 99],
  ["yards_allowed_100_199_probability", 100, 199],
  ["yards_allowed_200_299_probability", 200, 299],
  ["yards_allowed_300_349_probability", 300, 349],
  ["yards_allowed_350_399_probability", 350, 399],
  ["yards_allowed_400_449_probability", 400, 449],
  ["yards_allowed_450_499_probability", 450, 499],
  ["yards_allowed_500_549_probability", 500, 549],
  ["yards_allowed_550_plus_probability", 550, Infinity],
  ["yards_allowed_500_plus_probability", 500, Infinity],
] as const;

function expectedIndicators(points: number, yards: number): Record<string, number> {
  return Object.fromEntries([
    ...pointsBuckets.map(
      ([key, low, high]) => [key, Number(points >= low && points <= high)] as const,
    ),
    ...yardsBuckets.map(
      ([key, low, high]) => [key, Number(yards >= low && yards <= high)] as const,
    ),
  ]);
}

describe("the shared D/ST allowed-outcome distributions", () => {
  it.each([[], sparse, varied].map((history) => ({ history })))(
    "round-trips compact parameters to the exact mass and every scored bucket",
    ({ history }) => {
      for (const components of [
        { points_allowed: 0, yards_allowed: 0 },
        { points_allowed: 80, yards_allowed: 800 },
        { points_allowed: 20.125, yards_allowed: 499.875 },
        { points_allowed: 200, yards_allowed: 2_000 },
        projectFirstPartyTeamDefenseComponents({ target, history }).components,
      ]) {
        const input = { target, history, components };
        const original = firstPartyTeamDefenseAllowedDistributions(input);
        const compact = firstPartyTeamDefenseAllowedDistributionParameters(input);
        const serialized = JSON.stringify(compact);
        expect(Buffer.byteLength(serialized)).toBeLessThan(230);
        const decoded = JSON.parse(
          serialized,
        ) as FirstPartyTeamDefenseAllowedDistributionParameters;
        for (const [field, buckets] of [
          ["pointsAllowed", pointsBuckets],
          ["yardsAllowed", yardsBuckets],
        ] as const) {
          expect(original[field].parameters).toEqual(compact[field]);
          const expanded = expandFirstPartyTeamDefenseAllowedDistribution(decoded[field]);
          expect(expanded).toEqual(original[field]);
          for (const [, minimum, maximum] of buckets) {
            const sum = (mass: typeof expanded) =>
              mass.weights.reduce(
                (total, weight, outcome) =>
                  outcome >= minimum && outcome <= maximum
                    ? total + weight / mass.totalWeight
                    : total,
                0,
              );
            expect(sum(expanded)).toBe(sum(original[field]));
          }
        }
      }
    },
  );

  it.each([
    { maximum: 80 as const, sigmas: [5, 10, 18] },
    { maximum: 800 as const, sigmas: [55, 85, 115] },
  ])(
    "expands the exact original grid at support and dispersion boundaries: $maximum",
    ({ maximum, sigmas }) => {
      for (const center of [0, 0.125, maximum / 2, maximum - 0.125, maximum]) {
        for (const standardDeviation of sigmas) {
          const parameters = { center, standardDeviation, maximum };
          const expanded = expandFirstPartyTeamDefenseAllowedDistribution(parameters);
          const expected = Array.from({ length: maximum + 1 }, (_, value) =>
            Math.exp(-0.5 * ((value - center) / standardDeviation) ** 2),
          );
          expect(expanded.weights).toEqual(expected);
          expect(expanded.totalWeight).toBe(expected.reduce((sum, mass) => sum + mass, 0));
          expect(expanded.parameters).toEqual(parameters);
        }
      }
    },
  );

  it.each([0, -1, 81, 800.5, 8_192, NaN, Infinity, undefined])(
    "rejects unsupported compact maximum %s",
    (maximum) => {
      expect(() =>
        expandFirstPartyTeamDefenseAllowedDistribution({
          center: 20,
          standardDeviation: 10,
          maximum,
        } as FirstPartyTeamDefenseDiscreteGaussianParameters),
      ).toThrow(/maximum must be 80 or 800/u);
    },
  );

  it.each([80, 800] as const)(
    "strictly validates finite descriptor fields for support %s",
    (maximum) => {
      const standardDeviation = maximum === 80 ? 10 : 85;
      for (const center of [-1, maximum + 0.001, NaN, Infinity, -Infinity, undefined]) {
        expect(() =>
          expandFirstPartyTeamDefenseAllowedDistribution({
            center,
            standardDeviation,
            maximum,
          } as FirstPartyTeamDefenseDiscreteGaussianParameters),
        ).toThrow(/center must be finite and within support/u);
      }
      for (const sigma of [
        0,
        -1,
        NaN,
        Infinity,
        -Infinity,
        undefined,
        maximum === 80 ? 4.999 : 54.999,
        maximum === 80 ? 18.001 : 115.001,
      ]) {
        expect(() =>
          expandFirstPartyTeamDefenseAllowedDistribution({
            center: 0,
            standardDeviation: sigma,
            maximum,
          } as FirstPartyTeamDefenseDiscreteGaussianParameters),
        ).toThrow(/dispersion is outside the model bounds/u);
      }
    },
  );

  it("preserves complete weekly and recency outputs, including exact numbers and key order", () => {
    const cases = [
      { target, history: [] },
      { target, history: sparse },
      { target, history: varied },
      {
        target: {
          ...target,
          context: { pointsAllowedMultiplier: 1.3, yardsAllowedMultiplier: 0.75 },
        },
        history: [...varied, ...sparse],
        config: { recencyHalfLifeWeeks: 2.5 },
      },
      { target: { ...target, isBye: true }, history: varied },
    ];
    const serialized = JSON.stringify(
      cases.map((input) => ({
        projection: projectFirstPartyTeamDefenseComponents(input),
        baseline: projectFirstPartyTeamDefenseRecencyBaselineComponents(input),
      })),
    );
    // Captured from the pre-extraction implementation; covers 31,113 serialized bytes.
    expect(createHash("sha256").update(serialized).digest("hex")).toBe(
      "f9ca6e9cd7964884817ba2747d1389d67acfa873db3d146998c2c5271d6eb3c9",
    );
  });

  it.each([[], sparse, varied].map((history) => ({ history })))(
    "exposes normalized integer grids with every weekly Yahoo/ESPN probability unchanged",
    ({ history }) => {
      for (const components of [
        projectFirstPartyTeamDefenseComponents({ target, history }).components,
        projectFirstPartyTeamDefenseRecencyBaselineComponents({ target, history }),
      ]) {
        const distribution = firstPartyTeamDefenseAllowedDistributions({
          target,
          history,
          components,
        });
        for (const [mass, buckets, supportSize] of [
          [distribution.pointsAllowed, pointsBuckets, 81],
          [distribution.yardsAllowed, yardsBuckets, 801],
        ] as const) {
          expect(mass.weights).toHaveLength(supportSize);
          expect(mass.weights.every((weight) => Number.isFinite(weight) && weight >= 0)).toBe(true);
          expect(mass.totalWeight).toBeGreaterThan(0);
          expect(mass.totalWeight).toBe(mass.weights.reduce((sum, weight) => sum + weight, 0));
          expect(
            mass.weights.reduce((sum, weight) => sum + weight / mass.totalWeight, 0),
          ).toBeCloseTo(1, 14);
          for (const [component, low, high] of buckets) {
            const expected = mass.weights
              .slice(low, Number.isFinite(high) ? high + 1 : undefined)
              .reduce((sum, weight) => sum + weight / mass.totalWeight, 0);
            expect(components[component]).toBe(expected);
          }
        }
        expect(components.points_allowed_35_plus_probability).toBeCloseTo(
          (components.points_allowed_35_45_probability ?? 0) +
            (components.points_allowed_46_plus_probability ?? 0),
          14,
        );
        expect(components.yards_allowed_500_plus_probability).toBeCloseTo(
          (components.yards_allowed_500_549_probability ?? 0) +
            (components.yards_allowed_550_plus_probability ?? 0),
          14,
        );
      }
    },
  );

  it.each([[], sparse].map((history) => ({ history })))(
    "uses the original fallback dispersion with zero or one history row",
    ({ history }) => {
      const distribution = firstPartyTeamDefenseAllowedDistributions({
        target,
        history,
        components: { points_allowed: 22.5, yards_allowed: 338.5 },
      });
      expect(distribution.pointsAllowed.weights).toEqual(
        Array.from({ length: 81 }, (_, point) => Math.exp(-0.5 * ((point - 22.5) / 10) ** 2)),
      );
      expect(distribution.yardsAllowed.weights).toEqual(
        Array.from({ length: 801 }, (_, yard) => Math.exp(-0.5 * ((yard - 338.5) / 85) ** 2)),
      );
    },
  );

  it("uses strict-prior played history and the same deterministic ordering as weekly forecasts", () => {
    const input = {
      target,
      history: [...varied, ...sparse],
      components: { points_allowed: 25, yards_allowed: 360 },
    };
    const expected = firstPartyTeamDefenseAllowedDistributions(input);
    const excluded = [
      { ...sparse[0]!, week: target.week },
      { ...sparse[0]!, week: target.week + 1 },
      { ...sparse[0]!, season: target.season + 1 },
      { ...sparse[0]!, played: false },
    ].map((row) => ({ ...row, components: { points_allowed: 80, yards_allowed: 800 } }));
    expect(
      firstPartyTeamDefenseAllowedDistributions({
        ...input,
        history: [...excluded, ...input.history].reverse(),
      }),
    ).toEqual(expected);
    expect(
      firstPartyTeamDefenseAllowedDistributions({ ...input, config: { recencyHalfLifeWeeks: 1 } }),
    ).not.toEqual(expected);
  });

  it("distinguishes the bounded grid expectation from its supplied center", () => {
    const distribution = firstPartyTeamDefenseAllowedDistributions({
      target,
      history: [],
      components: {},
    });
    expect(
      distribution.pointsAllowed.weights.reduce(
        (sum, weight, outcome) => sum + (outcome * weight) / distribution.pointsAllowed.totalWeight,
        0,
      ),
    ).toBeGreaterThan(0);
    expect(
      distribution.yardsAllowed.weights.reduce(
        (sum, weight, outcome) => sum + (outcome * weight) / distribution.yardsAllowed.totalWeight,
        0,
      ),
    ).toBeGreaterThan(0);
    const capped = firstPartyTeamDefenseAllowedDistributions({
      target,
      history: [],
      components: { points_allowed: 100, yards_allowed: 900 },
    });
    expect(capped).toEqual(
      firstPartyTeamDefenseAllowedDistributions({
        target,
        history: [],
        components: { points_allowed: 80, yards_allowed: 800 },
      }),
    );
  });

  it.each([NaN, Infinity, -Infinity, -1])("rejects invalid projected centers: %s", (value) => {
    for (const component of ["points_allowed", "yards_allowed"]) {
      expect(() =>
        firstPartyTeamDefenseAllowedDistributions({
          target,
          history: [],
          components: { [component]: value },
        }),
      ).toThrow(/finite and nonnegative/u);
    }
  });

  it("validates target and configuration before fitting a distribution", () => {
    const input = { target, history: [], components: {} };
    expect(() =>
      firstPartyTeamDefenseAllowedDistributions({ ...input, target: { ...target, week: 0 } }),
    ).toThrow(/positive integer/u);
    expect(() =>
      firstPartyTeamDefenseAllowedDistributions({ ...input, config: { recencyHalfLifeWeeks: 0 } }),
    ).toThrow(/greater than zero/u);
  });
});

describe("realized D/ST provider buckets", () => {
  it.each([
    0,
    1,
    6,
    7,
    13,
    14,
    17,
    18,
    20,
    21,
    22,
    27,
    28,
    34,
    35,
    45,
    46,
    80,
    81,
    Number.MAX_SAFE_INTEGER,
  ])("classifies points-allowed boundary %s consistently across providers", (pointsAllowed) => {
    expect(
      firstPartyTeamDefenseRealizedAllowedBuckets({ pointsAllowed, yardsAllowed: 338 }),
    ).toEqual(expectedIndicators(pointsAllowed, 338));
  });

  it.each([
    0,
    99,
    100,
    199,
    200,
    299,
    300,
    349,
    350,
    399,
    400,
    449,
    450,
    499,
    500,
    549,
    550,
    800,
    801,
    Number.MAX_SAFE_INTEGER,
  ])("classifies yards-allowed boundary %s consistently across providers", (yardsAllowed) => {
    expect(
      firstPartyTeamDefenseRealizedAllowedBuckets({ pointsAllowed: 21, yardsAllowed }),
    ).toEqual(expectedIndicators(21, yardsAllowed));
  });

  it("uses one coherent outcome for all overlapping provider tiers throughout both supports", () => {
    for (let points = 0; points <= 80; points += 1) {
      const actual = firstPartyTeamDefenseRealizedAllowedBuckets({
        pointsAllowed: points,
        yardsAllowed: 0,
      });
      expect(actual).toEqual(expectedIndicators(points, 0));
      expect(actual.points_allowed_35_plus_probability).toBe(
        (actual.points_allowed_35_45_probability ?? 0) +
          (actual.points_allowed_46_plus_probability ?? 0),
      );
      expect(
        pointsBuckets.slice(0, 7).reduce((sum, [component]) => sum + (actual[component] ?? 0), 0),
      ).toBe(1);
      expect(
        [0, 1, 2, 7, 8, 9, 5, 10, 11].reduce(
          (sum, index) => sum + (actual[pointsBuckets[index]![0]] ?? 0),
          0,
        ),
      ).toBe(1);
    }
    for (let yards = 0; yards <= 800; yards += 1) {
      const actual = firstPartyTeamDefenseRealizedAllowedBuckets({
        pointsAllowed: 0,
        yardsAllowed: yards,
      });
      expect(actual).toEqual(expectedIndicators(0, yards));
      expect(actual.yards_allowed_500_plus_probability).toBe(
        (actual.yards_allowed_500_549_probability ?? 0) +
          (actual.yards_allowed_550_plus_probability ?? 0),
      );
      expect(
        yardsBuckets.slice(0, 9).reduce((sum, [component]) => sum + (actual[component] ?? 0), 0),
      ).toBe(1);
    }
  });

  it.each([NaN, Infinity, -Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, undefined])(
    "rejects non-integer or invalid realized outcomes: %s",
    (value) => {
      for (const field of ["pointsAllowed", "yardsAllowed"] as const) {
        // Include a missing required runtime value to ensure validation does not silently emit zeros.
        expect(() =>
          firstPartyTeamDefenseRealizedAllowedBuckets({
            pointsAllowed: 0,
            yardsAllowed: 0,
            [field]: value as number,
          }),
        ).toThrow(/nonnegative safe integer/u);
      }
    },
  );
});
