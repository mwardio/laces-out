import { describe, expect, it } from "vitest";

import {
  projectFirstPartyRestOfSeason,
  type FirstPartyRosProjectionInput,
} from "./rest-of-season.js";
import { scoreFirstPartyRosOutcomes, simulateFirstPartyRosOutcomes } from "./ros-outcomes.js";

const fineMakes = [
  "field_goals_made_0_19",
  "field_goals_made_20_29",
  "field_goals_made_30_39",
  "field_goals_made_40_49",
  "field_goals_made_50_59",
  "field_goals_made_60_plus",
] as const;
const fineMisses = fineMakes.map((key) => key.replace("made", "missed"));
const baseComponents: Record<string, number> = {
  field_goals_made_0_19: 0.1,
  field_goals_made_20_29: 0.25,
  field_goals_made_30_39: 0.35,
  field_goals_made_0_39: 0.7,
  field_goals_made_40_49: 0.6,
  field_goals_made_50_59: 0.4,
  field_goals_made_60_plus: 0.1,
  field_goals_made_50_plus: 0.5,
  field_goals_made: 1.8,
  field_goals_attempted: 2.1,
  field_goals_missed: 0.3,
  field_goals_missed_0_19: 0.015,
  field_goals_missed_20_29: 0.015,
  field_goals_missed_30_39: 0.03,
  field_goals_missed_40_49: 0.09,
  field_goals_missed_50_59: 0.12,
  field_goals_missed_60_plus: 0.03,
  field_goals_missed_0_39: 0.06,
  field_goals_missed_50_plus: 0.15,
  field_goals_total_yards: 76.3,
  extra_points_made: 2.5,
  extra_points_missed: 0.1,
  extra_points_attempted: 2.6,
};

function input(
  components: Record<string, number> = baseComponents,
  overrides: Partial<FirstPartyRosProjectionInput> = {},
): FirstPartyRosProjectionInput {
  return {
    playerId: "kicker-scoring-fixture",
    position: "K",
    season: 2026,
    asOfWeek: 4,
    asOfAt: "2026-10-01T12:00:00.000Z",
    windowStartWeek: 5,
    windowEndWeek: 5,
    strategy: "contextual",
    weeks: [
      {
        season: 2026,
        week: 5,
        scheduled: true,
        bye: false,
        contextualComponents: components,
        recencyComponents: components,
        componentElasticities: Object.fromEntries(
          Object.keys(components).map((key) => [key, { role: 1, production: 1 }]),
        ),
      },
    ],
    availability: {
      state: "active",
      newAbsenceProbability: 0,
      recoveryProbability: 0,
      reserveRecoveryProbability: 0,
      limitedRoleMultiplier: 1,
      returnRoleMultiplier: 1,
    },
    role: {
      currentMultiplier: 1,
      persistence: 1,
      innovationVolatility: 0,
      weeklyProductionVolatility: 0,
      minimumMultiplier: 0.25,
      maximumMultiplier: 2.5,
    },
    kicker: {
      fgEventDispersion: 0.9,
      xpDispersion: 0.9,

      centerVolatility: 0,
      bucketMix: [0.4, 0.35, 0.25],
      missBucketMix: [0.05, 0.05, 0.1, 0.3, 0.4, 0.1],
    },
    scoringProfile: {
      id: "distance-and-penalties",
      rules: [
        { statId: "field_goals_made_0_19", points: 2 },
        { statId: "field_goals_made_20_29", points: 3 },
        { statId: "field_goals_made_30_39", points: 4 },
        { statId: "field_goals_made_40_49", points: 5 },
        { statId: "field_goals_made_50_59", points: 6 },
        { statId: "field_goals_made_60_plus", points: 7 },
        { statId: "field_goals_total_yards_per_10_units", points: 1 },
        { statId: "extra_points_made", points: 1 },
        { statId: "extra_points_missed", points: -5 },
      ],
    },
    inputChecksum: "e".repeat(64),
    weeklyModelVersion: "kicker-scoring-test",
    seed: "integer-kicker-outcomes",
    scenarioCount: 512,
    ...overrides,
  };
}

function average(values: Float64Array): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

describe("ROS kicker realized scoring outcomes", () => {
  it("keeps every count integer and conserves fine buckets, attempts, and distance bounds", () => {
    const ensemble = simulateFirstPartyRosOutcomes(input());
    const { columns } = ensemble;
    for (const column of Object.values(columns)) {
      expect(column.every((value) => Number.isInteger(value) && value >= 0)).toBe(true);
    }
    for (let i = 0; i < ensemble.scenarioCount; i += 1) {
      const read = (key: string): number => columns[key]![i]!;
      expect(fineMakes.reduce((sum, key) => sum + read(key), 0)).toBe(read("field_goals_made"));
      expect(fineMisses.reduce((sum, key) => sum + read(key), 0)).toBe(read("field_goals_missed"));
      expect(read("field_goals_made_0_39")).toBe(
        fineMakes.slice(0, 3).reduce((sum, key) => sum + read(key), 0),
      );
      expect(read("field_goals_made_50_plus")).toBe(read(fineMakes[4]) + read(fineMakes[5]));
      expect(read("field_goals_attempted")).toBe(
        read("field_goals_made") + read("field_goals_missed"),
      );
      expect(read("extra_points_attempted")).toBe(
        read("extra_points_made") + read("extra_points_missed"),
      );
      const lower = [0, 20, 30, 40, 50, 60];
      const upper = [19, 29, 39, 49, 59, 70];
      const totalYards = read("field_goals_total_yards");
      expect(totalYards).toBeGreaterThanOrEqual(
        fineMakes.reduce((sum, key, index) => sum + read(key) * lower[index]!, 0),
      );
      expect(totalYards).toBeLessThanOrEqual(
        fineMakes.reduce((sum, key, index) => sum + read(key) * upper[index]!, 0),
      );
      for (const divisor of [5, 10, 20, 25, 50, 100]) {
        expect(read(`field_goals_total_yards_per_${divisor}_units`)).toBe(
          Math.floor(totalYards / divisor),
        );
      }
    }
  });

  it("sums weekly whole groups instead of rounding a season yardage total", () => {
    const football = input();
    const firstWeek = football.weeks[0]!;
    const ensemble = simulateFirstPartyRosOutcomes({
      ...football,
      windowEndWeek: 6,
      weeks: [firstWeek, { ...firstWeek, week: 6 }],
    });
    const totals = ensemble.columns.field_goals_total_yards!;
    const groups = ensemble.columns.field_goals_total_yards_per_10_units!;
    const deficits = Array.from(totals, (yards, index) => Math.floor(yards / 10) - groups[index]!);
    expect(deficits.every((value) => value === 0 || value === 1)).toBe(true);
    expect(deficits.some((value) => value === 1)).toBe(true);
  });

  it("retains subsequent-week draws when the first week is a bye or has zero intensity", () => {
    const football = input();
    const firstWeek = football.weeks[0]!;
    const zeroComponents = Object.fromEntries(Object.keys(baseComponents).map((key) => [key, 0]));
    const withBye = simulateFirstPartyRosOutcomes({
      ...football,
      windowEndWeek: 6,
      weeks: [
        { ...firstWeek, scheduled: false, bye: true },
        { ...firstWeek, week: 6 },
      ],
    });
    const withZeroGame = simulateFirstPartyRosOutcomes({
      ...football,
      windowEndWeek: 6,
      weeks: [
        { ...firstWeek, contextualComponents: zeroComponents, recencyComponents: zeroComponents },
        { ...firstWeek, week: 6 },
      ],
    });
    expect(withZeroGame.columns).toEqual(withBye.columns);
  });

  it("preserves feasible yardage, fine-count and XP-miss centers in a large sample", () => {
    const ensemble = simulateFirstPartyRosOutcomes(
      input(baseComponents, { scenarioCount: 16_384 }),
    );
    for (const key of [...fineMakes, ...fineMisses, "extra_points_missed"]) {
      expect(Math.abs(average(ensemble.columns[key]!) - baseComponents[key]!)).toBeLessThan(0.025);
    }
    expect(Math.abs(average(ensemble.columns.field_goals_total_yards!) - 76.3)).toBeLessThan(0.6);
  });

  it("retains explicit zero XP misses and consumes their draws independently of makes", () => {
    const withMisses = simulateFirstPartyRosOutcomes(input());
    const withoutMisses = simulateFirstPartyRosOutcomes(
      input({ ...baseComponents, extra_points_missed: 0, extra_points_attempted: 2.5 }),
    );
    expect(withoutMisses.columns.extra_points_missed!.every((value) => value === 0)).toBe(true);
    expect(withoutMisses.columns.extra_points_made).toEqual(withMisses.columns.extra_points_made);
    expect(withoutMisses.columns.field_goals_total_yards).toEqual(
      withMisses.columns.field_goals_total_yards,
    );
  });

  it("derives XP misses from explicit attempts when the miss component is absent", () => {
    const components = { ...baseComponents };
    delete components.extra_points_missed;
    const derived = simulateFirstPartyRosOutcomes(input(components));
    const explicit = simulateFirstPartyRosOutcomes(input());
    expect(derived.columns.extra_points_missed).toEqual(explicit.columns.extra_points_missed);
  });

  it("scores signed penalties and arbitrary supported distance prices from the same outcomes", () => {
    const football = input();
    const ensemble = simulateFirstPartyRosOutcomes(football);
    const penalty = scoreFirstPartyRosOutcomes(ensemble, {
      id: "xp-miss-penalty",
      rules: [{ statId: "extra_points_missed", points: -5 }],
    });
    expect(penalty.meanPoints).toBe(-5 * average(ensemble.columns.extra_points_missed!));
    expect(penalty.meanPoints).toBeLessThan(0);
    const direct = projectFirstPartyRestOfSeason(football);
    const rescored = scoreFirstPartyRosOutcomes(ensemble, football.scoringProfile);
    expect(rescored.meanPoints).toBeCloseTo(direct.meanPoints, 12);
    expect(rescored.standardDeviation).toBeCloseTo(direct.standardDeviation, 12);
    expect(rescored.p15Points).toBe(direct.p15Points);
    expect(rescored.p85Points).toBe(direct.p85Points);
    const repricedInput = {
      ...football,
      scoringProfile: { id: "unrelated", rules: [{ statId: "receptions", points: 100 }] },
    };
    const repriced = simulateFirstPartyRosOutcomes(repricedInput);
    expect(repriced.columns).toEqual(ensemble.columns);
  });

  it("bounds an infeasible yardage center to its distance buckets and discloses the change", () => {
    const result = projectFirstPartyRestOfSeason(
      input({ ...baseComponents, field_goals_total_yards: 0 }),
    );
    expect(result.expectedComponents.field_goals_total_yards).toBeGreaterThan(0);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "kicker_yardage_mean_bounded", severity: "warning" }),
    );
  });
});
